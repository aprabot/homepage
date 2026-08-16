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

## Backtest accuracy vs. forward-forecast reliability

A backtest score (WAPE, bias, etc. measured against known historical actuals) tells you how the
model performed on data it can be graded against — it does **not** by itself guarantee the same
accuracy on the genuinely-future, no-actuals-yet horizon, because the future can differ from the
backtest window in ways the model has no way to detect in advance (new seasonality, a regime
change, a promotion calendar that doesn't resemble history). Backtest accuracy is necessary
evidence of a sound model, but not sufficient proof of forward performance — the two are related
but distinct questions, and a good forecasting product keeps them visibly separate rather than
implying one number covers both. **Refresh/re-forecast cadence** (how often a forecast is
re-anchored against newly-arrived actuals) is a deliberate trade-off: refreshing more often keeps
the forecast responsive to real recent shifts, but too-frequent refreshing on noisy data can make
the forecast jumpy and harder to plan against — there's no universally "correct" cadence, it
depends on how fast the underlying demand genuinely moves.

## Why tree-based models respond to price/discount in "steps," not smoothly

Gradient-boosted tree models (like LightGBM, XGBoost, and similar) — one of the most common model
families for tabular demand forecasting — don't learn a smooth mathematical curve relating a
feature (like discount depth) to the outcome the way a linear or logistic regression would. Instead
they partition the training data into a large number of if/then splits, and every input that lands
in the same partition ("leaf") gets the *exact same* predicted adjustment, regardless of how far
into that partition's range it falls. Two practical consequences that surprise people new to this
model family: (1) predictions **cannot extrapolate** past the range of values seen in training —
if the model never saw a 90%-off discount, feeding it one won't produce a bigger response than the
biggest discount it did see, it'll just reuse the nearest leaf's learned value; and (2) even
*within* the training range, the response to a changing input can look "flat" between two
thresholds and then "jump" at a split point, rather than scaling proportionally — so going from a
10% to a 20% discount might move the forecast measurably, while going from 40% to 60% might barely
move it at all, if the model's splits happen to cluster more resolution in the lower range (usually
because that's where more of the real historical examples actually were). This is a structural
property of how these models represent functions, not a sign the model is broken — and it means
"does the forecast respond to a bigger input change" depends heavily on whether that specific range
was well-represented, with enough distinct examples, in the training history.

## Seasonality and calendar effects

Demand for most products/services isn't flat over time — it moves with day-of-week, month, and
holiday patterns that repeat year over year. A model can only learn these patterns if they're
represented as explicit features (day-of-week, week-of-year, "is this a holiday," days-to/from a
holiday) — a raw date column carries no seasonal information a model can generalize from on its
own. **Moving holidays** (ones that shift date year to year on the civil calendar — Easter, Lunar
New Year, Ramadan/Eid, and similar) are a common source of forecast error if they're not modeled
explicitly, since a fixed "same week last year" comparison silently misaligns them. Local/regional
holidays matter too when demand is forecast at a sub-national level — a national model can miss a
region-specific pattern entirely.

## Weather as an exogenous demand driver

Temperature, precipitation, and related conditions are a real driver for weather-sensitive
categories (beverages, seasonal apparel, produce, HVAC-adjacent goods, and many others) — sustained
heat or cold, not just a single day's reading, is often the more informative signal (a single hot
day may not move demand much; a multi-day heatwave usually does). The practical catch: for weather
to be usable at *forecast* time (not just to explain the past), the model needs a genuine forward
weather forecast as an input, not historical weather — and weather forecasts themselves are only
reliably accurate roughly 7-10 days out; beyond that, "forecasts" are really climatological/seasonal
normals, which capture typical seasonal temperature shape but miss real short-term anomalies. So
weather as a forward demand driver is most trustworthy near-term and should be treated as a
seasonal-shape input, not a precise prediction, further out.

## Safety stock and turning forecast error into an inventory decision

A point forecast alone doesn't tell you how much safety stock to hold — that depends on the
forecast's *uncertainty* (how wrong it tends to be) and the service level you're targeting (what
probability of not stocking out you're willing to pay for). Wider forecast error and/or a higher
target service level both push safety stock up; a common simplified framing is safety stock scaling
with the standard deviation of forecast error and a service-level multiplier (e.g. via a normal-
distribution z-score), though real supply chains layer on lead-time variability too. The broader
point for a planner: two SKUs with the same point forecast but very different historical
error/volatility shouldn't be stocked the same way — the *confidence* in a forecast is itself a
decision input, not just the number.

## Hierarchical forecasting and reconciliation

When demand can be viewed at multiple levels of aggregation (e.g. SKU x location, rolled up to SKU,
rolled up to total), forecasts at each level don't automatically agree with each other unless
explicitly reconciled — a common and non-obvious result is that the more aggregated forecast is
usually *more* accurate than the sum of independently-produced granular forecasts, because
independent errors at the granular level partly cancel out when summed, while a systematic
(biased) error does not. **Bottom-up** reconciliation (forecast at the most granular level, sum
up) preserves granular detail but inherits granular noise; **top-down** (forecast the aggregate,
allocate down by historical share) is smoother but can miss real granular-level shifts; most modern
approaches use some blend. Practically: don't expect a fine-grained (e.g. per-location) forecast to
hit the same accuracy as the aggregate view of the same data — that gap is expected, not a defect.

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
- **Why didn't a bigger change in an input (price, discount, etc.) produce a proportionally bigger
  forecast change** — often a real model-behavior question, not a bug; see the tree-model-response
  and training-range sections above.
