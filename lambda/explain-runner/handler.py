import json
import os
import subprocess
import sys
import traceback
from datetime import datetime, timezone

import boto3

s3 = boto3.client('s3')
BUCKET = os.environ.get('BUCKET_NAME', 'aprabot-forecast-751835847089')

RAW_INPUT   = '/tmp/With_Price.tsv'
RAW_WEATHER = '/tmp/weather.tsv'
OUTDIR      = '/tmp/out'
FORECAST_PY = '/var/task/forecast.py'

# Async, best-effort companion to aprabot-scenario-runner: computes real
# per-feature day-level explainability (forecast.py --explain) for the
# default full-catalog forecast, decoupled from the main run's own timeout
# budget. See scenario-runner/handler.py's comment where this gets invoked
# for why this had to be split out (full catalog + --explain doesn't fit in
# a single Lambda invocation's 900s ceiling).
#
# Deliberately scoped to a shorter forward window than the main run's full
# 364-day horizon — explainability questions are realistically about the
# near-to-medium term ("why is next week's forecast high"), and the per-day
# cost of --explain (an extra pred_contrib model.predict call each day) means
# covering the full 364 days would itself risk exceeding even this Lambda's
# own dedicated 900s budget. 182 days (~26 weeks) leaves comfortable margin.
EXPLAIN_HORIZON_DAYS = 182


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read_json(key, default=None):
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        return json.loads(obj['Body'].read().decode('utf-8'))
    except s3.exceptions.NoSuchKey:
        return default
    except s3.exceptions.ClientError as exc:
        if exc.response.get('Error', {}).get('Code') in ('AccessDenied', '403'):
            return default
        raise


def _write_json(key, data):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(data).encode('utf-8'),
                   ContentType='application/json')


def _trim_partial_trailing_week(path):
    """Same trim as scenario-runner's — keeps this run's forward forecast
    seeded from the same last-complete-week starting point as the main run's,
    so the two runs' near-term day-by-day numbers stay consistent."""
    import pandas as pd
    df = pd.read_csv(path, sep='\t')
    date_col = next((c for c in df.columns if c.strip().lower() == 'ship_day'), None)
    if not date_col:
        return
    dates = pd.to_datetime(df[date_col], errors='coerce')
    max_date = dates.max()
    if pd.isna(max_date):
        return
    days_since_sunday = (max_date.weekday() + 1) % 7
    if days_since_sunday == 0:
        return
    cutoff = max_date - pd.Timedelta(days=days_since_sunday)
    keep = dates <= cutoff
    dropped = int((~keep).sum())
    if dropped:
        print(f"[trim] dropping {dropped} row(s) from the incomplete trailing week "
              f"(data ran through {max_date.date()}, trimmed to the last complete "
              f"week ending {cutoff.date()})")
        df[keep].to_csv(path, sep='\t', index=False)


def build_explain_by_sku(explain_path, anon):
    """Same aggregation as scenario-runner's build_explain_by_sku — see that
    docstring for why converting each postal code's pct_effect to a real unit
    delta (using the `units` forecast.py persists alongside it) before summing
    across postal codes is required for correctness."""
    if not os.path.exists(explain_path):
        return {}
    with open(explain_path) as fh:
        raw = json.load(fh)

    out = {}
    for asin, days in raw.items():
        sku = anon.get(asin)
        if not sku:
            continue
        sku_out = out.setdefault(sku, {})
        for day_str, rows in days.items():
            day_total = sum(r['units'] for r in rows)
            feature_totals = {}
            for r in rows:
                units = r['units']
                for f in r['features']:
                    delta = units - units / (1 + f['pct_effect'] / 100)
                    feature_totals[f['feature']] = feature_totals.get(f['feature'], 0.0) + delta
            ranked = sorted(feature_totals.items(), key=lambda kv: abs(kv[1]), reverse=True)[:5]
            sku_out[day_str] = [
                {
                    'feature': name,
                    'units': round(delta, 2),
                    'pct_of_forecast': round(100 * delta / day_total, 1) if day_total else None,
                }
                for name, delta in ranked
            ]
    return out


def handler(event, context):
    scenario_id  = event['scenario_id']
    best_iter    = event['best_iter']
    known_prices = bool(event.get('known_prices', True))
    weather      = bool(event.get('weather', True))

    try:
        os.makedirs(OUTDIR, exist_ok=True)
        anon = _read_json(f'scenarios/{scenario_id}/anon.json')
        if not anon:
            raise RuntimeError(f'scenarios/{scenario_id}/anon.json not found — '
                                f'was this invoked for a scenario scenario-runner '
                                f'actually wrote one for?')

        s3.download_file(BUCKET, 'raw/With_Price.tsv', RAW_INPUT)
        _trim_partial_trailing_week(RAW_INPUT)
        if weather:
            s3.download_file(BUCKET, 'raw/weather.tsv', RAW_WEATHER)

        args = [sys.executable, '-u', FORECAST_PY,
                '--input', RAW_INPUT,
                '--outdir', OUTDIR,
                '--forecast-future',
                '--horizon', str(EXPLAIN_HORIZON_DAYS),
                '--best-iter', str(best_iter),
                '--explain']
        if known_prices:
            args.append('--known-prices')
        if weather:
            args += ['--weather', RAW_WEATHER]

        # No capture_output — see scenario-runner's identical note: piping
        # to a buffer hides all progress from CloudWatch until the process
        # ends, which is exactly what made the original full-catalog timeout
        # undiagnosable. Leave ~30s of this Lambda's own 900s ceiling for the
        # aggregation + S3 writes that follow.
        proc = subprocess.run(args, timeout=870)
        if proc.returncode != 0:
            raise RuntimeError(f"forecast.py exited {proc.returncode} — see the "
                                f"forecast.py output above in this same log stream for the traceback.")

        explain_by_sku = build_explain_by_sku(os.path.join(OUTDIR, 'forecast_explain.json'), anon)
        for sku, days in explain_by_sku.items():
            _write_json(f'scenarios/{scenario_id}/explain/{sku}.json', days)

        _write_json(f'scenarios/{scenario_id}/explain_status.json', {
            'status': 'completed',
            'completed_at': _now(),
            'horizon_days': EXPLAIN_HORIZON_DAYS,
            'skus_written': len(explain_by_sku),
        })

    except Exception as exc:
        err = f"{exc}\n{traceback.format_exc()[-1500:]}"
        print(f"EXPLAIN_RUN_ERROR[{scenario_id}]: {err}")
        try:
            _write_json(f'scenarios/{scenario_id}/explain_status.json', {
                'status': 'failed',
                'error': str(exc)[:500],
                'failed_at': _now(),
            })
        except Exception as inner_exc:
            print(f"EXPLAIN_RUN_ERROR[{scenario_id}]: also failed to record status: {inner_exc}")

    return {'ok': True}
