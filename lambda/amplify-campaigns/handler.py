import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
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
    # numeric attribute this Lambda writes (daily_budget_yen, version) is
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
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS',
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


def _write_json(key, data):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(data).encode('utf-8'),
                   ContentType='application/json')


def _claims(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']
    except (KeyError, TypeError):
        return {}


# ---- limits — orgs/{org}/amplify/limits.json, same "absent = default"
# convention as scenarios/members.json. Server-side enforcement only —
# never trust a client-side disabled button for a real-money ceiling.
#
# Yen, not USD cents: forecast/latest.json's avgPrice is JPY (the underlying
# business is Japanese bottled-water demand — real per-unit prices in the
# 800-2000 range only make sense as yen, never USD). JPY has no commonly-used
# minor unit, so budgets here are plain integer yen throughout, no x100/÷100
# "cents" conversion anywhere in this module. ----
_DEFAULT_DAILY_BUDGET_YEN_MAX = 50000  # ¥50,000/day, conservative v1 default


def _budget_ceiling(org):
    limits = _read_json(f'orgs/{org}/amplify/limits.json')
    if limits is None:
        return _DEFAULT_DAILY_BUDGET_YEN_MAX
    return int(limits.get('daily_budget_yen_max', _DEFAULT_DAILY_BUDGET_YEN_MAX))


# ---- per-org SKU display labels — orgs/{org}/amplify/sku_labels.json, same
# "absent = default" convention as limits.json/members.json. Real,
# customer-entered, opt-in: the catalog itself is fully anonymized
# (SKU-001, no names/images anywhere in the pipeline) by deliberate policy,
# so this is the ONLY place a product gets a human label, and only if an
# org admin chooses to set one. Falls back to the plain SKU id — never a
# fabricated name/photo. ----
def _sku_labels_key(org):
    return f'orgs/{org}/amplify/sku_labels.json'


def get_sku_labels(org):
    labels = _read_json(_sku_labels_key(org), default={})
    return _resp(200, labels)


def put_sku_labels(org, caller_email, event):
    if not _is_admin(org, caller_email):
        return _resp(403, {'error': 'only an admin can edit product labels for this organization'})
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _resp(400, {'error': 'invalid JSON body'})

    sku = (body.get('sku') or '').strip()
    if not re.match(r'^SKU-\d+$', sku):
        return _resp(400, {'error': 'sku must look like SKU-001'})
    label = (body.get('label') or '').strip()[:120]
    image_url = (body.get('image_url') or '').strip()[:500]
    if image_url and not image_url.startswith('https://'):
        return _resp(400, {'error': 'image_url must be an https:// URL'})

    labels = _read_json(_sku_labels_key(org), default={})
    if label or image_url:
        labels[sku] = {'label': label, 'image_url': image_url,
                        'updated_by': caller_email, 'updated_at': _now()}
    else:
        labels.pop(sku, None)  # both fields cleared — revert to the plain SKU id
    _write_json(_sku_labels_key(org), labels)
    return _resp(200, labels.get(sku, {}))


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
    sku = (body.get('sku') or '').strip() or None  # which product this campaign promotes —
                                                    # optional (a campaign created from scratch,
                                                    # not from an AI Opportunity, may not target one
                                                    # specific SKU), but required for Phase B's
                                                    # feedback loop to attribute spend to a SKU.
    try:
        daily_budget_yen = int(body.get('daily_budget_yen', 0))
    except (TypeError, ValueError):
        return _resp(400, {'error': 'daily_budget_yen must be an integer'})
    try:
        duration_days = int(body.get('duration_days', _DEFAULT_CAMPAIGN_DURATION_DAYS))
    except (TypeError, ValueError):
        return _resp(400, {'error': 'duration_days must be an integer'})

    if not name:
        return _resp(400, {'error': 'name is required'})
    if platform not in PLATFORMS:
        return _resp(400, {'error': f'platform must be one of {sorted(PLATFORMS)}'})
    if objective not in ALLOWED_OBJECTIVES:
        return _resp(400, {'error': f'objective must be one of {sorted(ALLOWED_OBJECTIVES)}'})
    if sku is not None and not re.match(r'^SKU-\d+$', sku):
        return _resp(400, {'error': 'sku must look like SKU-001'})
    if daily_budget_yen <= 0:
        return _resp(400, {'error': 'daily_budget_yen must be positive'})
    if duration_days <= 0:
        return _resp(400, {'error': 'duration_days must be positive'})
    ceiling = _budget_ceiling(org)
    if daily_budget_yen > ceiling:
        return _resp(400, {'error': f'daily_budget_yen exceeds this organization\'s cap '
                                     f'({ceiling} yen/day) — see Settings to request a higher limit'})

    if dry_run:
        return _resp(200, {'dry_run': True, 'would_create': {
            'name': name, 'platform': platform, 'objective': objective,
            'sku': sku, 'daily_budget_yen': daily_budget_yen, 'duration_days': duration_days,
        }})

    campaign_id = uuid.uuid4().hex[:16]
    now = _now()
    end_date = (datetime.now(timezone.utc) + timedelta(days=duration_days)).date().isoformat()
    item = {
        'pk': f'ORG#{org}',
        'sk': _campaign_sk(platform, campaign_id),
        'entity_type': 'campaign',
        'campaign_id': campaign_id,
        'platform': platform,
        'name': name,
        'objective': objective,
        'sku': sku,
        'daily_budget_yen': daily_budget_yen,
        'duration_days': duration_days,
        'start_date': now[:10],
        'end_date': end_date,
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
    if 'daily_budget_yen' in body:
        try:
            patch['daily_budget_yen'] = int(body['daily_budget_yen'])
        except (TypeError, ValueError):
            return _resp(400, {'error': 'daily_budget_yen must be an integer'})
        if patch['daily_budget_yen'] <= 0:
            return _resp(400, {'error': 'daily_budget_yen must be positive'})
        ceiling = _budget_ceiling(org)
        if patch['daily_budget_yen'] > ceiling:
            return _resp(400, {'error': f'daily_budget_yen exceeds this organization\'s cap '
                                         f'({ceiling} yen/day)'})
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


# ============================================================================
# AI Opportunities recommendation engine
#
# Every number here is derived from real data already in this app
# (forecast/latest.json, forecast/latest_inventory.json) via a transparent,
# documented heuristic — never Bedrock-generated, never a placeholder. The
# constants below ARE the model; they're named and explained so they can be
# tuned later against real outcomes, not buried as magic numbers.
# ============================================================================

# Ad-economics assumptions — standard Japanese paid-social e-commerce
# benchmarks, in yen (see the currency note on _DEFAULT_DAILY_BUDGET_YEN_MAX
# above — avgPrice is JPY, so every assumption here must be too; mixing a
# USD-denominated CPM against yen prices is exactly the bug that produced an
# absurd ~56x ROAS before this was caught and fixed). Revisit these once
# real campaign performance data (from amplify-sync-worker) accumulates —
# until then this is a deliberately moderate, credible estimate, not tuned
# to produce impressive-looking numbers.
_ASSUMED_CPM_YEN = 300      # ¥300 per 1,000 impressions
_ASSUMED_CTR = 0.01         # 1% click-through rate
_ASSUMED_CVR = 0.03         # 3% click-to-purchase conversion rate
_PREDICTION_BAND = 0.20     # +/-20% range around the point estimate, shown
                            # as a range rather than false single-number precision
_MIN_ROAS_TO_RECOMMEND = 1.0  # never recommend a campaign the heuristic itself predicts loses money

# Archetype thresholds.
_GROWTH_TREND_THRESHOLD_PCT = 10.0   # forward trend must beat this to count as "growing"
_MIN_HEALTHY_WEEKS_OF_SUPPLY = 2.0   # below this, don't advertise — you'd just stock out faster
_OVERSTOCK_WEEKS_OF_SUPPLY = 8.0     # above this, there's real excess to move

# Suggested budget = this fraction of the SKU's own near-term forecasted
# revenue — a conservative ad-spend-to-revenue ratio, not a cap on what the
# org could spend (the org's own daily budget ceiling, _budget_ceiling(),
# is the real enforcement; this just sizes a reasonable starting suggestion).
_BUDGET_REVENUE_FRACTION = 0.15
_DEFAULT_CAMPAIGN_DURATION_DAYS = 14
_NEAR_TERM_WEEKS = 4  # "next month" window for trend/inventory sizing

_CONFIDENCE_BY_TIER = {'High': 90, 'Medium': 70, 'Lower': 50}


def _forecast_sku_stats(forecast):
    """Port of js/main.js's computeForwardStats() SKU-ranking pattern (volume-
    tiered confidence, trend vs. a trailing window of equal length) — reused
    here rather than reinvented, so a SKU's "trend"/"confidence" means the
    same thing everywhere in the product, not two different definitions in
    two different places."""
    weeks = forecast['weeks']
    bt = forecast.get('backtestWeeks', len(weeks))
    total_weeks = len(weeks)
    fwd_weeks = total_weeks - bt
    trail_win = min(fwd_weeks, bt) or 1

    def sum_range(arr, s, e):
        return sum((x or 0) for x in arr[max(0, s):e])

    rows = {}
    for sku, o in forecast['skus'].items():
        a, f = o['a'], o['f']
        backtest_vol = sum_range(a, 0, bt)
        if backtest_vol <= 0:
            continue
        trailing_actual = sum_range(a, bt - trail_win, bt)
        forward_forecast_all = sum_range(f, bt, total_weeks) if fwd_weeks else 0
        trend_pct = (100 * (forward_forecast_all - trailing_actual) / trailing_actual
                     if trailing_actual else None)
        near_term_forecast = sum_range(f, bt, bt + _NEAR_TERM_WEEKS)
        rows[sku] = {
            'backtest_vol': backtest_vol, 'trend_pct': trend_pct,
            'near_term_forecast': near_term_forecast, 'avg_price': o.get('avgPrice'),
        }

    by_vol = sorted(rows.items(), key=lambda kv: kv[1]['backtest_vol'], reverse=True)
    n = len(by_vol) or 1
    for i, (sku, row) in enumerate(by_vol):
        pct = i / n
        row['confidence_tier'] = 'High' if pct < 0.15 else 'Medium' if pct < 0.5 else 'Lower'
    return rows


def _sku_inventory_total(inventory, sku):
    """Most recent month's inventory total for a SKU, summed across every
    postal code — inventory/latest_inventory.json's own grain is SKU x ZIP x
    month (lambda/scenario-runner/handler.py's compute_monthly_inventory());
    this app only ever needs the SKU-level current total."""
    by_zip = (inventory.get('bySku', {}).get(sku) or {}).get('byZip', {})
    if not by_zip:
        return None
    total = 0.0
    for zip_data in by_zip.values():
        series = zip_data.get('total') or []
        if series:
            total += series[-1]  # most recent month
    return total


def get_recommendations(org):
    forecast = _read_json(f'orgs/{org}/forecast/latest.json')
    if forecast is None:
        return _resp(200, {'recommendations': [],
                            'note': 'no approved forecast yet for this organization'})
    inventory = _read_json(f'orgs/{org}/forecast/latest_inventory.json', default={})
    labels = _read_json(_sku_labels_key(org), default={})
    stats = _forecast_sku_stats(forecast)

    recs = []
    for sku, row in stats.items():
        near_term = row['near_term_forecast']
        avg_price = row['avg_price']
        if not avg_price or near_term <= 0:
            continue  # nothing to size a budget/ROAS estimate from

        inv_total = _sku_inventory_total(inventory, sku)
        avg_weekly_near_term = near_term / _NEAR_TERM_WEEKS
        weeks_of_supply = (inv_total / avg_weekly_near_term
                           if inv_total is not None and avg_weekly_near_term > 0 else None)

        trend_pct = row['trend_pct']
        archetype = None
        why = []
        if weeks_of_supply is not None and weeks_of_supply > _OVERSTOCK_WEEKS_OF_SUPPLY:
            archetype = 'clear_overstock'
            why = [
                f'Inventory is at {weeks_of_supply:.1f} weeks of supply — well above near-term '
                f'forecasted demand ({_OVERSTOCK_WEEKS_OF_SUPPLY:.0f}-week threshold)',
                'Advertising now can help move excess stock before it ages further',
            ]
        elif (trend_pct is not None and trend_pct > _GROWTH_TREND_THRESHOLD_PCT
              and (weeks_of_supply is None or weeks_of_supply >= _MIN_HEALTHY_WEEKS_OF_SUPPLY)):
            archetype = 'growth'
            why = [
                f'Demand is forecasted to grow {trend_pct:.1f}% over the current forward horizon',
                (f'Inventory ({weeks_of_supply:.1f} weeks of supply) is healthy — not a constraint '
                 'on fulfilling increased demand') if weeks_of_supply is not None
                else 'No inventory constraint data available for this SKU',
            ]
        if archetype is None:
            continue

        ceiling = _budget_ceiling(org)
        revenue_window_yen = near_term * avg_price
        suggested_total_yen = round(revenue_window_yen * _BUDGET_REVENUE_FRACTION)
        suggested_daily_yen = min(
            round(suggested_total_yen / _DEFAULT_CAMPAIGN_DURATION_DAYS), ceiling)
        suggested_total_yen = suggested_daily_yen * _DEFAULT_CAMPAIGN_DURATION_DAYS

        impressions = suggested_total_yen / _ASSUMED_CPM_YEN * 1000
        clicks = impressions * _ASSUMED_CTR
        purchases_point = clicks * _ASSUMED_CVR
        predicted_revenue_yen = purchases_point * avg_price
        roas = (predicted_revenue_yen / suggested_total_yen) if suggested_total_yen else None

        # Don't surface a recommendation the heuristic itself predicts would
        # lose money — "advertise this" should never come with a sub-1x
        # predicted return attached, that's self-contradictory advice.
        if roas is None or roas < _MIN_ROAS_TO_RECOMMEND:
            continue

        confidence_tier = row['confidence_tier']
        why.append(f'Using "{confidence_tier}" confidence, based on this SKU\'s sales-volume rank '
                    f'among the catalog')
        why.append(f'Predicted purchases assume a ¥{_ASSUMED_CPM_YEN:.0f} CPM, '
                    f'{_ASSUMED_CTR*100:.1f}% click-through, and {_ASSUMED_CVR*100:.0f}% conversion '
                    f'rate — industry-benchmark estimates, not measured from this organization\'s '
                    f'own ad history yet')

        label_info = labels.get(sku, {})
        recs.append({
            'sku': sku,
            'label': label_info.get('label') or sku,
            'image_url': label_info.get('image_url') or None,
            'archetype': archetype,
            'priority': 'high' if archetype == 'growth' else 'watch',
            'suggested_daily_budget_yen': suggested_daily_yen,
            'suggested_total_budget_yen': suggested_total_yen,
            'suggested_duration_days': _DEFAULT_CAMPAIGN_DURATION_DAYS,
            'predicted_purchases_low': round(purchases_point * (1 - _PREDICTION_BAND)),
            'predicted_purchases_high': round(purchases_point * (1 + _PREDICTION_BAND)),
            'predicted_roas': round(roas, 1) if roas is not None else None,
            'confidence_pct': _CONFIDENCE_BY_TIER[confidence_tier],
            'trend_pct': round(trend_pct, 1) if trend_pct is not None else None,
            'weeks_of_supply': round(weeks_of_supply, 1) if weeks_of_supply is not None else None,
            'why': why,
        })

    # High-priority (growth) opportunities first, then by predicted ROAS —
    # surfaces the most convincing cases at the top, same spirit as the
    # existing report's "fastest movers" ranking.
    recs.sort(key=lambda r: (r['priority'] != 'high', -(r['predicted_roas'] or 0)))
    return _resp(200, {'recommendations': recs})


def get_campaign_performance(org, platform, campaign_id):
    """Aggregates the write-once daily snapshots amplify-sync-worker already
    writes (orgs/{org}/amplify/performance/{platform}/{campaign_id}/{date}.json)
    into a time series for the Results panel — this reads data that's been
    populating since Milestone 0, no new write path needed here."""
    item = _get_campaign_item(org, platform, campaign_id)
    if item is None:
        return _resp(404, {'error': 'campaign not found'})

    prefix = f'orgs/{org}/amplify/performance/{platform}/{campaign_id}/'
    days = []
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get('Contents', []):
            snapshot = _read_json(obj['Key'])
            if snapshot:
                days.append(snapshot)
    days.sort(key=lambda d: d['date'])

    totals = {k: sum(d.get(k, 0) for d in days) for k in
              ('impressions', 'clicks', 'spend_yen', 'conversions')}
    return _resp(200, {'campaign_id': campaign_id, 'platform': platform,
                        'days': days, 'totals': totals})


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

        if method == 'GET' and path == '/amplify-campaigns/sku-labels':
            return get_sku_labels(org)

        if method == 'PUT' and path == '/amplify-campaigns/sku-labels':
            return put_sku_labels(org, caller_email, event)

        if method == 'GET' and path == '/amplify-campaigns/recommendations':
            return get_recommendations(org)

        m = re.match(r'^/amplify-campaigns/([a-z]+)/([^/]+)/performance$', path)
        if method == 'GET' and m:
            return get_campaign_performance(org, m.group(1), m.group(2))

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
