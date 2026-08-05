# aprabot-chat-api

Lyra, the AI demand analyst chat assistant. Answers questions about the live forecast via
Bedrock (Converse API + tool use), and can start/check scenario runs and point the UI at
relevant nav items.

## Deploy dependencies (not committed — rebuild before deploying)

Uses `jpholiday` (pure Python, no C extensions) to correlate forecast spikes/drops with Japan's
real public-holiday calendar — the same library `forecast.py` itself trains on. This means the
package is no longer a trivial `zip -j handler.py`; it needs `jpholiday` bundled alongside it.

```bash
mkdir -p ./pkg
pip3 install --python-version 3.12 --only-binary=:all: --target ./pkg --no-deps jpholiday
find ./pkg -name "__pycache__" -type d -exec rm -rf {} +   # strip local bytecode cache before zipping
cp handler.py ./pkg/handler.py
cd pkg && zip -rq ../chat-api.zip .

aws s3 cp ../chat-api.zip s3://aprabot-forecast-751835847089/_deploy/chat-api.zip
aws lambda update-function-code --function-name aprabot-chat-api \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/chat-api.zip
```

Env vars: `BUCKET_NAME`, `FORECAST_KEY`, `WEATHER_KEY` (default `raw/weather.tsv`), `MODEL_ID`,
`BEDROCK_REGION`, `SCENARIOS_API_FUNCTION`.

## A note on `SYSTEM_TMPL`

`SYSTEM_TMPL.format(data=...)` runs against the *entire* prompt string — any literal `{` or `}`
written into the prompt text itself (not just the `{data}` placeholder) must be escaped as `{{`
/ `}}`, or `.format()` raises `KeyError` at request time, not at deploy time. Test locally with
`SYSTEM_TMPL.format(data='TEST')` before deploying after editing the prompt.
