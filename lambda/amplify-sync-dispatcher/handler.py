"""EventBridge-triggered fan-out for Amplify's performance sync — see the
Amplify plan's section on why this is a different shape from the existing
scenario-runner->explain-runner one-shot async invoke: this is recurring
and multi-tenant, sharing one app-level API quota per platform across every
org, so the fan-out goes through SQS (gives a real concurrency-cap knob on
the consumer side, see amplify-sync-worker) rather than direct lam.invoke
calls per campaign.

Does NOT call Meta/Google itself — only decides WHAT needs syncing and
queues it. Queries GSI1 (gsi1pk = PLATFORM#{platform}#STATUS#active) so this
is one query per platform, not a full-table scan, regardless of org count.
"""
import json
import os
from datetime import datetime, timezone

import boto3

ddb = boto3.resource('dynamodb')
sqs = boto3.client('sqs')
TABLE_NAME = os.environ.get('TABLE_NAME', 'aprabot-amplify')
QUEUE_URL  = os.environ['SYNC_QUEUE_URL']
table = ddb.Table(TABLE_NAME)

PLATFORMS = ('meta', 'google')


def handler(event, context):
    today = datetime.now(timezone.utc).date().isoformat()
    queued = 0
    for platform in PLATFORMS:
        resp = table.query(
            IndexName='GSI1',
            KeyConditionExpression='gsi1pk = :pk',
            ExpressionAttributeValues={':pk': f'PLATFORM#{platform}#STATUS#active'},
        )
        for item in resp.get('Items', []):
            org_id = item['pk'].split('#', 1)[1]
            sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps({
                'org_id': org_id,
                'platform': platform,
                'campaign_id': item['campaign_id'],
                'external_id': item.get('external_id'),
                'date': today,
            }))
            queued += 1
    print(f"[dispatcher] queued {queued} sync job(s) for {today}")
    return {'queued': queued}
