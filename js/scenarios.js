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
        ? '<button class="dbtn" style="padding:6px 12px;font-size:12px" onclick="approveScenario(\'' + s.id + '\')">Approve</button>'
        : '';
      return '<tr>' +
        '<td>' + (canCompare ? '<input type="checkbox" ' + checked + ' onchange="toggleCompareSelect(\'' + s.id + '\',this.checked)">' : '') + '</td>' +
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
      var a = r.all.a.reduce(function (s, x) { return s + x; }, 0);
      var f = r.all.f.reduce(function (s, x) { return s + x; }, 0);
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

    body.innerHTML = html;
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
