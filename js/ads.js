/* Dashboard Ads: campaign planning, product catalog, and account connections. */
(function () {
  'use strict';

  var CAMPAIGNS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-campaigns';
  var OAUTH_API      = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/amplify-oauth';


  function apiFetch(url, opts) {
    return APRA_SESSION.fetch(url, opts).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var shopifyStatusCache = null;
  async function loadAccountConnections() {
    var res = await apiFetch(OAUTH_API + '/status', {cache:'no-store', signal:AbortSignal.timeout(12000)});
    if (!res.ok) throw new Error('Could not load account connections.');
    shopifyStatusCache = res.body.shopify?.status === 'connected';
    return res.body;
  }

  function fetchShopifyStatus() {
    return shopifyStatusCache === null
      ? loadAccountConnections().then(function () { return shopifyStatusCache; })
      : Promise.resolve(shopifyStatusCache);
  }

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
    if (/^https:\/\//i.test(imageUrl || '')) return '<img class="amp-sku-thumb" src="' + escHtml(imageUrl) + '">';
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
    var hasAllStock = true, hasAllSold = true, hasAllRevenue = true;
    products.forEach(function (p) {
      (p.variants || []).forEach(function (v) {
        if (v.inventory_on_hand != null) totalStock += v.inventory_on_hand;
        else hasAllStock = false;
        if (v.units_sold_60d == null) hasAllSold = false;
        if (v.revenue_60d == null) hasAllRevenue = false;
        totalSold += v.units_sold_60d || 0;
        totalRevenue += v.revenue_60d || 0;
      });
    });
    kpis.style.display = '';
    document.getElementById('amp-kpi-products').textContent = products.length.toLocaleString();
    document.getElementById('amp-kpi-stock').textContent = hasAllStock ? totalStock.toLocaleString() : '—';
    document.getElementById('amp-kpi-sold-card').style.display = hasSales ? '' : 'none';
    document.getElementById('amp-kpi-revenue-card').style.display = hasSales ? '' : 'none';
    if (hasSales) {
      document.getElementById('amp-kpi-sold').textContent = hasAllSold ? totalSold.toLocaleString() : '—';
      document.getElementById('amp-kpi-revenue').textContent = hasAllRevenue ? totalRevenue.toFixed(2) + ' ' + (shopifyCatalogState.salesCurrency || '') : '—';
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
            '<td>' + (v.units_sold_60d == null ? '—' : v.units_sold_60d.toLocaleString()) + '</td>' +
            '<td>' + (v.revenue_60d == null ? '—' : v.revenue_60d.toFixed(2) + ' ' + escHtml(shopifyCatalogState.salesCurrency || '')) + '</td>' : '');
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
        setShopifyEmptyMessage('Connect Shopify in Integrations to see the catalog and inventory.');
        renderShopifyCatalog();
        return;
      }
      return apiFetch(CAMPAIGNS_API + '/shopify-products').then(function (res) {
        if (!res.ok) throw new Error();
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
          setShopifyEmptyMessage(res.body.status === 'failed' ? 'Shopify sync failed. Try Refresh.' : 'No Shopify products have synced yet.');
          renderShopifyCatalog();
        }
      });
    }).catch(function () {
      setShopifyRefreshSpinning(false);
      setShopifyEmptyMessage('Could not load the Shopify catalog.');
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
      if (!res.ok) throw new Error();
      var items = Object.values(res.body);
      document.querySelector('#amp-manual-catalog-empty p').textContent = 'No manually added products yet.';
      items.sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); });
      renderManualCatalog(items);
    }).catch(function () {
      renderManualCatalog([]);
      document.querySelector('#amp-manual-catalog-empty p').textContent = 'Could not load the manual catalog.';
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

  // ---- Connection details on the Integrations cards: which account, when
  // and by whom it was connected (or disconnected), and what access it has.
  // Only what the connection service reports is shown; nothing is guessed.
  var ACCESS_TEXT = {
    read_products: 'products', read_inventory: 'inventory', read_orders: 'orders',
    ads_management: 'manage ads', 'https://www.googleapis.com/auth/adwords': 'manage Google Ads campaigns',
  };
  function accessText(platform, scope) {
    if (!scope) return '';
    var parts = String(scope).split(/[,\s]+/).filter(Boolean).map(function (x) { return ACCESS_TEXT[x] || x; });
    if (platform === 'shopify') return 'Read-only: ' + parts.join(', ');
    return parts.join(', ').replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function whenText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    var ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? days + ' days ago'
      : Math.round(days / 30) + ' months ago';
    return [d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), ago.charAt(0).toUpperCase() + ago.slice(1)];
  }
  function addWhen(add, label, iso) { var w = whenText(iso); if (w) add(label, w[0], w[1]); }
  function renderConnectionDetails(card, platform, s) {
    if (!card.closest('#integrationsPanel')) return;   // the Getting Started card stays compact
    var dl = card.querySelector('.amp-conn-meta');
    if (!dl) {
      dl = document.createElement('dl');
      dl.className = 'amp-conn-meta';
      card.insertBefore(dl, card.querySelector('.row'));
    }
    dl.replaceChildren();
    function add(label, value, note) {
      if (!value) return;
      var row = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      if (note) { var sm = document.createElement('small'); sm.textContent = note; dd.append(sm); }
      row.append(dt, dd); dl.append(row);
    }
    var det = s.account_details || {};
    var accountId = s.external_account_id;
    if (s.status === 'connected') {
      if (platform === 'shopify') {
        add('Store', s.account_name || accountId, s.account_name ? accountId : '');
        if (det.domain && det.domain !== accountId) add('Website', det.domain);
        add('Plan', det.plan);
        add('Region', [det.country, det.currency, det.timezone].filter(Boolean).join(' · '));
      } else {
        add('Account', s.account_name || accountId || 'Not shown yet',
          s.account_name || accountId ? '' : 'Account details appear once ' + (platform === 'google' ? 'Google Ads' : 'Meta') + ' API access is approved.');
      }
      addWhen(add, 'Connected', s.connected_at);
      add('Connected by', s.connected_by);
      add('Access', accessText(platform, s.access));
    } else if (s.status === 'revoked') {
      add(platform === 'shopify' ? 'Store' : 'Account', s.account_name || accountId);
      addWhen(add, 'Disconnected', s.revoked_at);
      add('Disconnected by', s.revoked_by);
      addWhen(add, 'First connected', s.connected_at);
    }
    dl.hidden = !dl.children.length;
  }

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
        btn.disabled = false;
        if (s.status === 'connected') {
          badge.textContent = card.closest('#integrationsPanel') ? 'Connected'
            : 'Connected' + (s.external_account_id ? ' — ' + s.external_account_id : '');
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
        renderConnectionDetails(card, platform, s);
      });
    });
  }

  function loadConnectAccounts() {
    return loadAccountConnections().then(renderConnectAccounts).catch(function () {
      document.getElementById('ads-integration-status').textContent = 'Could not load account connections.';
    });
  }

  async function getAuthorizationUrl(platform, shop) {
    var url = OAUTH_API + '/' + platform + '/start';
    if (shop) url += '?shop=' + encodeURIComponent(shop);
    var res = await apiFetch(url);
    if (!res.ok || !res.body.authorize_url) {
      throw new Error(res.body.error || 'Could not start the connection.');
    }
    return res.body.authorize_url;
  }

  function connectPlatform(platform, shop) {
    getAuthorizationUrl(platform, shop).then(function (url) {
      window.location.href = url;
    }).catch(function (error) { alert(error.message); });
  }

  window.APRA_COMMERCE = {
    shopifyStatus: async function () {
      var connections = await loadAccountConnections();
      var shopify = connections.shopify;
      if (!shopify || !['connected', 'revoked', 'not_connected'].includes(shopify.status)) {
        throw new Error('Unexpected Shopify status.');
      }
      return shopify;
    },
    authorize: getAuthorizationUrl,
  };

  function disconnectPlatform(platform) {
    if (!confirm('Disconnect this ' + platform + ' account? Reconnect to resume syncing account data.')) return;
    apiFetch(OAUTH_API + '/' + platform + '/disconnect', { method: 'POST' }).then(function () {
      shopifyStatusCache = null; // re-check on next Products panel visit
      loadConnectAccounts();
    });
  }

  var PLANS_API = CAMPAIGNS_API + '?view=plans';
  var planForm = document.getElementById('ads-plan-form');
  var planStatus = document.getElementById('ads-plan-status');
  var planError = document.getElementById('ads-plan-error');
  var scopeLines = document.getElementById('ads-scope-lines');
  var currentPlan = null;

  function addScope(line) {
    var row = document.getElementById('ads-scope-template').content.firstElementChild.cloneNode(true);
    var input = function (name) { return row.querySelector('[name="' + name + '"]'); };
    if (line) {
      input('sku').value = line.sku;
      input('postal_codes').value = line.postal_codes.join(', ');
    }
    input('line_start').value = line ? line.start_date : planForm.elements.start_date.value;
    input('line_end').value = line ? line.end_date : planForm.elements.end_date.value;
    input('share').value = line ? line.share : (scopeLines.childElementCount ? '' : '100');
    row.querySelector('button').addEventListener('click', function () {
      if (scopeLines.childElementCount > 1) row.remove();
    });
    scopeLines.append(row);
  }

  function openPlan(plan, viewOnly) {
    currentPlan = plan;
    planForm.reset();
    scopeLines.replaceChildren();
    planError.textContent = '';
    document.getElementById('ads-plan-title').textContent = plan ? plan.name : 'New campaign';
    var stateChip = document.getElementById('ads-plan-state');
    if (stateChip) {
      stateChip.hidden = !plan;
      if (plan) { stateChip.textContent = STATUS_TEXT[plan.status] || plan.status; stateChip.dataset.status = plan.status; }
    }
    var readOnly = viewOnly || (plan && plan.status !== 'draft');
    ['code', 'name', 'platform', 'objective', 'daily_budget_yen', 'start_date', 'end_date'].forEach(function (name) {
      if (plan) planForm.elements[name].value = plan[name];
      planForm.elements[name].disabled = Boolean(readOnly);
    });
    planForm.elements.code.readOnly = Boolean(plan);
    renderLaunchDetails(plan);
    if (plan) plan.scope.forEach(addScope);
    else addScope(null);
    scopeLines.querySelectorAll('input, button').forEach(function (control) {
      control.disabled = Boolean(readOnly);
    });
    ['ads-add-scope', 'ads-save-plan', 'ads-commit-plan'].forEach(function (id) {
      document.getElementById(id).hidden = Boolean(readOnly);
    });
    planForm.hidden = false;
    updatePlanTotal();
    planForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (!readOnly) planForm.elements.name.focus({ preventScroll: true });
  }

  function updatePlanTotal() {
    var out = document.getElementById('ads-plan-total');
    if (!out) return;
    var el = planForm.elements, budget = Number(el.daily_budget_yen.value);
    var start = el.start_date.value, end = el.end_date.value;
    if (!budget || !start || !end || end < start) { out.textContent = ''; return; }
    var days = planDays({ start_date: start, end_date: end });
    out.textContent = days + (days === 1 ? ' day' : ' days') + ' × ' + yen(budget) + ' = ' + yen(budget * days) + ' total';
  }
  ['daily_budget_yen', 'start_date', 'end_date'].forEach(function (n) {
    planForm.elements[n].addEventListener('input', updatePlanTotal);
  });
  // Scope-line dates follow the campaign dates until someone sets them:
  // a line added before the campaign dates were filled in no longer sits
  // there empty, silently blocking Save.
  ['start_date', 'end_date'].forEach(function (n) {
    var lineField = n === 'start_date' ? 'line_start' : 'line_end';
    var el = planForm.elements[n], last = '';
    el.addEventListener('focus', function () { last = el.value; });
    el.addEventListener('change', function () {
      scopeLines.querySelectorAll('[name="' + lineField + '"]').forEach(function (input) {
        if (!input.disabled && (!input.value || input.value === last)) input.value = el.value;
      });
      last = el.value;
    });
  });

  // ---- Campaign list: readable dates, budget per day and in total, what
  // each plan targets, a status pill, and quiet row actions. ----
  var STATUS_TEXT = { draft: 'Draft', committed: 'Committed', withdrawn: 'Withdrawn' };
  var PLATFORM_ICON = {
    google: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#4285F4" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
    meta: '<svg viewBox="0 0 24 24" width="14" height="14" fill="#0668E1" aria-hidden="true"><path d="M6.9 4C3.4 4 0 8.6 0 14.4 0 18 1.7 20 4.4 20c2.3 0 3.8-1.6 6.6-6.6l.2-.4.3.5c2.4 4 4 6.5 6.7 6.5 2.6 0 4.8-2.2 4.8-6.2C23 8.8 20.1 4 16.6 4c-1.8 0-3.3 1.3-4.8 3.4C10.3 5.3 8.8 4 6.9 4zm10 2.1c2.2 0 4.1 3.5 4.1 7.9 0 1.7-.6 2.9-1.8 2.9-1.4 0-2.3-1.3-5.6-6.9l-.3-.6c1.2-2.1 2.4-3.3 3.6-3.3zM7 6.6c1.4 0 2.5 1 3.6 2.9-1.6 2.4-3.9 6.8-5.5 6.8-.9 0-1.6-.6-1.6-2.3C3.5 10.3 5.3 6.6 7 6.6z"/></svg>'
  };
  function planDays(plan) {
    var a = new Date(plan.start_date + 'T00:00:00Z'), b = new Date(plan.end_date + 'T00:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
  }
  function shortDate(iso, withYear) {
    var d = new Date(iso + 'T00:00:00Z');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, withYear
      ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function yen(n) { return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }); }
  function cell(row, cls) { var td = row.insertCell(); if (cls) td.className = cls; return td; }
  function two(td, main, sub) {
    var b = document.createElement('span'); b.className = 'camp-main'; b.textContent = main;
    td.append(b);
    if (sub) { var s2 = document.createElement('span'); s2.className = 'camp-sub'; s2.textContent = sub; td.append(s2); }
  }
  function pill(status) {
    var p = document.createElement('span');
    p.className = 'camp-pill'; p.dataset.status = status; p.textContent = STATUS_TEXT[status] || status;
    return p;
  }
  function renderSummary(plans) {
    var box = document.getElementById('ads-plan-summary');
    if (!box) return;
    box.replaceChildren();
    if (!plans.length) { box.hidden = true; return; }
    var live = plans.filter(function (p) { return p.status === 'committed'; });
    var drafts = plans.filter(function (p) { return p.status === 'draft'; }).length;
    var total = live.reduce(function (s, p) { return s + p.daily_budget_yen * planDays(p); }, 0);
    [['Committed', live.length, live.length === 1 ? 'plan in forecasting' : 'plans in forecasting'],
     ['Drafts', drafts, 'not used yet'],
     ['Committed spend', yen(total), 'over all committed dates']].forEach(function (s) {
      var d = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = s[0];
      var dd = document.createElement('dd'); dd.textContent = s[1];
      var note = document.createElement('dd'); note.className = 'camp-note'; note.textContent = s[2];
      d.append(dt, dd, note); box.append(d);
    });
    box.hidden = false;
  }

  // ---- Google Ads launch (test accounts only, see the campaigns service).
  function launchState(plan) {
    var l = plan.launch || {};
    if (l.campaign_id) return 'launched';
    return l.status || '';
  }
  function launchLine(plan) {
    var l = plan.launch || {}, st = launchState(plan);
    if (!st) return null;
    var line = document.createElement('span');
    line.className = 'camp-launch';
    line.dataset.state = st;
    if (st === 'launched') {
      line.append(document.createTextNode('On Google Ads · ' + (l.status === 'PAUSED' ? 'Paused' : (l.status || '').toLowerCase())));
      if (l.url) {
        var a = document.createElement('a');
        a.href = l.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Open ↗';
        a.setAttribute('aria-label', 'Open campaign ' + l.campaign_id + ' in Google Ads');
        a.onclick = function (e) { e.stopPropagation(); };
        line.append(' ', a);
      } else {
        line.append(document.createTextNode(' · ID ' + l.campaign_id));
      }
    } else if (st === 'launching') {
      line.textContent = 'Launching on Google…';
    } else if (st === 'failed') {
      line.textContent = 'Launch failed';
      line.title = l.error || '';
    }
    return line;
  }
  function launchPlan(plan, btn, currency) {
    var cur = currency || 'the Google account\'s currency';
    if (!confirm('Create "' + plan.name + '" in your Google Ads TEST account?\n\n' +
      'It is created paused, in a test account: no ads run and nothing is charged. ' +
      'Daily budget ' + Number(plan.daily_budget_yen).toLocaleString() + ' is sent as an amount in ' + cur + '.')) return;
    btn.disabled = true; btn.textContent = 'Launching…';
    planStatus.textContent = '';
    var failure = '';
    postPlan({ action: 'launch', code: plan.code, version: plan.version })
      .catch(function (err) { failure = err.message; })
      .then(function () { return loadCampaigns(); })
      .then(function () { if (failure) planStatus.textContent = failure; });
  }
  function renderLaunchDetails(plan) {
    var box = document.getElementById('ads-plan-launch');
    if (!box) {
      box = document.createElement('dl');
      box.id = 'ads-plan-launch';
      box.className = 'camp-launch-box';
      planForm.querySelector('.camp-form-head').after(box);
    }
    box.replaceChildren();
    var l = (plan && plan.launch) || {};
    function add(k, v) {
      if (v == null || v === '') return;
      var d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k;
      if (v instanceof Node) dd.append(v); else dd.textContent = v;
      d.append(dt, dd); box.append(d);
    }
    if (l.campaign_id) {
      var link = null;
      if (l.url) { link = document.createElement('a'); link.href = l.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open in Google Ads ↗'; }
      add('Google Ads', link || 'Campaign ' + l.campaign_id);
      add('Campaign ID', l.campaign_id);
      add('Account', l.customer_id ? l.customer_id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3') + ' (test)' : '');
      add('Status', l.status === 'PAUSED' ? 'Paused' : l.status);
      add('Budget currency', l.currency);
      add('Postal codes targeted', (l.postal_targeted || []).join(', ') || 'None');
      if ((l.postal_missing || []).length) add('Not found on Google', l.postal_missing.join(', '));
      if (l.geo_error) add('Targeting note', l.geo_error);
      add('Launched', l.launched_at ? new Date(l.launched_at).toLocaleString() : '');
    } else if (l.status === 'failed') {
      add('Google Ads', 'Launch failed');
      add('Reason', l.error);
    }
    box.hidden = !box.children.length;
  }

  function loadCampaigns() {
    var list = document.getElementById('ads-plan-list');
    planStatus.textContent = 'Loading campaigns…';
    return apiFetch(PLANS_API).then(function (res) {
      if (!res.ok) throw new Error(res.body.error || 'Could not load campaign plans.');
      if (!Array.isArray(res.body.plans)) throw new Error('Campaign planning is unavailable.');
      document.getElementById('ads-new-plan').disabled = !res.body.can_edit;
      list.replaceChildren();
      var plans = res.body.plans.slice().sort(function (a, b) {
        var order = { draft: 0, committed: 1, withdrawn: 2 };
        return (order[a.status] - order[b.status]) || a.start_date.localeCompare(b.start_date);
      });
      renderSummary(plans);
      list.closest('.camp-list').classList.toggle('is-empty', !plans.length);
      planStatus.textContent = plans.length ? '' : 'No campaign plans yet. Create one to plan ad spend by SKU and postal code.';
      plans.forEach(function (plan) {
        var row = list.insertRow();
        row.className = 'camp-row';
        row.dataset.status = plan.status;
        var editable = res.body.can_edit && plan.status === 'draft';
        var open = function () { openPlan(plan, !res.body.can_edit); };
        two(cell(row), plan.name, plan.code);
        var pf = cell(row);
        pf.innerHTML = '<span class="camp-platform">' + (PLATFORM_ICON[plan.platform] || '') +
          escHtml(plan.platform === 'meta' ? 'Meta' : 'Google') + '</span>';
        if (plan.objective) { var ob = document.createElement('span'); ob.className = 'camp-sub'; ob.textContent = plan.objective; pf.append(ob); }
        var days = planDays(plan);
        two(cell(row), shortDate(plan.start_date) + ' – ' + shortDate(plan.end_date, true), days + (days === 1 ? ' day' : ' days'));
        two(cell(row, 'num'), yen(plan.daily_budget_yen) + ' / day', yen(plan.daily_budget_yen * days) + ' total');
        var skus = Array.from(new Set((plan.scope || []).map(function (l) { return l.sku; })));
        var pins = Array.from(new Set([].concat.apply([], (plan.scope || []).map(function (l) { return l.postal_codes || []; }))));
        two(cell(row), skus.slice(0, 2).join(', ') + (skus.length > 2 ? ' +' + (skus.length - 2) : ''),
          pins.length + (pins.length === 1 ? ' postal code' : ' postal codes'));
        var stCell = cell(row);
        stCell.append(pill(plan.status));
        var ll = launchLine(plan);
        if (ll) stCell.append(ll);
        var actions = cell(row, 'camp-acts');
        var view = document.createElement('button');
        view.type = 'button';
        view.className = 'camp-btn';
        view.textContent = editable ? 'Edit' : 'View';
        view.setAttribute('aria-label', view.textContent + ' ' + plan.name);
        view.onclick = function (e) { e.stopPropagation(); open(); };
        actions.append(view);
        var lst = launchState(plan);
        var gads = res.body.google_ads || {};
        if (res.body.can_edit && gads.ready && plan.status === 'committed' && plan.platform === 'google' &&
            (lst === '' || lst === 'failed')) {
          var go = document.createElement('button');
          go.type = 'button';
          go.className = 'camp-btn camp-btn-go';
          go.textContent = lst === 'failed' ? 'Retry launch' : 'Launch (test)';
          go.setAttribute('aria-label', 'Launch ' + plan.name + ' on Google Ads test account');
          go.onclick = function (e) { e.stopPropagation(); launchPlan(plan, go, gads.currency); };
          actions.append(go);
        }
        if (res.body.can_edit && plan.status === 'committed' && lst !== 'launched') {
          var withdraw = document.createElement('button');
          withdraw.type = 'button';
          withdraw.className = 'camp-btn camp-btn-danger';
          withdraw.textContent = 'Withdraw';
          withdraw.setAttribute('aria-label', 'Withdraw ' + plan.name);
          withdraw.onclick = function (e) {
            e.stopPropagation();
            if (!confirm('Withdraw this plan from future forecast runs? Its history will remain.')) return;
            withdraw.disabled = true;
            postPlan({ action: 'withdraw', code: plan.code, version: plan.version })
              .then(function () { planForm.hidden = true; return loadCampaigns(); })
              .catch(function (err) { planStatus.textContent = err.message; })
              .finally(function () { withdraw.disabled = false; });
          };
          actions.append(withdraw);
        }
        row.addEventListener('click', open);
      });
    }).catch(function (err) { planStatus.textContent = err.message; });
  }

  function postPlan(payload) {
    return apiFetch(PLANS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error(res.body.error || 'Could not save the campaign plan.');
      return res.body;
    });
  }

  planForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var action = event.submitter ? event.submitter.value : 'save';
    var stockWarning = 'Available stock and expected uplift could not be verified. Commit this plan to forecasting anyway?';
    if (action === 'commit' && !confirm(stockWarning)) return;
    var values = Object.fromEntries(new FormData(planForm));
    var scope = Array.from(scopeLines.children, function (line) {
      var get = function (name) { return line.querySelector('[name="' + name + '"]').value; };
      return {
        sku: get('sku').trim().toUpperCase(),
        postal_codes: get('postal_codes').split(',').map(function (postal) { return postal.trim().toUpperCase(); }).filter(Boolean),
        start_date: get('line_start'), end_date: get('line_end'), share: Number(get('share')),
      };
    });
    var payload = {
      action: action, code: values.code.trim().toUpperCase(),
      name: values.name, platform: values.platform, objective: values.objective,
      daily_budget_yen: Number(values.daily_budget_yen), start_date: values.start_date,
      end_date: values.end_date, scope: scope, stock_unavailable_ack: action === 'commit',
    };
    if (currentPlan) payload.version = currentPlan.version;
    var buttons = planForm.querySelectorAll('button');
    buttons.forEach(function (button) { button.disabled = true; });
    planError.textContent = 'Saving…';
    postPlan(payload).then(function () {
      planError.textContent = '';
      planForm.hidden = true;
      return loadCampaigns();
    }).catch(function (err) {
      planError.textContent = err.message;
    }).finally(function () {
      buttons.forEach(function (button) { button.disabled = false; });
    });
  });

  document.getElementById('ads-new-plan').onclick = function () { openPlan(null); };
  document.getElementById('ads-add-scope').onclick = function () {
    if (scopeLines.childElementCount < 20) addScope(null);
  };
  document.getElementById('ads-close-plan').onclick = function () { planForm.hidden = true; };
  window.loadAdsCampaigns = loadCampaigns;

  window.loadAdsProducts = loadProducts;
  window.loadAdsIntegrations = loadConnectAccounts;
  document.addEventListener('DOMContentLoaded', function () {
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
