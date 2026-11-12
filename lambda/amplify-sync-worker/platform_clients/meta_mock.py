"""Mock Meta Marketing API client — stands in for meta_client.py until Meta's
App Review clears (see Milestone 0/1 in the Amplify plan). Same function
signatures as the real client will have, so handler.py never needs to change
when this gets swapped out — only the import at the top of handler.py does.

A campaign named literally "FORCE_FAIL" simulates a platform-side failure on
create/update/set_status, for exercising the pending_write/idempotency retry
path (see handler.py's _call_platform) without needing a real API to fail.
"""
import random
import time
import uuid


def _maybe_fail(name):
    if (name or '') == 'FORCE_FAIL':
        raise RuntimeError('mock Meta API: simulated failure for FORCE_FAIL campaign')


def get_performance(connection, external_id, date):
    """Daily performance stats for one campaign — stands in for the real
    Marketing API's Insights endpoint. Deterministic per (external_id, date)
    so repeated syncs of the same day don't produce different numbers,
    matching how a real write-once performance snapshot should behave."""
    time.sleep(0.05)
    rng = random.Random(f'{external_id}:{date}')
    impressions = rng.randint(500, 20000)
    clicks = rng.randint(10, max(11, impressions // 20))
    spend_yen = rng.randint(500, 50000)
    conversions = rng.randint(0, max(1, clicks // 10))
    return {'date': date, 'impressions': impressions, 'clicks': clicks,
            'spend_yen': spend_yen, 'conversions': conversions}


def create_campaign(connection, campaign):
    _maybe_fail(campaign.get('name'))
    time.sleep(0.05)  # simulate real network latency, keeps this honest in timing tests
    return {'external_id': f"mock-meta-{uuid.uuid4().hex[:12]}", 'status': 'ACTIVE'}


def update_campaign(connection, external_id, patch):
    _maybe_fail(patch.get('name'))
    time.sleep(0.05)
    return {'external_id': external_id, 'status': patch.get('status', 'ACTIVE')}


def set_status(connection, external_id, status):
    time.sleep(0.05)
    return {'external_id': external_id, 'status': 'PAUSED' if status == 'paused' else 'ACTIVE'}
