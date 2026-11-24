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
  // Defaults true so nothing changes for an org that hasn't set up roles
  // yet (matches the backend's own default-permissive behavior) — set for
  // real from GET /scenarios's own you_are_admin field in loadScenarios().
  var isAdmin = true;
  var SCENARIOS_PAGE_SIZE = 10;
  var scenariosPage = 1; // 1-indexed; client-side only — /scenarios always returns the full list
  var scenariosSearch = '';        // lowercased, matched against label + requested_by
  var scenariosStatusFilter = 'all'; // 'all' | 'approved' | 'completed' | 'running' | 'failed'
  var selectedForCompare = [];
  var sdVisible = { a: true, f: true };
  var cmpVisible = { a: true, fA: true, fB: true };
  var cmpZoom = null;       // {start, end} week-index range (inclusive) into the full series, or null = full range
  var cmpLastRender = null; // {X, N0, dataLen} from the most recent drawCompareChart call, for hit-testing drags
  var lastCompare = null;   // {metas, results, totals, forward, fwdDelta} from the most recent renderCompare, for .xlsx export
  var cmpMaximized = false;
  var cmpRedraw = null;     // current redrawCmp closure, so toggling maximize can redraw the chart at its new size

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
    var levers = s.levers || {};
    if (Number.isFinite(levers.spend_pct)) parts.push('spend ' + levers.spend_pct + '%');
    if (Number.isFinite(levers.price_pct)) {
      var targets = [levers.price_sku, levers.price_postal_code, levers.price_target].filter(Boolean);
      parts.push('price ' + levers.price_pct + '%' + (targets.length ? ' (' + targets.join(', ') + ')' : ''));
    }
    if (Number.isFinite(levers.unit_cap)) parts.push('weekly cap ' + levers.unit_cap.toLocaleString());
    if (levers.holiday_off) parts.push('forward holiday effects off');
    if (levers.excluded_holiday_dates?.length) parts.push(levers.excluded_holiday_dates.length + ' holidays excluded');
    if (levers.excluded_schemes && levers.excluded_schemes.length) parts.push(levers.excluded_schemes.length + ' schemes excluded');
    if (levers.included_schemes && levers.included_schemes.length) parts.push('saved scheme' + (levers.included_schemes.length === 1 ? ' ' : 's ') + levers.included_schemes.join(', '));
    return parts.join(', ');
  }

  function statusPill(s) {
    if (s.approved) return '<span class="pill ok">Approved</span>';
    if (s.status === 'running') return '<span class="pill warn">Running…</span>';
    if (s.status === 'failed') return '<span class="pill risk">Failed</span>';
    return '<span class="pill" style="color:var(--muted);border-color:var(--line-2);background:var(--ink-3)">Completed</span>';
  }

  // Status-filter predicate — 'completed' means "completed but not (yet)
  // approved" so it's mutually exclusive with 'approved' (matching the
  // distinct pills statusPill() shows: a completed+approved scenario always
  // reads "Approved", never "Completed").
  function matchesStatusFilter(s) {
    switch (scenariosStatusFilter) {
      case 'approved':  return !!s.approved;
      case 'completed': return s.status === 'completed' && !s.approved;
      case 'running':   return s.status === 'running';
      case 'failed':    return s.status === 'failed';
      default:          return true; // 'all'
    }
  }

  function matchesScenariosSearch(s) {
    if (!scenariosSearch) return true;
    var hay = ((s.label || '') + ' ' + (s.requested_by || '')).toLowerCase();
    return hay.indexOf(scenariosSearch) > -1;
  }

  function render(scenarios) {
    lastScenarios = scenarios; // full, UNFILTERED list — compare/labelFor/notifications/etc. all need every scenario, not just the visible/filtered page
    var body = document.getElementById('scenariosBody');
    var empty = document.getElementById('scenariosEmpty');
    var noMatch = document.getElementById('scenariosNoMatch');
    if (!body) return;

    if (!scenarios.length) {
      body.innerHTML = '';
      if (empty) empty.style.display = '';
      if (noMatch) noMatch.style.display = 'none';
      renderScenariosPagination(0, 1);
      return;
    }
    if (empty) empty.style.display = 'none';

    var filtered = scenarios.filter(function (s) { return matchesStatusFilter(s) && matchesScenariosSearch(s); });

    if (!filtered.length) {
      body.innerHTML = '';
      if (noMatch) noMatch.style.display = '';
      renderScenariosPagination(0, 1);
      return;
    }
    if (noMatch) noMatch.style.display = 'none';

    var totalPages = Math.max(1, Math.ceil(filtered.length / SCENARIOS_PAGE_SIZE));
    if (scenariosPage > totalPages) scenariosPage = totalPages; // clamp — e.g. a filter narrowed the list, or it shrank
    if (scenariosPage < 1) scenariosPage = 1;
    var pageItems = filtered.slice((scenariosPage - 1) * SCENARIOS_PAGE_SIZE, scenariosPage * SCENARIOS_PAGE_SIZE);

    body.innerHTML = pageItems.map(function (s) {
      var canCompare = s.status === 'completed';
      var checked = selectedForCompare.indexOf(s.id) > -1 ? 'checked' : '';
      var approveBtn = (s.status === 'completed' && !s.approved && isAdmin)
        ? '<button class="dbtn" style="padding:6px 12px;font-size:12px" onclick="event.stopPropagation();approveScenario(\'' + s.id + '\', this).catch(function(err){alert(err.message);})">Approve</button>'
        : (s.status === 'completed' && !s.approved
            ? '<span class="dsubtle" style="margin:0;font-size:11.5px" title="Only an admin for your organization can approve a forecast">Viewer</span>'
            : '');
      var baselineBtn = canCompare && !s.approved
        ? '<button type="button" class="dbtn" style="padding:6px 12px;font-size:12px" onclick="event.stopPropagation();compareWithApproved(this.dataset.id)" data-id="' + s.id + '">Compare with approved</button>'
        : '';
      return '<tr onclick="viewScenario(\'' + s.id + '\')" style="cursor:pointer">' +
        '<td>' + (canCompare ? '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation()" onchange="toggleCompareSelect(\'' + s.id + '\',this.checked)">' : '') + '</td>' +
        '<td style="font-weight:600">' + escapeHtml(s.label || 'Untitled') + '</td>' +
        '<td class="dsubtle" style="margin:0">' + escapeHtml((s.requested_by || '').split('@')[0]) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + escapeHtml(configDescription(s)) + '</td>' +
        '<td>' + (s.wape != null ? s.wape.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + (s.volume_error != null ? (s.volume_error > 0 ? '+' : '') + s.volume_error.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + statusPill(s) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + fmtRelative(s.created_at) + '</td>' +
        '<td>' + approveBtn + baselineBtn + '</td>' +
        '</tr>';
    }).join('');

    updateCompareBtn();
    renderScenariosPagination(filtered.length, totalPages);
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
    return APRA_SESSION.fetch(SCENARIOS_API)
      .then(function (r) {
        if (!r.ok) throw new Error('Could not load scenario settings.');
        return r.json();
      })
      .then(function (d) {
        syncScenarioCapabilities(d.scenario_levers === true);
        isAdmin = d.you_are_admin !== false; // absent (old cache/error shape) -> stay permissive
        render(d.scenarios || []);
      })
      .catch(function () {
        var status = scenarioElement('scenarioLeverAvailability');
        if (status && !scenarioLeverSupport) status.textContent = 'Could not verify scenario settings. Refresh the dashboard before running with levers.';
      });
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
    return APRA_SESSION.fetch(SCENARIOS_API + '/approvals')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        lastApprovals = d.approvals || [];
        if (typeof window.renderOrgApprovals === 'function') window.renderOrgApprovals();
      })
      .catch(function () { /* leave cache as-is on transient error */ });
  }

  // Scenarios > Approval history card — the org-wide cross-scenario view
  // the comment above originally said was dropped in favor of a per-
  // scenario-only one. Brought back for activity/trust visibility (who's
  // approving what), living in Scenarios rather than Settings since that's
  // where the rest of this data already lives. No new fetch — reuses
  // lastApprovals, already populated by loadApprovals() on page load;
  // just re-renders whenever Scenarios' own render() runs.
  window.renderOrgApprovals = function () {
    var body = document.getElementById('orgApprovalsBody');
    if (!body) return;
    if (!lastApprovals.length) {
      body.innerHTML = '<tr><td colspan="6" class="dsubtle">No scenarios approved yet.</td></tr>';
      return;
    }
    body.innerHTML = lastApprovals.map(function (e) {
      var replaced = e.replaced_scenario_id
        ? escapeHtml(labelFor(e.replaced_scenario_id) || e.replaced_scenario_id)
        : '<span class="dsubtle" style="margin:0">— (first approval)</span>';
      // e.label is the backend's own snapshot captured at approval time —
      // preferred over labelFor(e.scenario_id) (an on-the-fly lookup into
      // lastScenarios) since it stays correct even for a scenario that's
      // since aged out of that list.
      return '<tr>' +
        '<td style="font-weight:600">' + escapeHtml(e.label || labelFor(e.scenario_id) || e.scenario_id) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + escapeHtml((e.approved_by || 'unknown').split('@')[0]) + '</td>' +
        '<td class="dsubtle" style="margin:0" title="' + escapeHtml(e.approved_at || '') + '">' + fmtAbsolute(e.approved_at) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + replaced + '</td>' +
        '<td>' + (e.wape != null ? e.wape.toFixed(2) + '%' : '—') + '</td>' +
        '<td>' + (e.volume_error != null ? (e.volume_error > 0 ? '+' : '') + e.volume_error.toFixed(2) + '%' : '—') + '</td>' +
        '</tr>';
    }).join('');
  };

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
      if (typeof window.invalidateInsights === 'function') window.invalidateInsights();
      if (typeof window.invalidateInventory === 'function') window.invalidateInventory();
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
    syncScenarioWorkspace(scenarios);
    renderLastRun(scenarios);
  };

  // "Last run" card at the top of the Scenario workspace: the most recently
  // started scenario, its status (live while running — the list re-polls
  // every 8s then), its accuracy once it completes or its error if it
  // failed, and shortcuts to compare it with the approved plan or open its
  // details. Built from the scenario list this page already loads; the
  // container is created here so the page markup doesn't need to change.
  function renderLastRun(scenarios) {
    var workspace = scenarioElement('scenarioWorkspace');
    if (!workspace) return;
    var box = document.getElementById('scenarioLastRun');
    if (!box) {
      box = document.createElement('div');
      box.id = 'scenarioLastRun';
      box.className = 'scenario-last-run';
      box.setAttribute('aria-live', 'polite');
      var head = workspace.querySelector('.scenario-workspace-head');
      head.insertAdjacentElement('afterend', box);
      box.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-last-run-action]');
        if (!btn) return;
        if (btn.dataset.lastRunAction === 'compare') window.compareWithApproved(btn.dataset.id);
        else window.viewScenario(btn.dataset.id);
      });
    }
    var last = scenarios.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    })[0];
    if (!last) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.dataset.status = last.approved ? 'approved' : last.status || '';

    var who = (last.requested_by || '').split('@')[0];
    var meta = [who ? 'by ' + escapeHtml(who) : '', last.status === 'running' ? 'started ' + fmtRelative(last.created_at) : fmtRelative(last.created_at)]
      .filter(Boolean).join(' · ');
    var detail;
    if (last.status === 'running') {
      detail = '<span class="slr-running">' + SPINNER_SVG + ' Running — results usually arrive within a few minutes.</span>';
    } else if (last.status === 'failed') {
      detail = '<span class="slr-error">' + escapeHtml(last.error || 'The run failed.') + '</span>';
    } else {
      detail = '<span class="slr-metric">Backtest WAPE <b>' + (last.wape != null ? last.wape.toFixed(2) + '%' : '—') + '</b></span>' +
        '<span class="slr-metric">Volume error <b>' + (last.volume_error != null
          ? (last.volume_error > 0 ? '+' : '') + last.volume_error.toFixed(2) + '%' : '—') + '</b></span>' +
        (last.approved ? '<span class="slr-metric">This is the live forecast</span>' : '');
    }
    var comparing = workspaceRunId === last.id;
    var actions = '';
    if (last.status === 'completed' && !last.approved) {
      actions += '<button type="button" class="dbtn slr-btn" data-last-run-action="compare" data-id="' + escapeHtml(last.id) + '"' +
        (comparing ? ' disabled' : '') + '>' + (comparing ? 'Shown below' : 'Compare with approved') + '</button>';
    }
    actions += '<button type="button" class="dbtn slr-btn slr-ghost" data-last-run-action="view" data-id="' + escapeHtml(last.id) + '">View details</button>';

    box.innerHTML =
      '<div class="slr-main">' +
        '<div class="slr-kicker">Last run ' + statusPill(last) + '</div>' +
        '<div class="slr-title">' + escapeHtml(last.label || 'Untitled scenario') + '</div>' +
        '<div class="slr-meta" title="' + escapeHtml(fmtAbsolute(last.created_at)) + '">' + meta + '</div>' +
        '<div class="slr-config">' + escapeHtml(configDescription(last)) + '</div>' +
        '<div class="slr-detail">' + detail + '</div>' +
      '</div>' +
      '<div class="slr-actions">' + actions + '</div>';
  }

  var scenarioLeverSupport = false;
  var pendingScenarioChoices = {};
  var excludedHolidayDates = new Set();
  var excludedSchemes = new Set();  // committed schemes left out of the next run
  var includedSchemes = new Set();  // drafts applied to the next run only
  var committedSchemes = null;      // null until the registry has loaded
  var draftSchemes = [];
  var workspaceRunId = '';
  var workspaceChosen = false; // true once a run was picked or started; until then the latest one shows
  var workspaceComparisonKey = '';

  function scenarioElement(id) { return document.getElementById(id); }

  function syncScenarioCapabilities(supported) {
    var source = scenarioElement('rf-source');
    if (!source) return;
    var wasSupported = scenarioLeverSupport;
    scenarioLeverSupport = supported;
    source.options[0].disabled = !supported;
    if (supported && !wasSupported && source.value === 'default' && !source.dataset.edited) source.value = 'approved';
    if (!supported && source.value === 'approved') source.value = 'default';
    scenarioElement('scenarioLeverAvailability').textContent = supported
      ? '' : 'Advanced levers require the updated Forecast backend.';
  }

  var scenarioDraftFields = [
    'rf-label', 'rf-source', 'rf-spend', 'rf-campaign',
    'rf-cap', 'rf-price', 'rf-price-postal', 'rf-price-sku', 'rf-postal', 'rf-weather', 'rf-refresh',
  ];

  function draftKey() {
    var email = currentUserEmail();
    return email ? 'apra_scenario_draft:' + email : '';
  }

  function syncScenarioInput() {
    var source = scenarioElement('rf-source');
    var upload = scenarioElement('rf-upload-row');
    upload.hidden = source.value !== 'custom';
  }

  // Holiday dates the model uses (2021–2027), by the forecast's country —
  // the same calendars as lambda/scenario-runner/calendars.py and forecast.py.
  var japanHolidays = [
    ["2021-01-01", "元日"], ["2021-01-11", "成人の日"], ["2021-02-11", "建国記念の日"], ["2021-02-23", "天皇誕生日"], ["2021-03-20", "春分の日"], ["2021-04-29", "昭和の日"], ["2021-05-03", "憲法記念日"], ["2021-05-04", "みどりの日"], ["2021-05-05", "こどもの日"], ["2021-07-22", "海の日"], ["2021-07-23", "スポーツの日"], ["2021-08-08", "山の日"], ["2021-08-09", "山の日 振替休日"], ["2021-09-20", "敬老の日"], ["2021-09-23", "秋分の日"], ["2021-11-03", "文化の日"], ["2021-11-23", "勤労感謝の日"],
    ["2022-01-01", "元日"], ["2022-01-10", "成人の日"], ["2022-02-11", "建国記念の日"], ["2022-02-23", "天皇誕生日"], ["2022-03-21", "春分の日"], ["2022-04-29", "昭和の日"], ["2022-05-03", "憲法記念日"], ["2022-05-04", "みどりの日"], ["2022-05-05", "こどもの日"], ["2022-07-18", "海の日"], ["2022-08-11", "山の日"], ["2022-09-19", "敬老の日"], ["2022-09-23", "秋分の日"], ["2022-10-10", "スポーツの日"], ["2022-11-03", "文化の日"], ["2022-11-23", "勤労感謝の日"],
    ["2023-01-01", "元日"], ["2023-01-02", "元日 振替休日"], ["2023-01-09", "成人の日"], ["2023-02-11", "建国記念の日"], ["2023-02-23", "天皇誕生日"], ["2023-03-21", "春分の日"], ["2023-04-29", "昭和の日"], ["2023-05-03", "憲法記念日"], ["2023-05-04", "みどりの日"], ["2023-05-05", "こどもの日"], ["2023-07-17", "海の日"], ["2023-08-11", "山の日"], ["2023-09-18", "敬老の日"], ["2023-09-23", "秋分の日"], ["2023-10-09", "スポーツの日"], ["2023-11-03", "文化の日"], ["2023-11-23", "勤労感謝の日"],
    ["2024-01-01", "元日"], ["2024-01-08", "成人の日"], ["2024-02-11", "建国記念の日"], ["2024-02-12", "建国記念の日 振替休日"], ["2024-02-23", "天皇誕生日"], ["2024-03-20", "春分の日"], ["2024-04-29", "昭和の日"], ["2024-05-03", "憲法記念日"], ["2024-05-04", "みどりの日"], ["2024-05-05", "こどもの日"], ["2024-05-06", "こどもの日 振替休日"], ["2024-07-15", "海の日"], ["2024-08-11", "山の日"], ["2024-08-12", "山の日 振替休日"], ["2024-09-16", "敬老の日"], ["2024-09-22", "秋分の日"], ["2024-09-23", "秋分の日 振替休日"], ["2024-10-14", "スポーツの日"], ["2024-11-03", "文化の日"], ["2024-11-04", "文化の日 振替休日"], ["2024-11-23", "勤労感謝の日"],
    ["2025-01-01", "元日"], ["2025-01-13", "成人の日"], ["2025-02-11", "建国記念の日"], ["2025-02-23", "天皇誕生日"], ["2025-02-24", "天皇誕生日 振替休日"], ["2025-03-20", "春分の日"], ["2025-04-29", "昭和の日"], ["2025-05-03", "憲法記念日"], ["2025-05-04", "みどりの日"], ["2025-05-05", "こどもの日"], ["2025-05-06", "みどりの日 振替休日"], ["2025-07-21", "海の日"], ["2025-08-11", "山の日"], ["2025-09-15", "敬老の日"], ["2025-09-23", "秋分の日"], ["2025-10-13", "スポーツの日"], ["2025-11-03", "文化の日"], ["2025-11-23", "勤労感謝の日"], ["2025-11-24", "勤労感謝の日 振替休日"],
    ["2026-01-01", "元日"], ["2026-01-12", "成人の日"], ["2026-02-11", "建国記念の日"], ["2026-02-23", "天皇誕生日"], ["2026-03-20", "春分の日"], ["2026-04-29", "昭和の日"], ["2026-05-03", "憲法記念日"], ["2026-05-04", "みどりの日"], ["2026-05-05", "こどもの日"], ["2026-05-06", "憲法記念日 振替休日"], ["2026-07-20", "海の日"], ["2026-08-11", "山の日"], ["2026-09-21", "敬老の日"], ["2026-09-22", "国民の休日"], ["2026-09-23", "秋分の日"], ["2026-10-12", "スポーツの日"], ["2026-11-03", "文化の日"], ["2026-11-23", "勤労感謝の日"],
    ["2027-01-01", "元日"], ["2027-01-11", "成人の日"], ["2027-02-11", "建国記念の日"], ["2027-02-23", "天皇誕生日"], ["2027-03-21", "春分の日"], ["2027-03-22", "春分の日 振替休日"], ["2027-04-29", "昭和の日"], ["2027-05-03", "憲法記念日"], ["2027-05-04", "みどりの日"], ["2027-05-05", "こどもの日"], ["2027-07-19", "海の日"], ["2027-08-11", "山の日"], ["2027-09-20", "敬老の日"], ["2027-09-23", "秋分の日"], ["2027-10-11", "スポーツの日"], ["2027-11-03", "文化の日"], ["2027-11-23", "勤労感謝の日"]
  ];

  var indiaFixedHolidays = [['01-26', 'Republic Day'], ['04-14', 'Ambedkar Jayanti'], ['05-01', 'May Day'],
    ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti'], ['12-25', 'Christmas']];
  var indiaMovingHolidays = {
    Holi: ['2021-03-29', '2022-03-18', '2023-03-08', '2024-03-25', '2025-03-14', '2026-03-04', '2027-03-23'],
    Diwali: ['2021-11-04', '2022-10-24', '2023-11-12', '2024-10-31', '2025-10-20', '2026-11-08', '2027-10-29'],
  };
  var calendarNames = { JP: 'Japan', IN: 'India', US: 'the United States', GB: 'the United Kingdom' };

  // The forecast's country from its own postal codes; null when unclear.
  function forecastCountry() {
    var skus = window.DATA?.id ? window.DATA.skus || {} : {};
    var codes = new Set(Object.values(skus).flatMap(function (item) { return Object.keys(item.byZip || {}); }));
    var counts = {};
    codes.forEach(function (code) {
      var c = String(code).trim().toUpperCase();
      var country = /^\d{3}-?\d{4}$/.test(c) ? 'JP' : /^[1-9]\d{5}$/.test(c) ? 'IN' : /^\d{5}(-\d{4})?$/.test(c) ? 'US'
        : /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(c) ? 'GB' : null;
      if (country) counts[country] = (counts[country] || 0) + 1;
    });
    var best = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    return best && counts[best] * 2 > codes.size ? best : null;
  }

  function holidaysFor(country) {
    if (!country || country === 'JP') return japanHolidays;
    if (country !== 'IN') return [];
    var rows = [];
    for (var year = 2021; year <= 2027; year++) {
      indiaFixedHolidays.forEach(function (entry) { rows.push([year + '-' + entry[0], entry[1]]); });
    }
    Object.keys(indiaMovingHolidays).forEach(function (name) {
      indiaMovingHolidays[name].forEach(function (day) { rows.push([day, name]); });
    });
    return rows.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  }

  function fillScenarioSelect(id, label, options) {
    var field = scenarioElement(id);
    var value = pendingScenarioChoices[id] || field.value;
    if (options.length) delete pendingScenarioChoices[id];
    field.replaceChildren(new Option(label, ''), ...options.map(function (entry) {
      return new Option(entry[1], entry[0]);
    }));
    field.value = options.some(function (entry) { return entry[0] === value; }) ? value : '';
  }

  function syncScenarioPriceOptions() {
    var skus = window.DATA?.id ? window.DATA.skus || {} : {};
    var sku = scenarioElement('rf-price-sku');
    var postal = scenarioElement('rf-price-postal');
    var ids = Object.keys(skus).sort();
    fillScenarioSelect(sku.id, 'All SKUs', ids.map(function (id) { return [id, id]; }));
    var scope = sku.value ? [skus[sku.value]] : Object.values(skus);
    var codes = Array.from(new Set(scope.flatMap(function (item) {
      return Object.keys(item?.byZip || {});
    }))).sort();
    fillScenarioSelect(postal.id, 'All PIN codes', codes.map(function (code) { return [code, code]; }));
  }

  async function loadScenarioCampaigns() {
    var status = scenarioElement('scenarioCampaignStatus');
    status.textContent = 'Loading campaigns…';
    try {
      var response = await APRA_SESSION.fetch(SCENARIOS_API.replace(/scenarios$/, 'amplify-campaigns') + '?view=plans');
      if (!response.ok) throw new Error();
      var data = await response.json();
      var campaigns = data.plans.filter(function (plan) { return plan.status === 'committed'; });
      fillScenarioSelect('rf-campaign', 'All campaigns', campaigns.map(function (plan) {
        return [plan.code, plan.name + ' · ' + plan.code];
      }));
      status.textContent = campaigns.length ? '' : 'No committed campaigns.';
    } catch (error) {
      status.textContent = 'Could not load campaigns. Reopen this section to retry.';
    }
  }

  // Choices are the schemes created in Discount Schemes: committed ones
  // apply unless unticked; drafts apply only when ticked, to this run alone.
  // Schemes only detected in sales have no discount or future dates to apply.
  async function loadScenarioSchemes() {
    var status = scenarioElement('scenarioSchemeStatus');
    if (!committedSchemes) status.textContent = 'Loading schemes…';
    try {
      var response = await APRA_SESSION.fetch(SCENARIOS_API + '?view=schemes');
      if (!response.ok) throw new Error();
      var data = await response.json();
      if (!Array.isArray(data.schemes)) throw new Error();
      committedSchemes = data.schemes.filter(function (scheme) { return scheme.status === 'committed'; });
      // An older backend would silently ignore drafts, so it isn't offered them.
      draftSchemes = data.draft_runs ? data.schemes.filter(function (scheme) { return scheme.version && scheme.status === 'draft'; }) : [];
      var detected = data.schemes.filter(function (scheme) { return scheme.detected && !scheme.version; }).length;
      keepKnownSchemes(excludedSchemes, committedSchemes);
      keepKnownSchemes(includedSchemes, draftSchemes);
      var any = committedSchemes.length + draftSchemes.length;
      status.textContent = any ? 'Ticked schemes apply to this run.' + (draftSchemes.length ? ' Saved ones aren’t committed.' : '') : '';
      scenarioElement('scenarioSchemeFoot').hidden = any > 0 && !detected;
      scenarioElement('scenarioSchemeFootText').textContent = detected
        ? detected + ' found in your sales need' + (detected === 1 ? 's' : '') + ' a discount and dates'
        : 'No schemes created yet';
      scenarioElement('scenarioSchemesOpen').textContent = detected ? 'Set up →' : 'Create one →';
      renderScenarioSchemes();
    } catch (error) {
      status.textContent = 'Could not load discount schemes. Reopen this section to retry.';
    }
  }

  // "Use in Scenarios" on a saved scheme: tick it here and show it.
  window.useSchemeInScenario = async function (code) {
    includedSchemes.add(code);
    var nav = Array.from(document.querySelectorAll('.dnav li')).find(function (li) { return li.title === 'Scenarios'; });
    if (nav) nav.click();
    var details = scenarioElement('scenarioSchemes');
    details.open = true;
    await loadScenarioSchemes();
    details.scrollIntoView({ block: 'center' });
    var box = scenarioElement('scenarioSchemeOptions').querySelector('input[value="' + CSS.escape(code) + '"]');
    if (box) box.focus({ preventScroll: true });
  };

  function keepKnownSchemes(chosen, schemes) {
    var codes = new Set(schemes.map(function (scheme) { return scheme.code; }));
    chosen.forEach(function (code) { if (!codes.has(code)) chosen.delete(code); });
  }

  function renderScenarioSchemes() {
    var all = committedSchemes.concat(draftSchemes);
    var firstForecastDay = window.DATA?.id ? window.DATA.weeks?.[window.DATA.backtestWeeks || 0] : null;
    scenarioElement('scenarioSchemeActions').hidden = all.length < 2;
    scenarioElement('scenarioSchemeOptions').replaceChildren(...all.map(function (scheme) {
      var isDraft = scheme.status === 'draft';
      var add = function (parent, tag, className, text) {
        var el = document.createElement(tag);
        el.className = className;
        if (text != null) el.textContent = text;
        parent.append(el);
        return el;
      };
      var card = document.createElement('label');
      card.className = 'sch-card';
      var input = add(card, 'input', '');
      input.type = 'checkbox';
      input.value = scheme.code;
      input.dataset.kind = isDraft ? 'draft' : 'committed';
      input.checked = isDraft ? includedSchemes.has(scheme.code) : !excludedSchemes.has(scheme.code);
      var body = add(card, 'span', 'sch-body');
      var top = add(body, 'span', 'sch-top');
      add(top, 'b', 'sch-name', scheme.name || scheme.code);
      add(top, 'em', 'sch-tag' + (isDraft ? '' : ' on'), isDraft ? 'Saved' : 'Committed');
      if (scheme.name && scheme.name.toUpperCase() !== scheme.code) add(body, 'span', 'sch-code', scheme.code);
      var facts = schemeFacts(scheme);
      if (facts) add(body, 'span', 'sch-facts', facts);
      var starts = (scheme.scope || []).map(function (line) { return line.start_date; }).filter(Boolean).sort();
      var ends = (scheme.scope || []).map(function (line) { return line.end_date; }).filter(Boolean).sort();
      if (starts.length && ends.length) {
        var last = ends[ends.length - 1];
        add(body, 'span', 'sch-dates', schemeDates(starts[0], last));
        if (firstForecastDay && last < firstForecastDay) add(body, 'span', 'sch-ended', 'Ended — no effect on the forecast');
      }
      return card;
    }));
    updateScenarioSchemeSummary();
  }

  // "15% off · All SKUs · All postal codes", from the scheme's own lines.
  function schemeFacts(scheme) {
    var lines = scheme.scope || [];
    if (!lines.length) return '';
    var amounts = lines.map(function (line) { return Number(line.discount); }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    var fmt = function (n) { return n.toLocaleString(undefined, { maximumFractionDigits: 2 }); };
    var parts = [];
    if (amounts.length) {
      var low = amounts[0], high = amounts[amounts.length - 1];
      parts.push((low === high ? fmt(low) : fmt(low) + '–' + fmt(high)) + (scheme.mechanic === 'Flat amount off' ? ' off' : '% off'));
    }
    var bundle = lines[0];
    if (scheme.mechanic === 'Buy X get Y' && bundle.buy_quantity && lines.every(function (line) {
      return line.buy_quantity === bundle.buy_quantity && line.free_quantity === bundle.free_quantity;
    })) parts.unshift('Buy ' + bundle.buy_quantity + ' get ' + bundle.free_quantity);
    else if (scheme.mechanic && !['Percent off', 'Flat amount off'].includes(scheme.mechanic)) parts.unshift(scheme.mechanic);
    var count = function (key, all, many) {
      var values = Array.from(new Set(lines.map(function (line) { return String(line[key] || '').toUpperCase(); }).filter(Boolean)));
      if (values.includes('ALL')) return all;
      return values.length === 1 ? values[0] : values.length ? values.length + ' ' + many : '';
    };
    return parts.concat(count('sku', 'All SKUs', 'SKUs'), count('postal_code', 'All postal codes', 'postal codes'))
      .filter(Boolean).join(' · ');
  }

  // "23 Nov – 9 Dec 2026"; the year is repeated only when it differs.
  function schemeDates(start, end) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var a = start.split('-'), b = end.split('-');
    var day = function (d) { return Number(d[2]) + ' ' + months[Number(d[1]) - 1]; };
    if (start === end) return day(a) + ' ' + a[0];
    return day(a) + (a[0] === b[0] ? '' : ' ' + a[0]) + ' – ' + day(b) + ' ' + b[0];
  }

  function updateScenarioSchemeSummary() {
    var total = committedSchemes ? committedSchemes.length + draftSchemes.length : 0;
    var on = total ? committedSchemes.length - excludedSchemes.size + includedSchemes.size : 0;
    var pill = scenarioElement('scenarioSchemeCount');
    pill.hidden = !total;
    pill.textContent = on + ' of ' + total + ' included';
    pill.classList.toggle('on', on > 0);
  }

  function changeScenarioSchemes(included) {
    var codes = function (schemes) { return schemes.map(function (scheme) { return scheme.code; }); };
    excludedSchemes = new Set(included ? [] : codes(committedSchemes));
    includedSchemes = new Set(included ? codes(draftSchemes) : []);
    renderScenarioSchemes();
  }

  function renderScenarioHolidays() {
    var data = window.DATA;
    var lastActual = data?.id && data.weeks?.[(data.backtestWeeks || 0) - 1];
    var first = lastActual || new Date().toISOString().slice(0, 10);
    var last = data?.id && data.weeks?.at(-1);
    // The weekly forecast labels use the start of the week.
    var end = last && last > first ? new Date(Date.parse(last) + 6 * 86400000).toISOString().slice(0, 10) : '';
    var list = scenarioElement('scenarioHolidayOptions');
    var country = forecastCountry();
    var modelHolidays = holidaysFor(country);
    // A saved draft may still exclude another country's dates.
    if (data?.id) {
      var known = new Set(modelHolidays.map(function (entry) { return entry[0]; }));
      excludedHolidayDates.forEach(function (day) { if (!known.has(day)) excludedHolidayDates.delete(day); });
    }
    list.replaceChildren(...modelHolidays.filter(function (entry) {
      return (entry[0] >= first && (!end || entry[0] <= end)) || excludedHolidayDates.has(entry[0]);
    }).map(function (entry) {
      var label = document.createElement('label');
      label.className = 'scenario-check';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = entry[0];
      input.checked = !excludedHolidayDates.has(entry[0]);
      label.append(input, entry[0] + ' · ' + entry[1]);
      return label;
    }));
    if (!list.childElementCount) list.textContent = country && country !== 'JP' && country !== 'IN'
      ? 'No holiday calendar for ' + calendarNames[country] + ' yet.' : 'No holidays in the forecast period.';
    // Forecasts trained before per-country calendars all used Japan's.
    var trained = data?.id ? data.holidayCalendar || 'JP' : null;
    if (country && trained && trained !== country) {
      var note = document.createElement('p');
      note.className = 'scenario-holiday-note';
      note.textContent = 'The approved forecast was trained with ' + (calendarNames[trained] || trained) +
        '’s holidays. New runs use ' + (modelHolidays.length ? calendarNames[country] + '’s' : 'none') +
        ', so some change against the plan comes from that.';
      list.prepend(note);
    }
    updateScenarioHolidaySummary();
  }

  function updateScenarioHolidaySummary() {
    var inputs = scenarioElement('scenarioHolidayOptions').querySelectorAll('input');
    var selected = Array.from(inputs).filter(function (input) { return input.checked; }).length;
    scenarioElement('scenarioHolidaySummary').textContent = inputs.length
      ? 'Select holidays · ' + selected + ' of ' + inputs.length + ' included' : 'Select holidays';
  }

  function changeScenarioHolidays(checked) {
    scenarioElement('scenarioHolidayOptions').querySelectorAll('input').forEach(function (input) {
      input.checked = checked;
      if (checked) excludedHolidayDates.delete(input.value);
      else excludedHolidayDates.add(input.value);
    });
    updateScenarioHolidaySummary();
  }

  function restoreScenarioDraft() {
    try {
      var saved = JSON.parse(localStorage.getItem(draftKey()) || '{}');
      scenarioDraftFields.forEach(function (id) {
        var field = scenarioElement(id);
        if (saved[id] == null) return;
        if (field.type === 'checkbox') field.checked = saved[id] === true;
        else if (['rf-price-postal', 'rf-price-sku', 'rf-campaign'].includes(id)) pendingScenarioChoices[id] = saved[id];
        else field.value = saved[id];
      });
      if (saved['rf-price-target'] && !saved['rf-price-postal'] && !saved['rf-price-sku']) {
        pendingScenarioChoices[saved['rf-price-scope'] === 'sku' ? 'rf-price-sku' : 'rf-price-postal'] = saved['rf-price-target'];
      }
      excludedHolidayDates = new Set(saved.excludedHolidayDates || []);
      // Older drafts kept typed, comma-separated IDs.
      excludedSchemes = new Set(saved.excludedSchemes || String(saved['rf-exclude'] || '').split(',')
        .map(function (code) { return code.trim().toUpperCase(); }).filter(Boolean));
      includedSchemes = new Set(saved.includedSchemes || []);
      if (excludedSchemes.size || includedSchemes.size) loadScenarioSchemes();
      if (saved['rf-source']) scenarioElement('rf-source').dataset.edited = 'true';
      syncScenarioInput();
    } catch (error) { /* Nothing to restore. */ }
  }

  function saveScenarioDraft() {
    var key = draftKey();
    var message = scenarioElement('scenarioDraftStatus');
    if (!key) { message.textContent = 'Sign in to save a draft.'; return; }
    var draft = Object.fromEntries(scenarioDraftFields.map(function (id) {
      var field = scenarioElement(id);
      return [id, field.type === 'checkbox' ? field.checked : field.value];
    }));
    draft.excludedHolidayDates = Array.from(excludedHolidayDates);
    draft.excludedSchemes = Array.from(excludedSchemes);
    draft.includedSchemes = Array.from(includedSchemes);
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      message.textContent = 'Draft saved in this browser.' +
        (draft['rf-source'] === 'custom' ? ' Select the sales file again when you reopen it.' : '');
    } catch (error) {
      message.textContent = 'Could not save the draft in this browser.';
    }
  }

  function formatScenarioChange(base, variant) {
    if (base == null || variant == null || base <= 0) return '—';
    var change = (variant - base) / base * 100;
    return (change > 0 ? '+' : '') + change.toFixed(1) + '%';
  }

  function setWorkspaceChart(message, loading) { window.scenarioForecast.clear(message, loading); }

  var KPI_FIELDS = ['scenarioRevenue', 'scenarioUnitsChange'];
  var KPI_NOTES = ['scenarioRevenueNote', 'scenarioUnitsTotals'];
  function resetScenarioKpis(loading) {
    KPI_FIELDS.forEach(function (field) {
      var value = scenarioElement(field);
      value.textContent = loading ? '' : '—';
      if (loading) value.innerHTML = '<span class="skel-line"></span>';
    });
    KPI_NOTES.forEach(function (field) { scenarioElement(field).textContent = ''; });
    scenarioElement('scenarioKpiNote').hidden = true;
  }

  function showScenarioTotals(totals, context) {
    var whole = function (n) { return Math.round(n).toLocaleString(); };
    var set = function (field, value, note) {
      scenarioElement(field[0]).textContent = value;
      scenarioElement(field[1]).textContent = note || '';
    };
    var weeks = totals ? ' · ' + totals.weeks + ' wk' : '';
    if (!totals) {
      set(['scenarioUnitsChange', 'scenarioUnitsTotals'], '—');
      set(['scenarioRevenue', 'scenarioRevenueNote'], '—');
      return;
    }
    set(['scenarioUnitsChange', 'scenarioUnitsTotals'], totals.base == null ? '—' : formatScenarioChange(totals.base, totals.scenario),
      totals.base == null ? whole(totals.scenario) + ' units' + weeks : whole(totals.scenario) + ' vs. ' + whole(totals.base) + weeks);

    var money = totals.revenue, plan = totals.baseRevenue;
    var known = money.value != null && !context.unpriced;
    var planKnown = plan && plan.value != null && !context.unpricedBase;
    set(['scenarioRevenue', 'scenarioRevenueNote'], known && planKnown ? formatScenarioChange(plan.value, money.value) : '—',
      money.value == null ? 'No selling prices in your sales data' : !known ? 'This run’s prices can’t be read'
        : whole(money.value) + (planKnown ? ' vs. ' + whole(plan.value) : '') + weeks +
          (money.missing ? ' · ' + money.missing + ' SKU' + (money.missing === 1 ? '' : 's') + ' without a price left out' : ''));
    var note = scenarioElement('scenarioKpiNote');
    note.textContent = 'Revenue is forecast units × average selling price, with the run’s price changes and discounts.';
    note.hidden = false;
  }

  async function renderWorkspaceComparison(id, key) {
    var status = scenarioElement('scenarioComparisonStatus');
    status.textContent = '';
    setWorkspaceChart('', true);
    resetScenarioKpis(true);

    async function request(url) {
      var response = await APRA_SESSION.fetch(url);
      if (!response.ok) throw new Error('Forecast comparison unavailable.');
      return response.json();
    }
    try {
      var query = new URLSearchParams({view:'baseline', scenario:id});
      var results = await Promise.allSettled([
        request(SCENARIOS_API + '?' + query),
        request(SCENARIOS_API + '/' + encodeURIComponent(id) + '/result'),
      ]);
      if (workspaceComparisonKey !== key) return;
      var comparison = results[0].status === 'fulfilled' ? results[0].value : {};
      if (results[1].status !== 'fulfilled') throw new Error('Could not load the scenario result.');
      var result = results[1].value;
      var approved = lastScenarios.find(function (item) { return item.approved; });
      var base = comparison.base || (approved && window.DATA && window.DATA.id === approved.id ? window.DATA : null);
      if (!Array.isArray(result.weeks) || !result.all || !result.skus) throw new Error('No weekly forecast is available.');
      var meta = lastScenarios.find(function (item) { return item.id === id; }) || {};
      var levers = meta.levers || {};
      var repriced = Number.isFinite(levers.price_pct) || (levers.included_schemes || []).length > 0;
      var pricing = comparison.pricing || {};
      var context = {
        // Without the run's price details only an unrepriced run is safe to value.
        unpriced: !pricing.scenario && (!!comparison.pricing || repriced), unpricedBase: !!comparison.pricing && !pricing.base };
      window.scenarioForecast.show(result, base, {
        pricing: pricing,
        note: context.unpriced ? 'Revenue uses usual prices, so this scenario’s discounts or price change aren’t in it.' : '',
        // Same weeks as the chart and table, so every number agrees.
        onTotals: function (totals) {
          showScenarioTotals(totals, context);
          status.textContent = totals && totals.base != null ? ''
            : totals && totals.otherProducts ? 'This scenario’s products aren’t in the approved plan, so there is nothing to compare.'
            : base ? 'This scenario and the approved plan have no forecast weeks in common.' : 'The approved plan isn’t available to compare with.';
        },
      });
    } catch (error) {
      if (workspaceComparisonKey === key) {
        status.textContent = '';
        resetScenarioKpis();
        setWorkspaceChart(error.message || 'Could not load the weekly forecast.');
      }
    }
  }

  function syncScenarioWorkspace(scenarios) {
    var select = scenarioElement('scenarioRunSelection');
    if (!select) return;
    if (!workspaceChosen && !workspaceRunId) {
      var newest = scenarios.filter(function (item) { return item.status === 'completed' && !item.approved; })
        .sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); })[0];
      if (newest) workspaceRunId = newest.id;
    }
    var options = scenarios.filter(function (item) { return item.status === 'completed' || item.id === workspaceRunId; });
    select.replaceChildren(new Option('Select a scenario', ''));
    options.forEach(function (item) {
      var suffix = item.status !== 'completed' ? ' · ' + item.status : item.approved ? ' · approved' : '';
      select.add(new Option((item.label || 'Untitled') + suffix, item.id));
    });
    if (workspaceRunId && !options.some(function (item) { return item.id === workspaceRunId; })) {
      select.add(new Option('Starting forecast…',workspaceRunId));
    }
    select.value = workspaceRunId;
    var item = options.find(function (row) { return row.id === workspaceRunId; });
    var apply = scenarioElement('scenarioApplyPlan');
    apply.disabled = !isAdmin || !item || item.status !== 'completed' || item.approved;
    var approved = scenarios.find(function (row) { return row.approved; });
    var key = [workspaceRunId, item?.status, approved?.id].join('|');
    if (key === workspaceComparisonKey) return;
    workspaceComparisonKey = key;
    resetScenarioKpis();
    setWorkspaceChart(workspaceRunId ? 'The weekly forecast will appear after the run completes.'
      : 'Select a completed scenario to see its forecast.');
    var status = scenarioElement('scenarioComparisonStatus');
    if (!workspaceRunId) status.textContent = '';
    else if (item?.status === 'completed') renderWorkspaceComparison(item.id, key);
    else if (item?.status === 'failed') {
      status.textContent = item.error || 'The scenario run failed.';
      setWorkspaceChart('No weekly forecast was produced.');
    }
    else status.textContent = 'Forecast running. Results will appear when it finishes.';
  }

  window.compareWithApproved = function (id) {
    workspaceRunId = id;
    workspaceChosen = true;
    workspaceComparisonKey = '';
    syncScenarioWorkspace(lastScenarios);
    renderLastRun(lastScenarios);
    scenarioElement('scenarioWorkspace').scrollIntoView({block:'start'});
    scenarioElement('scenarioRunSelection').focus({preventScroll:true});
  };

  // Revision history filters — status seg (All/Approved/Completed/Running/
  // Failed) and free-text search (label + requester), both applied client-
  // side in render() since /scenarios already returns everything. Any
  // change jumps back to page 1 so the new result set is never viewed
  // starting from a page number that may no longer exist for it.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#scenariosStatusSeg button');
    if (!btn) return;
    document.querySelectorAll('#scenariosStatusSeg button').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
    scenariosStatusFilter = btn.dataset.status;
    scenariosPage = 1;
    render(lastScenarios);
  });

  document.addEventListener('DOMContentLoaded', function () {
    var searchInput = document.getElementById('scenariosSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        scenariosSearch = searchInput.value.trim().toLowerCase();
        scenariosPage = 1;
        render(lastScenarios);
      });
    }
  });

  function uploadCustomInput(file) {
    var statusEl = document.getElementById('rf-upload-status');
    statusEl.textContent = 'Requesting upload URL…';
    return APRA_SESSION.fetch(SCENARIOS_API + '/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
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
    var source = scenarioElement('rf-source').value;
    var useCustom = source === 'custom';
    var fileInput = document.getElementById('rf-file');
    var file = fileInput && fileInput.files && fileInput.files[0];

    errEl.textContent = '';
    if (useCustom && !file) {
      errEl.textContent = 'Choose a file to upload, or switch back to the default dataset.';
      return;
    }

    var levers = {};
    [['rf-spend', 'spend_pct'], ['rf-price', 'price_pct'], ['rf-cap', 'unit_cap']].forEach(function (entry) {
      var value = document.getElementById(entry[0]).value;
      if (value !== '') levers[entry[1]] = Number(value);
    });
    [['rf-campaign', 'campaign_code'], ['rf-postal', 'postal_code']].forEach(function (entry) {
      var value = document.getElementById(entry[0]).value.trim();
      if (value) levers[entry[1]] = value;
    });
    if ('price_pct' in levers) {
      levers.price_sku = scenarioElement('rf-price-sku').value;
      levers.price_postal_code = scenarioElement('rf-price-postal').value;
    }
    if (excludedHolidayDates.size) levers.excluded_holiday_dates = Array.from(excludedHolidayDates);
    if ((excludedSchemes.size || includedSchemes.size) && !committedSchemes) {
      errEl.textContent = 'Your discount schemes haven’t loaded, so the saved selection can’t be checked. Open Discount schemes above and try again.';
      return;
    }
    if (excludedSchemes.size) levers.excluded_schemes = Array.from(excludedSchemes);
    if (includedSchemes.size) levers.included_schemes = Array.from(includedSchemes);

    if (!scenarioLeverSupport && (source === 'approved' || Object.keys(levers).length)) {
      errEl.textContent = 'The saved levers require the updated Forecast backend. Choose a standard run or try again after deployment.';
      return;
    }
    var payload = {
      label: label,
      source: source,
      levers: levers,
      weather: scenarioElement('rf-weather').checked,
      refresh_days: Number(scenarioElement('rf-refresh').value),
    };

    btn.disabled = true;
    btn.textContent = useCustom ? 'Uploading…' : 'Starting…';

    (useCustom ? uploadCustomInput(file) : Promise.resolve(null))
      .then(function (customInputKey) {
        if (customInputKey) payload.custom_input_key = customInputKey;
        btn.textContent = 'Starting…';
        return APRA_SESSION.fetch(SCENARIOS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Run';
        if (!res.ok) {
          errEl.textContent = res.d.error || 'Failed to start run.';
          return;
        }
        workspaceRunId = res.d.scenario_id || '';
        workspaceComparisonKey = '';
        syncScenarioWorkspace(lastScenarios);
        scenariosPage = 1; // jump back to the top page so the just-started run is visible right away
        loadScenarios();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Run';
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

    return APRA_SESSION.fetch(SCENARIOS_API + '/' + id + '/approve', {
      method: 'POST',
    })
      .then(function (r) {
        if (r.status === 403) {
          // The button itself is hidden for a viewer — reaching this means
          // either stale UI state (role just changed) or a direct API
          // call. Re-sync the role/list so the button reflects reality,
          // then surface a clear reason rather than a generic failure.
          loadScenarios();
          throw new Error('Only an admin for your organization can approve a forecast.');
        }
        if (!r.ok) throw new Error('approve failed');
        return loadScenarios();
      })
      .then(function () {
        return loadApprovals(); // pick up the new audit entry the approve call just wrote
      })
      .then(function () {
        try { localStorage.removeItem('apra_forecast_cache'); } catch (e) {}
        if (typeof loadForecast === 'function') loadForecast(true); // refresh Overview/Forecasts with the newly-approved data
        // AI Insights (headline/summary/findings) has its own separate cache
        // with no TTL — without this, Generate report and the AI Insights
        // tab both kept showing the PREVIOUS approved scenario's insights
        // until a hard reload, even though the numbers above already
        // refreshed correctly.
        if (typeof window.invalidateInsights === 'function') window.invalidateInsights();
        if (typeof window.invalidateInventory === 'function') window.invalidateInventory();
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
        throw err;
      });
  };

  /* ── Team / roles (Settings > Team) ── */
  function currentUserEmail() {
    try {
      var t = localStorage.getItem('apra_id');
      var p = JSON.parse(decodeURIComponent(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        .split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')));
      return (p.email || '').toLowerCase();
    } catch (e) { return ''; }
  }

  // Loads the Settings > Team card — everyone in the org sees the member
  // list (read-only), only an admin gets the role toggle. Self-contained
  // (own fetch, own you_are_admin check) rather than reusing scenarios.js's
  // own isAdmin module var, since Settings can be opened without Scenarios
  // ever having loaded.
  window.loadTeamMembers = function () {
    var card = document.getElementById('settingsTeamCard');
    var body = document.getElementById('teamMembersBody');
    var actionHead = document.getElementById('teamActionHead');
    if (!card || !body) return;

    APRA_SESSION.fetch(SCENARIOS_API + '/members')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        card.style.display = '';
        var youAreAdmin = !!d.you_are_admin;
        var me = currentUserEmail();
        if (actionHead) actionHead.style.display = youAreAdmin ? '' : 'none';

        body.innerHTML = (d.members || []).map(function (m) {
          var isSelf = m.email === me;
          var roleBadge = '<span class="pill' + (m.role === 'admin' ? ' ok' : '') + '">' +
            (m.role === 'admin' ? 'Admin' : 'Viewer') + '</span>';
          // Admin status can only be granted, never revoked — see
          // set_member_role()'s own comment. So the only action a role
          // toggle ever offers is promoting a viewer; an existing admin's
          // row gets a plain dash, not a demote button that would just
          // 400 if clicked.
          var action = '';
          if (youAreAdmin && !isSelf) {
            action = (m.role === 'viewer')
              ? '<button class="dbtn" style="padding:5px 10px;font-size:11.5px" ' +
                'onclick="setMemberRole(\'' + escapeHtml(m.email) + '\',\'admin\',this)">Make admin</button>'
              : '<span class="dsubtle" style="margin:0;font-size:11px" title="Admin status can only be granted, not revoked">—</span>';
          }
          return '<tr>' +
            '<td>' + escapeHtml(m.email) + (isSelf ? ' <span class="dsubtle" style="margin:0">(you)</span>' : '') + '</td>' +
            '<td>' + roleBadge + '</td>' +
            '<td>' + action + '</td>' +
            '</tr>';
        }).join('') || '<tr><td colspan="3" class="dsubtle">No members found.</td></tr>';
      })
      .catch(function () {
        card.style.display = 'none'; // transient error — don't show a broken/empty team card
      });
  };

  window.setMemberRole = function (email, role, btn) {
    var msg = document.getElementById('teamRoleMsg');
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = ''; msg.className = 'stest-msg'; }

    APRA_SESSION.fetch(SCENARIOS_API + '/members/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, role: role }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'could not update role'); });
        return window.loadTeamMembers();
      })
      .then(function () {
        // The signed-in user's own role may have just changed (an admin
        // demoting themself via someone else's session, or a second tab) —
        // re-sync the Approve button's gating too, not just this table.
        if (typeof loadScenarios === 'function') loadScenarios();
      })
      .catch(function (err) {
        if (msg) { msg.className = 'stest-msg err'; msg.textContent = err.message; }
        if (btn) btn.disabled = false;
      });
  };

  /* ── Compare ── */
  window.openCompareModal = function () {
    if (selectedForCompare.length !== 2) return;
    var body = document.getElementById('compareBody');
    body.innerHTML = '<p class="dsubtle">Loading comparison…</p>';
    document.getElementById('compareModal').classList.add('open');

    var ids = selectedForCompare.slice();
    Promise.all(ids.map(function (id) {
      return APRA_SESSION.fetch(SCENARIOS_API + '/' + id + '/result').then(function (r) { return r.json(); });
    })).then(function (results) {
      var metas = ids.map(function (id) {
        return lastScenarios.find(function (s) { return s.id === id; });
      });
      renderCompare(metas, results);
      loadCompareBreakdown(ids[1], ids[0]);
    }).catch(function () {
      body.innerHTML = '<p class="auth-error">Could not load one or both results.</p>';
    });
  };
  async function loadCompareBreakdown(id, baseId) {
    var panel = document.getElementById('scenario-compare-detail');
    if (!panel) return;
    panel.textContent = 'Loading SKU and postal-code comparison…';
    try {
      var query = new URLSearchParams({ view: 'baseline', scenario: id });
      if (baseId) query.set('base', baseId);
      var response = await APRA_SESSION.fetch(SCENARIOS_API + '?' + query);
      var data = await response.json();
      if (!response.ok || !data.detail_available || !data.rows.length) throw new Error();
      panel.innerHTML = '<div class="table-wrap"><table class="dtable"><thead><tr><th>Base SKU</th><th>Postal code</th><th>Base units</th><th>Scenario units</th><th>Change</th></tr></thead><tbody></tbody></table></div>';
      var body = panel.querySelector('tbody');
      data.rows.forEach(function (row) {
        var tr = body.insertRow();
        [row.sku, row.postal_code, row.base, row.scenario, row.change].forEach(function (value) {
          tr.insertCell().textContent = value.toLocaleString();
        });
      });
    } catch (error) {
      panel.textContent = 'SKU and postal-code comparison is unavailable for these revisions.';
    }
  }

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
    if (results.some(function (r) { return r.cappedUnits != null; })) {
      rows.push(['Capped units', results.map(function (r) { return r.cappedUnits == null ? '—' : r.cappedUnits.toLocaleString(); })]);
    }
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

    html += '<div class="dcard" style="margin-top:20px"><h4>SKU and postal-code comparison</h4><div id="scenario-compare-detail"></div></div>';

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
    APRA_SESSION.fetch(SCENARIOS_API + '/' + id + '/result')
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

  // Decision support for "does this scenario look safe to approve" — three
  // anomaly types, each judged against that SKU's OWN historical behavior
  // rather than one fixed threshold, since normal volatility varies hugely
  // sku to sku (a bestseller's forecast swinging 10% week to week might be
  // routine; the same swing on a slow mover could be the model going off
  // the rails). Mirrored in lambda/chat-api/handler.py's detect_anomalies
  // tool — same methodology, so the UI and Lyra never disagree about what
  // counts as anomalous for a given scenario.
  //   - backtestMisses: a historical week where the model's error badly
  //     missed that SKU's own typical error (mean + 2.5 std of that SKU's
  //     own backtest error distribution, with a 35% floor so an already-
  //     accurate SKU isn't flagged over noise).
  //   - forwardSwings: a forward week whose forecast moves further, week
  //     over week, than that SKU's own model curve ever moved across the
  //     whole backtest window (mean + 3 std of week-over-week % change in
  //     f, floor 60%).
  //   - wapeOutliers: a SKU whose own WAPE is markedly worse than this
  //     scenario's overall WAPE — meaningfully less trustworthy than the
  //     rest of the catalog in this specific run.
  function computeScenarioAnomalies(result) {
    var backtestMisses = [];
    var forwardSwings = [];
    var wapeOutliers = [];
    var weeks = result.weeks || [];
    var n = result.backtestWeeks || 0;
    var overallWape = result.overallWape || 0;

    Object.keys(result.skus).forEach(function (skuId) {
      var o = result.skus[skuId];
      var a = o.a || [], f = o.f || [];

      var errs = [];
      for (var i = 0; i < n; i++) {
        if (a[i] == null) continue;
        var denom = Math.max(Math.abs(a[i]), 1);
        errs.push({ i: i, pct: Math.abs(a[i] - (f[i] || 0)) / denom });
      }
      if (errs.length >= 8) {
        var mu = errs.reduce(function (s, e) { return s + e.pct; }, 0) / errs.length;
        var variance = errs.reduce(function (s, e) { return s + (e.pct - mu) * (e.pct - mu); }, 0) / errs.length;
        var sigma = Math.sqrt(variance);
        var threshold = Math.max(mu + 2.5 * sigma, 0.35);
        errs.forEach(function (e) {
          if (e.pct >= threshold) {
            backtestMisses.push({
              sku: skuId, week: weeks[e.i], actual: a[e.i], forecast: f[e.i] || 0, pctError: e.pct,
            });
          }
        });

        var skuWape = mu * 100;
        var wapeThreshold = Math.max(overallWape * 2, overallWape + 15);
        if (skuWape >= wapeThreshold) wapeOutliers.push({ sku: skuId, skuWape: skuWape });
      }

      var wow = [];
      for (var j = 1; j < n; j++) {
        if (f[j - 1] == null || f[j] == null) continue;
        wow.push(Math.abs(f[j] - f[j - 1]) / Math.max(Math.abs(f[j - 1]), 1));
      }
      if (wow.length >= 8) {
        var wmu = wow.reduce(function (s, v) { return s + v; }, 0) / wow.length;
        var wvar = wow.reduce(function (s, v) { return s + (v - wmu) * (v - wmu); }, 0) / wow.length;
        var wthreshold = Math.max(wmu + 3 * Math.sqrt(wvar), 0.6);
        for (var k = Math.max(n, 1); k < f.length; k++) {
          if (f[k - 1] == null || f[k] == null) continue;
          var fbase = Math.max(Math.abs(f[k - 1]), 1);
          var change = (f[k] - f[k - 1]) / fbase;
          if (Math.abs(change) >= wthreshold) {
            forwardSwings.push({ sku: skuId, week: weeks[k], prevForecast: f[k - 1], forecast: f[k], pctChange: change });
          }
        }
      }
    });

    backtestMisses.sort(function (x, y) { return y.pctError - x.pctError; });
    forwardSwings.sort(function (x, y) { return Math.abs(y.pctChange) - Math.abs(x.pctChange); });
    wapeOutliers.sort(function (x, y) { return y.skuWape - x.skuWape; });
    return { backtestMisses: backtestMisses, forwardSwings: forwardSwings, wapeOutliers: wapeOutliers };
  }

  function renderScenarioDetail(meta, result) {
    var head = document.getElementById('scenarioDetailHead');
    var body = document.getElementById('scenarioDetailBody');

    var approveBtn = (meta.status === 'completed' && !meta.approved && isAdmin)
      ? '<button class="dbtn" onclick="approveScenario(\'' + meta.id + '\', this).then(closeScenarioDetail).catch(function(err){alert(err.message);})">Approve</button>'
      : (meta.status === 'completed' && !meta.approved
          ? '<span class="dsubtle" style="margin:0" title="Only an admin for your organization can approve a forecast">Viewer — approval requires an admin</span>'
          : '');
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
      ' · Config: ' + escapeHtml(configDescription(meta)) +
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

    // Decision support before approving — see computeScenarioAnomalies()'s
    // own docstring for the methodology. Three sub-lists, capped (5-6
    // rows each) so a genuinely messy scenario doesn't produce an
    // unreadable wall of rows; a clean scenario gets a reassuring
    // all-clear instead of an empty section with no signal either way.
    var anomalies = computeScenarioAnomalies(result);
    var totalAnomalies = anomalies.backtestMisses.length + anomalies.forwardSwings.length + anomalies.wapeOutliers.length;
    bodyHtml += '<div class="dcard" style="margin-top:16px;padding:16px">' +
      '<div class="ch"><h4>Anomalies</h4>' +
      (totalAnomalies ? '<span class="dsubtle" style="margin:0;font-size:.8rem">worth checking before you approve</span>' : '') +
      '</div>';
    if (!totalAnomalies) {
      bodyHtml += '<p class="dsubtle" style="margin:0;display:flex;align-items:center;gap:8px">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" style="flex:none;color:var(--signal)"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        'No anomalies detected — every SKU stayed within its own historical pattern.</p>';
    } else {
      if (anomalies.wapeOutliers.length) {
        bodyHtml += '<div><div class="srow-label" style="margin-bottom:6px">Unreliable SKUs ' +
          '<span class="dsubtle" style="margin:0;font-weight:400">— WAPE far above this scenario\'s overall ' + result.overallWape.toFixed(1) + '%</span></div>' +
          '<div class="table-wrap"><table class="dtable"><thead><tr><th>SKU</th><th>SKU WAPE</th></tr></thead><tbody>' +
          anomalies.wapeOutliers.slice(0, 5).map(function (x) {
            return '<tr><td class="skucell">' + x.sku + '</td><td><span class="pill risk">' + x.skuWape.toFixed(1) + '%</span></td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }
      if (anomalies.backtestMisses.length) {
        bodyHtml += '<div style="margin-top:' + (anomalies.wapeOutliers.length ? '16px' : '0') + '">' +
          '<div class="srow-label" style="margin-bottom:6px">Backtest misses ' +
          '<span class="dsubtle" style="margin:0;font-weight:400">— weeks the model got unusually wrong for that SKU</span></div>' +
          '<div class="table-wrap"><table class="dtable"><thead><tr><th>SKU</th><th>Week</th><th>Actual</th><th>Forecast</th><th>Error</th></tr></thead><tbody>' +
          anomalies.backtestMisses.slice(0, 6).map(function (x) {
            return '<tr><td class="skucell">' + x.sku + '</td><td class="dsubtle" style="margin:0">' + x.week + '</td>' +
              '<td>' + x.actual.toLocaleString() + '</td><td>' + Math.round(x.forecast).toLocaleString() + '</td>' +
              '<td><span class="pill risk">' + (x.pctError * 100).toFixed(0) + '%</span></td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }
      if (anomalies.forwardSwings.length) {
        bodyHtml += '<div style="margin-top:' + (anomalies.wapeOutliers.length || anomalies.backtestMisses.length ? '16px' : '0') + '">' +
          '<div class="srow-label" style="margin-bottom:6px">Forward forecast swings ' +
          '<span class="dsubtle" style="margin:0;font-weight:400">— bigger week-over-week moves than this SKU has historically made</span></div>' +
          '<div class="table-wrap"><table class="dtable"><thead><tr><th>SKU</th><th>Week</th><th>From</th><th>To</th><th>Change</th></tr></thead><tbody>' +
          anomalies.forwardSwings.slice(0, 6).map(function (x) {
            return '<tr><td class="skucell">' + x.sku + '</td><td class="dsubtle" style="margin:0">' + x.week + '</td>' +
              '<td>' + Math.round(x.prevForecast).toLocaleString() + '</td><td>' + Math.round(x.forecast).toLocaleString() + '</td>' +
              '<td><span class="pill warn">' + (x.pctChange > 0 ? '+' : '') + (x.pctChange * 100).toFixed(0) + '%</span></td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }
    }
    bodyHtml += '</div>';

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
    if (scenarioElement('scenarioWorkspace')) {
      var source = scenarioElement('rf-source');
      source.addEventListener('change', function () { source.dataset.edited='true'; syncScenarioInput(); });
      scenarioElement('rf-price-sku').addEventListener('change', syncScenarioPriceOptions);
      scenarioElement('scenarioSchemes').addEventListener('toggle', function (event) {
        if (event.target.open) loadScenarioSchemes();
      });
      scenarioElement('scenarioSchemeOptions').addEventListener('change', function (event) {
        var draft = event.target.dataset.kind === 'draft';
        var chosen = draft ? includedSchemes : excludedSchemes;
        if (event.target.checked === draft) chosen.add(event.target.value);
        else chosen.delete(event.target.value);
        updateScenarioSchemeSummary();
      });
      scenarioElement('scenarioSchemesAll').addEventListener('click', function () { changeScenarioSchemes(true); });
      scenarioElement('scenarioSchemesNone').addEventListener('click', function () { changeScenarioSchemes(false); });
      scenarioElement('scenarioSchemesOpen').addEventListener('click', function () {
        var nav = Array.from(document.querySelectorAll('.dnav li')).find(function (li) { return li.title === 'Discount Schemes'; });
        if (nav) nav.click();
      });
      scenarioElement('scenarioMarketingSpend').addEventListener('toggle', function (event) {
        if (event.currentTarget.open) loadScenarioCampaigns();
      });
      scenarioElement('scenarioHolidayOptions').addEventListener('change', function (event) {
        var input = event.target;
        if (input.checked) excludedHolidayDates.delete(input.value);
        else excludedHolidayDates.add(input.value);
        updateScenarioHolidaySummary();
      });
      scenarioElement('scenarioHolidaysAll').addEventListener('click', function () { changeScenarioHolidays(true); });
      scenarioElement('scenarioHolidaysNone').addEventListener('click', function () { changeScenarioHolidays(false); });
      document.addEventListener('apra:forecast-loaded', function () {
        syncScenarioPriceOptions();
        renderScenarioHolidays();
      });
      scenarioElement('scenarioSaveDraft').addEventListener('click', saveScenarioDraft);
      scenarioElement('scenarioRunSelection').addEventListener('change', function (event) {
        workspaceRunId = event.target.value;
        workspaceChosen = true;
        syncScenarioWorkspace(lastScenarios);
        renderLastRun(lastScenarios);
      });
      scenarioElement('scenarioApplyPlan').addEventListener('click', function (event) {
        var id = workspaceRunId;
        var button = event.currentTarget;
        if (!id || !confirm('Apply this scenario as the approved forecast?')) return;
        approveScenario(id, button).then(function () {
          button.textContent = 'Apply to plan';
          if (workspaceRunId === id) scenarioElement('scenarioComparisonStatus').textContent = 'Scenario applied to the plan.';
        }).catch(function (error) {
          scenarioElement('scenarioComparisonStatus').textContent = error.message || 'Could not apply this scenario.';
        });
      });
      Promise.resolve(window.dashboardSessionReady).then(function () {
        restoreScenarioDraft();
        if (pendingScenarioChoices['rf-campaign']) loadScenarioCampaigns();
        syncScenarioPriceOptions();
        renderScenarioHolidays();
      }).then(loadScenarios).then(loadApprovals);
    } else {
      loadScenarios().then(loadApprovals);
    }

    // Keep the list current when runs are created elsewhere (onboarding fires
    // apra:scenarios-changed) and whenever the Scenarios tab is opened —
    // otherwise a run started after page load never shows up until a reload.
    var refreshScenarioList = function () { loadScenarios().then(loadApprovals); };
    document.addEventListener('apra:scenarios-changed', refreshScenarioList);
    var scenariosNav = Array.prototype.find.call(document.querySelectorAll('.dnav li'), function (li) {
      return li.getAttribute('title') === 'Scenarios';
    });
    if (scenariosNav) scenariosNav.addEventListener('click', refreshScenarioList);

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
