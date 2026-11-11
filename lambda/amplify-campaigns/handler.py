import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

from platform_clients import meta_mock as meta_client
from platform_clients import google_mock as google_client

s3  = boto3.client('s3')
ddb = boto3.resource('dynamodb')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
TABLE_NAME = os.environ.get('TABLE_NAME', 'aprabot-amplify')
table = ddb.Table(TABLE_NAME)


def _json_default(o):
    # boto3's DynamoDB resource API returns all numbers as Decimal — every
    # numeric attribute this Lambda writes (daily_budget_cents, version) is
    # always a plain int, so round-tripping through int() here is exact,
    # never a float-precision concern.
    if isinstance(o, Decimal):
        return int(o)
    raise TypeError(f'Object of type {type(o).__name__} is not JSON serializable')

PLATFORMS = {'meta': meta_client, 'google': google_client}
ALLOWED_OBJECTIVES = {'awareness', 'traffic', 'conversions', 'sales'}

# ---- organization scoping — identical copy to scenarios-api/handler.py's
# (no shared layer between Lambdas in this repo — see that file for the
# full rationale). ----
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


# Reuses the SAME members.json as scenarios-api — admin status is an
# org-level concept (who can approve a forecast scenario, who can spend real
# ad budget), not a per-module one. Deliberately not amplify/members.json.
def _members_key(org):
    return f'orgs/{org}/scenarios/members.json'


def _is_admin(org, email):
    members = _read_json(_members_key(org))
    if members is None:
        return True
    return (email or '').strip().lower() in members.get('admins', [])


CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _resp(status, body):
    return {'statusCode': status, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps(body, default=_json_default)}


def _read_json(key, default=None):
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        return json.loads(obj['Body'].read().decode('utf-8'))
    except s3.exceptions.NoSuchKey:
        return default
    except s3.exceptions.ClientError:
        return default


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


# ---- limits — orgs/{org}/amplify/limits.json, same "absent = default"
# convention as scenarios/members.json. Server-side enforcement only —
# never trust a client-side disabled button for a real-money ceiling. ----
_DEFAULT_DAILY_BUDGET_CENTS_MAX = 50000  # $500/day, conservative v1 default


def _budget_ceiling(org):
    limits = _read_json(f'orgs/{org}/amplify/limits.json')
    if limits is None:
        return _DEFAULT_DAILY_BUDGET_CENTS_MAX
    return int(limits.get('daily_budget_cents_max', _DEFAULT_DAILY_BUDGET_CENTS_MAX))


# ---- DynamoDB item helpers (first table in this stack — see the Amplify
# plan for why: campaign edits/pauses genuinely race with the scheduled sync
# worker, which S3's last-write-wins JSON blobs can't safely arbitrate). ----
def _campaign_sk(platform, campaign_id):
    return f'CAMP#{platform}#{campaign_id}'


def _get_campaign_item(org, platform, campaign_id):
    resp = table.get_item(Key={'pk': f'ORG#{org}', 'sk': _campaign_sk(platform, campaign_id)})
    return resp.get('Item')


def _write_audit(org, action, actor_email, entity_type, entity_id, platform,
                  before, after, result, platform_request_id=None):
    """Append-only, written synchronously right after the action completes —
    unlike scenario-runner's best-effort insights invoke, a real-money
    action's audit entry must fail loud (raise), not degrade silently, since
    it's the only record of who changed a live ad budget/status."""
    table.put_item(Item={
        'pk': f'ORG#{org}',
        'sk': f"AUDIT#{_now()}#{uuid.uuid4().hex[:8]}",
        'entity_type': 'audit',
        'action': action,
        'actor_email': actor_email,
        'target_entity_type': entity_type,
        'target_entity_id': entity_id,
        'platform': platform,
        'before': before,
        'after': after,
        'result': result,
        'platform_request_id': platform_request_id,
    })


def list_campaigns(org):
    resp = table.query(
        KeyConditionExpression=Key('pk').eq(f'ORG#{org}') & Key('sk').begins_with('CAMP#'),
    )
    items = sorted(resp.get('Items', []), key=lambda i: i.get('created_at', ''), reverse=True)
    return _resp(200, {'campaigns': items})


def create_campaign(org, caller_email, event, dry_run=False):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    name = (body.get('name') or '').strip()
    platform = (body.get('platform') or '').strip().lower()
    objective = (body.get('objective') or '').strip().lower()
    try:
        daily_budget_cents = int(body.get('daily_budget_cents', 0))
    except (TypeError, ValueError):
        return _resp(400, {'error': 'daily_budget_cents must be an integer'})

    if not name:
        return _resp(400, {'error': 'name is required'})
    if platform not in PLATFORMS:
        return _resp(400, {'error': f'platform must be one of {sorted(PLATFORMS)}'})
    if objective not in ALLOWED_OBJECTIVES:
        return _resp(400, {'error': f'objective must be one of {sorted(ALLOWED_OBJECTIVES)}'})
    if daily_budget_cents <= 0:
        return _resp(400, {'error': 'daily_budget_cents must be positive'})
    ceiling = _budget_ceiling(org)
    if daily_budget_cents > ceiling:
        return _resp(400, {'error': f'daily_budget_cents exceeds this organization\'s cap '
                                     f'({ceiling} cents/day) — see Settings to request a higher limit'})

    if dry_run:
        return _resp(200, {'dry_run': True, 'would_create': {
            'name': name, 'platform': platform, 'objective': objective,
            'daily_budget_cents': daily_budget_cents,
        }})

    campaign_id = uuid.uuid4().hex[:16]
    now = _now()
    item = {
        'pk': f'ORG#{org}',
        'sk': _campaign_sk(platform, campaign_id),
        'entity_type': 'campaign',
        'campaign_id': campaign_id,
        'platform': platform,
        'name': name,
        'objective': objective,
        'daily_budget_cents': daily_budget_cents,
        'status': 'draft',
        'external_id': None,
        'version': 1,
        'pending_write': True,  # claimed immediately — cleared below once the platform call resolves
        'created_by': caller_email,
        'created_at': now,
        'updated_at': now,
        'gsi1pk': f'PLATFORM#{platform}#STATUS#draft',
        'gsi1sk': f'ORG#{org}#{campaign_id}',
    }
    table.put_item(Item=item)

    client = PLATFORMS[platform]
    try:
        platform_result = client.create_campaign(connection=None, campaign=item)
        item['external_id'] = platform_result['external_id']
        item['status'] = 'active'
        item['pending_write'] = False
        item['gsi1pk'] = f'PLATFORM#{platform}#STATUS#active'
        item['updated_at'] = _now()
        table.put_item(Item=item)
        _write_audit(org, 'create', caller_email, 'campaign', campaign_id, platform,
                      before=None, after=item, result='success',
                      platform_request_id=platform_result.get('external_id'))
        return _resp(201, item)
    except Exception as exc:
        # Left pending_write=true on purpose — see the Amplify plan's
        # idempotency section. Local state never assumes the platform call
        # actually failed vs. just timed out on our end; a retry/reconcile
        # path (manual, or the sync worker) must re-check platform truth
        # rather than trusting this local row.
        _write_audit(org, 'create', caller_email, 'campaign', campaign_id, platform,
                      before=None, after=item, result='failed')
        return _resp(502, {'error': f'platform call failed: {exc}', 'campaign_id': campaign_id,
                            'note': 'campaign record was created locally but the platform call '
                                     'failed — retry the same campaign_id rather than creating a new one'})


def get_campaign(org, platform, campaign_id):
    item = _get_campaign_item(org, platform, campaign_id)
    if item is None:
        return _resp(404, {'error': 'campaign not found'})
    return _resp(200, item)


def update_campaign(org, platform, campaign_id, caller_email, event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    item = _get_campaign_item(org, platform, campaign_id)
    if item is None:
        return _resp(404, {'error': 'campaign not found'})
    if item.get('pending_write'):
        return _resp(409, {'error': 'this campaign has a write in progress — try again shortly'})

    patch = {}
    if 'name' in body:
        patch['name'] = (body['name'] or '').strip()
        if not patch['name']:
            return _resp(400, {'error': 'name cannot be empty'})
    if 'daily_budget_cents' in body:
        try:
            patch['daily_budget_cents'] = int(body['daily_budget_cents'])
        except (TypeError, ValueError):
            return _resp(400, {'error': 'daily_budget_cents must be an integer'})
        if patch['daily_budget_cents'] <= 0:
            return _resp(400, {'error': 'daily_budget_cents must be positive'})
        ceiling = _budget_ceiling(org)
        if patch['daily_budget_cents'] > ceiling:
            return _resp(400, {'error': f'daily_budget_cents exceeds this organization\'s cap '
                                         f'({ceiling} cents/day)'})
    if not patch:
        return _resp(400, {'error': 'no editable fields in request body'})

    before = dict(item)
    try:
        # Optimistic lock: claim pending_write, bump version, only succeeds
        # if nothing else has touched this row since we read it above.
        table.update_item(
            Key={'pk': item['pk'], 'sk': item['sk']},
            UpdateExpression='SET pending_write = :true',
            ConditionExpression=Attr('version').eq(item['version']) & Attr('pending_write').eq(False),
            ExpressionAttributeValues={':true': True},
        )
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return _resp(409, {'error': 'campaign was modified concurrently — reload and retry'})
        raise

    client = PLATFORMS[platform]
    try:
        client.update_campaign(connection=None, external_id=item.get('external_id'), patch=patch)
        after = dict(item)
        after.update(patch)
        after['version'] = item['version'] + 1
        after['pending_write'] = False
        after['updated_at'] = _now()
        table.put_item(Item=after)
        _write_audit(org, 'update', caller_email, 'campaign', campaign_id, platform,
                      before=before, after=after, result='success')
        return _resp(200, after)
    except Exception as exc:
        _write_audit(org, 'update', caller_email, 'campaign', campaign_id, platform,
                      before=before, after=None, result='failed')
        # Leave pending_write=true — same reconciliation story as create_campaign.
        return _resp(502, {'error': f'platform call failed: {exc}'})


def _set_campaign_status(org, platform, campaign_id, caller_email, new_status):
    """Shared by pause/resume — own dedicated routes (not a generic PATCH),
    same reasoning as /scenarios/{id}/approve being its own route: a status
    transition needs its own guardrail/audit semantics, not a bag-of-fields edit."""
    item = _get_campaign_item(org, platform, campaign_id)
    if item is None:
        return _resp(404, {'error': 'campaign not found'})
    if item.get('pending_write'):
        return _resp(409, {'error': 'this campaign has a write in progress — try again shortly'})
    if item.get('status') == new_status:
        return _resp(200, item)  # already in the desired state — no-op, not an error

    before = dict(item)
    try:
        table.update_item(
            Key={'pk': item['pk'], 'sk': item['sk']},
            UpdateExpression='SET pending_write = :true',
            ConditionExpression=Attr('version').eq(item['version']) & Attr('pending_write').eq(False),
            ExpressionAttributeValues={':true': True},
        )
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return _resp(409, {'error': 'campaign was modified concurrently — reload and retry'})
        raise

    client = PLATFORMS[platform]
    try:
        client.set_status(connection=None, external_id=item.get('external_id'), status=new_status)
        after = dict(item)
        after['status'] = new_status
        after['version'] = item['version'] + 1
        after['pending_write'] = False
        after['updated_at'] = _now()
        after['gsi1pk'] = f'PLATFORM#{platform}#STATUS#{new_status}'
        table.put_item(Item=after)
        _write_audit(org, new_status, caller_email, 'campaign', campaign_id, platform,
                      before=before, after=after, result='success')
        return _resp(200, after)
    except Exception as exc:
        _write_audit(org, new_status, caller_email, 'campaign', campaign_id, platform,
                      before=before, after=None, result='failed')
        return _resp(502, {'error': f'platform call failed: {exc}'})


def list_audit(org):
    resp = table.query(
        KeyConditionExpression=Key('pk').eq(f'ORG#{org}') & Key('sk').begins_with('AUDIT#'),
        ScanIndexForward=False,  # newest first
    )
    return _resp(200, {'entries': resp.get('Items', [])})


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path   = event.get('requestContext', {}).get('http', {}).get('path', '')
    qs     = event.get('queryStringParameters') or {}
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        caller_email = _claims(event).get('email')
        org = _org_id(caller_email)

        if method == 'GET' and path == '/amplify-campaigns':
            return list_campaigns(org)

        if method == 'POST' and path == '/amplify-campaigns':
            if not _is_admin(org, caller_email):
                return _resp(403, {'error': 'only an admin can create a campaign for this organization'})
            dry_run = (qs.get('dry_run') or '').lower() == 'true'
            return create_campaign(org, caller_email, event, dry_run=dry_run)

        if method == 'GET' and path == '/amplify-campaigns/audit':
            return list_audit(org)

        m = re.match(r'^/amplify-campaigns/([a-z]+)/([^/]+)/pause$', path)
        if method == 'POST' and m:
            if not _is_admin(org, caller_email):
                return _resp(403, {'error': 'only an admin can pause a campaign for this organization'})
            return _set_campaign_status(org, m.group(1), m.group(2), caller_email, 'paused')

        m = re.match(r'^/amplify-campaigns/([a-z]+)/([^/]+)/resume$', path)
        if method == 'POST' and m:
            if not _is_admin(org, caller_email):
                return _resp(403, {'error': 'only an admin can resume a campaign for this organization'})
            return _set_campaign_status(org, m.group(1), m.group(2), caller_email, 'active')

        m = re.match(r'^/amplify-campaigns/([a-z]+)/([^/]+)$', path)
        if method == 'GET' and m:
            return get_campaign(org, m.group(1), m.group(2))

        if method == 'PATCH' and m:
            if not _is_admin(org, caller_email):
                return _resp(403, {'error': 'only an admin can edit a campaign for this organization'})
            return update_campaign(org, m.group(1), m.group(2), caller_email, event)

        return _resp(404, {'error': f'no route for {method} {path}'})

    except Exception as exc:
        return _resp(500, {'error': str(exc)})
