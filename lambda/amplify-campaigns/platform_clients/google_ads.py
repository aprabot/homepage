"""Real Google Ads API client (REST, v26) for launching a committed campaign
plan into a Google Ads account.

Scope on purpose: TEST accounts only. The Google Cloud project behind the
app's OAuth client has Google Ads API "Test" access, which Google itself
limits to test accounts, and launch() also refuses unless the org's
settings say mode "test". What it creates, in this order:

  1. a campaign budget (daily, in the Google account's own currency)
  2. a Search campaign, PAUSED, with the plan's start and end dates
  3. location targets for the plan's postal codes that Google recognises

Ad groups and ads need ad copy, so they are not created here.

Settings live in s3://<bucket>/orgs/{org}/amplify/google_ads.json (not
secret): client_id, login_customer_id (the manager), customer_id (the
client the campaign goes into), currency, mode, and optionally
ui_campaign_url (a template for the "Open in Google Ads" link). The OAuth
refresh token and client secret come from Secrets Manager, the same
secrets amplify-oauth writes.
"""
import json
import urllib.error
import urllib.parse
import urllib.request

API = 'https://googleads.googleapis.com/v26'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
CLIENT_SECRET_NAME = 'amplify/google/client_secret'


class GoogleAdsError(Exception):
    """A Google Ads API call failed. message is safe to show to the user."""


def _digits(value):
    return ''.join(ch for ch in str(value or '') if ch.isdigit())


def access_token(secretsmanager, org, cfg):
    refresh = secretsmanager.get_secret_value(SecretId=f'amplify/{org}/google/refresh_token')['SecretString']
    secret = secretsmanager.get_secret_value(SecretId=CLIENT_SECRET_NAME)['SecretString']
    body = urllib.parse.urlencode({
        'grant_type': 'refresh_token', 'client_id': cfg['client_id'],
        'client_secret': secret, 'refresh_token': refresh,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            token = json.loads(resp.read().decode()).get('access_token')
    except urllib.error.HTTPError as exc:
        raise GoogleAdsError('Google sign-in has expired or was revoked. Reconnect Google Ads in Integrations.') from exc
    if not token:
        raise GoogleAdsError('Google did not return an access token. Reconnect Google Ads in Integrations.')
    return token


def _call(token, cfg, path, body):
    req = urllib.request.Request(f'{API}/{path}', data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'login-customer-id': _digits(cfg['login_customer_id']),
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as exc:
        raise GoogleAdsError(_error_text(exc)) from exc


def _error_text(exc):
    """Google's own error message, trimmed, for the plan's launch status."""
    try:
        data = json.loads(exc.read().decode())
        err = data.get('error', {})
        details = []
        for d in err.get('details', []):
            for e in d.get('errors', []):
                code = ', '.join(f'{k}: {v}' for k, v in (e.get('errorCode') or {}).items())
                details.append((e.get('message') or '') + (f' ({code})' if code else ''))
        text = '; '.join(x for x in details if x) or err.get('message') or str(exc)
    except Exception:  # noqa: BLE001
        text = f'HTTP {exc.code}'
    return ('Google Ads: ' + text)[:500]


def _postal_targets(token, cfg, postal_codes, country='IN'):
    """Map postal codes to Google geo target constants. Unknown codes are
    returned separately rather than failing the launch."""
    found, missing = {}, []
    codes = list(dict.fromkeys(postal_codes))
    for start in range(0, len(codes), 25):
        batch = codes[start:start + 25]
        data = _call(token, cfg, 'geoTargetConstants:suggest',
                     {'locale': 'en', 'countryCode': country, 'locationNames': {'names': batch}})
        for s in data.get('geoTargetConstantSuggestions', []):
            g = s.get('geoTargetConstant') or {}
            name = (g.get('name') or '').upper()
            if g.get('countryCode') == country and 'postal' in (g.get('targetType') or '').lower() and name in batch:
                found.setdefault(name, g.get('resourceName'))
    missing = [c for c in codes if c not in found]
    return found, missing


def campaign_url(cfg, campaign_id):
    """Link to the campaign in the Google Ads web UI, from the org's
    settings template (Google documents no fixed format)."""
    template = cfg.get('ui_campaign_url')
    if not template:
        return None
    return template.replace('{campaign_id}', str(campaign_id)).replace('{customer_id}', _digits(cfg['customer_id']))


def launch(secretsmanager, org, cfg, plan):
    if cfg.get('mode') != 'test':
        raise GoogleAdsError('Launching is only enabled for Google Ads test accounts.')
    customer = _digits(cfg['customer_id'])
    token = access_token(secretsmanager, org, cfg)
    label = f"APRABot {plan['code']}"

    budget = _call(token, cfg, f'customers/{customer}/campaignBudgets:mutate', {'operations': [{'create': {
        'name': f'{label} budget', 'amountMicros': str(int(plan['daily_budget_yen']) * 1_000_000),
        'deliveryMethod': 'STANDARD', 'explicitlyShared': False,
    }}]})['results'][0]['resourceName']

    campaign = _call(token, cfg, f'customers/{customer}/campaigns:mutate', {'operations': [{'create': {
        'name': f"{label} · {plan['name']}"[:250],
        'advertisingChannelType': 'SEARCH',
        'status': 'PAUSED',
        'campaignBudget': budget,
        'manualCpc': {},
        'networkSettings': {'targetGoogleSearch': True, 'targetSearchNetwork': True,
                            'targetContentNetwork': False, 'targetPartnerSearchNetwork': False},
        'containsEuPoliticalAdvertising': 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        'startDateTime': f"{plan['start_date']} 00:00:00",
        'endDateTime': f"{plan['end_date']} 23:59:59",
    }}]})['results'][0]['resourceName']
    campaign_id = campaign.rsplit('/', 1)[-1]

    postal = [p for line in plan.get('scope', []) for p in line.get('postal_codes', [])]
    targeted, missing, geo_error = [], [], None
    try:
        found, missing = _postal_targets(token, cfg, postal)
        if found:
            _call(token, cfg, f'customers/{customer}/campaignCriteria:mutate', {'operations': [
                {'create': {'campaign': campaign, 'location': {'geoTargetConstant': rn}}} for rn in found.values()]})
            targeted = sorted(found)
    except GoogleAdsError as exc:
        geo_error, missing = str(exc), sorted(set(postal))

    return {
        'platform': 'google', 'customer_id': customer, 'campaign_id': campaign_id,
        'campaign_resource': campaign, 'budget_resource': budget, 'status': 'PAUSED',
        'currency': cfg.get('currency'), 'postal_targeted': targeted, 'postal_missing': missing,
        'geo_error': geo_error, 'url': campaign_url(cfg, campaign_id),
    }
