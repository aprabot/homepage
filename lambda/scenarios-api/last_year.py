"""What was really sold last year, for Overview's Last year column.

Reads the sales file the approved plan was trained on: units and, where the
file has selling prices, revenue for the same weeks a year earlier (364 days,
like the forecast's own lastYear), in total, by SKU and by postal code, plus
the year before that so last year's growth is known too.

Nothing is estimated: a week the file doesn't fully cover is null, and so is
revenue for a week with units that had no price yet.

Pure functions, no AWS calls. Uploaded files are untrusted input.
"""
import csv
import html
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from bisect import bisect_right
from datetime import date, timedelta
from xml.parsers import expat

import inbound
from inbound import InboundError, NS

MAX_BYTES = 25 * 1024 * 1024
MAX_UNZIPPED = 120 * 1024 * 1024
MAX_ROWS = 600_000
MAX_ZIPS = 1000
UNITS_COLS = ('shipped_units', 'shipment_units')
VERSION = 1  # of the cached result


# One row start, or one plain cell: what Excel and openpyxl write.
_PLAIN = re.compile(r'<row\b[^>]*>|<c r="([A-Z]{1,3})\d+"(?: s="\d+")?(?: t="([a-zA-Z]+)")?\s*'
                    r'(?:/>|>(?:<v>([^<]*)</v>|<is><t(?: xml:space="preserve")?>([^<]*)</t></is>|<v\s*/>)</c>)')
_ANY_CELL = re.compile(r'<(?:\w+:)?c[ >/]')


def _column(ref):
    n = 0
    for ch in ref:
        n = n * 26 + ord(ch) - 64
    return n - 1


def _sheet(z, path, shared):
    """Rows of one worksheet. A sales file is most of this Lambda's time limit,
    so plain sheets are read with one regular expression; a sheet with any cell
    it doesn't recognise is read by the XML parser instead."""
    raw = z.read(path)
    if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:  # entity expansion
        raise InboundError('The file is not a readable .xlsx file.')
    try:
        text = '' if b'<!--' in raw or b'<![CDATA[' in raw else raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = ''
    del raw
    found = _PLAIN.findall(text) if text else []
    cells = sum(1 for m in found if m[0])
    if not cells or cells != len(_ANY_CELL.findall(text)):
        yield from _sheet_xml(z, path, shared)
        return
    del text
    columns, row = {}, None
    for ref, kind, value, inline in found:
        if not ref:
            if row:
                yield row
            row = []
            continue
        at = columns.get(ref)
        if at is None:
            at = columns[ref] = _column(ref)
            if at >= 200:
                raise InboundError('The file is not a readable .xlsx file.')
        if row is None:
            row = []
        while len(row) < at:
            row.append('')
        content = value or inline
        if kind == 's' and content:
            content = shared[int(content)]
        elif '&' in content:
            content = html.unescape(content)
        if len(row) == at:
            row.append(content)
        else:
            row[at] = content
    if row:
        yield row


def _sheet_xml(z, path, shared):
    parser = expat.ParserCreate(namespace_separator='}')
    ns = NS[1:]
    CELL, VALUE, TEXT, ROW = ns + 'c', ns + 'v', ns + 't', ns + 'row'
    ready, row, columns = [], {}, {}
    state = {'col': 0, 'type': '', 'text': None, 'on': False}

    def refuse(*_):  # no DTD means no entities to expand
        raise InboundError('The file is not a readable .xlsx file.')

    def opened(tag, attrs):
        if tag == CELL:
            ref = (attrs.get('r') or '').rstrip('0123456789')
            col = columns.get(ref)
            if col is None:
                col = 0
                for ch in ref:
                    col = col * 26 + ord(ch) - 64
                columns[ref] = col
            state['col'] = col - 1 if col else len(row)
            state['type'], state['text'] = attrs.get('t'), []
        elif tag == VALUE or tag == TEXT:
            state['on'] = state['text'] is not None
        elif tag == ROW:
            row.clear()

    def closed(tag):
        if tag == VALUE or tag == TEXT:
            state['on'] = False
        elif tag == CELL:
            text = ''.join(state['text'] or ())
            row[state['col']] = shared[int(text)] if state['type'] == 's' and text else text
            state['text'] = None
        elif tag == ROW:
            width = max(row, default=-1) + 1
            if width > 200:
                refuse()
            ready.append([row.get(k, '') for k in range(width)])

    def text(chunk):
        if state['on']:
            state['text'].append(chunk)

    parser.StartElementHandler, parser.EndElementHandler, parser.CharacterDataHandler = opened, closed, text
    parser.StartDoctypeDeclHandler = refuse
    parser.buffer_text = True
    with z.open(path) as f:
        while True:
            chunk = f.read(262144)
            parser.Parse(chunk, not chunk)
            yield from ready
            ready.clear()
            if not chunk:
                return


def _tables(data, filename):
    """(shipments rows, price rows or None)."""
    if len(data) > MAX_BYTES:
        raise InboundError('The sales file is too large.')
    if not filename.lower().endswith('.xlsx'):
        text = data.decode('utf-8-sig', errors='replace')
        delimiter = ',' if filename.lower().endswith('.csv') else '\t'
        return csv.reader(io.StringIO(text), delimiter=delimiter), None
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        if sum(i.file_size for i in z.infolist()) > MAX_UNZIPPED:
            raise InboundError('The sales file is too large.')
        names, shared = z.namelist(), []
        if 'xl/sharedStrings.xml' in names:
            raw = z.read('xl/sharedStrings.xml')
            if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
                raise InboundError('The file is not a readable .xlsx file.')
            shared = [''.join(t.text or '' for t in si.iter(NS + 't')) for si in ET.fromstring(raw).iter(NS + 'si')]
        raw = z.read('xl/workbook.xml')
        if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
            raise InboundError('The file is not a readable .xlsx file.')
        sheets = [str(s.get('name', '')).strip().lower() for s in ET.fromstring(raw).iter(NS + 'sheet')]
        path = lambda n: f'xl/worksheets/sheet{n + 1}.xml'
        ship = path(sheets.index('shipments')) if 'shipments' in sheets else path(0)
        price = path(sheets.index('price')) if 'price' in sheets else None
        if ship not in names:
            raise InboundError('The file has no shipments sheet.')
        return _sheet(z, ship, shared), _sheet(z, price, shared) if price in names else None
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise InboundError('The file is not a readable .xlsx file.')


def _header(rows):
    return [str(h).strip().lower().lstrip('﻿') for h in next(rows, [])]


def _col(header, names):
    return next((header.index(n) for n in names if n in header), None)


def _cell(row, i):
    return row[i].strip() if i is not None and i < len(row) else ''


def summarize(data, filename, sku_map, weeks):
    """sku_map: {product in the file: forecast SKU}; weeks: the forecast's
    forward week starts (ISO). Every list lines up with weeks."""
    try:
        return _summarize(data, filename, sku_map, weeks)
    except (IndexError, KeyError, ValueError, ET.ParseError, expat.ExpatError, zipfile.BadZipFile) as exc:
        if isinstance(exc, InboundError):
            raise
        raise InboundError('The sales file could not be read.')


def _summarize(data, filename, sku_map, weeks):
    ship, price = _tables(data, filename)
    ship = iter(ship)
    header = _header(ship)
    c_day, c_sku = _col(header, ('ship_day',)), _col(header, inbound.SKU_COLS)
    c_zip, c_units = _col(header, ('postal_code',)), _col(header, UNITS_COLS)
    c_price = _col(header, ('avg_our_price',))
    if None in (c_day, c_sku, c_zip, c_units):
        raise InboundError('The sales file has no ship_day, sku, postal_code or shipped_units column.')

    seen_days = {}

    def as_day(text):  # the same few hundred dates repeat on every row
        if text not in seen_days:
            seen_days[text] = inbound._date(text)
        return seen_days[text]

    prices = {}  # (product, postal code or ''): {day: price}
    has_price = c_price is not None
    if price is not None:
        price = iter(price)
        ph = _header(price)
        p_day, p_sku, p_zip, p_val = _col(ph, ('ship_day',)), _col(ph, inbound.SKU_COLS), _col(ph, ('postal_code',)), _col(ph, ('avg_our_price',))
        if None not in (p_day, p_sku, p_val):
            has_price = True
            for n, row in enumerate(price):
                if n > MAX_ROWS:
                    raise InboundError('The sales file has too many rows.')
                day, value = as_day(_cell(row, p_day)), inbound._units(_cell(row, p_val))
                if day and value:
                    prices.setdefault((_cell(row, p_sku), _cell(row, p_zip)), {})[day] = value

    # Which of the two earlier years, and which forecast week, a day falls in.
    slot = {}
    for i, week in enumerate(weeks):
        first = date.fromisoformat(week)
        for year in (1, 2):
            for d in range(7):
                slot[first - timedelta(days=364 * year - d)] = (year, i)

    sold, first_day, last_day = [], None, None
    for n, row in enumerate(ship):
        if n > MAX_ROWS:
            raise InboundError('The sales file has too many rows.')
        day, units = as_day(_cell(row, c_day)), inbound._units(_cell(row, c_units))
        if day is None or units is None:
            continue
        first_day = day if first_day is None or day < first_day else first_day
        last_day = day if last_day is None or day > last_day else last_day
        product, postal = _cell(row, c_sku), _cell(row, c_zip)
        if c_price is not None:
            value = inbound._units(_cell(row, c_price))
            if value:
                prices.setdefault((product, postal), {})[day] = value
        if day in slot and product in sku_map:
            sold.append((day, product, postal, units))
    if first_day is None:
        raise InboundError('The sales file has no readable rows.')

    known = {key: sorted(days) for key, days in prices.items()}

    def price_on(product, postal, day):
        """That day's price, or the last one before it."""
        for key in ((product, postal), (product, '')):
            days = known.get(key)
            if days:
                at = bisect_right(days, day)
                if at:
                    return prices[key][days[at - 1]]
        return None

    size = len(weeks)
    covered = {year: [date.fromisoformat(w) - timedelta(days=364 * year) >= first_day
                      and date.fromisoformat(w) - timedelta(days=364 * year - 6) <= last_day for w in weeks] for year in (1, 2)}
    blank = lambda year: [0.0 if ok else None for ok in covered[year]]
    out = {year: {'units': blank(year), 'revenue': blank(year) if has_price else None, 'skus': {}, 'zips': {}} for year in (1, 2)}
    for day, product, postal, units in sold:
        year, i = slot[day]
        if not covered[year][i]:
            continue
        box, sku = out[year], sku_map[product]
        place = box['zips'].setdefault(postal, {'units': blank(year), 'revenue': blank(year) if has_price else None})
        box['skus'].setdefault(sku, blank(year))[i] += units
        box['units'][i] += units
        place['units'][i] += units
        if has_price and units:
            value = price_on(product, postal, day)
            for series in (box['revenue'], place['revenue']):
                series[i] = None if value is None or series[i] is None else series[i] + units * value

    def tidy(values):
        return None if values is None else [None if v is None else round(v, 2) for v in values]

    result = {'version': VERSION, 'weeks': list(weeks), 'from': first_day.isoformat(), 'to': last_day.isoformat()}
    for year, name in ((1, 'last'), (2, 'before')):
        box = out[year]
        zips = box['zips'] if len(box['zips']) <= MAX_ZIPS else None
        result[name] = {'units': tidy(box['units']), 'revenue': tidy(box['revenue']),
                        'skus': {k: tidy(v) for k, v in box['skus'].items()},
                        'zips': None if zips is None else {k: {'units': tidy(v['units']), 'revenue': tidy(v['revenue'])} for k, v in zips.items()}}
    return result
