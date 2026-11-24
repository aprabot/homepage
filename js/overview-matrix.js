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

  function rows(base, figures) {
    var s = start(base), n = ahead(base), span = 'next ' + n + ' weeks';
    var p = planFigures(base);
    // With prices known for the plan (committed schemes), use the same basis as the runs.
    var priced = figures.find(function (f) { return f.planRevenue != null && f.planUnits === p.units; });
    var planRevenue = priced ? priced.planRevenue : p.revenue;
    var change = function (now, before) { return now != null && before > 0 ? 100 * (now - before) / before : null; };
    var count = function (key) { return { text: function (f) { return f[key] == null ? null : whole(f[key]); } }; };
    var list = [
      { group: 'coverage', title: 'Coverage', rows: [
        Object.assign({ name: '# SKUs' }, count('skus')), Object.assign({ name: '# Zip codes' }, count('zips')),
        { name: 'Forecast units, ' + span, last: lastYear(base), text: function (f) { return f.units == null ? null : whole(f.units); },
          vs: function (f) { return f.other ? null : change(f.units, f.planUnits); } }] },
      { group: 'accuracy', title: 'Accuracy (WAPE)', sub: 'Lower is better', rows: [12, 24].filter(function (w) { return s >= w; }).map(function (w) { return { name: 'Last ' + w + ' weeks', w: w }; })
        .concat([{ name: s < 52 ? 'All ' + s + ' weeks of actuals' : 'Full year', w: s < 52 ? Infinity : 52 }]).map(function (r) {
          r.text = function (f) { var v = f.wape(r.w === Infinity && f === p ? s : r.w); return v == null ? null : v.toFixed(1) + '%'; };
          return r;
        }) },
      { group: 'money', title: 'Money', rows: [
        { name: 'Revenue predicted (after discount), ' + span, text: function (f) { var v = f === p ? planRevenue : f.revenue; return v == null ? null : whole(v); },
          vs: function (f) { return f.other ? null : change(f.revenue, f.planRevenue); }, why: 'No selling prices in your sales data' },
        { name: 'Marketing spend committed', why: 'Not connected yet' }] },
      { group: 'growth-units', title: 'Growth: Units', rows: [
        { name: 'YoY growth predicted', text: function (f) { return f.yoy == null ? null : pct(f.yoy); }, why: 'No last-year data' },
        { name: 'Channel A/B CAGR', why: 'Needs sales by channel' },
        { name: '# Zip codes above overall growth', why: 'Needs last year by zip code' },
        { name: '# Zip codes below overall growth', why: 'Needs last year by zip code' }] },
      { group: 'growth-rev', title: 'Growth: Revenue', rows: ['YoY growth predicted', 'Channel A/B CAGR', '# Zip codes above overall growth', '# Zip codes below overall growth']
        .map(function (name) { return { name: name, why: 'Needs last year’s revenue' }; }) },
    ];
    return { plan: p, groups: list };
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
    var all = rows(base, figures), span = 3 + Math.max(1, ids.length);
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
        line.append(el('td', '', r.name), el('td', r.last == null ? 'ov-none' : '', r.last == null ? '—' : whole(r.last)));
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
