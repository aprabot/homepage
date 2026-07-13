#!/usr/bin/env python3
"""Generate AI Insights from the live (anonymized) forecast data via Bedrock,
then upload the result to s3://aprabot-forecast-.../insights/latest.json.

Run this locally (or from any machine with AWS creds for the aprabot
account) whenever you want to refresh the AI Insights tab. It reads only
the already-anonymized forecast/latest.json — no raw ASIN/order data ever
touches the model or the insights JSON.
"""
import json
import os
from datetime import datetime, timezone

import boto3

BUCKET = 'aprabot-forecast-751835847089'
FORECAST_KEY = 'forecast/latest.json'
INSIGHTS_KEY = 'insights/latest.json'
BEDROCK_REGION = 'us-west-2'
MODEL_ID = 'amazon.nova-lite-v1:0'

s3 = boto3.client('s3')
bedrock = boto3.client('bedrock-runtime', region_name=BEDROCK_REGION)


def load_forecast():
    obj = s3.get_object(Bucket=BUCKET, Key=FORECAST_KEY)
    return json.loads(obj['Body'].read().decode('utf-8'))


def compute_stats(d):
    weeks = d['weeks']
    bt = d.get('backtestWeeks', len(weeks))
    all_a, all_f, all_w = d['all']['a'], d['all']['f'], d['all']['w']

    backtest_vol = sum(x for x in all_a[:bt] if x is not None)
    future_vol = sum(x for x in all_f[bt:] if x is not None)
    last4_bt_vol = sum(x for x in all_a[max(0, bt - 4):bt] if x is not None)
    first4_fwd_vol = sum(x for x in all_f[bt:bt + 4] if x is not None)
    trend_pct = round(100 * (first4_fwd_vol - last4_bt_vol) / last4_bt_vol, 1) if last4_bt_vol else 0

    worst_weeks = sorted(
        [(weeks[i], all_w[i]) for i in range(bt) if all_w[i] is not None],
        key=lambda x: x[1], reverse=True
    )[:3]

    sku_stats = []
    for sid, o in d['skus'].items():
        a, f = o['a'], o['f']
        vol = sum(x for x in a[:bt] if x is not None)
        err = sum(abs((a[i] or 0) - (f[i] or 0)) for i in range(bt) if a[i] is not None)
        wape = round(100 * err / vol, 1) if vol else None
        fwd = sum(x for x in f[bt:] if x is not None)
        last4 = sum(x for x in a[max(0, bt - 4):bt] if x is not None)
        fwd4 = sum(x for x in f[bt:bt + 4] if x is not None)
        sku_trend = round(100 * (fwd4 - last4) / last4, 1) if last4 else None
        sku_stats.append({'id': sid, 'volume': vol, 'wape': wape, 'forward_volume': fwd, 'trend_pct': sku_trend})

    by_volume = sorted(sku_stats, key=lambda x: x['volume'], reverse=True)
    by_wape_desc = sorted([s for s in sku_stats if s['wape'] is not None], key=lambda x: x['wape'], reverse=True)
    by_trend_desc = sorted([s for s in sku_stats if s['trend_pct'] is not None], key=lambda x: x['trend_pct'], reverse=True)

    return {
        'weeks_total': len(weeks), 'backtest_weeks': bt, 'forward_weeks': len(weeks) - bt,
        'overall_wape': d['overallWape'], 'backtest_volume': backtest_vol, 'forward_volume': future_vol,
        'trend_pct_next4_vs_last4': trend_pct,
        'worst_weeks': worst_weeks,
        'top5_by_volume': by_volume[:5],
        'worst5_by_wape': by_wape_desc[:5],
        'fastest_growing': by_trend_desc[:3],
        'fastest_declining': list(reversed(by_trend_desc[-3:])),
    }


def build_prompt(stats):
    return f"""You are Lyra, an AI demand-forecasting analyst for APRABot. Analyze this
weekly bottled-water shipment forecast summary (units are anonymized SKU IDs, all
figures already computed) and produce a concise executive insights brief.

DATA:
{json.dumps(stats, indent=2)}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) matching this
exact schema:
{{
  "headline": "<one punchy sentence summarizing the overall forecast health>",
  "summary": "<2-3 sentence paragraph, plain language, referencing the real WAPE/volume numbers above>",
  "key_findings": [
    {{"title": "<short title>", "detail": "<1-2 sentences, cite specific numbers from the data>"}},
    ... 3 to 4 items, covering accuracy, volume trend, and notable SKU-level movers
  ],
  "risks": [
    "<1 sentence risk or accuracy concern grounded in the worst_weeks / worst5_by_wape data>",
    ... 2 items
  ],
  "opportunities": [
    "<1 sentence actionable recommendation grounded in fastest_growing / fastest_declining data>",
    ... 2 items
  ]
}}

Be specific and numeric — reference actual SKU ids, WAPE percentages, and volume figures
from the data above rather than generic statements."""


def call_bedrock(prompt):
    resp = bedrock.converse(
        modelId=MODEL_ID,
        messages=[{'role': 'user', 'content': [{'text': prompt}]}],
        inferenceConfig={'maxTokens': 1200, 'temperature': 0.4},
    )
    text = resp['output']['message']['content'][0]['text'].strip()
    if text.startswith('```'):
        text = text.strip('`')
        if text.startswith('json'):
            text = text[4:]
    return json.loads(text.strip())


def main():
    forecast = load_forecast()
    stats = compute_stats(forecast)
    prompt = build_prompt(stats)
    insights = call_bedrock(prompt)
    insights['generated_at'] = datetime.now(timezone.utc).isoformat()
    insights['based_on'] = {
        'weeks_total': stats['weeks_total'],
        'backtest_weeks': stats['backtest_weeks'],
        'forward_weeks': stats['forward_weeks'],
        'overall_wape': stats['overall_wape'],
    }
    body = json.dumps(insights, indent=2)
    s3.put_object(Bucket=BUCKET, Key=INSIGHTS_KEY, Body=body.encode('utf-8'), ContentType='application/json')
    print(body)
    print(f"\nUploaded to s3://{BUCKET}/{INSIGHTS_KEY}")


if __name__ == '__main__':
    main()
