import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3

s3     = boto3.client('s3')
lam    = boto3.client('lambda')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
RUNNER = os.environ.get('RUNNER_FUNCTION', 'aprabot-scenario-runner')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _resp(status, body):
    return {'statusCode': status, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps(body)}


def _read_json(key, default=None):
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        return json.loads(obj['Body'].read().decode('utf-8'))
    except s3.exceptions.NoSuchKey:
        return default
    except s3.exceptions.ClientError:
        return default


def _write_json(key, data):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(data).encode('utf-8'),
                   ContentType='application/json')


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


def list_scenarios():
    idx = _read_json('scenarios/index.json', default={'scenarios': []})
    scenarios = sorted(idx['scenarios'], key=lambda s: s.get('created_at', ''), reverse=True)
    return _resp(200, {'scenarios': scenarios})


ALLOWED_UPLOAD_EXT = {'.xlsx', '.tsv', '.csv', '.txt'}


def create_upload_url(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    filename = (body.get('filename') or '').strip()
    ext = os.path.splitext(filename)[1].lower()
    if not filename or ext not in ALLOWED_UPLOAD_EXT:
        return _resp(400, {'error': f'filename must end in one of {sorted(ALLOWED_UPLOAD_EXT)}'})

    safe_name = re.sub(r'[^A-Za-z0-9_.-]', '_', filename)[:120]
    key = f"uploads/{uuid.uuid4().hex}/{safe_name}"

    content_type = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }.get(ext, 'text/tab-separated-values')

    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': BUCKET, 'Key': key, 'ContentType': content_type},
        ExpiresIn=300,
    )
    return _resp(200, {'upload_url': url, 'key': key, 'content_type': content_type})


def create_scenario(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    label            = (body.get('label') or 'Untitled scenario').strip()[:80]
    known_prices     = bool(body.get('known_prices', True))
    calibrate        = bool(body.get('calibrate', True))
    weather          = bool(body.get('weather', True))
    refresh_days     = int(body.get('refresh_days', 28))
    if refresh_days not in (7, 14, 28):
        refresh_days = 28

    custom_input_key = (body.get('custom_input_key') or '').strip()
    if custom_input_key and not custom_input_key.startswith('uploads/'):
        return _resp(400, {'error': 'invalid custom_input_key'})

    scenario_id = f"scn-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    email = _claims(event).get('email', 'planner')

    config = {
        'id': scenario_id, 'label': label, 'status': 'running',
        'known_prices': known_prices, 'calibrate': calibrate,
        'weather': weather, 'refresh_days': refresh_days,
        'custom_input': bool(custom_input_key),
        'requested_by': email, 'created_at': _now(), 'approved': False,
    }
    if custom_input_key:
        config['custom_input_key'] = custom_input_key
    _write_json(f'scenarios/{scenario_id}/config.json', config)

    idx = _read_json('scenarios/index.json', default={'scenarios': []})
    idx['scenarios'].append({k: config[k] for k in
                              ('id', 'label', 'status', 'known_prices', 'calibrate',
                               'weather', 'refresh_days', 'custom_input',
                               'requested_by', 'created_at', 'approved')})
    _write_json('scenarios/index.json', idx)

    runner_payload = {
        'scenario_id': scenario_id, 'label': label,
        'known_prices': known_prices, 'calibrate': calibrate,
        'weather': weather, 'refresh_days': refresh_days,
    }
    if custom_input_key:
        runner_payload['custom_input_key'] = custom_input_key

    lam.invoke(FunctionName=RUNNER, InvocationType='Event',
               Payload=json.dumps(runner_payload).encode('utf-8'))

    return _resp(202, {'scenario_id': scenario_id, 'status': 'running'})


def get_result(scenario_id):
    result = _read_json(f'scenarios/{scenario_id}/result.json')
    if result is None:
        return _resp(404, {'error': 'result not found (scenario may still be running or failed)'})
    return _resp(200, result)


def approve_scenario(scenario_id):
    result = _read_json(f'scenarios/{scenario_id}/result.json')
    if result is None:
        return _resp(404, {'error': 'no completed result for this scenario'})

    _write_json('forecast/latest.json', result)

    idx = _read_json('scenarios/index.json', default={'scenarios': []})
    for s in idx['scenarios']:
        s['approved'] = (s['id'] == scenario_id)
    _write_json('scenarios/index.json', idx)

    config = _read_json(f'scenarios/{scenario_id}/config.json', default={})
    config['approved'] = True
    _write_json(f'scenarios/{scenario_id}/config.json', config)

    return _resp(200, {'approved': scenario_id})


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path   = event.get('requestContext', {}).get('http', {}).get('path', '')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        m = re.match(r'^/scenarios/([^/]+)/approve$', path)
        if method == 'POST' and m:
            return approve_scenario(m.group(1))

        m = re.match(r'^/scenarios/([^/]+)/result$', path)
        if method == 'GET' and m:
            return get_result(m.group(1))

        if method == 'GET' and path == '/scenarios':
            return list_scenarios()

        if method == 'POST' and path == '/scenarios':
            return create_scenario(event)

        if method == 'POST' and path == '/scenarios/upload-url':
            return create_upload_url(event)

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
