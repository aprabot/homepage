/* ============================================================
   APRABot — Amplify (ad-campaign management: Meta + Google Ads)
   Talks to the Cognito-authenticated /amplify-campaigns and
   /amplify-oauth APIs. Milestone 0: full CRUD against mocked
   platform clients server-side — see each Lambda's own header
   comment for why, and the Connect Accounts panel for why Connect
   buttons are marked "pending" until a real app review clears.
============================================================ */
(function () {
  'use strict';

  var CAMPAIGNS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-campaigns';
  var OAUTH_API      = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-oauth';
  var lastCampaigns = [];
  var editingCampaign = null; // null = create mode; otherwise the campaign object being edited

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  // Same expired-session handling as scenarios.js — a 401 here means the
  // stored token expired mid-session (the page-load guard only checks once).
  function signOutExpired() {
    try {
      localStorage.removeItem('apra_access');
      localStorage.removeItem('apra_id');
      localStorage.removeItem('apra_refresh');
    } catch (e) {}
    window.location.replace('/');
  }

  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, authHeaders());
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { signOutExpired(); throw new Error('session expired'); }
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function money(cents) { return '$' + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function statusPillClass(status) {
    if (status === 'active') return 'ok';
    if (status === 'paused') return 'warn';
    if (status === 'draft') return 'warn';
    return 'risk';
  }

  /* ---------------- Connect Accounts panel ---------------- */

  function renderConnectAccounts(status) {
    ['meta', 'google'].forEach(function (platform) {
      var card = document.getElementById('amp-connect-' + platform);
      if (!card) return;
      var s = status[platform] || { status: 'not_connected' };
      var badge = card.querySelector('.amp-conn-status');
      var btn = card.querySelector('.amp-conn-btn');
      if (s.status === 'connected') {
        badge.textContent = 'Connected' + (s.external_account_id ? ' — ' + s.external_account_id : '');
        badge.className = 'pill ok amp-conn-status';
        btn.textContent = 'Disconnect';
        btn.onclick = function () { disconnectPlatform(platform); };
      } else if (s.status === 'revoked') {
        badge.textContent = 'Disconnected';
        badge.className = 'pill warn amp-conn-status';
        btn.textContent = 'Reconnect';
        btn.onclick = function () { connectPlatform(platform); };
      } else {
        badge.textContent = 'Not connected';
        badge.className = 'pill risk amp-conn-status';
        btn.textContent = 'Connect';
        btn.onclick = function () { connectPlatform(platform); };
      }
    });
  }

  function loadConnectAccounts() {
    apiFetch(OAUTH_API + '/status').then(function (res) {
      if (res.ok) renderConnectAccounts(res.body);
    });
  }

  function connectPlatform(platform) {
    apiFetch(OAUTH_API + '/' + platform + '/start').then(function (res) {
      if (res.ok) {
        window.location.href = res.body.authorize_url;
      } else if (res.status === 501) {
        // Expected state until that platform's app review clears — not an
        // error, just not live yet. See amplify-oauth/handler.py's start().
        alert(platform.charAt(0).toUpperCase() + platform.slice(1) +
          ' integration is pending app review — not connectable yet.');
      } else {
        alert('Could not start the connection: ' + (res.body.error || 'unknown error'));
      }
    });
  }

  function disconnectPlatform(platform) {
    if (!confirm('Disconnect this ' + platform + ' account? Campaigns already created will keep running on the platform itself, but Amplify will stop being able to manage them until you reconnect.')) return;
    apiFetch(OAUTH_API + '/' + platform + '/disconnect', { method: 'POST' }).then(function () {
      loadConnectAccounts();
    });
  }

  /* ---------------- Campaigns panel ---------------- */

  function renderCampaigns(campaigns) {
    lastCampaigns = campaigns;
    var tbody = document.getElementById('amp-campaigns-body');
    var empty = document.getElementById('amp-campaigns-empty');
    if (!tbody) return;
    tbody.innerHTML = '';
    empty.style.display = campaigns.length ? 'none' : '';
    campaigns.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + escHtml(c.name) + '</td>' +
        '<td><span class="pill ' + (c.platform === 'meta' ? 'ok' : 'warn') + '">' + escHtml(c.platform) + '</span></td>' +
        '<td>' + escHtml(c.objective) + '</td>' +
        '<td>' + money(c.daily_budget_cents) + '/day</td>' +
        '<td><span class="pill ' + statusPillClass(c.status) + '">' + escHtml(c.status) +
          (c.pending_write ? ' · syncing…' : '') + '</span></td>' +
        '<td class="amp-row-actions"></td>';
      var actionsTd = tr.querySelector('.amp-row-actions');
      var editBtn = document.createElement('button');
      editBtn.className = 'dbtn'; editBtn.textContent = 'Edit';
      editBtn.onclick = function () { openCampaignModal(c); };
      actionsTd.appendChild(editBtn);
      if (!c.pending_write) {
        var toggleBtn = document.createElement('button');
        toggleBtn.className = 'dbtn';
        var toPause = c.status === 'active';
        toggleBtn.textContent = toPause ? 'Pause' : 'Resume';
        toggleBtn.onclick = function () { setCampaignStatus(c, toPause ? 'pause' : 'resume'); };
        actionsTd.appendChild(toggleBtn);
      }
      tbody.appendChild(tr);
    });
  }

  function loadCampaigns() {
    apiFetch(CAMPAIGNS_API).then(function (res) {
      if (res.ok) renderCampaigns(res.body.campaigns);
    });
  }

  function setCampaignStatus(c, action) {
    apiFetch(CAMPAIGNS_API + '/' + c.platform + '/' + c.campaign_id + '/' + action, { method: 'POST' })
      .then(function (res) {
        if (!res.ok) { alert('Could not ' + action + ' this campaign: ' + (res.body.error || '')); return; }
        loadCampaigns();
      });
  }

  /* ---------------- New / edit campaign modal ---------------- */

  function openCampaignModal(campaign) {
    editingCampaign = campaign || null;
    document.getElementById('amp-modal-title').textContent = campaign ? 'Edit campaign' : 'New campaign';
    document.getElementById('amp-field-name').value = campaign ? campaign.name : '';
    document.getElementById('amp-field-name').disabled = false;
    document.getElementById('amp-field-budget').value = campaign ? (campaign.daily_budget_cents / 100).toFixed(2) : '';
    pillSet('amp-field-platform', campaign ? campaign.platform : 'meta');
    pillSet('amp-field-objective', campaign ? campaign.objective : 'conversions');
    // Platform/objective are fixed once a campaign is created — editing
    // only changes name/budget (see amplify-campaigns/handler.py's
    // update_campaign, which only accepts those two fields).
    setPillsDisabled('amp-field-platform', !!campaign);
    setPillsDisabled('amp-field-objective', !!campaign);
    document.getElementById('amp-modal-error').textContent = '';
    document.getElementById('ampCampaignModal').classList.add('open');
  }

  function closeCampaignModal() {
    document.getElementById('ampCampaignModal').classList.remove('open');
    editingCampaign = null;
  }

  function pillGet(groupId) {
    var active = document.getElementById(groupId).querySelector('.active');
    return active ? active.dataset.v : null;
  }
  function pillSet(groupId, val) {
    document.getElementById(groupId).querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.v === val);
    });
  }
  function setPillsDisabled(groupId, disabled) {
    document.getElementById(groupId).querySelectorAll('button').forEach(function (b) { b.disabled = disabled; });
  }

  function submitCampaignForm(e) {
    e.preventDefault();
    var errEl = document.getElementById('amp-modal-error');
    errEl.textContent = '';
    var name = document.getElementById('amp-field-name').value.trim();
    var budgetDollars = parseFloat(document.getElementById('amp-field-budget').value);
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    if (!budgetDollars || budgetDollars <= 0) { errEl.textContent = 'Daily budget must be a positive amount.'; return; }
    var daily_budget_cents = Math.round(budgetDollars * 100);

    if (editingCampaign) {
      apiFetch(CAMPAIGNS_API + '/' + editingCampaign.platform + '/' + editingCampaign.campaign_id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, daily_budget_cents: daily_budget_cents }),
      }).then(function (res) {
        if (!res.ok) { errEl.textContent = res.body.error || 'Could not save changes.'; return; }
        closeCampaignModal();
        loadCampaigns();
      });
    } else {
      var platform = pillGet('amp-field-platform');
      var objective = pillGet('amp-field-objective');
      apiFetch(CAMPAIGNS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, platform: platform, objective: objective,
          daily_budget_cents: daily_budget_cents,
        }),
      }).then(function (res) {
        if (!res.ok) { errEl.textContent = res.body.error || 'Could not create the campaign.'; return; }
        closeCampaignModal();
        loadCampaigns();
      });
    }
  }

  window.loadConnectAccounts = loadConnectAccounts;
  window.loadCampaigns = loadCampaigns;
  window.openCampaignModal = openCampaignModal;
  window.closeCampaignModal = closeCampaignModal;
  window.submitCampaignForm = submitCampaignForm;

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('ampCampaignForm');
    if (form) form.addEventListener('submit', submitCampaignForm);
    ['amp-field-platform', 'amp-field-objective'].forEach(function (gid) {
      var group = document.getElementById(gid);
      if (!group) return;
      group.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.disabled) return;
          group.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
        });
      });
    });
  });
})();
