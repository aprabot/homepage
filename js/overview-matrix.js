/* Overview: the Plan & Scenario Comparison Matrix. The committed plan is the
   live forecast (window.DATA); scenarios are completed runs, valued by
   scenario-forecast.js exactly as the Scenarios page values them. Loaded after
   main.js and scenario-forecast.js, before scenarios.js (which sends the list). */
(function () {
  'use strict';
  var API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var COLUMNS = 2;
  var head = document.getElementById('ovMatrixHead'), body = document.getElementById('ovMatrixBody');
  if (!head || !body) return;
  var horizon = 52, loaded = null; // loaded: null until the plan has been tried
  var runs = null;                 // completed runs, newest first; null until the list arrives
  var picked = [];                 // run ids the person chose, by column
  var cache = {};                  // run id|plan id -> {state, result, base, pricing}
  var closed = {};                 // group -> true/false, once clicked
  var history = {};                // plan id -> last year's real sales, once read

  function plan() { return loaded && window.DATA && window.DATA.id ? window.DATA : null; }
  function start(d) { return d.backtestWeeks == null ? d.weeks.length : d.backtestWeeks; }
  function whole(n) { return Math.round(n).toLocaleString(); }
  function sum(list) { return list.length && list.every(Number.isFinite) ? list.reduce(function (a, b) { return a + b; }, 0) : null; }
  function ahead(d) { return Math.min(horizon, d.weeks.length - start(d)); }
  function lastYear(d) { var s = start(d); return sum((d.all.lastYear || []).slice(s, s + ahead(d))); }
  function zips(d) {
    var all = new Set();
    Object.values(d.skus).forEach(function (item) { Object.keys(item.byZip || {}).forEach(function (z) { all.add(z); }); });
    return all.size;
  }
  function day(text) {
    var d = typeof text === 'number' ? new Date(text) : new Date(text);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function madeOn(id) { var m = /^scn-(\d+)-/.exec(id || ''); return m ? day(Number(m[1]) * 1000) : ''; }

  // Last year's real sales for the plan's weeks, from the sales file. An older
  // backend answers with the scenario list instead: then it stays unknown.
  function readHistory(base) {
    if (history[base.id]) return history[base.id];
    var entry = history[base.id] = { state: 'loading' };
    APRA_SESSION.fetch(API + '?view=last_year')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var y = d.last_year, ok = y && y.status === 'ok' && y.last && y.before && JSON.stringify(y.weeks) === JSON.stringify(base.weeks.slice(start(base)));
        entry.state = ok ? 'ready' : 'none';
        if (ok) { entry.last = y.last; entry.before = y.before; }
      })
      .catch(function () { entry.state = 'none'; })
      .then(render);
    return entry;
  }

  function first(values, n) { return values ? sum(values.slice(0, n)) : null; }
  function change(now, before) { return now != null && before > 0 ? 100 * (now - before) / before : null; }

  // Postal codes growing faster or slower than the whole, of those that sold in
  // both periods. now/then: {postal code: number|null}.
  function spread(now, then, overall) {
    if (!now || !then || overall == null) return null;
    var out = { above: 0, below: 0, of: 0 };
    Object.keys(then).forEach(function (z) {
      var c = now[z] == null ? null : change(now[z], then[z]);
      if (c == null) return;
      out.of++;
      if (c > overall + 0.05) out.above++; else if (c < overall - 0.05) out.below++;
    });
    return out.of ? out : null;
  }

  function zipSums(year, key, n) {
    if (!year || !year.zips) return null;
    var out = {};
    Object.keys(year.zips).forEach(function (z) { out[z] = first(year.zips[z][key], n); });
    return out;
  }

  // Last year as a column: what sold in the same weeks, against the year before.
  function lastYearFigures(base) {
    var n = ahead(base), h = readHistory(base), units = lastYear(base);
    if (h.state !== 'ready') return { state: h.state, units: units, zipUnits: null, zipRevenue: null };
    var sold = function (year) { return Object.keys(year.skus).filter(function (k) { return year.skus[k].slice(0, n).some(function (v) { return v > 0; }); }).length; };
    var u = first(h.last.units, n), r = first(h.last.revenue, n), zu = zipSums(h.last, 'units', n), zr = zipSums(h.last, 'revenue', n);
    var yoy = change(u, first(h.before.units, n)), ryoy = change(r, first(h.before.revenue, n));
    return { state: 'ready', units: u, revenue: r, skus: sold(h.last), zips: zu ? Object.keys(zu).filter(function (z) { return zu[z] > 0; }).length : null,
      yoy: yoy, revenueYoy: ryoy, zipUnits: zu, zipRevenue: zr,
      spread: spread(zu, zipSums(h.before, 'units', n), yoy), revenueSpread: spread(zr, zipSums(h.before, 'revenue', n), ryoy) };
  }

  // A plan's or run's growth on last year, in total and by postal code.
  function growth(f, d, pricing, ly, n) {
    f.revenueYoy = ly.revenue > 0 ? change(f.revenue, ly.revenue) : null;
    if (!ly.zipUnits) return;
    var zips = scenarioForecast.byZip(d, pricing, n), units = {}, money = {};
    Object.keys(zips).forEach(function (z) { units[z] = zips[z].units; money[z] = zips[z].revenue; });
    f.spread = spread(units, ly.zipUnits, f.yoy);
    f.revenueSpread = f.revenueYoy == null ? null : spread(money, ly.zipRevenue, f.revenueYoy);
  }

  // Runs other than the plan itself.
  function others() { return (runs || []).filter(function (r) { return r.id !== plan().id; }); }

  // Default columns: the newest runs; a choice replaces its own column only.
  function columns() {
    var list = others(), used = [];
    for (var i = 0; i < COLUMNS; i++) {
      var id = picked[i] && list.some(function (r) { return r.id === picked[i]; }) ? picked[i] : null;
      if (!id) {
        var next = list.find(function (r) { return !used.includes(r.id) && !picked.includes(r.id); });
        id = next ? next.id : null;
      }
      if (id && !used.includes(id)) used.push(id);
    }
    return used;
  }

  function load(id) {
    var base = plan(), key = id + '|' + base.id;
    if (cache[key]) return cache[key];
    var entry = cache[key] = { state: 'loading' };
    var get = function (url) {
      return APRA_SESSION.fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    };
    Promise.allSettled([get(API + '?' + new URLSearchParams({ view: 'baseline', scenario: id })), get(API + '/' + encodeURIComponent(id) + '/result')])
      .then(function (both) {
        var result = both[1].status === 'fulfilled' ? both[1].value : null;
        if (!result || !Array.isArray(result.weeks) || !result.all || !result.skus) { entry.state = 'failed'; }
        else {
          entry.state = 'ready';
          entry.result = result;
          entry.pricing = (both[0].status === 'fulfilled' && both[0].value.pricing) || null;
        }
        render();
      });
    return entry;
  }

  // One column's numbers. Anything not known stays null, never estimated.
  function planFigures(base) {
    var s = start(base), n = ahead(base), units = sum(base.all.f.slice(s, s + n)), prior = lastYear(base);
    var revenue = scenarioForecast.compare(base, null, null, horizon);
    return { skus: Object.keys(base.skus).length, zips: zips(base), units: units,
      wape: function (w) { return skuLevelWape(base, w); },
      revenue: revenue && !revenue.revenue.missing ? revenue.revenue.value : null,
      yoy: units != null && prior > 0 ? 100 * (units - prior) / prior : null };
  }

  function runFigures(id, base) {
    var entry = load(id);
    if (entry.state !== 'ready') return { state: entry.state };
    var d = entry.result, t = scenarioForecast.compare(d, base, entry.pricing, horizon);
    if (!t) return { state: 'failed' };
    var s = start(d), prior = lastYear(d), priced = entry.pricing && entry.pricing.scenario;
    return { state: 'ready', other: t.otherProducts, weeks: t.weeks,
      skus: Object.keys(d.skus).length, zips: zips(d), units: t.scenario, planUnits: t.base,
      wape: function (w) { return s >= w || w === Infinity ? skuLevelWape(d, w === Infinity ? s : w) : null; },
      revenue: priced && !t.revenue.missing ? t.revenue.value : null,
      planRevenue: entry.pricing && entry.pricing.base && t.baseRevenue && !t.baseRevenue.missing ? t.baseRevenue.value : null,
      yoy: ahead(d) === t.weeks && prior > 0 ? 100 * (t.scenario - prior) / prior : null };
  }

  function pct(v, digits) { return (v > 0 ? '+' : '') + v.toFixed(digits == null ? 1 : digits) + '%'; }

  function rows(base, figures, ids) {
    var s = start(base), n = ahead(base), span = 'next ' + n + ' weeks';
    var p = planFigures(base), ly = lastYearFigures(base);
    // With prices known for the plan (committed schemes), use the same basis as the runs.
    var at = figures.findIndex(function (f) { return f.planRevenue != null && f.planUnits === p.units; });
    if (at >= 0) p.revenue = figures[at].planRevenue;
    growth(p, base, at >= 0 ? cache[ids[at] + '|' + base.id].pricing.base : null, ly, n);
    figures.forEach(function (f, k) {
      var entry = cache[ids[k] + '|' + base.id];
      // Only a run for the same products and weeks can be held against last year.
      if (f.state === 'ready' && !f.other && f.weeks === n) growth(f, entry.result, entry.pricing && entry.pricing.scenario, ly, n);
    });
    var count = function (key) { return function (f) { return f[key] == null ? null : whole(f[key]); }; };
    var rate = function (key) { return function (f) { return f[key] == null ? null : pct(f[key]); }; };
    var side = function (key, which) { return function (f) { return f[key] ? whole(f[key][which]) : null; }; };
    var noYear = ly.state === 'ready' ? 'Not in your sales file' : ly.state === 'loading' ? '…' : 'Last year’s sales couldn’t be read';
    var growthRows = function (yoy, zip, why) {
      return [{ name: 'YoY growth predicted', text: rate(yoy), why: why, lastWhy: noYear, lastNote: 'Last year against the year before' },
        { name: 'Channel A/B CAGR', why: 'Needs sales by channel' },
        { name: '# Zip codes above overall growth', text: side(zip, 'above'), why: why, lastWhy: noYear, lastNote: 'Of zip codes that sold in both years' },
        { name: '# Zip codes below overall growth', text: side(zip, 'below'), why: why, lastWhy: noYear, lastNote: 'Of zip codes that sold in both years' }];
    };
    var list = [
      { group: 'coverage', title: 'Coverage', rows: [
        { name: '# SKUs', text: count('skus'), lastWhy: noYear, lastNote: 'SKUs that sold in the same weeks last year' },
        { name: '# Zip codes', text: count('zips'), lastWhy: noYear, lastNote: 'Zip codes that bought in the same weeks last year' },
        { name: 'Forecast units, ' + span, text: count('units'), lastWhy: noYear, lastNote: 'Units sold in the same weeks last year',
          vs: function (f) { return f.other ? null : change(f.units, f.planUnits); } }] },
      { group: 'accuracy', title: 'Accuracy (WAPE)', sub: 'Lower is better', rows: [12, 24].filter(function (w) { return s >= w; }).map(function (w) { return { name: 'Last ' + w + ' weeks', w: w }; })
        .concat([{ name: s < 52 ? 'All ' + s + ' weeks of actuals' : 'Full year', w: s < 52 ? Infinity : 52 }]).map(function (r) {
          r.text = function (f) {
            if (!f.wape) return null;
            var v = f.wape(r.w === Infinity && f === p ? s : r.w);
            return v == null ? null : v.toFixed(1) + '%';
          };
          r.lastWhy = 'No forecast to check';
          return r;
        }) },
      { group: 'money', title: 'Money', rows: [
        { name: 'Revenue predicted (after discount), ' + span, text: count('revenue'), lastWhy: noYear, lastNote: 'Units sold × that day’s selling price, same weeks last year',
          vs: function (f) { return f.other ? null : change(f.revenue, f.planRevenue); }, why: 'No selling prices in your sales data' },
        { name: 'Marketing spend committed', why: 'Not connected yet' }] },
      { group: 'growth-units', title: 'Growth: Units', rows: growthRows('yoy', 'spread', 'No last-year data') },
      { group: 'growth-rev', title: 'Growth: Revenue', rows: growthRows('revenueYoy', 'revenueSpread', 'Needs last year’s revenue') },
    ];
    return { plan: p, last: ly, groups: list };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function header(ids) {
    var row = el('tr');
    row.append(el('th', '', 'Metric'), el('th', '', 'Last year'));
    var th = el('th', 'ov-plan-col');
    th.append(el('span', 'ov-plan-dot'), 'Committed plan');
    var made = plan() && madeOn(plan().id);
    if (made) th.append(el('small', 'ov-col-date', made));
    row.append(th);
    ids.forEach(function (id, i) {
      var cell = el('th', 'ov-run-col'), select = el('select');
      select.setAttribute('aria-label', 'Scenario ' + (i + 1));
      others().forEach(function (r) {
        if (r.id === id || !ids.includes(r.id)) select.append(new Option((r.label || 'Untitled') + (runs.filter(function (x) { return x.label === r.label; }).length > 1 ? ' · ' + day(r.created_at) : ''), r.id));
      });
      select.value = id;
      select.addEventListener('change', function () {
        picked = ids.slice();
        picked[i] = select.value;
        render();
        var again = head.querySelectorAll('select')[i];
        if (again) again.focus();
      });
      var run = runs.find(function (r) { return r.id === id; });
      cell.append(select, el('small', 'ov-col-date', day(run.created_at)));
      row.append(cell);
    });
    if (!ids.length) {
      var none = el('th', 'ov-run-col');
      if (runs === null) none.textContent = 'Scenarios';
      else {
        var link = el('button', 'ov-run-link', 'Run a scenario →');
        link.type = 'button';
        link.addEventListener('click', function () { goToPanel('Scenarios'); });
        none.append(el('span', '', 'No scenarios yet'), link);
      }
      row.append(none);
    }
    head.replaceChildren(row);
  }

  function render() {
    var table = document.getElementById('ovMatrixTable'), base = plan(), note = document.getElementById('ovMatrixNote');
    if (loaded === null) return;
    table.classList.remove('ov-loading');
    table.removeAttribute('aria-busy');
    var ids = base && runs ? columns() : [];
    header(ids);
    if (!base) {
      var only = el('td', 'ov-none', 'Your forecast couldn’t be loaded, so there is no plan to compare.');
      only.colSpan = 4;
      var tr = el('tr', 'ov-group-row');
      tr.append(only);
      body.replaceChildren(tr);
      note.textContent = 'No forecast loaded';
      return;
    }
    var figures = ids.map(function (id) { return runFigures(id, base); });
    var shown = {};
    ids.forEach(function (id) { shown[id] = { run: runs.find(function (r) { return r.id === id; }), entry: load(id) }; });
    document.dispatchEvent(new CustomEvent('apra:matrix-runs', { detail: shown })); // Opportunities
    var all = rows(base, figures, ids), span = 3 + Math.max(1, ids.length);
    var out = [];
    all.groups.forEach(function (g) {
      var empty = !g.rows.some(function (r) { return r.text && r.text(all.plan) != null; });
      var hide = closed[g.group] == null ? empty : closed[g.group];
      var h = el('tr', 'ov-group-header' + (hide ? ' collapsed' : '')), td = el('td');
      h.dataset.group = g.group;
      td.colSpan = span;
      td.append(g.title);
      if (g.sub || empty) td.append(el('span', 'ov-group-sub', empty ? 'Not available yet' : g.sub));
      td.insertAdjacentHTML('beforeend', '<svg class="ov-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M19 9l-7 7-7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      h.append(td);
      h.addEventListener('click', function () { ovToggleGroup(g.group, h); closed[g.group] = h.classList.contains('collapsed'); });
      out.push(h);
      g.rows.forEach(function (r) {
        var line = el('tr', 'ov-group-row' + (hide ? ' ov-row-hidden' : ''));
        line.dataset.groupItem = g.group;
        var planText = r.text ? r.text(all.plan) : null;
        line.classList.toggle('ov-row-empty', planText == null);
        var then = r.text ? r.text(all.last) : null, lastCell = el('td', then == null ? 'ov-none' : '', then == null ? '—' : then);
        if (then == null && r.lastWhy) { lastCell.textContent = r.lastWhy === '…' ? '…' : '—'; lastCell.title = r.lastWhy; }
        if (then != null && r.lastNote) lastCell.title = r.lastNote;
        line.append(el('td', '', r.name), lastCell);
        line.append(el('td', 'ov-plan-col' + (planText == null ? ' ov-none' : ''), planText == null ? r.why || '—' : planText));
        figures.forEach(function (f) {
          var text = f.state === 'ready' && r.text ? r.text(f) : null, cell = el('td', text == null ? 'ov-none' : '', f.state === 'loading' && r.text ? '…' : text == null ? '—' : text);
          if (f.state === 'failed') cell.title = 'Could not load this scenario';
          var v = text != null && r.vs ? r.vs(f) : null;
          if (v != null) {
            var tag = el('span', 'ov-var', pct(v));
            tag.dataset.direction = v >= 0.05 ? 'up' : v <= -0.05 ? 'down' : 'flat';
            tag.title = 'Compared with the committed plan' + (f.weeks < ahead(base) ? ', ' + f.weeks + ' weeks in common' : '');
            cell.append(' ', tag);
          }
          line.append(cell);
        });
        if (!figures.length) line.append(el('td', 'ov-none', '—'));
        out.push(line);
      });
    });
    body.replaceChildren.apply(body, out);
    var other = figures.some(function (f) { return f.other; }), broken = figures.some(function (f) { return f.state === 'failed'; });
    note.textContent = 'Next ' + ahead(base) + ' weeks, compared with the committed plan' +
      (other ? ' · a scenario uses different products, so it isn’t compared' : '') + (broken ? ' · a scenario couldn’t be loaded' : '');
    var btn = document.getElementById('ovToggleAllGroupsBtn');
    if (btn) btn.textContent = body.querySelector('.ov-group-header:not(.collapsed)') ? 'Collapse all groups' : 'Expand all groups';
    var intro = document.getElementById('ovIntro'), from = start(base), end = new Date(base.weeks[base.weeks.length - 1] + 'T00:00:00');
    end.setDate(end.getDate() + 6);
    if (intro) intro.textContent = 'Committed plan' + (madeOn(base.id) ? ' from ' + madeOn(base.id) : '') + ': checked against ' + from + ' weeks of actual sales, with a ' +
      (base.weeks.length - from) + '-week forecast to ' + day(end.getTime()) + '.';
  }

  document.addEventListener('apra:overview', function (event) { horizon = event.detail.horizon; loaded = event.detail.loaded; render(); });
  document.addEventListener('apra:scenarios-list', function (event) {
    runs = (event.detail || []).filter(function (r) { return r.status === 'completed' && !r.approved; })
      .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    Object.keys(cache).forEach(function (key) { if (cache[key].state === 'failed') delete cache[key]; }); // try again
    render();
  });
  // After the button's own handler: remember what it did.
  document.getElementById('ovToggleAllGroupsBtn').addEventListener('click', function () {
    body.querySelectorAll('.ov-group-header').forEach(function (h) { closed[h.dataset.group] = h.classList.contains('collapsed'); });
  });
})();
