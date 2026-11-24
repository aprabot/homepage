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
  var loaded = null, fetched = 0, busy = false, selected = null, drawn = null; // selected: the item the person picked; the top one until then
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
      var units = low.reduce(function (t, x) { return t + x.order; }, 0);
      out.push({ rank: urgent ? 0 : 1, tag: 'Stock', tone: urgent ? 'risk' : 'warn', icon: 'box', title: 'Reorder ' + skus(low.length),
        big: whole(units), unit: 'units to order', line: urgent ? names(low.filter(function (x) { return x.urgent; }).map(function (x) { return x.sku; }), 2) + (urgent === 1 ? ' runs' : ' run') + ' out before a new order could arrive.' : 'Stock is below the reorder point.',
        bars: low.map(function (x) { return { label: x.sku, value: x.lasts, text: x.lasts.toFixed(1) + ' weeks left', sub: 'order ' + whole(x.order), tone: x.urgent ? 'risk' : '' }; }),
        mark: { value: supply.lead / 7, text: 'New order arrives' },
        why: (urgent ? skus(urgent) + (urgent === 1 ? ' runs' : ' run') + ' out before a new order could arrive. ' : '') +
          'Orders cover a ' + supply.lead + '-day lead time plus safety stock. ' + source + '.',
        go: 'Inventory', label: 'Open Inventory' });
    }
    if (long.length) {
      long.sort(function (a, b) { return b.lasts - a.lasts; });
      out.push({ rank: 5, tag: 'Stock', tone: 'info', icon: 'box', title: 'Excess stock on ' + skus(long.length),
        big: long[0].lasts === Infinity ? '52+' : long[0].lasts.toFixed(0), unit: 'weeks of ' + long[0].sku, line: 'More than ' + LONG_COVER + ' weeks of stock on hand or on the way.',
        bars: long.map(function (x) { return { label: x.sku, value: Math.min(x.lasts, 60), text: x.lasts === Infinity ? 'over a year' : x.lasts.toFixed(0) + ' weeks', sub: x.over > 0 ? whole(x.over) + ' extra' : '' }; }),
        mark: { value: LONG_COVER, text: LONG_COVER + ' weeks' },
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
    var bars = function (items, tone) { return items.map(function (x) { return { label: x.sku, value: Math.abs(x.units), text: (x.units > 0 ? '+' : '−') + whole(Math.abs(x.units)), sub: pct(x.change), tone: tone }; }); };
    var net = function (items) { var t = items.reduce(function (a, x) { return a + x.units; }, 0); return (t > 0 ? '+' : '−') + whole(Math.abs(t)); };
    if (up.length) {
      up.sort(function (a, b) { return b.units - a.units; });
      out.push({ rank: 2, tag: 'Demand', tone: 'good', icon: 'up', title: skus(up.length) + ' growing', big: net(up), unit: 'units vs. last year', line: 'Over the next ' + n + ' weeks. Check supply can keep up.', bars: bars(up, 'good'), why: 'Next ' + n + ' weeks against the same weeks last year. Check supply can keep up.', go: 'Forecasts', label: 'See forecast' });
    }
    if (down.length) {
      down.sort(function (a, b) { return a.units - b.units; });
      out.push({ rank: 3, tag: 'Demand', tone: 'warn', icon: 'down', title: skus(down.length) + ' slowing', big: net(down), unit: 'units vs. last year', line: 'Over the next ' + n + ' weeks. A promotion could help.', bars: bars(down, 'warn'), why: 'Next ' + n + ' weeks against the same weeks last year. A promotion could help.', go: 'Scenarios', label: 'Test a promotion' });
    }
    // The highest stretch of weeks well above the average, not just one week.
    var f = base.all.f.slice(edge), total = sum(f);
    if (total != null && f.length >= 26) {
      var mean = total / f.length, top = f.indexOf(Math.max.apply(null, f)), bar = mean * (1 + PEAK / 100);
      if (f[top] >= bar) {
        var a = top, b = top;
        while (a > 0 && f[a - 1] >= bar) a--;
        while (b < f.length - 1 && f[b + 1] >= bar) b++;
        out.push({ rank: 4, tag: 'Demand', tone: 'info', icon: 'peak', title: 'Peak season ahead',
          big: pct(100 * (f[top] - mean) / mean), unit: 'above average', line: (b - a + 1) + ' busy week' + (b > a ? 's' : '') + ' from ' + weekDay(base.weeks[edge + a]) + '.',
          columns: f.map(function (v, i) { return { value: v, on: i >= a && i <= b, text: 'Week of ' + weekDay(base.weeks[edge + i]) + ': ' + whole(v) + ' units' }; }),
          ends: [weekDay(base.weeks[edge]), whole(f[top]) + ' units at the peak', weekDay(base.weeks[base.weeks.length - 1])],
          why: 'Weeks at least ' + PEAK + '% above the forecast’s average of ' + whole(mean) + ' units. Plan stock and promotions around them.', go: 'Forecasts', label: 'See forecast' });
      }
    }
    var weak = Object.keys(base.skus).map(function (sku) {
      return { sku: sku, wape: weakWape(base, sku), fresh: !(sum((base.skus[sku].lastYear || []).slice(edge, edge + n)) > 0) };
    }).filter(function (x) { return x.wape != null; });
    if (weak.length) {
      weak.sort(function (a, b) { return b.wape - a.wape; });
      out.push({ rank: 6, tag: 'Accuracy', tone: 'warn', icon: 'target', title: 'Check the forecast for ' + skus(weak.length),
        big: weak[0].wape.toFixed(0) + '%', unit: 'error on ' + weak[0].sku, line: weak[0].fresh ? 'It had no sales last year to learn from.' : 'Far above your other SKUs.',
        bars: weak.map(function (x) { return { label: x.sku, value: x.wape, text: x.wape.toFixed(0) + '% WAPE', sub: x.fresh && weak.length > 1 ? 'no sales last year' : '', tone: 'warn' }; }).slice(0, 3)
          .concat([{ label: 'All SKUs', value: base.overallWape, text: base.overallWape.toFixed(1) + '% WAPE', sub: '' }]),
        moreBars: Math.max(0, weak.length - 3),
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
      var known = found.filter(function (s) { return s.observed_units != null; });
      out.push({ rank: 7, tag: 'Promotions', tone: 'info', icon: 'tag', title: 'Past promotion' + (found.length === 1 ? '' : 's') + ' you could repeat',
        big: String(found.length), unit: 'found in your sales', line: known.length ? known[0].code + ' sold the most: ' + whole(known[0].observed_units) + ' units.' : 'Add a discount and dates to test one.',
        bars: found.map(function (s) { return { label: s.code, value: s.observed_units || 0, text: s.observed_units == null ? '' : whole(s.observed_units) + ' units', sub: s.last_seen ? 'last seen ' + day(s.last_seen + 'T00:00:00') : '' }; }),
        why: 'Found in your sales. Add a discount and dates to test one in Scenarios.', go: 'Discount Schemes', label: 'Set one up' });
    }
    if (saved.length) out.push({ rank: 7, tag: 'Promotions', tone: 'info', icon: 'tag', title: 'Saved scheme' + (saved.length === 1 ? '' : 's') + ' not in the plan', big: String(saved.length), unit: 'ready to test',
      line: 'Saved, but not applied to the forecast.', chips: saved.map(function (s) { return s.code; }), why: 'Saved, but not applied to the forecast. Test or commit them.', go: 'Scenarios', label: 'Test in a scenario' });
    if (over.length) out.push({ rank: 8, tag: 'Promotions', tone: 'info', icon: 'tag', title: 'Saved scheme' + (over.length === 1 ? ' that has' : 's that have') + ' ended', big: String(over.length), unit: 'out of date',
      line: 'Their dates are past, so they do nothing.', chips: over.map(function (s) { return s.code; }), why: 'Their dates are past, so they have no effect. Update the dates to use them.', go: 'Discount Schemes', label: 'Update dates' });
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
      out.push({ rank: 2, tag: 'Scenario', tone: 'good', icon: 'up', title: better.length === 1 ? 'A scenario beats the plan' : better.length + ' scenarios beat the plan',
        big: pct(better[0].money), unit: 'revenue, ' + better[0].label, line: 'Over the next 52 weeks, with ' + pct(better[0].units) + ' units.',
        bars: better.map(function (x) { return { label: x.label, value: x.money, text: pct(x.money) + ' revenue', sub: pct(x.units) + ' units', tone: 'good' }; }),
        why: 'Next 52 weeks, at the prices each run used.', go: 'Scenarios', label: 'Compare' });
    }
    if (elastic) out.push({ rank: 3, tag: 'Pricing', tone: 'good', icon: 'price', title: 'Test a small price rise',
      big: pct(elastic.money), unit: 'revenue from a ' + Math.abs(elastic.price) + '% price cut', line: 'The cut lost more in price than it gained in units.',
      diverging: [{ label: 'Price', value: elastic.price }, { label: 'Units', value: elastic.units }, { label: 'Revenue', value: elastic.money, judge: true }],
      why: 'From “' + elastic.label + '” against the plan, next 52 weeks. In the model a price cut added fewer units than it gave up in price, so a rise may earn more. It’s a hint from one run, so test it before acting.', go: 'Scenarios', label: 'Test a price rise' });
    return out;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var ICONS = {
    box: 'M3 8l9-5 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8', up: 'M4 16l6-6 4 4 6-7M15 7h5v5', down: 'M4 8l6 6 4-4 6 7M15 17h5v-5',
    peak: 'M3 19h18M4 19l5-9 3 4 3-7 5 12', target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
    tag: 'M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01', price: 'M19 5L5 19M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16.5 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  };

  function icon(name) {
    var box = el('span', 'ov-opp-ic');
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ICONS[name] + '"/></svg>';
    return box;
  }

  // Every bar carries its own value, so the chart is also the table.
  function barChart(item) {
    var box = el('div', 'ov-opp-bars'), bars = item.bars.slice(0, 6), more = (item.moreBars || 0) + Math.max(0, item.bars.length - 6);
    var max = Math.max.apply(null, bars.map(function (b) { return b.value; }).concat(item.mark ? [item.mark.value * 1.15] : [0])) || 1;
    bars.forEach(function (b) {
      var row = el('div', 'ov-opp-bar'), top = el('div', 'ov-opp-bar-t'), track = el('div', 'ov-opp-track'), fill = el('i');
      top.append(el('b', '', b.label), el('span', '', b.text));
      if (b.sub) top.append(el('small', '', b.sub));
      fill.style.width = Math.max(1, 100 * b.value / max) + '%';
      if (b.tone) fill.dataset.tone = b.tone;
      track.append(fill);
      if (item.mark) {
        var tick = el('u');
        tick.style.left = 100 * item.mark.value / max + '%';
        track.append(tick);
      }
      row.append(top, track);
      box.append(row);
    });
    if (item.mark) {
      var key = el('div', 'ov-opp-key');
      key.append(el('u'), item.mark.text + (/week/.test(item.mark.text) ? '' : ', ' + (item.mark.value % 1 ? item.mark.value.toFixed(1) : item.mark.value) + ' weeks'));
      box.append(key);
    }
    if (more) box.append(el('div', 'ov-opp-key', 'and ' + more + ' more'));
    return box;
  }

  function divergingChart(rows) {
    var box = el('div', 'ov-opp-div'), max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.value); })) || 1;
    rows.forEach(function (r) {
      var line = el('div'), track = el('div', 'ov-opp-dtrack'), fill = el('i');
      fill.style.width = 50 * Math.abs(r.value) / max + '%';
      fill.style[r.value < 0 ? 'right' : 'left'] = '50%';
      fill.dataset.sign = r.value < 0 ? 'down' : 'up';
      if (r.judge) fill.dataset.judge = '';
      track.append(fill);
      line.append(el('b', '', r.label), track, el('span', '', pct(r.value)));
      box.append(line);
    });
    return box;
  }

  function columnChart(item) {
    var box = el('div', 'ov-opp-cols'), plot = el('div', 'ov-opp-plot'), max = Math.max.apply(null, item.columns.map(function (c) { return c.value; })) || 1;
    var tip = el('div', 'ov-opp-tip');
    tip.hidden = true;
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', 'Weekly forecast. ' + item.line + ' ' + item.ends[1] + '.');
    item.columns.forEach(function (c) {
      var col = el('span'), fill = el('i');
      fill.style.height = Math.max(2, 100 * c.value / max) + '%';
      if (c.on) fill.dataset.on = '';
      col.append(fill);
      var show = function () { tip.textContent = c.text; tip.hidden = false; };
      col.addEventListener('mouseenter', show);
      col.addEventListener('click', show); // touch
      plot.append(col);
    });
    plot.addEventListener('mouseleave', function () { tip.hidden = true; });
    var ends = el('div', 'ov-opp-ends');
    ends.append(el('span', '', item.ends[0]), el('span', '', item.ends[2]));
    box.append(plot, ends, tip);
    return box;
  }

  var GROUPS = [['act', 'Act now'], ['grow', 'Grow'], ['watch', 'Watch']];
  function groupOf(item) { return item.rank <= 1 ? 'act' : item.tone === 'good' || item.tag === 'Promotions' ? 'grow' : 'watch'; }

  function choose(key, focus) {
    list.querySelectorAll('.ov-opp-item').forEach(function (b) {
      var on = b.dataset.key === key;
      b.setAttribute('aria-expanded', String(on));
      document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) b.focus();
    });
  }

  // A row in the list, and its detail. On wide screens the detail sits beside
  // the list; on phones it opens under its own row (see the CSS grid).
  function row(item, i) {
    var b = el('button', 'ov-opp-item'), titles = el('span', 'ov-opp-names'), figure = el('span', 'ov-opp-num', item.big);
    b.type = 'button';
    b.dataset.key = item.title;
    b.dataset.tone = item.tone;
    b.setAttribute('aria-controls', 'ovOpp' + i);
    titles.append(el('b', '', item.title), el('small', '', item.unit));
    b.append(icon(item.icon), titles, figure);
    b.addEventListener('click', function () { selected = item.title; choose(selected); });
    b.addEventListener('keydown', function (event) {
      var step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      var all = Array.from(list.querySelectorAll('.ov-opp-item')), next = all[(all.indexOf(b) + step + all.length) % all.length];
      selected = next.dataset.key;
      choose(selected, true);
    });
    return b;
  }

  function detail(item, i) {
    var box = el('section', 'ov-opp-detail');
    box.id = 'ovOpp' + i;
    box.dataset.tone = item.tone;
    box.setAttribute('aria-label', item.title);
    var figure = el('div', 'ov-opp-fig'), chart = item.bars ? barChart(item) : item.diverging ? divergingChart(item.diverging) : item.columns ? columnChart(item) : el('div', 'ov-opp-chips');
    figure.append(el('strong', '', item.big), el('span', '', item.unit));
    (item.chips || []).slice(0, 12).forEach(function (c) { chart.append(el('span', '', c)); });
    if (item.chips && item.chips.length > 12) chart.append(el('span', '', '+' + (item.chips.length - 12)));
    var go = el('button', 'ov-opp-go', item.label + ' →');
    go.type = 'button';
    go.addEventListener('click', function () { goToPanel(item.go); window.scrollTo(0, 0); });
    box.append(el('span', 'ov-opp-tag', item.tag), el('h5', '', item.title), figure, el('p', 'ov-opp-line', item.line), chart, el('p', 'ov-opp-why', item.why), go);
    return box;
  }

  function build(items) {
    var now = JSON.stringify(items);
    if (now === drawn) return; // nothing changed: keep focus and tooltips
    drawn = now;
    var held = list.contains(document.activeElement) && document.activeElement.dataset.key;
    var out = [], n = 0, rows = 0;
    GROUPS.forEach(function (g) {
      var mine = items.filter(function (x) { return groupOf(x) === g[0]; });
      if (!mine.length) return;
      var head = el('div', 'ov-opp-group', g[1]);
      out.push(head);
      rows++;
      mine.forEach(function (item) {
        out.push(row(item, n), detail(item, n));
        n++;
        rows++;
      });
    });
    list.replaceChildren.apply(list, out);
    list.style.setProperty('--rows', rows);
    var keys = Array.from(list.querySelectorAll('.ov-opp-item')).map(function (b) { return b.dataset.key; });
    if (keys.length) choose(keys.includes(selected) ? selected : keys[0], !!held && keys.includes(held) && held === selected);
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
    build(items);
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
  // Coming back to Overview: stock or schemes may have changed elsewhere.
  document.querySelectorAll('.dnav li').forEach(function (li) {
    if (li.title === 'Overview') li.addEventListener('click', function () { if (fetched && Date.now() - fetched > 15000) read(); });
  });
})();
