/* ============================================================
   APRABot dashboard — Scenarios (run / revision history / approve / compare)
   Talks to the Cognito-authenticated /scenarios API.
============================================================ */
(function () {
  'use strict';

  var SCENARIOS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var pollTimer = null;
  var lastScenarios = [];
  var lastApprovals = [];
  var SCENARIOS_PAGE_SIZE = 10;
  var scenariosPage = 1; // 1-indexed; client-side only — /scenarios always returns the full list
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
    lastScenarios = scenarios; // full list — compare/labelFor/notifications/etc. all need every scenario, not just the visible page
    var body = document.getElementById('scenariosBody');
    var empty = document.getElementById('scenariosEmpty');
    if (!body) return;

    if (!scenarios.length) {
      body.innerHTML = '';
      if (empty) empty.style.display = '';
      renderScenariosPagination(0, 1);
      return;
    }
    if (empty) empty.style.display = 'none';

    var totalPages = Math.max(1, Math.ceil(scenarios.length / SCENARIOS_PAGE_SIZE));
    if (scenariosPage > totalPages) scenariosPage = totalPages; // clamp — e.g. the list shrank, or a prior scenario was pruned
    if (scenariosPage < 1) scenariosPage = 1;
    var pageItems = scenarios.slice((scenariosPage - 1) * SCENARIOS_PAGE_SIZE, scenariosPage * SCENARIOS_PAGE_SIZE);

    body.innerHTML = pageItems.map(function (s) {
      var canCompare = s.status === 'completed';
      var checked = selectedForCompare.indexOf(s.id) > -1 ? 'checked' : '';
      var approveBtn = (s.status === 'completed' && !s.approved)
        ? '<button class="dbtn" style="padding:6px 12px;font-size:12px" onclick="event.stopPropagation();approveScenario(\'' + s.id + '\', this)">Approve</button>'
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
    renderScenariosPagination(scenarios.length, totalPages);
  }

  // Prev/Next + "Page X of Y · N scenarios total" — hidden entirely when
  // everything fits on one page, so a small list looks exactly like it did
  // before pagination existed.
  function renderScenariosPagination(totalCount, totalPages) {
    var bar = document.getElementById('scenariosPagination');
    if (!bar) return;
    if (totalPages <= 1) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML =
      '<button type="button" class="dbtn" id="scenariosPrevBtn" style="padding:6px 12px;font-size:12.5px;' +
      'background:var(--ink-3);color:var(--text);border:1px solid var(--line-2)"' +
      (scenariosPage <= 1 ? ' disabled' : '') + '>← Prev</button>' +
      '<span class="dsubtle" style="margin:0;font-size:12.5px">Page ' + scenariosPage + ' of ' + totalPages +
      ' · ' + totalCount.toLocaleString() + ' scenario' + (totalCount === 1 ? '' : 's') + ' total</span>' +
      '<button type="button" class="dbtn" id="scenariosNextBtn" style="padding:6px 12px;font-size:12.5px;' +
      'background:var(--ink-3);color:var(--text);border:1px solid var(--line-2)"' +
      (scenariosPage >= totalPages ? ' disabled' : '') + '>Next →</button>';
    var prevBtn = document.getElementById('scenariosPrevBtn');
    var nextBtn = document.getElementById('scenariosNextBtn');
    if (prevBtn) prevBtn.onclick = function () { scenariosPage--; render(lastScenarios); };
    if (nextBtn) nextBtn.onclick = function () { scenariosPage++; render(lastScenarios); };
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

  /* ── Approval audit trail (who approved which scenario, when, and what
     it replaced) — append-only in the backend (scenarios/approval_log.json),
     so a scenario that was approved and later superseded keeps its history.
     Previously rendered as its own standalone "Approval history" table
     covering every scenario at once; now just cached here and rendered
     per-scenario, inline inside that scenario's own detail view (see
     approvalsFor() / renderScenarioDetail's "Approval audit" card below) —
     one scenario's approve/replace story belongs with that scenario, not in
     a separate list you have to cross-reference by name. ── */
  function fmtAbsolute(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function labelFor(id) {
    if (!id) return null;
    var s = lastScenarios.find(function (x) { return x.id === id; });
    return s ? (s.label || 'Untitled') : id; // fall back to the raw id if it's since been pruned from the list
  }

  // This scenario's own approval entries, most-recent first (the backend
  // already sorts the full log that way) — usually zero or one, but more
  // than one if it was approved, superseded, then approved again later.
  function approvalsFor(scenarioId) {
    return lastApprovals.filter(function (e) { return e.scenario_id === scenarioId; });
  }

  function loadApprovals() {
    return fetch(SCENARIOS_API + '/approvals', { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) { lastApprovals = d.approvals || []; })
      .catch(function () { /* leave cache as-is on transient error */ });
  }

  window.refreshScenarios = function (btn) {
    var icon = btn && btn.querySelector('svg');
    if (icon) icon.classList.add('spin');
    Promise.all([loadScenarios(), loadApprovals()]).then(function () {
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
      if (typeof loadForecast === 'function') loadForecast(true);
    }
    try { localStorage.setItem(APPROVED_ID_KEY, approvedId || ''); } catch (e) {}
  }

  // Best-effort decode of the current user's email out of the Cognito ID
  // token — same base64url-JWT decode already used inline in
  // dashboard/index.html, just scoped here so checkRunCompletion can tell
  // "my own run" from anyone else's without a network round-trip.
  function currentUserEmail() {
    try {
      var t = localStorage.getItem('apra_id');
      if (!t) return null;
      var payload = JSON.parse(decodeURIComponent(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        .split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')));
      return payload.email || null;
    } catch (e) { return null; }
  }

  // Celebrates a scenario of the user's OWN flipping running → completed
  // between one render and the next — catches both a run Lyra started via
  // chat and one started through the "Run new forecast" modal, since both
  // go through the same /scenarios POST and there's no separate marker for
  // which one kicked it off. Compares against the PREVIOUS render's
  // snapshot, so this only fires for a transition actually watched happen
  // in this tab (a scenario that was already completed on first load never
  // triggers it — prev starts as [], so nothing was "running" yet).
  function checkRunCompletion(prev, next) {
    var email = currentUserEmail();
    if (!email) return;
    var wasRunning = {};
    prev.forEach(function (s) { if (s.status === 'running' && s.requested_by === email) wasRunning[s.id] = true; });
    if (!Object.keys(wasRunning).length) return;
    var justCompleted = next.some(function (s) { return wasRunning[s.id] && s.status === 'completed'; });
    if (justCompleted && typeof window.cbCelebrate === 'function') window.cbCelebrate();
  }

  var _origRender = render;
  render = function (scenarios) {
    var prevScenarios = lastScenarios; // capture before _origRender overwrites it
    _origRender(scenarios);
    ensurePolling();
    renderNotifications(scenarios);
    checkApprovalChange(scenarios);
    checkRunCompletion(prevScenarios, scenarios);
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
        scenariosPage = 1; // jump back to the top page so the just-started run is visible right away
        loadScenarios();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Start run →';
        errEl.textContent = err.message || 'Connection error — please try again.';
      });
  };

  /* ── Approve ── */
  var SPINNER_SVG = '<svg class="spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">' +
    '<path d="M21 12a9 9 0 1 1-2.64-6.36" stroke-linecap="round"/></svg>';

  // btn is optional (the row's inline Approve button, or the detail modal's) —
  // when given, it's disabled and shown a spinner for the ~2s round-trip
  // (the approve call itself, plus the scenario-list refresh so the button
  // doesn't flash back to "Approve" for an instant before the row updates).
  // Rejects on failure (restoring the button) so callers like the detail
  // modal can chain .then(closeScenarioDetail) and only close on success.
  window.approveScenario = function (id, btn) {
    var origHtml = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = SPINNER_SVG; }

    return fetch(SCENARIOS_API + '/' + id + '/approve', {
      method: 'POST',
      headers: authHeaders(),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('approve failed');
        return loadScenarios();
      })
      .then(function () {
        return loadApprovals(); // pick up the new audit entry the approve call just wrote
      })
      .then(function () {
        try { localStorage.removeItem('apra_forecast_cache'); } catch (e) {}
        if (typeof loadForecast === 'function') loadForecast(true); // refresh Overview/Forecasts with the newly-approved data
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
        throw err;
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

    var wapeTied = results[0].overallWape === results[1].overallWape;
    var betterIdx = wapeTied ? -1 : (results[0].overallWape < results[1].overallWape ? 0 : 1);

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
        var pill = wapeTied
          ? ' <span class="pill" style="margin-left:4px;color:var(--muted);border-color:var(--line-2);background:var(--ink-3)">Same WAPE</span>'
          : (i === betterIdx ? ' <span class="pill ok" style="margin-left:4px">Lower WAPE</span>' : '');
        return '<div style="font-weight:700;padding-bottom:10px;border-bottom:2px solid ' +
          (i === betterIdx ? 'var(--signal)' : 'var(--line)') + '">' + escapeHtml(m.label) + pill + '</div>';
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
  var SD_CLOSE_BTN = '<button class="x" onclick="closeScenarioDetail()" aria-label="Close">×</button>';
  // Shown immediately on open, before the result fetch resolves — mirrors
  // the shape of the real content (see renderScenarioDetail) using the
  // dashboard's shimmer classes, rather than a bare "Loading…" line.
  var SD_SKELETON_HEAD = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
    '<div style="min-width:0"><span class="skel-line title" style="margin-bottom:10px"></span>' +
    '<span class="skel" style="width:84px;height:20px;border-radius:100px"></span></div>' +
    '<div style="display:flex;align-items:center;gap:8px;flex:none">' + SD_CLOSE_BTN + '</div></div>';
  var SD_SKELETON_BODY = '<div class="kpis" style="margin-bottom:20px">' +
    ['Overall WAPE', 'Volume error', 'SKUs', 'Weeks'].map(function (t) {
      return '<div class="kpi"><div class="t">' + t + '</div><div class="v"><span class="skel"></span></div></div>';
    }).join('') + '</div>' +
    '<div class="dcard" style="padding:16px"><div class="ch"><h4><span class="skel-line title"></span></h4></div>' +
    '<div class="dchart" style="height:200px"><div class="chart-skel">' +
    '<i style="height:45%"></i><i style="height:62%"></i><i style="height:38%"></i><i style="height:70%"></i>' +
    '<i style="height:55%"></i><i style="height:80%"></i><i style="height:50%"></i><i style="height:65%"></i>' +
    '</div></div></div>' +
    '<div class="dcard" style="margin-top:16px;padding:16px"><div class="ch"><h4>Top SKUs by volume</h4></div>' +
    '<table class="dtable"><tbody>' +
    [1, 2, 3, 4].map(function () {
      return '<tr class="skel-row"><td><span class="skel-line"></span></td><td><span class="skel-line"></span></td><td><span class="skel-line"></span></td></tr>';
    }).join('') + '</tbody></table></div>';

  window.viewScenario = function (id) {
    var meta = lastScenarios.find(function (s) { return s.id === id; });
    if (!meta) return;
    var head = document.getElementById('scenarioDetailHead');
    var body = document.getElementById('scenarioDetailBody');
    head.innerHTML = SD_SKELETON_HEAD;
    body.innerHTML = SD_SKELETON_BODY;
    document.getElementById('scenarioDetailModal').classList.add('open');
    var closeBtn = head.querySelector('.x');
    if (closeBtn) closeBtn.focus();

    if (meta.status !== 'completed') {
      renderScenarioDetail(meta, null);
      return;
    }
    fetch(SCENARIOS_API + '/' + id + '/result', { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (result) { renderScenarioDetail(meta, result); })
      .catch(function () {
        head.innerHTML = SD_CLOSE_BTN;
        body.innerHTML = '<p class="auth-error">Could not load this scenario\'s result.</p>';
      });
  };
  window.closeScenarioDetail = function () {
    document.getElementById('scenarioDetailModal').classList.remove('open');
  };

  // Escape closes whichever scenario modal is open — same behavior the
  // login modal already has, extended to these two.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var sd = document.getElementById('scenarioDetailModal');
    var cmp = document.getElementById('compareModal');
    if (sd && sd.classList.contains('open')) { window.closeScenarioDetail(); return; }
    if (cmp && cmp.classList.contains('open')) { window.closeCompareModal(); }
  });

  function renderScenarioDetail(meta, result) {
    var head = document.getElementById('scenarioDetailHead');
    var body = document.getElementById('scenarioDetailBody');

    var approveBtn = (meta.status === 'completed' && !meta.approved)
      ? '<button class="dbtn" onclick="approveScenario(\'' + meta.id + '\', this).then(closeScenarioDetail)">Approve</button>'
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

    // Validations are pure, instant analysis of data already on the page —
    // computed up front so their pass/warn/fail state is visible at a
    // glance next to the status pill, with no click required first.
    // Clicking the pill expands the full checklist into the body below.
    var checks = result ? runDataValidations(meta, result) : null;
    var validationsPill = '';
    if (checks) {
      var vc = { fail: 0, warn: 0, pass: 0 };
      checks.forEach(function (c) { vc[c.status]++; });
      var vcls = vc.fail ? 'risk' : vc.warn ? 'warn' : 'ok';
      var vlabel = vc.fail ? vc.fail + ' validation issue' + (vc.fail > 1 ? 's' : '')
        : vc.warn ? vc.warn + ' validation warning' + (vc.warn > 1 ? 's' : '')
        : 'Validations passed';
      validationsPill = '<button type="button" class="pill pill-btn ' + vcls + '" id="sdValidateBtn">' + vlabel + '</button>';
    }

    var headHtml = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="min-width:0"><h3 style="margin-bottom:8px">' + escapeHtml(meta.label || 'Untitled') + '</h3>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + statusPill(meta) + validationsPill + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex:none">' + inputBtn +
      (result ? '<span id="sdSpeakSlot"></span>' : '') + approveBtn + SD_CLOSE_BTN + '</div>' +
      '</div>';

    headHtml += '<div class="dsubtle" style="margin:14px 0 0">' +
      'Requested by ' + escapeHtml((meta.requested_by || '').split('@')[0]) +
      ' · Created ' + fmtRelative(meta.created_at) +
      (meta.completed_at ? ' · Completed ' + fmtRelative(meta.completed_at) : '') +
      ' · Config: ' + configDescription(meta) +
      '</div>';

    if (meta.approved) {
      headHtml += '<div style="margin-top:12px;padding:9px 14px;border-radius:9px;background:var(--signal-soft);' +
        'border:1px solid rgba(200,242,78,.25);color:var(--signal);font-size:12.5px;display:flex;align-items:center;gap:8px">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" style="flex:none"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span>This scenario is approved and currently powers the live Overview &amp; Forecasts data.</span></div>';
    }
    head.innerHTML = headHtml;

    if (result) {
      var speakSlot = document.getElementById('sdSpeakSlot');
      if (speakSlot && typeof window.cbSpeakBtn === 'function') {
        var speakBtn = window.cbSpeakBtn(narrateScenario(meta, result, checks));
        if (speakBtn) speakSlot.appendChild(speakBtn);
      }
    }

    if (meta.status === 'running') {
      body.innerHTML = '<p class="dsubtle">Still training — this view will show results once it completes. Close and reopen in a minute.</p>';
      return;
    }
    if (meta.status === 'failed') {
      body.innerHTML = '<p class="auth-error">' + escapeHtml(meta.error || 'Run failed.') + '</p>';
      return;
    }
    if (!result) {
      body.innerHTML = '<p class="dsubtle">No result available.</p>';
      return;
    }

    var bodyHtml = '<div class="kpis" style="margin-bottom:20px">' +
      '<div class="kpi"><div class="t">Overall WAPE</div><div class="v">' + result.overallWape.toFixed(2) + '%</div></div>' +
      '<div class="kpi"><div class="t">Volume error</div><div class="v">' + (meta.volume_error > 0 ? '+' : '') + (meta.volume_error != null ? meta.volume_error.toFixed(2) : '0') + '%</div></div>' +
      '<div class="kpi"><div class="t">SKUs</div><div class="v">' + Object.keys(result.skus).length + '</div></div>' +
      '<div class="kpi"><div class="t">Weeks</div><div class="v">' + result.weeks.length + '</div></div>' +
      '</div>';

    bodyHtml += '<div class="dcard" style="padding:16px">' +
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

    bodyHtml += '<div class="dcard" style="margin-top:16px;padding:16px">' +
      '<div class="ch"><h4>Top SKUs by volume</h4></div>' +
      '<div class="table-wrap"><table class="dtable"><thead><tr><th>SKU</th><th>Units</th><th>WAPE</th></tr></thead><tbody>' +
      topSkus.map(function (r) {
        return '<tr><td class="skucell">' + r.id + '</td><td>' + r.vol.toLocaleString() + '</td><td>' + r.wape.toFixed(1) + '%</td></tr>';
      }).join('') +
      '</tbody></table></div></div>';

    // This scenario's own approve/replace history — folded in here instead
    // of a separate cross-scenario table (see approvalsFor()'s comment).
    // Usually empty (never approved) or one entry; more than one only if it
    // was approved, later superseded, then approved again.
    var approvalEntries = approvalsFor(meta.id);
    if (approvalEntries.length) {
      bodyHtml += '<div class="dcard" style="margin-top:16px;padding:16px">' +
        '<div class="ch"><h4>Approval audit</h4>' +
        '<span class="dsubtle" style="margin:0;font-size:.8rem">who approved this run, and what it replaced</span></div>' +
        '<div class="table-wrap"><table class="dtable"><thead><tr>' +
        '<th>Approved by</th><th>When</th><th>Replaced</th><th>WAPE</th><th>Volume error</th>' +
        '</tr></thead><tbody>' +
        approvalEntries.map(function (e) {
          var replaced = e.replaced_scenario_id
            ? escapeHtml(labelFor(e.replaced_scenario_id) || e.replaced_scenario_id)
            : '<span class="dsubtle" style="margin:0">— (first approval)</span>';
          return '<tr>' +
            '<td class="dsubtle" style="margin:0">' + escapeHtml((e.approved_by || 'unknown').split('@')[0]) + '</td>' +
            '<td class="dsubtle" style="margin:0" title="' + escapeHtml(e.approved_at || '') + '">' + fmtAbsolute(e.approved_at) + '</td>' +
            '<td class="dsubtle" style="margin:0">' + replaced + '</td>' +
            '<td>' + (e.wape != null ? e.wape.toFixed(2) + '%' : '—') + '</td>' +
            '<td>' + (e.volume_error != null ? (e.volume_error > 0 ? '+' : '') + e.volume_error.toFixed(2) + '%' : '—') + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div></div>';
    }

    // Filled in when the validations pill above is clicked — its checklist
    // is already computed (checks), so this is just a render, not a re-run.
    bodyHtml += '<div id="sdValidations"></div>';

    body.innerHTML = bodyHtml;
    drawScenarioChart(result.weeks, result.all.a, result.all.f, result.backtestWeeks);
    wireLegend(document.getElementById('sdLegend'), sdVisible, function () {
      drawScenarioChart(result.weeks, result.all.a, result.all.f, result.backtestWeeks);
    });

    var validateBtn = document.getElementById('sdValidateBtn');
    if (validateBtn) {
      validateBtn.onclick = function () {
        var wrap = document.getElementById('sdValidations');
        wrap.innerHTML = renderValidations(checks);
        wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    }
  }

  /* ── Data validations — a fixed set of basic sanity/QA checks run
     client-side against a scenario's already-loaded result JSON. Nothing
     here calls the backend; it's pure analysis of data already on the
     page, triggered on demand from the "Run validations" button. ── */
  function runDataValidations(meta, result) {
    var checks = [];
    var add = function (name, status, detail) { checks.push({ name: name, status: status, detail: detail }); };

    var weeks = result.weeks || [], all = result.all || { a: [], f: [] }, skus = result.skus || {};
    var bw = result.backtestWeeks != null ? result.backtestWeeks : weeks.length;
    var skuIds = Object.keys(skus);

    // 1. Negative units — shipped-unit forecasts/actuals should never be negative.
    var negCount = 0, negSkus = {};
    skuIds.forEach(function (id) {
      (skus[id].f || []).concat(skus[id].a || []).forEach(function (v) {
        if (v != null && v < 0) { negCount++; negSkus[id] = 1; }
      });
    });
    add('No negative unit values', negCount ? 'fail' : 'pass',
      negCount ? negCount + ' negative value(s) across ' + Object.keys(negSkus).length + ' SKU(s).' : 'All actual and forecast values are ≥ 0.');

    // 2. Non-finite values (NaN / Infinity) — would silently break charts/KPIs downstream.
    var badCount = 0;
    skuIds.forEach(function (id) {
      (skus[id].f || []).concat(skus[id].a || []).forEach(function (v) {
        if (v != null && !isFinite(v)) badCount++;
      });
    });
    add('No NaN / infinite values', badCount ? 'fail' : 'pass',
      badCount ? badCount + ' non-finite value(s) found in the result data.' : 'All actual and forecast values are finite numbers.');

    // 3. Weekly date continuity — every week should be exactly 7 days after the last.
    var gapIssues = 0;
    for (var i = 1; i < weeks.length; i++) {
      var diffDays = Math.round((new Date(weeks[i]) - new Date(weeks[i - 1])) / 86400000);
      if (diffDays !== 7) gapIssues++;
    }
    add('Weekly date continuity', gapIssues ? 'warn' : 'pass',
      gapIssues ? gapIssues + ' week-to-week gap(s) are not exactly 7 days apart.' : 'All ' + weeks.length + ' weeks are evenly spaced 7 days apart.');

    // 4. Per-SKU actuals should sum to the aggregate — catches a SKU dropped
    // (or double-counted) between the per-SKU and all-SKU series.
    var sumSkuA = 0;
    skuIds.forEach(function (id) {
      (skus[id].a || []).slice(0, bw).forEach(function (v) { if (v != null) sumSkuA += v; });
    });
    var sumAllA = (all.a || []).slice(0, bw).reduce(function (s, v) { return s + (v || 0); }, 0);
    var diffPct = sumAllA ? Math.abs(sumSkuA - sumAllA) / sumAllA * 100 : 0;
    add('SKU totals reconcile with the all-SKU aggregate', diffPct > 1 ? 'warn' : 'pass',
      'Per-SKU actuals sum to ' + Math.round(sumSkuA).toLocaleString() + ' vs. aggregate ' + Math.round(sumAllA).toLocaleString() +
      ' (' + diffPct.toFixed(2) + '% difference).');

    // 5. Per-SKU WAPE outliers — SKUs scoring far worse than the overall number.
    var overall = result.overallWape || 0;
    var outliers = [];
    skuIds.forEach(function (id) {
      var o = skus[id], vol = 0, num = 0;
      (o.a || []).forEach(function (x, i) { if (x == null) return; vol += x; num += Math.abs(x - (o.f[i] || 0)); });
      if (!vol) return;
      var wape = 100 * num / vol;
      if (wape > Math.max(75, overall * 2)) outliers.push(id + ' (' + wape.toFixed(0) + '%)');
    });
    add('No extreme per-SKU WAPE outliers', outliers.length ? 'warn' : 'pass',
      outliers.length
        ? outliers.length + ' SKU(s) scoring far above the ' + overall.toFixed(1) + '% overall WAPE: ' + outliers.slice(0, 6).join(', ') + (outliers.length > 6 ? '…' : '')
        : 'No SKU’s WAPE is far above the ' + overall.toFixed(1) + '% overall.');

    // 6. SKUs with real history that collapse to a zero forward forecast.
    var zeroFwd = [];
    skuIds.forEach(function (id) {
      var o = skus[id];
      var histVol = (o.a || []).slice(0, bw).reduce(function (s, v) { return s + (v || 0); }, 0);
      var fwd = (o.f || []).slice(bw);
      var fwdSum = fwd.reduce(function (s, v) { return s + (v || 0); }, 0);
      if (histVol > 0 && fwd.length && fwdSum === 0) zeroFwd.push(id);
    });
    add('No SKU collapses to a zero forward forecast', zeroFwd.length ? 'warn' : 'pass',
      zeroFwd.length
        ? zeroFwd.length + ' SKU(s) had real volume but forecast 0 units for the entire forward horizon: ' + zeroFwd.slice(0, 6).join(', ') + (zeroFwd.length > 6 ? '…' : '')
        : 'Every SKU with historical volume has a non-zero forward forecast.');

    // 7. Abrupt week-over-week swings in the aggregate forward forecast.
    var fwdAll = (all.f || []).slice(bw);
    var spikes = 0;
    for (var j = 1; j < fwdAll.length; j++) {
      var p = fwdAll[j - 1], c = fwdAll[j];
      if (p > 0 && c != null && (c / p > 3 || c / p < 0.33)) spikes++;
    }
    add('No abrupt week-over-week jumps in the forward forecast', spikes ? 'warn' : 'pass',
      spikes ? spikes + ' week-to-week swing(s) of 3x or more in the aggregate forward forecast.' : 'The aggregate forward forecast moves smoothly week to week.');

    // 8. Overall volume error within a sane range.
    var ve = meta.volume_error;
    add('Overall volume error within a sane range', (ve != null && Math.abs(ve) > 20) ? 'warn' : 'pass',
      ve != null ? 'Volume error is ' + (ve > 0 ? '+' : '') + ve.toFixed(2) + '%.' : 'No volume error recorded for this scenario.');

    return checks;
  }

  function renderValidations(checks) {
    var order = { fail: 0, warn: 1, pass: 2 };
    var sorted = checks.slice().sort(function (a, b) { return order[a.status] - order[b.status]; });
    var counts = { fail: 0, warn: 0, pass: 0 };
    checks.forEach(function (c) { counts[c.status]++; });

    var icon = {
      pass: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      warn: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      fail: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round"/></svg>',
    };
    var cls = { pass: 'ok', warn: 'warn', fail: 'risk' };
    var summaryLabel = counts.fail ? counts.fail + ' failed'
      : counts.warn ? counts.warn + ' warning' + (counts.warn > 1 ? 's' : '')
      : 'All checks passed';

    return '<div class="dcard" style="margin-top:16px;padding:16px">' +
      '<div class="ch"><h4>Data validations</h4><span class="pill ' + cls[counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass'] + '">' + summaryLabel + '</span></div>' +
      '<ul class="val-list">' +
      sorted.map(function (c) {
        return '<li><span class="val-icon ' + cls[c.status] + '">' + icon[c.status] + '</span>' +
          '<div><div class="val-name">' + escapeHtml(c.name) + '</div>' +
          '<div class="val-detail">' + escapeHtml(c.detail) + '</div></div></li>';
      }).join('') +
      '</ul></div>';
  }

  // Plain-text narration for the scenario detail modal's "read summary
  // aloud" button — checks is runDataValidations' output, already
  // computed once for the validations pill, reused here rather than
  // re-run.
  function narrateScenario(meta, result, checks) {
    var parts = [(meta.label || 'Untitled scenario') + '.'];
    parts.push('Overall WAPE ' + result.overallWape.toFixed(2) + ' percent.');
    if (meta.volume_error != null) {
      parts.push('Volume error ' + (meta.volume_error > 0 ? '+' : '') + meta.volume_error.toFixed(2) + ' percent.');
    }
    parts.push(Object.keys(result.skus).length + ' SKUs over ' + result.weeks.length + ' weeks.');
    if (checks) {
      var vc = { fail: 0, warn: 0, pass: 0 };
      checks.forEach(function (c) { vc[c.status]++; });
      parts.push(vc.fail ? vc.fail + ' validation issue' + (vc.fail > 1 ? 's' : '') + '.'
        : vc.warn ? vc.warn + ' validation warning' + (vc.warn > 1 ? 's' : '') + '.'
        : 'All validations passed.');
    }
    if (meta.approved) parts.push('This scenario is currently live.');
    return parts.join(' ');
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
    // Sequenced (not parallel): labelFor() (used when a scenario detail's
    // Approval audit card renders a "Replaced" cell) looks up labels from
    // lastScenarios, which loadScenarios() is what populates — firing both
    // at once risks a detail view opened right after load showing a raw id
    // instead of a label the first time.
    loadScenarios().then(loadApprovals);

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
