"""Mock Google Ads API client — stands in for google_client.py until the
Google Ads Developer Token's Basic Access review clears (see Milestone 0/1
in the Amplify plan). Same function signatures as the real client will have,
so handler.py never needs to change when this gets swapped out — only the
import at the top of handler.py does.

A campaign named literally "FORCE_FAIL" simulates a platform-side failure on
create/update/set_status, for exercising the pending_write/idempotency retry
path (see handler.py's _call_platform) without needing a real API to fail.
"""
import random
import time
import uuid


def _maybe_fail(name):
    if (name or '') == 'FORCE_FAIL':
        raise RuntimeError('mock Google Ads API: simulated failure for FORCE_FAIL campaign')


def get_performance(connection, external_id, date):
    """Daily performance stats for one campaign — stands in for the real
    Google Ads API's GAQL reporting query. Deterministic per (external_id,
    date) so repeated syncs of the same day don't produce different numbers,
    matching how a real write-once performance snapshot should behave."""
    time.sleep(0.05)
    rng = random.Random(f'{external_id}:{date}')
    impressions = rng.randint(500, 20000)
    clicks = rng.randint(10, max(11, impressions // 20))
    spend_cents = rng.randint(500, 50000)
    conversions = rng.randint(0, max(1, clicks // 10))
    return {'date': date, 'impressions': impressions, 'clicks': clicks,
            'spend_cents': spend_cents, 'conversions': conversions}


def create_campaign(connection, campaign):
    _maybe_fail(campaign.get('name'))
    time.sleep(0.05)
    return {'external_id': f"mock-google-{uuid.uuid4().hex[:12]}", 'status': 'ENABLED'}


def update_campaign(connection, external_id, patch):
    _maybe_fail(patch.get('name'))
    time.sleep(0.05)
    return {'external_id': external_id, 'status': patch.get('status', 'ENABLED')}


def set_status(connection, external_id, status):
    time.sleep(0.05)
    return {'external_id': external_id, 'status': 'PAUSED' if status == 'paused' else 'ENABLED'}
