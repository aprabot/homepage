"""OAuth connect/disconnect flow for Amplify's Meta + Google Ads integrations.

STATUS (see the Amplify plan, Milestone 0/1): `status` and `disconnect` are
fully functional against DynamoDB. `start`/`callback` are structurally
complete (state-nonce round-trip, org correlation, the one place in this
whole app where org identity can't come from a JWT — see the comment on
`callback` for why) but return a clear 501 until real Meta/Google app
credentials exist (env vars below) — there is nothing to connect to yet.
Swapping in real credentials + the real token-exchange HTTP calls is
Milestone 1/2 work, gated on each platform's own app-review timeline, not
an engineering blocker.
"""
import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import boto3

s3  = boto3.client('s3')
ddb = boto3.resource('dynamodb')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
TABLE_NAME = os.environ.get('TABLE_NAME', 'aprabot-amplify')
table = ddb.Table(TABLE_NAME)

AMPLIFY_BASE_URL = os.environ.get('AMPLIFY_BASE_URL', 'https://aprabot.com/amplify/')
OAUTH_API_BASE = os.environ.get('OAUTH_API_BASE', 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-oauth')

# Real app credentials — unset until each platform's app review/registration
# is actually done (Milestone 1/2). Deliberately checked at request time,
# not import time, so this Lambda deploys and serves /status fine today.
PLATFORM_CONFIG = {
    'meta': {
        'client_id_env': 'META_APP_ID',
        'authorize_url': 'https://www.facebook.com/v21.0/dialog/oauth',
        'scope': 'ads_management',
    },
    'google': {
        'client_id_env': 'GOOGLE_OAUTH_CLIENT_ID',
        'authorize_url': 'https://accounts.google.com/o/oauth2/v2/auth',
        'scope': 'https://www.googleapis.com/auth/adwords',
    },
}

# ---- organization scoping — identical copy to scenarios-api/handler.py's. ----
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


def _redirect(url):
    return {'statusCode': 302, 'headers': {**CORS, 'Location': url}, 'body': ''}


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


def _conn_item(org, platform):
    resp = table.get_item(Key={'pk': f'ORG#{org}', 'sk': f'CONN#{platform}'})
    return resp.get('Item')


def status(org):
    out = {}
    for platform in PLATFORM_CONFIG:
        item = _conn_item(org, platform)
        if item is None:
            out[platform] = {'status': 'not_connected'}
        else:
            out[platform] = {
                'status': item.get('status'),
                'external_account_id': item.get('external_account_id'),
                'connected_by': item.get('connected_by'),
                'connected_at': item.get('connected_at'),
            }
    return _resp(200, out)


def start(platform, org, caller_email):
    if platform not in PLATFORM_CONFIG:
        return _resp(404, {'error': f'unknown platform {platform}'})
    cfg = PLATFORM_CONFIG[platform]
    client_id = os.environ.get(cfg['client_id_env'])
    if not client_id:
        # This is the expected state until that platform's app review/
        # registration is actually complete — not a bug. The frontend's
        # Connect Accounts panel should show this platform as "pending"
        # rather than attempting a connection that can't possibly succeed.
        return _resp(501, {'error': f'{platform} integration is not yet configured '
                                      f'(pending app review) — nothing to connect to yet'})

    # Opaque state nonce, TTL'd in DynamoDB, correlates the callback back to
    # this org — the callback request itself carries no JWT (Meta/Google
    # redirect the browser here with no Authorization header of ours), so
    # this round-trip is the ONLY place in this app where org identity
    # doesn't come directly from a JWT claim. See handler()'s callback route.
    state = secrets.token_urlsafe(24)
    table.put_item(Item={
        'pk': f'OAUTH_STATE#{state}', 'sk': 'STATE',
        'entity_type': 'oauth_state',
        'org_id': org, 'platform': platform, 'initiated_by': caller_email,
        'created_at': _now(),
        'ttl': int(time.time()) + 600,  # 10 minutes to complete the redirect round-trip
    })

    params = {
        'client_id': client_id,
        'redirect_uri': f'{OAUTH_API_BASE}/{platform}/callback',
        'scope': cfg['scope'],
        'state': state,
        'response_type': 'code',
    }
    return _resp(200, {'authorize_url': f"{cfg['authorize_url']}?{urlencode(params)}"})


def callback(platform, event):
    qs = event.get('queryStringParameters') or {}
    state = qs.get('state')
    code = qs.get('code')
    error = qs.get('error')

    state_item = table.get_item(Key={'pk': f'OAUTH_STATE#{state}', 'sk': 'STATE'}).get('Item') if state else None
    if state_item is None:
        return _redirect(f'{AMPLIFY_BASE_URL}?error=invalid_or_expired_state')
    org = state_item['org_id']
    table.delete_item(Key={'pk': f'OAUTH_STATE#{state}', 'sk': 'STATE'})  # single-use

    if error or not code:
        return _redirect(f'{AMPLIFY_BASE_URL}?error={error or "no_code_returned"}')

    # Real token exchange is Milestone 1/2 work — needs that platform's real
    # client secret (Secrets Manager, not yet provisioned — see the
    # Amplify plan) and, for Meta specifically, the System User token setup
    # described there rather than just the short-lived code exchange below.
    # Structurally this is where it goes:
    #   access_token, refresh_token = _exchange_code_for_token(platform, code)
    #   secret_arn = _store_refresh_token(org, platform, refresh_token)
    #   table.put_item(Item={'pk': f'ORG#{org}', 'sk': f'CONN#{platform}', ...,
    #                        'status': 'connected', 'token_ref': secret_arn})
    return _redirect(f'{AMPLIFY_BASE_URL}?error={platform}_not_yet_configured')


def disconnect(platform, org, caller_email):
    item = _conn_item(org, platform)
    if item is None:
        return _resp(404, {'error': 'not connected'})
    # Soft-revoke — keep the item (and its history) rather than deleting it,
    # same "audit trail over hard delete" instinct as scenario approvals.
    item['status'] = 'revoked'
    item['revoked_by'] = caller_email
    item['revoked_at'] = _now()
    table.put_item(Item=item)
    return _resp(200, {'platform': platform, 'status': 'revoked'})


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path   = event.get('requestContext', {}).get('http', {}).get('path', '')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        # The callback route is the one exception to "org always comes from
        # the JWT" — handled before touching _claims()/_org_id() at all.
        if method == 'GET' and path.endswith('/callback'):
            platform = path.split('/')[-2]
            return callback(platform, event)

        caller_email = _claims(event).get('email')
        org = _org_id(caller_email)

        if method == 'GET' and path == '/amplify-oauth/status':
            return status(org)

        if method == 'GET' and path.endswith('/start'):
            platform = path.split('/')[-2]
            return start(platform, org, caller_email)

        if method == 'POST' and path.endswith('/disconnect'):
            platform = path.split('/')[-2]
            return disconnect(platform, org, caller_email)

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
