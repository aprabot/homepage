/* ============================================================
   APRABot — Amplify (ad-campaign management: Meta + Google Ads)
   Talks to the Cognito-authenticated /amplify-campaigns, /amplify-oauth,
   and (read-only) /forecast APIs. See the Amplify plan for the full
   architecture — Milestone 0 shipped campaign CRUD/OAuth/sync against
   mocked platform clients; this file adds the Overview/Products/AI
   Opportunities/Campaign Builder wizard/Performance redesign on top of it.
============================================================ */
(function () {
  'use strict';

  var CAMPAIGNS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-campaigns';
  var OAUTH_API      = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-oauth';
  var FORECAST_API   = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/forecast';

  var lastCampaigns = [];
  var editingCampaign = null;     // non-wizard modal: null = create mode, else the campaign being edited
  var forecastDataCache = null;   // GET /forecast response, fetched once per page load
  var lastRecommendations = [];
  var wizardRec = null;           // the recommendation the wizard was opened from, or null if blank
  var wizardStep = 1;

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

  // Yen, not USD — forecast/latest.json's avgPrice is JPY (the underlying
  // business is Japanese bottled-water demand); JPY has no commonly-used
  // minor unit, so every money value in this module is a plain integer yen.
  function yen(amount) { return '¥' + Math.round(amount).toLocaleString(); }

  function statusPillClass(status) {
    if (status === 'active') return 'ok';
    if (status === 'paused') return 'warn';
    if (status === 'draft') return 'warn';
    return 'risk';
  }

  /* ---------------- shared forecast-data fetch + SKU stats ----------------
     Ports js/main.js's computeForwardStats() SKU-ranking pattern (volume-
     tiered confidence, trend vs. an equal trailing window) so Products/
     Overview mean the same thing here as they do everywhere else in the
     product, rather than inventing a second definition. */
  function fetchForecastData() {
    if (forecastDataCache) return Promise.resolve(forecastDataCache);
    return apiFetch(FORECAST_API).then(function (res) {
      if (res.ok) forecastDataCache = res.body;
      return forecastDataCache;
    });
  }

  function computeSkuStats(data) {
    var weeks = data.weeks, bt = data.backtestWeeks != null ? data.backtestWeeks : weeks.length;
    var totalWeeks = weeks.length, fwdWeeks = totalWeeks - bt;
    var trailWin = Math.min(fwdWeeks || 1, bt) || 1;
    var sumRange = function (arr, s, e) {
      var sum = 0;
      for (var i = Math.max(0, s); i < e; i++) sum += (arr[i] || 0);
      return sum;
    };
    var rows = [];
    Object.keys(data.skus).forEach(function (sku) {
      var o = data.skus[sku];
      var backtestVol = sumRange(o.a, 0, bt);
      if (backtestVol <= 0) return;
      var trailingActual = sumRange(o.a, bt - trailWin, bt);
      var forwardAll = fwdWeeks ? sumRange(o.f, bt, totalWeeks) : 0;
      var trendPct = trailingActual ? 100 * (forwardAll - trailingActual) / trailingActual : null;
      var nearTerm = sumRange(o.f, bt, bt + 4);
      rows.push({ sku: sku, backtestVol: backtestVol, trendPct: trendPct,
                  nearTermForecast: nearTerm, avgPrice: o.avgPrice });
    });
    rows.sort(function (a, b) { return b.backtestVol - a.backtestVol; });
    var n = rows.length || 1;
    rows.forEach(function (r, i) {
      var pct = i / n;
      r.confidenceTier = pct < 0.15 ? 'High' : pct < 0.5 ? 'Medium' : 'Lower';
    });
    return rows;
  }

  function skuLabel(labels, sku) {
    var l = labels[sku];
    return (l && l.label) || sku;
  }
  function skuImage(labels, sku) {
    return (labels[sku] && labels[sku].image_url) || null;
  }

  var labelsCache = null;
  function fetchSkuLabels() {
    if (labelsCache) return Promise.resolve(labelsCache);
    return apiFetch(CAMPAIGNS_API + '/sku-labels').then(function (res) {
      labelsCache = res.ok ? res.body : {};
      return labelsCache;
    });
  }

  /* ---------------- Overview panel ---------------- */

  function drawRevenueChart(canvas, weeks, actual, forecast, backtestWeeks) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = rect.width || 560, H = rect.height || 220;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var padL = 50, padR = 14, padT = 14, padB = 26;
    var vals = actual.concat(forecast).filter(function (v) { return v != null; });
    var vMax = Math.max.apply(null, vals) * 1.15 || 1;
    var N = weeks.length;
    var X = function (i) { return padL + i * (W - padL - padR) / Math.max(1, N - 1); };
    var Y = function (v) { return padT + (H - padT - padB) * (1 - v / vMax); };
    ctx.strokeStyle = 'rgba(127,127,150,.18)'; ctx.lineWidth = 1;
    for (var g = 0; g <= 3; g++) {
      var y = padT + (H - padT - padB) * g / 3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    }
    var drawLine = function (arr, color, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.setLineDash(dash || []);
      ctx.beginPath();
      var started = false;
      arr.forEach(function (v, i) {
        if (v == null) return;
        var x = X(i), yy = Y(v);
        if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    drawLine(actual, '#1b66d6');
    drawLine(forecast, '#7c6af2', [6, 4]);
    ctx.fillStyle = 'rgba(127,127,150,.8)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    for (var i = 0; i < N; i += Math.max(1, Math.round(N / 6))) {
      ctx.fillText((weeks[i] || '').slice(5), X(i), H - 8);
    }
  }

  function renderOverview(data, recs) {
    var bt = data.backtestWeeks != null ? data.backtestWeeks : data.weeks.length;
    var stats = computeSkuStats(data);
    var revenue = stats.reduce(function (sum, r) { return sum + r.nearTermForecast * (r.avgPrice || 0); }, 0);
    document.getElementById('ovKpiRevenue').textContent = yen(revenue);

    var totalSpend = recs.reduce(function (s, r) { return s + r.suggested_daily_budget_yen * r.suggested_duration_days; }, 0);
    document.getElementById('ovKpiSpend').textContent = yen(totalSpend);

    var overstockCount = recs.filter(function (r) { return r.archetype === 'clear_overstock'; }).length;
    document.getElementById('ovKpiInventory').textContent = overstockCount;
    document.getElementById('ovKpiOpps').textContent = recs.length;

    var canvas = document.getElementById('ovRevenueCanvas');
    if (canvas) drawRevenueChart(canvas, data.weeks, data.all.a, data.all.f, bt);

    var topRecs = document.getElementById('ovTopRecs');
    if (topRecs) {
      topRecs.innerHTML = '';
      recs.slice(0, 2).forEach(function (rec) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);gap:10px';
        row.innerHTML =
          '<div><div style="font-weight:600">' + escHtml(rec.label) + '</div>' +
          '<div class="dsubtle" style="margin:0;font-size:12px">' + (rec.predicted_purchases_low) + '-' +
          (rec.predicted_purchases_high) + ' purchases · ' + rec.predicted_roas + 'x ROAS</div></div>';
        var btn = document.createElement('button');
        btn.className = 'dbtn'; btn.textContent = 'Create Campaign';
        btn.onclick = function () { openCampaignWizard(rec); };
        row.appendChild(btn);
        topRecs.appendChild(row);
      });
      if (!recs.length) topRecs.innerHTML = '<p class="dsubtle">No recommendations right now.</p>';
    }
  }

  function loadOverview() {
    Promise.all([fetchForecastData(), apiFetch(CAMPAIGNS_API + '/recommendations')]).then(function (results) {
      var data = results[0], recRes = results[1];
      if (!data) return;
      lastRecommendations = recRes.ok ? (recRes.body.recommendations || []) : [];
      renderOverview(data, lastRecommendations);
    });
  }

  /* ---------------- Products panel ---------------- */

  function renderProducts(stats, labels) {
    var tbody = document.getElementById('amp-products-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    stats.forEach(function (row) {
      var tr = document.createElement('tr');
      var img = skuImage(labels, row.sku);
      var trendStr = row.trendPct == null ? 'n/a' : (row.trendPct >= 0 ? '+' : '') + row.trendPct.toFixed(1) + '%';
      tr.innerHTML =
        '<td>' + (img ? '<img class="amp-sku-thumb" src="' + escHtml(img) + '">' : '') +
          escHtml(skuLabel(labels, row.sku)) + '</td>' +
        '<td>' + Math.round(row.backtestVol).toLocaleString() + '</td>' +
        '<td>' + trendStr + '</td>' +
        '<td><span class="pill ' + (row.confidenceTier === 'High' ? 'ok' : row.confidenceTier === 'Medium' ? 'warn' : 'risk') + '">' +
          row.confidenceTier + '</span></td>' +
        '<td><button class="dbtn amp-edit-label-btn" style="padding:5px 11px;font-size:12.5px">Edit label</button></td>';
      tr.querySelector('.amp-edit-label-btn').onclick = function () { editSkuLabel(row.sku, labels); };
      tbody.appendChild(tr);
    });
  }

  function editSkuLabel(sku, labels) {
    var current = labels[sku] || {};
    var label = window.prompt('Display name for ' + sku + ' (leave blank to revert to the plain SKU id):', current.label || '');
    if (label === null) return; // cancelled
    var imageUrl = window.prompt('Image URL (must start with https://, leave blank for none):', current.image_url || '');
    if (imageUrl === null) return;
    apiFetch(CAMPAIGNS_API + '/sku-labels', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: sku, label: label, image_url: imageUrl }),
    }).then(function (res) {
      if (!res.ok) { alert(res.body.error || 'Could not save label'); return; }
      labelsCache = null; // force refetch so every panel picks up the change
      window.loadProducts();
    });
  }

  function loadProducts() {
    Promise.all([fetchForecastData(), fetchSkuLabels()]).then(function (results) {
      var data = results[0], labels = results[1];
      if (!data) return;
      renderProducts(computeSkuStats(data), labels);
    });
  }

  /* ---------------- AI Opportunities panel ---------------- */

  function renderOpportunities(recs, labels) {
    var list = document.getElementById('amp-opportunities-list');
    var empty = document.getElementById('amp-opportunities-empty');
    if (!list) return;
    list.innerHTML = '';
    empty.style.display = recs.length ? 'none' : '';
    recs.forEach(function (rec) {
      var card = document.createElement('div');
      card.className = 'amp-rec-card';
      var img = rec.image_url;
      card.innerHTML =
        (img ? '<img class="amp-rec-thumb" src="' + escHtml(img) + '">' : '') +
        '<div class="amp-rec-main">' +
          '<h4>' + escHtml(rec.label) +
            '<span class="pill ' + (rec.priority === 'high' ? 'ok' : 'warn') + '">' +
              (rec.priority === 'high' ? 'High Priority' : 'Watch') + '</span></h4>' +
          '<ul class="amp-rec-why">' + rec.why.map(function (w) { return '<li>' + escHtml(w) + '</li>'; }).join('') + '</ul>' +
        '</div>' +
        '<div class="amp-rec-stats">' +
          '<div><div class="lbl">Suggested Budget</div><div class="val">' + yen(rec.suggested_daily_budget_yen) + '/day</div></div>' +
          '<div><div class="lbl">Duration</div><div class="val">' + rec.suggested_duration_days + ' days</div></div>' +
          '<div><div class="lbl">Predicted Purchases</div><div class="val">' + rec.predicted_purchases_low + '-' + rec.predicted_purchases_high + '</div></div>' +
          '<div><div class="lbl">ROAS</div><div class="val">' + rec.predicted_roas + 'x</div></div>' +
          '<div style="grid-column:1/-1"><div class="lbl">Confidence</div><div class="val">' + rec.confidence_pct + '%</div></div>' +
        '</div>';
      var btnWrap = document.createElement('div');
      btnWrap.style.cssText = 'display:flex;align-items:center';
      var btn = document.createElement('button');
      btn.className = 'btn btn-pri'; btn.textContent = 'Create Campaign';
      btn.onclick = function () { openCampaignWizard(rec); };
      btnWrap.appendChild(btn);
      card.appendChild(btnWrap);
      list.appendChild(card);
    });
  }

  function loadOpportunities() {
    Promise.all([apiFetch(CAMPAIGNS_API + '/recommendations'), fetchSkuLabels()]).then(function (results) {
      var recRes = results[0];
      lastRecommendations = recRes.ok ? (recRes.body.recommendations || []) : [];
      renderOpportunities(lastRecommendations, results[1]);
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
        '<td>' + yen(c.daily_budget_yen) + '/day</td>' +
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

  /* ---------------- Performance panel ---------------- */

  function renderPerformanceList(campaigns) {
    var list = document.getElementById('amp-performance-list');
    if (!list) return;
    list.innerHTML = '';
    if (!campaigns.length) {
      list.innerHTML = '<p class="dsubtle" style="padding:10px;margin:0">No campaigns yet.</p>';
      return;
    }
    campaigns.forEach(function (c) {
      var item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px';
      item.innerHTML = '<div style="font-weight:600;font-size:13.5px">' + escHtml(c.name) + '</div>' +
        '<div class="dsubtle" style="margin:0;font-size:11.5px">' + escHtml(c.platform) + ' · ' + escHtml(c.status) + '</div>';
      item.onclick = function () {
        list.querySelectorAll('div[data-active]').forEach(function (x) { x.style.background = ''; x.removeAttribute('data-active'); });
        item.style.background = 'var(--signal-soft)'; item.setAttribute('data-active', '1');
        loadPerformanceDetail(c);
      };
      list.appendChild(item);
    });
  }

  function loadPerformanceDetail(c) {
    var detail = document.getElementById('amp-performance-detail');
    detail.innerHTML = '<p class="dsubtle" style="text-align:center;margin:40px 0">Loading…</p>';
    apiFetch(CAMPAIGNS_API + '/' + c.platform + '/' + c.campaign_id + '/performance').then(function (res) {
      if (!res.ok) { detail.innerHTML = '<p class="dsubtle">Could not load performance data.</p>'; return; }
      var totals = res.body.totals, days = res.body.days;
      if (!days.length) {
        detail.innerHTML = '<p class="dsubtle" style="text-align:center;margin:40px 0">No performance data synced yet for this campaign.</p>';
        return;
      }
      detail.innerHTML =
        '<div class="ch"><h4>' + escHtml(c.name) + '</h4></div>' +
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin:14px 0">' +
          '<div class="kpi" style="padding:14px"><div class="t">Impressions</div><div class="v" style="font-size:1.4rem">' + totals.impressions.toLocaleString() + '</div></div>' +
          '<div class="kpi" style="padding:14px"><div class="t">Clicks</div><div class="v" style="font-size:1.4rem">' + totals.clicks.toLocaleString() + '</div></div>' +
          '<div class="kpi" style="padding:14px"><div class="t">Spend</div><div class="v" style="font-size:1.4rem">' + yen(totals.spend_yen) + '</div></div>' +
          '<div class="kpi" style="padding:14px"><div class="t">Conversions</div><div class="v" style="font-size:1.4rem">' + totals.conversions.toLocaleString() + '</div></div>' +
        '</div>' +
        '<table class="amp-table"><thead><tr><th>Date</th><th>Impressions</th><th>Clicks</th><th>Spend</th><th>Conversions</th></tr></thead><tbody>' +
        days.map(function (d) {
          return '<tr><td>' + d.date + '</td><td>' + d.impressions + '</td><td>' + d.clicks + '</td><td>' + yen(d.spend_yen) + '</td><td>' + d.conversions + '</td></tr>';
        }).join('') + '</tbody></table>';
    });
  }

  function loadPerformanceList() {
    apiFetch(CAMPAIGNS_API).then(function (res) {
      if (res.ok) renderPerformanceList(res.body.campaigns);
    });
  }

  /* ---------------- Connect Accounts (Integrations & Settings) ---------------- */

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

  /* ---------------- Simple create-from-scratch campaign modal ---------------- */

  function openCampaignModal(campaign) {
    editingCampaign = campaign || null;
    document.getElementById('amp-modal-title').textContent = campaign ? 'Edit campaign' : 'New campaign';
    document.getElementById('amp-field-name').value = campaign ? campaign.name : '';
    document.getElementById('amp-field-budget').value = campaign ? campaign.daily_budget_yen : '';
    pillSet('amp-field-platform', campaign ? campaign.platform : 'meta');
    pillSet('amp-field-objective', campaign ? campaign.objective : 'conversions');
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
    var budget = parseInt(document.getElementById('amp-field-budget').value, 10);
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    if (!budget || budget <= 0) { errEl.textContent = 'Daily budget must be a positive amount.'; return; }

    if (editingCampaign) {
      apiFetch(CAMPAIGNS_API + '/' + editingCampaign.platform + '/' + editingCampaign.campaign_id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, daily_budget_yen: budget }),
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
        body: JSON.stringify({ name: name, platform: platform, objective: objective, daily_budget_yen: budget }),
      }).then(function (res) {
        if (!res.ok) { errEl.textContent = res.body.error || 'Could not create the campaign.'; return; }
        closeCampaignModal();
        loadCampaigns();
      });
    }
  }

  /* ---------------- Campaign Builder wizard ---------------- */

  function openCampaignWizard(rec) {
    wizardRec = rec;
    wizardStep = 1;
    document.getElementById('amp-wiz-title').textContent =
      'Create ' + (rec ? (rec.suggested_platform || 'Meta') : 'Meta') + ' Campaign';

    var summary = document.getElementById('amp-wiz-rec-summary');
    if (rec) {
      summary.innerHTML =
        '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
          (rec.image_url ? '<img class="amp-rec-thumb" style="width:80px;height:80px" src="' + escHtml(rec.image_url) + '">' : '') +
          '<div style="flex:1;min-width:220px">' +
            '<span class="pill ' + (rec.priority === 'high' ? 'ok' : 'warn') + '">' +
              (rec.priority === 'high' ? 'High Opportunity' : 'Watch') + '</span>' +
            '<h4 style="margin:8px 0 4px">' + escHtml(rec.label) + '</h4>' +
            '<ul class="amp-rec-why">' + rec.why.map(function (w) { return '<li>' + escHtml(w) + '</li>'; }).join('') + '</ul>' +
          '</div>' +
          '<div class="amp-rec-stats">' +
            '<div><div class="lbl">Suggested Budget</div><div class="val">' + yen(rec.suggested_daily_budget_yen) + '/mo</div></div>' +
            '<div><div class="lbl">Duration</div><div class="val">' + rec.suggested_duration_days + ' days</div></div>' +
            '<div><div class="lbl">Predicted Purchases</div><div class="val">' + rec.predicted_purchases_low + '-' + rec.predicted_purchases_high + '</div></div>' +
            '<div><div class="lbl">ROAS</div><div class="val">' + rec.predicted_roas + 'x</div></div>' +
          '</div>' +
        '</div>';
    } else {
      summary.innerHTML = '<p class="dsubtle">Starting a new campaign from scratch — set its details on the next step.</p>';
    }

    // Prefill step 2 fields from the recommendation (or sensible blanks).
    pillSet('wiz-field-platform', 'meta');
    pillSet('wiz-field-objective', 'conversions');
    document.getElementById('wiz-field-budget').value = rec ? rec.suggested_daily_budget_yen : '';
    document.getElementById('wiz-field-name').value = rec ? ('Promote ' + rec.label) : '';
    document.getElementById('wiz-field-duration').value = rec ? rec.suggested_duration_days : 14;
    document.getElementById('wiz-ad-title').textContent = 'My Online Store';
    document.getElementById('wiz-ad-name').textContent = rec ? rec.label : 'Product';
    var img = document.getElementById('wiz-ad-image');
    if (rec && rec.image_url) { img.src = rec.image_url; img.style.display = ''; }
    else { img.style.display = 'none'; }

    wizardGoto(1);
    document.getElementById('ampWizardModal').classList.add('open');
  }

  function closeWizard() {
    document.getElementById('ampWizardModal').classList.remove('open');
    wizardRec = null;
  }

  function wizardGoto(step) {
    wizardStep = step;
    [1, 2, 3].forEach(function (n) {
      document.getElementById('amp-wiz-step' + n).style.display = (n === step) ? '' : 'none';
    });
    document.querySelectorAll('.amp-wiz-steps .step').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.dataset.step, 10) === step);
    });
    if (step === 3) {
      var platform = pillGet('wiz-field-platform');
      var objective = pillGet('wiz-field-objective');
      var budget = document.getElementById('wiz-field-budget').value;
      var name = document.getElementById('wiz-field-name').value;
      var duration = document.getElementById('wiz-field-duration').value;
      document.getElementById('amp-wiz-launch-summary').innerHTML =
        '<div class="amp-wiz-main">' +
          '<div class="amp-wiz-field"><div class="lbl">Campaign Name</div><div class="val">' + escHtml(name) + '</div></div>' +
          '<div class="amp-wiz-field"><div class="lbl">Platform</div><div class="val">' + escHtml(platform) + '</div></div>' +
          '<div class="amp-wiz-field"><div class="lbl">Objective</div><div class="val">' + escHtml(objective) + '</div></div>' +
          '<div class="amp-wiz-field"><div class="lbl">Daily Budget</div><div class="val">' + yen(budget || 0) + '</div></div>' +
          '<div class="amp-wiz-field"><div class="lbl">Duration</div><div class="val">' + escHtml(duration) + ' days</div></div>' +
          '<div class="amp-wiz-field"><div class="lbl">Total Budget</div><div class="val">' + yen((budget || 0) * (duration || 1)) + '</div></div>' +
        '</div>';
    }
  }

  function submitWizard() {
    var errEl = document.getElementById('amp-wiz-launch-error');
    errEl.textContent = '';
    var name = document.getElementById('wiz-field-name').value.trim();
    var budget = parseInt(document.getElementById('wiz-field-budget').value, 10);
    var platform = pillGet('wiz-field-platform');
    var objective = pillGet('wiz-field-objective');
    if (!name) { errEl.textContent = 'Campaign name is required.'; return; }
    if (!budget || budget <= 0) { errEl.textContent = 'Daily budget must be a positive amount.'; return; }

    var btn = document.getElementById('amp-wiz-launch-btn');
    btn.disabled = true; btn.textContent = 'Launching…';
    apiFetch(CAMPAIGNS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, platform: platform, objective: objective, daily_budget_yen: budget }),
    }).then(function (res) {
      btn.disabled = false; btn.textContent = 'Launch Campaign';
      if (!res.ok) { errEl.textContent = res.body.error || 'Could not launch the campaign.'; return; }
      closeWizard();
      document.querySelector('li[title="Campaigns"]').click();
    });
  }

  window.loadOverview = loadOverview;
  window.loadProducts = loadProducts;
  window.loadOpportunities = loadOpportunities;
  window.loadConnectAccounts = loadConnectAccounts;
  window.loadCampaigns = loadCampaigns;
  window.loadPerformanceList = loadPerformanceList;
  window.openCampaignModal = openCampaignModal;
  window.closeCampaignModal = closeCampaignModal;
  window.submitCampaignForm = submitCampaignForm;
  window.openCampaignWizard = openCampaignWizard;
  window.closeWizard = closeWizard;
  window.wizardGoto = wizardGoto;
  window.submitWizard = submitWizard;

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('ampCampaignForm');
    if (form) form.addEventListener('submit', submitCampaignForm);
    ['amp-field-platform', 'amp-field-objective', 'wiz-field-platform', 'wiz-field-objective'].forEach(function (gid) {
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
