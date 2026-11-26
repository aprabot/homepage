/* Inventory: stock needed at the points in time the person picks.

   For a forecast run (the committed plan or a scenario) and each SKU:
     projected(t) = stock on hand + arrivals up to t - P50 demand up to t
     required(t)  = demand at the chosen service level over [t, t + cover)
     shortfall(t) = max(0, required - projected); order by = t - lead time
   Status: green when projected covers required, amber when it covers P50
   demand over the cover window, red otherwise.

   Only what the data supports: the forecast is weekly, so a day is a
   seventh of its week; P75 and P90 come from each SKU's own backtest errors;
   stock with no arrival date is shown arriving one lead time after the
   stock date, or left out. Anything assumed is said on the page.
   Loaded after main.js and scenario-forecast.js. */
(function () {
  'use strict';
  var API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var INVENTORY = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/forecast?type=inventory';
  var DAY = 864e5, REVIEW_DAYS = 7, MIN_WEEKS = 8;
  var box = document.getElementById('invPlan');
  if (!box) return;
  var el = function (id) { return document.getElementById(id); };

  var state = { run: 'plan', points: null, preset: 'mondays3', level: 'P75', lead: null, review: REVIEW_DAYS, undated: true, filter: 'all', sel: null, point: null, view: 'sku' };
  var inputs = null;   // {stock, inbound, params} once read
  var runs = [];       // completed scenarios
  var results = {};    // scenario id -> {state, result}
  var reading = false;
  var forecastState = null; // from Overview's event: true loaded, false failed, null not yet

  // ---------- dates ----------
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parse(text) { var p = String(text).slice(0, 10).split('-'); return new Date(+p[0], p[1] - 1, +p[2]); }
  function add(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function days(a, b) { return Math.round((parse(iso(b)) - parse(iso(a))) / DAY); }
  function today() { return parse(iso(new Date())); }
  function label(d) { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  function whole(n) { return Math.round(n).toLocaleString(); }

  function presetPoints(kind) {
    var t = today(), out = [];
    if (kind === 'mondays3' || kind === 'mondays8') {
      var m = add(t, ((8 - t.getDay()) % 7) || 7);
      for (var i = 0; i < (kind === 'mondays3' ? 3 : 8); i++) out.push(add(m, 7 * i));
    } else if (kind === 'months3') {
      for (var k = 0; k < 3; k++) out.push(new Date(t.getFullYear(), t.getMonth() + k + 1, 0));
      if (out[0] <= t) out.shift(), out.push(new Date(t.getFullYear(), t.getMonth() + 4, 0));
    }
    return out.map(iso);
  }

  // ---------- data ----------
  function plan() { return window.DATA && window.DATA.id ? window.DATA : null; }

  function chosen() {
    var base = plan();
    if (state.run === 'plan' || !base) return base ? { d: base, pair: null, name: 'Committed plan' } : null;
    var r = results[state.run];
    if (!r || r.state !== 'ready') return null;
    return { d: r.result, pair: scenarioForecast.pair(r.result, base), name: (runs.find(function (x) { return x.id === state.run; }) || {}).label || 'Scenario' };
  }

  function loadRun(id) {
    if (results[id]) return;
    results[id] = { state: 'loading' };
    APRA_SESSION.fetch(API + '/' + encodeURIComponent(id) + '/result')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { results[id] = Array.isArray(d.weeks) && d.skus ? { state: 'ready', result: d } : { state: 'failed' }; })
      .catch(function () { results[id] = { state: 'failed' }; })
      .then(render);
  }

  function read() {
    if (reading) return;
    reading = true;
    var get = function (url) { return APRA_SESSION.fetch(url).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }); };
    Promise.allSettled([get(API + '?view=inbound'), get(INVENTORY)]).then(function (all) {
      reading = false;
      var a = all[0].status === 'fulfilled' ? all[0].value : {}, b = all[1].status === 'fulfilled' ? all[1].value : {};
      inputs = { stock: a.stock || null, inbound: a.inbound || null, params: (b && b.params) || {} };
      render();
    });
  }
  window.invPlanRefresh = function () { inputs = null; read(); };

  // ---------- engine ----------
  // Spread over days: a week's forecast is shared evenly across its 7 days.
  function daily(d, values) {
    var start = parse(d.weeks[0]);
    return function (day) {
      var w = Math.floor(days(start, day) / 7);
      return w >= 0 && w < d.weeks.length && Number.isFinite(values[w]) ? values[w] / 7 : null;
    };
  }

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    var at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  }

  // P75 and P90 as a multiple of the forecast, from how actual sales ran
  // against it in the backtest: the SKU's own weeks, or all SKUs' when it
  // has too few.
  function uplifts(d) {
    var edge = d.backtestWeeks == null ? d.weeks.length : d.backtestWeeks, pooled = [], own = {};
    Object.keys(d.skus).forEach(function (sku) {
      var item = d.skus[sku], list = [];
      for (var i = 0; i < edge; i++) if (Number.isFinite(item.a[i]) && item.f[i] > 0) list.push(item.a[i] / item.f[i]);
      own[sku] = list.sort(function (x, y) { return x - y; });
      pooled = pooled.concat(list);
    });
    pooled.sort(function (x, y) { return x - y; });
    var factor = function (list) {
      var mid = quantile(list, 0.5);
      return mid > 0 ? { P50: 1, P75: Math.max(1, quantile(list, 0.75) / mid), P90: Math.max(1, quantile(list, 0.9) / mid), n: list.length } : null;
    };
    var all = factor(pooled), out = {};
    Object.keys(own).forEach(function (sku) {
      var mine = own[sku].length >= MIN_WEEKS ? factor(own[sku]) : null; // null too when its usual week sold nothing
      out[sku] = mine ? Object.assign(mine, { own: true }) : all ? Object.assign({}, all, { own: false }) : { P50: 1, P75: 1, P90: 1, own: false };
    });
    return out;
  }

  function stockFor(sku, pair) {
    var s = inputs && inputs.stock;
    if (!s || s.status !== 'ok') return null;
    var key = pair ? pair[sku] : sku;
    return key ? s.by_sku[key] || null : null;
  }

  function stockDate() {
    var s = inputs && inputs.stock;
    if (!s || s.status !== 'ok') return null;
    return s.as_of ? parse(s.as_of) : parse(iso(new Date(s.uploaded_at)));
  }

  function leadDays() {
    if (state.lead) return state.lead;
    var v = Number(inputs && inputs.params && inputs.params.leadTimeDays);
    return v > 0 ? Math.round(v) : 14;
  }

  function evaluate(run) {
    var d = run.d, lead = leadDays(), cover = lead + state.review, up = uplifts(d), from = stockDate(), out = [];
    var points = (state.points || presetPoints(state.preset)).map(parse).filter(function (t) { return t >= today(); }).sort(function (a, b) { return a - b; });
    Object.keys(d.skus).sort().forEach(function (sku) {
      var item = d.skus[sku], demand = daily(d, item.f), u = up[sku] || { P50: 1, P75: 1, P90: 1 }, held = stockFor(sku, run.pair);
      var undated = held ? (held.intransit || 0) + (held.openpo || 0) : 0, arrive = from ? add(from, lead) : null;
      var sum = function (a, n, f) { var t = 0; for (var i = 0; i < n; i++) { var v = demand(add(a, i)); if (v == null) return null; t += v * f; } return t; };
      // Stock on each day from the stock date: arrivals in, P50 demand out, never below zero.
      var line = null;
      if (held && held.present != null && from) {
        line = {};
        var level = held.present, last = points.length ? add(points[points.length - 1], cover) : from;
        for (var day = from; day <= last; day = add(day, 1)) {
          if (state.undated && undated && iso(day) === iso(arrive)) level += undated;
          line[iso(day)] = level;
          var used = demand(day);
          if (used == null) break;
          level = Math.max(0, level - used);
        }
      }
      points.forEach(function (t) {
        var need = sum(t, cover, u[state.level]), base = sum(t, cover, 1), proj = line && line[iso(t)] != null ? line[iso(t)] : null;
        var r = { sku: sku, point: iso(t), required: need, base: base, projected: proj, cover: cover, lead: lead, uplift: u, held: held, undated: undated, arrive: arrive };
        if (need == null) r.status = 'nodata';
        else if (proj == null) r.status = 'nostock';
        else {
          r.short = Math.max(0, need - proj);
          r.days = base > 0 ? proj / (base / cover) : null;
          r.status = proj >= need ? 'green' : proj >= base ? 'amber' : 'red';
          r.orderBy = add(t, -lead);
          r.late = r.short > 0 && r.orderBy < today();
        }
        out.push(r);
      });
    });
    return { rows: out, points: points, cover: cover, lead: lead, from: from, up: up };
  }

  // ---------- drawing ----------
  var STATUS = { green: 'Covered', amber: 'Short', red: 'Stockout risk', nostock: 'No stock data', nodata: 'Past the forecast' };
  function node(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function num(v) { return v == null ? '—' : whole(v); }

  // Per SKU: its rows by date, the most it falls short and when to order.
  function bySku(res) {
    var out = {};
    res.rows.forEach(function (r) {
      var g = out[r.sku] || (out[r.sku] = { sku: r.sku, rows: {}, worst: 0, by: null, late: false, held: r.held, status: 'green' });
      g.rows[r.point] = r;
      if (r.short > 0) {
        g.worst = Math.max(g.worst, r.short);
        var due = r.late ? today() : r.orderBy;
        if (!g.by || due < g.by) g.by = due;
        g.late = g.late || r.late;
        if (r.late) g.lateDays = Math.max(g.lateDays || 0, days(r.orderBy, today()));
      }
      var rank = { red: 3, amber: 2, nostock: 1, nodata: 1, green: 0 };
      if (rank[r.status] > rank[g.status]) g.status = r.status;
    });
    return Object.keys(out).sort().map(function (k) { return out[k]; });
  }

  function summary(res, run) {
    var groups = bySku(res), short = groups.filter(function (g) { return g.worst > 0; }), late = groups.filter(function (g) { return g.late; });
    var known = res.rows.some(function (r) { return r.projected != null; });
    var due = short.filter(function (g) { return !g.late; }).reduce(function (a, g) { return !a || g.by < a ? g.by : a; }, null);
    var tile = function (id, value, note, tone) {
      var t = el(id);
      t.querySelector('b').textContent = value;
      t.querySelector('small').textContent = note;
      t.dataset.tone = tone || '';
    };
    var units = short.reduce(function (a, g) { return a + Math.round(g.worst); }, 0);
    tile('invKpiShort', known ? String(short.length) : '—', known ? 'of ' + groups.length + ' SKUs fall short' : 'Needs a stock file', short.length ? 'risk' : known ? 'good' : '');
    tile('invKpiUnits', known ? whole(units) : '—', known ? 'units to order, largest shortfall per SKU' : 'Needs a stock file', '');
    tile('invKpiLate', known ? String(late.length) : '—', known ? (late.length ? 'SKUs to order today, already late' : 'Nothing is late') : 'Needs a stock file', late.length ? 'risk' : '');
    tile('invKpiNext', !known ? '—' : due ? label(due) : late.length ? 'Today' : 'None', !known ? 'Needs a stock file' : due ? 'next order-by date' : late.length ? 'every order due is late' : 'no order needed', '');
    el('invPlanSum').textContent = !res.points.length ? 'Pick a date from today on.' : !known
      ? 'Required stock only: there is no stock file, so shortfalls can’t be worked out. Upload one above.'
      : run.name + ' at ' + state.level + ', checked on ' + res.points.length + ' date' + (res.points.length === 1 ? '' : 's') + ': ' + res.points.map(label).join(', ') + '.';
  }

  function orderCell(g) {
    var td = node('td');
    if (!(g.worst > 0)) { td.append(node('span', 'inv-dim', g.held ? 'Not needed' : '—')); return td; }
    if (g.late) { td.append(node('b', 'inv-late', 'Order now')); td.append(node('small', '', g.lateDays + ' day' + (g.lateDays === 1 ? '' : 's') + ' late')); }
    else td.append(node('span', '', label(g.by)));
    return td;
  }

  function cell(r) {
    var td = node('td', 'inv-cell');
    if (!r) { td.textContent = '—'; return td; }
    td.dataset.s = r.status;
    td.dataset.point = r.point;
    td.title = label(parse(r.point)) + ': ' + STATUS[r.status] + (r.required != null ? ', required ' + whole(r.required) : '') + (r.projected != null ? ', projected ' + whole(r.projected) : '');
    if (r.short > 0) { td.append(node('b', '', '−' + whole(r.short))); td.append(node('small', '', r.days == null ? '' : r.days.toFixed(1) + ' days')); }
    else if (r.status === 'green') { td.append(node('span', '', '✓')); td.append(node('small', '', r.days == null ? '' : Math.round(r.days) + ' days')); }
    else td.append(node('span', 'inv-dim', r.status === 'nodata' ? 'Past forecast' : '—'));
    return td;
  }

  function table(res) {
    var groups = bySku(res);
    var counts = { all: groups.length, short: 0, red: 0, ok: 0 };
    groups.forEach(function (g) { if (g.worst > 0) counts.short++; if (g.status === 'red') counts.red++; if (g.status === 'green') counts.ok++; });
    var chips = el('invPlanFilters');
    chips.replaceChildren.apply(chips, [['all', 'All'], ['short', 'Short'], ['red', 'Stockout risk'], ['ok', 'Covered']].map(function (f) {
      var b = node('button', 'inv-chip', f[1] + ' ' + counts[f[0]]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.filter === f[0]));
      b.addEventListener('click', function () { state.filter = f[0]; render(); });
      return b;
    }));
    var keep = function (g) { return state.filter === 'all' || (state.filter === 'short' && g.worst > 0) || (state.filter === 'red' && g.status === 'red') || (state.filter === 'ok' && g.status === 'green'); };
    groups = groups.filter(keep);
    el('invPlanView').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === state.view)); });
    var head = el('invPlanHead'), body = el('invPlanRows');
    var th = function (text, cls) { var c = node('th', cls || '', text); c.scope = 'col'; return c; };
    if (state.view === 'sku') {
      var hr = node('tr');
      hr.append(th('SKU'), th('On hand', 'n'));
      res.points.forEach(function (t) { hr.append(th(label(t), 'n')); });
      hr.append(th('To order', 'n'), th('Order by'));
      head.replaceChildren(hr);
      body.replaceChildren.apply(body, groups.map(function (g) {
        var tr = node('tr', 'inv-plan-row');
        tr.tabIndex = 0;
        tr.dataset.sku = g.sku;
        tr.setAttribute('aria-selected', String(state.sel === g.sku));
        var name = node('td', 'inv-sku');
        var dot = node('span', 'inv-status', '');
        dot.dataset.s = g.status;
        dot.title = STATUS[g.status];
        var inner = node('span', 'inv-sku-in');
        inner.append(dot, g.sku);
        name.append(inner);
        tr.append(name, node('td', 'n', g.held && g.held.present != null ? whole(g.held.present) : '—'));
        res.points.forEach(function (t) { tr.append(cell(g.rows[iso(t)])); });
        tr.append(node('td', 'n inv-order', g.worst > 0 ? whole(g.worst) : '—'), orderCell(g));
        return tr;
      }));
    } else {
      var h2 = node('tr');
      ['Date', 'SKU', 'Required', 'Projected', 'Shortfall', 'Cover days', 'Order by', 'Status'].forEach(function (t, i) { h2.append(th(t, i > 1 && i < 6 ? 'n' : '')); });
      head.replaceChildren(h2);
      var rows = res.rows.filter(function (r) { return groups.some(function (g) { return g.sku === r.sku; }); });
      body.replaceChildren.apply(body, rows.map(function (r) {
        var tr = node('tr', 'inv-plan-row');
        tr.tabIndex = 0;
        tr.dataset.sku = r.sku;
        tr.dataset.point = r.point;
        tr.setAttribute('aria-selected', String(state.sel === r.sku && state.point === r.point));
        [label(parse(r.point)), r.sku, num(r.required), num(r.projected), r.short == null ? '—' : whole(r.short), r.days == null ? '—' : r.days.toFixed(1)].forEach(function (v, i) {
          tr.append(node('td', i === 1 ? 'inv-sku' : i > 1 ? 'n' : '', v));
        });
        var by = node('td');
        by.append(r.short > 0 ? (r.late ? node('b', 'inv-late', 'Order now') : node('span', '', label(r.orderBy))) : node('span', 'inv-dim', r.short === 0 ? 'Not needed' : '—'));
        var st = node('td'), pill = node('span', 'inv-status', STATUS[r.status]);
        pill.dataset.s = r.status;
        st.append(pill);
        tr.append(by, st);
        return tr;
      }));
    }
    if (!body.children.length) {
      var tr = node('tr'), td = node('td', 'inv-dim', 'Nothing matches this filter.');
      td.colSpan = 20; tr.append(td); body.append(tr);
    }
  }

  function panel(res, run) {
    var p = el('invPlanPanel'), skus = Object.keys(run.d.skus).sort();
    if (!skus.includes(state.sel)) {
      var first = bySku(res).sort(function (a, b) { return b.worst - a.worst; })[0];
      state.sel = first ? first.sku : skus[0];
    }
    var rows = res.rows.filter(function (x) { return x.sku === state.sel; });
    if (!rows.some(function (x) { return x.point === state.point; })) {
      var worst = rows.slice().sort(function (a, b) { return (b.short || 0) - (a.short || 0); })[0];
      state.point = worst ? worst.point : null;
    }
    var r = rows.find(function (x) { return x.point === state.point; });
    p.replaceChildren();
    if (!r) return;
    var t = parse(r.point), head = node('div', 'inv-panel-head'), title = node('div');
    title.append(node('h3', '', r.sku), node('span', 'inv-dim', run.name + ' · ' + state.level));
    var pill = node('span', 'inv-status', STATUS[r.status]);
    pill.dataset.s = r.status;
    head.append(title, pill);
    var tabs = node('div', 'inv-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Date');
    rows.forEach(function (x) {
      var b = node('button', '', label(parse(x.point)));
      b.type = 'button';
      b.dataset.s = x.status;
      b.setAttribute('aria-pressed', String(x.point === state.point));
      b.addEventListener('click', function () { state.point = x.point; render(); });
      tabs.append(b);
    });
    var steps = node('ol', 'inv-steps');
    var step = function (title, note, value, strong) {
      var li = node('li', strong ? 'res' : ''), text = node('span', '', title);
      text.append(node('small', '', note));
      li.append(text, node('b', '', value));
      steps.append(li);
    };
    var u = r.uplift[state.level];
    step('Demand to cover', r.cover + ' days from ' + label(t) + ' (' + r.lead + ' lead time + ' + state.review + ' review)' +
      (state.level === 'P50' ? '' : ', ×' + u.toFixed(2) + ' for ' + state.level + ' from ' + (r.uplift.own ? 'this SKU’s' : 'all SKUs’') + ' backtest errors'), num(r.required));
    if (r.held) {
      step('Projected stock on ' + label(t), whole(r.held.present) + ' on hand' + (state.undated && r.undated ? ' + ' + whole(r.undated) + ' in transit and on order, arriving ' + label(r.arrive) : '') +
        ' − P50 demand from ' + label(res.from), num(r.projected));
      step('Shortfall', 'Required − projected', r.short == null ? '—' : whole(r.short), true);
      step('Order by', r.lead + '-day lead time before ' + label(t), r.short > 0 ? (r.late ? 'Today' : label(r.orderBy)) : 'Not needed', true);
    } else step('Projected stock', 'Needs a stock file with this SKU', '—');
    p.append(head, chart(res, run, r.sku), tabs, steps);
  }

  // Projected stock against required stock for one SKU, dates marked.
  function chart(res, run, sku) {
    var rows = res.rows.filter(function (x) { return x.sku === sku; });
    var wrap = node('div', 'inv-chart');
    if (!rows.length || rows[0].projected == null || !res.from) { wrap.append(node('p', 'inv-dim', 'A chart appears once stock is known.')); return wrap; }
    var d = run.d, demand = daily(d, d.skus[sku].f), first = res.from, end = add(parse(rows[rows.length - 1].point), 14), u = rows[0].uplift[state.level];
    var n = days(first, end), proj = [], need = [], level = rows[0].held.present, arrive = rows[0].arrive;
    for (var i = 0; i <= n; i++) {
      var day = add(first, i);
      if (state.undated && rows[0].undated && iso(day) === iso(arrive)) level += rows[0].undated;
      proj.push(level);
      var r = 0, ok = true;
      for (var k = 0; k < res.cover; k++) { var v = demand(add(day, k)); if (v == null) { ok = false; break; } r += v * u; }
      need.push(ok ? r : null);
      var used = demand(day);
      level = used == null ? level : Math.max(0, level - used);
    }
    var W = 420, H = 170, max = Math.max.apply(null, proj.concat(need.filter(Number.isFinite))) * 1.1 || 1;
    var X = function (i) { return 6 + i / n * (W - 12); }, Y = function (v) { return H - 20 - v / max * (H - 36); };
    var path = function (list) { return list.map(function (v, i) { return v == null ? '' : (i && list[i - 1] != null ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(''); };
    var gap = '';
    for (var j = 0; j < n; j++) if (need[j] != null && need[j + 1] != null && proj[j] < need[j]) gap += 'M' + X(j) + ' ' + Y(proj[j]) + 'L' + X(j + 1) + ' ' + Y(proj[j + 1]) + 'L' + X(j + 1) + ' ' + Y(Math.max(need[j + 1], proj[j + 1])) + 'L' + X(j) + ' ' + Y(need[j]) + 'Z';
    var marks = res.points.map(function (t) { var i = days(first, t); return i >= 0 && i <= n ? '<line class="pt" x1="' + X(i) + '" x2="' + X(i) + '" y1="10" y2="' + (H - 20) + '"/><text x="' + X(i) + '" y="8" text-anchor="middle">' + label(t) + '</text>' : ''; }).join('');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + sku + ': projected stock against required stock">' +
      '<path class="gap" d="' + gap + '"/>' + marks + '<path class="need" d="' + path(need) + '"/><path class="proj" d="' + path(proj) + '"/>' +
      '<text x="6" y="' + (H - 5) + '">' + label(first) + '</text><text x="' + (W - 6) + '" y="' + (H - 5) + '" text-anchor="end">' + label(end) + '</text></svg>';
    wrap.innerHTML = svg;
    var key = node('div', 'inv-chart-key');
    key.append(node('span', 'k-proj', 'Projected'), node('span', 'k-need', 'Required (' + state.level + ')'), node('span', 'k-gap', 'Shortfall'));
    wrap.append(key);
    return wrap;
  }

  function notes(res, run) {
    var list = [], s = inputs && inputs.stock, rec = inputs && inputs.inbound;
    list.push('Forecast: ' + run.name + ', weekly, shared evenly across each week’s days.');
    if (state.level !== 'P50') list.push(state.level + ': forecast × how sales ran against it in the backtest, per SKU where it has ' + MIN_WEEKS + '+ weeks, otherwise all SKUs.');
    if (!s || s.status !== 'ok') list.push('No stock file, so only required stock is shown.');
    else {
      list.push('Stock: ' + (s.filename || 'stock file') + ', ' + (s.as_of ? 'as of ' + label(parse(s.as_of)) : 'no date in the file, so taken as the upload day, ' + label(res.from)) + '.');
      if (days(res.from, today()) > 7) list.push('The stock file is ' + days(res.from, today()) + ' days old, so these figures may be stale.');
      list.push(state.undated ? 'In transit and open orders have no dates, so they are shown arriving one lead time after the stock date.' : 'In transit and open orders are left out.');
    }
    if (!state.lead) list.push('Lead time: ' + res.lead + ' days, an assumption. Your receipts have no order dates and the SKU master has no lead time.');
    if (rec && rec.status === 'ok' && !rec.rows_future) list.push('Inbound receipts have no future dates, so no expected receipts are added.');
    list.push('Level: country. Site and region need a file mapping pincodes to sites.');
    var ul = el('invPlanNotes');
    ul.replaceChildren.apply(ul, list.map(function (t) { return node('li', '', t); }));
  }

  function controls(res) {
    el('invPlanMoreSum').textContent = 'Lead time ' + leadDays() + ' days · review ' + state.review + ' · country' + (state.undated ? '' : ' · open orders left out');
    var sel = el('invPlanRun'), base = plan();
    var opts = [['plan', 'Committed plan']].concat(runs.filter(function (r) { return !base || r.id !== base.id; }).map(function (r) { return [r.id, 'Scenario: ' + (r.label || 'Untitled')]; }));
    if (sel.options.length !== opts.length) sel.replaceChildren.apply(sel, opts.map(function (o) { return new Option(o[1], o[0]); }));
    sel.value = state.run;
    el('invPlanPreset').value = state.points ? 'custom' : state.preset;
    var chips = el('invPlanPoints');
    chips.replaceChildren.apply(chips, (res ? res.points : []).map(function (t) {
      var b = node('button', 'inv-point', label(t) + ' ×');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove ' + label(t));
      b.addEventListener('click', function () { state.points = (state.points || presetPoints(state.preset)).filter(function (x) { return x !== iso(t); }); render(); });
      return b;
    }));
    el('invPlanLevel').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === state.level)); });
    if (document.activeElement !== el('invPlanLead')) el('invPlanLead').value = leadDays();
    if (document.activeElement !== el('invPlanReview')) el('invPlanReview').value = state.review;
    el('invPlanUndated').checked = state.undated;
    el('invPlanAdd').min = iso(today());
  }

  function render() {
    if (box.closest('.dbody') && box.closest('.dbody').style.display === 'none' && !inputs) return;
    var run = chosen();
    if (!inputs) { read(); }
    var status = el('invPlanState');
    if (!plan()) { status.textContent = forecastState === false ? 'Your forecast couldn’t be loaded.' : 'Loading the forecast…'; box.dataset.ready = ''; return; }
    if (state.run !== 'plan') loadRun(state.run);
    if (!inputs || !run) {
      status.textContent = state.run !== 'plan' && results[state.run] && results[state.run].state === 'failed' ? 'This scenario couldn’t be loaded.' : 'Reading stock and receipts…';
      controls(null);
      return;
    }
    status.textContent = '';
    box.dataset.ready = '1';
    var res = evaluate(run);
    if (box.lastKey !== JSON.stringify([state.run, state.points, state.preset, state.level, state.lead, state.review, state.undated])) el('invPlanPoMsg').textContent = ''; // the inputs changed
    box.lastKey = JSON.stringify([state.run, state.points, state.preset, state.level, state.lead, state.review, state.undated]);
    box.res = res;
    controls(res);
    summary(res, run);
    table(res);
    panel(res, run);
    notes(res, run);
  }

  function exportCsv() {
    var res = box.res;
    if (!res) return;
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [['point', 'level', 'sku', 'service_level', 'required', 'projected', 'shortfall', 'cover_days', 'order_by', 'status'].join(',')];
    res.rows.forEach(function (r) {
      lines.push([r.point, 'country', r.sku, state.level, r.required == null ? '' : Math.round(r.required), r.projected == null ? '' : Math.round(r.projected),
        r.short == null ? '' : Math.round(r.short), r.days == null ? '' : r.days.toFixed(1), r.short > 0 ? (r.late ? iso(today()) : iso(r.orderBy)) : '', STATUS[r.status]].map(q).join(','));
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = 'apra_stock_needed_' + iso(today()) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // A demo only: no procurement system is connected, so nothing is created or
  // sent. One draft per short SKU, for its largest shortfall across the dates.
  function draftPos() {
    var res = box.res, msg = el('invPlanPoMsg');
    if (!res) return;
    var bySku = {};
    res.rows.forEach(function (r) {
      if (!(r.short > 0)) return;
      var d = bySku[r.sku] || (bySku[r.sku] = { units: 0, by: r.late ? today() : r.orderBy });
      d.units = Math.max(d.units, Math.round(r.short)); // as the table shows it
      var by = r.late ? today() : r.orderBy;
      if (by < d.by) d.by = by;
    });
    var skus = Object.keys(bySku), units = skus.reduce(function (t, k) { return t + bySku[k].units; }, 0);
    msg.textContent = skus.length
      ? 'Demo only: this would create ' + skus.length + ' PO draft' + (skus.length === 1 ? '' : 's') + ' for ' + whole(units) + ' units (' +
        skus.map(function (k) { return k + ' ' + whole(bySku[k].units); }).join(', ') + '). Nothing was created or sent: no procurement system is connected.'
      : 'No shortfall at these dates, so there is nothing to order.';
  }

  // ---------- events ----------
  el('invPlanRun').addEventListener('change', function () { state.run = this.value; state.sel = null; render(); });
  el('invPlanPreset').addEventListener('change', function () {
    if (this.value !== 'custom') { state.preset = this.value; state.points = null; }
    else state.points = (state.points || presetPoints(state.preset)).slice();
    render();
  });
  el('invPlanAdd').addEventListener('change', function () {
    if (!this.value || parse(this.value) < today()) return;
    var list = (state.points || presetPoints(state.preset)).filter(function (x) { return x !== this.value; }, this);
    state.points = list.concat(this.value).sort().slice(-12);
    this.value = '';
    render();
  });
  el('invPlanLevel').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { state.level = b.dataset.v; render(); } });
  var number = function (input, key, lo, hi) {
    input.addEventListener('change', function () {
      var v = Math.round(Number(input.value));
      if (!(v >= lo && v <= hi)) { input.value = key === 'lead' ? leadDays() : state[key]; return; }
      state[key] = v;
      render();
    });
  };
  number(el('invPlanLead'), 'lead', 1, 180);
  number(el('invPlanReview'), 'review', 0, 90);
  el('invPlanUndated').addEventListener('change', function () { state.undated = this.checked; render(); });
  var pick = function (tr) { state.sel = tr.dataset.sku; if (tr.dataset.point) state.point = tr.dataset.point; };
  el('invPlanRows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr.inv-plan-row');
    if (!tr) return;
    pick(tr);
    var c = e.target.closest('td.inv-cell');
    if (c && c.dataset.point) state.point = c.dataset.point;
    render();
  });
  el('invPlanRows').addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr.inv-plan-row');
    if (!tr) return;
    var step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      var all = Array.from(el('invPlanRows').querySelectorAll('tr.inv-plan-row')), next = all[all.indexOf(tr) + step];
      if (next) next.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(tr);
      render();
      var again = el('invPlanRows').querySelector('tr[data-sku="' + CSS.escape(state.sel) + '"]' + (tr.dataset.point ? '[data-point="' + tr.dataset.point + '"]' : ''));
      if (again) again.focus();
    }
  });
  el('invPlanView').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { state.view = b.dataset.v; render(); } });
  el('invPlanCsv').addEventListener('click', exportCsv);
  el('invPlanPo').addEventListener('click', draftPos);
  document.addEventListener('apra:scenarios-list', function (event) {
    runs = (event.detail || []).filter(function (r) { return r.status === 'completed' && !r.approved; })
      .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    if (state.run !== 'plan' && !runs.some(function (r) { return r.id === state.run; })) state.run = 'plan';
    if (inputs) render();
  });
  document.addEventListener('apra:overview', function (event) { forecastState = event.detail.loaded; render(); }); // the forecast has loaded (or changed)
  document.querySelectorAll('.dnav li').forEach(function (li) {
    if (li.title === 'Inventory') li.addEventListener('click', function () { setTimeout(render, 0); });
  });
  if (localStorage && (function () { try { return localStorage.getItem('apra_dashboard_panel') === 'Inventory'; } catch (e) { return false; } })()) setTimeout(render, 0);
})();
