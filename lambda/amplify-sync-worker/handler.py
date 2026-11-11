"""SQS consumer for Amplify's performance sync — one message per
org x platform x campaign unit of work, queued by amplify-sync-dispatcher.

The actual rate-limit-respecting mechanism is this function's Lambda
**reserved concurrency** setting (capped low, e.g. 5, at deploy time — see
the Amplify plan), which bounds how many of these run at once across ALL
orgs sharing one app's Meta/Google API quota. Nothing in this handler's own
code enforces that; it's an AWS-side Lambda setting on this function.

Returns batchItemFailures so one bad message (e.g. a transient platform API
error) gets retried by SQS without failing messages that succeeded in the
same batch — see handler()'s return shape.
"""
import json
import os
from datetime import datetime, timezone

import boto3

from platform_clients import meta_mock as meta_client
from platform_clients import google_mock as google_client

s3  = boto3.client('s3')
ddb = boto3.resource('dynamodb')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')
TABLE_NAME = os.environ.get('TABLE_NAME', 'aprabot-amplify')
table = ddb.Table(TABLE_NAME)

PLATFORMS = {'meta': meta_client, 'google': google_client}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sync_one(job):
    org_id = job['org_id']
    platform = job['platform']
    campaign_id = job['campaign_id']
    external_id = job.get('external_id')
    date = job['date']

    if not external_id:
        print(f"[sync-worker] skipping {org_id}/{platform}/{campaign_id} — no external_id yet")
        return

    client = PLATFORMS[platform]
    perf = client.get_performance(connection=None, external_id=external_id, date=date)

    # Write-once: a given (entity, date) key is never read-modify-written
    # again once a sync has produced it — consistent with the existing
    # convention for immutable per-run S3 blobs elsewhere in this app.
    key = f'orgs/{org_id}/amplify/performance/{platform}/{campaign_id}/{date}.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(perf).encode('utf-8'),
                   ContentType='application/json')

    table.update_item(
        Key={'pk': f'ORG#{org_id}', 'sk': f'CAMP#{platform}#{campaign_id}'},
        UpdateExpression='SET last_synced_at = :now',
        ExpressionAttributeValues={':now': _now()},
    )
    print(f"[sync-worker] synced {org_id}/{platform}/{campaign_id} for {date}")


def handler(event, context):
    failures = []
    for record in event.get('Records', []):
        try:
            job = json.loads(record['body'])
            _sync_one(job)
        except Exception as exc:
            print(f"SYNC_WORKER_ERROR[{record.get('messageId')}]: {exc}")
            failures.append({'itemIdentifier': record['messageId']})
    return {'batchItemFailures': failures}
