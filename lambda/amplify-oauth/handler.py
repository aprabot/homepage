"""OAuth connect/disconnect flow for Amplify's Meta + Google Ads integrations,
plus Shopify — connected not as an ad platform but as a real product-catalog/
inventory data source for the Products panel (see amplify-campaigns' README).

STATUS (see the Amplify plan, Milestone 0/1): `status` and `disconnect` are
fully functional against DynamoDB. `start`/`callback` are structurally
complete (state-nonce round-trip, org correlation, the one place in this
whole app where org identity can't come from a JWT — see the comment on
`callback` for why) but return a clear 501 until real Meta/Google/Shopify app
credentials exist (env vars below) — there is nothing to connect to yet.
Swapping in real credentials + the real token-exchange HTTP calls is
Milestone 1/2 work, gated on each platform's own app-review timeline, not
an engineering blocker.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlencode

import boto3

s3  = boto3.client('s3')
ddb = boto3.resource('dynamodb')
secretsmanager = boto3.client('secretsmanager')
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
        'client_secret_name': 'amplify/meta/client_secret',
        'authorize_url': 'https://www.facebook.com/v21.0/dialog/oauth',
        'token_url': 'https://graph.facebook.com/v21.0/oauth/access_token',
        'scope': 'ads_management',
        'extra_auth_params': {},
        # Meta's token exchange returns {"access_token": ...} — there is no
        # refresh_token field in this flow at all. token_field says which
        # key in the token-exchange response callback() should store.
        'token_field': 'access_token',
    },
    'google': {
        'client_id_env': 'GOOGLE_OAUTH_CLIENT_ID',
        'client_secret_name': 'amplify/google/client_secret',
        'authorize_url': 'https://accounts.google.com/o/oauth2/v2/auth',
        'token_url': 'https://oauth2.googleapis.com/token',
        'scope': 'https://www.googleapis.com/auth/adwords',
        # access_type=offline is what makes Google return a refresh_token at
        # all; prompt=consent forces the consent screen (and therefore a
        # fresh refresh_token) even on a repeat connect — without it, Google
        # silently skips re-issuing one on a second authorization, which
        # would leave us with no way to get a new token if the stored one
        # is ever lost/revoked.
        'extra_auth_params': {'access_type': 'offline', 'prompt': 'consent'},
        'token_field': 'refresh_token',
    },
    'shopify': {
        'client_id_env': 'SHOPIFY_API_KEY',
        'client_secret_name': 'amplify/shopify/client_secret',
        # No single fixed authorize_url/token_url — Shopify's OAuth is
        # per-shop (https://{shop}.myshopify.com/admin/oauth/...). Both are
        # built at request time in start()/_exchange_code_for_token() using
        # the shop domain instead of a static value here.
        'authorize_url': None,
        'token_url': None,
        # Read-only: Amplify only ever consumes Shopify's catalog/inventory/
        # order data, never writes to the store. read_orders without the
        # separate (Shopify-approved) read_all_orders scope only returns
        # orders from the last 60 days — amplify-campaigns' sales lookup is
        # written to assume that window, not full history.
        'scope': 'read_products,read_inventory,read_orders',
        'extra_auth_params': {},
        # Shopify access tokens don't expire, so there's no refresh_token —
        # the token exchange returns {"access_token": ...} directly.
        'token_field': 'access_token',
    },
}

_SHOP_DOMAIN_RE = re.compile(r'^[a-z0-9][a-z0-9-]*\.myshopify\.com$')

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


def start(platform, org, caller_email, shop=None):
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

    # Shopify has no single fixed authorize_url — it's per-shop
    # (https://{shop}.myshopify.com/admin/oauth/authorize), so the shop
    # domain has to come from the caller before we know where to send them.
    authorize_url = cfg['authorize_url']
    if platform == 'shopify':
        shop = (shop or '').strip().lower()
        if not _SHOP_DOMAIN_RE.match(shop):
            return _resp(400, {'error': 'shop must look like yourstore.myshopify.com'})
        authorize_url = f'https://{shop}/admin/oauth/authorize'

    # Opaque state nonce, TTL'd in DynamoDB, correlates the callback back to
    # this org — the callback request itself carries no JWT (Meta/Google
    # redirect the browser here with no Authorization header of ours), so
    # this round-trip is the ONLY place in this app where org identity
    # doesn't come directly from a JWT claim. See handler()'s callback route.
    state = secrets.token_urlsafe(24)
    state_item = {
        'pk': f'OAUTH_STATE#{state}', 'sk': 'STATE',
        'entity_type': 'oauth_state',
        'org_id': org, 'platform': platform, 'initiated_by': caller_email,
        'created_at': _now(),
        'ttl': int(time.time()) + 600,  # 10 minutes to complete the redirect round-trip
    }
    if platform == 'shopify':
        state_item['shop'] = shop  # cross-checked against callback's own ?shop= param
    table.put_item(Item=state_item)

    params = {
        'client_id': client_id,
        'redirect_uri': f'{OAUTH_API_BASE}/{platform}/callback',
        'scope': cfg['scope'],
        'state': state,
        'response_type': 'code',
        **cfg['extra_auth_params'],
    }
    return _resp(200, {'authorize_url': f"{authorize_url}?{urlencode(params)}"})


def _get_secret(name):
    return secretsmanager.get_secret_value(SecretId=name)['SecretString']


def _refresh_token_secret_name(org, platform):
    return f'amplify/{org}/{platform}/refresh_token'


def _store_refresh_token(org, platform, refresh_token):
    name = _refresh_token_secret_name(org, platform)
    try:
        secretsmanager.create_secret(Name=name, SecretString=refresh_token)
    except secretsmanager.exceptions.ResourceExistsException:
        # Reconnecting an already-connected org (e.g. after a revoke, or
        # Google issuing a fresh refresh_token on re-consent) — overwrite
        # rather than error.
        secretsmanager.put_secret_value(SecretId=name, SecretString=refresh_token)
    return name


def _exchange_code_for_token(platform, code, client_id, redirect_uri, shop=None):
    """POST the real token-exchange request to Meta/Google/Shopify — plain
    urllib.request rather than adding a `requests` dependency this Lambda
    has never needed before. Returns the parsed JSON response (shape varies
    by platform — see each PLATFORM_CONFIG entry's token_field) on success,
    or raises with the platform's own error body on failure (surfaced to
    the caller rather than swallowed, since a failed exchange here means
    the connection genuinely didn't happen).

    Shopify differs from Meta/Google here in two ways: the token endpoint
    is per-shop, not a fixed URL, and it wants a plain JSON body (no
    grant_type/redirect_uri) rather than form-encoded data.
    """
    cfg = PLATFORM_CONFIG[platform]
    client_secret = _get_secret(cfg['client_secret_name'])

    if platform == 'shopify':
        token_url = f'https://{shop}/admin/oauth/access_token'
        payload = json.dumps({
            'client_id': client_id, 'client_secret': client_secret, 'code': code,
        }).encode('utf-8')
        headers = {'Content-Type': 'application/json'}
    else:
        token_url = cfg['token_url']
        payload = urlencode({
            'code': code,
            'client_id': client_id,
            'client_secret': client_secret,
            'redirect_uri': redirect_uri,
            'grant_type': 'authorization_code',
        }).encode('utf-8')
        headers = {'Content-Type': 'application/x-www-form-urlencoded'}

    req = urllib.request.Request(token_url, data=payload, method='POST', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'{platform} token exchange failed ({exc.code}): {body}') from exc


def _verify_shopify_hmac(query_params, client_secret):
    """Shopify's own documented callback-verification algorithm: drop
    hmac/signature, sort the rest lexicographically by key, join as
    key=value pairs with &, HMAC-SHA256 against the client secret, compare
    to the hmac query param. Required by Shopify's own app-review security
    checklist — without it, a forged callback could be used to associate an
    attacker-controlled shop/token with a victim org."""
    params = {k: v for k, v in query_params.items() if k not in ('hmac', 'signature')}
    message = '&'.join(f'{k}={v}' for k, v in sorted(params.items()))
    digest = hmac.new(client_secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()
    provided = query_params.get('hmac', '')
    return hmac.compare_digest(digest, provided)


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

    cfg = PLATFORM_CONFIG.get(platform)
    client_id = os.environ.get(cfg['client_id_env']) if cfg else None
    if not cfg or not client_id:
        return _redirect(f'{AMPLIFY_BASE_URL}?error={platform}_not_yet_configured')

    shop = None
    if platform == 'shopify':
        shop = (qs.get('shop') or '').strip().lower()
        # The shop that initiated the connect (stored in start()) must match
        # the shop Shopify is redirecting back for — otherwise this callback
        # could be used to attach a different store's code to this org.
        if not shop or shop != state_item.get('shop'):
            return _redirect(f'{AMPLIFY_BASE_URL}?error=shop_mismatch')
        client_secret = _get_secret(cfg['client_secret_name'])
        if not _verify_shopify_hmac(qs, client_secret):
            print(f"OAUTH_CALLBACK_ERROR[{org}/shopify]: hmac verification failed")
            return _redirect(f'{AMPLIFY_BASE_URL}?error=hmac_verification_failed')

    try:
        tokens = _exchange_code_for_token(
            platform, code, client_id, redirect_uri=f'{OAUTH_API_BASE}/{platform}/callback', shop=shop)
    except Exception as exc:
        print(f"OAUTH_CALLBACK_ERROR[{org}/{platform}]: {exc}")
        return _redirect(f'{AMPLIFY_BASE_URL}?error=token_exchange_failed')

    token = tokens.get(cfg['token_field'])
    if not token:
        # Expected if this org already connected once before and Google
        # didn't re-issue a refresh_token — but start() always sends
        # prompt=consent specifically to force a fresh one every time, so
        # this should only happen if that ever regresses (for Meta/Shopify,
        # whose token_field is access_token, this firing would mean the
        # exchange response itself was malformed). Surfacing it rather than
        # silently "connecting" with nothing to actually operate on later.
        print(f"OAUTH_CALLBACK_ERROR[{org}/{platform}]: no {cfg['token_field']} in response — "
              f"got keys: {list(tokens.keys())}")
        return _redirect(f'{AMPLIFY_BASE_URL}?error=no_token_returned')

    token_ref = _store_refresh_token(org, platform, token)
    # external_account_id: Shopify's is simply the shop domain, known
    # immediately. For Google that needs a listAccessibleCustomers call
    # (requires the Developer Token, not yet in hand per the Amplify plan's
    # Milestone 1); for Meta a /me/adaccounts call. Left null for those
    # until that follow-up lands; nothing in this app currently depends on
    # it being non-null.
    table.put_item(Item={
        'pk': f'ORG#{org}', 'sk': f'CONN#{platform}',
        'entity_type': 'connection',
        'platform': platform,
        'status': 'connected',
        'external_account_id': shop,
        'token_ref': token_ref,
        'connected_by': state_item.get('initiated_by'),
        'connected_at': _now(),
    })
    return _redirect(f'{AMPLIFY_BASE_URL}?connected={platform}')


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
            shop = (event.get('queryStringParameters') or {}).get('shop')
            return start(platform, org, caller_email, shop=shop)

        if method == 'POST' and path.endswith('/disconnect'):
            platform = path.split('/')[-2]
            return disconnect(platform, org, caller_email)

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
