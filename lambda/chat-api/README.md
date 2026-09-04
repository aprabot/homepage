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
cp forecasting_knowledge.md ./pkg/forecasting_knowledge.md   # load_forecasting_knowledge()'s fallback
cd pkg && zip -rq ../chat-api.zip .

aws s3 cp ../chat-api.zip s3://aprabot-forecast-751835847089/_deploy/chat-api.zip
aws lambda update-function-code --function-name aprabot-chat-api \
  --s3-bucket aprabot-forecast-751835847089 --s3-key _deploy/chat-api.zip
```

Env vars: `BUCKET_NAME`, `FORECAST_KEY`, `WEATHER_KEY` (default `raw/weather.tsv`), `MODEL_ID`,
`BEDROCK_REGION`, `SCENARIOS_API_FUNCTION`, `KNOWLEDGE_KEY`, `KNOWLEDGE_INDEX_KEY`, `EMBED_MODEL_ID`.

## Knowledge base RAG (2026-09-04)

The KB used to go into *every* chat request in full — a growing problem as the file grows past
its original size (currently ~280 lines / 24KB): a large model context dilutes attention on
whatever's buried lower in the file, and every message pays to re-send the whole thing regardless
of relevance. `retrieve_knowledge(question)` fixes this without a real vector DB (evaluated —
Amazon Bedrock Knowledge Bases + OpenSearch Serverless has a ~$175/month OCU floor for a corpus
this small; not worth it):

- `put_knowledge()` splits the just-saved content on `#`/`##` headings (`_split_knowledge_
  sections()` — H3+ stays nested inside its enclosing section) and embeds each one via Titan
  Embeddings V2 (`EMBED_MODEL_ID`), synchronously, writing the result to `KNOWLEDGE_INDEX_KEY`
  right alongside the raw `.md` at `KNOWLEDGE_KEY`. This keeps the same "live on the very next
  message" guarantee the old full-file approach had — no separate ingestion/sync job.
- Each chat message embeds the question (one Titan call) and cosine-ranks it against the stored
  section embeddings in plain Python (no numpy — trivial at ~15-20 sections), taking only the top
  `KNOWLEDGE_TOP_K` into the prompt.
- Falls back to the old full-file behavior (`load_forecasting_knowledge()`) if the index is
  missing or anything about retrieval fails — a KB saved before this existed, or before its first
  re-save afterward, degrades gracefully rather than breaking chat.

**Gotcha hit while building this**: a `GetObject` on a key that doesn't exist yet returns
`AccessDenied`, not `NoSuchKey`/404, when the caller's IAM role lacks `s3:ListBucket` on the
bucket (S3 masks "not found" as "denied" in that case, so as not to leak object existence to a
caller who can't list). Not a bug — `retrieve_knowledge()`'s `except Exception` already handles
it as any other retrieval failure — but confusing to read in CloudWatch the first time (`KB_
RETRIEVAL_FALLBACK: ... AccessDenied ... s3:ListBucket ...`) if you don't know this quirk. Once
the index key actually exists, ordinary `s3:GetObject` (which this role already has, used
elsewhere in this same file) is all that's needed — no ListBucket required for an existing key.

## A note on `SYSTEM_TMPL`

`SYSTEM_TMPL.format(data=...)` runs against the *entire* prompt string — any literal `{` or `}`
written into the prompt text itself (not just the `{data}` placeholder) must be escaped as `{{`
/ `}}`, or `.format()` raises `KeyError` at request time, not at deploy time. Test locally with
`SYSTEM_TMPL.format(data='TEST')` before deploying after editing the prompt.
