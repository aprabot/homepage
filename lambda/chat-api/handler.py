import json
import re
import boto3
import os

BEDROCK_REGION = os.environ.get('BEDROCK_REGION', 'us-west-2')
bedrock = boto3.client('bedrock-runtime', region_name=BEDROCK_REGION)
s3      = boto3.client('s3')
lam     = boto3.client('lambda')

BUCKET         = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY            = os.environ.get('FORECAST_KEY', 'forecast/latest.json')
MODEL          = os.environ.get('MODEL_ID',    'amazon.nova-lite-v1:0')
SCENARIOS_API_FUNCTION = os.environ.get('SCENARIOS_API_FUNCTION', 'aprabot-scenarios-api')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}

_cache = {}   # simple in-process cache across warm invocations

def build_data_summary():
    obj  = s3.get_object(Bucket=BUCKET, Key=KEY)
    data = json.loads(obj['Body'].read().decode('utf-8'))

    # backtestWeeks marks where real actuals end and the forward-only
    # forecast begins; older cached results may not have the field.
    bt = data.get('backtestWeeks', len(data['weeks']))

    rows = []
    for sku, d in data['skus'].items():
        vol = sum(a for a in d['a'] if a is not None)
        num = sum(abs(a - f) for a, f in zip(d['a'], d['f']) if a is not None)
        wape = round(100 * num / vol, 2) if vol else 0
        fwd = sum(f for f in d['f'][bt:] if f is not None)
        rows.append({'sku': sku, 'vol': vol, 'wape': wape, 'acc': round(100 - wape, 1), 'fwd': fwd})
    rows.sort(key=lambda x: -x['vol'])

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
        "--- SKU DETAIL (volume-sorted; vol/WAPE/acc are backtest-only, forward_fcst is the forecast beyond the backtest) ---",
    ]
    for r in rows:
        lines.append(f"  {r['sku']:20s}  vol={r['vol']:>9,}  WAPE={r['wape']:.1f}%  acc={r['acc']:.1f}%  forward_fcst={r['fwd']:>8,}")

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
• You can actually start a new forecast pipeline run using the run_scenario tool, and check on a
  run's progress with check_scenario_status. Use run_scenario when the user asks you to run, start,
  or kick off a new forecast/scenario. A run takes ~3-5 minutes — tell the user that, and mention
  they can ask you for a status update or check the Scenarios tab. Only the settings the user
  specifies should differ from the defaults (known_prices=true, weather=true, calibrate=true,
  refresh_days=28) — don't ask clarifying questions for settings they didn't mention, just use
  the defaults and say so in your reply.
• Whenever your answer tells the user where to go or what to click in the dashboard, also call the
  point_to_ui tool with the relevant nav item, in addition to writing your normal text reply — do
  not use it instead of a reply.

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
            # Nova sometimes emits a <thinking>...</thinking> preamble inline
            # in the text block rather than as separate reasoning content —
            # strip it, it's not meant for the end user.
            return re.sub(r'<thinking>.*?</thinking>\s*', '', block['text'], flags=re.DOTALL).strip()
    return ''


def handler(event, context):
    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'POST')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

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

        system = SYSTEM_TMPL.format(data=_cache['data'])
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

        resp = bedrock.converse(
            modelId=MODEL, system=[{'text': system}], messages=messages,
            inferenceConfig=inference_config, toolConfig=TOOL_CONFIG,
        )
        output_message = resp['output']['message']
        point_to = None

        if resp.get('stopReason') == 'tool_use':
            messages.append(output_message)
            tool_result_blocks = []
            for block in output_message.get('content', []):
                if 'toolUse' in block:
                    tu = block['toolUse']
                    inputs = tu.get('input') or {}
                    if tu['name'] == 'point_to_ui':
                        target = inputs.get('target')
                        if target in NAV_TARGETS:
                            point_to = target
                    result = execute_tool(tu['name'], inputs, claims)
                    tool_result_blocks.append({'toolResult': {
                        'toolUseId': tu['toolUseId'],
                        'content': [{'json': result}],
                    }})
            messages.append({'role': 'user', 'content': tool_result_blocks})

            resp2 = bedrock.converse(
                modelId=MODEL, system=[{'text': system}], messages=messages,
                inferenceConfig=inference_config, toolConfig=TOOL_CONFIG,
            )
            reply = _text_of(resp2['output']['message'])
        else:
            reply = _text_of(output_message)

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
