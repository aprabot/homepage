/* Scenario workspace: the weekly chart and results table, the same as on
   Forecasts. The chart is main.js's own painter (paintForecast) and the table
   shares the Forecasts styles; this file feeds both from a scenario's result
   and adds the approved plan. Loaded after main.js, before scenarios.js. */
(function () {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var PAGE = 25;
  var run = null;       // the scenario's result
  var base = null;      // the approved plan's result
  var pair = {};        // scenario SKU -> plan SKU (the same product)
  var sku = 'ALL', zip = '', horizon = 52, full = false, page = 1, geom = null;
  var sort = { key: 'units', dir: 'desc' };
  var visible = { a: true, f: true, p: true, w: true };
  var onTotals = null;

  function start(d) { return d.backtestWeeks == null ? d.weeks.length : d.backtestWeeks; }
  function finite(v) { return Number.isFinite(v); }

  // SKU numbers are assigned per run, so the same number can be a different
  // product in another run. Two SKUs are paired only when their actual sales
  // agree on every week both runs have; otherwise the plan shows as unknown.
  function pairSkus() {
    pair = {};
    if (!base) return;
    var at = new Map(base.weeks.map(function (w, i) { return [w, i]; }));
    var common = [];
    run.weeks.slice(0, start(run)).forEach(function (w, i) { if (at.has(w) && at.get(w) < start(base)) common.push([i, at.get(w)]); });
    if (!common.length) return;
    var agrees = function (mine, theirs) {
      return !!theirs && common.every(function (c) { return (mine.a[c[0]] == null ? null : mine.a[c[0]]) === (theirs.a[c[1]] == null ? null : theirs.a[c[1]]); });
    };
    Object.keys(run.skus).forEach(function (id) {
      var match = agrees(run.skus[id], base.skus[id]) ? id
        : Object.keys(base.skus).filter(function (other) { return agrees(run.skus[id], base.skus[other]); });
      if (Array.isArray(match)) match = match.length === 1 ? match[0] : null;
      if (match) pair[id] = match;
    });
  }

  // Sum of one postal code across SKUs; null where no SKU has a value.
  function zipTotal(d, code) {
    var parts = Object.keys(d.skus).map(function (id) { return (d.skus[id].byZip || {})[code]; }).filter(Boolean);
    if (!parts.length) return null;
    var sum = function (key) {
      return d.weeks.map(function (_, i) {
        var known = parts.map(function (p) { return (p[key] || [])[i]; }).filter(finite);
        return known.length ? known.reduce(function (x, y) { return x + y; }, 0) : null;
      });
    };
    return { a: sum('a'), f: sum('f') };
  }

  function seriesOf(d, id, code) {
    if (!d) return null;
    if (id === 'ALL') return code ? zipTotal(d, code) : d.all;
    var item = d.skus[id];
    return !item ? null : code ? (item.byZip || {})[code] || null : item;
  }

  function planSeries(id, code) {
    return base ? seriesOf(base, id === 'ALL' ? 'ALL' : pair[id], code) : null;
  }

  // The plan's forecast on the scenario's forward weeks, by week label.
  function planOnWeeks(series, weeks, offset) {
    if (!series || !base) return weeks.map(function () { return null; });
    var from = start(base), at = new Map(base.weeks.map(function (w, i) { return [w, i]; }));
    return weeks.map(function (w, i) {
      var j = at.get(w);
      return offset + i < start(run) || j == null || j < from ? null : finite(series.f[j]) ? series.f[j] : null;
    });
  }

  function weeksAhead() {
    var from = start(run), future = run.all.f.slice(from, from + horizon);
    var gap = future.findIndex(function (v) { return !finite(v); });
    return gap < 0 ? future.length : gap;
  }

  function total(values) {
    return values.length && values.every(finite) ? values.reduce(function (x, y) { return x + y; }, 0) : null;
  }

  function change(now, before) { return now != null && before > 0 ? 100 * (now - before) / before : null; }

  function figures(id, code, count) {
    var s = seriesOf(run, id, code), from = start(run);
    if (!s) return null;
    var units = total(s.f.slice(from, from + count));
    var prior = total((s.lastYear || []).slice(from, from + count));
    if ((s.lastYear || []).slice(from, from + count).length < count) prior = null;
    var plan = total(planOnWeeks(planSeries(id, code), run.weeks.slice(from, from + count), from));
    var price = id === 'ALL' ? null : run.skus[id].avgPrice;
    var first = Math.max(0, from - horizon);
    return { sku: id, units: units, plan: plan, vsPlan: change(units, plan), prior: prior, change: change(units, prior),
             revenue: units != null && finite(price) ? units * price : null,
             wape: seriesWape(s.a.slice(first, from), s.f.slice(first, from)).overall };
  }

  function pct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }

  function draw() {
    if (!run || el('scfBody').hidden) return null;
    var s = seriesOf(run, sku, zip);
    if (!s) return null;
    var length = run.weeks.length, edge = start(run), hasForward = edge < length;
    var context = hasForward ? Math.min(edge, Math.max(8, Math.min(horizon, 26))) : 0;
    var end = hasForward ? Math.min(length, edge + horizon) : length;
    var from = hasForward ? (full ? 0 : edge - context) : Math.max(0, length - horizon);
    var weeks = run.weeks.slice(from, end);
    var w = (s.w || seriesWape(s.a, s.f).w).slice(from, end);
    var a = s.a.slice(from, end), f = s.f.slice(from, end);
    var plan = planOnWeeks(planSeries(sku, zip), weeks, from);
    el('scfLegend').querySelectorAll('.lgd-item').forEach(function (item) {
      var values = { a: a, w: w, p: plan, f: f }[item.dataset.k];
      item.hidden = !values.some(finite);
    });
    el('scfSub').textContent = !hasForward ? 'Last ' + weeks.length + ' weeks of the backtest'
      : full ? 'Full backtest history, then the next ' + (end - edge) + ' weeks of forecast'
      : 'Last ' + context + ' weeks of actuals, then the next ' + (end - edge) + ' weeks of forecast';
    geom = paintForecast(el('scfChart'), el('scfCanvas'), { weeks: weeks, a: a, f: f, w: w, plan: plan, boundary: edge - from, visible: visible });
    return geom;
  }

  function render() {
    if (!run) return;
    var s = seriesOf(run, sku, zip);
    var name = sku === 'ALL' ? 'All SKUs' : sku;
    el('scfName').textContent = zip ? name + ' · ' + zip : name;
    var overall = sku === 'ALL' && !zip ? run.overallWape : seriesWape(s.a, s.f).overall;
    el('scfWape').textContent = overall == null ? '—' : overall.toFixed(2) + '%';
    el('scfSku').value = sku === 'ALL' ? '' : sku;
    el('scfSkuFilter').value = sku;
    draw();
    if (onTotals) {
      var edge = start(run), count = weeksAhead();
      var plan = planOnWeeks(planSeries('ALL', ''), run.weeks.slice(edge, edge + count), edge);
      var mine = run.all.f.slice(edge, edge + count), both = { base: 0, scenario: 0, weeks: 0 };
      mine.forEach(function (v, i) { if (finite(v) && finite(plan[i])) { both.base += plan[i]; both.scenario += v; both.weeks++; } });
      onTotals(both.weeks ? both : null);
    }
    table();
  }

  function table() {
    var count = weeksAhead();
    var rows = (sku === 'ALL' ? Object.keys(run.skus) : [sku]).map(function (id) { return figures(id, zip, count); }).filter(Boolean);
    var dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort(function (x, y) {
      var a = x[sort.key], b = y[sort.key];
      if (typeof a === 'string') return a.localeCompare(b) * dir;
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * dir;
    });
    var all = rows.length, pages = Math.max(1, Math.ceil(all / PAGE));
    page = Math.min(page, pages);
    var first = (page - 1) * PAGE;
    rows = rows.slice(first, first + PAGE);
    el('scfCount').textContent = all ? 'Showing ' + (first + 1).toLocaleString() + '–' + (first + rows.length).toLocaleString() + ' of ' + all.toLocaleString() + ' SKUs' : 'No SKUs';
    el('scfPrev').hidden = el('scfNext').hidden = pages === 1;
    el('scfPrev').disabled = page === 1;
    el('scfNext').disabled = page === pages;
    el('scfScroll').scrollTop = 0;
    el('scfTable').querySelectorAll('.amp-sortable').forEach(function (th) {
      var on = th.dataset.sortKey === sort.key;
      th.querySelector('.ov-sort-ic').textContent = on ? (sort.dir === 'asc' ? '↑' : '↓') : '⇅';
      if (on) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    });
    var trend = function (v) { return v > 0 ? 'fc-up' : v < 0 ? 'fc-down' : ''; };
    el('scenarioWorkspaceRows').replaceChildren.apply(el('scenarioWorkspaceRows'), rows.map(function (r) {
      var tr = document.createElement('tr'), head = document.createElement('th');
      head.scope = 'row';
      head.className = 'skucell';
      head.textContent = r.sku;
      tr.append(head);
      [[r.units, nfFull], [r.plan, nfFull], [r.vsPlan, pct, trend(r.vsPlan)], [r.prior, nfFull], [r.change, pct, trend(r.change)],
       [r.revenue, nfFull], [r.wape, function (v) { return v.toFixed(1) + '%'; }]].forEach(function (c) {
        var td = tr.insertCell();
        td.className = 'fcly-number' + (c[0] == null ? ' ov-dim' : c[2] ? ' ' + c[2] : '');
        td.textContent = c[0] == null ? '—' : c[1](c[0]);
      });
      return tr;
    }));
  }

  function zipOptions() {
    var items = sku === 'ALL' ? Object.values(run.skus) : [run.skus[sku]];
    var zips = Array.from(new Set(items.flatMap(function (item) { return Object.keys(item.byZip || {}); }))).sort();
    el('scfZip').replaceChildren.apply(el('scfZip'), [new Option('All ZIP codes', '')].concat(zips.map(function (z) { return new Option(z, z); })));
    if (!zips.includes(zip)) zip = '';
    el('scfZip').value = zip;
    el('scfZip').disabled = !zips.length;
  }

  function pick(id, code) {
    if (id !== 'ALL' && !run.skus[id]) {
      el('scfName').textContent = 'SKU “' + id + '” not found';
      el('scfWape').textContent = '—';
      return;
    }
    sku = id;
    zip = code || '';
    page = 1;
    zipOptions();
    render();
  }

  function clear(message, loading) {
    run = base = null;
    el('scfBody').hidden = !loading;
    el('scfResults').hidden = !loading;
    el('scfSkel').style.display = loading ? '' : 'none';
    el('scfCanvas').style.visibility = loading ? 'hidden' : '';
    el('scfControls').hidden = true;
    el('scfLegend').hidden = !!loading;
    var status = el('scenarioGraphStatus');
    status.textContent = message;
    status.hidden = !!loading;
    if (loading) {
      el('scfName').textContent = 'Loading…';
      el('scfWape').textContent = '—';
      el('scfSub').textContent = 'Loading the scenario’s forecast';
      el('scfCount').textContent = 'Loading results…';
      el('scenarioWorkspaceRows').innerHTML = ('<tr class="skel-row">' + '<td><span class="skel-line"></span></td>'.repeat(8) + '</tr>').repeat(3);
    } else {
      el('scfSub').textContent = 'Recent actuals and the forecast ahead';
      el('scenarioWorkspaceRows').replaceChildren();
    }
  }

  // note: shown when the run's prices differ from the history revenue uses.
  function show(result, plan, options) {
    run = result;
    base = plan && Array.isArray(plan.weeks) && plan.skus ? plan : null;
    onTotals = options && options.onTotals;
    pairSkus();
    page = 1;
    el('scfBody').hidden = el('scfResults').hidden = el('scfControls').hidden = el('scfLegend').hidden = false;
    el('scfSkel').style.display = 'none';
    el('scfCanvas').style.visibility = '';
    el('scenarioGraphStatus').hidden = true;
    var ids = Object.keys(run.skus).sort();
    el('scfSkuList').replaceChildren.apply(el('scfSkuList'), ids.map(function (id) { return new Option(id, id); }));
    el('scfSkuFilter').replaceChildren.apply(el('scfSkuFilter'), [new Option('All SKUs', 'ALL')].concat(ids.map(function (id) { return new Option(id, id); })));
    el('scfHistory').style.display = start(run) < run.weeks.length ? '' : 'none';
    var note = el('scfNote');
    note.textContent = options && options.note || '';
    note.hidden = !note.textContent;
    pick(run.skus[sku] ? sku : 'ALL', zip);
  }

  window.scenarioForecast = { show: show, clear: clear, redraw: draw };

  document.addEventListener('DOMContentLoaded', function () {
    if (!el('scfBody')) return;
    el('scfHorizon').addEventListener('click', function (event) {
      var btn = event.target.closest('button');
      if (!btn || !run) return;
      horizon = Number(btn.dataset.h);
      page = 1;
      el('scfHorizon').querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      render();
    });
    el('scfHistory').addEventListener('click', function () {
      full = !full;
      this.textContent = full ? 'Recent weeks' : 'Full history';
      this.classList.toggle('on', !full);
      this.setAttribute('aria-pressed', String(full));
      draw();
    });
    var search = function () { if (run) pick(el('scfSku').value.trim().toUpperCase() || 'ALL', ''); };
    el('scfSku').addEventListener('change', search);
    el('scfSku').addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); search(); } });
    el('scfSkuFilter').addEventListener('change', function () { pick(this.value, zip); });
    el('scfZip').addEventListener('change', function () { pick(sku, this.value); });
    el('scfPrev').addEventListener('click', function () { page--; table(); });
    el('scfNext').addEventListener('click', function () { page++; table(); });
    el('scfTable').querySelectorAll('.amp-sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        if (!run) return;
        var key = th.dataset.sortKey;
        if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key: key, dir: key === 'sku' || key === 'wape' ? 'asc' : 'desc' };
        page = 1;
        table();
      });
    });
    el('scfLegend').querySelectorAll('.lgd-item').forEach(function (item) {
      item.addEventListener('click', function () {
        visible[item.dataset.k] = !visible[item.dataset.k];
        item.classList.toggle('off', !visible[item.dataset.k]);
        draw();
      });
    });
    el('scfCanvas').addEventListener('mousemove', function (event) { if (run) forecastHover(event, draw, el('scfCanvas'), el('scfTip')); });
    el('scfCanvas').addEventListener('mouseleave', function () { el('scfTip').style.opacity = 0; draw(); });
    new ResizeObserver(function () { draw(); }).observe(el('scfChart'));
    new MutationObserver(function () { draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
})();
