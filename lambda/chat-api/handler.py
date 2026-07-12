import json
import boto3
import os

BEDROCK_REGION = os.environ.get('BEDROCK_REGION', 'us-west-2')
bedrock = boto3.client('bedrock-runtime', region_name=BEDROCK_REGION)
s3     = boto3.client('s3')

BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY    = os.environ.get('FORECAST_KEY', 'forecast/latest.json')
MODEL  = os.environ.get('MODEL_ID',    'amazon.nova-lite-v1:0')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}

_cache = {}   # simple in-process cache across warm invocations

def build_data_summary():
    obj  = s3.get_object(Bucket=BUCKET, Key=KEY)
    data = json.loads(obj['Body'].read().decode('utf-8'))

    rows = []
    for sku, d in data['skus'].items():
        vol = sum(a for a in d['a'] if a)
        num = sum(abs(a - f) for a, f in zip(d['a'], d['f']) if a)
        den = sum(a for a in d['a'] if a)
        wape = round(100 * num / den, 2) if den else 0
        rows.append({'sku': sku, 'vol': vol, 'wape': wape, 'acc': round(100 - wape, 1)})
    rows.sort(key=lambda x: -x['vol'])

    tot_a = sum(data['all']['a'])
    tot_f = sum(data['all']['f'])
    bias  = round(100 * (tot_f - tot_a) / tot_a, 2) if tot_a else 0

    lines = [
        "=== 2024 WEEKLY FORECAST BACKTEST ===",
        f"Period : {data['weeks'][0]}  →  {data['weeks'][-1]}  ({len(data['weeks'])} weeks, 1-week-ahead)",
        f"Overall WAPE : {data['overallWape']}%   (lower is better)",
        f"Actual units : {tot_a:,}  |  Forecast units : {tot_f:,}  |  Bias : {'+' if bias>=0 else ''}{bias}%",
        f"SKUs forecasted : {len(rows)}",
        "",
        "--- SKU DETAIL (volume-sorted) ---",
    ]
    for r in rows:
        lines.append(f"  {r['sku']:20s}  vol={r['vol']:>9,}  WAPE={r['wape']:.1f}%  acc={r['acc']:.1f}%")

    worst_wk = max(range(len(data['all']['w'])), key=lambda i: data['all']['w'][i])
    best_wk  = min(range(len(data['all']['w'])), key=lambda i: data['all']['w'][i])
    lines += [
        "",
        f"Worst week : {data['weeks'][worst_wk]}  WAPE={data['all']['w'][worst_wk]:.1f}%",
        f"Best week  : {data['weeks'][best_wk]}   WAPE={data['all']['w'][best_wk]:.1f}%",
        "",
        "Weekly aggregate WAPE (each entry = one week):",
        "  " + "  ".join(f"{w:.1f}%" for w in data['all']['w']),
    ]
    return "\n".join(lines)


SYSTEM_TMPL = """\
You are **Lyra**, an AI demand analyst inside APRABot.
Answer questions about the 2024 forecast backtest below. Be concise and precise.

Rules:
• Use **bold** for key numbers (e.g. **2.81% WAPE**).
• Default reply length: 2–4 sentences. Expand only if the user asks for details.
• If a SKU is not in the data, say so.
• Never fabricate numbers. Only quote figures that appear in the data below.

{data}
"""

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

        resp   = bedrock.invoke_model(
            modelId=MODEL,
            body=json.dumps({
                'system':          [{'text': system}],
                'messages':        messages,
                'inferenceConfig': {'maxTokens': toks, 'temperature': temp},
            }),
            contentType='application/json',
            accept='application/json',
        )
        result = json.loads(resp['body'].read())
        reply  = result['output']['message']['content'][0]['text']

        return {
            'statusCode': 200,
            'headers':    {**CORS, 'Content-Type': 'application/json'},
            'body':       json.dumps({'reply': reply}),
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
