# aprabot-scenario-runner

Runs the real `forecast.py` pipeline (from `aprabot/forecast`) inside Lambda via
subprocess, then anonymizes and uploads the weekly result to S3.

## Deploy dependencies (not committed — rebuild before deploying)

LightGBM's Linux wheel needs `libgomp.so.1` at runtime, which Amazon Linux 2023's
Lambda base image does not ship. Fix: extract it from scikit-learn's manylinux wheel
(which bundles its own copy) and set `LD_LIBRARY_PATH=/var/task/lib`.

```bash
pip3 install --platform manylinux_2_28_x86_64 --implementation cp --python-version 3.12 \
  --only-binary=:all: --target ./pkg --no-deps \
  pandas==2.3.3 numpy lightgbm==4.6.0 jpholiday certifi python-dateutil pytz tzdata scipy

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

Env vars: `BUCKET_NAME`, `LD_LIBRARY_PATH=/var/task/lib`.

Pin exactly `lightgbm==4.6.0` — 3.3.5 (the default `--no-deps` resolution for
manylinux2014 at time of writing) predates NumPy 2.0's `copy=False` semantics and
fails at training time, not import time, making it a slow bug to catch. Verify with
`pip3 index versions lightgbm` if this stops resolving.
