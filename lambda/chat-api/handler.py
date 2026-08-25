import csv
import io
import json
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


def build_data_summary():
    obj  = s3.get_object(Bucket=BUCKET, Key=KEY)
    data = json.loads(obj['Body'].read().decode('utf-8'))

    # backtestWeeks marks where real actuals end and the forward-only
    # forecast begins; older cached results may not have the field.
    bt = data.get('backtestWeeks', len(data['weeks']))

    total_weeks = len(data['weeks'])
    fwd_weeks   = total_weeks - bt
    trail_win   = min(fwd_weeks, bt) if fwd_weeks else 0

    rows = []
    for sku, d in data['skus'].items():
        a, f = d['a'], d['f']
        vol = sum(x for x in a if x is not None)
        num = sum(abs(x - y) for x, y in zip(a, f) if x is not None)
        wape = round(100 * num / vol, 2) if vol else 0
        fwd = sum(x for x in f[bt:] if x is not None)
        # Trend: total forward forecast vs. an equally-sized trailing actual
        # window — same comparison the dashboard itself shows, so Lyra's
        # reasoning about a SKU's trajectory matches what the user sees.
        trail_actual = sum(x for x in a[max(0, bt - trail_win):bt] if x is not None) if trail_win else 0
        trend = round(100 * (fwd - trail_actual) / trail_actual, 1) if trail_win and trail_actual else None
        rows.append({'sku': sku, 'vol': vol, 'wape': wape, 'acc': round(100 - wape, 1), 'fwd': fwd, 'trend': trend})
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
• You can actually start a new forecast pipeline run using the run_scenario tool, and check on a
  run's progress with check_scenario_status. Only call run_scenario when the user explicitly asks
  you to run, start, or kick off a NEW forecast/scenario — never for an analytical or correlation
  question about the existing forecast (e.g. "do holidays cause spikes?", "why did this SKU drop?")
  even if answering it thoroughly is hard; answer directly from the data instead, or say what's
  missing. A run takes ~3-5 minutes — tell the user that, and mention they can ask you for a status
  update or check the Scenarios tab. Only the settings the user specifies should differ from the
  defaults (known_prices=true, weather=true, calibrate=true,
  refresh_days=28) — don't ask clarifying questions for settings they didn't mention, just use
  the defaults and say so in your reply.
• Whenever your answer tells the user where to go or what to click in the dashboard, also call the
  point_to_ui tool with the relevant nav item, in addition to writing your normal text reply — do
  not use it instead of a reply.
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
                    "Check the status/result of a scenario run. If scenario_id is omitted, "
                    "checks the most recently requested scenario for this user."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id": {"type": "string", "description": "e.g. scn-1234567890-abcdef. Omit to check the most recent one."},
                    },
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


def execute_tool(name, inputs, claims):
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

        sid = (inputs.get('scenario_id') or '').strip()
        if sid:
            match = next((s for s in scenarios if s['id'] == sid), None)
            return match or {'error': f'no scenario found with id {sid}'}

        email = claims.get('email')
        mine = [s for s in scenarios if s.get('requested_by') == email]
        if not mine:
            return {'message': 'No scenarios found for this user yet.'}
        return mine[0]  # list_scenarios already sorts newest-first

    if name == 'point_to_ui':
        return {'ok': True}  # actual UI effect happens client-side; this just satisfies the tool-result contract

    return {'error': f'unknown tool {name}'}


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
            # see literally, so strip them all.
            text = re.sub(r'<thinking>.*?</thinking>\s*', '', text, flags=re.DOTALL)
            text = re.sub(r'</?reply>', '', text)
            text = re.sub(r'</?(?:run_scenario|check_scenario_status|point_to_ui)\b[^>]*>', '', text, flags=re.DOTALL)
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
        reply = ''
        seen_tool_calls = set()  # (name, sorted-inputs) already executed this request
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
                    # Nova occasionally gets stuck re-issuing the exact same
                    # tool call indefinitely (observed: point_to_ui with an
                    # unchanged target, 8+ times in a row) — no fixed
                    # iteration budget reliably bounds a genuine loop, so
                    # detect the repeat directly instead.
                    call_sig = (tu['name'], json.dumps(inputs, sort_keys=True))
                    if call_sig in seen_tool_calls:
                        repeated_call = True
                    seen_tool_calls.add(call_sig)
                    result = execute_tool(tu['name'], inputs, claims)
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
            reply = "Done — I've highlighted it in the sidebar for you." if point_to else "Done!"

        return {
            'statusCode': 200,
            'headers':    {**CORS, 'Content-Type': 'application/json'},
            'body':       json.dumps({'reply': reply, 'point_to': point_to}),
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
