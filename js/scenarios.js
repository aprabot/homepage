/* ============================================================
   APRABot dashboard — Scenarios (run / revision history / approve / compare)
   Talks to the Cognito-authenticated /scenarios API.
============================================================ */
(function () {
  'use strict';

  var SCENARIOS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var pollTimer = null;
  var lastScenarios = [];
  var selectedForCompare = [];

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function fmtRelative(iso) {
    if (!iso) return '—';
    var diffMs = Date.now() - new Date(iso).getTime();
    var mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function configBadges(s) {
    var bits = [];
    bits.push(s.known_prices ? 'KP' : 'no-KP');
    bits.push(s.weather ? 'WX' : 'no-WX');
    bits.push(s.calibrate ? 'CAL' : 'no-CAL');
    bits.push(s.refresh_days + 'd');
    return bits.join(' · ');
  }

  function statusPill(s) {
    if (s.approved) return '<span class="pill ok">Approved</span>';
    if (s.status === 'running') return '<span class="pill warn">Running…</span>';
    if (s.status === 'failed') return '<span class="pill risk">Failed</span>';
    return '<span class="pill" style="color:var(--muted);border-color:var(--line-2);background:var(--ink-3)">Completed</span>';
  }

  function render(scenarios) {
    lastScenarios = scenarios;
    var body = document.getElementById('scenariosBody');
    var empty = document.getElementById('scenariosEmpty');
    if (!body) return;

    if (!scenarios.length) {
      body.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    body.innerHTML = scenarios.map(function (s) {
      var canCompare = s.status === 'completed';
      var checked = selectedForCompare.indexOf(s.id) > -1 ? 'checked' : '';
      var approveBtn = (s.status === 'completed' && !s.approved)
        ? '<button class="dbtn" style="padding:6px 12px;font-size:12px" onclick="event.stopPropagation();approveScenario(\'' + s.id + '\')">Approve</button>'
        : '';
      return '<tr onclick="viewScenario(\'' + s.id + '\')" style="cursor:pointer">' +
        '<td>' + (canCompare ? '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation()" onchange="toggleCompareSelect(\'' + s.id + '\',this.checked)">' : '') + '</td>' +
        '<td style="font-weight:600">' + escapeHtml(s.label || 'Untitled') + '</td>' +
        '<td class="dsubtle" style="margin:0">' + escapeHtml((s.requested_by || '').split('@')[0]) + '</td>' +
        '<td class="dsubtle" style="margin:0;font-family:var(--mono);font-size:11px">' + configBadges(s) + '</td>' +
        '<td>' + (s.wape != null ? s.wape.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + (s.volume_error != null ? (s.volume_error > 0 ? '+' : '') + s.volume_error.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + statusPill(s) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + fmtRelative(s.created_at) + '</td>' +
        '<td>' + approveBtn + '</td>' +
        '</tr>';
    }).join('');

    updateCompareBtn();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.toggleCompareSelect = function (id, on) {
    selectedForCompare = selectedForCompare.filter(function (x) { return x !== id; });
    if (on) selectedForCompare.push(id);
    if (selectedForCompare.length > 2) selectedForCompare.shift(); // keep only last 2
    render(lastScenarios); // re-render to reflect the 2-max trim in checkboxes
    updateCompareBtn();
  };

  function updateCompareBtn() {
    var btn = document.getElementById('compareBtn');
    if (!btn) return;
    btn.style.display = selectedForCompare.length === 2 ? '' : 'none';
  }

  function loadScenarios() {
    fetch(SCENARIOS_API, { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) { render(d.scenarios || []); })
      .catch(function () { /* leave table as-is on transient error */ });
  }

  function ensurePolling() {
    var hasRunning = lastScenarios.some(function (s) { return s.status === 'running'; });
    if (hasRunning && !pollTimer) {
      pollTimer = setInterval(function () {
        loadScenarios();
      }, 8000);
    } else if (!hasRunning && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  var _origRender = render;
  render = function (scenarios) {
    _origRender(scenarios);
    ensurePolling();
  };

  /* ── Run new forecast modal ── */
  window.openRunForecastModal = function () {
    var m = document.getElementById('runForecastModal');
    if (m) m.classList.add('open');
    document.getElementById('rf-label').value = '';
    document.getElementById('rf-error').textContent = '';
  };
  window.closeRunForecastModal = function () {
    var m = document.getElementById('runForecastModal');
    if (m) m.classList.remove('open');
  };

  // Generic pill toggle for the run-forecast modal's On/Off/7d/14d/28d groups.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#runForecastModal .theme-pill button');
    if (!btn) return;
    var group = btn.parentElement;
    group.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
  });

  function pillValue(groupId) {
    var el = document.getElementById(groupId);
    var active = el && el.querySelector('.active');
    return active ? active.dataset.v : null;
  }

  window.submitRunForecast = function (e) {
    e.preventDefault();
    var label = document.getElementById('rf-label').value.trim() || 'Untitled scenario';
    var errEl = document.getElementById('rf-error');
    var btn = e.target.querySelector('button[type=submit]');

    var payload = {
      label: label,
      known_prices: pillValue('rf-known-prices') === '1',
      weather: pillValue('rf-weather') === '1',
      calibrate: pillValue('rf-calibrate') === '1',
      refresh_days: parseInt(pillValue('rf-refresh') || '28', 10),
    };

    btn.disabled = true;
    btn.textContent = 'Starting…';
    errEl.textContent = '';

    fetch(SCENARIOS_API, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Start run →';
        if (!res.ok) {
          errEl.textContent = res.d.error || 'Failed to start run.';
          return;
        }
        window.closeRunForecastModal();
        loadScenarios();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Start run →';
        errEl.textContent = 'Connection error — please try again.';
      });
  };

  /* ── Approve ── */
  window.approveScenario = function (id) {
    fetch(SCENARIOS_API + '/' + id + '/approve', {
      method: 'POST',
      headers: authHeaders(),
    })
      .then(function () {
        loadScenarios();
        try { localStorage.removeItem('apra_forecast_cache'); } catch (e) {}
        if (typeof loadForecast === 'function') loadForecast(); // refresh Overview/Forecasts with the newly-approved data
      });
  };

  /* ── Compare ── */
  window.openCompareModal = function () {
    if (selectedForCompare.length !== 2) return;
    var body = document.getElementById('compareBody');
    body.innerHTML = '<p class="dsubtle">Loading comparison…</p>';
    document.getElementById('compareModal').classList.add('open');

    Promise.all(selectedForCompare.map(function (id) {
      return fetch(SCENARIOS_API + '/' + id + '/result', { headers: authHeaders() }).then(function (r) { return r.json(); });
    })).then(function (results) {
      var metas = selectedForCompare.map(function (id) {
        return lastScenarios.find(function (s) { return s.id === id; });
      });
      renderCompare(metas, results);
    }).catch(function () {
      body.innerHTML = '<p class="auth-error">Could not load one or both results.</p>';
    });
  };
  window.closeCompareModal = function () {
    document.getElementById('compareModal').classList.remove('open');
  };

  function renderCompare(metas, results) {
    var body = document.getElementById('compareBody');
    var rows = [
      ['Config', metas.map(configBadges)],
      ['Overall WAPE', results.map(function (r) { return r.overallWape.toFixed(2) + '%'; })],
      ['Weeks', results.map(function (r) { return r.weeks.length; })],
      ['SKUs', results.map(function (r) { return Object.keys(r.skus).length; })],
    ];
    var totals = results.map(function (r) {
      // Sum only over the backtest portion — r.all.f may extend past r.all.a
      // into the forward-forecast weeks, and mixing those in would inflate
      // "Forecast units" against actuals that don't cover the same weeks.
      var bw = r.backtestWeeks != null ? r.backtestWeeks : r.weeks.length;
      var a = r.all.a.slice(0, bw).reduce(function (s, x) { return s + x; }, 0);
      var f = r.all.f.slice(0, bw).reduce(function (s, x) { return s + x; }, 0);
      return { a: a, f: f, err: a ? (100 * (f - a) / a) : 0 };
    });
    rows.push(['Actual units', totals.map(function (t) { return t.a.toLocaleString(); })]);
    rows.push(['Forecast units', totals.map(function (t) { return t.f.toLocaleString(); })]);
    rows.push(['Volume error', totals.map(function (t) { return (t.err > 0 ? '+' : '') + t.err.toFixed(2) + '%'; })]);

    var betterIdx = results[0].overallWape <= results[1].overallWape ? 0 : 1;

    var html = '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px">' +
      '<div></div>' +
      metas.map(function (m, i) {
        return '<div style="font-weight:700;padding-bottom:10px;border-bottom:2px solid ' +
          (i === betterIdx ? 'var(--signal)' : 'var(--line)') + '">' + escapeHtml(m.label) +
          (i === betterIdx ? ' <span class="pill ok" style="margin-left:4px">Lower WAPE</span>' : '') + '</div>';
      }).join('') +
      rows.map(function (row) {
        return '<div class="dsubtle" style="margin:0;padding:10px 0;border-top:1px solid var(--line)">' + row[0] + '</div>' +
          row[1].map(function (v) {
            return '<div style="padding:10px 0;border-top:1px solid var(--line)">' + v + '</div>';
          }).join('');
      }).join('') +
      '</div>';

    html += '<div class="dcard" style="margin-top:20px;padding:16px">' +
      '<div class="ch"><h4>Weekly actual vs. each scenario\'s forecast</h4></div>' +
      '<div class="dchart" style="height:220px"><canvas id="cmpCanvas"></canvas></div>' +
      '<div class="chart-legend">' +
      '<span><i style="background:#54E6C4"></i>Actual</span>' +
      '<span><i style="background:#C8F24E;border-radius:0;height:0;border-top:2px dashed #C8F24E"></i>' + escapeHtml(metas[0].label) + '</span>' +
      '<span><i style="background:#7AA2FF;border-radius:0;height:0;border-top:2px dashed #7AA2FF"></i>' + escapeHtml(metas[1].label) + '</span>' +
      '</div></div>';

    body.innerHTML = html;
    drawCompareChart(results[0].weeks, results[0].all.a, results[0].all.f, results[1].all.f, results[0].backtestWeeks);
  }

  function drawCompareChart(weeks, actual, forecastA, forecastB, backtestWeeks) {
    var cv = document.getElementById('cmpCanvas');
    if (!cv) return;
    var box = cv.parentElement;
    var cw = box.clientWidth || 680, ch = box.clientHeight || 220, dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = ch * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var padL = 54, padR = 12, padT = 12, padB = 22;
    var N = weeks.length;
    var nonNull = function (arr) { return arr.filter(function (v) { return v != null; }); };
    var uMax = Math.max.apply(null, nonNull(actual).concat(nonNull(forecastA), nonNull(forecastB))) * 1.12 || 1;
    var X = function (i) { return padL + i * (cw - padL - padR) / (N - 1 || 1); };
    var Y = function (v) { return padT + (ch - padT - padB) * (1 - v / uMax); };

    ctx.font = '10px JetBrains Mono';
    for (var g = 0; g <= 3; g++) {
      var y = padT + (ch - padT - padB) * g / 3;
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cw - padR, y); ctx.stroke();
      ctx.fillStyle = '#5C6878'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(uMax * (1 - g / 3)).toLocaleString(), padL - 8, y + 3);
    }
    ctx.fillStyle = '#5C6878'; ctx.textAlign = 'center';
    var step = Math.max(1, Math.round(N / 6));
    for (var i = 0; i < N; i += step) { ctx.fillText(weeks[i].slice(5), X(i), ch - 6); }

    function line(arr, color, dash, width) {
      ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.setLineDash(dash || []);
      ctx.beginPath(); var started = false;
      arr.forEach(function (v, i) {
        if (v == null) return;
        var x = X(i), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }
    line(actual, '#54E6C4', null, 2.4);
    line(forecastA, '#C8F24E', [7, 5]);
    line(forecastB, '#7AA2FF', [2, 3]);

    if (backtestWeeks != null && backtestWeeks > 0 && backtestWeeks < N) {
      var bx = X(backtestWeeks - 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, ch - padB); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#5C6878'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
      ctx.fillText('FORECAST →', bx + 4, padT + 10);
    }
  }

  /* ── Scenario detail ── */
  window.viewScenario = function (id) {
    var meta = lastScenarios.find(function (s) { return s.id === id; });
    if (!meta) return;
    var body = document.getElementById('scenarioDetailBody');
    body.innerHTML = '<p class="dsubtle">Loading…</p>';
    document.getElementById('scenarioDetailModal').classList.add('open');

    if (meta.status !== 'completed') {
      renderScenarioDetail(meta, null);
      return;
    }
    fetch(SCENARIOS_API + '/' + id + '/result', { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (result) { renderScenarioDetail(meta, result); })
      .catch(function () {
        body.innerHTML = '<p class="auth-error">Could not load this scenario\'s result.</p>';
      });
  };
  window.closeScenarioDetail = function () {
    document.getElementById('scenarioDetailModal').classList.remove('open');
  };

  function renderScenarioDetail(meta, result) {
    var body = document.getElementById('scenarioDetailBody');
    var approveBtn = (meta.status === 'completed' && !meta.approved)
      ? '<button class="dbtn" onclick="approveScenario(\'' + meta.id + '\');closeScenarioDetail()">Approve</button>'
      : '';

    var html = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:4px">' +
      '<div><h3 style="margin-bottom:4px">' + escapeHtml(meta.label || 'Untitled') + '</h3>' +
      statusPill(meta) + '</div>' + approveBtn + '</div>';

    html += '<div class="dsubtle" style="margin:12px 0 20px">' +
      'Requested by ' + escapeHtml((meta.requested_by || '').split('@')[0]) +
      ' · Created ' + fmtRelative(meta.created_at) +
      (meta.completed_at ? ' · Completed ' + fmtRelative(meta.completed_at) : '') +
      ' · Config: <span style="font-family:var(--mono)">' + configBadges(meta) + '</span>' +
      '</div>';

    if (meta.status === 'running') {
      html += '<p class="dsubtle">Still training — this view will show results once it completes. Close and reopen in a minute.</p>';
      body.innerHTML = html;
      return;
    }
    if (meta.status === 'failed') {
      html += '<p class="auth-error">' + escapeHtml(meta.error || 'Run failed.') + '</p>';
      body.innerHTML = html;
      return;
    }
    if (!result) {
      html += '<p class="dsubtle">No result available.</p>';
      body.innerHTML = html;
      return;
    }

    html += '<div class="kpis" style="margin-bottom:20px">' +
      '<div class="kpi"><div class="t">Overall WAPE</div><div class="v">' + result.overallWape.toFixed(2) + '%</div></div>' +
      '<div class="kpi"><div class="t">Volume error</div><div class="v">' + (meta.volume_error > 0 ? '+' : '') + (meta.volume_error != null ? meta.volume_error.toFixed(2) : '0') + '%</div></div>' +
      '<div class="kpi"><div class="t">SKUs</div><div class="v">' + Object.keys(result.skus).length + '</div></div>' +
      '<div class="kpi"><div class="t">Weeks</div><div class="v">' + result.weeks.length + '</div></div>' +
      '</div>';

    html += '<div class="dcard" style="padding:16px">' +
      '<div class="ch"><h4>Forecast vs actuals — all SKUs</h4></div>' +
      '<div class="dchart" style="height:200px"><canvas id="sdCanvas"></canvas></div>' +
      '<div class="chart-legend"><span><i style="background:#54E6C4"></i>Actual</span>' +
      '<span><i style="background:#C8F24E;border-radius:0;height:0;border-top:2px dashed #C8F24E"></i>Forecast</span></div>' +
      '</div>';

    var topSkus = Object.keys(result.skus).map(function (id) {
      var o = result.skus[id];
      var vol = 0, num = 0;
      o.a.forEach(function (x, i) {
        if (x == null) return; // skip forward-forecast weeks — no actual to score against
        vol += x;
        num += Math.abs(x - (o.f[i] || 0));
      });
      var wape = vol ? (100 * num / vol) : 0;
      return { id: id, vol: vol, wape: wape };
    }).sort(function (a, b) { return b.vol - a.vol; }).slice(0, 8);

    html += '<div class="dcard" style="margin-top:16px;padding:16px">' +
      '<div class="ch"><h4>Top SKUs by volume</h4></div>' +
      '<div class="table-wrap"><table class="dtable"><thead><tr><th>SKU</th><th>Units</th><th>WAPE</th></tr></thead><tbody>' +
      topSkus.map(function (r) {
        return '<tr><td class="skucell">' + r.id + '</td><td>' + r.vol.toLocaleString() + '</td><td>' + r.wape.toFixed(1) + '%</td></tr>';
      }).join('') +
      '</tbody></table></div></div>';

    body.innerHTML = html;
    drawScenarioChart(result.weeks, result.all.a, result.all.f, result.backtestWeeks);
  }

  function drawScenarioChart(weeks, a, f, backtestWeeks) {
    var cv = document.getElementById('sdCanvas');
    if (!cv) return;
    var box = cv.parentElement;
    var cw = box.clientWidth || 680, ch = box.clientHeight || 200, dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = ch * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var padL = 50, padR = 12, padT = 12, padB = 22;
    var N = weeks.length;
    var nonNull = function (arr) { return arr.filter(function (v) { return v != null; }); };
    var uMax = Math.max.apply(null, nonNull(a).concat(nonNull(f))) * 1.12 || 1;
    var X = function (i) { return padL + i * (cw - padL - padR) / (N - 1 || 1); };
    var Y = function (v) { return padT + (ch - padT - padB) * (1 - v / uMax); };

    ctx.font = '10px JetBrains Mono';
    for (var g = 0; g <= 3; g++) {
      var y = padT + (ch - padT - padB) * g / 3;
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cw - padR, y); ctx.stroke();
      ctx.fillStyle = '#5C6878'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(uMax * (1 - g / 3)).toLocaleString(), padL - 8, y + 3);
    }
    ctx.fillStyle = '#5C6878'; ctx.textAlign = 'center';
    var step = Math.max(1, Math.round(N / 6));
    for (var i = 0; i < N; i += step) { ctx.fillText(weeks[i].slice(5), X(i), ch - 6); }

    function line(arr, color, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []);
      ctx.beginPath(); var started = false;
      arr.forEach(function (v, i) {
        if (v == null) return;
        var x = X(i), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }

    line(a, '#54E6C4');
    line(f, '#C8F24E', [7, 5]);

    if (backtestWeeks != null && backtestWeeks > 0 && backtestWeeks < N) {
      var bx = X(backtestWeeks - 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, ch - padB); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#5C6878'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
      ctx.fillText('FORECAST →', bx + 4, padT + 10);
    }
  }

  /* ── init when the Scenarios nav item is first opened ── */
  var _loaded = false;
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.dnav li').forEach(function (li) {
      li.addEventListener('click', function () {
        if (li.textContent.trim() === 'Scenarios' && !_loaded) {
          _loaded = true;
          loadScenarios();
        }
      });
    });
  });
})();
