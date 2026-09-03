# aprabot-explain-runner

Async, best-effort companion to `aprabot-scenario-runner`. Computes real per-feature
day-level explainability (`forecast.py --explain`) for the default full-catalog forecast,
decoupled from the main scenario run's own timeout budget.

## Why this is a separate Lambda

`--explain` at full catalog scale (217 series x 364 forward days) makes the whole run
exceed even Lambda's 900s hard ceiling — confirmed 2026-09-03 via real timing: backtest
took ~240s, and the forward+explain phase alone (extra `pred_contrib` model.predict call
per day) extrapolated to ~900s on its own at a measured ~2.5s/explain-day. `scenario-runner`
now runs the main forecast WITHOUT `--explain` (fast, comfortably fits) and fires an async
`Event`-type invoke of this Lambda afterward — the scenario is already `completed` by then,
so a failure here is invisible to the user except that Lyra's day-level quantitative
attribution won't be available for that scenario (chat-api's `explain_forecast_day` tool
already handles a missing `scenarios/{id}/explain/{sku}.json` gracefully).

This Lambda gets its own fresh 900s budget and skips the (expensive) backtest entirely via
forecast.py's `--best-iter` flag — reusing the exact `best_iter` the main run already
computed (see `backtest_2025.meta.json`), so the refit-on-all-data model here matches what
the main run's own internal `forecast_future()` call already produced, instead of
independently re-deriving a possibly-different one.

Also deliberately scoped to `EXPLAIN_HORIZON_DAYS = 182` (~26 weeks) rather than the main
run's full 364-day horizon — explainability questions are realistically about the
near-to-medium term, and covering the full 364 days would itself risk exceeding this
Lambda's own 900s budget given the per-day `--explain` cost.

Custom (user-uploaded) input scenarios do NOT go through this Lambda — those are always
small and `--explain` runs inline in `scenario-runner` for them without any timeout risk.

## Invocation payload

```json
{"scenario_id": "scn-...", "best_iter": 113, "known_prices": true, "weather": true}
```

Sent via `lam.invoke(FunctionName=EXPLAIN_RUNNER_FUNCTION, InvocationType='Event', ...)`
from `scenario-runner/handler.py`. Requires `scenarios/{scenario_id}/anon.json` (the
ASIN->SKU-### mapping, written by `scenario-runner` right before invoking this) to already
exist in S3.

## Deploy dependencies (not committed — rebuild before deploying)

Same trimmed dependency set as `scenario-runner` (pandas/numpy/lightgbm/jpholiday/scipy,
minus unused scipy submodules and test suites — see `scenario-runner/README.md` for the
full rationale and exact `rm -rf` list, since both Lambdas need identical packaging).
Simplest to just copy `scenario-runner/pkg` wholesale and swap in this Lambda's own
`handler.py` (there's no cross-Lambda dependency drift risk since both are rebuilt from the
same recipe):

```bash
rm -rf ./pkg explain-runner.zip
cp -r ../scenario-runner/pkg ./pkg
rm -f ./pkg/handler.py
cp handler.py ./pkg/handler.py
cp ../../../forecast/forecast.py ./pkg/forecast.py   # keep in sync with the forecast repo
cd pkg && zip -rq ../explain-runner.zip .

aws s3 cp ../explain-runner.zip s3://aprabot-forecast-751835847089/_deploy/explain-runner.zip
aws lambda update-function-code --function-name aprabot-explain-runner \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/explain-runner.zip
```

Env vars: `BUCKET_NAME`, `LD_LIBRARY_PATH=/var/task/lib` (same libgomp fix as
scenario-runner — see its README).

Runs under the same IAM role as `scenario-runner` (`aprabot-scenario-lambda-role`) since it
needs the identical S3 access (read `raw/*`, read+write `scenarios/*`) — no new role.
`scenario-runner`'s role additionally needs `lambda:InvokeFunction` on this function's ARN
to fire the async invoke (added to its `invoke-runner` policy).

Timeout 900s (Lambda's hard max), memory 3008MB (account's max) — same as scenario-runner.
