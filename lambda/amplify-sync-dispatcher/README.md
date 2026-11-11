# aprabot-amplify-sync-dispatcher

EventBridge-scheduled fan-out for Amplify's performance sync. Queries DynamoDB's GSI1
(`gsi1pk = PLATFORM#{platform}#STATUS#active`, one query per platform, not a table scan)
for every active campaign across every org, and pushes one SQS message per unit of work
onto `amplify-sync-queue` for `aprabot-amplify-sync-worker` to pick up.

Does NOT call Meta/Google itself — only decides what needs syncing. This is a different
shape from the existing `scenario-runner -> explain-runner` one-shot async invoke: that's
single-org/single-event; this is recurring and multi-tenant, sharing one app-level API
quota per platform across every org, which is why the fan-out goes through SQS (gives the
worker's reserved concurrency a real rate-limit-respecting knob) rather than direct
`lam.invoke` calls.

## Deploy

```bash
zip -rq amplify-sync-dispatcher.zip handler.py
aws s3 cp amplify-sync-dispatcher.zip s3://aprabot-forecast-751835847089/_deploy/amplify-sync-dispatcher.zip
aws lambda update-function-code --function-name aprabot-amplify-sync-dispatcher \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/amplify-sync-dispatcher.zip
```

Env vars: `TABLE_NAME`, `SYNC_QUEUE_URL`.

## Trigger — deliberately not wired up to a recurring schedule yet

An EventBridge scheduled rule to invoke this automatically (e.g. `rate(4 hours)`) was
NOT created as part of Milestone 0 — a recurring, indefinitely-firing cron job is a
standing automation that needs explicit sign-off, not something to enable as a side effect
of building the pipeline. The dispatcher and worker are both fully built and verified via
direct invoke; wiring the actual schedule is a one-line `aws events put-rule` +
`put-targets` once that's explicitly wanted.
