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

  // Display-only $ relabel (explicit product choice) — every underlying
  // number here is still a real JPY amount from forecast/latest.json (the
  // business is Japanese bottled-water demand), just prefixed with $
  // instead of ¥. NOT a real USD conversion — ¥5000/day literally shows as
  // "$5,000/day", not its ~$33 real-dollar equivalent. Function kept named
  // `yen` on purpose: the values passing through it are still yen.
  function yen(amount) { return '$' + Math.round(amount).toLocaleString(); }

  function statusPillClass(status) {
    if (status === 'active') return 'ok';
    if (status === 'paused') return 'warn';
    if (status === 'draft') return 'warn';
    return 'risk';
  }

  // Real brand marks (Simple Icons, MIT-licensed), inlined so the real Meta
  // and Google logos show up anywhere a platform is named, instead of a
  // generic colored dot or plain text.
  var PLATFORM_ICONS = {
    meta: '<svg class="pf-ic" viewBox="0 0 24 24" width="14" height="14" fill="#0668E1" aria-hidden="true"><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"/></svg>',
    google: '<svg class="pf-ic" viewBox="0 0 24 24" width="14" height="14" fill="#4285F4" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
    shopify: '<svg class="pf-ic" viewBox="0 0 24 24" width="14" height="14" fill="#95BF47" aria-hidden="true"><path d="M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z"/></svg>'
  };

  function platformIcon(platform) { return PLATFORM_ICONS[platform] || ''; }
  function platformLabel(platform) {
    if (platform === 'meta') return 'Meta';
    if (platform === 'google') return 'Google';
    if (platform === 'shopify') return 'Shopify';
    return escHtml(platform || '');
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

  var labelsCache = null;
  function fetchSkuLabels() {
    if (labelsCache) return Promise.resolve(labelsCache);
    return apiFetch(CAMPAIGNS_API + '/sku-labels').then(function (res) {
      labelsCache = res.ok ? res.body : {};
      return labelsCache;
    });
  }

  var shopifyStatusCache = null;
  function fetchShopifyStatus() {
    if (shopifyStatusCache !== null) return Promise.resolve(shopifyStatusCache);
    return apiFetch(OAUTH_API + '/status').then(function (res) {
      shopifyStatusCache = !!(res.ok && res.body.shopify && res.body.shopify.status === 'connected');
      return shopifyStatusCache;
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
  // Two independent catalogs, deliberately not merged: Shopify (live, read-
  // only) and a manual list an admin maintains by hand. There's no reliable
  // automatic match between a forecast SKU and either of these (different
  // systems, no shared identifier), so the forecast-SKU table that used to
  // live here is gone — AI Opportunities/Campaign Builder still read
  // forecast data + sku_labels.json under the hood, unaffected by this.

  function loadProducts() {
    loadShopifyCatalog();
    loadManualCatalog();
  }

  // Shown immediately once Shopify is connected — the real, live catalog,
  // no per-SKU action needed. Separate from the forecast-SKU table below
  // it: there's no reliable automatic match between the two (different
  // systems, no shared identifier), so this is a plain read-only view of
  // what's actually in the store, not an attempt to merge the two.
  function ampThumbOrPlaceholder(imageUrl) {
    if (imageUrl) return '<img class="amp-sku-thumb" src="' + escHtml(imageUrl) + '">';
    return '<span class="amp-thumb-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="16" height="16">' +
      '<path d="M21 8l-9-5-9 5 9 5 9-5Z" stroke-linejoin="round"/><path d="M3 8v8l9 5 9-5V8M12 13v8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  }

  function ampInventoryPillClass(n) {
    if (n == null) return '';
    if (n <= 0) return 'pill risk';
    if (n < 10) return 'pill warn';
    return 'pill ok';
  }

  // Full catalog lives client-side once fetched — search/sort are purely
  // local filters over it, no new backend calls needed for either.
  var shopifyCatalogState = { products: [], salesCurrency: null, salesWindowDays: null,
    search: '', sortKey: null, sortDir: 1 };
  var shopifyPollTimer = null;

  function shopifyProductSortValue(p, key) {
    if (key === 'product') return (p.title || '').toLowerCase();
    var sum = 0;
    (p.variants || []).forEach(function (v) {
      if (key === 'inventory') sum += v.inventory_on_hand || 0;
      if (key === 'sold') sum += v.units_sold_60d || 0;
      if (key === 'revenue') sum += v.revenue_60d || 0;
    });
    return sum;
  }

  function shopifyProductMatchesSearch(p, term) {
    if (!term) return true;
    term = term.toLowerCase();
    if ((p.title || '').toLowerCase().indexOf(term) !== -1) return true;
    return (p.variants || []).some(function (v) {
      return ((v.title || '').toLowerCase().indexOf(term) !== -1) ||
        ((v.sku || '').toLowerCase().indexOf(term) !== -1);
    });
  }

  function setShopifyEmptyMessage(text) {
    var el = document.getElementById('amp-shopify-catalog-empty-text');
    if (el) el.textContent = text;
  }

  function setShopifyRefreshSpinning(spinning) {
    var btn = document.getElementById('amp-shopify-refresh-btn');
    if (!btn) return;
    btn.disabled = spinning;
    btn.innerHTML = spinning ? '<span class="amp-spinner"></span>Syncing…' : 'Refresh';
  }

  function renderShopifyCatalog() {
    var products = shopifyCatalogState.products;
    var empty = document.getElementById('amp-shopify-catalog-empty');
    var table = document.getElementById('amp-shopify-catalog-table');
    var tbody = document.getElementById('amp-shopify-catalog-body');
    var unitsCol = document.getElementById('amp-shopify-units-col');
    var revenueCol = document.getElementById('amp-shopify-revenue-col');
    var kpis = document.getElementById('amp-catalog-kpis');
    var searchBox = document.getElementById('amp-shopify-search');
    if (!products || !products.length) {
      empty.style.display = '';
      table.style.display = 'none';
      kpis.style.display = 'none';
      searchBox.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    table.style.display = '';
    searchBox.style.display = '';

    // Sales columns are only present when the connected store's token has
    // the read_orders scope (added after Shopify catalog/inventory first
    // shipped) — omit them entirely for a store that hasn't reconnected
    // yet, rather than show an all-blank column.
    var hasSales = products.some(function (p) { return (p.variants || []).some(function (v) { return 'units_sold_60d' in v; }); });
    unitsCol.style.display = hasSales ? '' : 'none';
    revenueCol.style.display = hasSales ? '' : 'none';
    if (hasSales) {
      unitsCol.textContent = 'Units sold (' + (shopifyCatalogState.salesWindowDays || 60) + 'd)';
      revenueCol.textContent = 'Revenue (' + (shopifyCatalogState.salesWindowDays || 60) + 'd)';
    }

    // Summary strip reflects the FULL catalog, not the filtered/sorted view.
    var totalStock = 0, totalSold = 0, totalRevenue = 0;
    products.forEach(function (p) {
      (p.variants || []).forEach(function (v) {
        if (v.inventory_on_hand != null) totalStock += v.inventory_on_hand;
        totalSold += v.units_sold_60d || 0;
        totalRevenue += v.revenue_60d || 0;
      });
    });
    kpis.style.display = '';
    document.getElementById('amp-kpi-products').textContent = products.length.toLocaleString();
    document.getElementById('amp-kpi-stock').textContent = totalStock.toLocaleString();
    document.getElementById('amp-kpi-sold-card').style.display = hasSales ? '' : 'none';
    document.getElementById('amp-kpi-revenue-card').style.display = hasSales ? '' : 'none';
    if (hasSales) {
      document.getElementById('amp-kpi-sold').textContent = totalSold.toLocaleString();
      document.getElementById('amp-kpi-revenue').textContent = totalRevenue.toFixed(2) + ' ' + (shopifyCatalogState.salesCurrency || '');
    }

    // Sort-header arrow indicators.
    document.querySelectorAll('#amp-shopify-catalog-table .amp-sortable').forEach(function (th) {
      th.querySelectorAll('.amp-sort-arrow').forEach(function (a) { a.remove(); });
      if (th.dataset.sortKey === shopifyCatalogState.sortKey) {
        var arrow = document.createElement('span');
        arrow.className = 'amp-sort-arrow';
        arrow.textContent = shopifyCatalogState.sortDir === 1 ? '▲' : '▼';
        th.appendChild(arrow);
      }
    });

    var visible = products.filter(function (p) { return shopifyProductMatchesSearch(p, shopifyCatalogState.search); });
    if (shopifyCatalogState.sortKey) {
      var key = shopifyCatalogState.sortKey, dir = shopifyCatalogState.sortDir;
      visible = visible.slice().sort(function (a, b) {
        var av = shopifyProductSortValue(a, key), bv = shopifyProductSortValue(b, key);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    tbody.innerHTML = '';
    if (!visible.length) {
      var noMatch = document.createElement('tr');
      noMatch.innerHTML = '<td colspan="6" class="dsubtle" style="text-align:center;padding:20px">No products match "' +
        escHtml(shopifyCatalogState.search) + '"</td>';
      tbody.appendChild(noMatch);
      return;
    }
    visible.forEach(function (p) {
      var variants = p.variants || [];
      variants.forEach(function (v, i) {
        var tr = document.createElement('tr');
        if (i === 0 && variants.length > 1) tr.className = 'amp-group-start';
        var invStr = v.inventory_on_hand != null
          ? '<span class="' + ampInventoryPillClass(v.inventory_on_hand) + '">' + v.inventory_on_hand.toLocaleString() + '</span>'
          : '—';
        var variantLabel = v.title && v.title !== 'Default Title' ? v.title : '';
        tr.innerHTML =
          '<td>' + (i === 0 ? ampThumbOrPlaceholder(p.image_url) + escHtml(p.title) : '') + '</td>' +
          '<td>' + (i > 0 && variantLabel ? '<span class="amp-variant-indent">↳</span>' : '') + escHtml(variantLabel) + '</td>' +
          '<td class="mono">' + escHtml(v.sku || '—') + '</td>' +
          '<td>' + invStr + '</td>' +
          (hasSales ?
            '<td>' + (v.units_sold_60d || 0).toLocaleString() + '</td>' +
            '<td>' + v.revenue_60d.toFixed(2) + ' ' + escHtml(shopifyCatalogState.salesCurrency || '') + '</td>' : '');
        tbody.appendChild(tr);
      });
    });
  }

  function pollShopifyCatalog() {
    if (shopifyPollTimer) return; // already polling
    shopifyPollTimer = setTimeout(function () {
      shopifyPollTimer = null;
      loadShopifyCatalog();
    }, 2500);
  }

  function loadShopifyCatalog() {
    fetchShopifyStatus().then(function (connected) {
      if (!connected) {
        shopifyCatalogState.products = [];
        setShopifyRefreshSpinning(false);
        setShopifyEmptyMessage('Connect Shopify (Getting Started, or Integrations & Settings) to see your real catalog and live inventory here.');
        renderShopifyCatalog();
        return;
      }
      apiFetch(CAMPAIGNS_API + '/shopify-products').then(function (res) {
        if (!res.ok) { setShopifyRefreshSpinning(false); return; }
        shopifyCatalogState.products = res.body.products || [];
        shopifyCatalogState.salesCurrency = res.body.sales_currency || null;
        shopifyCatalogState.salesWindowDays = res.body.sales_window_days || null;
        if (res.body.status === 'syncing') {
          setShopifyRefreshSpinning(true);
          if (!shopifyCatalogState.products.length) {
            setShopifyEmptyMessage('Syncing your Shopify catalog for the first time — this can take a minute for a large store…');
          }
          renderShopifyCatalog();
          pollShopifyCatalog();
        } else {
          setShopifyRefreshSpinning(false);
          renderShopifyCatalog();
        }
      });
    });
  }

  function refreshShopifyCatalog() {
    setShopifyRefreshSpinning(true);
    apiFetch(CAMPAIGNS_API + '/shopify-products/sync', { method: 'POST' }).then(function (res) {
      if (!res.ok && res.status !== 409) {
        setShopifyRefreshSpinning(false);
        alert(res.body.error || 'Could not start a refresh');
        return;
      }
      pollShopifyCatalog();
    });
  }

  // Manual catalog — a plain, admin-maintained list fully independent of
  // Shopify and of forecast SKUs (for products Shopify doesn't have, or
  // orgs with no Shopify connection at all).
  function renderManualCatalog(items) {
    var empty = document.getElementById('amp-manual-catalog-empty');
    var table = document.getElementById('amp-manual-catalog-table');
    var tbody = document.getElementById('amp-manual-catalog-body');
    if (!items.length) { empty.style.display = ''; table.style.display = 'none'; return; }
    empty.style.display = 'none';
    table.style.display = '';
    tbody.innerHTML = '';
    items.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + ampThumbOrPlaceholder(item.image_url) + escHtml(item.name) + '</td>' +
        '<td class="amp-row-actions"></td>';
      var actionsTd = tr.querySelector('.amp-row-actions');
      var editBtn = document.createElement('button');
      editBtn.className = 'dbtn'; editBtn.textContent = 'Edit';
      editBtn.onclick = function () { editManualCatalogItem(item); };
      actionsTd.appendChild(editBtn);
      var delBtn = document.createElement('button');
      delBtn.className = 'dbtn'; delBtn.textContent = 'Delete';
      delBtn.onclick = function () { deleteManualCatalogItem(item); };
      actionsTd.appendChild(delBtn);
      tbody.appendChild(tr);
    });
  }

  function loadManualCatalog() {
    apiFetch(CAMPAIGNS_API + '/manual-catalog').then(function (res) {
      var items = res.ok ? Object.keys(res.body).map(function (k) { return res.body[k]; }) : [];
      items.sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
      renderManualCatalog(items);
    });
  }

  function addManualCatalogItem() {
    var name = window.prompt('Product name:');
    if (name === null || !name.trim()) return;
    var imageUrl = window.prompt('Image URL (must start with https://, leave blank for none):', '');
    if (imageUrl === null) return;
    apiFetch(CAMPAIGNS_API + '/manual-catalog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), image_url: imageUrl }),
    }).then(function (res) {
      if (!res.ok) { alert(res.body.error || 'Could not add product'); return; }
      loadManualCatalog();
    });
  }

  function editManualCatalogItem(item) {
    var name = window.prompt('Product name:', item.name || '');
    if (name === null || !name.trim()) return;
    var imageUrl = window.prompt('Image URL (must start with https://, leave blank for none):', item.image_url || '');
    if (imageUrl === null) return;
    apiFetch(CAMPAIGNS_API + '/manual-catalog/' + item.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), image_url: imageUrl }),
    }).then(function (res) {
      if (!res.ok) { alert(res.body.error || 'Could not save product'); return; }
      loadManualCatalog();
    });
  }

  function deleteManualCatalogItem(item) {
    if (!confirm('Delete "' + item.name + '" from the manual catalog?')) return;
    apiFetch(CAMPAIGNS_API + '/manual-catalog/' + item.id, { method: 'DELETE' }).then(function (res) {
      if (!res.ok) { alert(res.body.error || 'Could not delete product'); return; }
      loadManualCatalog();
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
        '<td><span class="pill ' + (c.platform === 'meta' ? 'ok' : 'warn') + '" style="display:inline-flex;align-items:center;gap:5px">' + platformIcon(c.platform) + platformLabel(c.platform) + '</span></td>' +
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
        '<div class="dsubtle" style="margin:0;font-size:11.5px;display:flex;align-items:center;gap:5px">' + platformIcon(c.platform) + platformLabel(c.platform) + ' · ' + escHtml(c.status) + '</div>';
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
    // querySelectorAll, not getElementById — the same platform's connect
    // card can appear more than once (Integrations & Settings, and the
    // Getting Started panel's Shopify CTA), and both must stay in sync
    // from this one status fetch.
    ['meta', 'google', 'shopify'].forEach(function (platform) {
      document.querySelectorAll('.amp-connect-card[data-platform="' + platform + '"]').forEach(function (card) {
        var s = status[platform] || { status: 'not_connected' };
        var badge = card.querySelector('.amp-conn-status');
        var btn = card.querySelector('.amp-conn-btn');
        var shopInput = card.querySelector('.amp-shop-input');
        if (s.status === 'connected') {
          badge.textContent = 'Connected' + (s.external_account_id ? ' — ' + s.external_account_id : '');
          badge.className = 'pill ok amp-conn-status';
          btn.textContent = 'Disconnect';
          btn.onclick = function () { disconnectPlatform(platform); };
          if (shopInput) shopInput.style.display = 'none';
        } else {
          badge.textContent = s.status === 'revoked' ? 'Disconnected' : 'Not connected';
          badge.className = (s.status === 'revoked' ? 'pill warn' : 'pill risk') + ' amp-conn-status';
          btn.textContent = s.status === 'revoked' ? 'Reconnect' : 'Connect';
          btn.onclick = function () {
            // Shopify has no fixed authorize URL — it's per-shop — so the
            // admin has to tell us the shop domain before Connect means
            // anything; Meta/Google need nothing extra.
            var shop = shopInput ? shopInput.value.trim() : undefined;
            if (shopInput && !shop) { shopInput.focus(); return; }
            connectPlatform(platform, shop);
          };
          if (shopInput) shopInput.style.display = '';
        }
      });
    });
  }

  function loadConnectAccounts() {
    apiFetch(OAUTH_API + '/status').then(function (res) {
      if (res.ok) renderConnectAccounts(res.body);
    });
  }

  function connectPlatform(platform, shop) {
    var url = OAUTH_API + '/' + platform + '/start';
    if (shop) url += '?shop=' + encodeURIComponent(shop);
    apiFetch(url).then(function (res) {
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
      shopifyStatusCache = null; // re-check on next Products panel visit
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
    var wizPlatform = (rec && rec.suggested_platform) || 'meta';
    document.getElementById('amp-wiz-title').innerHTML =
      'Create ' + platformIcon(wizPlatform) + ' ' + platformLabel(wizPlatform) + ' Campaign';

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
          '<div class="amp-wiz-field"><div class="lbl">Platform</div><div class="val" style="display:flex;align-items:center;gap:5px">' + platformIcon(platform) + platformLabel(platform) + '</div></div>' +
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
    var duration = parseInt(document.getElementById('wiz-field-duration').value, 10);
    var platform = pillGet('wiz-field-platform');
    var objective = pillGet('wiz-field-objective');
    if (!name) { errEl.textContent = 'Campaign name is required.'; return; }
    if (!budget || budget <= 0) { errEl.textContent = 'Daily budget must be a positive amount.'; return; }
    if (!duration || duration <= 0) { errEl.textContent = 'Duration must be a positive number of days.'; return; }

    var btn = document.getElementById('amp-wiz-launch-btn');
    btn.disabled = true; btn.textContent = 'Launching…';
    apiFetch(CAMPAIGNS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, platform: platform, objective: objective, daily_budget_yen: budget,
        duration_days: duration, sku: wizardRec ? wizardRec.sku : null }),
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
    var refreshBtn = document.getElementById('amp-shopify-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshShopifyCatalog);
    var addBtn = document.getElementById('amp-manual-add-btn');
    if (addBtn) addBtn.addEventListener('click', addManualCatalogItem);
    var searchBox = document.getElementById('amp-shopify-search');
    if (searchBox) searchBox.addEventListener('input', function () {
      shopifyCatalogState.search = searchBox.value;
      renderShopifyCatalog();
    });
    document.querySelectorAll('#amp-shopify-catalog-table .amp-sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sortKey;
        if (shopifyCatalogState.sortKey === key) shopifyCatalogState.sortDir *= -1;
        else { shopifyCatalogState.sortKey = key; shopifyCatalogState.sortDir = 1; }
        renderShopifyCatalog();
      });
    });
  });
})();
