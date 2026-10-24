import hashlib
import json
import boto3
import os

s3 = boto3.client('s3')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
FORECAST_KEY   = os.environ.get('FORECAST_KEY', 'forecast/latest.json')
# Companion object scenario-runner writes alongside a scenario's own
# result.json (see lambda/scenario-runner/handler.py's
# compute_monthly_inventory()), copied to this key by approve_scenario()
# the same way result.json -> forecast/latest.json already works. Served
# from this same Lambda/route via ?type=inventory rather than a new API
# Gateway route — GET /forecast already exists and query strings reach a
# Lambda proxy integration regardless of the route's own path pattern, so
# this needed no infra change, just this handler reading the query param.
INVENTORY_KEY = os.environ.get('FORECAST_INVENTORY_KEY', 'forecast/latest_inventory.json')

# ---- organization scoping ---------------------------------------------
# Every org-aware Lambda (this one, insights-api, scenarios-api, chat-api)
# carries its own copy of this — these are small, independently zip-deployed
# functions with no shared layer, matching how this repo already does it.
# A corporate email domain IS the org id (any @sagarorg.com user lands in
# org "sagarorg.com" automatically, no setup). Free webmail domains CANNOT
# be used directly as an org id — two strangers who both happen to use
# Gmail must never land in the same org just because they share a mail
# provider. _INTERNAL_EMAILS is the one explicit exception: APRABot's own
# team currently signs in with personal Gmail addresses with no domain to
# group them by, so they're named here instead and share "aprabot-internal".
# Anyone else on a free-webmail domain not in that list gets a private,
# single-person org (safe default — isolated, never silently merged).
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

    org = _org_id(_claims(event).get('email'))
    qs = event.get('queryStringParameters') or {}
    is_inventory = (qs.get('type') == 'inventory')
    key = f'orgs/{org}/' + (INVENTORY_KEY if is_inventory else FORECAST_KEY)

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
        if not_found:
            # Same "not found" gotcha, hit on the base forecast too — and a
            # now-common real state since org-scoping landed: a brand new
            # organization that's signed in but hasn't approved its first
            # scenario yet has genuinely nothing at this key. Clean 404 so
            # the dashboard can show a "no forecast yet — run and approve a
            # scenario to get started" empty state instead of an error.
            return {'statusCode': 404, 'headers': {**CORS, 'Content-Type': 'application/json'},
                    'body': json.dumps({'error': 'no approved forecast yet for this organization'})}
        return {
            'statusCode': 500,
            'headers': CORS,
            'body': json.dumps({'error': str(e)}),
        }
