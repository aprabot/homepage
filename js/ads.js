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
  function fetchShopifyStatus() {
    if (shopifyStatusCache !== null) return Promise.resolve(shopifyStatusCache);
    return apiFetch(OAUTH_API + '/status').then(function (res) {
      if (!res.ok) throw new Error('Could not load Shopify connection.');
      shopifyStatusCache = !!( res.body.shopify && res.body.shopify.status === 'connected');
      return shopifyStatusCache;
    });
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
      if (!res.ok) throw new Error();
      renderConnectAccounts(res.body);
    }).catch(function () {
      document.getElementById('ads-integration-status').textContent = 'Could not load account connections.';
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
    var readOnly = viewOnly || (plan && plan.status !== 'draft');
    ['code', 'name', 'platform', 'objective', 'daily_budget_yen', 'start_date', 'end_date'].forEach(function (name) {
      if (plan) planForm.elements[name].value = plan[name];
      planForm.elements[name].disabled = Boolean(readOnly);
    });
    planForm.elements.code.readOnly = Boolean(plan);
    if (plan) plan.scope.forEach(addScope);
    else addScope(null);
    scopeLines.querySelectorAll('input, button').forEach(function (control) {
      control.disabled = Boolean(readOnly);
    });
    ['ads-add-scope', 'ads-save-plan', 'ads-commit-plan'].forEach(function (id) {
      document.getElementById(id).hidden = Boolean(readOnly);
    });
    planForm.hidden = false;
    planForm.scrollIntoView({ block: 'nearest' });
    planForm.elements.name.focus();
  }

  function loadCampaigns() {
    var list = document.getElementById('ads-plan-list');
    planStatus.textContent = 'Loading campaigns…';
    return apiFetch(PLANS_API).then(function (res) {
      if (!res.ok) throw new Error(res.body.error || 'Could not load campaign plans.');
      if (!Array.isArray(res.body.plans)) throw new Error('Campaign planning is unavailable.');
      document.getElementById('ads-new-plan').disabled = !res.body.can_edit;
      list.replaceChildren();
      planStatus.textContent = res.body.plans.length ? '' : 'No campaign plans yet.';
      res.body.plans.forEach(function (plan) {
        var row = list.insertRow();
        [plan.name + ' · ' + plan.code, plan.platform === 'meta' ? 'Meta' : 'Google',
          plan.start_date + ' to ' + plan.end_date,
          Number(plan.daily_budget_yen).toLocaleString(undefined, { style: 'currency', currency: 'JPY' }),
          plan.status].forEach(function (value) { row.insertCell().textContent = value; });
        var actions = row.insertCell();
        var view = document.createElement('button');
        view.type = 'button';
        view.className = 'dbtn';
        view.textContent = res.body.can_edit && plan.status === 'draft' ? 'Edit' : 'View';
        view.onclick = function () { openPlan(plan, !res.body.can_edit); };
        actions.append(view);
        if (res.body.can_edit && plan.status === 'committed') {
          var withdraw = document.createElement('button');
          withdraw.type = 'button';
          withdraw.className = 'dbtn';
          withdraw.textContent = 'Withdraw';
          withdraw.onclick = function () {
            if (!confirm('Withdraw this plan from future forecast runs? Its history will remain.')) return;
            withdraw.disabled = true;
            postPlan({ action: 'withdraw', code: plan.code, version: plan.version })
              .then(function () { planForm.hidden = true; return loadCampaigns(); })
              .catch(function (err) { planStatus.textContent = err.message; })
              .finally(function () { withdraw.disabled = false; });
          };
          actions.append(withdraw);
        }
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
