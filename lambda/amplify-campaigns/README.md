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

## Currency: yen, not USD cents

Every money field in this module (`daily_budget_yen`, recommendation budgets, performance
spend) is a plain integer yen — `forecast/latest.json`'s `avgPrice` is JPY (the underlying
business is Japanese bottled-water demand; real per-unit prices in the 800-2000 range only
make sense as yen, never USD cents). Mixing a USD-denominated ad-economics assumption
against yen prices was a real bug caught during development (produced an absurd ~56x
ROAS) — if you add any new money field here, make sure it's yen, not cents.

## AI Opportunities recommendation engine (`GET /amplify-campaigns/recommendations`)

Every number is derived from real data already in this app (`forecast/latest.json`,
`forecast/latest_inventory.json`) via a transparent, documented heuristic (see the
constants block near the top of `handler.py`) — never Bedrock-generated, never a
placeholder. Two archetypes: **growth** (rising forward trend + healthy inventory) and
**clear_overstock** (inventory well above near-term forecasted demand). A recommendation
is never surfaced if the heuristic itself predicts a sub-1x ROAS — "advertise this"
should never come with a self-contradictory "...but it'll lose money" attached.

Revisit `_ASSUMED_CPM_YEN`/`_ASSUMED_CTR`/`_ASSUMED_CVR` once real campaign performance
data (from `amplify-sync-worker`) accumulates — they're currently moderate, credible
estimates, not calibrated against this organization's own real ad history (there isn't
any yet).

## Products panel: two independent catalogs, not merged

The Products panel shows two plain, separate lists — deliberately not merged with each
other or with the forecast-SKU system, since there's no reliable shared identifier to
auto-match any of them (see "Per-org SKU labels" below for why that still matters
elsewhere, even though the Products panel itself no longer shows the raw forecast-SKU
table):

- **Shopify catalog** (`GET /amplify-campaigns/shopify-products`) — real product/variant
  names, images, and live on-hand inventory (`_shopify_inventory_on_hand`, batched in
  groups of 50 — Shopify's own cap on `inventory_item_ids` per call), shown the moment an
  org connects Shopify, no action required. The frontend's Refresh button just re-calls
  this same route — it's always a fresh, uncached read already, nothing to invalidate.

  Also merges in real recent sales per variant (`_shopify_recent_sales`: units sold,
  revenue, in the store's own currency) from actual orders in the last
  `_SHOPIFY_SALES_WINDOW_DAYS` (60) — genuine history, not a demand estimate, but capped
  at 60 days because going further back needs Shopify's own `read_all_orders` scope,
  which requires a separate "protected customer data" review, not just an OAuth scope
  addition. Best-effort and isolated from the rest of this route: an org that connected
  before `read_orders` was added to the Shopify OAuth scope will get a 403 on just this
  part (its existing token predates the scope) — the response still includes real
  products/inventory, just without the two sales columns, until that org reconnects.
- **Manual catalog** (`GET/POST /amplify-campaigns/manual-catalog`,
  `PATCH/DELETE /amplify-campaigns/manual-catalog/{id}`) — a plain admin-maintained list
  (`orgs/{org}/amplify/manual_catalog.json`, dict keyed by a generated id), fully
  independent of Shopify and of forecast SKUs. For products Shopify doesn't have, or orgs
  with no Shopify connection at all.

## Per-org SKU labels (`GET/PUT /amplify-campaigns/sku-labels`)

The forecast catalog itself is fully anonymized (`SKU-001`, no names/images anywhere in
the pipeline) by deliberate policy. This endpoint is how a forecast SKU gets a real human
label/image (`orgs/{org}/amplify/sku_labels.json`) — still read by AI Opportunities and
the Campaign Builder wizard for each recommendation's display name/photo, even though the
Products panel no longer shows a UI to edit it (removed in favor of the two independent
catalogs above — there was no reliable way to auto-match a forecast SKU to a Shopify
product anyway, so pairing SKU-editing with "browse your Shopify catalog" implied a
connection that didn't really exist). The endpoint and its validation
(`sku` must match `SKU-\d+`, `image_url` must be `https://`, admin-only) are unchanged;
`shopify_product_id`/`shopify_variant_id`/`shopify_inventory_item_id`/`source` fields it
accepts are still there for any future UI that wants to wire a SKU to a specific product.

`GET /sku-labels` also enriches any Shopify-linked SKU with a live
`shopify_inventory_on_hand` figure (real on-hand units from the store right now) —
**alongside**, never replacing, `latest_inventory.json`'s Cycle+Safety Stock numbers.
Those answer "how much *should* be stocked" from demand history; this answers "how much
really *is* on the shelf." Best-effort: a Shopify API hiccup just omits that one field,
never fails the whole response (the label data itself is always real and already
persisted).

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
`orgs/*/amplify/*` read/write and `orgs/*/forecast/*` read-only — the latter needed so
the recommendation engine can read real forecast/inventory data, plus a narrow
`secretsmanager:GetSecretValue` on `amplify/*/shopify/*` so `get_shopify_products`/the
inventory lookup can read an org's stored Shopify token — this Lambda doesn't touch
Meta/Google tokens at all, those stay exclusive to `amplify-oauth`/`amplify-sync-worker`).
Routes live on the same `ktksptlz75` API Gateway as every other Lambda in this app,
behind the same Cognito JWT authorizer (`aprabot-cognito-jwt`) already protecting
`/scenarios`.

**Note**: the API-level CORS config needed `PATCH` (Milestone 0) and later `PUT`
(sku-labels) added to `AllowMethods` — same class of bug as the Knowledge Base tab's
PUT-CORS issue (the API-level `CorsConfiguration` handles preflight automatically and is
separate from this Lambda's own response headers; a missing method there is invisible to
`curl`/direct invoke, only a real browser enforces it). This Lambda's own `CORS` dict in
`handler.py` needs to list every method it actually uses too, not just the API-level one.
