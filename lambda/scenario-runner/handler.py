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
CUSTOM_RAW  = '/tmp/custom_upload'
OUTDIR      = '/tmp/out'
FORECAST_PY = '/var/task/forecast.py'
TRAIN_END   = '2024-12-31'
FUTURE_HORIZON_DAYS = 364  # 52 weeks beyond the last real data point
BACKTEST_FRACTION = 0.2   # for custom uploads: last 20% of unique dates held out


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


REQUIRED_INPUT_COLS = {
    'ship_day': {'ship_day'},
    'asin': {'asin'},
    'postal_code': {'postal_code'},
    'shipped_units': {'shipped_units', 'shipment_units'},
}


def _validate_custom_input(path):
    import pandas as pd
    df = pd.read_csv(path, sep='\t', nrows=5)
    cols_lower = {c.strip().lower() for c in df.columns}
    missing = [label for label, opts in REQUIRED_INPUT_COLS.items() if not (opts & cols_lower)]
    if missing:
        raise ValueError(
            f"Uploaded file is missing required column(s): {', '.join(missing)}. "
            f"Expected at least: ship_day, asin, postal_code, shipped_units "
            f"(see the input template).")


def _strip_cols(df):
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _merge_exogenous_sheet(ship_df, other_df, key_candidates, required_keys, label):
    """Left-join an optional exogenous sheet (Price) onto the Shipments sheet
    using whichever of key_candidates are present in both. Skips (with a log
    line, not an error) if the required subset of keys isn't there — an
    unrecognized sheet shouldn't take down the whole run."""
    other_df = _strip_cols(other_df).dropna(how='all')
    if other_df.empty:
        return ship_df
    merge_keys = [c for c in key_candidates if c in ship_df.columns and c in other_df.columns]
    if not required_keys.issubset(set(merge_keys)):
        print(f"[custom_input] {label} sheet present but missing expected join columns "
              f"(needs at least {sorted(required_keys)}, found {list(other_df.columns)}) — skipping.")
        return ship_df
    return ship_df.merge(other_df, on=merge_keys, how='left', suffixes=('', f'_{label.lower()}'))


def _download_custom_input(key):
    """Download a user-uploaded input file and normalize it to the
    tab-separated format forecast.py expects, validating required columns.

    For .xlsx, reads separate Shipments / Price / Weather sheets — Price and
    Weather are optional; an empty or missing sheet just means that signal
    falls back to the platform default (no price features, or the default
    weather.tsv). .csv/.tsv uploads are treated as a single Shipments sheet
    with no separate exogenous data (that split is an xlsx-only feature).

    Returns True if a custom weather file was written (RAW_WEATHER), so the
    caller knows not to overwrite it with the default.
    """
    import pandas as pd

    ext = os.path.splitext(key)[1].lower()
    local_raw = CUSTOM_RAW + ext
    s3.download_file(BUCKET, key, local_raw)

    has_custom_weather = False

    if ext == '.xlsx':
        sheets = pd.read_excel(local_raw, sheet_name=None)
        by_name = {str(k).strip().lower(): v for k, v in sheets.items()}

        ship_df = by_name.get('shipments')
        if ship_df is None:  # backward-compatible: no explicit "Shipments" tab
            ship_df = next(iter(sheets.values()))
        ship_df = _strip_cols(ship_df).dropna(how='all')

        price_df = by_name.get('price')
        if price_df is not None:
            ship_df = _merge_exogenous_sheet(
                ship_df, price_df, ['ship_day', 'asin', 'postal_code'],
                {'ship_day', 'asin'}, 'Price')

        weather_df = by_name.get('weather')
        if weather_df is not None:
            weather_df = _strip_cols(weather_df).dropna(how='all')
            if not weather_df.empty:
                weather_df.to_csv(RAW_WEATHER, sep='\t', index=False)
                has_custom_weather = True

        ship_df.to_csv(RAW_INPUT, sep='\t', index=False)
    elif ext == '.csv':
        df = pd.read_csv(local_raw)
        df.to_csv(RAW_INPUT, sep='\t', index=False)
    else:  # .tsv / .txt — already tab-separated
        os.replace(local_raw, RAW_INPUT)

    _validate_custom_input(RAW_INPUT)
    return has_custom_weather


def _dynamic_train_end(path, backtest_fraction=BACKTEST_FRACTION):
    """Pick a train/backtest split for an arbitrary uploaded date range: the
    last `backtest_fraction` of unique ship_day values become the backtest
    window (and, with --forecast-future, the model also extrapolates beyond
    the very last date in the file)."""
    import pandas as pd
    dates = pd.read_csv(path, sep='\t', usecols=lambda c: c.strip().lower() == 'ship_day')
    col = dates.columns[0]
    uniq = sorted(pd.to_datetime(dates[col], errors='coerce').dropna().dt.normalize().unique())
    if len(uniq) < 20:
        raise ValueError(
            f"Uploaded file only has {len(uniq)} distinct date(s) — need at least "
            f"20 days of history to train and backtest a model.")
    cutoff_idx = max(1, min(int(len(uniq) * (1 - backtest_fraction)), len(uniq) - 2))
    return pd.Timestamp(uniq[cutoff_idx]).strftime('%Y-%m-%d')


def _trim_partial_trailing_week(path):
    """Drop any trailing partial week from the input before forecasting.

    Weeks are bucketed Mon-Sun (W-SUN). If the raw data's last date isn't a
    Sunday, that final week is undercounted — e.g. data ending on a
    Wednesday gives that week only 3 of 7 days of volume. Left in, it both
    corrupts the last backtest week's reported accuracy AND, more
    importantly, seeds the recursive forecast's very first lag/rolling
    features with an artificially depressed "current level", which then
    propagates through the entire forward horizon.
    """
    import pandas as pd
    df = pd.read_csv(path, sep='\t')
    date_col = next((c for c in df.columns if c.strip().lower() == 'ship_day'), None)
    if not date_col:
        return
    dates = pd.to_datetime(df[date_col], errors='coerce')
    max_date = dates.max()
    if pd.isna(max_date):
        return
    days_since_sunday = (max_date.weekday() + 1) % 7  # Mon=0..Sun=6 -> 0 if already Sunday
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


def _seasonal_index(raw_path):
    """Per-ASIN week-of-year seasonal factor, averaged across ALL real
    history in raw_path (typically 2-3 years) — more robust than the
    1-year backtest alone. Each ASIN's factors average to ~1.0 across its
    own weeks, so multiplying a flat forecast by these restores the
    historical seasonal shape without changing the overall level.

    Returns (per_asin_index, catalog_wide_index) — the second is a
    fallback for ASIN/week-of-year combinations with too little signal.
    """
    import pandas as pd

    df = pd.read_csv(raw_path, sep='\t', parse_dates=['ship_day'])
    asin_col = 'asin' if 'asin' in df.columns else 'ASIN'
    unit_col = 'shipped_units' if 'shipped_units' in df.columns else 'shipment_units'
    df = df.rename(columns={asin_col: 'ASIN', unit_col: 'units'})
    df['week'] = df['ship_day'].dt.to_period('W-SUN').dt.start_time
    df['woy'] = df['week'].dt.isocalendar().week.astype(int)

    wk = df.groupby(['ASIN', 'week', 'woy'], as_index=False)['units'].sum()
    asin_mean = wk.groupby('ASIN')['units'].transform('mean')
    wk = wk[asin_mean > 0].copy()
    wk['rel'] = wk['units'] / asin_mean[asin_mean > 0]

    per_asin = wk.groupby(['ASIN', 'woy'])['rel'].mean().to_dict()
    catalog_wide = wk.groupby('woy')['rel'].mean().to_dict()
    return per_asin, catalog_wide


def _apply_seasonal_correction(future_wk_asin, per_asin_idx, catalog_idx, ramp_weeks=8):
    """Blend the model's raw forward forecast toward a historical seasonal
    shape as the horizon grows. The recursive model's own week-to-week
    shape is trustworthy near-term (where this pipeline is validated) but
    dampens badly beyond ~8 weeks out — the first `ramp_weeks` stay close
    to the model's own numbers, then the seasonal index takes over,
    rescaled to match the model's own average level so the correction
    changes shape, not the model's implied overall volume.
    """
    import pandas as pd

    future_wk_asin = future_wk_asin.sort_values(['ASIN', 'week']).copy()
    future_wk_asin['woy'] = future_wk_asin['week'].dt.isocalendar().week.astype(int)
    future_wk_asin['fwd_rank'] = future_wk_asin.groupby('ASIN').cumcount()

    def factor(row):
        f = per_asin_idx.get((row['ASIN'], row['woy']))
        if f is None or f <= 0:
            f = catalog_idx.get(row['woy'], 1.0)
        return f if f and f > 0 else 1.0

    future_wk_asin['seasonal_f'] = future_wk_asin.apply(factor, axis=1)
    model_avg = future_wk_asin.groupby('ASIN')['f'].transform('mean')
    seasonal_target = model_avg * future_wk_asin['seasonal_f']
    blend = (future_wk_asin['fwd_rank'] / ramp_weeks).clip(0, 1)
    future_wk_asin['f'] = future_wk_asin['f'] * (1 - blend) + seasonal_target * blend
    return future_wk_asin.drop(columns=['woy', 'fwd_rank', 'seasonal_f'])


def _confidence_weight(bt_vol_by_asin):
    """Trust weight per ASIN by backtest-volume rank — same tiering as the
    dashboard's High/Medium/Lower confidence badge, expressed as how much
    to trust that ASIN's own long-horizon model average (vs. anchoring it
    to a trusted trend applied to its real trailing level)."""
    ranked = bt_vol_by_asin.sort_values(ascending=False)
    n = len(ranked) or 1
    weight = {}
    for i, asin in enumerate(ranked.index):
        pct = i / n
        weight[asin] = 0.85 if pct < 0.15 else 0.5 if pct < 0.5 else 0.15
    return weight


def _apply_level_correction(future_wk_asin, wk_asin, trail_win):
    """On top of the shape correction, also correct the overall LEVEL for
    lower-volume SKUs. The shape fix only reshapes week-to-week variation
    around whatever average the model landed on — for lower-volume SKUs
    that average is itself still depressed by the same long-horizon
    compounding. Blend each SKU's forward average toward (its own real
    trailing level x a trusted trend factor computed only from
    High-confidence SKUs), weighted by how much we trust that SKU's own
    model average.
    """
    bt_vol = wk_asin.groupby('ASIN')['a'].sum()
    trust = _confidence_weight(bt_vol)

    all_weeks_sorted = sorted(wk_asin['week'].unique())
    trail_weeks = set(all_weeks_sorted[-trail_win:]) if trail_win else set(all_weeks_sorted)
    trailing_actual = wk_asin[wk_asin['week'].isin(trail_weeks)].groupby('ASIN')['a'].mean()

    model_avg = future_wk_asin.groupby('ASIN')['f'].mean()

    high_conf = [a for a, w in trust.items() if w >= 0.85]
    hc_model_sum = model_avg[model_avg.index.isin(high_conf)].sum()
    hc_trailing_sum = trailing_actual[trailing_actual.index.isin(high_conf)].sum()
    trend_factor = (hc_model_sum / hc_trailing_sum) if hc_trailing_sum else 1.0

    out = future_wk_asin.copy()
    for asin, idx in out.groupby('ASIN').groups.items():
        m_avg = model_avg.get(asin)
        t_avg = trailing_actual.get(asin)
        if not m_avg or m_avg <= 0 or t_avg is None or t_avg <= 0:
            continue
        corrected_avg = t_avg * trend_factor
        w = trust.get(asin, 0.5)
        final_avg = m_avg * w + corrected_avg * (1 - w)
        out.loc[idx, 'f'] = out.loc[idx, 'f'] * (final_avg / m_avg)
    return out


def transform_to_weekly(tsv_path, future_tsv_path=None, raw_history_path=None):
    """Aggregate the daily SKU x ZIP backtest to weekly per-SKU totals, with
    ASINs replaced by rank-ordered SKU-### ids and postal codes dropped —
    matches the anonymization policy used for forecast/latest.json.

    If future_tsv_path (from --forecast-future) is given, its weeks are
    appended after the backtest weeks with actual=None (genuinely unknown)
    and forecast=the forward prediction. overallWape/volume_error are
    computed from the backtest weeks only — the forward forecast never
    affects the accuracy metrics, only extends the chart data.
    """
    import pandas as pd

    df = pd.read_csv(tsv_path, sep='\t', parse_dates=['ship_day'])
    df['week'] = df['ship_day'].dt.to_period('W-SUN').dt.start_time

    wk_asin = (df.groupby(['ASIN', 'week'], as_index=False)
                 .agg(a=('actual_units', 'sum'), f=('forecast_units', 'sum')))

    weeks = sorted(wk_asin['week'].unique())
    weeks_set = set(weeks)

    asin_totals = wk_asin.groupby('ASIN')['a'].sum().sort_values(ascending=False)
    asin_ids = list(asin_totals.index)
    anon = {asin: f"SKU-{i+1:03d}" for i, asin in enumerate(asin_ids)}

    future_wk_asin = None
    future_weeks = []
    if future_tsv_path and os.path.exists(future_tsv_path):
        fdf = pd.read_csv(future_tsv_path, sep='\t', parse_dates=['ship_day'])
        fdf['week'] = fdf['ship_day'].dt.to_period('W-SUN').dt.start_time
        future_wk_asin = (fdf.groupby(['ASIN', 'week'], as_index=False)
                              .agg(f=('forecast_units', 'sum')))
        # Drop any week already covered by the backtest — the last backtest
        # week and first future week can land in the same W-SUN bucket at
        # the data boundary. Keep the backtest's (real, complete) week.
        future_weeks = sorted(w for w in future_wk_asin['week'].unique() if w not in weeks_set)
        future_wk_asin = future_wk_asin[future_wk_asin['week'].isin(future_weeks)]

        # The recursive forecast dampens seasonal amplitude badly beyond
        # its validated ~8-week horizon (short-term lag/rolling features
        # become fully self-referential). Correct the shape using a
        # seasonal index from real multi-year history, blended in over the
        # first ramp_weeks so the model's own near-term signal still leads.
        if raw_history_path and os.path.exists(raw_history_path) and not future_wk_asin.empty:
            per_asin_idx, catalog_idx = _seasonal_index(raw_history_path)
            future_wk_asin = _apply_seasonal_correction(future_wk_asin, per_asin_idx, catalog_idx)
            future_wk_asin = _apply_level_correction(
                future_wk_asin, wk_asin, trail_win=min(len(future_weeks), len(weeks)))

    all_weeks = weeks + future_weeks
    week_strs = [w.strftime('%Y-%m-%d') for w in all_weeks]
    widx = {w: i for i, w in enumerate(all_weeks)}
    n = len(all_weeks)
    backtest_week_count = len(weeks)

    skus = {}
    for asin in asin_ids:
        sub = wk_asin[wk_asin['ASIN'] == asin].set_index('week')
        a = [None] * n
        f = [None] * n
        for w, row in sub.iterrows():
            i = widx[w]
            a[i] = round(float(row['a']))
            f[i] = round(float(row['f']))
        if future_wk_asin is not None:
            fsub = future_wk_asin[future_wk_asin['ASIN'] == asin].set_index('week')
            for w, row in fsub.iterrows():
                i = widx[w]
                f[i] = round(float(row['f']))  # a stays None — genuinely unknown
        skus[anon[asin]] = {'a': a, 'f': f}

    all_a = [None] * n
    all_f = [None] * n
    all_abserr = [0.0] * backtest_week_count
    backtest_a_by_week = [0.0] * backtest_week_count
    for _, row in wk_asin.iterrows():
        i = widx[row['week']]
        all_a[i] = (all_a[i] or 0) + row['a']
        all_f[i] = (all_f[i] or 0) + row['f']
        all_abserr[i] += abs(row['a'] - row['f'])
        backtest_a_by_week[i] += row['a']
    if future_wk_asin is not None:
        for _, row in future_wk_asin.iterrows():
            i = widx[row['week']]
            all_f[i] = (all_f[i] or 0) + row['f']

    all_w = [round(100 * all_abserr[i] / backtest_a_by_week[i], 2) if backtest_a_by_week[i] else 0.0
             for i in range(backtest_week_count)] + [None] * len(future_weeks)
    overall_wape = round(100 * sum(all_abserr) / sum(backtest_a_by_week), 2) if sum(backtest_a_by_week) else 0.0
    tot_a = sum(backtest_a_by_week)
    tot_f_backtest = sum(all_f[i] for i in range(backtest_week_count))
    volume_error = round(100 * (tot_f_backtest - tot_a) / tot_a, 2) if tot_a else 0.0

    return {
        'weeks': week_strs,
        'overallWape': overall_wape,
        'backtestWeeks': backtest_week_count,
        'all': {
            'a': [round(x) if x is not None else None for x in all_a],
            'f': [round(x) if x is not None else None for x in all_f],
            'w': all_w,
        },
        'skus': skus,
    }, volume_error


def handler(event, context):
    scenario_id = event['scenario_id']
    label       = event.get('label', 'Untitled scenario')
    known_prices = bool(event.get('known_prices', True))
    calibrate    = bool(event.get('calibrate', True))
    weather      = bool(event.get('weather', True))
    refresh_days = int(event.get('refresh_days', 28))
    custom_input_key = event.get('custom_input_key')

    try:
        os.makedirs(OUTDIR, exist_ok=True)
        has_custom_weather = False
        if custom_input_key:
            has_custom_weather = _download_custom_input(custom_input_key)
            _trim_partial_trailing_week(RAW_INPUT)
            train_end = _dynamic_train_end(RAW_INPUT)
        else:
            s3.download_file(BUCKET, 'raw/With_Price.tsv', RAW_INPUT)
            _trim_partial_trailing_week(RAW_INPUT)
            train_end = TRAIN_END
        if weather and not has_custom_weather:
            s3.download_file(BUCKET, 'raw/weather.tsv', RAW_WEATHER)

        args = [sys.executable, FORECAST_PY,
                '--input', RAW_INPUT,
                '--outdir', OUTDIR,
                '--train-end', train_end,
                '--refresh-days', str(refresh_days),
                '--forecast-future',
                '--horizon', str(FUTURE_HORIZON_DAYS)]
        if known_prices:
            args.append('--known-prices')
        if calibrate:
            args.append('--calibrate')
        if weather:
            args += ['--weather', RAW_WEATHER]

        proc = subprocess.run(args, capture_output=True, text=True, timeout=780)
        if proc.returncode != 0:
            raise RuntimeError(f"forecast.py exited {proc.returncode}: {proc.stderr[-2000:]}")

        result_json, volume_error = transform_to_weekly(
            os.path.join(OUTDIR, 'backtest_2025.tsv'),
            os.path.join(OUTDIR, 'forecast_output.tsv'),
            raw_history_path=RAW_INPUT)

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
