"""Inbound receipts summary for the Inventory page.

Reads the receipts file uploaded in Getting Started and summarises what it
really contains, per forecast SKU and site: units received, last receipt and
how often deliveries arrive. Receipts say what arrived, not what is left, so
this never produces on-hand, in-transit or open-PO figures.

Pure functions, no AWS calls. Uploaded files are untrusted input.
"""
import csv
import io
import re
import statistics
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, datetime, timedelta

MAX_BYTES = 10 * 1024 * 1024
MAX_UNZIPPED = 60 * 1024 * 1024
MAX_ROWS = 300_000
DATE_COLS = ('receipt_date', 'received_date', 'date', 'day', 'ship_day')
SKU_COLS = ('sku', 'sku_id', 'asin')
UNITS_COLS = ('units_received', 'received_units', 'units', 'qty', 'quantity')
# Same site columns Getting Started looks for (js/onboarding.js).
SITE_COLS = ('site_code', 'site', 'warehouse_code', 'warehouse', 'location_code', 'location', 'dc')
SITE_NAME_COLS = ('site_name', 'warehouse_name', 'location_name', 'name')
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


class InboundError(ValueError):
    """The file can't be summarised; the message is safe to show the user."""


def _xlsx_rows(data):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise InboundError('The inbound file is not a readable .xlsx file.')
    if sum(i.file_size for i in z.infolist()) > MAX_UNZIPPED:
        raise InboundError('The inbound file is too large.')

    def xml(name):
        raw = z.read(name)
        if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:  # entity expansion
            raise InboundError('The inbound file is not a readable .xlsx file.')
        return ET.fromstring(raw)

    try:
        names = z.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in names:
            shared = [''.join(t.text or '' for t in si.iter(NS + 't')) for si in xml('xl/sharedStrings.xml').iter(NS + 'si')]
        sheets = [s.get('name', '') for s in xml('xl/workbook.xml').iter(NS + 'sheet')]
        n = next((i for i, s in enumerate(sheets) if s.strip().lower() == 'receipts'), 0) + 1
        sheet = f'xl/worksheets/sheet{n}.xml'
        if sheet not in names:
            sheet = sorted(x for x in names if x.startswith('xl/worksheets/sheet'))[0]
        for row in xml(sheet).iter(NS + 'row'):
            cells = {}
            for c in row.iter(NS + 'c'):
                col = re.match(r'[A-Z]+', c.get('r') or '')
                v, inline = c.find(NS + 'v'), c.find(NS + 'is')
                text = (''.join(t.text or '' for t in inline.iter(NS + 't')) if inline is not None
                        else '' if v is None else v.text or '')
                if c.get('t') == 's' and text:
                    text = shared[int(text)]
                idx = 0
                for ch in (col.group(0) if col else ''):
                    idx = idx * 26 + ord(ch) - 64
                cells[idx - 1 if idx else len(cells)] = text
            yield [cells.get(i, '') for i in range(max(cells, default=-1) + 1)]
    except InboundError:
        raise
    except (KeyError, IndexError, ValueError, ET.ParseError, zipfile.BadZipFile):
        raise InboundError('The inbound file is not a readable .xlsx file.')


def _rows(data, filename):
    if len(data) > MAX_BYTES:
        raise InboundError('The inbound file is too large.')
    if filename.lower().endswith('.xlsx'):
        return _xlsx_rows(data)
    text = data.decode('utf-8-sig', errors='replace')
    head = text.split('\n', 1)[0]
    return csv.reader(io.StringIO(text), delimiter='\t' if '\t' in head else ',')


def _date(value):
    value = str(value).strip()
    if re.fullmatch(r'\d{5}(\.\d+)?', value):  # Excel serial day
        return date(1899, 12, 30) + timedelta(days=int(float(value)))
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%d-%m-%Y', '%d/%m/%Y'):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    return None


def _units(value):
    try:
        n = float(str(value).replace(',', '').strip())
    except ValueError:
        return None
    return n if 0 <= n < 1e12 else None


def _num(n):
    return int(n) if float(n).is_integer() else round(n, 2)


def _stats(receipts, today):
    """receipts: {date: units}"""
    days = sorted(receipts)
    gaps = [(b - a).days for a, b in zip(days, days[1:])]
    since = today - timedelta(days=30)
    return {'received_30d': _num(sum(u for d, u in receipts.items() if d > since)),
            'received_total': _num(sum(receipts.values())),
            'receipts': len(days), 'last_receipt': days[-1].isoformat(),
            'every_days': _num(statistics.median(gaps)) if gaps else None}


def summarize(data, filename, sku_map, today):
    """sku_map: {SKU in the uploaded files: forecast SKU}."""
    rows = iter(_rows(data, filename))
    header = [str(h).strip().lower().lstrip('﻿') for h in next(rows, [])]

    def col(names):
        return next((header.index(n) for n in names if n in header), None)
    c_date, c_sku, c_units = col(DATE_COLS), col(SKU_COLS), col(UNITS_COLS)
    c_site, c_name = col(SITE_COLS), col(SITE_NAME_COLS)
    missing = [label for label, c in (('receipt_date', c_date), ('sku', c_sku), ('units_received', c_units)) if c is None]
    if missing:
        raise InboundError('The inbound file is missing: ' + ', '.join(missing) + '.')

    lookup = {str(k).strip().upper(): v for k, v in sku_map.items()}
    by_sku, names, unmatched = {}, {}, set()
    used = skipped = future = 0
    for n, row in enumerate(rows):
        if n >= MAX_ROWS:
            raise InboundError('The inbound file has too many rows.')
        if not any(str(x).strip() for x in row):
            continue
        cell = lambda c: str(row[c]).strip() if c is not None and c < len(row) else ''
        day, units, raw = _date(cell(c_date)), _units(cell(c_units)), cell(c_sku).upper()
        if day is None or units is None or not raw:
            skipped += 1
            continue
        if day > today:  # not received yet, so not a receipt
            future += 1
            continue
        sku = lookup.get(raw)
        if sku is None:
            unmatched.add(raw)
            continue
        site = cell(c_site)[:60]
        if site and cell(c_name):
            names[site] = cell(c_name)[:80]
        dates = by_sku.setdefault(sku, {}).setdefault(site, {})
        dates[day] = dates.get(day, 0) + units
        used += 1

    out = {}
    for sku, sites in by_sku.items():
        total = {}
        for dates in sites.values():
            for d, u in dates.items():
                total[d] = total.get(d, 0) + u
        out[sku] = {**_stats(total, today), 'sites': [
            {'code': s, 'name': names.get(s, ''), **_stats(d, today)} for s, d in sorted(sites.items()) if s]}
    return {'by_sku': out, 'rows_used': used, 'rows_skipped': skipped, 'rows_future': future,
            'skus_unmatched': len(unmatched), 'as_of': today.isoformat()}
