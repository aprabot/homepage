import hashlib
import json
import boto3
import os

s3 = boto3.client('s3')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY    = os.environ.get('INSIGHTS_KEY', 'insights/latest.json')

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


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
}

def handler(event, context):
    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'GET')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}
    try:
        org = _org_id(_claims(event).get('email'))
        obj  = s3.get_object(Bucket=BUCKET, Key=f'orgs/{org}/{KEY}')
        body = obj['Body'].read().decode('utf-8')
        return {
            'statusCode': 200,
            # Same fix as forecast-api's: a full hour meant a regenerated
            # insight could stay invisible to anyone with an already-cached
            # response for that long.
            'headers': {**CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60'},
            'body': body,
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': CORS,
            'body': json.dumps({'error': str(e)}),
        }
