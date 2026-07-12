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
TRAIN_END   = '2024-12-31'


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read_json(key, default=None):
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        return json.loads(obj['Body'].read().decode('utf-8'))
    except s3.exceptions.NoSuchKey:
        return default
    except s3.exceptions.ClientError as exc:
        # S3 returns 403 (not 404) for GetObject on a missing key when the
        # caller lacks ListBucket — treat that the same as "not found".
        if exc.response.get('Error', {}).get('Code') in ('AccessDenied', '403'):
            return default
        raise


def _write_json(key, data):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(data).encode('utf-8'),
                   ContentType='application/json')


def _update_index(scenario_id, patch):
    idx = _read_json('scenarios/index.json', default={'scenarios': []})
    found = False
    for s in idx['scenarios']:
        if s['id'] == scenario_id:
            s.update(patch)
            found = True
            break
    if not found:
        entry = {'id': scenario_id}
        entry.update(patch)
        idx['scenarios'].append(entry)
    _write_json('scenarios/index.json', idx)


def transform_to_weekly(tsv_path):
    """Aggregate the daily SKU x ZIP backtest to weekly per-SKU totals, with
    ASINs replaced by rank-ordered SKU-### ids and postal codes dropped —
    matches the anonymization policy used for forecast/latest.json."""
    import pandas as pd

    df = pd.read_csv(tsv_path, sep='\t', parse_dates=['ship_day'])
    df['week'] = df['ship_day'].dt.to_period('W-SUN').dt.start_time

    wk_asin = (df.groupby(['ASIN', 'week'], as_index=False)
                 .agg(a=('actual_units', 'sum'), f=('forecast_units', 'sum')))

    weeks = sorted(wk_asin['week'].unique())
    week_strs = [w.strftime('%Y-%m-%d') for w in weeks]
    widx = {w: i for i, w in enumerate(weeks)}
    n = len(weeks)

    asin_totals = wk_asin.groupby('ASIN')['a'].sum().sort_values(ascending=False)
    asin_ids = list(asin_totals.index)
    anon = {asin: f"SKU-{i+1:03d}" for i, asin in enumerate(asin_ids)}

    skus = {}
    for asin in asin_ids:
        sub = wk_asin[wk_asin['ASIN'] == asin].set_index('week')
        a = [0] * n
        f = [0] * n
        for w, row in sub.iterrows():
            i = widx[w]
            a[i] = round(float(row['a']))
            f[i] = round(float(row['f']))
        skus[anon[asin]] = {'a': a, 'f': f}

    all_a = [0.0] * n
    all_f = [0.0] * n
    all_abserr = [0.0] * n
    for _, row in wk_asin.iterrows():
        i = widx[row['week']]
        all_a[i] += row['a']
        all_f[i] += row['f']
        all_abserr[i] += abs(row['a'] - row['f'])

    all_w = [round(100 * all_abserr[i] / all_a[i], 2) if all_a[i] else 0.0 for i in range(n)]
    overall_wape = round(100 * sum(all_abserr) / sum(all_a), 2) if sum(all_a) else 0.0
    tot_a, tot_f = sum(all_a), sum(all_f)
    volume_error = round(100 * (tot_f - tot_a) / tot_a, 2) if tot_a else 0.0

    return {
        'weeks': week_strs,
        'overallWape': overall_wape,
        'all': {'a': [round(x) for x in all_a], 'f': [round(x) for x in all_f], 'w': all_w},
        'skus': skus,
    }, volume_error


def handler(event, context):
    scenario_id = event['scenario_id']
    label       = event.get('label', 'Untitled scenario')
    known_prices = bool(event.get('known_prices', True))
    calibrate    = bool(event.get('calibrate', True))
    weather      = bool(event.get('weather', True))
    refresh_days = int(event.get('refresh_days', 28))

    try:
        os.makedirs(OUTDIR, exist_ok=True)
        s3.download_file(BUCKET, 'raw/With_Price.tsv', RAW_INPUT)
        if weather:
            s3.download_file(BUCKET, 'raw/weather.tsv', RAW_WEATHER)

        args = [sys.executable, FORECAST_PY,
                '--input', RAW_INPUT,
                '--outdir', OUTDIR,
                '--train-end', TRAIN_END,
                '--refresh-days', str(refresh_days)]
        if known_prices:
            args.append('--known-prices')
        if calibrate:
            args.append('--calibrate')
        if weather:
            args += ['--weather', RAW_WEATHER]

        proc = subprocess.run(args, capture_output=True, text=True, timeout=780)
        if proc.returncode != 0:
            raise RuntimeError(f"forecast.py exited {proc.returncode}: {proc.stderr[-2000:]}")

        result_json, volume_error = transform_to_weekly(os.path.join(OUTDIR, 'backtest_2025.tsv'))

        _write_json(f'scenarios/{scenario_id}/result.json', result_json)

        config = _read_json(f'scenarios/{scenario_id}/config.json', default={})
        config.update({
            'status': 'completed',
            'completed_at': _now(),
            'wape': result_json['overallWape'],
            'volume_error': volume_error,
        })
        _write_json(f'scenarios/{scenario_id}/config.json', config)
        _update_index(scenario_id, {
            'status': 'completed',
            'wape': result_json['overallWape'],
            'volume_error': volume_error,
            'completed_at': config['completed_at'],
        })

    except Exception as exc:
        err = f"{exc}\n{traceback.format_exc()[-1500:]}"
        print(f"SCENARIO_RUN_ERROR[{scenario_id}]: {err}")
        # Best-effort status update — never let a failure here hide the
        # original exception above (it's already printed to CloudWatch).
        try:
            config = _read_json(f'scenarios/{scenario_id}/config.json', default={})
            config.update({'status': 'failed', 'error': str(exc)[:500], 'failed_at': _now()})
            _write_json(f'scenarios/{scenario_id}/config.json', config)
            _update_index(scenario_id, {'status': 'failed', 'error': str(exc)[:500]})
        except Exception as inner_exc:
            print(f"SCENARIO_RUN_ERROR[{scenario_id}]: also failed to record status: {inner_exc}")

    return {'ok': True}
