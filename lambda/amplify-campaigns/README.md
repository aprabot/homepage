# aprabot-amplify-campaigns

Campaign CRUD for Amplify (aprabot.com/amplify) — create/edit/pause/resume real ad
campaigns on Meta and Google Ads. See the Amplify plan for full context on why this
module exists and its phased (Milestone 0/1/2) rollout.

## Data store

First DynamoDB table in this stack (`aprabot-amplify`, on-demand billing), not the usual
S3-JSON convention — campaign edits/pauses genuinely race with the scheduled sync worker,
and S3's last-write-wins semantics can't safely arbitrate that. Single-table design:

| PK | SK | Entity |
|---|---|---|
| `ORG#{org_id}` | `CAMP#{platform}#{campaign_id}` | campaign (`version` for optimistic locking, `pending_write` for idempotency) |
| `ORG#{org_id}` | `AUDIT#{iso_ts}#{uuid}` | append-only audit entry |

GSI1 (`gsi1pk = PLATFORM#{platform}#STATUS#{status}`) lets `amplify-sync-dispatcher` find
all active campaigns across every org without a full-table scan.

## Idempotency

A write claims an exclusive `pending_write` lock (conditional `UpdateItem`) before calling
the platform API, and clears it only on confirmed success. A failed/crashed call leaves
`pending_write=true` on purpose — that's the signal for reconciliation (manual retry, or a
future sync-worker pass) to re-check the platform's real state rather than trust the local
optimistic write. Never assume a failed call definitely failed on the platform side too.

## Mocked platform clients (Milestone 0)

`platform_clients/{meta,google}_mock.py` stand in for the real Meta Marketing API / Google
Ads API clients until each platform's app review clears (see the Amplify plan). Same
function signatures the real clients will have — swapping to `{platform}_client.py` only
means changing the two `from platform_clients import ... as ...` lines at the top of
`handler.py`. A campaign named literally `FORCE_FAIL` simulates a platform failure, for
exercising the idempotency/retry path without needing a real API to fail.

## Deploy

Pure boto3 — no extra dependencies to install (`boto3`/`botocore` ship with the Lambda
runtime already).

```bash
zip -rq amplify-campaigns.zip handler.py platform_clients/
aws s3 cp amplify-campaigns.zip s3://aprabot-forecast-751835847089/_deploy/amplify-campaigns.zip
aws lambda update-function-code --function-name aprabot-amplify-campaigns \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/amplify-campaigns.zip
```

Env vars: `BUCKET_NAME`, `TABLE_NAME` (default `aprabot-amplify`). Runs under
`aprabot-amplify-lambda-role` (DynamoDB access scoped to this table, S3 scoped to
`orgs/*/amplify/*`). Routes live on the same `ktksptlz75` API Gateway as every other
Lambda in this app, behind the same Cognito JWT authorizer (`aprabot-cognito-jwt`) already
protecting `/scenarios`.

**Note**: the API-level CORS config needed `PATCH` added to `AllowMethods` for this
Lambda's update route — same class of bug as the Knowledge Base tab's PUT-CORS issue
(the API-level `CorsConfiguration` handles preflight automatically and is separate from
this Lambda's own response headers; a missing method there is invisible to `curl`/direct
invoke, only a real browser enforces it).
