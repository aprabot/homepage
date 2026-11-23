import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3

import inbound

s3      = boto3.client('s3')
lam     = boto3.client('lambda')
cognito = boto3.client('cognito-idp')
BUCKET       = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
RUNNER       = os.environ.get('RUNNER_FUNCTION', 'aprabot-scenario-runner')
USER_POOL_ID = os.environ.get('USER_POOL_ID', 'us-east-1_fb34nECGY')
CHAT_API     = os.environ.get('CHAT_API_FUNCTION', 'aprabot-chat-api')

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


# ---- roles within an org -----------------------------------------------
# orgs/{org}/members.json: {"admins": ["a@x.com", "b@x.com"]} — ABSENT
# (not an empty admins list, the whole file missing) means "roles were
# never configured for this org", which is treated as everyone-admin. This
# is the key default-permissive choice: every org that exists today (just
# aprabot-internal) keeps working exactly as before with zero migration,
# and a brand new org stays fully open until an admin explicitly sets up
# roles — never silently locks anyone out. Only an org that has actually
# called set_member_role() once ever sees a real admin/viewer split.
def _members_key(org):
    return f'orgs/{org}/scenarios/members.json'


def _is_admin(org, email):
    members = _read_json(_members_key(org))
    if members is None:
        return True
    return (email or '').strip().lower() in members.get('admins', [])


def _org_member_emails(org):
    """Every Cognito user whose own org resolves to this one. The user
    pool has no native "list by org" query (org is a derived concept, not
    a stored attribute) — this pool is small (single digits today, low
    hundreds at most for the foreseeable future), so a full ListUsers scan
    filtered in Python is simpler and more honest than trying to keep a
    separate index in sync."""
    emails = []
    kwargs = {'UserPoolId': USER_POOL_ID, 'Limit': 60}
    while True:
        page = cognito.list_users(**kwargs)
        for u in page.get('Users', []):
            email = next((a['Value'] for a in u.get('Attributes', []) if a['Name'] == 'email'), None)
            if email and _org_id(email) == org:
                emails.append(email.strip().lower())
        token = page.get('PaginationToken')
        if not token:
            break
        kwargs['PaginationToken'] = token
    return emails


def list_members(org, caller_email):
    members = _read_json(_members_key(org))
    # Unconfigured org: every real member is shown as admin, matching
    # _is_admin()'s own default — never show a role split that doesn't
    # actually correspond to what's enforced.
    admin_set = set(members.get('admins', [])) if members is not None else None
    result = []
    for email in sorted(_org_member_emails(org)):
        is_admin = True if admin_set is None else (email in admin_set)
        result.append({'email': email, 'role': 'admin' if is_admin else 'viewer'})
    return _resp(200, {'members': result, 'you_are_admin': _is_admin(org, caller_email)})


def set_member_role(org, caller_email, event):
    if not _is_admin(org, caller_email):
        return _resp(403, {'error': 'only an admin can change member roles'})

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    target = (body.get('email') or '').strip().lower()
    role = (body.get('role') or '').strip().lower()
    if role not in ('admin', 'viewer'):
        return _resp(400, {'error': 'role must be "admin" or "viewer"'})
    if not target or _org_id(target) != org:
        return _resp(400, {'error': 'email must belong to your own organization'})

    members = _read_json(_members_key(org))
    if members is None:
        # First-ever role change for this org — materialize the implicit
        # "everyone is admin" state into an explicit list before applying
        # the requested change, so promoting ONE viewer can never be
        # confused with anyone else's existing standing.
        members = {'admins': _org_member_emails(org)}

    admins = set(members.get('admins', []))

    if role == 'viewer':
        if target in admins:
            # Admin status can only be GRANTED through this endpoint, never
            # revoked — one admin demoting another isn't offered as a
            # self-service action (removes any risk of one admin locking
            # another out, or a role fight). A member who isn't already an
            # admin is already effectively a viewer, so this is a no-op.
            return _resp(400, {'error': 'an admin cannot be downgraded to viewer — '
                                         'admin status can only be granted, not revoked'})
        return _resp(200, {'email': target, 'role': 'viewer'})

    admins.add(target)
    members['admins'] = sorted(admins)
    _write_json(_members_key(org), members)
    return _resp(200, {'email': target, 'role': 'admin'})


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


def list_scenarios(org, caller_email):
    idx = _read_json(f'orgs/{org}/scenarios/index.json', default={'scenarios': []})
    scenarios = sorted(idx['scenarios'], key=lambda s: s.get('created_at', ''), reverse=True)
    # Lets the frontend hide/disable the Approve button for a viewer without
    # a separate request — this list is already fetched on every page load.
    return _resp(200, {'scenarios': scenarios, 'you_are_admin': _is_admin(org, caller_email),
                       'scenario_levers': True})


ALLOWED_UPLOAD_EXT = {'.xlsx', '.tsv', '.csv', '.txt'}


def create_upload_url(org, event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    filename = (body.get('filename') or '').strip()
    ext = os.path.splitext(filename)[1].lower()
    if not filename or ext not in ALLOWED_UPLOAD_EXT:
        return _resp(400, {'error': f'filename must end in one of {sorted(ALLOWED_UPLOAD_EXT)}'})

    safe_name = re.sub(r'[^A-Za-z0-9_.-]', '_', filename)[:120]
    key = f"orgs/{org}/uploads/{uuid.uuid4().hex}/{safe_name}"

    content_type = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }.get(ext, 'text/tab-separated-values')

    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': BUCKET, 'Key': key, 'ContentType': content_type},
        ExpiresIn=300,
    )
    return _resp(200, {'upload_url': url, 'key': key, 'content_type': content_type})


def _scheme_key(org):
    return f'orgs/{org}/scenarios/discount-schemes.json'


def _scheme_id(value):
    value = str(value or '').strip().upper()
    if not value or len(value) > 80 or any(ord(ch) < 32 for ch in value):
        raise ValueError('Enter a scheme ID of up to 80 characters.')
    return value


def _scenario_levers(body):
    levers = body.get('levers') or {}
    if not isinstance(levers, dict):
        raise ValueError('Invalid scenario controls.')
    result = {}
    for name, low, high in [('spend_pct', -100, 1000), ('unit_cap', 0, 100000000),
                            ('price_pct', -99, 1000)]:
        value = levers.get(name)
        if value is not None:
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f'Invalid {name}.')
            result[name] = value
    for name in ('postal_code', 'holiday_postal_code'):
        if name in levers:
            value = str(levers[name]).strip()
            if not re.fullmatch(r'[A-Za-z0-9 -]{2,12}', value):
                raise ValueError('Enter a valid postal code.')
            result[name] = value
    # Price lever scope: one zip or one SKU (blank target = all of them).
    # Separate from postal_code, which only scopes spend and the unit cap.
    if 'price_scope' in levers:
        scope = levers['price_scope']
        if scope not in ('zip', 'sku') or 'price_pct' not in result:
            raise ValueError('Choose Zip or SKU for a price change.')
        result['price_scope'] = scope
        target = str(levers.get('price_target') or '').strip().upper()
        if target:
            pattern = r'[A-Z0-9 -]{2,12}' if scope == 'zip' else r'SKU-\d{3,}'
            if not re.fullmatch(pattern, target):
                raise ValueError('Enter a valid zip code.' if scope == 'zip' else 'Enter a forecast SKU such as SKU-003.')
            result['price_target'] = target
    for name, pattern in (('price_sku', r'SKU-\d{3,}'),
                          ('price_postal_code', r'[A-Z0-9 -]{2,12}')):
        if name in levers:
            value = str(levers[name]).strip().upper()
            if 'price_pct' not in result or (value and not re.fullmatch(pattern, value)):
                raise ValueError('Choose a valid SKU or PIN code for the price change.')
            result[name] = value
    holiday_dates = levers.get('excluded_holiday_dates', [])
    if not isinstance(holiday_dates, list) or len(holiday_dates) > 150:
        raise ValueError('Select up to 150 holidays to exclude.')
    for date in holiday_dates:
        if not isinstance(date, str) or not re.fullmatch(r'20\d{2}-\d{2}-\d{2}', date):
            raise ValueError('Enter a valid holiday date.')
        try:
            datetime.strptime(date, '%Y-%m-%d')
        except ValueError:
            raise ValueError('Enter a valid holiday date.') from None
    if holiday_dates:
        result['excluded_holiday_dates'] = sorted(set(holiday_dates))
    if levers.get('campaign_code'):
        result['campaign_code'] = _scheme_id(levers['campaign_code'])
    if levers.get('holiday_off') is True:
        result['holiday_off'] = True
    excluded = levers.get('excluded_schemes') or []
    if not isinstance(excluded, list) or len(excluded) > 100:
        raise ValueError('Select up to 100 schemes to exclude.')
    if excluded:
        result['excluded_schemes'] = list(dict.fromkeys(map(_scheme_id, excluded)))
    included = levers.get('included_schemes') or []
    if not isinstance(included, list) or len(included) > 100:
        raise ValueError('Select up to 100 draft schemes to include.')
    if included:
        result['included_schemes'] = list(dict.fromkeys(map(_scheme_id, included)))
    return result


def _discount_schemes(org, email, method, event):
    if method == 'POST':
        try:
            request = json.loads(event.get('body') or '{}')
        except json.JSONDecodeError:
            return _resp(400, {'error': 'Invalid JSON.'})
        if not isinstance(request, dict):
            return _resp(400, {'error': 'Expected a scheme request.'})
        if request.get('action') == 'scan':
            input_key = request.get('custom_input_key')
            if not isinstance(input_key, str) or not input_key.startswith(f'orgs/{org}/uploads/'):
                return _resp(400, {'error': 'Choose an uploaded sales file.'})
            lam.invoke(FunctionName=RUNNER, InvocationType='Event',
                       Payload=json.dumps({'job': 'scan_schemes', 'org_id': org,
                                           'custom_input_key': input_key}).encode())
            return _resp(202, {'status': 'scanning'})
    key = _scheme_key(org)
    try:
        existing = s3.get_object(Bucket=BUCKET, Key=key)
        registry = json.loads(existing['Body'].read())
        condition = {'IfMatch': existing['ETag']}
    except s3.exceptions.ClientError as exc:
        if exc.response['Error']['Code'] not in ('403', 'AccessDenied', '404', 'NoSuchKey'):
            raise
        registry = {}
        condition = {'IfNoneMatch': '*'}
    detected = _read_json(f'orgs/{org}/scenarios/detected-schemes.json', default={}) or {}
    can_edit = _is_admin(org, email)
    if method == 'GET':
        rows = [{**detected.get(code, {}), **registry.get(code, {}), 'code': code,
                 'detected': code in detected}
                for code in sorted(registry.keys() | detected.keys())]
        # draft_runs: this backend can apply drafts to one run (included_schemes).
        return _resp(200, {'schemes': rows, 'can_edit': can_edit, 'draft_runs': True})
    if not can_edit:
        return _resp(403, {'error': 'Only an admin can update discount schemes.'})
    try:
        body = request
        code = _scheme_id(body.get('code'))
        previous = registry.get(code, {})
        if body.get('version', 0) != previous.get('version', 0):
            return _resp(409, {'error': 'The scheme changed. Refresh and try again.'})
        action = body.get('action')
        if action == 'withdraw':
            if previous.get('status') != 'committed':
                raise ValueError('Only a committed scheme can be withdrawn.')
            row = {**previous, 'status': 'withdrawn'}
        elif action in ('draft', 'commit'):
            if previous.get('status') == 'committed':
                raise ValueError('Withdraw the committed version before changing it.')
            name = str(body.get('name') or '').strip()
            mechanic = body.get('mechanic')
            if not name or len(name) > 120 or mechanic not in ('Percent off', 'Flat amount off', 'Buy X get Y', 'Bundle', 'Free gift', 'Cashback', 'Tiered'):
                raise ValueError('Enter a name and choose a supported discount mechanic.')
            scope = body.get('scope')
            if not isinstance(scope, list) or not 1 <= len(scope) <= 30:
                raise ValueError('Include between 1 and 30 scope lines.')
            latest = _read_json(f'orgs/{org}/forecast/latest.json', default={})
            for line in scope:
                sku, postal = line.get('sku', ''), line.get('postal_code', '')
                if not isinstance(sku, str) or not re.fullmatch(r'SKU-\d{3,}', sku):
                    raise ValueError('Use a forecast SKU for each scope line.')
                if not isinstance(postal, str) or not re.fullmatch(r'[A-Za-z0-9 -]{2,12}', postal):
                    raise ValueError('Enter a postal code for each scope line.')
                start = datetime.strptime(line.get('start_date', ''), '%Y-%m-%d').date()
                end = datetime.strptime(line.get('end_date', ''), '%Y-%m-%d').date()
                if not 0 <= (end - start).days < 364:
                    raise ValueError('Each scope line must span 1–364 days.')
                value = line.get('discount')
                if type(value) not in (int, float) or not 0 < value <= (1000000 if mechanic == 'Flat amount off' else 99):
                    raise ValueError('Enter a positive discount. Percent discounts must be below 100.')
                if action == 'commit' and sku not in latest.get('skus', {}):
                    raise ValueError('Each SKU must exist in the approved forecast.')
                line.update(start_date=start.isoformat(), end_date=end.isoformat())
            if action == 'commit' and not latest.get('campaignPlanningReady'):
                raise ValueError('Run and approve a fresh forecast before committing schemes.')
            row = {'name': name, 'mechanic': mechanic, 'scope': scope,
                   'status': 'committed' if action == 'commit' else 'draft',
                   'forecast_id': latest.get('id') if action == 'commit' else None}
        else:
            raise ValueError('Unknown scheme action.')
        history = previous.get('history', [])
        if previous.get('status') == 'withdrawn' and action != 'withdraw':
            history = [*history, {k: v for k, v in previous.items() if k != 'history'}][-20:]
        registry[code] = {**row, 'history': history, 'version': previous.get('version', 0) + 1,
                          'updated_at': _now()}
        s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(registry).encode(),
                      ContentType='application/json', **condition)
    except (ValueError, TypeError, AttributeError) as exc:
        return _resp(400, {'error': str(exc)})
    except s3.exceptions.ClientError as exc:
        if exc.response['Error']['Code'] in ('PreconditionFailed', 'ConditionalRequestConflict', '412', '409'):
            return _resp(409, {'error': 'The registry changed. Refresh and try again.'})
        raise
    if action == 'commit':
        # Use the approved revision's source so onboarding-derived tenants can rerun.
        config = _read_json(f'orgs/{org}/scenarios/{row["forecast_id"]}/config.json', default={})
        if config is None:
            config = {}
        run = {**event, 'body': json.dumps({'label': f'Discount scheme {code}', 'source': 'approved',
                                            'weather': config.get('weather', True),
                                            'calibrate': config.get('calibrate', True),
                                            'refresh_days': config.get('refresh_days', 28)})}
        try:
            result = create_scenario(org, run)
            if result['statusCode'] == 202:
                return _resp(200, {'scheme': registry[code], **json.loads(result['body'])})
        except Exception as exc:
            print(f'Scheme rerun dispatch failed: {exc}')
        return _resp(200, {'scheme': registry[code], 'warning': 'Scheme committed. Start a scenario to run the updated forecast.'})
    return _resp(200, {'scheme': registry[code]})


def _live_sku_map(org):
    """{SKU in uploaded files: forecast SKU}, from the live forecast."""
    latest = _read_json(f'orgs/{org}/forecast/latest.json', default={}) or {}
    return _read_json(f'orgs/{org}/scenarios/{latest.get("id")}/anon.json', default={}) or {}


def _read_upload(org, key):
    """A file this org uploaded. Never follows a key outside its own prefix."""
    if not isinstance(key, str) or not key.startswith(f'orgs/{org}/uploads/') or '..' in key:
        raise inbound.InboundError('Choose a file you uploaded.')
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
    except s3.exceptions.ClientError:
        raise inbound.InboundError('The uploaded file could not be found.')
    if obj['ContentLength'] > inbound.MAX_BYTES:
        raise inbound.InboundError('The file is too large.')
    return obj['Body'].read()


def _stock_key(org):
    return f'orgs/{org}/scenarios/stock.json'


def stock_summary(org):
    saved = _read_json(_stock_key(org), default=None)
    if not saved:
        return {'status': 'none'}
    meta = {'uploaded_at': saved.get('uploaded_at'), 'filename': saved.get('filename')}
    try:
        data = _read_upload(org, saved.get('key'))
        return {'status': 'ok', **meta, **inbound.summarize_stock(
            data, saved['key'], _live_sku_map(org), datetime.now(timezone.utc).date())}
    except inbound.InboundError as exc:
        return {'status': 'error', 'error': str(exc), **meta}


def save_stock(org, email, event):
    """POST /scenarios?view=stock {key}: use this uploaded stock file."""
    if not _is_admin(org, email):
        return _resp(403, {'error': 'Only an admin can update stock.'})
    try:
        key = json.loads(event.get('body') or '{}').get('key')
        result = inbound.summarize_stock(_read_upload(org, key), key, _live_sku_map(org), datetime.now(timezone.utc).date())
    except inbound.InboundError as exc:
        return _resp(400, {'error': str(exc)})
    except (ValueError, AttributeError):
        return _resp(400, {'error': 'Invalid JSON.'})
    if not result['by_sku']:
        return _resp(400, {'error': 'No SKUs in this file match the approved forecast, so it was not used.'})
    _write_json(_stock_key(org), {'key': key, 'filename': key.rsplit('/', 1)[-1], 'uploaded_by': email, 'uploaded_at': _now()})
    return _resp(200, {'stock': stock_summary(org)})


def inbound_view(org, email):
    """GET /scenarios?view=inbound: everything Inventory knows from uploads."""
    return _resp(200, {'inbound': inbound_summary(org), 'stock': stock_summary(org), 'can_edit': _is_admin(org, email)})


def inbound_summary(org):
    """What the latest inbound receipts uploaded in Getting Started contain,
    per forecast SKU. The onboarding profile names the file."""
    prefix = f'orgs/{org}/uploads/'
    profiles, token = [], None
    while True:
        page = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix, **({'ContinuationToken': token} if token else {}))
        profiles += [(o['LastModified'], o['Key']) for o in page.get('Contents', [])
                     if o['Key'].endswith('/onboarding-profile.txt')]
        token = page.get('NextContinuationToken')
        if not token:
            break
    for uploaded, profile_key in sorted(profiles, reverse=True)[:20]:
        profile = _read_json(profile_key, default=None)
        key = profile.get('inbound_receipts_key') if isinstance(profile, dict) else None
        # The profile is uploaded content: never follow it outside this org.
        if isinstance(key, str) and key.startswith(prefix) and '..' not in key:
            break
    else:
        return {'status': 'none'}
    try:
        result = inbound.summarize(_read_upload(org, key), key, _live_sku_map(org), datetime.now(timezone.utc).date())
    except inbound.InboundError as exc:
        return {'status': 'error', 'error': str(exc), 'uploaded_at': uploaded.isoformat()}
    return {'status': 'ok', 'uploaded_at': uploaded.isoformat(), **result}


def create_scenario(org, event):
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
    if custom_input_key and not custom_input_key.startswith(f'orgs/{org}/uploads/'):
        return _resp(400, {'error': 'invalid custom_input_key'})

    try:
        levers = _scenario_levers(body)
    except ValueError as exc:
        return _resp(400, {'error': str(exc)})
    if body.get('source') == 'approved' and not custom_input_key:
        latest = _read_json(f'orgs/{org}/forecast/latest.json', default={})
        if latest and latest.get('id'):
            base = _read_json(f'orgs/{org}/scenarios/{latest["id"]}/config.json', default={})
            custom_input_key = (base or {}).get('custom_input_key') or ''
    schemes = _read_json(_scheme_key(org), default={}) or {}
    active_schemes = [dict(name=row['name'], mechanic=row['mechanic'], scope=row['scope'],
                           forecast_id=row['forecast_id'], code=code) for code, row in schemes.items()
                      if row['status'] == 'committed' and code not in levers.get('excluded_schemes', [])]
    # Drafts picked for this run only: they apply here without being committed.
    if levers.get('included_schemes'):
        latest = _read_json(f'orgs/{org}/forecast/latest.json', default={}) or {}
        for code in levers['included_schemes']:
            row = schemes.get(code) or {}
            if row.get('status') == 'committed':  # committed since it was picked
                if code in levers.get('excluded_schemes', []):
                    return _resp(400, {'error': f'{code} is both included and excluded.'})
                continue
            if row.get('status') != 'draft':
                return _resp(400, {'error': f'{code} is not a draft scheme. Reopen Discount schemes and choose again.'})
            unknown = sorted({line['sku'] for line in row['scope']} - set(latest.get('skus') or {}))
            if unknown:
                return _resp(400, {'error': f'{code} uses {", ".join(unknown[:3])}, which is not in the approved forecast.'})
            active_schemes.append(dict(name=row['name'], mechanic=row['mechanic'], scope=row['scope'],
                                       forecast_id=latest['id'], code=code, draft=True))

    scenario_id = f"scn-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    email = _claims(event).get('email', 'planner')

    config = {
        'id': scenario_id, 'label': label, 'status': 'running',
        'known_prices': known_prices, 'calibrate': calibrate,
        'weather': weather, 'refresh_days': refresh_days,
        'custom_input': bool(custom_input_key), 'levers': levers, 'discount_schemes': active_schemes,
        'requested_by': email, 'created_at': _now(), 'approved': False,
    }
    if custom_input_key:
        config['custom_input_key'] = custom_input_key
    _write_json(f'orgs/{org}/scenarios/{scenario_id}/config.json', config)

    idx = _read_json(f'orgs/{org}/scenarios/index.json', default={'scenarios': []})
    idx['scenarios'].append({k: config[k] for k in
                              ('id', 'label', 'status', 'known_prices', 'calibrate',
                               'weather', 'refresh_days', 'custom_input',
                               'requested_by', 'created_at', 'approved', 'levers')})
    _write_json(f'orgs/{org}/scenarios/index.json', idx)

    runner_payload = {
        'org_id': org,
        'scenario_id': scenario_id, 'label': label,
        'known_prices': known_prices, 'calibrate': calibrate,
        'weather': weather, 'refresh_days': refresh_days, 'levers': levers,
    }
    if custom_input_key:
        runner_payload['custom_input_key'] = custom_input_key

    lam.invoke(FunctionName=RUNNER, InvocationType='Event',
               Payload=json.dumps(runner_payload).encode('utf-8'))

    return _resp(202, {'scenario_id': scenario_id, 'status': 'running'})


DEFAULT_INPUT_FILENAME = 'apra-default-input.tsv'


def get_result(org, scenario_id):
    result = _read_json(f'orgs/{org}/scenarios/{scenario_id}/result.json')
    if result is None:
        return _resp(404, {'error': 'result not found (scenario may still be running or failed)'})

    # Presigned download for whatever this scenario actually ran on — the
    # user's uploaded file if there was one, otherwise this org's own
    # default dataset. Not persisted back to S3, just added to this response.
    config = _read_json(f'orgs/{org}/scenarios/{scenario_id}/config.json', default={})
    custom_key = config.get('custom_input_key')
    if custom_key:
        filename = custom_key.rsplit('/', 1)[-1]
        key, is_default = custom_key, False
    else:
        filename = DEFAULT_INPUT_FILENAME
        key, is_default = f'orgs/{org}/raw/With_Price.tsv', True
    url = s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': key,
                'ResponseContentDisposition': f'attachment; filename="{filename}"'},
        ExpiresIn=300,
    )
    result['inputDownload'] = {'url': url, 'filename': filename, 'isDefault': is_default}

    return _resp(200, result)


def approve_scenario(org, scenario_id, event):
    approver_email = _claims(event).get('email', '')
    if not _is_admin(org, approver_email):
        # Covers both the UI's own Approve button (hidden for a viewer, but
        # this is the real enforcement — client-side hiding alone is never
        # a security boundary) and chat-api's approve_scenario tool, which
        # proxies through this same function via an identical fake_event.
        return _resp(403, {'error': 'only an admin can approve a scenario for this organization'})

    result = _read_json(f'orgs/{org}/scenarios/{scenario_id}/result.json')
    if result is None:
        return _resp(404, {'error': 'no completed result for this scenario'})

    _write_json(f'orgs/{org}/forecast/latest.json', result)

    # Best-effort — inventory.json is an optional companion scenario-runner
    # writes alongside result.json (see its own compute_monthly_inventory()
    # docstring for why it can legitimately be absent: an older scenario
    # from before this existed, or the computation itself best-effort
    # failing on this run's own data). Never let a missing/unreadable
    # inventory.json block the approval that already succeeded above.
    inventory = _read_json(f'orgs/{org}/scenarios/{scenario_id}/inventory.json')
    if inventory is not None:
        _write_json(f'orgs/{org}/forecast/latest_inventory.json', inventory)

    idx = _read_json(f'orgs/{org}/scenarios/index.json', default={'scenarios': []})
    # Captured before the loop overwrites 'approved' below — this scenario's
    # own index entry (for label/wape/volume_error) and whichever OTHER
    # scenario was previously live (for the audit entry's "replaced" field;
    # None on a first-ever approval, or if re-approving the same one).
    this_entry = next((s for s in idx['scenarios'] if s['id'] == scenario_id), {})
    previous_id = next((s['id'] for s in idx['scenarios']
                        if s.get('approved') and s['id'] != scenario_id), None)

    # Best-effort, fire-and-forget — same pattern as scenario-runner's own
    # async explain-runner invoke. chat-api's _generate_insights() writes
    # orgs/{org}/insights/latest.json on its own time; approve_scenario()
    # doesn't wait on it (Bedrock generation takes several seconds, too
    # slow to make the Approve button hang for) and a failure here must
    # never undo the approval that's already succeeded above.
    try:
        lam.invoke(
            FunctionName=CHAT_API, InvocationType='Event',
            Payload=json.dumps({
                'internal_task': 'generate_insights', 'org_id': org,
                'scenario_id': scenario_id, 'scenario_label': this_entry.get('label'),
            }).encode('utf-8'),
        )
    except Exception as exc:
        print(f"INSIGHTS_INVOKE_WARNING[{scenario_id}]: {exc}")

    for s in idx['scenarios']:
        s['approved'] = (s['id'] == scenario_id)
    _write_json(f'orgs/{org}/scenarios/index.json', idx)

    config = _read_json(f'orgs/{org}/scenarios/{scenario_id}/config.json', default={})
    config['approved'] = True
    _write_json(f'orgs/{org}/scenarios/{scenario_id}/config.json', config)

    # Audit trail — who approved what, when, replacing what. Append-only,
    # separate from scenarios/index.json (which only ever tracks the
    # CURRENTLY approved one) so history survives being superseded later.
    # Same claims shape whether this call came from the UI's own Approve
    # button or via chat-api's approve_scenario tool (_invoke_scenarios_api
    # builds an identical fake_event), so both are attributed the same way.
    log = _read_json(f'orgs/{org}/scenarios/approval_log.json', default={'entries': []})
    log['entries'].append({
        'scenario_id': scenario_id,
        'label': this_entry.get('label') or config.get('label', 'Untitled scenario'),
        'approved_by': _claims(event).get('email', 'unknown'),
        'approved_at': _now(),
        'replaced_scenario_id': previous_id,
        'wape': this_entry.get('wape'),
        'volume_error': this_entry.get('volume_error'),
    })
    _write_json(f'orgs/{org}/scenarios/approval_log.json', log)

    return _resp(200, {'approved': scenario_id})


def list_approvals(org):
    log = _read_json(f'orgs/{org}/scenarios/approval_log.json', default={'entries': []})
    entries = sorted(log['entries'], key=lambda e: e.get('approved_at', ''), reverse=True)
    return _resp(200, {'approvals': entries})


# ---- support tickets -----------------------------------------------------
# orgs/{org}/support/index.json: {"tickets": [{id, subject, category,
# status, created_by, created_at, updated_at, message_count}, ...]} — a
# lightweight summary list per org, same shape/purpose as scenarios/
# index.json. The full thread for one ticket lives in its own object,
# orgs/{org}/support/{ticket_id}.json, so replying never has to rewrite
# every other ticket's messages.
#
# Staff (anyone in aprabot-internal, reusing the same org-resolution this
# whole file already does — there's no separate "support agent" role to
# manage) can see and reply to EVERY org's tickets, not just their own;
# a regular org member only ever sees their own org's. Tickets are
# otherwise genuinely org-level as asked: any member of an org can see
# and reply to a ticket a teammate opened, not just its original author.
_TICKET_CATEGORIES = {
    'accuracy', 'approvals-roles', 'data-integration', 'billing', 'bug', 'other',
}


def _is_staff(email):
    return _org_id(email) == 'aprabot-internal'


def _support_index_key(org):
    return f'orgs/{org}/support/index.json'


def _ticket_key(org, ticket_id):
    return f'orgs/{org}/support/{ticket_id}.json'


def _all_org_ids():
    """Every org that has ever written anything under orgs/ — staff-only,
    to build the cross-org ticket view. S3 has no "list distinct
    prefixes" primitive; Delimiter='/' on the orgs/ prefix is the
    standard way to get just the next path segment (each org's own
    folder) without listing every object underneath it."""
    orgs = []
    kwargs = {'Bucket': BUCKET, 'Prefix': 'orgs/', 'Delimiter': '/'}
    while True:
        page = s3.list_objects_v2(**kwargs)
        for p in page.get('CommonPrefixes', []):
            orgs.append(p['Prefix'][len('orgs/'):].rstrip('/'))
        if not page.get('IsTruncated'):
            break
        kwargs['ContinuationToken'] = page['NextContinuationToken']
    return orgs


def list_tickets(org, caller_email):
    if _is_staff(caller_email):
        # Cross-org — every org's own index, each entry tagged with which
        # org it belongs to (the per-org index itself doesn't need that
        # field, only this aggregated staff view does).
        out = []
        for o in _all_org_ids():
            idx = _read_json(_support_index_key(o), default={'tickets': []})
            for t in idx['tickets']:
                out.append({**t, 'org': o})
        out.sort(key=lambda t: t.get('updated_at', ''), reverse=True)
        return _resp(200, {'tickets': out, 'is_staff': True})

    idx = _read_json(_support_index_key(org), default={'tickets': []})
    tickets = sorted(idx['tickets'], key=lambda t: t.get('updated_at', ''), reverse=True)
    return _resp(200, {'tickets': tickets, 'is_staff': False})


def create_ticket(org, caller_email, event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    subject = (body.get('subject') or '').strip()[:140]
    category = (body.get('category') or 'other').strip().lower()
    message = (body.get('message') or '').strip()[:4000]
    if not subject or not message:
        return _resp(400, {'error': 'subject and message are required'})
    if category not in _TICKET_CATEGORIES:
        category = 'other'

    ticket_id = f"tkt-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    now = _now()
    ticket = {
        'id': ticket_id, 'org': org, 'subject': subject, 'category': category, 'status': 'open',
        'created_by': caller_email, 'created_at': now, 'updated_at': now,
        'messages': [{'from': caller_email, 'is_staff': False, 'body': message, 'created_at': now}],
    }
    _write_json(_ticket_key(org, ticket_id), ticket)

    idx = _read_json(_support_index_key(org), default={'tickets': []})
    idx['tickets'].append({
        'id': ticket_id, 'subject': subject, 'category': category, 'status': 'open',
        'created_by': caller_email, 'created_at': now, 'updated_at': now, 'message_count': 1,
    })
    _write_json(_support_index_key(org), idx)

    return _resp(202, {'ticket_id': ticket_id})


def get_ticket(org, caller_email, ticket_id):
    # A customer only ever gets here with their own org (org is resolved
    # from their own email, same as every other route in this file); staff
    # can look up ANY org's ticket, so they need to find which org it
    # actually belongs to first rather than assuming their own.
    if _is_staff(caller_email):
        target_org = _find_ticket_org(ticket_id)
        if target_org is None:
            return _resp(404, {'error': 'ticket not found'})
    else:
        target_org = org

    ticket = _read_json(_ticket_key(target_org, ticket_id))
    if ticket is None:
        return _resp(404, {'error': 'ticket not found'})
    return _resp(200, ticket)


def _find_ticket_org(ticket_id):
    """Staff-only lookup — a ticket id alone doesn't say which org's S3
    prefix it lives under, so check each org's index. Fine at this
    scale (same reasoning as _org_member_emails' own full-scan)."""
    for o in _all_org_ids():
        idx = _read_json(_support_index_key(o), default={'tickets': []})
        if any(t['id'] == ticket_id for t in idx['tickets']):
            return o
    return None


def reply_ticket(org, caller_email, ticket_id, event):
    is_staff = _is_staff(caller_email)
    target_org = _find_ticket_org(ticket_id) if is_staff else org
    if target_org is None:
        return _resp(404, {'error': 'ticket not found'})

    ticket = _read_json(_ticket_key(target_org, ticket_id))
    if ticket is None:
        return _resp(404, {'error': 'ticket not found'})

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})
    message = (body.get('message') or '').strip()[:4000]
    if not message:
        return _resp(400, {'error': 'message is required'})

    now = _now()
    ticket['messages'].append({'from': caller_email, 'is_staff': is_staff, 'body': message, 'created_at': now})
    # A customer replying reopens a ticket staff had marked resolved; staff
    # replying doesn't change status on its own — they close it explicitly.
    if not is_staff and ticket.get('status') == 'closed':
        ticket['status'] = 'open'
    ticket['updated_at'] = now
    _write_json(_ticket_key(target_org, ticket_id), ticket)

    idx = _read_json(_support_index_key(target_org), default={'tickets': []})
    for t in idx['tickets']:
        if t['id'] == ticket_id:
            t['updated_at'] = now
            t['status'] = ticket['status']
            t['message_count'] = len(ticket['messages'])
            break
    _write_json(_support_index_key(target_org), idx)

    return _resp(200, {'ok': True})


def set_ticket_status(org, caller_email, ticket_id, event):
    if not _is_staff(caller_email):
        return _resp(403, {'error': 'only APRABot support can close or reopen a ticket'})
    target_org = _find_ticket_org(ticket_id)
    if target_org is None:
        return _resp(404, {'error': 'ticket not found'})

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})
    status = (body.get('status') or '').strip().lower()
    if status not in ('open', 'closed'):
        return _resp(400, {'error': 'status must be "open" or "closed"'})

    ticket = _read_json(_ticket_key(target_org, ticket_id))
    if ticket is None:
        return _resp(404, {'error': 'ticket not found'})
    ticket['status'] = status
    ticket['updated_at'] = _now()
    _write_json(_ticket_key(target_org, ticket_id), ticket)

    idx = _read_json(_support_index_key(target_org), default={'tickets': []})
    for t in idx['tickets']:
        if t['id'] == ticket_id:
            t['status'] = status
            t['updated_at'] = ticket['updated_at']
            break
    _write_json(_support_index_key(target_org), idx)

    return _resp(200, {'ok': True})


def _baseline_comparison(org, scenario_id, base_id=None):
    valid_id = r'scn-\d+-[a-f0-9]+'
    if not re.fullmatch(valid_id, scenario_id or '') or (base_id and not re.fullmatch(valid_id, base_id)):
        return _resp(400, {'error': 'Choose a valid scenario.'})
    prefix = f'orgs/{org}'
    base = _read_json(f'{prefix}/scenarios/{base_id}/result.json') if base_id else _read_json(f'{prefix}/forecast/latest.json')
    variant = _read_json(f'{prefix}/scenarios/{scenario_id}/result.json')
    if not base or not base.get('id') or not variant:
        return _resp(404, {'error': 'Forecast comparison is unavailable for these revisions.'})
    base_map = _read_json(f'{prefix}/scenarios/{base["id"]}/anon.json') or {}
    variant_map = _read_json(f'{prefix}/scenarios/{scenario_id}/anon.json') or {}
    if not base_map or not variant_map:
        return _resp(200, {'base': base, 'rows': [], 'detail_available': False})
    weeks = {week: i for i, week in enumerate(base['weeks']) if i >= base.get('backtestWeeks', len(base['weeks']))}
    periods = [(weeks[week], i) for i, week in enumerate(variant['weeks'])
               if i >= variant.get('backtestWeeks', len(variant['weeks'])) and week in weeks]
    if not periods:
        return _resp(200, {'base': base, 'rows': [], 'detail_available': False})

    def total(series, side):
        values = series.get('f', [])
        selected = [values[p[side]] if p[side] < len(values) else None for p in periods]
        return sum(selected) if all(value is not None for value in selected) else None

    rows = []
    for product, sku in base_map.items():
        left = base['skus'].get(sku, {}).get('byZip', {})
        right = variant['skus'].get(variant_map.get(product), {}).get('byZip', {})
        for postal in left.keys() & right.keys():
            a, b = total(left[postal], 0), total(right[postal], 1)
            if a is not None and b is not None:
                rows.append({'sku': sku, 'postal_code': postal, 'base': a, 'scenario': b, 'change': b - a})
    rows.sort(key=lambda row: (-abs(row['change']), row['sku'], row['postal_code']))
    return _resp(200, {'base': base, 'rows': rows[:100], 'detail_available': True})


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path   = event.get('requestContext', {}).get('http', {}).get('path', '')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        caller_email = _claims(event).get('email')
        org = _org_id(caller_email)

        m = re.match(r'^/scenarios/([^/]+)/approve$', path)
        if method == 'POST' and m:
            return approve_scenario(org, m.group(1), event)

        m = re.match(r'^/scenarios/([^/]+)/result$', path)
        if method == 'GET' and m:
            return get_result(org, m.group(1))

        if method == 'GET' and path == '/scenarios/approvals':
            return list_approvals(org)

        if method == 'GET' and path == '/scenarios/members':
            return list_members(org, caller_email)

        if method == 'POST' and path == '/scenarios/members/role':
            return set_member_role(org, caller_email, event)

        if path == '/scenarios' and (event.get('queryStringParameters') or {}).get('view') == 'schemes' and method in ('GET', 'POST'):
            return _discount_schemes(org, caller_email, method, event)

        query = event.get('queryStringParameters') or {}
        if method == 'GET' and path == '/scenarios' and query.get('view') == 'inbound':
            return inbound_view(org, caller_email)

        # Before the plain POST below, which starts a forecast run.
        if path == '/scenarios' and method == 'POST' and query.get('view'):
            if query['view'] == 'stock':
                return save_stock(org, caller_email, event)
            return _resp(404, {'error': f'no view {query["view"]}'})

        if method == 'GET' and path == '/scenarios' and query.get('view') == 'baseline':
            return _baseline_comparison(org, query.get('scenario'), query.get('base'))

        if method == 'GET' and path == '/scenarios':
            return list_scenarios(org, caller_email)

        if method == 'POST' and path == '/scenarios':
            return create_scenario(org, event)

        if method == 'POST' and path == '/scenarios/upload-url':
            return create_upload_url(org, event)

        if method == 'GET' and path == '/tickets':
            return list_tickets(org, caller_email)

        if method == 'POST' and path == '/tickets':
            return create_ticket(org, caller_email, event)

        m = re.match(r'^/tickets/([^/]+)/reply$', path)
        if method == 'POST' and m:
            return reply_ticket(org, caller_email, m.group(1), event)

        m = re.match(r'^/tickets/([^/]+)/status$', path)
        if method == 'POST' and m:
            return set_ticket_status(org, caller_email, m.group(1), event)

        m = re.match(r'^/tickets/([^/]+)$', path)
        if method == 'GET' and m:
            return get_ticket(org, caller_email, m.group(1))

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
