import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3

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
    return _resp(200, {'scenarios': scenarios, 'you_are_admin': _is_admin(org, caller_email)})


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
    _write_json(f'orgs/{org}/scenarios/{scenario_id}/config.json', config)

    idx = _read_json(f'orgs/{org}/scenarios/index.json', default={'scenarios': []})
    idx['scenarios'].append({k: config[k] for k in
                              ('id', 'label', 'status', 'known_prices', 'calibrate',
                               'weather', 'refresh_days', 'custom_input',
                               'requested_by', 'created_at', 'approved')})
    _write_json(f'orgs/{org}/scenarios/index.json', idx)

    runner_payload = {
        'org_id': org,
        'scenario_id': scenario_id, 'label': label,
        'known_prices': known_prices, 'calibrate': calibrate,
        'weather': weather, 'refresh_days': refresh_days,
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

        if method == 'GET' and path == '/scenarios':
            return list_scenarios(org, caller_email)

        if method == 'POST' and path == '/scenarios':
            return create_scenario(org, event)

        if method == 'POST' and path == '/scenarios/upload-url':
            return create_upload_url(org, event)

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
