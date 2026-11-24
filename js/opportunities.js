/* Overview: Opportunities. Every item is worked out from the live forecast,
   the stock file, discount schemes and the scenarios shown in the matrix.
   Anything without data is left out and said so. Loaded after main.js,
   scenario-forecast.js and overview-matrix.js. */
(function () {
  'use strict';
  var API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var INVENTORY = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/forecast?type=inventory';
  var list = document.getElementById('ovOppList');
  if (!list) return;
  var LONG_COVER = 26, GROWTH = 10, PEAK = 25, WEAK_WAPE = 20;
  var loaded = null, fetched = 0, busy = false, showAll = false;
  var supply = null;        // {safety: {sku}, lead: days, stock: {..}|null}; null until read
  var schemes = null;       // null until read
  var runs = {};            // run id -> {run, entry} from the matrix

  function plan() { return loaded && window.DATA && window.DATA.id ? window.DATA : null; }
  function start(d) { return d.backtestWeeks == null ? d.weeks.length : d.backtestWeeks; }
  function whole(n) { return Math.round(n).toLocaleString(); }
  function pct(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function sum(values) { return values.length && values.every(Number.isFinite) ? values.reduce(function (a, b) { return a + b; }, 0) : null; }
  function day(text) {
    var d = new Date(text);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function weekDay(week) { return day(week + 'T00:00:00'); }
  function names(items, n) {
    return items.slice(0, n).join(', ') + (items.length > n ? ' and ' + (items.length - n) + ' more' : '');
  }
  function skus(n) { return n + ' SKU' + (n === 1 ? '' : 's'); }

  // Weeks of forecast a quantity covers, from week `from`; null past the end.
  function cover(f, from, quantity) {
    for (var i = from, n = 0; i < f.length; i++, n++) {
      if (!Number.isFinite(f[i])) return null;
      if (quantity < f[i]) return n + quantity / f[i];
      quantity -= f[i];
    }
    return Infinity;
  }

  // A SKU's error over the actuals, when it is too high to lean on.
  function weakWape(base, sku) {
    var edge = start(base), item = base.skus[sku], w = seriesWape(item.a.slice(0, edge), item.f.slice(0, edge)).overall;
    return Number.isFinite(w) && w >= WEAK_WAPE && w >= 2 * base.overallWape ? w : null;
  }

  function stockItems(base) {
    if (!supply || !supply.stock) return [];
    var stock = supply.stock, edge = start(base), weeks = Math.max(1, Math.ceil(supply.lead / 7));
    // From the week the stock was counted, or uploaded if the file has no date.
    var asOf = new Date(stock.as_of || stock.uploaded_at), from = edge;
    while (from + 1 < base.weeks.length && new Date(base.weeks[from + 1] + 'T00:00:00') <= asOf) from++;
    var low = [], long = [];
    Object.keys(base.skus).forEach(function (sku) {
      var held = stock.by_sku[sku], f = base.skus[sku].f, safety = supply.safety[sku];
      if (!held || held.present == null) return;
      var have = held.present + (held.intransit || 0) + (held.openpo || 0);
      var lead = sum(f.slice(from, from + weeks)), lasts = cover(f, from, have);
      if (lead == null || lasts == null || f.length < from + weeks) return;
      if (Number.isFinite(safety) && have < lead + safety) low.push({ sku: sku, order: lead + safety - have, lasts: lasts, urgent: have < lead });
      else if (lasts > LONG_COVER) {
        var enough = sum(f.slice(from, from + LONG_COVER));
        long.push({ sku: sku, lasts: lasts, over: enough == null ? null : have - enough });
      }
    });
    var out = [], source = 'Stock file' + (stock.as_of ? ' as of ' + day(stock.as_of) : ' uploaded ' + day(stock.uploaded_at)) + ', counting stock in transit and on order';
    if (low.length) {
      low.sort(function (a, b) { return a.lasts - b.lasts; });
      var urgent = low.filter(function (x) { return x.urgent; }).length;
      out.push({ rank: urgent ? 0 : 1, tag: 'Stock', tone: urgent ? 'risk' : 'warn', title: 'Reorder ' + skus(low.length),
        rows: low.map(function (x) { return [x.sku, 'order ' + whole(x.order), x.lasts === Infinity ? '' : 'lasts ' + x.lasts.toFixed(1) + ' weeks']; }),
        why: (urgent ? skus(urgent) + (urgent === 1 ? ' runs' : ' run') + ' out before a new order could arrive. ' : '') +
          'Orders cover a ' + supply.lead + '-day lead time plus safety stock. ' + source + '.',
        go: 'Inventory', label: 'Open Inventory' });
    }
    if (long.length) {
      long.sort(function (a, b) { return b.lasts - a.lasts; });
      out.push({ rank: 5, tag: 'Stock', tone: 'info', title: 'Excess stock on ' + skus(long.length),
        rows: long.map(function (x) { return [x.sku, x.lasts === Infinity ? 'more than the forecast' : x.lasts.toFixed(0) + ' weeks of cover', x.over > 0 ? whole(x.over) + ' beyond ' + LONG_COVER + ' weeks' : '']; }),
        why: (long.some(function (x) { return weakWape(base, x.sku) != null; }) ? 'The forecast for ' + names(long.filter(function (x) { return weakWape(base, x.sku) != null; }).map(function (x) { return x.sku; }), 3) +
          ' isn’t reliable yet, so check it first. ' : '') + 'A discount could clear it. ' + source + '.', go: 'Scenarios', label: 'Test a discount' });
    }
    return out;
  }

  function demandItems(base) {
    var edge = start(base), n = Math.min(12, base.weeks.length - edge), up = [], down = [], out = [];
    if (n < 4) return out;
    Object.keys(base.skus).forEach(function (sku) {
      var item = base.skus[sku], now = sum(item.f.slice(edge, edge + n)), then = sum((item.lastYear || []).slice(edge, edge + n));
      if (now == null || !(then > 0)) return;
      var change = 100 * (now - then) / then;
      if (change >= GROWTH) up.push({ sku: sku, change: change, units: now - then });
      else if (change <= -GROWTH) down.push({ sku: sku, change: change, units: now - then });
    });
    var rows = function (items) { return items.map(function (x) { return [x.sku, pct(x.change), (x.units > 0 ? '+' : '−') + whole(Math.abs(x.units)) + ' units']; }); };
    if (up.length) {
      up.sort(function (a, b) { return b.units - a.units; });
      out.push({ rank: 2, tag: 'Demand', tone: 'good', title: 'Growing: ' + skus(up.length), rows: rows(up), why: 'Next ' + n + ' weeks against the same weeks last year. Check supply can keep up.', go: 'Forecasts', label: 'See forecast' });
    }
    if (down.length) {
      down.sort(function (a, b) { return a.units - b.units; });
      out.push({ rank: 3, tag: 'Demand', tone: 'warn', title: 'Slowing: ' + skus(down.length), rows: rows(down), why: 'Next ' + n + ' weeks against the same weeks last year. A promotion could help.', go: 'Scenarios', label: 'Test a promotion' });
    }
    // The highest stretch of weeks well above the average, not just one week.
    var f = base.all.f.slice(edge), total = sum(f);
    if (total != null && f.length >= 26) {
      var mean = total / f.length, top = f.indexOf(Math.max.apply(null, f)), bar = mean * (1 + PEAK / 100);
      if (f[top] >= bar) {
        var a = top, b = top;
        while (a > 0 && f[a - 1] >= bar) a--;
        while (b < f.length - 1 && f[b + 1] >= bar) b++;
        out.push({ rank: 4, tag: 'Demand', tone: 'info', title: 'Peak season ahead',
          rows: [['Starts', weekDay(base.weeks[edge + a]), ''], ['Lasts', (b - a + 1) + ' week' + (b > a ? 's' : ''), ''],
            ['Highest week', whole(f[top]) + ' units', pct(100 * (f[top] - mean) / mean) + ' vs. average']],
          why: 'Weeks at least ' + PEAK + '% above the forecast’s average of ' + whole(mean) + ' units. Plan stock and promotions around them.', go: 'Forecasts', label: 'See forecast' });
      }
    }
    var weak = Object.keys(base.skus).map(function (sku) {
      return { sku: sku, wape: weakWape(base, sku), fresh: !(sum((base.skus[sku].lastYear || []).slice(edge, edge + n)) > 0) };
    }).filter(function (x) { return x.wape != null; });
    if (weak.length) {
      weak.sort(function (a, b) { return b.wape - a.wape; });
      out.push({ rank: 6, tag: 'Accuracy', tone: 'warn', title: 'Check the forecast for ' + skus(weak.length),
        rows: weak.map(function (x) { return [x.sku, x.wape.toFixed(0) + '% WAPE', x.fresh ? 'no sales last year' : '']; }),
        why: 'Error over ' + edge + ' weeks of actuals; all SKUs together are at ' + base.overallWape.toFixed(1) + '%. Treat these numbers with care.', go: 'Forecasts', label: 'See forecast' });
    }
    return out;
  }

  function schemeItems() {
    if (!schemes) return [];
    var today = new Date().toISOString().slice(0, 10), out = [];
    var found = schemes.filter(function (s) { return s.detected && !s.version; });
    var saved = schemes.filter(function (s) { return s.status === 'draft' && (s.scope || []).some(function (l) { return l.end_date >= today; }); });
    var over = schemes.filter(function (s) { return s.status === 'draft' && (s.scope || []).length && !(s.scope || []).some(function (l) { return l.end_date >= today; }); });
    if (found.length) {
      found.sort(function (a, b) { return (b.observed_units || 0) - (a.observed_units || 0); });
      out.push({ rank: 7, tag: 'Promotions', tone: 'info', title: found.length + ' past promotion' + (found.length === 1 ? '' : 's') + ' you could repeat',
        rows: found.map(function (s) { return [s.code, s.observed_units == null ? '' : whole(s.observed_units) + ' units sold', s.last_seen ? 'last seen ' + day(s.last_seen + 'T00:00:00') : '']; }),
        why: 'Found in your sales. Add a discount and dates to test one in Scenarios.', go: 'Discount Schemes', label: 'Set one up' });
    }
    if (saved.length) out.push({ rank: 7, tag: 'Promotions', tone: 'info', title: saved.length + ' saved scheme' + (saved.length === 1 ? '' : 's') + ' not in the plan',
      rows: saved.map(function (s) { return [s.code, s.name || '', '']; }), why: 'Saved, but not applied to the forecast. Test or commit them.', go: 'Scenarios', label: 'Test in a scenario' });
    if (over.length) out.push({ rank: 8, tag: 'Promotions', tone: 'info', title: over.length + ' saved scheme' + (over.length === 1 ? ' has' : 's have') + ' ended',
      rows: over.map(function (s) { return [s.code, s.name || '', '']; }), why: 'Their dates are past, so they have no effect. Update the dates to use them.', go: 'Discount Schemes', label: 'Update dates' });
    return out;
  }

  function scenarioItems(base) {
    var better = [], elastic = null;
    Object.keys(runs).forEach(function (id) {
      var run = runs[id].run, entry = runs[id].entry;
      if (entry.state !== 'ready' || !entry.pricing || !entry.pricing.scenario || !entry.pricing.base) return;
      var t = scenarioForecast.compare(entry.result, base, entry.pricing, 52);
      if (!t || t.base == null || !(t.base > 0) || !t.baseRevenue || !(t.baseRevenue.value > 0) || t.revenue.missing || t.baseRevenue.missing) return;
      var money = 100 * (t.revenue.value - t.baseRevenue.value) / t.baseRevenue.value, units = 100 * (t.scenario - t.base) / t.base;
      if (money >= 1) better.push({ label: run.label || 'Untitled', money: money, units: units });
      var levers = run.levers || {}, keys = Object.keys(levers).filter(function (k) { var v = levers[k]; return v !== '' && v != null && v !== false && !(Array.isArray(v) && !v.length); });
      if (keys.length === 1 && keys[0] === 'price_pct' && Math.abs(levers.price_pct) >= 5 && !entry.pricing.scenario.schemes.length && !elastic) {
        var e = units / levers.price_pct;
        // Only when the model says demand moved the expected way, and by less than the price.
        if (e < 0 && e > -0.8 && levers.price_pct < 0) elastic = { label: run.label || 'Untitled', price: levers.price_pct, units: units, money: money };
      }
    });
    var out = [];
    if (better.length) {
      better.sort(function (a, b) { return b.money - a.money; });
      out.push({ rank: 2, tag: 'Scenario', tone: 'good', title: better.length === 1 ? 'A scenario beats the plan on revenue' : better.length + ' scenarios beat the plan on revenue',
        rows: better.map(function (x) { return [x.label, pct(x.money) + ' revenue', pct(x.units) + ' units']; }), why: 'Next 52 weeks, at the prices each run used.', go: 'Scenarios', label: 'Compare' });
    }
    if (elastic) out.push({ rank: 3, tag: 'Pricing', tone: 'good', title: 'Test a small price rise',
      rows: [[elastic.label, pct(elastic.price) + ' price', pct(elastic.units) + ' units'], ['Revenue', pct(elastic.money), 'vs. plan']],
      why: 'In the model a price cut added fewer units than it gave up in price, so a rise may earn more. It’s a hint from one run, so test it before acting.', go: 'Scenarios', label: 'Test a price rise' });
    return out;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function card(item) {
    var box = el('article', 'ov-opp-card');
    box.dataset.tone = item.tone;
    box.append(el('span', 'ov-opp-tag', item.tag), el('h5', '', item.title));
    var table = el('div', 'ov-opp-rows');
    item.rows.slice(0, 4).forEach(function (row) {
      var line = el('div');
      line.append(el('b', '', row[0]), el('span', '', row[1]), el('small', '', row[2] || ''));
      table.append(line);
    });
    if (item.rows.length > 4) table.append(el('div', 'ov-opp-more', 'and ' + (item.rows.length - 4) + ' more'));
    box.append(table, el('p', '', item.why));
    var go = el('button', 'ov-opp-go', item.label + ' →');
    go.type = 'button';
    go.addEventListener('click', function () { goToPanel(item.go); window.scrollTo(0, 0); });
    box.append(go);
    return box;
  }

  function render() {
    if (loaded === null) return;
    var base = plan(), empty = document.getElementById('ovOppEmpty'), items = [], gaps = [];
    if (base) {
      items = stockItems(base).concat(demandItems(base), scenarioItems(base), schemeItems())
        .map(function (x, i) { x.order = i; return x; }).sort(function (a, b) { return a.rank - b.rank || a.order - b.order; });
      if (supply && !supply.stock) gaps.push(supply.error ? 'stock couldn’t be read' : 'add a stock file on Inventory to check stock');
      if (schemes === false) gaps.push('promotions couldn’t be read');
    }
    var reading = base && (supply === null || schemes === null);
    document.getElementById('ovOppCount').textContent = reading && !items.length ? '…' : items.length;
    list.replaceChildren.apply(list, (showAll ? items : items.slice(0, 6)).map(card));
    var more = document.getElementById('ovOppMore');
    more.hidden = items.length <= 6;
    more.textContent = showAll ? 'Show fewer' : 'Show all ' + items.length;
    empty.hidden = items.length > 0;
    empty.querySelector('p').textContent = !base ? 'Your forecast couldn’t be loaded' : reading ? 'Checking your data…' : 'Nothing needs attention right now';
    empty.querySelector('.sub').textContent = !base || reading ? '' : 'Stock, demand, accuracy, promotions and scenarios were checked against your live forecast.';
    document.getElementById('ovOppNote').textContent = 'From your live forecast, stock, promotions and scenarios' + (gaps.length ? ' · ' + gaps.join(' · ') : '');
  }

  function read() {
    if (busy || !plan()) return;
    busy = true;
    fetched = Date.now();
    var get = function (url) { return APRA_SESSION.fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); };
    Promise.allSettled([get(INVENTORY), get(API + '?view=inbound'), get(API + '?view=schemes')]).then(function (all) {
      busy = false;
      var value = function (i) { return all[i].status === 'fulfilled' ? all[i].value : null; };
      var inv = value(0), stock = value(1) && value(1).stock, safety = {};
      Object.keys((inv && inv.bySku) || {}).forEach(function (sku) {
        var last = Object.values(inv.bySku[sku].byZip || {}).map(function (zip) { return (zip.safetyStock || []).at(-1); });
        if (last.length && last.every(Number.isFinite)) safety[sku] = last.reduce(function (a, b) { return a + b; }, 0);
      });
      var days = inv && inv.params && Number(inv.params.leadTimeDays);
      var ok = stock && stock.status === 'ok' && inv && days > 0;
      supply = { safety: safety, lead: days, stock: ok ? stock : null, error: !value(1) || (stock && stock.status === 'error') || (stock && stock.status === 'ok' && !ok) };
      schemes = value(2) && Array.isArray(value(2).schemes) ? value(2).schemes : false;
      render();
    });
  }

  document.addEventListener('apra:overview', function (event) {
    loaded = event.detail.loaded;
    if (!fetched) read();
    render();
  });
  document.addEventListener('apra:matrix-runs', function (event) { runs = event.detail; render(); });
  document.getElementById('ovOppMore').addEventListener('click', function () { showAll = !showAll; render(); });
  // Coming back to Overview: stock or schemes may have changed elsewhere.
  document.querySelectorAll('.dnav li').forEach(function (li) {
    if (li.title === 'Overview') li.addEventListener('click', function () { if (fetched && Date.now() - fetched > 15000) read(); });
  });
})();
