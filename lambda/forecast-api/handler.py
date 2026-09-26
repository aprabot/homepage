import json
import boto3
import os

s3 = boto3.client('s3')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
KEY    = os.environ.get('FORECAST_KEY', 'forecast/latest.json')
# Companion object scenario-runner writes alongside a scenario's own
# result.json (see lambda/scenario-runner/handler.py's
# compute_monthly_inventory()), copied to this key by approve_scenario()
# the same way result.json -> forecast/latest.json already works. Served
# from this same Lambda/route via ?type=inventory rather than a new API
# Gateway route — GET /forecast already exists and query strings reach a
# Lambda proxy integration regardless of the route's own path pattern, so
# this needed no infra change, just this handler reading the query param.
INVENTORY_KEY = os.environ.get('FORECAST_INVENTORY_KEY', 'forecast/latest_inventory.json')

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
}

def handler(event, context):
    method = (event.get('requestContext') or {}).get('http', {}).get('method', 'GET')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    qs = event.get('queryStringParameters') or {}
    is_inventory = (qs.get('type') == 'inventory')
    key = INVENTORY_KEY if is_inventory else KEY

    try:
        obj  = s3.get_object(Bucket=BUCKET, Key=key)
        body = obj['Body'].read().decode('utf-8')
        return {
            'statusCode': 200,
            # Was max-age=3600 — meant an approved scenario could take up to
            # an hour to show up for anyone whose browser had already cached
            # a GET /forecast response, regardless of the dashboard's own
            # 5-minute localStorage cache being cleared on approval. 60s
            # still meaningfully cuts down on repeat requests without that
            # long a stale window.
            'headers': {**CORS, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60'},
            'body': body,
        }
    except Exception as e:
        # A GetObject on a key that doesn't exist yet returns AccessDenied
        # (error code AccessDenied/403), not NoSuchKey, when this role lacks
        # s3:ListBucket on the bucket — S3 masks "not found" as "denied"
        # rather than leak object existence to a caller who can't list.
        # Confirmed live 2026-09-26 hitting ?type=inventory before any
        # scenario had ever written forecast/latest_inventory.json — same
        # gotcha already documented in lambda/chat-api/README.md's
        # Knowledge Base section. Treat that (or a genuine NoSuchKey) as
        # "not found", every other error as a real failure.
        code = getattr(e, 'response', {}).get('Error', {}).get('Code') if hasattr(e, 'response') else None
        not_found = code in ('NoSuchKey', 'AccessDenied', '403')

        if is_inventory and not_found:
            # A real, expected state — not every approved scenario has
            # inventory data yet (older scenarios predate this feature, or
            # its best-effort computation failed on that run). Distinct
            # 404 so the dashboard can show a clean "not available for the
            # current approved forecast yet" message instead of an error.
            return {'statusCode': 404, 'headers': {**CORS, 'Content-Type': 'application/json'},
                    'body': json.dumps({'error': 'no inventory data for the current approved forecast yet'})}
        return {
            'statusCode': 500,
            'headers': CORS,
            'body': json.dumps({'error': str(e)}),
        }
