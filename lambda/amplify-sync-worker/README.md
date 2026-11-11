# aprabot-amplify-sync-worker

SQS consumer for Amplify's performance sync — one message per org x platform x campaign,
queued by `aprabot-amplify-sync-dispatcher`. Fetches that campaign's daily performance
stats (mocked for Milestone 0 — see `platform_clients/`) and writes a write-once S3
snapshot (`orgs/{org}/amplify/performance/{platform}/{campaign_id}/{date}.json`, never
read-modify-written again once produced), then updates the campaign's `last_synced_at` in
DynamoDB.

Returns `batchItemFailures` (SQS's partial-batch-failure response) so one bad message gets
retried without failing messages that succeeded in the same batch.

## The actual rate-limit mechanism

Nothing in this handler's own code enforces a call-rate cap — it's this function's
**reserved concurrency** Lambda setting that bounds how many of these run at once across
ALL orgs sharing one app's Meta/Google API quota. **Not currently set** — this AWS
account's total concurrency limit is only 10 (default, no quota increase requested),
which is below the floor AWS requires to carve out any reserved concurrency at all. Fine
for Milestone 0's manual-testing scale; revisit (request a quota increase, then set
reserved concurrency, e.g. 5) before any real multi-org sync volume.

## Deploy

```bash
zip -rq amplify-sync-worker.zip handler.py platform_clients/
aws s3 cp amplify-sync-worker.zip s3://aprabot-forecast-751835847089/_deploy/amplify-sync-worker.zip
aws lambda update-function-code --function-name aprabot-amplify-sync-worker \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/amplify-sync-worker.zip
```

Env vars: `BUCKET_NAME`, `TABLE_NAME`. Triggered by an SQS event source mapping on
`amplify-sync-queue` (batch size 5, `ReportBatchItemFailures`).
