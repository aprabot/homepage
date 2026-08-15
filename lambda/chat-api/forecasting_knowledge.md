# Demand forecasting — general domain knowledge

Background knowledge for explaining *why* forecasting behaves the way it does, in addition to the
live dataset above. Use it to give real reasoning, not to replace the live numbers — never quote a
generic industry figure (e.g. a benchmark accuracy range) as if it were this dataset's own number,
and never let general knowledge override what the live data actually shows.

## Accuracy metrics and what they hide

- **WAPE** (weighted/volume-weighted absolute percentage error) sums absolute error over total
  actual volume — stable even when individual periods have low or zero demand, which is why it's
  generally preferred over MAPE for aggregated operational planning. **MAPE** (mean absolute
  percentage error) can blow up or become undefined when actual demand is near zero, since each
  period is weighted equally regardless of volume.
- **Bias** (systematic over- or under-forecasting) is a different failure mode than accuracy, and a
  forecast can look accurate on average while still being consistently wrong in one direction.
  Positive bias (over-forecasting) → excess inventory, tied-up capital. Negative bias
  (under-forecasting) → stockouts, urgent reorders, lost sales, and — subtly — it can become
  self-reinforcing: if stockout periods aren't excluded from historical training data, the model
  learns from artificially suppressed "demand" and forecasts even lower next time.
- Rough industry accuracy ranges (1 − WAPE): roughly 80-90% for stable, high-volume items down to
  60-75% for volatile/long-tail portfolios, with bias commonly targeted within ±5% at an aggregated
  level. These are general benchmarks for context, not a target to claim this dataset hits.

## Why forecasts go wrong — common root causes

- **Data quality**: missing values, inconsistent product/location identifiers, stale refresh
  cadence, stockout periods not excluded from history (see bias above).
- **Overreliance on history**: a model trained purely on the past can't see a genuine regime
  change — new competitor, changed consumer trend, macro shift — until enough new data accumulates
  to outweigh the old pattern.
- **External shocks**: weather events, holidays, social/influencer-driven demand spikes, supply
  disruptions — anything the model has no feature for is invisible to it by construction.
- **New products / thin history**: a SKU with little or no sales history has no learnable pattern
  yet — this is the general "cold start" problem, not specific to any one model.
- **Wrong aggregation level**: seasonality and patterns detected at too coarse a level (e.g.
  catalog-wide) can hide real SKU-level or region-level effects, and vice versa — a pattern real at
  one grain can vanish or invert at another.

## Recursive multi-step forecasting: error compounds with horizon

Many demand models (including this one) forecast day-by-day recursively — each day's prediction
feeds back in as a lag/rolling-window feature for the next day. This means small errors compound
geometrically the further out the horizon goes: near-term predictions are the most reliable,
and reliability degrades the further into the future you look, especially for lower-volume series
where noise makes up a larger share of the signal. This is a well-known, expected property of
recursive forecasting generally — not unique to this dataset — and is exactly why this product
tiers SKUs by confidence (High/Medium/Lower, ranked by backtest volume) rather than presenting one
flat accuracy number for every horizon and every SKU.

## Intermittent / lumpy demand

Low-volume or sparse SKUs — many zero-demand periods, occasional spikes — are one of the hardest
forecasting problems generally: demand variability is high, and both *when* the next order will
land and *how big* it'll be are difficult to predict. A high percentage error on a low-volume SKU
is often just the nature of sparse data, not necessarily a model deficiency.

## Promotions and discounts

Promotional/discount effects are notoriously hard to forecast well: true lift requires comparing
what actually happened against a modeled counterfactual (what would have sold without the promo),
which is inherently uncertain. Judgmental overrides for promotions can help when adjustments are
modest and grounded in real planned promo calendars, but can also introduce systematic bias —
marketing teams have been shown to typically over-forecast promotional uplift, while sales teams
sometimes under-forecast baseline demand to make targets easier to beat. A model that has never
seen a given discount depth in its training history has no learned relationship for it and will
under-react to it even if fed the planned discount value.

## The bullwhip effect

In multi-tier supply chains, small fluctuations in true end-consumer demand get amplified as they
propagate upstream — each tier over-reacts to the last order signal, batches orders, and adds its
own safety margin, so distributor/manufacturer order volatility ends up far larger than actual
consumer demand volatility. Relying on downstream order history (rather than true sell-through)
as a forecasting input is a classic way to unknowingly forecast the amplified noise instead of
real demand.

## Judgmental overrides and Forecast Value Added (FVA)

A statistical forecast is usually meant as a starting baseline, not a finished answer — human
context (planned promotions, known customer commitments, market intelligence) can genuinely
improve it. But un-tracked overrides can just as easily reintroduce the same biases the model was
built to remove. **Forecast Value Added (FVA)** is the practice of explicitly measuring whether
each step in a forecasting process (statistical baseline → analyst review → manager override →
consensus) actually improves accuracy versus a naive benchmark, or just adds noise/cost. Segmenting
where human judgment helps (promotions, new products, known one-off events) from where it typically
doesn't (stable, high-volume, well-behaved series) is a common, evidence-based practice.

## What planners typically want explained about a forecast

- **Why did this change** since last time — was it new actuals, a re-trained model, a changed
  input (price, promo, weather), or a manual override?
- **Which SKUs/periods should I trust least**, and why (volume, history length, recent volatility)?
- **Is a miss a data problem or a real demand shift** — worth investigating the underlying cause
  before reacting with an inventory or ordering decision.
- **What's driving a spike or drop** — a known calendar event (holiday), weather, a promotion, or
  genuinely unexplained (worth flagging honestly rather than forcing a narrative).
- **How far into the future can I actually trust this** — near-term is generally most reliable;
  say so plainly rather than presenting every horizon with equal confidence.
