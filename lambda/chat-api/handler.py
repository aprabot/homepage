import csv
import hashlib
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
# Pre-staged demo input for run_scenario's discount_scenario flag — a real
# custom upload (Shipments = the actual full catalog, unchanged, + a Future
# Price sheet applying a flat 20% discount off each SKU's own historical
# average price, for every real ASIN x postal_code combination, across the
# full 364-day forward horizon) sitting in S3 ahead of time so a live demo
# doesn't depend on an on-stage file upload or on-the-fly generation.
# 2026-09-08: built and verified locally (both that scenario-runner's own
# Future Price column/validation logic accepts it, and that forecast.py
# actually produces a different forward forecast when fed it) before this
# key was wired in. Must live under uploads/ — scenarios-api's
# create_scenario rejects any custom_input_key that doesn't.
# Lives under aprabot-internal's own org prefix (not global) — scenarios-api
# now requires every custom_input_key to belong to the calling org, and this
# fixture is only ever used for APRABot's own team demos anyway. Migrated
# here (copied, not moved) alongside the rest of the org-scoping rollout.
KNOWLEDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'forecasting_knowledge.md')
KNOWLEDGE_KEY  = os.environ.get('KNOWLEDGE_KEY', 'knowledge/forecasting_knowledge.md')
# RAG index for the knowledge base — see build_knowledge_index()/retrieve_
# knowledge() below. A companion object next to KNOWLEDGE_KEY, not a
# replacement for it: the raw .md stays the source of truth the editor
# loads/saves, this is a derived, rebuilt-on-every-save cache.
KNOWLEDGE_INDEX_KEY = os.environ.get('KNOWLEDGE_INDEX_KEY', 'knowledge/forecasting_knowledge.index.json')
EMBED_MODEL_ID = os.environ.get('EMBED_MODEL_ID', 'amazon.titan-embed-text-v2:0')
KNOWLEDGE_TOP_K = 4  # sections retrieved per chat message, out of ~15-20 total

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
}

_cache = {}   # simple in-process cache across warm invocations, keyed by
              # org id (see _CURRENT_ORG) so a warm container reused for a
              # different org's request never serves another org's data.
_CURRENT_ORG = {'id': None}  # set first thing in handler() every invocation

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


# Fixed-date national holidays for India — the same list the onboarding
# Weather & festivals step pre-fills (js/onboarding.js HOLIDAY_RULES.IN).
# Lunar-calendar festivals (Diwali, Holi, Eid, ...) move every year, so
# they're deliberately not guessed here.
IN_FIXED_HOLIDAYS = {(1, 26): 'Republic Day', (4, 14): 'Ambedkar Jayanti', (5, 1): 'May Day',
                     (8, 15): 'Independence Day', (10, 2): 'Gandhi Jayanti', (12, 25): 'Christmas'}
COUNTRY_NAMES = {'JP': 'Japan', 'IN': 'India', 'US': 'United States'}


def _detect_country():
    """The forecast's country, inferred from its own postal codes: 7-digit
    123-4567 = Japan, 6-digit PIN = India, 5-digit ZIP = United States.
    None when there are no postal codes or they don't match one pattern.
    Holidays and weather are only quoted for a detected country — an
    Indian forecast must never be explained with Japan's calendar."""
    cache_key = f"country:{_CURRENT_ORG['id']}"
    if cache_key in _cache:
        return _cache[cache_key]
    counts = {}
    try:
        for d in _get_forecast_data().get('skus', {}).values():
            for zip_code in (d.get('byZip') or {}):
                z = str(zip_code).strip()
                c = ('JP' if re.fullmatch(r'\d{3}-\d{4}', z) else 'IN' if re.fullmatch(r'\d{6}', z)
                     else 'US' if re.fullmatch(r'\d{5}', z) else None)
                if c:
                    counts[c] = counts.get(c, 0) + 1
    except Exception:
        counts = {}
    country = max(counts, key=counts.get) if counts else None
    _cache[cache_key] = country
    return country


def _holiday_on(day):
    """The detected country's public holiday on this date, or None."""
    country = _detect_country()
    if country == 'JP':
        name = jpholiday.is_holiday_name(day)
        return _translate_holiday(name) if name else None
    if country == 'IN':
        return IN_FIXED_HOLIDAYS.get((day.month, day.day))
    return None


def _week_holidays(week_start_str):
    """Public holidays (for the forecast's own country — see _detect_country)
    falling within the Mon-Sun week starting on week_start_str — real,
    computed dates, not guessed."""
    start = dt.date.fromisoformat(week_start_str)
    names = []
    for i in range(7):
        day = start + dt.timedelta(days=i)
        name = _holiday_on(day)
        if name:
            names.append(f"{name} ({day.isoformat()})")
    return names


def _weekly_weather():
    """Aggregates raw/weather.tsv (daily, per postal code) to one row per
    W-SUN week, averaged across all postal codes — only covers real
    historical dates, not the forward forecast period. Japan only: this
    file is the Japanese platform dataset's weather, so it would describe
    the wrong place for any other country's forecast."""
    if _detect_country() != 'JP':
        return {}
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
    return _holiday_on(dt.date.fromisoformat(date_str))


def _day_weather(date_str):
    """Real historical weather for a single date, averaged across postal
    codes — same source (raw/weather.tsv) as _weekly_weather(), just not
    pre-aggregated to a week. Returns None for a date with no matching rows
    (most commonly: a forward-forecast date, since weather isn't known that
    far in advance). Japan only, same as _weekly_weather()."""
    if _detect_country() != 'JP':
        return None
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


def _embed_text(text):
    """One Titan Embeddings V2 call -> list[float] (1024-dim). Truncated
    defensively — the model has its own input-length limit and a KB
    section is never anywhere near it, this is just a safety net."""
    resp = bedrock.invoke_model(
        modelId=EMBED_MODEL_ID,
        body=json.dumps({'inputText': text[:8000]}),
        contentType='application/json', accept='application/json',
    )
    return json.loads(resp['body'].read())['embedding']


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _split_knowledge_sections(content):
    """Split the KB markdown into (title, body) sections on H1/H2 headings
    ('#'/'##') — H3+ subheadings stay nested inside their enclosing
    section (this file's own numbered subsections like 8.1/8.2/8.3 are
    already organized that way, so splitting deeper would break up
    content the author clearly intended to read together). Each body
    includes its own heading line, so a retrieved chunk reads naturally
    on its own. Returns a list of {'title', 'body'} dicts, empty ones
    dropped (e.g. any stray content before the first heading, if there is
    none worth keeping)."""
    heading_re = re.compile(r'^#{1,2}\s+(.+)$')
    sections, cur_title, cur_lines = [], None, []
    for line in content.split('\n'):
        m = heading_re.match(line)
        if m:
            if cur_lines:
                sections.append({'title': cur_title or '(intro)', 'body': '\n'.join(cur_lines).strip()})
            cur_title, cur_lines = m.group(1).strip(), [line]
        else:
            cur_lines.append(line)
    if cur_lines:
        sections.append({'title': cur_title or '(intro)', 'body': '\n'.join(cur_lines).strip()})
    return [s for s in sections if s['body'].strip()]


def build_knowledge_index(content):
    """Split the just-saved KB content into sections and embed each one —
    called synchronously from put_knowledge() so the index stays as fresh
    as the raw file, keeping the same 'live on the very next message'
    guarantee the old full-file approach had. ~15-20 short sections at
    ~150-250ms/embed call is a few seconds, acceptable for a Save click
    (the UI already shows a 'Saving…' state for the round trip)."""
    sections = _split_knowledge_sections(content)
    for s in sections:
        s['embedding'] = _embed_text(s['title'] + '\n' + s['body'])
    return {'sections': sections, 'built_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def retrieve_knowledge(question):
    """RAG retrieval for the knowledge base: embed the question, cosine-
    rank the pre-embedded sections from the index build_knowledge_index()
    produces, return only the top KNOWLEDGE_TOP_K sections' text instead
    of dumping the entire KB file into every prompt regardless of
    relevance (the old load_forecasting_knowledge()-in-every-request
    behavior) — fixes both the cost of a growing KB and a large model
    context diluting attention on whatever's buried lower in the file.
    Falls back to the full file — the exact old behavior — if there's no
    index yet (e.g. a knowledge base saved before this existed, or one
    that's never been re-saved since) or if anything about retrieval
    itself fails; a degraded-but-working answer beats a broken one."""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=KNOWLEDGE_INDEX_KEY)
        sections = json.loads(obj['Body'].read().decode('utf-8')).get('sections') or []
        if not sections:
            raise ValueError('empty knowledge index')
        qvec = _embed_text(question)
        ranked = sorted(sections, key=lambda s: _cosine(qvec, s['embedding']), reverse=True)
        return '\n\n'.join(s['body'] for s in ranked[:KNOWLEDGE_TOP_K])
    except Exception as exc:
        print(f"KB_RETRIEVAL_FALLBACK: {exc} — using full-file knowledge instead")
        return load_forecasting_knowledge()


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

    # Rebuild the RAG index for retrieve_knowledge() so the edit's actual
    # CONTENT is what's used on the next chat message, not just that the
    # raw file changed. Best-effort: an embedding hiccup here (e.g. a
    # transient Bedrock throttle) must not undo the content save that
    # already succeeded above — retrieve_knowledge() already falls back to
    # the full file if the index is stale or missing, so this degrades
    # gracefully rather than breaking the save.
    try:
        index = build_knowledge_index(content)
        s3.put_object(Bucket=BUCKET, Key=KNOWLEDGE_INDEX_KEY,
                       Body=json.dumps(index).encode('utf-8'), ContentType='application/json')
    except Exception as exc:
        print(f"KB_INDEX_BUILD_FAILED: {exc} — content saved, but chat will use the full-file "
              f"fallback until the next successful save")

    return {'statusCode': 200, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps({'saved': True,
                                 'updated_at': dt.datetime.now(dt.timezone.utc).isoformat()})}


INSIGHTS_PROMPT_TMPL = """You are writing a concise executive AI Insights brief for a demand-forecasting \
dashboard, grounded ONLY in the real data below — never invent a SKU, number, or trend that isn't in it.

{data_summary}

Return ONLY a single JSON object (no markdown fences, no commentary before or after it) with exactly \
these fields:
{{
  "tagline": "a punchy 5-8 word summary line",
  "headline": "one sentence — the single most important takeaway",
  "summary": "2-4 sentences giving the overall picture: accuracy, volume trend, what it means for planning",
  "key_findings": [{{"title": "short label", "detail": "1-2 sentences citing real numbers"}}] (3 to 5 of these),
  "watch_areas": ["1-2 sentences flagging something that needs attention"] (2 to 3 of these),
  "opportunities": ["1-2 sentences on a positive trend worth acting on"] (1 to 3 of these)
}}

Cite real SKU ids and real percentages from the data above. Never state a WAPE, accuracy, or "actual" \
figure for a forward-only week — those only have a forecast, no ground truth exists for them yet."""


def _extract_json_object(text):
    """Nova's response is usually clean JSON, but strip a stray markdown
    fence or preamble sentence defensively — same spirit as _text_of()'s
    own cleanup of the regular chat reply, just for a structured response
    instead of prose."""
    start, end = text.find('{'), text.rfind('}')
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def _generate_insights(org, scenario_id, scenario_label):
    """Best-effort, fire-and-forget — mirrors compute_monthly_inventory()'s
    own convention in scenario-runner: never raise past its own boundary,
    since approve_scenario() has already succeeded by the time this runs
    and must not be undone by a generation hiccup. Invoked directly (not
    through API Gateway — see handler()'s own internal_task branch) right
    after scenarios-api writes this org's new forecast/latest.json, so
    _get_forecast_data() below naturally picks up the just-approved
    scenario's data with no extra plumbing to tell it which one.

    Reuses build_data_summary() verbatim — the exact same forecast
    grounding built for every chat message — so the brief cites the same
    numbers Lyra herself would if asked the same question directly, not a
    second, possibly-divergent view of the data.
    """
    try:
        _CURRENT_ORG['id'] = org
        # Force a fresh read: a warm container's cache may still hold the
        # PREVIOUS approved scenario's data from an earlier chat request in
        # this same container, and this absolutely must not generate a
        # brief for stale data.
        _cache.pop(f'forecast_data:{org}', None)
        _cache.pop(f'sku_rows:{org}', None)
        data_summary = build_data_summary()

        resp = bedrock.converse(
            modelId=MODEL,
            system=[{'text': 'You write grounded, concrete executive briefs from real data. '
                              'Output ONLY valid JSON, nothing else — no markdown fences, no preamble.'}],
            messages=[{'role': 'user', 'content': [{'text': INSIGHTS_PROMPT_TMPL.format(data_summary=data_summary)}]}],
            inferenceConfig={'maxTokens': 1500, 'temperature': 0.4},
        )
        parsed = _extract_json_object(_text_of(resp['output']['message']))
        if not parsed or not parsed.get('headline'):
            print(f"INSIGHTS_GEN_FAILED[{org}/{scenario_id}]: model reply had no usable JSON object")
            return

        data = _get_forecast_data()
        bt = data.get('backtestWeeks', len(data['weeks']))
        insights = {
            'tagline': parsed.get('tagline'),
            'headline': parsed.get('headline', ''),
            'summary': parsed.get('summary', ''),
            'key_findings': parsed.get('key_findings') or [],
            'watch_areas': parsed.get('watch_areas') or [],
            'opportunities': parsed.get('opportunities') or [],
            'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
            # Computed deterministically rather than trusted from the
            # model's own output — exact figures, not narrative, belong in
            # Python, not an LLM's free-text response.
            'based_on': {
                'weeks_total': len(data['weeks']), 'backtest_weeks': bt,
                'forward_weeks': len(data['weeks']) - bt, 'overall_wape': data.get('overallWape'),
            },
            # What the UI shows as "generated for" — see js/insights.js's render().
            'scenario_id': scenario_id,
            'scenario_label': scenario_label,
        }
        s3.put_object(Bucket=BUCKET, Key=f'orgs/{org}/insights/latest.json',
                       Body=json.dumps(insights).encode('utf-8'), ContentType='application/json')
        print(f"INSIGHTS_GEN: wrote orgs/{org}/insights/latest.json for scenario {scenario_id}")
    except Exception as exc:
        print(f"INSIGHTS_GEN_FAILED[{org}/{scenario_id}]: {exc}")


def _get_forecast_data():
    """Fetch + parse this org's forecast/latest.json once per warm
    invocation, shared by build_data_summary() (which turns it into the
    prompt string) and any tool that needs the structured data directly
    (e.g. explain_forecast_day, which looks up a specific week's real
    numbers). Cached per-org (_CURRENT_ORG, set at the top of handler())
    so a warm container never serves one org's forecast to another."""
    cache_key = f"forecast_data:{_CURRENT_ORG['id']}"
    if cache_key not in _cache:
        obj = s3.get_object(Bucket=BUCKET, Key=f"orgs/{_CURRENT_ORG['id']}/{KEY}")
        _cache[cache_key] = json.loads(obj['Body'].read().decode('utf-8'))
    return _cache[cache_key]


def _annotation_label(explain_result):
    """Best-effort short label for the chart annotation explain_forecast_day
    triggers — same priority order Lyra herself is told to lead with
    (holiday, then weather, then weekend), so the label on the chart always
    matches whatever reason she actually gives in her text reply. Falls back
    to the bare date so there's always SOMETHING to show at the point, even
    with no notable qualitative driver — the value is in showing WHERE she's
    talking about, not just why."""
    if explain_result.get('holiday'):
        return '🎌 ' + explain_result['holiday']
    weather = explain_result.get('weather')
    if weather:
        if weather.get('hot_share', 0) > 0.5:
            return '☀️ Hot week'
        if weather.get('cold_share', 0) > 0.5:
            return '❄️ Cold week'
    if explain_result.get('is_weekend'):
        return '📅 Weekend'
    return '📍 ' + (explain_result.get('date') or '')


def _downsample(arr, target=40):
    """Even-stride downsample for compact chart payloads — an inline chat
    sparkline doesn't need full weekly resolution, and this keeps both the
    tool result (which the model also reads) and the client-facing chart
    payload small and length-independent regardless of a series' actual
    horizon (backtest+forward commonly 80-100+ weeks)."""
    n = len(arr)
    if n <= target:
        return arr
    step = n / target
    return [arr[int(i * step)] for i in range(target)]


def _sku_row(sku_id, sku_data, bt, trail_win):
    """One SKU's summary stats (backtest volume/WAPE/accuracy, forward
    forecast total, trend vs. an equally-sized trailing-actual window) —
    factored out of build_data_summary() so compare_skus can look up the
    exact same numbers for just two SKUs without recomputing the whole
    catalog inline.

    avg_price/revenue_est: added so "$ value" / revenue questions have a
    real number to point to instead of "no price data" — avgPrice is a
    volume-weighted average selling price over the SKU's full raw history
    (scenario-runner's transform_to_weekly(), not computed here), so
    revenue_est = vol x avgPrice is an ESTIMATE (this dataset has no exact
    per-order revenue figure), not a made-up one. None on older cached
    results from before this field existed."""
    a, f = sku_data['a'], sku_data['f']
    vol = sum(x for x in a if x is not None)
    num = sum(abs(x - y) for x, y in zip(a, f) if x is not None)
    wape = round(100 * num / vol, 2) if vol else 0
    fwd = sum(x for x in f[bt:] if x is not None)
    trail_actual = sum(x for x in a[max(0, bt - trail_win):bt] if x is not None) if trail_win else 0
    # The next trail_win forward weeks vs. the last trail_win actual weeks —
    # equal-length windows. (Using the whole forward horizon here compared
    # e.g. 52 forecast weeks with 21 actual weeks and reported +150% "growth".)
    fwd_window = sum(x for x in f[bt:bt + trail_win] if x is not None) if trail_win else 0
    trend = round(100 * (fwd_window - trail_actual) / trail_actual, 1) if trail_win and trail_actual else None
    avg_price = sku_data.get('avgPrice')
    revenue_est = round(vol * avg_price, 2) if avg_price is not None else None
    return {'sku': sku_id, 'vol': vol, 'wape': wape, 'acc': round(100 - wape, 1), 'fwd': fwd, 'trend': trend,
            'avg_price': avg_price, 'revenue_est': revenue_est}


def _all_sku_rows():
    """Every SKU's _sku_row(), sorted by backtest volume and tiered
    High/Medium/Lower — cached per warm invocation since both
    build_data_summary() (every request) and compare_skus (on demand) need
    the exact same ranked/tiered list, and tiering requires the whole
    catalog's ranks, not just the SKUs in question."""
    cache_key = f"sku_rows:{_CURRENT_ORG['id']}"
    if cache_key in _cache:
        return _cache[cache_key]

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
    _cache[cache_key] = rows
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
    levers = meta.get('levers') or {}
    if levers.get('spend_pct') is not None:
        parts.append(f"marketing spend {levers['spend_pct']:+d}%")
    if levers.get('price_pct') is not None:
        target = [t for t in (levers.get('price_sku'), levers.get('price_postal_code'), levers.get('price_target')) if t]
        parts.append(f"price {levers['price_pct']:+d}%" + (f" ({', '.join(target)})" if target else ''))
    if levers.get('unit_cap') is not None:
        parts.append(f"weekly cap {levers['unit_cap']:,}")
    if levers.get('holiday_off'):
        parts.append('forward holiday effects off')
    if levers.get('excluded_schemes'):
        parts.append(f"{len(levers['excluded_schemes'])} schemes excluded")
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
        "confidence is the tier explained below. avg_price is a volume-weighted average selling price "
        "over each SKU's full history; revenue_est = vol x avg_price is an ESTIMATE — this dataset has "
        "no exact per-order revenue figure, so always call it an estimate when quoting it, never state "
        "it as precise transaction revenue. n/a on either means no price data survived for that SKU.) ---",
    ]
    for r in rows:
        trend_str = f"{r['trend']:+.1f}%" if r['trend'] is not None else "n/a"
        price_str = f"{r['avg_price']:.2f}" if r['avg_price'] is not None else "n/a"
        revenue_str = f"{r['revenue_est']:,.0f}" if r['revenue_est'] is not None else "n/a"
        lines.append(
            f"  {r['sku']:20s}  vol={r['vol']:>9,}  WAPE={r['wape']:.1f}%  acc={r['acc']:.1f}%  "
            f"forward_fcst={r['fwd']:>8,}  trend={trend_str:>7s}  confidence={r['tier']}  "
            f"avg_price={price_str:>8s}  revenue_est={revenue_str:>12s}")

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
    # Only SKUs actually moving that way — with a small catalog the top 5
    # otherwise listed flat or shrinking SKUs as "fastest-growing".
    declining  = sorted([r for r in with_trend if r['trend'] < 0], key=lambda x: x['trend'])[:5]
    growing    = sorted([r for r in with_trend if r['trend'] > 0], key=lambda x: -x['trend'])[:5]
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

    # Peak/highest forecasted week(s), forward horizon only, all-SKU total —
    # added because there was previously NO way to ground a "which week/
    # period is the peak/highest forecasted" question: no tool searches for
    # a maximum across the horizon (get_forecast_range only sums a range the
    # caller already has to name; explain_forecast_day only explains one
    # given date), so this used to get answered by fabricating a plausible-
    # looking date/number instead of computing one. Precomputed here the
    # same way worst_wk/best_wk are, so the answer is always a real number.
    fwd_week_totals = [(i, v) for i, v in enumerate(data['all']['f'][bt:], start=bt) if v is not None]
    if fwd_week_totals:
        top_fwd_weeks = sorted(fwd_week_totals, key=lambda x: -x[1])[:5]
        lines += [
            "",
            "--- PEAK FORECASTED WEEKS (forward horizon only, total forecast units summed across ALL "
            "SKUs, highest first — this is the ONLY reliable source for 'which week/period is the "
            "peak/highest forecasted' style questions; never estimate this from memory or by eyeballing "
            "get_forecast_range's per-week series, which is downsampled and not meant for finding a "
            "maximum) ---",
            *[f"  {data['weeks'][i]}  total_forecast_units={v:,.0f}" for i, v in top_fwd_weeks],
        ]

    # Real holiday (Japan's actual public-holiday calendar, same as
    # forecast.py uses as a model feature) and weather context per week —
    # lets Lyra correlate a spike or drop with an actual cause instead of
    # only describing the number. Weather only covers real historical dates;
    # forward weeks show holidays only (weather isn't known in advance).
    weather_by_week = _weekly_weather()
    country = _detect_country()
    if country == 'JP':
        context_note = "Japan's public holidays (the calendar forecast.py trains on) and historical weather"
    elif country == 'IN':
        context_note = ("India's fixed-date national holidays only (Republic Day, Independence Day, Gandhi "
                        "Jayanti, etc.) — lunar festivals such as Diwali, Holi and Eid move every year and "
                        "are NOT listed, and no weather data is available to you for India")
    else:
        context_note = "no holiday calendar or weather data is available for this forecast's country"
    lines += ["", f"FORECAST COUNTRY: {COUNTRY_NAMES.get(country, 'unknown')} (detected from its postal codes)",
              f"--- WEEKLY CONTEXT ({context_note}) ---"]
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

    lines += _inventory_summary_lines()
    return "\n".join(lines)


def _get_inventory_data():
    """This org's forecast/latest_inventory.json (required inventory per SKU x
    postal code x month — cycle stock + safety stock — published alongside
    latest.json when a scenario is approved), or None if there isn't one."""
    cache_key = f"inventory:{_CURRENT_ORG['id']}"
    if cache_key not in _cache:
        try:
            obj = s3.get_object(Bucket=BUCKET, Key=f"orgs/{_CURRENT_ORG['id']}/forecast/latest_inventory.json")
            _cache[cache_key] = json.loads(obj['Body'].read().decode('utf-8'))
        except Exception:
            _cache[cache_key] = None
    return _cache[cache_key]


def _inventory_totals(inv, month_idx):
    """{sku: {'total','cycle','safety'}} summed across postal codes for one month."""
    out = {}
    for sku, sd in (inv.get('bySku') or {}).items():
        t = {'total': 0, 'cycle': 0, 'safety': 0}
        for zd in (sd.get('byZip') or {}).values():
            for k, src in (('total', 'total'), ('cycle', 'cycleStock'), ('safety', 'safetyStock')):
                arr = zd.get(src) or []
                if month_idx < len(arr) and arr[month_idx] is not None:
                    t[k] += arr[month_idx]
        out[sku] = t
    return out


def _inventory_summary_lines():
    inv = _get_inventory_data()
    if not inv or not inv.get('months'):
        return ["", "--- REQUIRED INVENTORY --- none available for the current approved forecast "
                "(it is computed when a scenario runs and published when one is approved)."]
    months = inv['months']
    i = len(months) - 1  # the Inventory page also shows the latest month by default
    totals = _inventory_totals(inv, i)
    p = inv.get('params') or {}
    rows = sorted(totals.items(), key=lambda kv: -kv[1]['total'])
    lines = [
        "",
        f"--- REQUIRED INVENTORY (Inventory page; month {months[i]}, summed across postal codes) ---",
        "Required = cycle stock + safety stock, from shipment history. Safety stock assumes a "
        f"{p.get('leadTimeDays', 14):g}-day lead time and a {round(100 * p.get('serviceLevel', 0.95))}% service level — "
        "these lead-time figures are ASSUMED placeholders (the source data has no vendor lead times); say so "
        "when quoting safety stock. On-hand, in-transit and open-PO stock are NOT available, so never claim a "
        "shortfall or surplus versus stock on hand. For one postal code or another month, call get_inventory.",
        f"  catalog total required={sum(t['total'] for t in totals.values()):,.0f}",
    ]
    for sku, t in rows[:25]:
        lines.append(f"  {sku:20s}  required={t['total']:>9,.0f}  cycle={t['cycle']:>8,.0f}  safety={t['safety']:>8,.0f}")
    if len(rows) > 25:
        lines.append(f"  … {len(rows) - 25} more SKUs — use get_inventory for any of them.")
    return lines


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
  against the WEEKLY CONTEXT section below (real public holidays for the FORECAST COUNTRY, and
  weather where available) before concluding it's unexplained. Only ever name holidays of that
  country; if the section says no calendar is available, say so instead of naming any. If a
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
• For any "which week/period is the peak/highest forecasted (across all SKUs or overall)" style
  question, use the PEAK FORECASTED WEEKS section below — never try to compute or estimate this
  yourself (there is no tool that searches for a maximum across the horizon; get_forecast_range only
  sums a range you already name, and its per-week series is downsampled, not exhaustive, so scanning
  it for a max will give a wrong week/number). If the section doesn't cover the exact SKU or window
  the user asked about (e.g. one specific SKU rather than all SKUs, or the backtest instead of the
  forward horizon), say plainly that level of breakdown isn't available rather than guessing.
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
  Check holidays_in_week too: a holiday later in the same week (e.g. a Friday) still shapes that
  week's numbers, so mention it with its date.
• Every explain_forecast_day call also does something real and visible on its own: it switches the
  Forecasts chart to the right SKU (or the all-SKU view) and draws a pulsing marker with a callout
  right on the exact point on the line you're discussing — the user can watch you point at it. This
  happens automatically; you don't control it and it needs no separate mention beyond something
  natural like "look at the chart" if it fits. Don't also call point_to_ui at Forecasts for this —
  same as generate_report/open_scenario, it's already shown directly, a nav highlight on top of that
  is redundant.
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
• Use list_scenario_runs for a run list, get_plan_approval_history for approval records,
  get_scenario_demand_changes for the SKU and postal code changes versus the approved plan,
  and rank_forecast_skus for the top SKUs by forward units. When ranking, report the weeks
  covered and any skipped incomplete series.
• For a named promotion, use list_discount_schemes to look and draft_discount_scheme to prepare a
  draft. Never fill in terms: if the user hasn't said the discount, the SKU (or all SKUs), the PIN
  code (or all) and the dates, ask for what is missing instead of calling the tool. You cannot
  commit or withdraw schemes: say it is done on the Discount Schemes page. Answer questions about
  schemes ("what would happen if…", "should I…") in words. To try a draft in a scenario, pass its
  ID in run_scenario's included_schemes.
• draft_discount_scheme, approve_scenario and some run_scenario calls show the user the exact terms
  and wait for their yes. Never say something was saved, started or approved yourself.
• For a scenario testing a discount or price change ("a 20% discount on all products", "cut SKU-002's price 10% in
  400001"), use run_scenario's price_pct lever (negative for a discount), with price_sku and/or
  price_postal_code if they named one. A discount_scenario=true call is the same as price_pct=-20 on
  every product. One SKU and/or one postal code per run is the most it can target — if they ask for
  more than that, say so rather than running something different from what they asked.
• When the user asks to see, open, show, pull up, or look at a specific scenario (as opposed to
  asking a question you can just answer in text), use open_scenario — it opens the real detail
  modal (chart, top SKUs, validations, Approve) directly, so hand it to them rather than describing
  where to click. Don't also call point_to_ui at Scenarios for this — the modal already shows it,
  same as generate_report. Use check_scenario_status instead when they're asking FOR specific
  numbers/status as an answer (e.g. "what's the WAPE on the 40% discount run"), not to see the UI.
• Approving a scenario (approve_scenario) makes it the live forecast for every user. Call it when the
  user asks to approve or apply a scenario; never start a run instead. It shows them the scenario and
  asks them to confirm. Never claim it is approved yourself.
• For "any data quality issues with this scenario" / "does this run look OK", use
  check_scenario_validations rather than eyeballing the raw numbers yourself — it runs the same
  fixed checklist the dashboard's own "Run validations" button does, so the pass/warn/fail verdicts
  match exactly. Lead with any failed checks, then warnings; don't restate passed checks in detail,
  a brief "everything else checked out" covers them.
• For "any anomalies" / "does this forecast look safe to approve" / "anything weird about SKU-X",
  use detect_anomalies rather than eyeballing weeks yourself — it's per-SKU statistical outlier
  detection (backtest misses, forward-forecast swings, WAPE outliers), judged against each SKU's own
  history, the same methodology the scenario detail view's own Anomalies card uses. Distinct from
  check_scenario_validations (structural data-quality, not statistical outliers) — use both if asked
  something that spans both ("is this scenario OK to approve" genuinely warrants either or both).
  With no scenario named, this defaults to the currently APPROVED one, not your most recent run.
• For "compare scenario X and Y" (two specific runs), use compare_scenarios — never eyeball two
  check_scenario_status calls yourself, its numbers (including the forward-horizon delta, which
  backtest-period WAPE/volume-error alone can't show) are the ones the dashboard's own Compare view
  shows. Both scenarios must be identified by name or id; if the user only names one, ask which
  second scenario they mean rather than guessing.
• For "compare SKU-X and SKU-Y" (two SKUs within the CURRENT live forecast, not two scenarios), use
  compare_skus instead — different tool, different question.
• compare_skus and get_forecast_range both also render a small inline chart in the chat automatically
  (a two-SKU line comparison, or the actual/forecast weekly trend for a date range) — you don't control this and it needs no
  separate mention or setup; just answer normally in text. Keep the reply itself to the actual
  numbers/comparison, not a verbal description of what the chart looks like (e.g. not "the lines
  show an upward trend" — the picture already says that).
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
• THE DASHBOARD — what each sidebar page is for (use this to answer "where do I…" / "how do I…"
  questions, and call point_to_ui with the page's exact name):
  – Getting Started: the onboarding flow — Country (sets postal pattern, festival calendar, currency;
    locks after the first upload), Connect Shopify, Sales data (the historical sales file), Marketing
    spend, SKU master, Inbound receipts, Weather & festivals, then Review & train, which trains a real
    forecast; for an admin it becomes the live forecast automatically and shows on Forecasts,
    Overview and Scenarios. Also has a guided product walkthrough.
  – Overview: headline KPIs and the Plan & Scenario Comparison Matrix (last year vs. committed plan
    vs. scenarios), with a 12W/26W/52W horizon.
  – Discount Schemes: create and manage promotions (percent off, flat amount, Buy X get Y, bundle,
    free gift, cashback, tiered) scoped by SKU, postal code and dates; Save as a draft or Commit and run.
    Committed schemes are applied to future forecasts; schemes can also be detected from sales.
  – Forecasts: the approved forecast — forecast units, revenue estimate, avg discount/unit and
    backtest WAPE for a 4/12/52-week horizon, a weekly chart of actuals vs. forecast, and a
    per-SKU table compared with last year.
  – Scenarios: the Scenario workspace — a "Last run" card (the most recent run's status, accuracy,
    Compare with approved / View details), a lever form (discount schemes to exclude, marketing spend
    %, holiday impact, a weekly unit cap, price % for one SKU and/or PIN code, weather and refresh
    settings), Run, a comparison against the approved plan (revenue, units vs. plan, capped units,
    stock needed), Apply to plan, plus revision history and approval history. (Promotions are
    managed in Discount Schemes. A scenario can include drafts and exclude committed schemes.)
  – Inventory: required inventory per SKU and site (cycle stock + safety stock) by month. On-hand,
    in-transit and open PO stock aren't connected yet.
  – AI Insights: your own written brief on the current approved forecast.
  – Campaigns, Products, Performance, Integrations (the "Ads" group): plan ad spend by forecast SKU
    and postal code, view the Shopify catalog or manually maintained products, campaign results
    (not available until live ad reporting is connected), and connect a Shopify store. Meta and
    Google campaign launches are not available yet — say so rather than promising them.
  – Settings (account, 2FA, report settings, preferences), Knowledge Base (your background
    knowledge, editable), Support (FAQs and support tickets).
  Never invent a page, button or feature that isn't listed here.
• For "how much stock/inventory do I need" questions use the REQUIRED INVENTORY section below or the
  get_inventory tool — not the forecast units, which are demand, not required stock.
• run_scenario always runs on the organization's approved (live) dataset, like the Scenarios page
  default, and supports the same levers as the Scenarios page: spend_pct, price_pct (optionally for
  one price_sku and/or one price_postal_code), unit_cap (optionally for one postal_code),
  excluded_holiday_dates, holiday_off, included_schemes and excluded_schemes. Set only the levers the user asked for. If they ask something you
  can't run (e.g. a lever not listed), say so instead of starting a different run. If the user only
  asks WHETHER you can do something, answer in words — never start a run for a hypothetical.
• The user's current page, when given below, is where they are right now — use it to resolve
  "this page" / "here" (e.g. "what can I do on this page?" → describe that page from THE DASHBOARD
  list above in 2-3 sentences), and don't point them to the page they're already on.
• point_to_ui's target must be the page your reply actually names (e.g. marketing spend upload →
  Getting Started, connecting Shopify → Integrations). Always write the answer in your reply too —
  a highlight alone is never an answer.
• Holidays in WEEKLY CONTEXT show their real date in brackets — quote that date, never the week label.
• The GENERAL FORECASTING KNOWLEDGE section below is background domain knowledge (industry
  concepts, common causes of forecast issues, terminology like WAPE/bias/FVA/bullwhip effect) — use
  it to explain WHY something happens or to name a real phenomenon, never to state a number. The
  live data further below is always the sole source of truth for any actual figure; never quote a
  benchmark or example number from the general knowledge as if it were this dataset's own result.

{knowledge}

{data}
"""

SCHEME_LINE_SCHEMA = {
    "type": "object",
    "required": ["sku", "postal_code", "start_date", "end_date"],
    "properties": {
        "sku": {"type": "string", "description": "Forecast SKU or ALL."},
        "postal_code": {"type": "string", "description": "PIN code as text, or ALL."},
        "start_date": {"type": "string", "description": "Inclusive YYYY-MM-DD."},
        "end_date": {"type": "string", "description": "Inclusive YYYY-MM-DD."},
        "discount": {"type": "number", "description": "Percentage or flat amount per unit."},
        "buy_quantity": {"type": "integer", "description": "Paid units in Buy X get Y."},
        "free_quantity": {"type": "integer", "description": "Free units in Buy X get Y."},
    },
}

def _planning_tool(name, description, properties):
    return {"toolSpec": {"name": name, "description": description, "inputSchema": {"json": {
        "type": "object", "properties": properties,
    }}}}


PLANNING_LIMIT = {"type": "integer", "description": "Number of rows, 1 to 25. Default 10."}
PLANNING_TOOLS = [
    _planning_tool("list_scenario_runs", "List scenario runs, newest first. Filter by name, run status or current approval.", {
        "label": {"type": "string"}, "status": {"type": "string"},
        "approved": {"type": "boolean"}, "limit": PLANNING_LIMIT,
    }),
    _planning_tool("get_plan_approval_history", "Show who approved each plan, when, and which scenario it replaced. Optionally filter by scenario ID.", {
        "scenario_id": {"type": "string"}, "limit": PLANNING_LIMIT,
    }),
    _planning_tool("get_scenario_demand_changes", "Show the biggest absolute changes in forecast units by SKU and postal code against the current approved plan, across overlapping forward weeks. Supply a scenario ID or name.", {
        "scenario_id": {"type": "string"}, "label": {"type": "string"}, "limit": PLANNING_LIMIT,
    }),
    _planning_tool("rank_forecast_skus", "Rank SKUs by total forecast units over the next 4, 12 or 52 forecast weeks. Optionally filter by postal code. Report actual period and incomplete data.", {
        "weeks": {"type": "integer", "enum": [4, 12, 52]},
        "postal_code": {"type": "string"}, "limit": PLANNING_LIMIT,
    }),
]
PLANNING_NAMES = {tool["toolSpec"]["name"] for tool in PLANNING_TOOLS}


TOOL_CONFIG = {
    "tools": [
        *PLANNING_TOOLS,
        {"toolSpec": {
            "name": "list_discount_schemes",
            "description": "List promotion IDs, statuses and versions. Supply a code to inspect its terms before editing.",
            "inputSchema": {"json": {"type": "object", "properties": {"code": {"type": "string"}}}},
        }},
        {"toolSpec": {
            "name": "draft_discount_scheme",
            "description": "Prepare a promotion draft for the user to confirm, new or replacing a saved draft. Only with terms the user gave: never fill in a discount, SKU, PIN code or date yourself. Cannot commit or withdraw.",
            "inputSchema": {"json": {"type": "object", "required": ["name", "mechanic", "scope"],
                "properties": {
                    "code": {"type": "string", "description": "Scheme ID if the user gave one."},
                    "name": {"type": "string"},
                    "mechanic": {"type": "string", "enum": ["Percent off", "Flat amount off", "Buy X get Y"]},
                    "scope": {"type": "array", "items": SCHEME_LINE_SCHEMA},
                }}},
        }},
        {
            "toolSpec": {
                "name": "run_scenario",
                "description": (
                    "Start a real forecast pipeline run (the actual LightGBM model, not a "
                    "simulation) on the organization's approved dataset. Takes about 3-5 minutes. "
                    "Use only when the user explicitly asks to run, start, kick off, or try a new "
                    "forecast/scenario — never for a hypothetical 'can you…' question, and never to approve "
                    "one (use approve_scenario). Unless they plainly said to run it, the user is asked to "
                    "confirm first. Supports the "
                    "Scenarios page levers below; set only the ones the user asked for."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "label":        {"type": "string",  "description": "Short name for this run, e.g. 'No calibration test'."},
                        "known_prices": {"type": "boolean", "description": "Feed actual test-period prices as a known promo calendar. Default true."},
                        "weather":      {"type": "boolean", "description": "Add temperature/precipitation as exogenous features. Default true."},
                        "calibrate":    {"type": "boolean", "description": "Leakage-free rolling bias correction each refresh block. Default true."},
                        "refresh_days": {"type": "integer", "description": "How often lags re-seed with real actuals: 7, 14, or 28. Default 28."},
                        "spend_pct":    {"type": "integer", "description": "Marketing spend change in percent, e.g. 20 or -10 (-100 to 1000)."},
                        "price_pct":    {"type": "integer", "description": "Price change in percent, e.g. -10 for a 10% price cut (-99 to 1000)."},
                        "price_sku":    {"type": "string",  "description": "Limit the price change to one SKU, e.g. SKU-002. Omit for all SKUs."},
                        "price_postal_code": {"type": "string", "description": "Limit the price change to one postal/PIN code. Omit for all."},
                        "unit_cap":     {"type": "integer", "description": "Weekly unit cap (supply constraint), e.g. 5000."},
                        "postal_code":  {"type": "string",  "description": "Limit the spend change and unit cap to one postal code. Omit for all."},
                        "holiday_off":  {"type": "boolean", "description": "Turn off forward holiday effects."},
                        "excluded_schemes": {"type": "array", "items": {"type": "string"}, "description": "Committed discount scheme IDs to leave out of this run."},
                        "included_schemes": {"type": "array", "items": {"type": "string"}, "description": "Draft scheme IDs to apply to this run only."},
                        "excluded_holiday_dates": {"type": "array", "items": {"type": "string"}, "description": "Forward holidays to omit, YYYY-MM-DD."},
                        "discount_scenario": {
                            "type": "boolean",
                            "description": (
                                "Shortcut for 'a 20% discount on all products': same as price_pct=-20 "
                                "for every SKU and postal code, on the approved dataset. For any other "
                                "depth or scope, use price_pct (with price_sku/price_postal_code) instead."
                            ),
                        },
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
                "name": "open_scenario",
                "description": (
                    "Open a scenario's full detail view directly in the dashboard — the same modal "
                    "the user would get by clicking its row in Scenarios (chart, top SKUs by "
                    "volume, the validations pill, Approve/download buttons). The actual modal "
                    "opens client-side; this just triggers it. Call this whenever the user asks to "
                    "see, open, show, pull up, or look at a specific scenario — hand it to them "
                    "directly instead of just telling them to go find it in the Scenarios tab, and "
                    "don't also call point_to_ui at Scenarios for this, the modal already shows it. "
                    "(For just the numbers/status as text instead of opening the UI, use "
                    "check_scenario_status.) Look it up by scenario_id, by label (partial match, "
                    "e.g. 'the 40% discount scenario'), or omit both for 'open the latest run' (the "
                    "user's most recently requested scenario)."
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
                    "& Forecasts for every user. This shows the user what it would approve and asks them "
                    "to confirm; it never approves by itself. Look the scenario up by scenario_id, by label (partial "
                    "match, e.g. 'the 40% discount scenario'), or omit both for 'approve the latest "
                    "run' (the user's most recently requested scenario)."
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
                "name": "detect_anomalies",
                "description": (
                    "Checks whether a scenario's forecast LOOKS statistically sane before approving "
                    "it — three things, each judged against a SKU's OWN historical behavior rather "
                    "than one fixed rule: (1) backtest weeks where the model's error badly missed "
                    "that specific SKU's own typical error, (2) forward weeks whose forecast swings "
                    "further week-over-week than that SKU's own model curve has ever moved "
                    "historically, (3) SKUs whose own WAPE is markedly worse than this scenario's "
                    "overall WAPE. This is NOT the same as check_scenario_validations — that's "
                    "structural data-quality (negative values, date gaps, reconciliation); this is "
                    "per-SKU, per-week statistical outlier detection, the same methodology behind the "
                    "scenario detail view's own 'Anomalies' card. Use for 'any anomalies', 'does this "
                    "look safe to approve', 'anything weird about SKU-003's forecast' style questions. "
                    "Omitting scenario_id and label defaults to whichever scenario is CURRENTLY "
                    "APPROVED (the live forecast), not the user's most recently run one — that's what "
                    "'any anomalies' almost always means with nothing else specified."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "scenario_id": {"type": "string", "description": "e.g. scn-1234567890-abcdef. Omit to look up by label, or omit both for the currently approved scenario."},
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
                    "WAPE, accuracy, forward forecast total, trend, confidence tier, and average "
                    "selling price + an ESTIMATED revenue (volume x average price — this dataset has "
                    "no exact per-order revenue, so always call it an estimate) for each. Use for any "
                    "'compare SKU-X and SKU-Y' style question, including $ value / revenue comparisons."
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
                "name": "get_inventory",
                "description": (
                    "Required inventory (cycle stock + safety stock — the Inventory page's numbers) "
                    "for one SKU, optionally one postal code, for one month (default: the latest "
                    "month). Use for 'how much stock do I need' questions beyond the catalog-level "
                    "REQUIRED INVENTORY summary. Omit sku for the catalog total."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "sku":   {"type": "string", "description": "e.g. SKU-003. Omit for all SKUs."},
                        "zip":   {"type": "string", "description": "Postal code — only valid together with sku."},
                        "month": {"type": "string", "description": "YYYY-MM. Omit for the latest month."},
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
                    "(Scenarios), creating a promotion (Discount Schemes), checking accuracy or "
                    "trends (Forecasts or AI Insights), stock needs (Inventory), reviewing KPIs "
                    "(Overview), ad spend plans (Campaigns), the Shopify catalog (Products), ad "
                    "results (Performance), connecting Shopify (Integrations), changing preferences "
                    "(Settings), background/domain knowledge (Knowledge Base), help tickets "
                    "(Support), or onboarding/uploading data (Getting Started)."
                ),
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {
                        "target": {"type": "string", "enum": [
                            "Getting Started", "Overview", "Discount Schemes", "Forecasts", "Scenarios",
                            "Inventory", "AI Insights", "Campaigns", "Products", "Performance",
                            "Integrations", "Settings", "Knowledge Base", "Support",
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

NAV_TARGETS = {"Getting Started", "Overview", "Discount Schemes", "Forecasts", "Scenarios", "Inventory",
               "AI Insights", "Campaigns", "Products", "Performance", "Integrations", "Settings",
               "Knowledge Base", "Support"}


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


# ---- organization scoping — see forecast-api/handler.py for the full
# rationale (identical copy, no shared layer between these functions). ----
_FREE_EMAIL_DOMAINS = {
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'aol.com',
    'protonmail.com', 'proton.me', 'gmx.com', 'zoho.com',
}
_INTERNAL_EMAILS = {
    'rajat.mahajan.seattle@gmail.com', 'aprabot@gmail.com', 'apurvgsingh@gmail.com',
    'rishabhtrust@gmail.com', 'ifty.pfk2009@gmail.com',
}


def _org_id(email):
    email = (email or '').strip().lower()
    if email in _INTERNAL_EMAILS:
        return 'aprabot-internal'
    domain = email.split('@')[-1] if '@' in email else ''
    if not domain or domain in _FREE_EMAIL_DOMAINS:
        return 'user-' + hashlib.sha256(email.encode()).hexdigest()[:16]
    return domain


def _invoke_scenarios_api(method, path, claims, body=None, query=None):
    fake_event = {
        'requestContext': {'http': {'method': method, 'path': path},
                            'authorizer': {'jwt': {'claims': claims}}},
        'body': json.dumps(body) if body is not None else None,
    }
    if query:
        fake_event['queryStringParameters'] = query
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


def _detect_anomalies(result):
    """Python port of scenarios.js's computeScenarioAnomalies — same three
    checks, same thresholds, so Lyra's answer always matches what the
    scenario detail view's own Anomalies card shows. Distinct from
    _run_data_validations' check #7 above (which flags the AGGREGATE
    forward forecast swinging 3x+ catalog-wide): this is per-SKU, judged
    against each SKU's OWN historical error/volatility rather than one
    fixed multiple, since what's "normal" week-to-week movement varies
    hugely between a bestseller and a slow mover.
      - backtest_misses: a historical week where the model's error badly
        missed that SKU's own typical error (mean + 2.5 std of that SKU's
        own backtest error distribution, 35% floor).
      - forward_swings: a forward week whose forecast moves further, week
        over week, than that SKU's own model curve ever moved across the
        whole backtest window (mean + 3 std of week-over-week % change,
        60% floor).
      - wape_outliers: a SKU whose own WAPE is markedly worse than this
        scenario's overall WAPE.
    """
    backtest_misses, forward_swings, wape_outliers = [], [], []
    weeks = result.get('weeks') or []
    n = result.get('backtestWeeks', len(weeks))
    overall_wape = result.get('overallWape', 0)

    for sku_id, o in (result.get('skus') or {}).items():
        a, f = o.get('a') or [], o.get('f') or []

        errs = []
        for i in range(n):
            if i >= len(a) or a[i] is None:
                continue
            denom = max(abs(a[i]), 1)
            fi = f[i] if i < len(f) and f[i] is not None else 0
            errs.append((i, abs(a[i] - fi) / denom))
        if len(errs) >= 8:
            mu = sum(e[1] for e in errs) / len(errs)
            variance = sum((e[1] - mu) ** 2 for e in errs) / len(errs)
            threshold = max(mu + 2.5 * (variance ** 0.5), 0.35)
            for i, pct in errs:
                if pct >= threshold:
                    backtest_misses.append({
                        'sku': sku_id, 'week': weeks[i], 'actual': a[i],
                        'forecast': f[i] if i < len(f) else None, 'pct_error': round(pct * 100, 1),
                    })
            sku_wape = mu * 100
            if sku_wape >= max(overall_wape * 2, overall_wape + 15):
                wape_outliers.append({'sku': sku_id, 'sku_wape': round(sku_wape, 1)})

        wow = []
        for j in range(1, n):
            if j >= len(f) or f[j - 1] is None or f[j] is None:
                continue
            wow.append(abs(f[j] - f[j - 1]) / max(abs(f[j - 1]), 1))
        if len(wow) >= 8:
            wmu = sum(wow) / len(wow)
            wvariance = sum((v - wmu) ** 2 for v in wow) / len(wow)
            wthreshold = max(wmu + 3 * (wvariance ** 0.5), 0.6)
            for k in range(max(n, 1), len(f)):
                if k - 1 >= len(f) or f[k - 1] is None or f[k] is None:
                    continue
                fbase = max(abs(f[k - 1]), 1)
                change = (f[k] - f[k - 1]) / fbase
                if abs(change) >= wthreshold:
                    forward_swings.append({
                        'sku': sku_id, 'week': weeks[k], 'prev_forecast': f[k - 1],
                        'forecast': f[k], 'pct_change': round(change * 100, 1),
                    })

    backtest_misses.sort(key=lambda x: -x['pct_error'])
    forward_swings.sort(key=lambda x: -abs(x['pct_change']))
    wape_outliers.sort(key=lambda x: -x['sku_wape'])
    return {'backtest_misses': backtest_misses, 'forward_swings': forward_swings, 'wape_outliers': wape_outliers}


def _planning_result(name, inputs, claims):
    if not claims.get('email'):
        return {'error': 'Sign in to view planning data.'}
    limit = _whole(inputs.get('limit', 10))
    if limit is None or not 1 <= limit <= 25:
        return {'error': 'Choose between 1 and 25 rows.'}

    if name == 'rank_forecast_skus':
        horizon = _whole(inputs.get('weeks', 4))
        if horizon not in (4, 12, 52):
            return {'error': 'Choose 4, 12 or 52 forecast weeks.'}
        try:
            data = _get_forecast_data() or {}
        except Exception:
            return {'error': 'No approved forecast is available.'}
        weeks = data.get('weeks', [])
        start = data.get('backtestWeeks', len(weeks))
        period = weeks[start:start + horizon]
        if not period:
            return {'error': 'No forward forecast weeks are available.'}
        postal = str(inputs.get('postal_code') or '').strip().upper()
        rows = []
        incomplete = 0
        for sku, item in data.get('skus', {}).items():
            series = item.get('byZip', {}).get(postal) if postal else item
            if series is None:
                continue
            values = series.get('f', [])[start:start + len(period)]
            if len(values) != len(period) or not all(type(v) in (int, float) and math.isfinite(v) for v in values):
                incomplete += 1
                continue
            rows.append({'sku': sku, 'forecast_units': sum(values)})
        rows.sort(key=lambda row: (-row['forecast_units'], row['sku']))
        return {'week_starts': period, 'requested_weeks': horizon, 'postal_code': postal or None,
                'ranked_skus': len(rows), 'incomplete_skus': incomplete, 'rows': rows[:limit]}

    if name == 'get_plan_approval_history':
        status, response = _invoke_scenarios_api('GET', '/scenarios/approvals', claims)
        if status != 200:
            return {'error': response.get('error', 'Approval history unavailable.')}
        rows = [row for row in response['approvals']
                if not inputs.get('scenario_id') or row['scenario_id'] == inputs['scenario_id']]
        return {'matching_approvals': len(rows), 'approvals': rows[:limit]}

    status, response = _invoke_scenarios_api('GET', '/scenarios', claims)
    if status != 200:
        return {'error': response.get('error', 'Scenarios unavailable.')}
    scenarios = response['scenarios']
    if name == 'list_scenario_runs':
        label = str(inputs.get('label') or '').casefold()
        fields = ('id', 'label', 'status', 'approved', 'created_at', 'wape')
        rows = [{key: row[key] for key in fields if key in row} for row in scenarios
                if label in (row.get('label') or '').casefold()
                and (not inputs.get('status') or row.get('status') == inputs['status'])
                and ('approved' not in inputs or bool(row.get('approved')) == inputs['approved'])]
        return {'matching_runs': len(rows), 'scenarios': rows[:limit]}

    match, error = _match_scenario(inputs, scenarios, claims, allow_default=False)
    if error:
        return error
    status, result = _invoke_scenarios_api('GET', '/scenarios', claims,
                                          query={'view': 'baseline', 'scenario': match['id']})
    if status != 200 or not result.get('detail_available'):
        return {'error': result.get('error', 'No comparable SKU and postal code detail is available.')}
    return {'scenario_id': match['id'], 'scenario_label': match.get('label'),
            'approved_id': result['base']['id'], 'rows': result['rows'][:limit]}


# ---- confirmations ------------------------------------------------------
# Saving a scheme, starting a run the user didn't plainly ask for, and
# approving all change something real. The model never does these itself: its
# tool call only produces a block of exact terms, which handler() sends as the
# whole reply. If the user's NEXT message is a plain yes, handler() carries
# out that block as written, without the model. A prompt can't guarantee this
# (Nova has previewed and confirmed in one go, acted on "what if" questions
# and made up dates); reading the block back from the conversation can.
CONFIRM_HEAD = '**Confirm: {}**'
CONFIRM_TAIL = 'Reply **yes** to go ahead, or tell me what to change. Nothing has been done yet.'
CONFIRM_KINDS = ('Save draft scheme', 'Start scenario run', 'Approve scenario')
_YES = re.compile(r"(yes|yep|yeah|y|ok|okay|sure|confirm|confirmed|go ahead|do it|yes please|please do|"
                  r"save it|start it|run it|approve it)([ ,]+(please|go ahead|do it|save it|start it|run it|approve it|confirm))?[ .!]*", re.I)
_NO = re.compile(r"(no|nope|n|cancel|stop|don'?t|do not|never ?mind)([ ,]+(thanks|thank you|please|cancel|stop))?[ .!]*", re.I)


def _plain(value, limit=120):
    """One line, safe to show and read back from a confirmation block."""
    return re.sub(r'[\s*]+', ' ', str(value)).strip()[:limit]


def _confirm_block(kind, fields):
    lines = [CONFIRM_HEAD.format(kind)] + [f'- {key}: {_plain(value, 400)}' for key, value in fields] + ['', CONFIRM_TAIL]
    return '\n'.join(lines)


def _read_confirm_block(text):
    """(kind, fields) if this whole message is a block from _confirm_block."""
    lines = str(text or '').strip().split('\n')
    kind = next((k for k in CONFIRM_KINDS if lines[0].strip() == CONFIRM_HEAD.format(k)), None)
    if not kind or len(lines) < 4 or lines[-1].strip() != CONFIRM_TAIL or lines[-2].strip():
        return None
    fields = []
    for line in lines[1:-2]:
        m = re.fullmatch(r'- ([A-Za-z0-9 ]+): (.*)', line.strip())
        if not m:
            return None
        fields.append((m.group(1), m.group(2)))
    return kind, fields


def _whole(value):
    """The model sends 10 as 10.0 at times. None if it isn't a whole number."""
    if type(value) is int:
        return value
    if isinstance(value, float) and math.isfinite(value) and value == int(value):
        return int(value)
    if isinstance(value, str) and re.fullmatch(r'[+-]?\d{1,9}', value.strip()):
        return int(value)
    return None


def _number(value):
    if type(value) in (int, float) and math.isfinite(value):
        return value
    try:
        return float(value) if isinstance(value, str) and math.isfinite(float(value)) else None
    except ValueError:
        return None


def _num_text(value):
    return f'{value:g}' if value != int(value) else str(int(value))


_SCHEME_LINE = re.compile(r'(?:(?P<pct>[\d.]+)% off|(?P<flat>[\d.]+) off per unit|buy (?P<buy>\d+) get (?P<free>\d+) free)'
                          r' \| SKU (?P<sku>ALL|SKU-\d{3,}) \| PIN (?P<pin>ALL|[A-Z0-9 -]{2,12})'
                          r' \| (?P<start>\d{4}-\d\d-\d\d) to (?P<end>\d{4}-\d\d-\d\d)')


# What the user has typed must mention each term; a saved draft's own terms
# count when it is being edited. The exact values are then shown to confirm.
_DATE_WORDS = re.compile(r"\d{4}-\d\d|\d{1,2}[/.]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(today|tomorrow|tonight|"
                         r"weekend|diwali|holi|christmas|xmas|new year)\b|\b(next|this|coming|following)\s+(\d+\s+)?(days?|weeks?|months?|quarter|year|"
                         r"mon|tues|wednes|thurs|fri|satur|sun)", re.I)
_ALL_PINS = re.compile(r"\b(all|every|any)\b[^.;]{0,40}\b(pin|pins|pincodes?|postal|postcodes?|zips?|zipcodes?|locations?|areas?|regions?|cities|places)\b"
                       r"|everywhere|nationwide|all[- ](over|india)|pan[- ]india", re.I)
_ALL_SKUS = re.compile(r"\b(all|every|entire|whole)\b[^.;]{0,25}\b(skus?|products?|items?|catalog(ue)?|range)\b|everything|site-?wide|store-?wide", re.I)
_NUMBER_WORDS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten'.split())}


def _said_number(value, text):
    said = {float(n) for n in re.findall(r'\d+(?:\.\d+)?', text)} | {float(_NUMBER_WORDS[w]) for w in re.findall(r'[a-z]+', text) if w in _NUMBER_WORDS}
    return float(value) in said or (float(value) == 50 and 'half' in text)


def _unsaid_terms(scope, mechanic, text, existing):
    """Terms the model sent that the user never mentioned."""
    text, old, ask = text.lower(), (existing or {}).get('scope') or [], []
    for line in scope:
        sku, pin = line['sku'], line['postal_code']
        if not any(o.get('sku') == sku for o in old) and not (
                _ALL_SKUS.search(text) if sku == 'ALL' else re.search(r'sku[- ]?0*' + sku[4:].lstrip('0') + r'\b', text)):
            ask.append('which SKU, or all SKUs')
        if not any(o.get('postal_code') == pin for o in old) and not (
                _ALL_PINS.search(text) if pin == 'ALL' else pin.lower() in text):
            ask.append('which PIN code, or all PIN codes')
        if not any((o.get('start_date'), o.get('end_date')) == (line['start_date'], line['end_date']) for o in old) and not _DATE_WORDS.search(text):
            ask.append('the start and end dates')
        if mechanic == 'Buy X get Y':
            if not any(o.get('buy_quantity') == line['buy_quantity'] and o.get('free_quantity') == line['free_quantity'] for o in old) and not (
                    _said_number(line['buy_quantity'], text) and _said_number(line['free_quantity'], text)):
                ask.append('how many units the customer buys and how many they get free')
        elif not any(o.get('discount') == line['discount'] for o in old) and not _said_number(line['discount'], text):
            ask.append('the discount')
    return ask


def _scheme_draft_block(inputs, claims, request_state):
    """Check a scheme's terms and return the block to confirm, or an error the
    model must turn into a question. Saves nothing."""
    ask = []
    name = _plain(inputs.get('name') or '')
    code = re.sub(r'[^A-Z0-9-]+', '-', _plain(inputs.get('code') or name, 40).upper()).strip('-')
    mechanic = inputs.get('mechanic')
    if not name and not code:
        ask.append('a name for the scheme')
    if mechanic not in ('Percent off', 'Flat amount off', 'Buy X get Y'):
        ask.append('whether it is a percent off, a flat amount off, or buy X get Y')
    scope = inputs.get('scope')
    if not isinstance(scope, list) or not scope:
        ask.append('the SKU (or all SKUs), the PIN code (or all), the dates and the discount')
        scope = []
    if len(scope) > 30:
        return {'error': 'A scheme can have up to 30 lines.'}
    lines, rows, past = [], [], False
    try:
        skus = set((_get_forecast_data() or {}).get('skus', {}))
    except Exception:
        skus = set()
    for line in scope:
        if not isinstance(line, dict):
            return {'error': 'Send each scope line with its SKU, PIN code, dates and discount.'}
        sku, pin = str(line.get('sku') or '').strip().upper(), str(line.get('postal_code') or '').strip().upper()
        if not re.fullmatch(r'ALL|SKU-\d{3,}', sku):
            ask.append('which SKU, or all SKUs')
        elif sku != 'ALL' and skus and sku not in skus:
            return {'error': f'{sku} is not in the forecast. Tell the user, and ask which SKU they mean.'}
        if not re.fullmatch(r'ALL|[A-Z0-9 -]{2,12}', pin):
            ask.append('which PIN code, or all PIN codes')
        try:
            start, end = (dt.date.fromisoformat(str(line.get(key) or '')) for key in ('start_date', 'end_date'))
            if not 0 <= (end - start).days < 364:
                return {'error': 'The end date must be on or after the start date, within 364 days.'}
            past = past or end < dt.date.today()
        except ValueError:
            ask.append('the start and end dates')
            continue
        row = {'sku': sku, 'postal_code': pin, 'start_date': start.isoformat(), 'end_date': end.isoformat()}
        if mechanic == 'Buy X get Y':
            buy, free = _whole(line.get('buy_quantity')), _whole(line.get('free_quantity'))
            if not buy or not free or not (1 <= buy <= 1000000 and 1 <= free <= 1000000) or 100 * free > 99 * (buy + free):
                ask.append('how many units the customer buys and how many they get free')
                continue
            terms = f'buy {buy} get {free} free'
            row.update(buy_quantity=buy, free_quantity=free)
        else:
            value = _number(line.get('discount'))
            if value is None or not 0 < value <= (1000000 if mechanic == 'Flat amount off' else 99):
                ask.append('the discount amount' if mechanic == 'Flat amount off' else 'the discount percentage, up to 99')
                continue
            row['discount'] = value
            terms = f'{_num_text(value)} off per unit' if mechanic == 'Flat amount off' else f'{_num_text(value)}% off'
        rows.append(row)
        lines.append(f"{terms} | SKU {sku} | PIN {pin} | {row['start_date']} to {row['end_date']}")
    need = lambda items: {'error': 'Not saved. Ask the user for: ' + '; '.join(dict.fromkeys(items)) + '. Do not fill these in yourself.'}
    if ask:
        return need(ask)
    status, found = _invoke_scenarios_api('GET', '/scenarios', claims, query={'view': 'schemes'})
    if status != 200 or 'schemes' not in found:
        return {'error': found.get('error', 'Could not load schemes.')}
    if not found.get('can_edit'):
        return {'error': 'Only an admin can save discount schemes.'}
    existing = next((row for row in found['schemes'] if row['code'] == code and row.get('version')), None)
    if existing and existing.get('status') != 'draft':
        return {'error': f"{code} is {existing.get('status')}. Changing it is done on the Discount Schemes page."}
    unsaid = _unsaid_terms(rows, mechanic, request_state.get('user_text', ''), existing)
    if unsaid:
        return need(unsaid)
    fields = [('Scheme ID', code), ('Name', name or code), ('Mechanic', mechanic)]
    fields += [(f'Line {i + 1}', text) for i, text in enumerate(lines)]
    if existing:
        fields.append(('Replaces', f"the saved draft, version {existing['version']}"))
    if past:
        fields.append(('Note', 'some of these dates are already past'))
    request_state['confirm_block'] = _confirm_block('Save draft scheme', fields)
    return {'needs_confirmation': True, 'message': 'Shown to the user to confirm. Not saved. Say nothing more.'}


def _save_confirmed_scheme(fields, claims, request_state):
    known = dict(fields)
    scope = []
    for key, text in fields:
        if not key.startswith('Line '):
            continue
        m = _SCHEME_LINE.fullmatch(text)
        if not m:
            return 'I couldn’t read those terms back, so nothing was saved. Please ask me again.'
        row = {'sku': m['sku'], 'postal_code': m['pin'], 'start_date': m['start'], 'end_date': m['end']}
        if m['buy']:
            row.update(buy_quantity=int(m['buy']), free_quantity=int(m['free']),
                       discount=100 * int(m['free']) / (int(m['buy']) + int(m['free'])))
        else:
            value = float(m['pct'] or m['flat'])
            row['discount'] = int(value) if value == int(value) else value
        scope.append(row)
    version = re.search(r'version (\d+)$', known.get('Replaces', ''))
    body = {'action': 'draft', 'code': known.get('Scheme ID'), 'name': known.get('Name'), 'mechanic': known.get('Mechanic'),
            'scope': scope, 'version': int(version.group(1)) if version else 0}
    status, result = _invoke_scenarios_api('POST', '/scenarios', claims, body, query={'view': 'schemes'})
    if status != 200 or 'scheme' not in result:
        return f"Not saved: {result.get('error', 'the scheme could not be saved.')}"
    request_state['schemes_changed'] = True
    return (f"Saved **{known.get('Scheme ID')}** as a draft. It isn’t applied to any forecast yet. You can use it in Scenarios, "
            'or commit it on the Discount Schemes page.')


# Plainly asked to run: start it. Anything else (questions, "cut prices and
# show me", approvals) is confirmed first.
_RUN_WORDS = re.compile(r'\b(re-?run|run|start|launch|kick off|simulate)\b', re.I)
_NOT_PLAIN = re.compile(r"\?|\b(what|would|should|could|how|why|if|don'?t|do not|never|not|approve|approval|instead of|before|explain)\b"
                        r"|^\s*(can|is|are|will|do|does|did|has|have|which|who|when|where)\b", re.I)


def _plain_run_request(message):
    return bool(_RUN_WORDS.search(message)) and not _NOT_PLAIN.search(message)


_RUN_FIELDS = (('Price change', 'price_pct', '%'), ('Price change SKU', 'price_sku', ''), ('Price change PIN', 'price_postal_code', ''),
               ('Marketing spend change', 'spend_pct', '%'), ('Weekly unit cap', 'unit_cap', ''), ('Spend and cap PIN', 'postal_code', ''))
_RUN_LISTS = (('Saved schemes included', 'included_schemes'), ('Committed schemes left out', 'excluded_schemes'),
              ('Holidays left out', 'excluded_holiday_dates'))


def _run_block(body):
    levers, fields = body.get('levers') or {}, [('Run name', body['label'])]
    for title, key, unit in _RUN_FIELDS:
        if levers.get(key) not in (None, ''):
            fields.append((title, f'{levers[key]:+d}%' if unit else levers[key]))
    if levers.get('holiday_off'):
        fields.append(('Holiday effects', 'off'))
    fields += [(title, ', '.join(levers[key])) for title, key in _RUN_LISTS if levers.get(key)]
    for title, key in (('Known prices', 'known_prices'), ('Weather', 'weather'), ('Calibration', 'calibrate')):
        if body[key] is False:
            fields.append((title, 'off'))
    if body['refresh_days'] != 28:
        fields.append(('Refresh days', body['refresh_days']))
    if len(fields) == 1:
        fields.append(('Changes', 'none, same settings as the approved plan'))
    return _confirm_block('Start scenario run', fields)


def _start_run(body, claims, request_state):
    status, result = _invoke_scenarios_api('POST', '/scenarios', claims, body)
    if status != 202:
        return {'error': result.get('error', 'failed to start the scenario run')}
    request_state['scenarios_changed'] = request_state['run_started'] = True
    return {'started': True, 'scenario_id': result['scenario_id'], 'config': body}


def _start_confirmed_run(fields, claims, request_state):
    known, levers = dict(fields), {}
    for title, key, unit in _RUN_FIELDS:
        if title in known:
            value = known[title]
            levers[key] = int(value.rstrip('%')) if unit or key == 'unit_cap' else value
    if 'price_pct' in levers:
        levers.setdefault('price_sku', '')
        levers.setdefault('price_postal_code', '')
    if known.get('Holiday effects') == 'off':
        levers['holiday_off'] = True
    for title, key in _RUN_LISTS:
        if title in known:
            levers[key] = known[title].split(', ')
    body = {'label': known.get('Run name') or 'Started by Lyra', 'source': 'approved',
            'known_prices': known.get('Known prices') != 'off', 'weather': known.get('Weather') != 'off',
            'calibrate': known.get('Calibration') != 'off', 'refresh_days': int(known.get('Refresh days') or 28)}
    if levers:
        body['levers'] = levers
    result = _start_run(body, claims, request_state)
    if 'error' in result:
        return f"Not started: {result['error']}"
    return f"Started **{body['label']}**. It takes about 3 to 5 minutes; ask me for an update or check the Scenarios page."


def _approve_block(match):
    return _confirm_block('Approve scenario', [
        ('Scenario', match.get('label') or match['id']), ('Scenario ID', match['id']),
        ('Run on', str(match.get('created_at') or '')[:16].replace('T', ' ') + ' UTC'),
        ('WAPE', f"{match.get('wape')}%"), ('Volume error', f"{match.get('volume_error')}%"),
        ('Effect', 'replaces the live forecast on Overview and Forecasts for every user')])


def _approve_by_name(message, claims, request_state):
    """"Approve <scenario name>": find it here rather than leave the model to
    guess a scenario (or start a run instead). None lets the model answer."""
    if not claims.get('email') or not re.match(r'\s*(please\s+|can you\s+|could you\s+)?approve\b', message, re.I):
        return None
    status, response = _invoke_scenarios_api('GET', '/scenarios', claims)
    if status != 200:
        return None
    text = ' '.join(message.casefold().split())
    hits = [s for s in response.get('scenarios', []) if s.get('status') == 'completed'
            and (s['id'] in text or (len(s.get('label') or '') >= 3 and ' '.join(s['label'].casefold().split()) in text))]
    if any(s['id'] in text for s in hits):
        hits = [s for s in hits if s['id'] in text]
    longest = max((len(s.get('label') or '') for s in hits), default=0)
    hits = [s for s in hits if len(s.get('label') or '') == longest]
    if len(hits) > 1:
        return 'More than one run has that name. Which one? Reply "approve" with its ID:\n' + '\n'.join(
            f"- {s.get('label')}, {str(s.get('created_at') or '')[:16].replace('T', ' ')} UTC, {s['id']}" for s in hits[:8])
    if not hits:
        return None
    if hits[0].get('approved'):
        return f"**{_plain(hits[0].get('label'))}** is already the approved plan."
    return _approve_block(hits[0])


def _approve_confirmed(fields, claims, request_state):
    sid = dict(fields).get('Scenario ID') or ''
    if not re.fullmatch(r'scn-\d+-[a-f0-9]+', sid):
        return 'I couldn’t read that scenario back, so nothing was approved. Please ask me again.'
    status, result = _invoke_scenarios_api('POST', f'/scenarios/{sid}/approve', claims)
    if status != 200:
        return f"Not approved: {result.get('error', 'the scenario could not be approved.')}"
    request_state['celebrate'] = request_state['scenarios_changed'] = True
    return f"Approved **{dict(fields).get('Scenario')}**. It is now the live forecast for everyone."


def _answer_confirmation(message, history, claims, request_state):
    """The reply to a yes or no right after a confirmation block, else None."""
    last = history[-1] if history and isinstance(history[-1], dict) else {}
    block = _read_confirm_block(last.get('content')) if last.get('role') == 'assistant' else None
    if not block:
        return None
    if _NO.fullmatch(message):
        return 'OK, nothing was done.'
    if not _YES.fullmatch(message):
        return None
    if not claims.get('email'):
        return 'Sign in first. Nothing was done.'
    kind, fields = block
    act = {'Save draft scheme': _save_confirmed_scheme, 'Start scenario run': _start_confirmed_run,
           'Approve scenario': _approve_confirmed}[kind]
    try:
        return act(fields, claims, request_state)
    except (ValueError, KeyError) as exc:
        print(f'CONFIRM_FAILED: {exc}')
        return 'I couldn’t read that back, so nothing was done. Please ask me again.'


def execute_tool(name, inputs, claims, request_state):
    if name in PLANNING_NAMES:
        return _planning_result(name, inputs, claims)
    if name in ('list_discount_schemes', 'draft_discount_scheme', 'run_scenario') and not claims.get('email'):
        return {'error': 'Sign in to manage discount schemes or run scenarios.'}
    if name == 'list_discount_schemes':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims, query={'view': 'schemes'})
        if status != 200 or 'schemes' not in result:
            return {'error': result.get('error', 'Could not load schemes.')}
        code = str(inputs.get('code') or '').strip().upper()
        fields = ['code', 'name', 'mechanic', 'version', 'status', 'detected']
        if code:
            fields.append('scope')
        rows = [{k: row[k] for k in fields if k in row} for row in result['schemes']
                if not code or row['code'] == code]
        return {'schemes': rows, 'can_edit': result.get('can_edit', False)}

    if name == 'draft_discount_scheme':
        return _scheme_draft_block(inputs, claims, request_state)

    if name == 'run_scenario':
        # The old discount preset ran a pre-staged file built from the
        # platform's original catalog, which doesn't match an org that has
        # onboarded its own data. It is now the price lever on the approved
        # dataset instead: 20% off every product.
        is_discount_demo = bool(inputs.get('discount_scenario'))
        if is_discount_demo and inputs.get('price_pct') is None:
            inputs = {**inputs, 'price_pct': -20}
        body = {
            'label':        inputs.get('label') or ('20% discount — all products' if is_discount_demo else 'Started by Lyra'),
            'known_prices': inputs.get('known_prices', True),
            'weather':      inputs.get('weather', True),
            'calibrate':    inputs.get('calibrate', True),
            'refresh_days': inputs.get('refresh_days', 28),
        }
        # Same default as the Scenarios page: the org's approved (live)
        # dataset, so a Lyra run is comparable with the live forecast.
        body['source'] = 'approved'
        levers = {}
        for key in ('spend_pct', 'price_pct', 'unit_cap'):
            if inputs.get(key) is not None:
                levers[key] = _whole(inputs[key])
                if levers[key] is None:
                    return {'error': f'{key} must be a whole number'}
        for key in ('price_sku', 'price_postal_code', 'postal_code'):
            if inputs.get(key):
                levers[key] = str(inputs[key]).strip().upper()
        if 'price_pct' in levers:
            levers.setdefault('price_sku', '')
            levers.setdefault('price_postal_code', '')
        if inputs.get('holiday_off') is True:
            levers['holiday_off'] = True
        for key in ('included_schemes', 'excluded_schemes', 'excluded_holiday_dates'):
            if inputs.get(key):
                values = inputs[key] if isinstance(inputs[key], list) else [inputs[key]]
                levers[key] = [_plain(v, 80).upper().strip('()[]"\'') for v in values]
        if levers:
            body['levers'] = levers
        body['label'] = _plain(body['label'], 80)
        body['refresh_days'] = _whole(body['refresh_days'])
        if body['refresh_days'] not in (7, 14, 28):
            return {'error': 'refresh_days must be 7, 14 or 28'}
        if request_state.get('run_started'):
            return {'error': 'A run was already started for this message.'}
        if re.search(r'\bapprov', request_state.get('message', ''), re.I) and not _RUN_WORDS.search(request_state.get('message', '')):
            return {'error': 'The user asked about approving, not a new run. Use approve_scenario.'}
        if _plain_run_request(request_state.get('message', '')):
            return _start_run(body, claims, request_state)
        request_state['confirm_block'] = _run_block(body)
        return {'needs_confirmation': True, 'message': 'Shown to the user to confirm. Not started. Say nothing more.'}

    if name == 'get_inventory':
        inv = _get_inventory_data()
        if not inv or not inv.get('months'):
            return {'error': 'no required-inventory data for the current approved forecast'}
        months = inv['months']
        month = (inputs.get('month') or '').strip()[:7]
        i = months.index(month) if month in months else len(months) - 1
        note = None if not month or month in months else f'{month} not available — showing {months[i]}'
        sku = (inputs.get('sku') or '').strip().upper()
        zip_code = (inputs.get('zip') or '').strip()
        params = inv.get('params') or {}
        base = {'month': months[i], 'available_months': f'{months[0]} to {months[-1]}',
                'assumptions': params.get('assumptionsNote'),
                'unavailable': 'on-hand, in-transit and open PO stock are not connected'}
        if note:
            base['note'] = note
        if not sku:
            totals = _inventory_totals(inv, i)
            base['catalog_required'] = round(sum(t['total'] for t in totals.values()))
            base['by_sku'] = {k: round(v['total']) for k, v in sorted(totals.items(), key=lambda kv: -kv[1]['total'])}
            return base
        sd = (inv.get('bySku') or {}).get(sku)
        if not sd:
            return {'error': f'{sku} has no inventory data', 'skus': sorted((inv.get('bySku') or {}).keys())}
        zips = sd.get('byZip') or {}
        if zip_code:
            zd = zips.get(zip_code)
            if not zd:
                return {'error': f'{sku} has no inventory for postal code {zip_code}', 'postal_codes': sorted(zips)}
            pick = lambda k: (zd.get(k) or [None] * (i + 1))[i]
            return {**base, 'sku': sku, 'zip': zip_code, 'required': pick('total'),
                    'cycle_stock': pick('cycleStock'), 'safety_stock': pick('safetyStock'),
                    'avg_daily_demand': pick('add')}
        t = _inventory_totals({'bySku': {sku: sd}}, i)[sku]
        return {**base, 'sku': sku, 'required': round(t['total']), 'cycle_stock': round(t['cycle']),
                'safety_stock': round(t['safety']),
                'by_postal_code': {z: (zd.get('total') or [None] * (i + 1))[i] for z, zd in zips.items()}}

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

    if name == 'open_scenario':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        match, err = _match_scenario(inputs, scenarios, claims)
        if err is not None:
            return err

        # Read-only — nothing to confirm, unlike approve_scenario. handler()
        # picks scenario_id back up from here (only when opened is true) to
        # set open_scenario_id, which js/main.js turns into a real
        # viewScenario(id) call client-side.
        return {'opened': True, 'scenario_id': match['id'], 'label': match.get('label'),
                'status': match.get('status')}

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

        # Never approves here: see "confirmations" above. (A confirm=true flag
        # used to do it, and was honoured even on the model's first call.)
        named = bool(inputs.get('scenario_id') or inputs.get('label'))
        if not named and not re.search(r'\b(latest|last|newest|recent|it|this|that)\b', request_state.get('message', ''), re.I):
            return {'error': 'Ask the user which scenario they want to approve.'}
        request_state['confirm_block'] = _approve_block(match)
        return {'needs_confirmation': True, 'message': 'Shown to the user to confirm. Not approved. Say nothing more.'}

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

    if name == 'detect_anomalies':
        status, result = _invoke_scenarios_api('GET', '/scenarios', claims)
        if status != 200:
            return {'error': result.get('error', 'failed to list scenarios')}
        scenarios = result.get('scenarios', [])

        # No scenario named/specified -> default to the currently APPROVED
        # one (the live forecast everyone's actually looking at) rather
        # than _match_scenario's own default of "my most recent" — "are
        # there any anomalies" with no scenario named almost always means
        # "in what's live right now," not whatever this user last ran.
        if not inputs.get('scenario_id') and not inputs.get('label'):
            approved = next((s for s in scenarios if s.get('approved')), None)
            if not approved:
                return {'message': 'No scenario is currently approved for this organization yet.'}
            match, err = approved, None
        else:
            match, err = _match_scenario(inputs, scenarios, claims)
        if err is not None:
            return err
        if match.get('status') != 'completed':
            return {'error': f'"{match.get("label") or match["id"]}" has no result to check yet '
                              f'— its status is {match.get("status")}.'}

        rstatus, rresult = _invoke_scenarios_api('GET', f"/scenarios/{match['id']}/result", claims)
        if rstatus != 200:
            return {'error': rresult.get('error', "failed to load this scenario's result")}

        anomalies = _detect_anomalies(rresult)
        total = sum(len(v) for v in anomalies.values())
        # Capped the same as the UI card (5-6 per category) — a chat reply
        # listing 30+ rows is worse than useless; the full set is one click
        # away in the scenario's own detail view if genuinely needed.
        return {
            'scenario_id': match['id'], 'label': match.get('label'), 'approved': bool(match.get('approved')),
            'total_anomalies': total,
            'unreliable_skus': anomalies['wape_outliers'][:5],
            'backtest_misses': anomalies['backtest_misses'][:6],
            'forward_forecast_swings': anomalies['forward_swings'][:6],
        }

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
            'holidays_in_week': _week_holidays(week_start),
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
                    obj = s3.get_object(Bucket=BUCKET, Key=f"orgs/{_CURRENT_ORG['id']}/scenarios/{scenario_id}/explain/{sku}.json")
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

        # A compact forecast-line sparkline per SKU — the continuous 'f'
        # series (unlike 'a', it has no null gaps in the forward horizon,
        # so it draws as one clean line covering the whole window) — for
        # the client to render as an inline mini-chart in the chat bubble.
        # Copies rather than mutates the cached _all_sku_rows() dicts,
        # which build_data_summary() and other calls also read.
        data = _get_forecast_data()

        def spark(sku_id):
            f = (data['skus'].get(sku_id) or {}).get('f') or []
            return _downsample([round(x, 1) if x is not None else None for x in f])

        row_a_out = dict(row_a, sparkline=spark(row_a['sku']))
        row_b_out = dict(row_b, sparkline=spark(row_b['sku']))

        return {
            'a': row_a_out, 'b': row_b_out,
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
        weekly_actual, weekly_forecast = [], []
        for i in matched_idx:
            a_val, f_val = series_a[i], series_f[i]
            if a_val is not None:
                actual_sum += a_val
                has_actual = True
            if f_val is not None:
                forecast_sum += f_val
            weekly_actual.append(round(a_val, 1) if a_val is not None else None)
            weekly_forecast.append(round(f_val, 1) if f_val is not None else None)

        weeks_full = [data['weeks'][i] for i in matched_idx]
        return {
            'series': series_label,
            # Downsampled with the exact same call (same length in, same
            # default target) as weekly_actual/weekly_forecast below, so all
            # three arrays pick the identical stride of indices and stay
            # aligned position-for-position. Previously this returned the
            # FULL-length date list next to two DOWNSAMPLED value arrays —
            # for any range over 40 weeks (e.g. "the whole forward horizon")
            # the arrays had different lengths, so both the model and the
            # inline chart it feeds (see 'range_trend' below) would pair a
            # value at index i with the wrong date, silently. That's part of
            # what produced a wrong date+number for a "peakiest week" style
            # question instead of an error.
            'weeks_matched': _downsample(weeks_full),
            'week_count': len(matched_idx),
            'backtest_weeks_included': sum(1 for i in matched_idx if i < bt),
            'forward_weeks_included': sum(1 for i in matched_idx if i >= bt),
            'actual_units': round(actual_sum) if has_actual else None,
            'forecast_units': round(forecast_sum, 1),
            # Per-week breakdown (same _downsample cap as compare_skus'
            # sparkline, though a date-range query rarely spans enough
            # weeks to actually trigger it) — lets the client draw the
            # real weekly trend instead of one aggregate total, which
            # degenerates to a single floating bar whenever the range is
            # forward-only (actual_units is None for any future range,
            # the common case for "next month"/"next quarter" questions).
            'weekly_actual': _downsample(weekly_actual),
            'weekly_forecast': _downsample(weekly_forecast),
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
            # or <response>...</response> tag, and occasionally narrates a
            # tool call as fake inline markup (e.g.
            # <point_to_ui(target="X")>...</point_to_ui>) instead of a real
            # toolUse block — none of these are meant for the end user to see
            # literally, so strip them all. _TOOL_TAG_RE is built from
            # TOOL_CONFIG itself so a newly added tool is covered automatically
            # instead of silently missing here (get_zip_forecast was, once).
            text = re.sub(r'<thinking>.*?</thinking>\s*', '', text, flags=re.DOTALL)
            text = re.sub(r'</?(?:reply|response)>', '', text)
            text = _TOOL_TAG_RE.sub('', text)
            return text.strip()
    return ''


def handler(event, context):
    # A direct async Lambda-to-Lambda invoke from scenarios-api's
    # approve_scenario() (InvocationType='Event', no requestContext at
    # all — same pattern scenario-runner already uses to kick off
    # explain-runner) rather than an HTTP request through API Gateway.
    # Short-circuits before any of the HTTP-path logic below, which
    # assumes a requestContext/body shape this payload doesn't have.
    if event.get('internal_task') == 'generate_insights':
        _generate_insights(event.get('org_id'), event.get('scenario_id'), event.get('scenario_label'))
        return {'ok': True}

    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'POST')
    path   = (event.get('requestContext') or {}).get('http', {}).get('path', '')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    # Knowledge base stays global/shared across every org — it's APRABot's
    # own forecasting methodology reference (also shipped as a static
    # fallback file in this Lambda's own package), not customer data, so no
    # org resolution needed for this route.
    if path == '/knowledge' and method == 'GET':
        return get_knowledge()
    if path == '/knowledge' and method == 'PUT':
        return put_knowledge(event)

    # Every other route is per-org data. Resolved once, first thing, into a
    # module global rather than threaded as a parameter — this file's tool
    # functions are many levels deep and already don't take an org/claims
    # parameter today; a global is what every one of them can see without a
    # much larger refactor, and it's reset at the very top of every single
    # invocation (Lambda runs one invocation at a time per container), so a
    # warm container can never leak a stale org into the next request.
    _CURRENT_ORG['id'] = _org_id(_claims(event).get('email'))

    try:
        body    = json.loads(event.get('body') or '{}')
        message = (body.get('message') or '').strip()
        history = body.get('history') or []
        extra   = (body.get('extra_instructions') or '').strip()
        page    = str(body.get('page') or '').strip()[:40]
        temperature = body.get('temperature')
        max_tokens  = body.get('max_tokens')

        if not message:
            return {'statusCode': 400, 'headers': CORS,
                    'body': json.dumps({'error': 'message required'})}

        request_state = {'message': message,  # per request; never shared
                         'user_text': ' . '.join([str(h.get('content') or '') for h in history[-8:]
                                                  if isinstance(h, dict) and h.get('role') == 'user'] + [message])}
        confirmed = _answer_confirmation(message, history, _claims(event), request_state)
        if confirmed is None:
            confirmed = _approve_by_name(message, _claims(event), request_state)
        if confirmed is not None:
            return {
                'statusCode': 200,
                'headers':    {**CORS, 'Content-Type': 'application/json'},
                'body':       json.dumps({'reply': confirmed, 'point_to': None, 'generate_report': False,
                                          'open_scenario_id': None, 'celebrate': bool(request_state.get('celebrate')),
                                          'chart': None, 'annotate': None,
                                          'schemes_changed': bool(request_state.get('schemes_changed')),
                                          'scenarios_changed': bool(request_state.get('scenarios_changed'))}),
            }

        data_cache_key = f"data:{_CURRENT_ORG['id']}"
        if data_cache_key not in _cache:
            _cache[data_cache_key] = build_data_summary()

        # RAG retrieval (top KNOWLEDGE_TOP_K relevant sections, not the whole
        # KB file) — see retrieve_knowledge()'s own docstring.
        system = SYSTEM_TMPL.format(knowledge=retrieve_knowledge(message), data=_cache[data_cache_key])
        if page in NAV_TARGETS:
            system += f"\n\nUSER'S CURRENT PAGE: {page}"
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
        open_scenario_id = None
        celebrate = False
        chart = None
        annotate = None
        reply = ''
        tool_results = {}  # (name, sorted-inputs) already executed this request
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
                    if call_sig in tool_results:
                        repeated_call = True
                        result = tool_results[call_sig]
                    else:
                        result = execute_tool(tu['name'], inputs, claims, request_state)
                        tool_results[call_sig] = result
                    if tu['name'] == 'open_scenario' and result.get('opened'):
                        open_scenario_id = result['scenario_id']
                    if tu['name'] == 'compare_skus' and result.get('a') and result.get('b'):
                        chart = {
                            'type': 'sku_compare',
                            'a': {'sku': result['a']['sku'], 'series': result['a'].get('sparkline') or []},
                            'b': {'sku': result['b']['sku'], 'series': result['b'].get('sparkline') or []},
                        }
                    if tu['name'] == 'get_forecast_range' and 'error' not in result:
                        chart = {
                            'type': 'range_trend',
                            'series': result.get('series'),
                            'weeks': result.get('weeks_matched') or [],
                            'actual': result.get('weekly_actual') or [],
                            'forecast': result.get('weekly_forecast') or [],
                        }
                    if tu['name'] == 'explain_forecast_day' and 'error' not in result:
                        # None sku means the currently-selected series should
                        # switch to the all-SKU aggregate — series is
                        # 'all SKUs' in that case, a real SKU id otherwise.
                        annotate = {
                            'sku': result.get('series') if result.get('series') != 'all SKUs' else None,
                            'week_of': result.get('week_of'),
                            'label': _annotation_label(result),
                        }
                    model_result = result
                    if tu['name'] == 'compare_skus':
                        # The sparkline feeds the inline chart; the model was
                        # pasting the raw number array into its reply.
                        model_result = {k: ({kk: vv for kk, vv in v.items() if kk != 'sparkline'}
                                            if isinstance(v, dict) else v) for k, v in result.items()}
                    if tu['name'] == 'point_to_ui' and inputs.get('target') == page:
                        model_result = {'skipped': 'The user is already on this page. Answer their '
                                                   'question in plain text instead.'}
                    tool_result_blocks.append({'toolResult': {
                        'toolUseId': tu['toolUseId'],
                        'content': [{'json': model_result}],
                    }})
            messages.append({'role': 'user', 'content': tool_result_blocks})

            if request_state.get('confirm_block'):
                break  # the block is the whole reply; nothing more to say or call
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

        # A more specific action already shown/navigated directly beats a
        # mere nav highlight — suppress point_to_ui's effect whenever one of
        # these fired, regardless of whether the model ALSO called
        # point_to_ui. It sometimes still does despite being told not to in
        # the system prompt (observed: flaky, not every call — chart was the
        # same story, caught in the same round of testing as this comment)
        # — the same "enforce it in code, not just the prompt" lesson
        # approve_scenario's confirm gate already needed. A prompt
        # instruction shapes behavior and avoids the wasted extra tool
        # round-trip most of the time, but isn't a guarantee, so this is the
        # actual guarantee.
        if annotate or trigger_report or open_scenario_id or chart:
            point_to = None
        if point_to and point_to == page:
            point_to = None  # they're already on it
        if request_state.get('confirm_block'):
            reply, point_to = request_state['confirm_block'], None
        elif _read_confirm_block(reply):
            reply = 'Nothing has been done. What would you like me to do?'  # only code may write a block

        # No text means the user would get a canned "Done!" / "I've
        # highlighted it" instead of an answer (seen live: a "how do I…"
        # question answered with only a sidebar highlight). Ask once more
        # for a plain-text answer before falling back — except after opening
        # a scenario or the report, where the canned line is the answer.
        if not reply and not (open_scenario_id or trigger_report):
            try:
                messages.append({'role': 'user', 'content': [
                    {'text': "Please answer my previous message in plain text now, without calling any tools."}]})
                resp3 = bedrock.converse(
                    modelId=MODEL, system=[{'text': system}], messages=messages,
                    inferenceConfig=inference_config, toolConfig=TOOL_CONFIG,
                )
                if resp3.get('stopReason') != 'tool_use':
                    reply = _text_of(resp3['output']['message'])
            except Exception as exc:
                print(f"CHAT_RETRY_FAILED: {exc}")
            if not reply:
                reply = "Sorry — I couldn't put an answer together for that. Could you rephrase it?"

        if not reply:
            reply = ("I've opened it for you." if open_scenario_id
                      else "I've generated your downloadable report — it should open in a new tab, or "
                      "download directly if your browser blocks the pop-up." if trigger_report
                      else "Done — I've highlighted it in the sidebar for you." if point_to
                      else "Done!")

        return {
            'statusCode': 200,
            'headers':    {**CORS, 'Content-Type': 'application/json'},
            'body':       json.dumps({'reply': reply, 'point_to': point_to, 'generate_report': trigger_report,
                                       'open_scenario_id': open_scenario_id, 'celebrate': celebrate, 'chart': chart,
                                       'annotate': annotate, 'schemes_changed': bool(request_state.get('schemes_changed')),
                                       'scenarios_changed': bool(request_state.get('scenarios_changed'))}),
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
