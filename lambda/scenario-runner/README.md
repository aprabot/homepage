# aprabot-scenario-runner

Runs the real `forecast.py` pipeline (from `aprabot/forecast`) inside Lambda via
subprocess, then anonymizes and uploads the weekly result to S3.

## Amplify feedback loop: campaign spend as a real forecast.py input

Before invoking `forecast.py`, `_build_ad_spend_tsv()` queries the org's live, SKU-linked,
`active` Amplify campaigns (`aprabot-amplify` DynamoDB table — needs its own scoped
`dynamodb:Query`/`GetItem` grant on this Lambda's role, added alongside this feature) and
builds an `--ad-spend` calendar from real budget/date data: each campaign's
`daily_budget_yen` over its `[start_date, end_date]`, broadcast from its SKU down to postal
codes proportional to that SKU's real historical ZIP volume share — the same ratio-
propagation idea `_apply_seasonal_correction`'s ZIP broadcast already uses, not a new
disaggregation method. Only wired up for this org's own default dataset (`not
custom_input_key`) — a custom "what-if" upload isn't guaranteed to share the live
scenario's SKU-### numbering, so resolving against it there risks attributing spend to
the wrong ASIN.

Resolving Amplify's `SKU-001`-style ids back to real ASINs reuses `anon.json`
(`orgs/{org}/scenarios/{scenario_id}/anon.json`), read from whichever scenario is
currently live (`orgs/{org}/forecast/latest.json`'s own `id` field) — this file is now
written unconditionally for every non-custom run (previously only written when the async
explain-runner invoke also fired), since a *later* run depends on an *earlier* run having
already persisted it.

Never writes an all-zero/empty file pretending to be a real signal — if the org has no
active SKU-linked campaigns, or the SKU can't be resolved to an ASIN, or that ASIN has no
historical ZIP volume to broadcast against, `--ad-spend` is omitted from the forecast.py
invocation entirely.

**Known limitation, by design**: zero historical ad-spend data exists yet (Amplify is
new), so this mechanism trains fine but can't learn a real ad-spend effect — see
`forecast.py`'s own `--ad-spend` help text. Shipping the real plumbing now; validating
whether it should ever be default-on is a deliberate, separate future step.

## Deploy dependencies (not committed — rebuild before deploying)

LightGBM's Linux wheel needs `libgomp.so.1` at runtime, which Amazon Linux 2023's
Lambda base image does not ship. Fix: extract it from scikit-learn's manylinux wheel
(which bundles its own copy) and set `LD_LIBRARY_PATH=/var/task/lib`.

```bash
pip3 install --platform manylinux_2_28_x86_64 --implementation cp --python-version 3.12 \
  --only-binary=:all: --target ./pkg --no-deps \
  pandas==2.3.3 numpy lightgbm==4.6.0 jpholiday certifi python-dateutil pytz tzdata scipy \
  openpyxl et_xmlfile

# lightgbm/basic.py unconditionally does `import scipy.sparse`, which (confirmed by importing
# scipy.sparse + scipy.sparse.linalg and diffing sys.modules) only ever pulls in scipy.linalg,
# scipy._lib, scipy._distributor_init, scipy.__config__, scipy.version beyond scipy.sparse itself
# — none of scipy's other ~17 submodules (stats/optimize/special/spatial/io/signal/interpolate/
# fft/fftpack/integrate/ndimage/cluster/odr/misc/constants/datasets/differentiate). Those add
# ~140MB for nothing forecast.py or lightgbm ever uses, and pushed the unzipped package past
# Lambda's 250MB hard limit as numpy/scipy releases grew (hit 2026-09-03: 301MB with them all).
# Also strip test suites / __pycache__ / .pyi stubs (safe — pytest-only, never imported at
# runtime), which numpy/pandas/scipy all bundle by default even for --no-deps installs.
rm -rf ./pkg/scipy/{cluster,constants,datasets,differentiate,fft,fftpack,integrate,interpolate,io,misc,ndimage,odr,optimize,signal,spatial,special,stats}
find ./pkg -type d -name "__pycache__" -exec rm -rf {} +
# ONLY "tests"/"test" (pytest-internal, never imported at runtime) — NOT "testing".
# numpy.testing is a real public submodule; scipy's array-api-compat shim touches it
# via `from numpy import *`-style introspection even in a plain `import scipy.sparse`,
# so deleting it breaks import at runtime, not just pytest (hit + fixed 2026-09-03).
find ./pkg -type d \( -name "tests" -o -name "test" \) -exec rm -rf {} +
find ./pkg -name "*.pyi" -delete
du -sh ./pkg   # sanity check: should be well under 250MB (was 301MB before trimming, ~142MB after w/ openpyxl)

pip3 download --platform manylinux2014_x86_64 --implementation cp --python-version 3.12 \
  --only-binary=:all: --no-deps -d /tmp/sklearn-dl scikit-learn
cd /tmp/sklearn-dl && unzip -o -q *.whl "scikit_learn.libs/libgomp*"
mkdir -p ./pkg/lib
cp /tmp/sklearn-dl/scikit_learn.libs/libgomp-*.so.1.0.0 ./pkg/lib/libgomp.so.1

cp handler.py ./pkg/handler.py
cp ../../../forecast/forecast.py ./pkg/forecast.py   # keep in sync with the forecast repo
cd pkg && zip -rq ../scenario-runner.zip .

aws s3 cp ../scenario-runner.zip s3://aprabot-forecast-751835847089/_deploy/scenario-runner.zip
aws lambda update-function-code --function-name aprabot-scenario-runner \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/scenario-runner.zip
```

If a future forecast.py change starts using more of scipy (e.g. scipy.optimize), re-run the
sys.modules diff above locally first to see what it actually pulls in, then adjust the `rm -rf`
list — don't just add the whole submodule back blindly.

`openpyxl` (+ its own dependency `et_xmlfile`) is required for `pandas.read_excel` on `.xlsx`
uploads — one of the file types Getting Started accepts. Without it pandas raises "Missing
optional dependency 'openpyxl'" only when a run actually hits an .xlsx file, not at import time,
so this was easy to miss until a real onboarding upload failed (hit + fixed 2026-09-04). Both are
pure-Python (`py3-none-any`) wheels, so there's no platform/arch concern packaging them.

Env vars: `BUCKET_NAME`, `LD_LIBRARY_PATH=/var/task/lib`, `AMPLIFY_TABLE_NAME` (default
`aprabot-amplify`, for the ad-spend feedback loop above).

Pin exactly `lightgbm==4.6.0` — 3.3.5 (the default `--no-deps` resolution for
manylinux2014 at time of writing) predates NumPy 2.0's `copy=False` semantics and
fails at training time, not import time, making it a slow bug to catch. Verify with
`pip3 index versions lightgbm` if this stops resolving.
