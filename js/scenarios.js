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
  var sdVisible = { a: true, f: true };
  var cmpVisible = { a: true, fA: true, fB: true };
  var cmpZoom = null;       // {start, end} week-index range (inclusive) into the full series, or null = full range
  var cmpLastRender = null; // {X, N0, dataLen} from the most recent drawCompareChart call, for hit-testing drags
  var lastCompare = null;   // {metas, results, totals, forward, fwdDelta} from the most recent renderCompare, for .xlsx export
  var cmpMaximized = false;
  var cmpRedraw = null;     // current redrawCmp closure, so toggling maximize can redraw the chart at its new size

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  // A 401 here means the stored token expired mid-session (the page-load
  // guard only checks once, on load) — clear it and send the user back to
  // sign in again, rather than leaving a cryptic failed-request error.
  function signOutExpired() {
    try {
      localStorage.removeItem('apra_access');
      localStorage.removeItem('apra_id');
      localStorage.removeItem('apra_refresh');
    } catch (e) {}
    window.location.replace('/');
  }

  // Wires click-to-toggle behavior onto a chart's legend items, reflecting
  // (and mutating) the given visibility state object, then re-drawing.
  function wireLegend(container, state, redraw) {
    if (!container) return;
    container.querySelectorAll('.lgd-item').forEach(function (el) {
      var k = el.dataset.k;
      el.classList.toggle('off', !state[k]);
      el.onclick = function () {
        state[k] = !state[k];
        el.classList.toggle('off', !state[k]);
        redraw();
      };
    });
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

  function configDescription(s) {
    var parts = [
      s.known_prices ? 'known prices' : 'no known prices',
      s.weather ? 'weather signal' : 'no weather signal',
      s.calibrate ? 'calibrated' : 'not calibrated',
      s.refresh_days + '-day refresh',
    ];
    if (s.custom_input) parts.push('custom input file');
    return parts.join(', ');
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
        '<td class="dsubtle" style="margin:0">' + configDescription(s) + '</td>' +
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
    return fetch(SCENARIOS_API, { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) { render(d.scenarios || []); })
      .catch(function () { /* leave table as-is on transient error */ });
  }

  window.refreshScenarios = function (btn) {
    var icon = btn && btn.querySelector('svg');
    if (icon) icon.classList.add('spin');
    loadScenarios().then(function () {
      if (icon) icon.classList.remove('spin');
    });
  };

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

  /* ── Notifications (bell) — derived from the same scenario list ── */
  function notifKind(s) {
    if (s.status === 'running') return 'running';
    if (s.status === 'failed') return 'failed';
    if (s.approved) return 'approved';
    return 'completed';
  }

  function notifText(s) {
    var label = escapeHtml(s.label || 'Untitled');
    switch (notifKind(s)) {
      case 'running':  return 'Scenario "' + label + '" is generating…';
      case 'failed':   return 'Scenario "' + label + '" failed to generate';
      case 'approved': return 'Scenario "' + label + '" was approved and is now live';
      default:         return 'Scenario "' + label + '" has been generated';
    }
  }

  function notifTime(s) {
    return s.completed_at || s.created_at;
  }

  function renderNotifications(scenarios) {
    var list = document.getElementById('notifList');
    var empty = document.getElementById('notifEmpty');
    var bell = document.getElementById('notifBell');
    if (!list) return;

    var items = scenarios.slice().sort(function (a, b) {
      return new Date(notifTime(b) || 0) - new Date(notifTime(a) || 0);
    }).slice(0, 8);

    if (!items.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      if (bell) bell.classList.remove('has-unread');
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = items.map(function (s) {
      return '<div class="notif-item" onclick="viewScenario(\'' + s.id + '\')">' +
        '<span class="notif-dot ' + notifKind(s) + '"></span>' +
        '<div><span class="notif-text">' + notifText(s) + '</span>' +
        '<span class="notif-time">' + fmtRelative(notifTime(s)) + '</span></div>' +
        '</div>';
    }).join('');

    var latest = notifTime(items[0]);
    var seen = localStorage.getItem('apra_notif_seen');
    if (bell) bell.classList.toggle('has-unread', !!latest && (!seen || new Date(latest) > new Date(seen)));
  }

  // Resets the client-side forecast cache whenever the approved scenario
  // changes — whether that change came from this tab's own approve click,
  // another tab, or another user entirely. render() runs on every fetch
  // (eager load, poll, manual refresh, or an explicit approve), so this
  // catches an approval no matter where it happened.
  //
  // The last-known approved id is persisted to localStorage, not just held
  // in a JS variable — a plain in-memory value resets to undefined on every
  // page load, so it would only ever catch an approval that happened while
  // a tab was already open and polling. A user who simply reloads or
  // revisits after someone else approves elsewhere needs the comparison to
  // survive across page loads, which only localStorage does.
  var APPROVED_ID_KEY = 'apra_last_approved_id';
  function checkApprovalChange(scenarios) {
    var approved = scenarios.find(function (s) { return s.approved; });
    var approvedId = approved ? approved.id : null;
    var lastKnown;
    try { lastKnown = localStorage.getItem(APPROVED_ID_KEY); } catch (e) { lastKnown = null; }
    if (lastKnown !== null && approvedId !== lastKnown) {
      try { localStorage.removeItem('apra_forecast_cache'); } catch (e) {}
      if (typeof loadForecast === 'function') loadForecast();
    }
    try { localStorage.setItem(APPROVED_ID_KEY, approvedId || ''); } catch (e) {}
  }

  var _origRender = render;
  render = function (scenarios) {
    _origRender(scenarios);
    ensurePolling();
    renderNotifications(scenarios);
    checkApprovalChange(scenarios);
  };

  /* ── Run new forecast modal ── */
  window.openRunForecastModal = function () {
    var m = document.getElementById('runForecastModal');
    if (m) m.classList.add('open');
    document.getElementById('rf-label').value = '';
    document.getElementById('rf-error').textContent = '';
    document.getElementById('rf-upload-row').style.display = 'none';
    document.getElementById('rf-upload-status').textContent = '';
    var fileInput = document.getElementById('rf-file');
    if (fileInput) fileInput.value = '';
    var sourcePill = document.getElementById('rf-source');
    if (sourcePill) {
      sourcePill.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.v === 'default'); });
    }
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
    if (group.id === 'rf-source') {
      document.getElementById('rf-upload-row').style.display = btn.dataset.v === 'custom' ? '' : 'none';
    }
  });

  function pillValue(groupId) {
    var el = document.getElementById(groupId);
    var active = el && el.querySelector('.active');
    return active ? active.dataset.v : null;
  }

  function uploadCustomInput(file) {
    var statusEl = document.getElementById('rf-upload-status');
    statusEl.textContent = 'Requesting upload URL…';
    return fetch(SCENARIOS_API + '/upload-url', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ filename: file.name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) { signOutExpired(); throw new Error('Session expired.'); }
        if (!res.ok) throw new Error(res.d.error || 'Could not get an upload URL.');
        statusEl.textContent = 'Uploading ' + file.name + '…';
        return fetch(res.d.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': res.d.content_type },
          body: file,
        }).then(function (putRes) {
          if (!putRes.ok) throw new Error('Upload failed (' + putRes.status + ').');
          statusEl.textContent = 'Upload complete.';
          return res.d.key;
        });
      });
  }

  window.submitRunForecast = function (e) {
    e.preventDefault();
    var label = document.getElementById('rf-label').value.trim() || 'Untitled scenario';
    var errEl = document.getElementById('rf-error');
    var btn = e.target.querySelector('button[type=submit]');
    var useCustom = pillValue('rf-source') === 'custom';
    var fileInput = document.getElementById('rf-file');
    var file = fileInput && fileInput.files && fileInput.files[0];

    errEl.textContent = '';
    if (useCustom && !file) {
      errEl.textContent = 'Choose a file to upload, or switch back to the default dataset.';
      return;
    }

    var payload = {
      label: label,
      known_prices: pillValue('rf-known-prices') === '1',
      weather: pillValue('rf-weather') === '1',
      calibrate: pillValue('rf-calibrate') === '1',
      refresh_days: parseInt(pillValue('rf-refresh') || '28', 10),
    };

    btn.disabled = true;
    btn.textContent = useCustom ? 'Uploading…' : 'Starting…';

    (useCustom ? uploadCustomInput(file) : Promise.resolve(null))
      .then(function (customInputKey) {
        if (customInputKey) payload.custom_input_key = customInputKey;
        btn.textContent = 'Starting…';
        return fetch(SCENARIOS_API, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify(payload),
        });
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
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Start run →';
        errEl.textContent = err.message || 'Connection error — please try again.';
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
    cmpZoom = null; // fresh comparison starts fully zoomed out
    cmpMaximized = false;
    var card = document.getElementById('compareCard');
    if (card) card.classList.remove('maximized');
    var body = document.getElementById('compareBody');
    var rows = [
      ['Config', metas.map(configDescription)],
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
    rows.push(['Forecast units (backtest period)', totals.map(function (t) { return t.f.toLocaleString(); })]);
    rows.push(['Volume error', totals.map(function (t) { return (t.err > 0 ? '+' : '') + t.err.toFixed(2) + '%'; })]);

    // Forward-horizon totals — the genuinely forward-looking numbers (e.g.
    // the effect of a Future Price / discount sheet). Backtest-period WAPE
    // and volume error above are identical whenever two scenarios share the
    // same historical data, so they can't show a Future Price scenario's
    // actual impact — this can.
    var forward = results.map(function (r) {
      var bw = r.backtestWeeks != null ? r.backtestWeeks : r.weeks.length;
      var slice = r.all.f.slice(bw);
      var f = slice.reduce(function (s, x) { return s + (x || 0); }, 0);
      return { f: f, n: slice.length };
    });
    var fwdDelta = null;
    if (forward.some(function (t) { return t.n > 0; })) {
      rows.push(['Forecast units (forward horizon)', forward.map(function (t) {
        return t.n > 0 ? t.f.toLocaleString() + ' over ' + t.n + ' wk' : '—';
      })]);
      if (forward[0].f && forward[1].n > 0) {
        fwdDelta = 100 * (forward[1].f - forward[0].f) / forward[0].f;
        rows.push(['Forward horizon delta', ['—', (fwdDelta > 0 ? '+' : '') + fwdDelta.toFixed(2) + '%']]);
      }
    }
    lastCompare = { metas: metas, results: results, totals: totals, forward: forward, fwdDelta: fwdDelta };

    var betterIdx = results[0].overallWape <= results[1].overallWape ? 0 : 1;

    var html = '<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px">' +
      '<button type="button" class="dbtn" id="cmpMaximizeBtn" style="padding:6px 16px;font-size:14px;min-width:44px;justify-content:center;' +
      'background:var(--ink-3);color:var(--text);border:1px solid var(--line-2)" ' +
      'title="Maximize" aria-label="Maximize" onclick="toggleCompareMaximize()">⤢</button>' +
      '<button type="button" class="dbtn" style="padding:6px 10px;font-size:14px;' +
      'background:var(--ink-3);color:var(--text);border:1px solid var(--line-2)" ' +
      'title="Download .xlsx" aria-label="Download .xlsx" onclick="downloadCompareXlsx()">⬇</button>' +
      '</div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px">' +
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
      '<div class="ch" style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
      '<h4>Weekly actual vs. each scenario\'s forecast</h4>' +
      '<div id="cmpZoomBar" style="display:flex;align-items:center;gap:8px"></div>' +
      '</div>' +
      '<div class="dchart cmp-chart-box" style="position:relative"><canvas id="cmpCanvas"></canvas></div>' +
      '<div class="chart-legend" id="cmpLegend">' +
      '<span class="lgd-item" data-k="a"><i style="background:#54E6C4"></i>Actual</span>' +
      '<span class="lgd-item" data-k="fA"><i style="background:#C8F24E;border-radius:0;height:0;border-top:2px dashed #C8F24E"></i>' + escapeHtml(metas[0].label) + '</span>' +
      '<span class="lgd-item" data-k="fB"><i style="background:#7AA2FF;border-radius:0;height:0;border-top:2px dashed #7AA2FF"></i>' + escapeHtml(metas[1].label) + '</span>' +
      '</div>' +
      '<p class="dsubtle" style="margin:8px 0 0;font-size:11px">Drag on the chart to zoom in · double-click or Reset zoom to zoom back out</p>' +
      '</div>';

    body.innerHTML = html;
    var redrawCmp = function (dragPx) {
      drawCompareChart(results[0].weeks, results[0].all.a, results[0].all.f, results[1].all.f, results[0].backtestWeeks, dragPx);
    };
    cmpRedraw = redrawCmp;
    redrawCmp();
    wireLegend(document.getElementById('cmpLegend'), cmpVisible, redrawCmp);
    wireCompareZoom(document.getElementById('cmpCanvas'), redrawCmp);
  }

  window.toggleCompareMaximize = function () {
    var card = document.getElementById('compareCard');
    var btn = document.getElementById('cmpMaximizeBtn');
    if (!card) return;
    cmpMaximized = !cmpMaximized;
    card.classList.toggle('maximized', cmpMaximized);
    if (btn) {
      btn.textContent = cmpMaximized ? '⤡' : '⤢';
      btn.title = cmpMaximized ? 'Restore' : 'Maximize';
      btn.setAttribute('aria-label', btn.title);
    }
    // The chart box's CSS height changes with the card size — redraw so the
    // canvas picks up its new on-screen dimensions instead of staying at
    // whatever size it was drawn at before.
    if (cmpRedraw) cmpRedraw();
  };

  // Exports the currently-open comparison to an .xlsx workbook — a Summary
  // sheet mirroring the KPI rows shown on screen, plus a Weekly data sheet
  // mirroring the chart. Uses the SheetJS build already loaded on this page
  // for reading uploads (js/onboarding.js) — no separate write-side library.
  window.downloadCompareXlsx = function () {
    if (!lastCompare || typeof XLSX === 'undefined') return;
    var metas = lastCompare.metas, results = lastCompare.results;
    var totals = lastCompare.totals, forward = lastCompare.forward, fwdDelta = lastCompare.fwdDelta;

    var summaryRows = [
      ['', metas[0].label, metas[1].label],
      ['Config', configDescription(metas[0]), configDescription(metas[1])],
      ['Overall WAPE (%)', results[0].overallWape, results[1].overallWape],
      ['Weeks', results[0].weeks.length, results[1].weeks.length],
      ['SKUs', Object.keys(results[0].skus).length, Object.keys(results[1].skus).length],
      ['Actual units (backtest period)', totals[0].a, totals[1].a],
      ['Forecast units (backtest period)', totals[0].f, totals[1].f],
      ['Volume error (%)', +totals[0].err.toFixed(2), +totals[1].err.toFixed(2)],
    ];
    if (forward.some(function (t) { return t.n > 0; })) {
      summaryRows.push(['Forecast units (forward horizon)', forward[0].f, forward[1].f]);
      summaryRows.push(['Forward horizon weeks', forward[0].n, forward[1].n]);
      if (fwdDelta != null) summaryRows.push(['Forward horizon delta (%)', '', +fwdDelta.toFixed(2)]);
    }

    var weeks = results[0].weeks;
    var bw = results[0].backtestWeeks != null ? results[0].backtestWeeks : weeks.length;
    var weeklyRows = [['Week', 'Period', 'Actual', metas[0].label + ' forecast', metas[1].label + ' forecast']];
    weeks.forEach(function (w, i) {
      weeklyRows.push([
        w,
        i < bw ? 'Backtest' : 'Forecast',
        results[0].all.a[i] != null ? results[0].all.a[i] : '',
        results[0].all.f[i] != null ? results[0].all.f[i] : '',
        results[1].all.f[i] != null ? results[1].all.f[i] : '',
      ]);
    });

    var wb = XLSX.utils.book_new();
    var wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{ wch: 30 }, { wch: 26 }, { wch: 26 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    var wsWeekly = XLSX.utils.aoa_to_sheet(weeklyRows);
    wsWeekly['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 24 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(wb, wsWeekly, 'Weekly data');

    var safeName = function (s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'scenario'; };
    XLSX.writeFile(wb, 'apra-scenario-compare_' + safeName(metas[0].label) + '_vs_' + safeName(metas[1].label) + '.xlsx');
  };

  function updateCmpZoomBar(redraw) {
    var bar = document.getElementById('cmpZoomBar');
    if (!bar) return;
    if (!cmpZoom) { bar.innerHTML = ''; return; }
    bar.innerHTML = '<button type="button" class="dbtn" style="padding:4px 10px;font-size:11.5px;' +
      'background:var(--ink-3);color:var(--text);border:1px solid var(--line-2)" id="cmpZoomResetBtn">↺ Reset zoom</button>';
    document.getElementById('cmpZoomResetBtn').onclick = function () {
      cmpZoom = null;
      redraw();
      updateCmpZoomBar(redraw);
    };
  }

  // Click-and-drag on the compare chart to zoom into a week range, CloudWatch-
  // metrics-style — the Y axis auto-rescales to whatever's visible, and
  // zooming again while already zoomed narrows further. Handlers live on the
  // canvas element itself (not window), so they're naturally discarded with
  // it on the next re-render — nothing to unwire.
  function wireCompareZoom(cv, redraw) {
    if (!cv) return;
    cv.style.cursor = 'crosshair';
    var dragStartPx = null;

    var pxFor = function (e) { return e.clientX - cv.getBoundingClientRect().left; };

    var endDrag = function (finalPx) {
      var startPx = dragStartPx;
      dragStartPx = null;
      if (startPx == null || !cmpLastRender) { redraw(); return; }
      if (Math.abs(finalPx - startPx) < 6) { redraw(); return; } // treat as a click, not a drag
      var lo = Math.min(startPx, finalPx), hi = Math.max(startPx, finalPx);
      var idx = cmpLastRender.pxToIndex;
      var startIdx = Math.max(0, Math.round(idx(lo)));
      var endIdx = Math.min(cmpLastRender.dataLen - 1, Math.round(idx(hi)));
      if (endIdx - startIdx < 1) { redraw(); return; }
      cmpZoom = { start: startIdx, end: endIdx };
      redraw();
      updateCmpZoomBar(redraw);
    };

    cv.onmousedown = function (e) { dragStartPx = pxFor(e); };
    cv.onmousemove = function (e) {
      if (dragStartPx == null) return;
      redraw({ x1: dragStartPx, x2: pxFor(e) });
    };
    cv.onmouseup = function (e) { endDrag(pxFor(e)); };
    cv.onmouseleave = function (e) { if (dragStartPx != null) endDrag(pxFor(e)); };
    cv.ondblclick = function () {
      if (cmpZoom) { cmpZoom = null; redraw(); updateCmpZoomBar(redraw); }
    };
  }

  function drawCompareChart(weeksFull, actualFull, forecastAFull, forecastBFull, backtestWeeksFull, dragPx) {
    var cv = document.getElementById('cmpCanvas');
    if (!cv) return;
    var box = cv.parentElement;
    var cw = box.clientWidth || 680, ch = box.clientHeight || 220, dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = ch * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var dataLen = weeksFull.length;
    var zStart = cmpZoom ? cmpZoom.start : 0;
    var zEnd = cmpZoom ? cmpZoom.end : dataLen - 1;
    var weeks = weeksFull.slice(zStart, zEnd + 1);
    var actual = actualFull.slice(zStart, zEnd + 1);
    var forecastA = forecastAFull.slice(zStart, zEnd + 1);
    var forecastB = forecastBFull.slice(zStart, zEnd + 1);

    var padL = 54, padR = 12, padT = 12, padB = 22;
    var N = weeks.length;
    var nonNull = function (arr) { return arr.filter(function (v) { return v != null; }); };
    // Y axis auto-rescales to whatever's currently visible, CloudWatch-style —
    // zooming into a narrow band reveals its own fluctuation instead of being
    // flattened against the full series' max.
    var uMax = Math.max.apply(null, nonNull(actual).concat(nonNull(forecastA), nonNull(forecastB))) * 1.12 || 1;
    var X = function (i) { return padL + i * (cw - padL - padR) / (N - 1 || 1); };
    var Y = function (v) { return padT + (ch - padT - padB) * (1 - v / uMax); };
    // Inverse of X(), remapped back onto the FULL (unzoomed) index space so
    // drag selections compose correctly when zooming in more than once.
    var pxToIndex = function (px) {
      var localIdx = (px - padL) * (N - 1 || 1) / (cw - padL - padR);
      return zStart + localIdx;
    };
    cmpLastRender = { pxToIndex: pxToIndex, dataLen: dataLen };

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
    if (cmpVisible.a) line(actual, '#54E6C4', null, 2.4);
    if (cmpVisible.fA) line(forecastA, '#C8F24E', [7, 5]);
    if (cmpVisible.fB) line(forecastB, '#7AA2FF', [2, 3]);

    if (backtestWeeksFull != null) {
      var bIdx = backtestWeeksFull - 0.5 - zStart;
      if (bIdx > 0 && bIdx < N) {
        var bx = X(bIdx);
        ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, ch - padB); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#5C6878'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
        ctx.fillText('FORECAST →', bx + 4, padT + 10);
      }
    }

    // Live selection overlay while dragging — doesn't commit a zoom, just feedback.
    if (dragPx) {
      var x1 = Math.max(padL, Math.min(cw - padR, dragPx.x1));
      var x2 = Math.max(padL, Math.min(cw - padR, dragPx.x2));
      var lo = Math.min(x1, x2), hi = Math.max(x1, x2);
      ctx.fillStyle = 'rgba(122,162,255,.16)';
      ctx.fillRect(lo, padT, hi - lo, ch - padT - padB);
      ctx.strokeStyle = 'rgba(122,162,255,.55)'; ctx.lineWidth = 1;
      ctx.strokeRect(lo, padT, hi - lo, ch - padT - padB);
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
    // result.inputDownload is a presigned URL to whatever this scenario
    // actually ran on — the uploaded file if there was one, otherwise the
    // platform default dataset (see scenarios-api's get_result).
    var inputBtn = (result && result.inputDownload)
      ? '<a class="dbtn" href="' + escapeHtml(result.inputDownload.url) + '" download="' + escapeHtml(result.inputDownload.filename) + '" ' +
        'style="background:var(--ink-3);color:var(--text);border:1px solid var(--line-2);text-decoration:none;padding:6px 10px;font-size:14px" ' +
        'title="' + (result.inputDownload.isDefault ? 'Download default dataset' : 'Download input file') + '" ' +
        'aria-label="Download input file">⬇</a>'
      : '';

    var html = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:4px">' +
      '<div><h3 style="margin-bottom:4px">' + escapeHtml(meta.label || 'Untitled') + '</h3>' +
      statusPill(meta) + '</div>' +
      '<div style="display:flex;gap:8px">' + inputBtn + approveBtn + '</div>' +
      '</div>';

    html += '<div class="dsubtle" style="margin:12px 0 20px">' +
      'Requested by ' + escapeHtml((meta.requested_by || '').split('@')[0]) +
      ' · Created ' + fmtRelative(meta.created_at) +
      (meta.completed_at ? ' · Completed ' + fmtRelative(meta.completed_at) : '') +
      ' · Config: ' + configDescription(meta) +
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
      '<div class="chart-legend" id="sdLegend"><span class="lgd-item" data-k="a"><i style="background:#54E6C4"></i>Actual</span>' +
      '<span class="lgd-item" data-k="f"><i style="background:#C8F24E;border-radius:0;height:0;border-top:2px dashed #C8F24E"></i>Forecast</span></div>' +
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
    wireLegend(document.getElementById('sdLegend'), sdVisible, function () {
      drawScenarioChart(result.weeks, result.all.a, result.all.f, result.backtestWeeks);
    });
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

    if (sdVisible.a) line(a, '#54E6C4');
    if (sdVisible.f) line(f, '#C8F24E', [7, 5]);

    if (backtestWeeks != null && backtestWeeks > 0 && backtestWeeks < N) {
      var bx = X(backtestWeeks - 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, ch - padB); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#5C6878'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'left';
      ctx.fillText('FORECAST →', bx + 4, padT + 10);
    }
  }

  /* ── init: load once on page load so the notification bell has data
     immediately, regardless of which tab the user starts on ── */
  document.addEventListener('DOMContentLoaded', function () {
    loadScenarios();

    var bell = document.getElementById('notifBell');
    var drop = document.getElementById('notifDrop');
    if (bell && drop) {
      bell.addEventListener('click', function (e) {
        e.stopPropagation();
        drop.classList.toggle('open');
        if (drop.classList.contains('open')) {
          localStorage.setItem('apra_notif_seen', new Date().toISOString());
          bell.classList.remove('has-unread');
        }
      });
      document.addEventListener('click', function () { drop.classList.remove('open'); });
    }
  });
})();
