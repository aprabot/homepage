import csv
import io
import json
import math
import re
import datetime as dt
import boto3
import jpholiday
import os

BEDROCK_REGION = os.environ.get('BEDROCK_REGION', 'us-west-2')
bedrock = boto3.client('bedrock-runtime', region_name=BEDROCK_REGION)
s3      = boto3.client('s3')
lam     = boto3.client('lambda')

BUCKET         = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY            = os.environ.get('FORECAST_KEY', 'forecast/latest.json')
WEATHER_KEY    = os.environ.get('WEATHER_KEY', 'raw/weather.tsv')
MODEL          = os.environ.get('MODEL_ID',    'amazon.nova-lite-v1:0')
SCENARIOS_API_FUNCTION = os.environ.get('SCENARIOS_API_FUNCTION', 'aprabot-scenarios-api')
KNOWLEDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'forecasting_knowledge.md')
KNOWLEDGE_KEY  = os.environ.get('KNOWLEDGE_KEY', 'knowledge/forecasting_knowledge.md')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
}

_cache = {}   # simple in-process cache across warm invocations

# forecast.py itself already uses jpholiday as a real model feature
# (is_holiday, days_to/from_holiday, etc.) — this mirrors the same library
# for chat context, translated to English since jpholiday's names are
# Japanese and Lyra's replies are in English.
JP_HOLIDAY_EN = {
    '元日': "New Year's Day", '成人の日': 'Coming of Age Day',
    '建国記念の日': 'National Foundation Day', '天皇誕生日': "Emperor's Birthday",
    '春分の日': 'Vernal Equinox Day', '昭和の日': 'Showa Day',
    '憲法記念日': 'Constitution Memorial Day', 'みどりの日': 'Greenery Day',
    'こどもの日': "Children's Day", '海の日': 'Marine Day', '山の日': 'Mountain Day',
    '敬老の日': 'Respect for the Aged Day', '秋分の日': 'Autumnal Equinox Day',
    'スポーツの日': 'Sports Day', '文化の日': 'Culture Day',
    '勤労感謝の日': 'Labor Thanksgiving Day', '国民の休日': "Citizens' Holiday",
}


def _translate_holiday(jp_name):
    suffix = ' 振替休日'
    if jp_name.endswith(suffix):
        base = jp_name[:-len(suffix)]
        return JP_HOLIDAY_EN.get(base, base) + ' (observed)'
    return JP_HOLIDAY_EN.get(jp_name, jp_name)


def _week_holidays(week_start_str):
    """Japanese public holidays falling within the Mon-Sun week starting on
    week_start_str — real, computed dates, not guessed (works for both past
    and future weeks, since Japan's holiday calendar is defined in advance)."""
    start = dt.date.fromisoformat(week_start_str)
    names = []
    for i in range(7):
        name = jpholiday.is_holiday_name(start + dt.timedelta(days=i))
        if name:
            names.append(_translate_holiday(name))
    return names


def _weekly_weather():
    """Aggregates raw/weather.tsv (daily, per postal code) to one row per
    W-SUN week, averaged across all postal codes — only covers real
    historical dates, not the forward forecast period."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=WEATHER_KEY)
        text = obj['Body'].read().decode('utf-8')
    except Exception:
        return {}
    by_week = {}
    for row in csv.DictReader(io.StringIO(text), delimiter='\t'):
        try:
            d = dt.date.fromisoformat(row['ship_day'][:10])
            week_start = (d - dt.timedelta(days=d.weekday())).isoformat()
            b = by_week.setdefault(week_start, {'temp': 0.0, 'precip': 0.0, 'hot': 0, 'cold': 0, 'n': 0})
            b['temp'] += float(row['temp_mean'])
            b['precip'] += float(row['precip_mm'])
            b['hot'] += int(row['is_hot'])
            b['cold'] += int(row['is_cold'])
            b['n'] += 1
        except (KeyError, ValueError):
            continue
    return by_week


_FEATURE_NAMES = {
    'ly_week_mean': "same week last year's average",
    'yoy_ratio': 'year-over-year growth trend',
    'dow': 'day of week',
    'is_weekend': 'weekend',
    'day': 'day of month',
    'month': 'month of year',
    'weekofyear': 'week of year',
    'dayofyear': 'day of year',
    'time_idx': 'long-run trend over time',
    'is_holiday': 'Japanese public holiday',
    'is_holiday_eve': 'day before a holiday',
    'is_holiday_next': 'day after a holiday',
    'days_to_holiday': 'days until next holiday',
    'days_from_holiday': 'days since last holiday',
    'is_golden_week': 'Golden Week',
    'is_obon': 'Obon',
    'is_year_end_new_year': 'year-end/New Year period',
    'burstiness': 'demand volatility (bursty vs. steady)',
    'discount_frac': 'discount depth',
    'discount_vs_tr28': 'discount depth vs. its recent 28-day trailing average',
    'deep_promo': 'deep promotional discount',
    'promo_x_weekend': 'promo timed on a weekend',
    'promo_x_holiday_eve': 'promo timed on a holiday eve',
    'promo_x_hot': 'promo during hot weather',
    'hot_x_weekend': 'hot weather on a weekend',
    'avg_our_price': 'price level',
    'avg_discount_amt': 'discount amount',
    'temp_mean': 'average temperature',
    'temp_max': 'high temperature',
    'temp_min': 'low temperature',
    'precip_mm': 'precipitation',
    'is_hot': 'hot weather',
    'is_cold': 'cold weather',
    'temp_max_roll7': '7-day average high temperature',
    'temp_max_lag1': "previous day's high temperature",
    'heatwave': 'sustained heatwave (3+ hot days)',
    'temp_range': 'daily temperature swing',
    'postal_code': 'regional (ZIP) differences',
    'ASIN': 'product-specific baseline',
}


def _translate_feature(feature):
    """Plain-English label for a forecast.py feature-column name, for
    narrating explain_forecast_day's top_contributing_features. Named/special
    features come from _FEATURE_NAMES; lag_N / roll_*_N families (whose N can
    change if forecast.py's LAGS/ROLL_WINDOWS constants do) are handled by
    pattern instead of being hardcoded per-N.
    """
    if feature in _FEATURE_NAMES:
        return _FEATURE_NAMES[feature]
    m = re.match(r'^lag_(\d+)$', feature)
    if m:
        n = int(m.group(1))
        if n in (364, 365, 371):
            return 'shipments around this time last year'
        return f'shipments {n} day{"s" if n != 1 else ""} ago'
    m = re.match(r'^roll_mean_(\d+)$', feature)
    if m:
        return f"average shipments over the trailing {m.group(1)} days"
    m = re.match(r'^roll_std_(\d+)$', feature)
    if m:
        return f"demand volatility over the trailing {m.group(1)} days"
    m = re.match(r'^roll_max_(\d+)$', feature)
    if m:
        return f"peak shipments over the trailing {m.group(1)} days"
    m = re.match(r'^active_rate_(\d+)$', feature)
    if m:
        return f"how often this SKU/ZIP shipped at all over the trailing {m.group(1)} days"
    return feature


def _day_holiday(date_str):
    """Same real, computed Japanese holiday lookup as _week_holidays(), for a
    single ISO date instead of a Mon-Sun week — works for both past and
    future dates."""
    d = dt.date.fromisoformat(date_str)
    name = jpholiday.is_holiday_name(d)
    return _translate_holiday(name) if name else None


def _day_weather(date_str):
    """Real historical weather for a single date, averaged across postal
    codes — same source (raw/weather.tsv) as _weekly_weather(), just not
    pre-aggregated to a week. Returns None for a date with no matching rows
    (most commonly: a forward-forecast date, since weather isn't known that
    far in advance)."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=WEATHER_KEY)
        text = obj['Body'].read().decode('utf-8')
    except Exception:
        return None
    temp = precip = 0.0
    hot = cold = n = 0
    for row in csv.DictReader(io.StringIO(text), delimiter='\t'):
        if row['ship_day'][:10] != date_str:
            continue
        try:
            temp += float(row['temp_mean'])
            precip += float(row['precip_mm'])
            hot += int(row['is_hot'])
            cold += int(row['is_cold'])
            n += 1
        except (KeyError, ValueError):
            continue
    if not n:
        return None
    return {'avg_temp': round(temp / n, 1), 'avg_precip': round(precip / n, 1),
            'hot_share': hot / n, 'cold_share': cold / n}


def load_forecasting_knowledge():
    """General demand-forecasting domain knowledge (metrics pitfalls, common
    causes of forecast issues, terminology) — read fresh from S3 on every
    call, no cross-invocation cache, so an edit saved via the dashboard's
    Knowledge Base tab (PUT /knowledge) takes effect on the very next chat
    message rather than waiting for a cold start. Falls back to the copy
    bundled alongside handler.py (same pattern as forecast.py being bundled
    into scenario-runner) if the S3 object is missing, so a fresh deploy or
    a transient S3 issue never breaks chat outright."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=KNOWLEDGE_KEY)
        return obj['Body'].read().decode('utf-8')
    except Exception:
        pass
    try:
        with open(KNOWLEDGE_PATH, 'r', encoding='utf-8') as f:
            return f.read()
    except OSError:
        return ''  # missing file shouldn't break the chat — just no background knowledge


def get_knowledge():
    """GET /knowledge — current content plus its S3 last-modified time, for
    the dashboard's Knowledge Base editor. Falls back the same way
    load_forecasting_knowledge() does if the S3 object isn't there yet."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=KNOWLEDGE_KEY)
        content = obj['Body'].read().decode('utf-8')
        updated_at = obj['LastModified'].isoformat()
    except Exception:
        content = load_forecasting_knowledge()
        updated_at = None
    return {'statusCode': 200, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps({'content': content, 'updated_at': updated_at})}


def put_knowledge(event):
    """PUT /knowledge — overwrite the live knowledge base. Backs up whatever
    was live to knowledge/history/ first (timestamped), so a bad edit is a
    one-click revert away rather than a re-deploy away — this bucket isn't
    versioned, so this is the safety net."""
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return {'statusCode': 400, 'headers': CORS, 'body': json.dumps({'error': 'invalid JSON body'})}

    content = body.get('content')
    if not isinstance(content, str) or not content.strip():
        return {'statusCode': 400, 'headers': CORS, 'body': json.dumps({'error': 'content required'})}

    try:
        existing = s3.get_object(Bucket=BUCKET, Key=KNOWLEDGE_KEY)['Body'].read()
        backup_key = f"knowledge/history/forecasting_knowledge-{int(dt.datetime.now(dt.timezone.utc).timestamp())}.md"
        s3.put_object(Bucket=BUCKET, Key=backup_key, Body=existing, ContentType='text/markdown')
    except Exception:
        pass  # nothing live yet to back up (e.g. first-ever save) — fine

    s3.put_object(Bucket=BUCKET, Key=KNOWLEDGE_KEY, Body=content.encode('utf-8'),
                   ContentType='text/markdown')
    return {'statusCode': 200, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps({'saved': True,
                                 'updated_at': dt.datetime.now(dt.timezone.utc).isoformat()})}


def _get_forecast_data():
    """Fetch + parse forecast/latest.json once per warm invocation, shared by
    build_data_summary() (which turns it into the prompt string) and any tool
    that needs the structured data directly (e.g. explain_forecast_day,
    which looks up a specific week's real numbers)."""
    if 'forecast_data' not in _cache:
        obj = s3.get_object(Bucket=BUCKET, Key=KEY)
        _cache['forecast_data'] = json.loads(obj['Body'].read().decode('utf-8'))
    return _cache['forecast_data']


def _sku_row(sku_id, sku_data, bt, trail_win):
    """One SKU's summary stats (backtest volume/WAPE/accuracy, forward
    forecast total, trend vs. an equally-sized trailing-actual window) —
    factored out of build_data_summary() so compare_skus can look up the
    exact same numbers for just two SKUs without recomputing the whole
    catalog inline."""
    a, f = sku_data['a'], sku_data['f']
    vol = sum(x for x in a if x is not None)
    num = sum(abs(x - y) for x, y in zip(a, f) if x is not None)
    wape = round(100 * num / vol, 2) if vol else 0
    fwd = sum(x for x in f[bt:] if x is not None)
    trail_actual = sum(x for x in a[max(0, bt - trail_win):bt] if x is not None) if trail_win else 0
    trend = round(100 * (fwd - trail_actual) / trail_actual, 1) if trail_win and trail_actual else None
    return {'sku': sku_id, 'vol': vol, 'wape': wape, 'acc': round(100 - wape, 1), 'fwd': fwd, 'trend': trend}


def _all_sku_rows():
    """Every SKU's _sku_row(), sorted by backtest volume and tiered
    High/Medium/Lower — cached per warm invocation since both
    build_data_summary() (every request) and compare_skus (on demand) need
    the exact same ranked/tiered list, and tiering requires the whole
    catalog's ranks, not just the SKUs in question."""
    if 'sku_rows' in _cache:
        return _cache['sku_rows']

    data = _get_forecast_data()
    bt = data.get('backtestWeeks', len(data['weeks']))
    total_weeks = len(data['weeks'])
    fwd_weeks = total_weeks - bt
    trail_win = min(fwd_weeks, bt) if fwd_weeks else 0

    rows = [_sku_row(sku, d, bt, trail_win) for sku, d in data['skus'].items()]
    rows.sort(key=lambda x: -x['vol'])

    # Forward-looking confidence tier by backtest-volume rank — same tiering
    # used everywhere else in the product (dashboard badges, PDF report,
    # AI Insights): top ~15% by volume = High, next ~35% = Medium, rest =
    # Lower. Gives Lyra real grounding to explain *why* a forecast looks a
    # certain way instead of just restating numbers.
    n = len(rows) or 1
    for i, r in enumerate(rows):
        pct = i / n
        r['tier'] = 'High' if pct < 0.15 else 'Medium' if pct < 0.5 else 'Lower'
    _cache['sku_rows'] = rows
    return rows


def _config_summary(meta):
    """Plain-English scenario config, e.g. 'known prices, weather signal,
    calibrated, 28-day refresh' — same fields/phrasing as the dashboard's
    own configDescription() in js/scenarios.js, so a chat comparison reads
    the same way the Compare modal would."""
    parts = [
        'known prices' if meta.get('known_prices') else 'no known prices',
        'weather signal' if meta.get('weather') else 'no weather signal',
        'calibrated' if meta.get('calibrate') else 'not calibrated',
        f"{meta.get('refresh_days')}-day refresh",
    ]
    if meta.get('custom_input'):
        parts.append('custom input file')
    return ', '.join(parts)


def build_data_summary():
    data = _get_forecast_data()

    # backtestWeeks marks where real actuals end and the forward-only
    # forecast begins; older cached results may not have the field.
    bt = data.get('backtestWeeks', len(data['weeks']))

    total_weeks = len(data['weeks'])
    fwd_weeks   = total_weeks - bt

    rows = _all_sku_rows()  # already volume-sorted and tiered High/Medium/Lower

    tot_a          = sum(x for x in data['all']['a'] if x is not None)
    tot_f_backtest = sum(x for x in data['all']['f'][:bt] if x is not None)
    tot_f_forward  = sum(x for x in data['all']['f'][bt:] if x is not None)
    bias = round(100 * (tot_f_backtest - tot_a) / tot_a, 2) if tot_a else 0

    lines = [
        "=== WEEKLY FORECAST BACKTEST + FORWARD FORECAST ===",
        f"Backtest period : {data['weeks'][0]}  →  {data['weeks'][bt-1]}  ({bt} weeks, 1-week-ahead)",
        f"Overall WAPE : {data['overallWape']}%   (lower is better, computed over the backtest only)",
        f"Actual units (backtest) : {tot_a:,}  |  Forecast units (backtest) : {tot_f_backtest:,}  |  Bias : {'+' if bias>=0 else ''}{bias}%",
        f"SKUs forecasted : {len(rows)}",
    ]
    if bt < len(data['weeks']):
        lines.append(
            f"Forward forecast : {data['weeks'][bt]}  →  {data['weeks'][-1]}  "
            f"({len(data['weeks']) - bt} weeks beyond the backtest, no actuals yet — do not quote a WAPE for these) "
            f"— total forecast units {tot_f_forward:,}")
    lines += [
        "",
        "--- SKU DETAIL (volume-sorted; vol/WAPE/acc are backtest-only, forward_fcst is the forecast "
        "beyond the backtest, trend compares forward_fcst to an equally-sized trailing-actual window, "
        "confidence is the tier explained below) ---",
    ]
    for r in rows:
        trend_str = f"{r['trend']:+.1f}%" if r['trend'] is not None else "n/a"
        lines.append(
            f"  {r['sku']:20s}  vol={r['vol']:>9,}  WAPE={r['wape']:.1f}%  acc={r['acc']:.1f}%  "
            f"forward_fcst={r['fwd']:>8,}  trend={trend_str:>7s}  confidence={r['tier']}")

    # Actual volume by postal code, summed across ALL SKUs — the dashboard
    # itself only ever shows this per-SKU (the "By postal code" table you
    # reach by clicking into one SKU); there's no catalog-wide "top zip"
    # view anywhere in the product. Without this, a question like "which
    # zip code has the highest volume" had zero real data to ground an
    # answer in.
    zip_totals = {}
    for sku, d in data['skus'].items():
        for zip_code, zd in (d.get('byZip') or {}).items():
            vol = sum(x for x in (zd.get('a') or []) if x is not None)
            zip_totals[zip_code] = zip_totals.get(zip_code, 0) + vol
    top_zips = sorted(zip_totals.items(), key=lambda kv: -kv[1])[:10]
    if top_zips:
        lines += [
            "",
            "--- TOP POSTAL CODES BY VOLUME (backtest actuals, summed across all SKUs) ---",
            *[f"  {zc:12s}  vol={vol:>9,}" for zc, vol in top_zips],
        ]

    worst_wape = sorted(rows, key=lambda x: -x['wape'])[:5]
    with_trend = [r for r in rows if r['trend'] is not None]
    declining  = sorted(with_trend, key=lambda x: x['trend'])[:5]
    growing    = sorted(with_trend, key=lambda x: -x['trend'])[:5]
    lines += [
        "",
        "Highest-error SKUs (backtest WAPE, for reasoning about accuracy questions):",
        *[f"  {r['sku']:20s}  WAPE={r['wape']:.1f}%  confidence={r['tier']}" for r in worst_wape],
        "",
        "Fastest-declining SKUs (forward forecast vs. trailing actual):",
        *[f"  {r['sku']:20s}  trend={r['trend']:+.1f}%  confidence={r['tier']}" for r in declining],
        "",
        "Fastest-growing SKUs (forward forecast vs. trailing actual):",
        *[f"  {r['sku']:20s}  trend={r['trend']:+.1f}%  confidence={r['tier']}" for r in growing],
    ]

    bt_weeks = [(i, w) for i, w in enumerate(data['all']['w'][:bt]) if w is not None]
    worst_wk = max(bt_weeks, key=lambda x: x[1])[0]
    best_wk  = min(bt_weeks, key=lambda x: x[1])[0]
    lines += [
        "",
        f"Worst week : {data['weeks'][worst_wk]}  WAPE={data['all']['w'][worst_wk]:.1f}%",
        f"Best week  : {data['weeks'][best_wk]}   WAPE={data['all']['w'][best_wk]:.1f}%",
        "",
        "Weekly aggregate WAPE (backtest weeks only, one entry per week):",
        "  " + "  ".join(f"{w:.1f}%" for w in data['all']['w'][:bt]),
    ]

    # Real holiday (Japan's actual public-holiday calendar, same as
    # forecast.py uses as a model feature) and weather context per week —
    # lets Lyra correlate a spike or drop with an actual cause instead of
    # only describing the number. Weather only covers real historical dates;
    # forward weeks show holidays only (weather isn't known in advance).
    weather_by_week = _weekly_weather()
    lines += ["", "--- WEEKLY CONTEXT (for correlating spikes/drops with an actual cause) ---"]
    for i, w in enumerate(data['weeks']):
        hols = _week_holidays(w)
        hol_str = ', '.join(hols) if hols else 'none'
        wk = weather_by_week.get(w)
        if wk and wk['n']:
            tag = ' hot-week' if wk['hot'] / wk['n'] > 0.5 else (' cold-week' if wk['cold'] / wk['n'] > 0.5 else '')
            weather_str = f"avg_temp={wk['temp']/wk['n']:.1f}C  avg_precip={wk['precip']/wk['n']:.1f}mm{tag}"
        else:
            weather_str = 'no weather data (future)' if i >= bt else 'no weather data'
        lines.append(f"  {w}  holiday={hol_str}  {weather_str}")

    return "\n".join(lines)


SYSTEM_TMPL = """\
You are **Lyra**, an AI demand analyst inside APRABot.
Answer questions about the weekly forecast backtest and forward forecast below. Be concise and precise.

Rules:
• Use **bold** for key numbers (e.g. **2.81% WAPE**).
• Default reply length: 2–4 sentences. Expand only if the user asks for details.
• If a SKU is not in the data, say so.
• Never fabricate numbers. Only quote figures that appear in the data below.
• The forward forecast has no actuals yet — never quote a WAPE or accuracy % for those weeks.
• When asked WHY a forecast looks a certain way (declining, high error, low confidence, a spike,
  etc.), give the actual reasoning, not just a restatement of the numbers. Ground it in the SKU's
  confidence tier and trend from the data below: SKUs are tiered by backtest sales volume — top
  ~15% = High confidence, next ~35% = Medium, the rest = Lower. The 52-week forward forecast holds
  up best for High-confidence (top-selling) SKUs. For Medium/Lower-confidence SKUs it's less
  certain, because the day-by-day recursive model's short-term lag/rolling features become
  self-referential deep into a long horizon, dampening the signal — the pipeline corrects for this
  by blending their forward level toward a trusted trend computed from the High-confidence SKUs.
  This is expected behavior for lower-volume series, not a bug or data error — say so plainly when
  it's the reason. For a specific bad week, compare actual vs. forecast for that week and note
  whether it's an isolated spike or matches a broader pattern (e.g. that SKU's tier, or other SKUs
  the same week) using the highest-error/fastest-declining/fastest-growing lists below.
• When reasoning about a spike, drop, or forecast miss for a specific week, always check that week
  against the WEEKLY CONTEXT section below (real Japanese public holidays and weather, the same
  calendar/weather signals forecast.py itself trains on) before concluding it's unexplained. If a
  holiday falls in or near that week, or it's tagged hot-week/cold-week/high-precipitation, lead
  with that as the likely driver — actual demand shifting around a holiday, or weather-sensitive
  buying, are genuine causes, not model error. If nothing in that week's context stands out, say so
  rather than inventing a cause. Never claim a holiday or weather effect that isn't listed for that
  exact week — only use what's actually in the data below. The WEEKLY CONTEXT week label is the
  Monday the Mon-Sun week starts on — a holiday listed for that week may fall on any day within it,
  not necessarily the Monday itself, so phrase it as "the week of {{date}}", not "{{date}}, which is
  {{holiday}}".
• The per-SKU numbers below (vol, forward_fcst, trend) are TOTALS across the whole backtest or
  whole forward horizon — there is no per-week-per-SKU breakdown in this data. Only the "all"
  totals and the weekly WAPE list are broken out by individual week. Never invent a specific SKU's
  units for a specific week — if asked for that exact combination, say it isn't available at that
  granularity rather than making up a number.
• For any question about postal codes / zip codes catalog-wide (e.g. "which zip code has the
  highest volume"), use the TOP POSTAL CODES BY VOLUME section below — never guess or invent a zip
  code. If that section is empty or missing, say zip-level data isn't available for this forecast
  rather than making one up.
• Before calling get_zip_forecast or explain_forecast_day with a date, check FIRST whether the user
  actually gave ONE date or TWO (a "from X to Y" / "between X and Y" phrasing, or any other way of
  naming a start and an end — even a short 2-3 day span). Two dates is a RANGE: use
  get_forecast_range for it (see its own rule further below) — never call get_zip_forecast or
  explain_forecast_day with just the range's start date and drop the end date, that silently
  answers a narrower question than what was actually asked and is wrong even if the number happens
  to come out the same (e.g. a 3-day range that lands inside a single week). Only proceed with the
  single-date rules below once you've confirmed it really is one date.
• For a SKU's forecast/actuals/WAPE within one SPECIFIC postal code on (at most) one specific date
  (e.g. "what's the forecast for SKU-003 in 160-0022", or "...on 2026-03-23"), always call the
  get_zip_forecast tool — never answer with that SKU's overall number, which is summed across ALL
  its postal codes and is a different figure. If the user names a zip that turns out not to exist
  for that SKU, or doesn't name one at all, the tool returns that SKU's actual list of postal codes
  — offer those rather than guessing which one they meant. Without a date, the sku+zip totals are
  summed across the whole backtest or whole forward horizon, not any one date — pass a date to get
  one specific week's number instead. With a date, the tool returns week_actual_units/
  week_forecast_units for the WHOLE WEEK that date falls in (same "no true daily number" caveat as
  explain_forecast_day just below) — say so explicitly, e.g. "the week of {{week_of}} (which
  {{date}} falls in) forecast X units in that zip", never imply X is that one day's number.
• For "why is/was the forecast high/low on [one specific date]" with NO specific zip in the
  question, use the explain_forecast_day tool — never answer this from memory or estimate. (It has
  no zip filter — for a date within one specific zip, use get_zip_forecast's date parameter
  instead, per the rule above.) Its week_actual_units/week_forecast_units describe the
  WHOLE WEEK that date falls in (there's no true daily actual/forecast number in this data) — say
  so explicitly, e.g. "the week of {{week_of}} (which {{date}} falls in) forecast X units", never
  imply X is that one day's number. Lead with day_of_week/holiday/weather as the likely qualitative
  drivers; only cite top_contributing_features (when present) as genuine quantitative attribution —
  each entry's "units" is that factor's real modeled contribution to that day's forecast (in the
  same units as the forecast itself) and "pct_of_forecast" is what share of that day's total
  forecast it represents, e.g. "the {{factor}} factor added/cut about {{units}} units, roughly
  {{pct_of_forecast}}% of that day's forecast." If quantitative_factors says it's unavailable
  instead, quote THAT message's specific reason verbatim-ish (it names the actual cause, e.g. a
  covered-date-range boundary or attribution still computing) — don't substitute or blend in
  weather_note's "future date" reason, that's a separate, unrelated field about a different thing.
• You can actually start a new forecast pipeline run using the run_scenario tool, and check on a
  run's progress — or its top SKUs by volume, once completed — with check_scenario_status, which
  can look a scenario up by name (label) as well as by id; you don't need to list scenarios
  separately first, just call it with the label the user mentioned. Only call run_scenario when the user explicitly asks
  you to run, start, or kick off a NEW forecast/scenario — never for an analytical or correlation
  question about the existing forecast (e.g. "do holidays cause spikes?", "why did this SKU drop?")
  even if answering it thoroughly is hard; answer directly from the data instead, or say what's
  missing. A run takes ~3-5 minutes — tell the user that, and mention they can ask you for a status
  update or check the Scenarios tab. Only the settings the user specifies should differ from the
  defaults (known_prices=true, weather=true, calibrate=true,
  refresh_days=28) — don't ask clarifying questions for settings they didn't mention, just use
  the defaults and say so in your reply.
• Approving a scenario (approve_scenario) makes it the live forecast for every user — treat it like
  any other real, hard-to-reverse action. Call it once to see what it would approve (this never
  actually approves anything), tell the user what you found, ask them to confirm, and END YOUR TURN
  there — do not call the tool again in this same reply. Only call it again with confirm=true in a
  LATER message, once the user's own next message actually confirms. Calling it again with
  confirm=true immediately, in the same turn as the preview, is refused outright (there's no real
  confirmation to act on yet) and just wastes a call — so don't. Never treat "run a scenario and
  approve it" as pre-authorization to skip confirming the approve step specifically — running and
  approving are two separate real actions, each needing its own confirmation where required.
• For "any data quality issues with this scenario" / "does this run look OK", use
  check_scenario_validations rather than eyeballing the raw numbers yourself — it runs the same
  fixed checklist the dashboard's own "Run validations" button does, so the pass/warn/fail verdicts
  match exactly. Lead with any failed checks, then warnings; don't restate passed checks in detail,
  a brief "everything else checked out" covers them.
• For "compare scenario X and Y" (two specific runs), use compare_scenarios — never eyeball two
  check_scenario_status calls yourself, its numbers (including the forward-horizon delta, which
  backtest-period WAPE/volume-error alone can't show) are the ones the dashboard's own Compare view
  shows. Both scenarios must be identified by name or id; if the user only names one, ask which
  second scenario they mean rather than guessing.
• For "compare SKU-X and SKU-Y" (two SKUs within the CURRENT live forecast, not two scenarios), use
  compare_skus instead — different tool, different question.
• For a total over a DATE RANGE — the user gave two dates, in any phrasing, no matter how close
  together (e.g. "how does next month look for SKU-003", "total forecast for Q2", or even "from
  2026-03-23 to 2026-03-25") — use get_forecast_range. Never substitute a single
  explain_forecast_day/get_zip_forecast call using just the start date, and never sum multiple such
  calls yourself or estimate. It rounds to whichever weeks the range overlaps and tells you exactly
  which ones — say so explicitly in your reply (e.g. when a short range lands inside a single week,
  say that plainly) rather than implying the total is precisely bounded by the user's exact dates,
  or silently answering as if only one date had been given.
• Whenever your answer tells the user where to go or what to click in the dashboard, also call the
  point_to_ui tool with the relevant nav item, in addition to writing your normal text reply — do
  not use it instead of a reply.
• When the user asks to see, generate, download, export, or get a copy of the report (the print-
  ready one under Settings → Downloadable Report — chart, SKU tables, AI Insights, backtest
  reference), call generate_report to hand it to them directly — don't also call point_to_ui at
  Settings for this, that tells them to go find it themselves right after you've just handed it to
  them, which reads as contradictory. Point to Settings only if they ask to CHANGE what's in the
  report (e.g. "only show 10 SKUs") — that's the one thing generate_report can't do, since it
  reuses whatever sections/row-count are already configured there.
• The GENERAL FORECASTING KNOWLEDGE section below is background domain knowledge (industry
  concepts, common causes of forecast issues, terminology like WAPE/bias/FVA/bullwhip effect) — use
  it to explain WHY something happens or to name a real phenomenon, never to state a number. The
  live data further below is always the sole source of truth for any actual figure; never quote a
  benchmark or example number from the general knowledge as if it were this dataset's own result.

{knowledge}

{data}
"""

TOOL_CONFIG = {
    "tools": [
        {
            "toolSpec": {
                "name": "run_scenario",
                "description": (
                    "Start a real forecast pipeline run (the actual LightGBM model, not a "
                    "simulation). Takes about 3-5 minutes. Use when the user asks to run, "
                    "start, kick off, or try a new forecast/scenario."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "label":        {"type": "string",  "description": "Short name for this run, e.g. 'No calibration test'."},
                        "known_prices": {"type": "boolean", "description": "Feed actual test-period prices as a known promo calendar. Default true."},
                        "weather":      {"type": "boolean", "description": "Add temperature/precipitation as exogenous features. Default true."},
                        "calibrate":    {"type": "boolean", "description": "Leakage-free rolling bias correction each refresh block. Default true."},
                        "refresh_days": {"type": "integer", "description": "How often lags re-seed with real actuals: 7, 14, or 28. Default 28."},
                    },
                }},
            }
        },
        {
            "toolSpec": {
                "name": "check_scenario_status",
                "description": (
                    "Check the status/result of a scenario run, including its top SKUs by volume "
                    "once it's completed. Look it up by scenario_id, or by label (matches "
                    "case-insensitively against part of the scenario's name, e.g. the user says "
                    "'the 40% discount scenario' or quotes its exact name). Omit both to check the "
                    "most recently requested scenario for this user."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id": {"type": "string", "description": "e.g. scn-1234567890-abcdef. Omit to look up by label or use the most recent."},
                        "label":       {"type": "string", "description": "Full or partial scenario name, e.g. '40% discount'. Omit if scenario_id is given."},
                    },
                }},
            }
        },
        {
            "toolSpec": {
                "name": "approve_scenario",
                "description": (
                    "Approve a completed scenario, making it the live forecast that powers Overview "
                    "& Forecasts for every user. THIS IS A REAL, VISIBLE CHANGE. Call this tool "
                    "WITHOUT confirm (or confirm=false) to preview what it would approve — it will "
                    "NOT approve anything on that call, just return what it found (WAPE, volume "
                    "error) plus a needs_confirmation flag. Tell the user what you found and ask "
                    "them to confirm, THEN STOP — end your turn there and wait. Only call this tool "
                    "again with confirm=true in a LATER message, after the user's own next message "
                    "explicitly confirms. Calling it again with confirm=true in THIS SAME turn, "
                    "right after the preview and without a real reply from the user in between, is "
                    "refused by the backend and wastes a turn — there is no way to skip the wait, "
                    "so don't attempt it. Look the scenario up by scenario_id, by label (partial "
                    "match, e.g. 'the 40% discount scenario'), or omit both for 'approve the latest "
                    "run' (the user's most recently requested scenario)."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id": {"type": "string", "description": "e.g. scn-1234567890-abcdef. Omit to look up by label or use the most recent."},
                        "label":       {"type": "string", "description": "Full or partial scenario name. Omit if scenario_id is given."},
                        "confirm":     {"type": "boolean", "description": "Only true on the SECOND call, after the user has explicitly confirmed. Default false."},
                    },
                }},
            }
        },
        {
            "toolSpec": {
                "name": "check_scenario_validations",
                "description": (
                    "Run the same basic data-quality checklist as the scenario detail modal's 'Run "
                    "validations' button — negative units, non-finite values, weekly date "
                    "continuity, SKU/aggregate reconciliation, per-SKU WAPE outliers, SKUs that "
                    "collapse to a zero forward forecast, abrupt forward-forecast swings, and "
                    "overall volume-error sanity. Use for any 'any data quality issues with this "
                    "scenario' / 'does this run look OK' style question. Look it up by scenario_id, "
                    "by label, or omit both for the most recently requested scenario."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id": {"type": "string", "description": "e.g. scn-1234567890-abcdef. Omit to look up by label or use the most recent."},
                        "label":       {"type": "string", "description": "Full or partial scenario name. Omit if scenario_id is given."},
                    },
                }},
            }
        },
        {
            "toolSpec": {
                "name": "compare_scenarios",
                "description": (
                    "Compare two completed scenarios side by side — config, overall WAPE, backtest "
                    "actual/forecast units and volume error, and (when either has a forward-only "
                    "horizon beyond its backtest) forward-forecast totals and the percent delta "
                    "between them. Identify EACH scenario by its own scenario_id or label — this "
                    "tool needs two specific scenarios and has no 'most recent' fallback for either."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id_a": {"type": "string", "description": "First scenario's id."},
                        "label_a":       {"type": "string", "description": "First scenario's name (partial match), if scenario_id_a isn't known."},
                        "scenario_id_b": {"type": "string", "description": "Second scenario's id."},
                        "label_b":       {"type": "string", "description": "Second scenario's name (partial match), if scenario_id_b isn't known."},
                    },
                }},
            }
        },
        {
            "toolSpec": {
                "name": "explain_forecast_day",
                "description": (
                    "Explain why the forecast is high/low on a SINGLE SPECIFIC date — real "
                    "day-level context (Japanese public holiday, historical weather if the date is "
                    "in the past, weekday/weekend), the real actual/forecast totals for the week "
                    "that day falls in, and — only for forward-forecast dates on a scenario run "
                    "that captured it — the model's actual top contributing features for that "
                    "exact day. Use this for any 'why is/was the forecast high/low on [one date]' "
                    "question. If the user gave a RANGE (two dates — 'from X to Y', 'between X and "
                    "Y', even a short 2-3 day span) rather than one date, use get_forecast_range "
                    "instead — do not call this tool with just the range's start date, which "
                    "silently answers a narrower question than what was actually asked."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string", "description": "ISO date, e.g. 2026-03-05 — a SINGLE date only. If the user gave a range (two dates), use get_forecast_range instead."},
                        "sku":  {"type": "string", "description": "e.g. SKU-003. Omit for the all-SKU catalog total."},
                    },
                    "required": ["date"],
                }},
            }
        },
        {
            "toolSpec": {
                "name": "get_zip_forecast",
                "description": (
                    "Look up the real forecast/actuals for one SKU within one specific postal "
                    "code (ZIP) — the SKU-level numbers already provided in the data are summed "
                    "ACROSS ALL postal codes for that SKU, so they are NOT the right answer "
                    "whenever the user asks about a specific zip/postal code within a SKU. "
                    "Always call this tool for that case instead of reusing the SKU total. Omit "
                    "zip to get the ranked list of postal codes that SKU actually sells in (by "
                    "backtest volume) — use this to answer 'which zips does this SKU sell in', "
                    "or when the user asked about a zip but hasn't said which one yet. Add date "
                    "ONLY for a question about ONE SINGLE isolated date — without it, the figures "
                    "returned are totals summed across the whole backtest or whole forward "
                    "horizon. If the user gave TWO dates (any 'from X to Y' / 'between X and Y' "
                    "phrasing, even a short span like just 2-3 days), that is a RANGE, not a "
                    "single date — use get_forecast_range instead (with the same sku/zip), and do "
                    "NOT call this tool with just the range's start date and silently drop the end "
                    "date, which answers a different, narrower question than what was actually asked."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "sku":  {"type": "string", "description": "e.g. SKU-003."},
                        "zip":  {"type": "string", "description": "Postal code, e.g. 160-0022. Omit to list the SKU's available zips instead."},
                        "date": {"type": "string", "description": "ISO date, e.g. 2026-03-23 — a SINGLE date only. If the user gave a range (two dates), use get_forecast_range instead, not this field with just one end of it."},
                    },
                    "required": ["sku"],
                }},
            }
        },
        {
            "toolSpec": {
                "name": "compare_skus",
                "description": (
                    "Compare two SKUs side by side on the current live forecast — backtest volume, "
                    "WAPE, accuracy, forward forecast total, trend, and confidence tier for each. "
                    "Use for any 'compare SKU-X and SKU-Y' style question."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "sku_a": {"type": "string", "description": "e.g. SKU-003."},
                        "sku_b": {"type": "string", "description": "e.g. SKU-005."},
                    },
                    "required": ["sku_a", "sku_b"],
                }},
            }
        },
        {
            "toolSpec": {
                "name": "get_forecast_range",
                "description": (
                    "Sum real actual/forecast units over a date range (e.g. 'how does next month "
                    "look for SKU-003', 'forecast for all SKUs from March 1 to March 31', or even "
                    "a short 2-3 day span like 'from 2026-03-23 to 2026-03-25'). Use this whenever "
                    "the user gives TWO dates, no matter how close together — never call "
                    "explain_forecast_day/get_zip_forecast with just the range's start date and "
                    "silently ignore the end date, that answers a narrower question than what was "
                    "actually asked. Rounds the range to whichever weeks it overlaps (this data is "
                    "weekly-grain, not daily) — the tool returns exactly which weeks it summed, "
                    "plus how many of those were backtest vs. forward-only; if a short range lands "
                    "entirely within one week, say so explicitly rather than silently answering as "
                    "if only one date had been asked about. Omit sku for the all-SKU catalog total; "
                    "add zip (only together with sku) to scope to one postal code. For a single "
                    "isolated date (not a range), use explain_forecast_day or get_zip_forecast "
                    "instead — they give richer single-week context (holiday/weather/attribution)."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "start_date": {"type": "string", "description": "ISO date, e.g. 2026-03-01."},
                        "end_date":   {"type": "string", "description": "ISO date, e.g. 2026-03-31."},
                        "sku":        {"type": "string", "description": "e.g. SKU-003. Omit for the all-SKU catalog total."},
                        "zip":        {"type": "string", "description": "Postal code — only valid together with sku."},
                    },
                    "required": ["start_date", "end_date"],
                }},
            }
        },
        {
            "toolSpec": {
                "name": "point_to_ui",
                "description": (
                    "Visually points to a section of the dashboard by highlighting its sidebar nav "
                    "item, in addition to your normal text reply. Call this whenever your answer "
                    "tells the user where to go or what to click — e.g. running a forecast "
                    "(Scenarios), checking accuracy or trends (Forecasts or AI Insights), reviewing "
                    "SKUs (Overview), changing preferences (Settings), or the setup wizard "
                    "(Getting Started)."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "target": {"type": "string", "enum": [
                            "Overview", "Forecasts", "Scenarios", "AI Insights",
                            "Settings", "Getting Started",
                        ]},
                    },
                    "required": ["target"],
                }},
            }
        },
        {
            "toolSpec": {
                "name": "generate_report",
                "description": (
                    "Open the downloadable forecast report (the same print-ready report Settings → "
                    "Downloadable Report generates — chart, SKU tables, AI Insights, backtest "
                    "reference), using whatever sections/row-count the user already has configured "
                    "in Settings. The actual generation happens client-side, asynchronously, after "
                    "this call returns — it opens in a new tab normally, but the browser may block "
                    "that as a pop-up (triggering from chat isn't a direct click), in which case it "
                    "downloads a file instead; there's no way to know from here which one actually "
                    "happened, so don't assert either specifically — say it's ready as a new tab or "
                    "a download. Call this whenever the user asks to see, generate, download, "
                    "export, or get a copy of the report — do not just tell them to go to Settings "
                    "when they can be handed it directly. No inputs — it can't customize which "
                    "sections are included from chat; point them to Settings → Downloadable Report "
                    "for that."
                ),
                "inputSchema": {"json": {"type": "object", "properties": {}}},
            }
        },
    ]
}

NAV_TARGETS = {"Overview", "Forecasts", "Scenarios", "AI Insights", "Settings", "Getting Started"}


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


def _invoke_scenarios_api(method, path, claims, body=None):
    fake_event = {
        'requestContext': {'http': {'method': method, 'path': path},
                            'authorizer': {'jwt': {'claims': claims}}},
        'body': json.dumps(body) if body is not None else None,
    }
    resp = lam.invoke(FunctionName=SCENARIOS_API_FUNCTION, InvocationType='RequestResponse',
                       Payload=json.dumps(fake_event).encode('utf-8'))
    payload = json.loads(resp['Payload'].read())
    status = payload.get('statusCode', 500)
    try:
        result_body = json.loads(payload.get('body') or '{}')
    except json.JSONDecodeError:
        result_body = {'error': 'bad response from scenarios-api'}
    return status, result_body


def _match_scenario(inputs, scenarios, claims, allow_default=True):
    """Resolve {scenario_id, label} inputs against a scenario list — the
    lookup check_scenario_status has always used, factored out now that
    approve_scenario and check_scenario_validations need the identical
    logic. Returns (match, None) on success, or (None, result) where
    result is what the tool should return as-is (an error, or a
    multiple_matches disambiguation for the model to relay to the user).
    allow_default=False for compare_scenarios, which needs two SPECIFIC
    scenarios — silently falling back to "most recent" for a missing one
    would compare the wrong thing without ever surfacing that as an error.
    """
    sid = (inputs.get('scenario_id') or '').strip()
    label_query = (inputs.get('label') or '').strip().lower()

    if sid:
        match = next((s for s in scenarios if s['id'] == sid), None)
        if not match:
            return None, {'error': f'no scenario found with id {sid}'}
        return match, None

    if label_query:
        matches = [s for s in scenarios if label_query in (s.get('label') or '').lower()]
        if not matches:
            return None, {'error': f'no scenario found with a label matching "{inputs.get("label")}"'}
        if len(matches) > 1:
            return None, {'multiple_matches': [{'id': m['id'], 'label': m['label']} for m in matches[:10]],
                    'message': 'More than one scenario matches that label — ask the user which '
                               'one they mean, or call this again with the exact scenario_id.'}
        return matches[0], None

    if allow_default:
        email = claims.get('email')
        mine = [s for s in scenarios if s.get('requested_by') == email]
        if not mine:
            return None, {'message': 'No scenarios found for this user yet.'}
        return mine[0], None  # list_scenarios already sorts newest-first

    return None, {'error': 'specify a scenario_id or label for this scenario'}


def _run_data_validations(meta, result):
    """Python port of scenarios.js's runDataValidations — the exact same 8
    checks, thresholds, and wording, so a chat answer always matches what
    clicking "Run validations" in the scenario detail modal would show."""
    checks = []

    def add(check_name, status, detail):
        checks.append({'name': check_name, 'status': status, 'detail': detail})

    weeks = result.get('weeks') or []
    all_ = result.get('all') or {'a': [], 'f': []}
    skus = result.get('skus') or {}
    bt = result.get('backtestWeeks', len(weeks))
    sku_ids = list(skus.keys())

    # 1. Negative units — shipped-unit forecasts/actuals should never be negative.
    neg_count, neg_skus = 0, set()
    for sid in sku_ids:
        o = skus[sid]
        for v in list(o.get('f') or []) + list(o.get('a') or []):
            if v is not None and v < 0:
                neg_count += 1
                neg_skus.add(sid)
    add('No negative unit values', 'fail' if neg_count else 'pass',
        f'{neg_count} negative value(s) across {len(neg_skus)} SKU(s).' if neg_count
        else 'All actual and forecast values are ≥ 0.')

    # 2. Non-finite values (NaN / Infinity) — would silently break charts/KPIs downstream.
    bad_count = 0
    for sid in sku_ids:
        o = skus[sid]
        for v in list(o.get('f') or []) + list(o.get('a') or []):
            if isinstance(v, (int, float)) and not math.isfinite(v):
                bad_count += 1
    add('No NaN / infinite values', 'fail' if bad_count else 'pass',
        f'{bad_count} non-finite value(s) found in the result data.' if bad_count
        else 'All actual and forecast values are finite numbers.')

    # 3. Weekly date continuity — every week should be exactly 7 days after the last.
    gap_issues = 0
    for i in range(1, len(weeks)):
        try:
            d0, d1 = dt.date.fromisoformat(weeks[i - 1]), dt.date.fromisoformat(weeks[i])
            if (d1 - d0).days != 7:
                gap_issues += 1
        except ValueError:
            gap_issues += 1
    add('Weekly date continuity', 'warn' if gap_issues else 'pass',
        f'{gap_issues} week-to-week gap(s) are not exactly 7 days apart.' if gap_issues
        else f'All {len(weeks)} weeks are evenly spaced 7 days apart.')

    # 4. Per-SKU actuals should sum to the aggregate — catches a SKU dropped
    # (or double-counted) between the per-SKU and all-SKU series.
    sum_sku_a = sum(v for sid in sku_ids for v in (skus[sid].get('a') or [])[:bt] if v is not None)
    sum_all_a = sum(v for v in (all_.get('a') or [])[:bt] if v is not None)
    diff_pct = (abs(sum_sku_a - sum_all_a) / sum_all_a * 100) if sum_all_a else 0
    add('SKU totals reconcile with the all-SKU aggregate', 'warn' if diff_pct > 1 else 'pass',
        f'Per-SKU actuals sum to {round(sum_sku_a):,} vs. aggregate {round(sum_all_a):,} '
        f'({diff_pct:.2f}% difference).')

    # 5. Per-SKU WAPE outliers — SKUs scoring far worse than the overall number.
    overall = result.get('overallWape') or 0
    outliers = []
    for sid in sku_ids:
        o = skus[sid]
        a, f = o.get('a') or [], o.get('f') or []
        vol = num = 0
        for i, x in enumerate(a):
            if x is None:
                continue
            vol += x
            fv = f[i] if i < len(f) and f[i] is not None else 0
            num += abs(x - fv)
        if not vol:
            continue
        wape = 100 * num / vol
        if wape > max(75, overall * 2):
            outliers.append(f'{sid} ({wape:.0f}%)')
    add('No extreme per-SKU WAPE outliers', 'warn' if outliers else 'pass',
        (f'{len(outliers)} SKU(s) scoring far above the {overall:.1f}% overall WAPE: ' +
         ', '.join(outliers[:6]) + ('…' if len(outliers) > 6 else '')) if outliers
        else f"No SKU's WAPE is far above the {overall:.1f}% overall.")

    # 6. SKUs with real history that collapse to a zero forward forecast.
    zero_fwd = []
    for sid in sku_ids:
        o = skus[sid]
        a, f = o.get('a') or [], o.get('f') or []
        hist_vol = sum(v for v in a[:bt] if v is not None)
        fwd = f[bt:]
        fwd_sum = sum(v for v in fwd if v is not None)
        if hist_vol > 0 and fwd and fwd_sum == 0:
            zero_fwd.append(sid)
    add('No SKU collapses to a zero forward forecast', 'warn' if zero_fwd else 'pass',
        (f'{len(zero_fwd)} SKU(s) had real volume but forecast 0 units for the entire forward '
         f'horizon: ' + ', '.join(zero_fwd[:6]) + ('…' if len(zero_fwd) > 6 else '')) if zero_fwd
        else 'Every SKU with historical volume has a non-zero forward forecast.')

    # 7. Abrupt week-over-week swings in the aggregate forward forecast.
    fwd_all = (all_.get('f') or [])[bt:]
    spikes = 0
    for j in range(1, len(fwd_all)):
        p, c = fwd_all[j - 1], fwd_all[j]
        if p and p > 0 and c is not None and (c / p > 3 or c / p < 0.33):
            spikes += 1
    add('No abrupt week-over-week jumps in the forward forecast', 'warn' if spikes else 'pass',
        f'{spikes} week-to-week swing(s) of 3x or more in the aggregate forward forecast.' if spikes
        else 'The aggregate forward forecast moves smoothly week to week.')

    # 8. Overall volume error within a sane range.
    ve = meta.get('volume_error')
    add('Overall volume error within a sane range', 'warn' if (ve is not None and abs(ve) > 20) else 'pass',
        f"Volume error is {'+' if ve is not None and ve > 0 else ''}{ve:.2f}%." if ve is not None
        else 'No volume error recorded for this scenario.')

    return checks


def execute_tool(name, inputs, claims, request_state):
    if name == 'run_scenario':
        body = {
            'label':        inputs.get('label') or 'Started by Lyra',
            'known_prices': inputs.get('known_prices', True),
            'weather':      inputs.get('weather', True),
            'calibrate':    inputs.get('calibrate', True),
            'refresh_days': inputs.get('refresh_days', 28),
        }
        status, result = _invoke_scenarios_api('POST', '/scenarios', claims, body)
        if status != 202:
            return {'error': result.get('error', 'failed to start the scenario run')}
        return {'started': True, 'scenario_id': result['scenario_id'], 'config': body}

    if name == 'check_scenario_status':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        match, err = _match_scenario(inputs, scenarios, claims)
        if err is not None:
            return err

        out = dict(match)
        if match.get('status') == 'completed':
            rstatus, rresult = _invoke_scenarios_api('GET', f"/scenarios/{match['id']}/result", claims)
            if rstatus == 200:
                # Same "top SKUs by volume" ranking the dashboard's own compare
                # view uses (sum of actual units, descending) — top 8.
                ranked = []
                for sku_id, o in (rresult.get('skus') or {}).items():
                    vol = sum(x for x in (o.get('a') or []) if x is not None)
                    ranked.append({'sku': sku_id, 'volume': round(vol)})
                ranked.sort(key=lambda r: r['volume'], reverse=True)
                out['top_skus_by_volume'] = ranked[:8]
        return out

    if name == 'approve_scenario':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        match, err = _match_scenario(inputs, scenarios, claims)
        if err is not None:
            return err

        if match.get('status') != 'completed':
            return {'error': f'"{match.get("label") or match["id"]}" isn\'t ready to approve — '
                              f'its status is {match.get("status")}.'}
        if match.get('approved'):
            return {'already_approved': True, 'scenario_id': match['id'], 'label': match.get('label'),
                    'message': f'"{match.get("label") or match["id"]}" is already the approved/live '
                               f'scenario — nothing to do.'}

        # Two-call confirm gate: this changes what's live for every user. The
        # FIRST call (confirm omitted/false) only ever previews — it never
        # approves — and records this scenario as "previewed this request"
        # below. Only a confirm=true call from a request where NO preview
        # happened in THIS invocation is honored — this is the part that
        # actually matters: Nova's own bounded tool-use loop can (and, once
        # in testing, did) chain a preview and an immediate confirm=true
        # call within the SAME request, with no real human reply in
        # between, silently defeating a gate that only lived in the prompt.
        # request_state is fresh per HTTP request/handler() invocation, so
        # this rejects that same-request chain outright — confirm=true can
        # only succeed on a genuinely later request, which only happens
        # once the user has actually typed something new.
        previewed = request_state.setdefault('approve_previewed_ids', set())
        if not inputs.get('confirm'):
            previewed.add(match['id'])
            return {
                'needs_confirmation': True,
                'scenario_id': match['id'],
                'label': match.get('label'),
                'wape': match.get('wape'),
                'volume_error': match.get('volume_error'),
                'message': (
                    f'Found "{match.get("label") or match["id"]}" (WAPE '
                    f'{match.get("wape")}%, volume error {match.get("volume_error")}%). Approving '
                    f'it replaces the live forecast that currently powers Overview & Forecasts for '
                    f'every user. Tell the user what you found and ask them to explicitly confirm '
                    f'— only call this again with confirm=true and this same scenario_id after '
                    f'they say yes IN THEIR NEXT MESSAGE. Do not approve without that.'
                ),
            }

        if match['id'] in previewed:
            return {'error': 'Refused: confirm=true arrived in the same request as the preview — '
                              'no real user reply happened in between. A genuine confirmation from '
                              'the user is required first: ask them, then wait for their next '
                              'message before calling this tool again with confirm=true.'}

        astatus, aresult = _invoke_scenarios_api('POST', f"/scenarios/{match['id']}/approve", claims)
        if astatus != 200:
            return {'error': aresult.get('error', 'failed to approve the scenario')}
        return {'approved': True, 'scenario_id': match['id'], 'label': match.get('label')}

    if name == 'check_scenario_validations':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        match, err = _match_scenario(inputs, scenarios, claims)
        if err is not None:
            return err
        if match.get('status') != 'completed':
            return {'error': f'"{match.get("label") or match["id"]}" has no result to validate yet '
                              f'— its status is {match.get("status")}.'}

        rstatus, rresult = _invoke_scenarios_api('GET', f"/scenarios/{match['id']}/result", claims)
        if rstatus != 200:
            return {'error': rresult.get('error', "failed to load this scenario's result")}

        checks = _run_data_validations(match, rresult)
        counts = {'pass': 0, 'warn': 0, 'fail': 0}
        for c in checks:
            counts[c['status']] += 1
        return {'scenario_id': match['id'], 'label': match.get('label'),
                'summary': {'passed': counts['pass'], 'warnings': counts['warn'], 'failed': counts['fail']},
                'checks': checks}

    if name == 'compare_scenarios':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        # allow_default=False on both — comparing needs two SPECIFIC
        # scenarios; silently defaulting a missing one to "most recent"
        # would silently compare the wrong thing instead of surfacing an error.
        match_a, err_a = _match_scenario(
            {'scenario_id': inputs.get('scenario_id_a'), 'label': inputs.get('label_a')},
            scenarios, claims, allow_default=False)
        if err_a is not None:
            return {'first_scenario': err_a}
        match_b, err_b = _match_scenario(
            {'scenario_id': inputs.get('scenario_id_b'), 'label': inputs.get('label_b')},
            scenarios, claims, allow_default=False)
        if err_b is not None:
            return {'second_scenario': err_b}
        if match_a['id'] == match_b['id']:
            return {'error': 'those are the same scenario — pick two different ones to compare'}
        for m in (match_a, match_b):
            if m.get('status') != 'completed':
                return {'error': f'"{m.get("label") or m["id"]}" has no result yet — its status is '
                                  f'{m.get("status")}.'}

        ra_status, ra = _invoke_scenarios_api('GET', f"/scenarios/{match_a['id']}/result", claims)
        rb_status, rb = _invoke_scenarios_api('GET', f"/scenarios/{match_b['id']}/result", claims)
        if ra_status != 200 or rb_status != 200:
            return {'error': 'failed to load one or both scenario results'}

        # Same totals the dashboard's own Compare modal shows: backtest-period
        # actual/forecast/volume-error, plus (when present) the forward-only
        # horizon total — the genuinely forward-looking number, since two
        # scenarios sharing the same historical data have identical
        # backtest-period WAPE/volume-error and can't show a Future Price /
        # discount scenario's actual impact any other way.
        def totals(r):
            bw = r.get('backtestWeeks', len(r['weeks']))
            a = sum(x for x in r['all']['a'][:bw] if x is not None)
            f = sum(x for x in r['all']['f'][:bw] if x is not None)
            err = (100 * (f - a) / a) if a else 0
            fwd_slice = r['all']['f'][bw:]
            fwd = sum(x for x in fwd_slice if x is not None) if fwd_slice else None
            return {'actual_units': round(a), 'forecast_units': round(f), 'volume_error_pct': round(err, 2),
                    'forward_forecast_units': round(fwd) if fwd is not None else None,
                    'forward_weeks': len(fwd_slice)}

        ta, tb = totals(ra), totals(rb)
        fwd_delta = None
        if ta['forward_weeks'] and tb['forward_weeks'] and ta['forward_forecast_units']:
            fwd_delta = round(100 * (tb['forward_forecast_units'] - ta['forward_forecast_units'])
                               / ta['forward_forecast_units'], 2)

        wape_a, wape_b = ra['overallWape'], rb['overallWape']
        return {
            'a': {'scenario_id': match_a['id'], 'label': match_a.get('label'), 'config': _config_summary(match_a),
                  'overall_wape': wape_a, 'weeks': len(ra['weeks']), 'skus': len(ra['skus']), **ta},
            'b': {'scenario_id': match_b['id'], 'label': match_b.get('label'), 'config': _config_summary(match_b),
                  'overall_wape': wape_b, 'weeks': len(rb['weeks']), 'skus': len(rb['skus']), **tb},
            'lower_wape': (match_a.get('label') if wape_a < wape_b
                            else match_b.get('label') if wape_b < wape_a else None),
            'forward_horizon_delta_pct': fwd_delta,
        }

    if name == 'explain_forecast_day':
        date_str = (inputs.get('date') or '').strip()
        try:
            day = dt.date.fromisoformat(date_str)
        except ValueError:
            return {'error': f'"{date_str}" is not a valid ISO date (YYYY-MM-DD).'}

        data = _get_forecast_data()
        week_start = (day - dt.timedelta(days=day.weekday())).isoformat()
        try:
            idx = data['weeks'].index(week_start)
        except ValueError:
            return {'error': f'{date_str} falls outside the range of this forecast '
                              f'({data["weeks"][0]} to {data["weeks"][-1]}).'}

        sku = (inputs.get('sku') or '').strip()
        if sku:
            sku_data = data['skus'].get(sku)
            if not sku_data:
                return {'error': f'no SKU found matching "{sku}"'}
            actual, forecast = sku_data['a'][idx], sku_data['f'][idx]
            series_label = sku
        else:
            actual, forecast = data['all']['a'][idx], data['all']['f'][idx]
            series_label = 'all SKUs'

        bt = data.get('backtestWeeks', len(data['weeks']))
        is_forward = idx >= bt

        out = {
            'date': date_str,
            'series': series_label,
            'week_of': week_start,
            'week_actual_units': actual,  # None if this week has no actuals yet (forward-only)
            'week_forecast_units': round(forecast, 1) if forecast is not None else None,
            'is_forward_forecast_week': is_forward,
            'day_of_week': day.strftime('%A'),
            'is_weekend': day.weekday() >= 5,
            'holiday': _day_holiday(date_str),
        }
        weather = _day_weather(date_str)
        if weather:
            out['weather'] = weather
        elif is_forward:
            out['weather_note'] = 'not available — this is a future date, weather is only known historically'

        if is_forward:
            scenario_id = data.get('id')
            if not sku:
                out['quantitative_factors'] = (
                    "not available at the 'all SKUs' level — ask about a specific SKU "
                    "(e.g. SKU-003) to get real per-feature model attribution for that day"
                )
            elif not scenario_id:
                out['quantitative_factors'] = (
                    "not available for this forecast — it was approved before day-level model "
                    "attribution was added, so no per-day explain data was captured for it"
                )
            else:
                try:
                    obj = s3.get_object(Bucket=BUCKET, Key=f'scenarios/{scenario_id}/explain/{sku}.json')
                    explain_days = json.loads(obj['Body'].read().decode('utf-8'))
                except Exception:
                    explain_days = {}
                day_features = explain_days.get(date_str)
                if day_features:
                    out['top_contributing_features'] = [
                        {
                            'factor': _translate_feature(f['feature']),
                            'units': f['units'],
                            'pct_of_forecast': f['pct_of_forecast'],
                        }
                        for f in day_features
                    ]
                elif not explain_days:
                    # No explain/{sku}.json at all — aprabot-explain-runner hasn't
                    # finished yet (it's async, fired right after this scenario's
                    # main run completed) or failed for this scenario.
                    out['quantitative_factors'] = (
                        'not available yet for this scenario — day-level model attribution '
                        'is computed as a background step after the forecast itself finishes, '
                        'and may take a few more minutes, or may have failed for this run'
                    )
                else:
                    # explain_days IS populated — date_str just falls outside its
                    # covered range. Quantitative attribution is deliberately capped
                    # to a near-term window (not the full forecast horizon) to keep
                    # computation practical at full catalog scale — say so plainly
                    # with the real covered range, instead of a vague "unavailable".
                    covered = sorted(explain_days.keys())
                    out['quantitative_factors'] = (
                        f'not available for {date_str} — real per-feature attribution for this '
                        f'scenario only covers {covered[0]} through {covered[-1]} (the near-term '
                        f'part of the forecast); {date_str} falls outside that window'
                    )
        return out

    if name == 'get_zip_forecast':
        sku = (inputs.get('sku') or '').strip()
        zip_code = (inputs.get('zip') or '').strip()
        if not sku:
            return {'error': 'a sku is required, e.g. SKU-003'}

        data = _get_forecast_data()
        sku_data = data['skus'].get(sku)
        if not sku_data:
            return {'error': f'no SKU found matching "{sku}"'}

        by_zip = sku_data.get('byZip') or {}
        if not by_zip:
            return {'error': f'{sku} has no postal-code breakdown in this forecast — only a '
                              f'SKU-level total (summed across all postal codes) is available'}

        bt = data.get('backtestWeeks', len(data['weeks']))
        total_weeks = len(data['weeks'])
        fwd_weeks = total_weeks - bt
        trail_win = min(fwd_weeks, bt) if fwd_weeks else 0

        # Same math as the dashboard's own SKU→postal-code table (js/main.js
        # renderSkuZipTable / seriesWape) — backtest-only WAPE, and a trend
        # comparing the forward forecast to an equally-sized trailing-actual
        # window — so Lyra's numbers always match what's on screen.
        def zip_summary(zd):
            a, f = zd['a'], zd['f']
            vol = sum(x for x in a[:bt] if x is not None)
            num = sum(abs(x - y) for x, y in zip(a[:bt], f[:bt]) if x is not None)
            wape = round(100 * num / vol, 1) if vol else None
            fwd = sum(x for x in f[bt:] if x is not None) if fwd_weeks else None
            trail_actual = sum(x for x in a[max(0, bt - trail_win):bt] if x is not None) if trail_win else 0
            trend = (round(100 * (fwd - trail_actual) / trail_actual, 1)
                      if (trail_win and trail_actual and fwd is not None) else None)
            return vol, wape, fwd, trend

        if not zip_code:
            ranked = []
            for z, zd in by_zip.items():
                vol, wape, _fwd, _trend = zip_summary(zd)
                ranked.append({'zip': z, 'backtest_actual_units': round(vol), 'wape': wape})
            ranked.sort(key=lambda r: -r['backtest_actual_units'])
            return {'sku': sku, 'zip': None, 'available_zips': ranked[:15],
                    'message': 'No zip specified — call again with one of these zip codes for its '
                               'specific forecast, or offer this list to the user.'}

        zd = by_zip.get(zip_code)
        if not zd:
            ranked = sorted(by_zip.keys(),
                             key=lambda z: -sum(x for x in by_zip[z]['a'][:bt] if x is not None))
            return {'error': f'no postal code "{zip_code}" found for {sku}',
                    'available_zips': ranked[:15]}

        # A date narrows this to one specific week instead of the full-horizon
        # totals below — same week-lookup logic and field names as
        # explain_forecast_day (week_actual_units/week_forecast_units mean
        # the WHOLE WEEK, there's no true daily number in this data), just
        # scoped to this one sku+zip series instead of the SKU/all-SKU total.
        date_str = (inputs.get('date') or '').strip()
        if date_str:
            try:
                day = dt.date.fromisoformat(date_str)
            except ValueError:
                return {'error': f'"{date_str}" is not a valid ISO date (YYYY-MM-DD).'}
            week_start = (day - dt.timedelta(days=day.weekday())).isoformat()
            try:
                idx = data['weeks'].index(week_start)
            except ValueError:
                return {'error': f'{date_str} falls outside the range of this forecast '
                                  f'({data["weeks"][0]} to {data["weeks"][-1]}).'}
            actual, forecast = zd['a'][idx], zd['f'][idx]
            return {
                'sku': sku, 'zip': zip_code, 'date': date_str,
                'week_of': week_start,
                'week_actual_units': actual,
                'week_forecast_units': round(forecast, 1) if forecast is not None else None,
                'is_forward_forecast_week': idx >= bt,
            }

        vol, wape, fwd, trend = zip_summary(zd)
        out = {'sku': sku, 'zip': zip_code, 'backtest_actual_units': round(vol), 'wape': wape}
        if fwd_weeks:
            out['forward_forecast_units'] = round(fwd) if fwd is not None else None
            out['forward_weeks'] = fwd_weeks
            out['trend_vs_trailing_actual'] = trend
        return out

    if name == 'compare_skus':
        sku_a = (inputs.get('sku_a') or '').strip()
        sku_b = (inputs.get('sku_b') or '').strip()
        if not sku_a or not sku_b:
            return {'error': 'both sku_a and sku_b are required'}
        if sku_a == sku_b:
            return {'error': 'those are the same SKU — pick two different ones to compare'}

        by_id = {r['sku']: r for r in _all_sku_rows()}
        row_a, row_b = by_id.get(sku_a), by_id.get(sku_b)
        if not row_a:
            return {'error': f'no SKU found matching "{sku_a}"'}
        if not row_b:
            return {'error': f'no SKU found matching "{sku_b}"'}

        return {
            'a': row_a, 'b': row_b,
            'higher_volume': row_a['sku'] if row_a['vol'] >= row_b['vol'] else row_b['sku'],
            'lower_wape': row_a['sku'] if row_a['wape'] <= row_b['wape'] else row_b['sku'],
        }

    if name == 'get_forecast_range':
        start_str = (inputs.get('start_date') or '').strip()
        end_str = (inputs.get('end_date') or '').strip()
        try:
            start_d = dt.date.fromisoformat(start_str)
            end_d = dt.date.fromisoformat(end_str)
        except ValueError:
            return {'error': 'start_date/end_date must be valid ISO dates (YYYY-MM-DD).'}
        if end_d < start_d:
            return {'error': 'end_date is before start_date.'}

        data = _get_forecast_data()
        sku = (inputs.get('sku') or '').strip()
        zip_code = (inputs.get('zip') or '').strip()
        if zip_code and not sku:
            return {'error': 'zip requires sku — a postal-code breakdown only exists within a specific SKU'}

        if sku:
            sku_data = data['skus'].get(sku)
            if not sku_data:
                return {'error': f'no SKU found matching "{sku}"'}
            if zip_code:
                zd = (sku_data.get('byZip') or {}).get(zip_code)
                if not zd:
                    ranked = sorted((sku_data.get('byZip') or {}).keys())
                    return {'error': f'no postal code "{zip_code}" found for {sku}',
                            'available_zips': ranked[:15]}
                series_a, series_f, series_label = zd['a'], zd['f'], f'{sku} · {zip_code}'
            else:
                series_a, series_f, series_label = sku_data['a'], sku_data['f'], sku
        else:
            series_a, series_f, series_label = data['all']['a'], data['all']['f'], 'all SKUs'

        bt = data.get('backtestWeeks', len(data['weeks']))
        matched_idx = []
        for i, w in enumerate(data['weeks']):
            week_start = dt.date.fromisoformat(w)
            week_end = week_start + dt.timedelta(days=6)
            # a week counts if it overlaps the requested range at all, even partially
            if week_end < start_d or week_start > end_d:
                continue
            matched_idx.append(i)

        if not matched_idx:
            return {'error': f'{start_str} to {end_str} falls outside the range of this forecast '
                              f'({data["weeks"][0]} to {data["weeks"][-1]}).'}

        actual_sum, has_actual, forecast_sum = 0, False, 0.0
        for i in matched_idx:
            a_val, f_val = series_a[i], series_f[i]
            if a_val is not None:
                actual_sum += a_val
                has_actual = True
            if f_val is not None:
                forecast_sum += f_val

        return {
            'series': series_label,
            'weeks_matched': [data['weeks'][i] for i in matched_idx],
            'week_count': len(matched_idx),
            'backtest_weeks_included': sum(1 for i in matched_idx if i < bt),
            'forward_weeks_included': sum(1 for i in matched_idx if i >= bt),
            'actual_units': round(actual_sum) if has_actual else None,
            'forecast_units': round(forecast_sum, 1),
        }

    if name == 'point_to_ui':
        return {'ok': True}  # actual UI effect happens client-side; this just satisfies the tool-result contract

    if name == 'generate_report':
        return {'ok': True}  # actual report generation happens client-side; see handler()'s generate_report flag

    return {'error': f'unknown tool {name}'}


_TOOL_NAMES = [t['toolSpec']['name'] for t in TOOL_CONFIG['tools']]
_TOOL_TAG_RE = re.compile(
    r'</?(?:' + '|'.join(re.escape(n) for n in _TOOL_NAMES) + r')\b[^>]*>', re.DOTALL)


def _text_of(message):
    for block in message.get('content', []):
        if 'text' in block:
            text = block['text']
            # Nova sometimes emits a <thinking>...</thinking> preamble inline
            # in the text block rather than as separate reasoning content,
            # occasionally wraps the actual reply in a stray <reply>...</reply>
            # tag, and occasionally narrates a tool call as fake inline markup
            # (e.g. <point_to_ui(target="X")>...</point_to_ui>) instead of a
            # real toolUse block — none of these are meant for the end user to
            # see literally, so strip them all. _TOOL_TAG_RE is built from
            # TOOL_CONFIG itself so a newly added tool is covered automatically
            # instead of silently missing here (get_zip_forecast was, once).
            text = re.sub(r'<thinking>.*?</thinking>\s*', '', text, flags=re.DOTALL)
            text = re.sub(r'</?reply>', '', text)
            text = _TOOL_TAG_RE.sub('', text)
            return text.strip()
    return ''


def handler(event, context):
    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'POST')
    path   = (event.get('requestContext') or {}).get('http', {}).get('path', '')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    if path == '/knowledge' and method == 'GET':
        return get_knowledge()
    if path == '/knowledge' and method == 'PUT':
        return put_knowledge(event)

    try:
        body    = json.loads(event.get('body') or '{}')
        message = (body.get('message') or '').strip()
        history = body.get('history') or []
        extra   = (body.get('extra_instructions') or '').strip()
        temperature = body.get('temperature')
        max_tokens  = body.get('max_tokens')

        if not message:
            return {'statusCode': 400, 'headers': CORS,
                    'body': json.dumps({'error': 'message required'})}

        if 'data' not in _cache:
            _cache['data'] = build_data_summary()

        system = SYSTEM_TMPL.format(knowledge=load_forecasting_knowledge(), data=_cache['data'])
        if extra:
            system += f"\n\nADDITIONAL INSTRUCTIONS: {extra}"

        messages = []
        for h in history[-8:]:
            role    = h.get('role')
            content = (h.get('content') or '').strip()
            if role in ('user', 'assistant') and content:
                messages.append({'role': role, 'content': [{'text': content}]})
        messages.append({'role': 'user', 'content': [{'text': message}]})

        # Clamp client-supplied generation params to sane bounds.
        temp = max(0.0, min(1.0, float(temperature))) if isinstance(temperature, (int, float)) else 0.3
        toks = max(64, min(1500, int(max_tokens))) if isinstance(max_tokens, (int, float)) else 512

        claims = _claims(event)
        inference_config = {'maxTokens': toks, 'temperature': temp}

        point_to = None
        trigger_report = False
        reply = ''
        seen_tool_calls = set()  # (name, sorted-inputs) already executed this request
        # Fresh per request — carries cross-tool-call state within this one
        # invocation (currently: which scenario ids approve_scenario has
        # already previewed here, so a confirm=true can't succeed without a
        # genuine new request in between). Never persisted or shared across
        # requests/users — that's the whole point of it.
        request_state = {}
        # Bounded loop rather than a single follow-up call: Nova sometimes
        # chains a second tool call (e.g. point_to_ui then run_scenario)
        # before it's ready to produce the final text, so one fixed
        # round-trip isn't always enough — and previously left `reply` empty
        # when that happened, even though the request had actually succeeded.
        # 6 iterations measured at ~1-2.5s each in practice — up to ~15s
        # worst case, comfortably under this Lambda's 30s timeout.
        for _ in range(6):
            resp = bedrock.converse(
                modelId=MODEL, system=[{'text': system}], messages=messages,
                inferenceConfig=inference_config, toolConfig=TOOL_CONFIG,
            )
            output_message = resp['output']['message']

            if resp.get('stopReason') != 'tool_use':
                reply = _text_of(output_message)
                break

            messages.append(output_message)
            tool_result_blocks = []
            repeated_call = False
            for block in output_message.get('content', []):
                if 'toolUse' in block:
                    tu = block['toolUse']
                    inputs = tu.get('input') or {}
                    if tu['name'] == 'point_to_ui':
                        target = inputs.get('target')
                        if target in NAV_TARGETS:
                            point_to = target
                    if tu['name'] == 'generate_report':
                        trigger_report = True
                    # Nova occasionally gets stuck re-issuing the exact same
                    # tool call indefinitely (observed: point_to_ui with an
                    # unchanged target, 8+ times in a row) — no fixed
                    # iteration budget reliably bounds a genuine loop, so
                    # detect the repeat directly instead.
                    call_sig = (tu['name'], json.dumps(inputs, sort_keys=True))
                    if call_sig in seen_tool_calls:
                        repeated_call = True
                    seen_tool_calls.add(call_sig)
                    result = execute_tool(tu['name'], inputs, claims, request_state)
                    tool_result_blocks.append({'toolResult': {
                        'toolUseId': tu['toolUseId'],
                        'content': [{'json': result}],
                    }})
            messages.append({'role': 'user', 'content': tool_result_blocks})

            if repeated_call:
                # Nudge toward a decisive final answer instead of looping
                # again. toolConfig must stay present here — the Converse
                # API requires it whenever prior turns contain toolUse/
                # toolResult blocks — so this can't force tools off
                # outright, only ask; if it still calls a tool, the loop's
                # normal exit (falling through to the fallback text below)
                # is the backstop.
                messages.append({'role': 'user', 'content': [
                    {'text': "You already have what you need from that tool. Answer now in "
                              "plain text — don't call any more tools."},
                ]})
                resp2 = bedrock.converse(
                    modelId=MODEL, system=[{'text': system}], messages=messages,
                    inferenceConfig=inference_config, toolConfig=TOOL_CONFIG,
                )
                if resp2.get('stopReason') != 'tool_use':
                    reply = _text_of(resp2['output']['message'])
                break

        if not reply:
            reply = ("I've generated your downloadable report — it should open in a new tab, or "
                      "download directly if your browser blocks the pop-up." if trigger_report
                      else "Done — I've highlighted it in the sidebar for you." if point_to
                      else "Done!")

        return {
            'statusCode': 200,
            'headers':    {**CORS, 'Content-Type': 'application/json'},
            'body':       json.dumps({'reply': reply, 'point_to': point_to, 'generate_report': trigger_report}),
        }

    except Exception as exc:
        msg = str(exc)
        print(f"CHAT_ERROR: {msg}")
        if 'Throttling' in msg or 'Too many' in msg:
            return {
                'statusCode': 429,
                'headers':    CORS,
                'body':       json.dumps({'reply': "I'm handling too many requests right now — please try again in a moment.", 'error': 'throttled'}),
            }
        return {
            'statusCode': 500,
            'headers':    CORS,
            'body':       json.dumps({'error': msg}),
        }
