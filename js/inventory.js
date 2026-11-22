/* ============================================================
   APRABot dashboard — Inventory panel

   Renders the Cycle Stock / Safety Stock / Total Monthly Inventory data
   scenario-runner computes per SKU x pincode x calendar month (see
   lambda/scenario-runner/handler.py's compute_monthly_inventory(), built
   from Monthly_Inventory_Methodology.docx) on its own dedicated nav page
   — a completely separate data source and load path from js/insights.js's
   Bedrock-generated AI Insights content, so this never depends on that
   other fetch succeeding.

   makeDetailView() below builds one SKU x pincode drill-down (its own
   selection, KPIs, and chart) bound to a set of DOM ids — currently
   instantiated once, for the Inventory page's own drill-down, but kept as
   a small factory rather than inline code in case a second, independent
   view is ever needed elsewhere again.
============================================================ */
(function () {
  'use strict';

  // Same API Gateway + Lambda as the main forecast fetch, distinguished by
  // a query param the Lambda reads (?type=inventory) rather than a new
  // route — see lambda/forecast-api/handler.py's own comment on why.
  var INVENTORY_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/forecast?type=inventory';

  // GET /forecast (this route too) now requires the signed-in user's
  // Cognito ID token — the API resolves it to an organization and serves
  // only that org's inventory data. Same header pattern as js/scenarios.js.
  var loaded = false;
  var lastData = null;     // {months, params, bySku} once fetched
  var fetchPromise = null;

  function fetchInventory() {
    if (lastData) return Promise.resolve(lastData);
    if (fetchPromise) return fetchPromise;
    fetchPromise = APRA_SESSION.fetch(INVENTORY_API)
      .then(function (r) {
        if (!r.ok) {
          var err = new Error('HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        return r.json();
      })
      .then(function (data) {
        lastData = data;
        return data;
      })
      .finally(function () { fetchPromise = null; });
    return fetchPromise;
  }

  // Mirrors js/insights.js's own invalidateInsights() — called from the
  // same two places (approveScenario / checkApprovalChange in
  // js/scenarios.js) so approving a new scenario doesn't leave this page
  // frozen on the previous approved forecast's inventory numbers, the
  // exact staleness bug that fix addressed for AI Insights itself.
  window.invalidateInventory = function () {
    loaded = false;
    lastData = null;
    invReqRows = null;
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtMonth(ym) {
    // 'YYYY-MM' -> 'Mon YYYY', avoiding a Date() parse (a bare "YYYY-MM" is
    // inconsistently interpreted as local vs. UTC across browsers).
    var parts = ym.split('-');
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }

  // Zips for a SKU, sorted by that zip's latest-month total descending —
  // same "highest-need first" convention the Forecasts panel's own zip
  // filter already uses (by backtest volume there; by inventory total
  // here, since that's the number this section is actually about).
  function sortedZipsFor(skuId) {
    var byZip = (lastData.bySku[skuId] || {}).byZip || {};
    return Object.keys(byZip).sort(function (a, b) {
      var za = byZip[a].total, zb = byZip[b].total;
      return zb[zb.length - 1] - za[za.length - 1];
    });
  }

  // Stacked area (Cycle Stock, then Safety Stock stacked on top of it) with
  // a dashed Total line tracing the top of the stack — a deliberate visual
  // match for the source doc's own "two buckets, add them together" framing
  // of how these two numbers relate, not just an arbitrary chart choice.
  // Takes a canvas element directly (not an id) so any makeDetailView()
  // instance can reuse it.
  function drawChart(cv, months, cycleArr, safetyArr, totalArr) {
    if (!cv) return;
    var box = cv.parentElement;
    var cw = box.clientWidth || 680, ch = box.clientHeight || 220, dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = ch * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var padL = 54, padR = 12, padT = 12, padB = 22;
    var N = months.length;
    var uMax = Math.max.apply(null, totalArr) * 1.15 || 1;
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
    for (var i = 0; i < N; i += step) { ctx.fillText(months[i], X(i), ch - 6); }

    function area(topArr, baseArr, fill) {
      ctx.beginPath();
      for (var i = 0; i < N; i++) {
        var x = X(i), y = Y(topArr[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (var i = N - 1; i >= 0; i--) ctx.lineTo(X(i), Y(baseArr[i]));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    var zero = months.map(function () { return 0; });
    var stacked = cycleArr.map(function (v, i) { return v + safetyArr[i]; });
    area(cycleArr, zero, 'rgba(84,230,196,.35)');
    area(stacked, cycleArr, 'rgba(200,242,78,.30)');

    ctx.strokeStyle = '#7AA2FF'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    totalArr.forEach(function (v, i) {
      var x = X(i), y = Y(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke(); ctx.setLineDash([]);
  }

  // One SKU x pincode drill-down view, bound to its own set of DOM ids —
  // a factory rather than inline code so a second independent instance
  // (its own selection, never touching this one's) is a one-line addition
  // if this ever needs to appear in more than one place again. Every
  // method no-ops if its own element isn't on the page, matching the
  // file's existing defensive convention (this same script runs
  // regardless of which panel exists on the current page).
  function makeDetailView(ids) {
    var currentSku = null, currentZip = null;

    function populateSkuSelect() {
      var sel = document.getElementById(ids.skuSelect);
      if (!sel) return;
      var skuIds = Object.keys(lastData.bySku).sort(); // SKU-001, SKU-002, ... already volume-ranked
      sel.innerHTML = skuIds.map(function (id) {
        return '<option value="' + id + '">' + id + '</option>';
      }).join('');
    }

    function populateZipSelect(skuId) {
      var sel = document.getElementById(ids.zipSelect);
      if (!sel) return;
      var zips = sortedZipsFor(skuId);
      sel.innerHTML = zips.map(function (z) {
        return '<option value="' + escapeHtml(z) + '">' + escapeHtml(z) + '</option>';
      }).join('');
    }

    function renderKpis(skuId, zip) {
      var el = document.getElementById(ids.kpis);
      if (!el) return;
      var d = lastData.bySku[skuId].byZip[zip];
      var i = lastData.months.length - 1;
      var kpi = function (label, value) {
        return '<div class="kpi"><div class="t">' + label + '</div><div class="v">' + value + '</div></div>';
      };
      el.innerHTML =
        kpi('Avg daily demand', Math.round(d.add[i]).toLocaleString()) +
        kpi('Std dev (daily)', Math.round(d.sigmaD[i]).toLocaleString()) +
        kpi('Cycle stock', d.cycleStock[i].toLocaleString()) +
        kpi('Safety stock', d.safetyStock[i].toLocaleString()) +
        kpi('Total needed', d.total[i].toLocaleString());
      if (ids.asOf) {
        var asOfEl = document.getElementById(ids.asOf);
        if (asOfEl) asOfEl.textContent = 'As of ' + fmtMonth(lastData.months[i]);
      }
    }

    function renderChart(skuId, zip) {
      var cv = document.getElementById(ids.chart);
      if (!cv) return;
      var d = lastData.bySku[skuId].byZip[zip];
      drawChart(cv, lastData.months, d.cycleStock, d.safetyStock, d.total);
    }

    // Same series the chart draws, as exact numbers per month — reading a
    // specific month off the chart means eyeballing pixel height; this is
    // for when the real figure for, say, March matters. Most recent month
    // first, matching how someone actually checking "what does the data
    // say for a given month" would want to scan it (newest first).
    function renderMonthlyTable(skuId, zip) {
      var body = document.getElementById(ids.monthlyTable);
      if (!body) return;
      var d = lastData.bySku[skuId].byZip[zip];
      var rows = [];
      for (var i = lastData.months.length - 1; i >= 0; i--) {
        rows.push(
          '<tr><td>' + fmtMonth(lastData.months[i]) + '</td>' +
          '<td>' + Math.round(d.add[i]).toLocaleString() + '</td>' +
          '<td>' + Math.round(d.sigmaD[i]).toLocaleString() + '</td>' +
          '<td>' + d.cycleStock[i].toLocaleString() + '</td>' +
          '<td>' + d.safetyStock[i].toLocaleString() + '</td>' +
          '<td>' + d.total[i].toLocaleString() + '</td></tr>'
        );
      }
      body.innerHTML = rows.join('');
    }

    function renderAssumptions() {
      var el = document.getElementById(ids.assumptions);
      if (!el) return;
      var p = lastData.params;
      var pct = Math.round(p.serviceLevel * 100);
      el.textContent =
        'Assumes a ' + p.leadTimeDays + '-day lead time with ' + Math.round(p.leadTimeCv * 100) +
        '% variability and a ' + pct + '% target service level (Z=' + p.z + ') — placeholders, not ' +
        'measured from this data. ' + (p.assumptionsNote || '');
    }

    function renderSelection() {
      var skuSel = document.getElementById(ids.skuSelect);
      var zipSel = document.getElementById(ids.zipSelect);
      if (!skuSel || !zipSel) return;
      currentSku = skuSel.value;
      currentZip = zipSel.value;
      if (!currentSku || !currentZip) return;
      renderKpis(currentSku, currentZip);
      renderChart(currentSku, currentZip);
      renderMonthlyTable(currentSku, currentZip);
    }

    // Called once fresh data has landed — populates both selects (default:
    // first/top SKU and its highest-need pincode) and renders everything.
    function initForData() {
      var skuSel = document.getElementById(ids.skuSelect);
      if (!skuSel) return; // this view's markup isn't on the current page
      var skuIds = Object.keys(lastData.bySku).sort();
      if (!skuIds.length) return;
      populateSkuSelect();
      populateZipSelect(skuIds[0]);
      renderAssumptions();
      renderSelection();
    }

    function wireEvents() {
      var skuSel = document.getElementById(ids.skuSelect);
      var zipSel = document.getElementById(ids.zipSelect);
      if (!skuSel || !zipSel) return;
      skuSel.addEventListener('change', function () {
        populateZipSelect(skuSel.value);
        renderSelection();
      });
      zipSel.addEventListener('change', renderSelection);
      if (ids.downloadBtn) {
        var btn = document.getElementById(ids.downloadBtn);
        if (btn) btn.addEventListener('click', window.downloadInventoryCsv);
      }
      // Redraw on resize so the canvas picks up its new on-screen width —
      // same reasoning as the compare/scenario charts' own resize handling.
      window.addEventListener('resize', function () {
        if (currentSku && currentZip && lastData) renderChart(currentSku, currentZip);
      });
    }

    return { initForData: initForData, wireEvents: wireEvents };
  }

  // The Inventory page's one drill-down (SKU x pincode selectors, KPIs,
  // chart, assumptions, CSV download) — see dashboard/index.html's
  // #inventoryPanel for the matching markup.
  var detailView = makeDetailView({
    skuSelect: 'invSkuSelect', zipSelect: 'invZipSelect', kpis: 'invKpis',
    chart: 'invChart', asOf: 'invAsOf', assumptions: 'invAssumptions', downloadBtn: 'invDownloadBtn',
    monthlyTable: 'invMonthlyTableBody',
  });

  // The same page's catalog-wide summary, above the drill-down — same
  // underlying data, just rolled up (every pincode summed per SKU, every
  // SKU summed for the whole catalog) instead of one SKU x one pincode at
  // a time. Only called once loadInventory() has already confirmed there
  // IS data to show (see its success handler below), so skuIds is never
  // empty here — no separate empty-state handling needed in this function.
  //
  // monthIdx: which month to summarize — lets #ovInvMonthSelect show any
  // past month, not just the latest (its own change handler re-calls this
  // with a different index; initForCatalog() below wires that up and picks
  // the latest month as the initial default).
  function renderCatalogSummary(monthIdx) {
    var el = document.getElementById('ovInvKpis');
    if (!el) return;
    var i = monthIdx != null ? monthIdx : lastData.months.length - 1;
    var skuIds = Object.keys(lastData.bySku);

    var totalCycle = 0, totalSafety = 0, totalAll = 0;
    var perSku = skuIds.map(function (skuId) {
      var byZip = lastData.bySku[skuId].byZip;
      var sCycle = 0, sSafety = 0, sTotal = 0;
      Object.keys(byZip).forEach(function (zip) {
        var d = byZip[zip];
        sCycle += d.cycleStock[i];
        sSafety += d.safetyStock[i];
        sTotal += d.total[i];
      });
      totalCycle += sCycle; totalSafety += sSafety; totalAll += sTotal;
      return { skuId: skuId, total: sTotal };
    }).sort(function (a, b) { return b.total - a.total; });

    var kpi = function (label, value) {
      return '<div class="kpi"><div class="t">' + label + '</div><div class="v">' + value + '</div></div>';
    };
    el.innerHTML =
      kpi('Total cycle stock', Math.round(totalCycle).toLocaleString()) +
      kpi('Total safety stock', Math.round(totalSafety).toLocaleString()) +
      kpi('Total inventory needed', Math.round(totalAll).toLocaleString());

    var moversEl = document.getElementById('ovInvMoversList');
    if (moversEl) {
      moversEl.innerHTML = perSku.slice(0, 5).map(function (r) {
        var zipCount = Object.keys(lastData.bySku[r.skuId].byZip).length;
        return '<li><div><div class="nmx">' + r.skuId + '</div><div class="sku">' + zipCount + ' pincode' +
          (zipCount === 1 ? '' : 's') + '</div></div><span class="chg">' + Math.round(r.total).toLocaleString() + ' units</span></li>';
      }).join('');
    }
  }

  // Populates #ovInvMonthSelect (defaulting to the latest month) and wires
  // its change handler — separate from renderCatalogSummary() itself so
  // the select only needs populating once per fresh data load, not on
  // every re-render.
  function initCatalogSummary() {
    var sel = document.getElementById('ovInvMonthSelect');
    if (!sel) { renderCatalogSummary(); return; }
    sel.innerHTML = lastData.months.map(function (m, idx) {
      return '<option value="' + idx + '">' + fmtMonth(m) + '</option>';
    }).join('');
    sel.value = lastData.months.length - 1;
    sel.onchange = function () { renderCatalogSummary(parseInt(sel.value, 10)); };
    renderCatalogSummary(lastData.months.length - 1);
  }

  window.downloadInventoryCsv = function () {
    if (!lastData) return;
    var rows = [['Pincode', 'SKU', 'Month', 'Avg Daily Demand', 'Std Dev Daily Demand',
                 'Cycle Stock (units)', 'Safety Stock (units)', 'Total Monthly Inventory (units)']];
    var skuIds = Object.keys(lastData.bySku).sort();
    skuIds.forEach(function (skuId) {
      var byZip = lastData.bySku[skuId].byZip;
      Object.keys(byZip).sort().forEach(function (zip) {
        var d = byZip[zip];
        lastData.months.forEach(function (m, i) {
          rows.push([zip, skuId, m, Math.round(d.add[i]), Math.round(d.sigmaD[i]), d.cycleStock[i], d.safetyStock[i], d.total[i]]);
        });
      });
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { return /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'APRABot_monthly_inventory.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function showState(state) {
    // state: 'loading' | 'empty' | 'error' | 'content' — the Inventory
    // page's own loading/empty/error chrome (both the catalog summary and
    // the drill-down live inside #invContent, so one state covers both).
    document.getElementById('invLoading').style.display = state === 'loading' ? '' : 'none';
    document.getElementById('invEmpty').style.display = state === 'empty' ? '' : 'none';
    document.getElementById('invError').style.display = state === 'error' ? '' : 'none';
    document.getElementById('invContent').style.display = state === 'content' ? '' : 'none';
  }

  window.loadInventory = function (force) {
    if (loaded && !force) return;
    if (force) lastData = null;
    showState('loading');

    fetchInventory()
      .then(function (data) {
        loaded = true;
        var skuIds = Object.keys(data.bySku || {});
        if (!skuIds.length) { showState('empty'); return; }
        showState('content');
        initCatalogSummary();
        detailView.initForData();
        initInvReq();
      })
      .catch(function (err) {
        loaded = true;
        if (err.status === 404) { showState('empty'); return; }
        showState('error');
        document.getElementById('invError').textContent = 'Could not load inventory data right now (' + err.message + ').';
      });
  };

  // Latest monthly requirement plus an optional client-side sample preview.
  var invReqRows = null;
  var invReqMonthIdx = null;
  var invSampleEnabled = false;
  var invReqState = { sku: 'ALL', search: '', activeKpiTab: null, sortKey: 'sku', sortDir: 'asc' };
  var inventoryKpis = {present: 'Present inventory', required: 'Recommended Inventory',
                       intransit: 'In-transit inventory', openpo: 'Open PO units'};

  function sampleInventory(required) {
    var scale = Math.max(12, required);
    var quantity = function (low, high) { return Math.round(scale * (low + Math.random() * (high - low))); };
    var present = quantity(0.25, 1.05);
    var intransit = quantity(0.02, 0.35);
    var openpo = quantity(0.08, 0.45);
    return {
      site: 'Sample site ' + (1 + Math.floor(Math.random() * 3)),
      present: present, intransit: intransit, openpo: openpo,
      delta: present + intransit + openpo - required,
      frequency: 'Every ' + (3 + Math.floor(Math.random() * 12)) + ' days',
    };
  }

  function invFmt(n) {
    return (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
  }

  function buildInvReqRows() {
    var i = lastData.months.length - 1;
    invReqMonthIdx = i;
    var skuIds = Object.keys(lastData.bySku).sort();
    return skuIds.map(function (skuId) {
      var byZip = lastData.bySku[skuId].byZip;
      var required = 0;
      Object.keys(byZip).forEach(function (zip) {
        required += byZip[zip].total[i];
      });
      return { sku: skuId, required: required };
    });
  }

  function invReqPopulateDropdowns() {
    var sel = document.getElementById('invReqSkuFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="ALL">All SKUs</option>' + invReqRows.map(function (r) {
      return '<option value="' + escapeHtml(r.sku) + '">' + escapeHtml(r.sku) + '</option>';
    }).join('');
  }

  function invReqUpdateKpiTabUI() {
    var toggle = document.getElementById('invSampleToggle');
    toggle.setAttribute('aria-pressed', String(invSampleEnabled));
    toggle.textContent = invSampleEnabled ? 'Hide sample data' : 'Preview sample data';
    document.getElementById('invSampleNotice').hidden = !invSampleEnabled;
    document.getElementById('invSampleTableNote').textContent = invSampleEnabled
      ? 'Site, on-hand, in-transit, PO units, and inbound frequency are samples. Delta compares sample supply with Required.'
      : 'Required uses this month’s cycle stock and safety stock. Other inventory fields are unavailable.';

    document.querySelectorAll('.inv-kpi-tab').forEach(function (tab) {
      var key = tab.dataset.kpiTab;
      tab.classList.toggle('active', invReqState.activeKpiTab === key);
      if (key === 'required') return;
      tab.disabled = !invSampleEnabled;
      tab.title = invSampleEnabled ? 'Sort by sample ' + inventoryKpis[key] : 'Data unavailable';
      tab.querySelector('.inv-kpi-hint').textContent = invSampleEnabled ? 'Sample' : 'No data';
    });
    var pill = document.getElementById('invActiveTabPill');
    if (invReqState.activeKpiTab) {
      document.getElementById('invActiveTabText').textContent =
        'Sorted by ' + inventoryKpis[invReqState.activeKpiTab] +
        ' (' + (invReqState.sortDir === 'desc' ? 'High → Low' : 'Low → High') + ')';
      pill.style.display = 'inline-flex';
    } else {
      pill.style.display = 'none';
    }
  }

  function invReqRender() {
    if (!invReqRows) return;
    var rows = invSampleEnabled ? invReqRows.map(function (row) {
      if (!row.sample) row.sample = sampleInventory(row.required);
      return Object.assign({}, row, row.sample);
    }) : invReqRows;
    var filtered = rows.filter(function (row) {
      if (invReqState.sku !== 'ALL' && row.sku !== invReqState.sku) return false;
      if (invReqState.search.trim() !== '') {
        var q = invReqState.search.trim().toLowerCase();
        if (row.sku.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      var av = a[invReqState.sortKey], bv = b[invReqState.sortKey];
      if (typeof av === 'string') return invReqState.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return invReqState.sortDir === 'asc' ? av - bv : bv - av;
    });

    var totalRequired = filtered.reduce(function (sum, r) { return sum + r.required; }, 0);

    ['present', 'intransit', 'openpo', 'delta'].forEach(function (key) {
      var total = function (items) { return items.reduce(function (sum, row) { return sum + row[key]; }, 0); };
      document.getElementById('inv-foot-' + key).textContent = invSampleEnabled && filtered.length ? invFmt(total(filtered)) : '—';
      var card = document.querySelector('.inv-kpi-tab[data-kpi-tab="' + key + '"] .inv-kpi-val');
      if (card) card.textContent = invSampleEnabled ? invFmt(total(rows)) : '—';
    });

    var kpiTotal = document.getElementById('kpi-required-total');
    if (kpiTotal) kpiTotal.textContent = invFmt(invReqRows.reduce(function (s, r) { return s + r.required; }, 0));
    var kpiSub = document.getElementById('kpi-required-sub');
    if (kpiSub) kpiSub.textContent = invReqRows.length + ' SKUs';

    var monthLabel = document.getElementById('invReqMonthLabel');
    if (monthLabel && lastData && invReqMonthIdx != null) monthLabel.textContent = fmtMonth(lastData.months[invReqMonthIdx]);

    var footCount = document.getElementById('inv-foot-count');
    if (footCount) footCount.textContent = filtered.length + ' rows';
    var footRequired = document.getElementById('inv-foot-required');
    if (footRequired) footRequired.textContent = invFmt(totalRequired);

    var counter = document.getElementById('invReqCounter');
    if (counter) counter.textContent = 'Showing ' + filtered.length + ' of ' + invReqRows.length + ' SKUs';

    document.querySelectorAll('#inventoryReqTable .amp-sortable').forEach(function (th) {
      var icon = th.querySelector('.ov-sort-ic');
      if (!icon) return;
      if (th.dataset.sortKey === invReqState.sortKey) {
        icon.textContent = invReqState.sortDir === 'asc' ? '↑' : '↓';
        icon.style.opacity = 1; icon.style.color = 'var(--text)';
      } else {
        icon.textContent = '⇅'; icon.style.opacity = 0; icon.style.color = '';
      }
    });

    var body = document.getElementById('inventoryReqBody');
    if (!body) return;
    if (!filtered.length) {
      body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px 20px;color:var(--muted)">No SKUs match your current filters.</td></tr>';
      return;
    }
    var dim = '<td><span class="inv-dim">—</span></td>';
    function sampleCell(value) {
      return invSampleEnabled ? '<td class="inv-sample-cell">' + escapeHtml(value) + '</td>' : dim;
    }
    body.innerHTML = filtered.map(function (row) {
      var status = row.delta < 0 ? 'Shortfall' : row.delta === 0 ? 'Matched' : 'Surplus';
      return '<tr>' +
        '<td><b style="font-family:var(--mono);color:var(--text)">' + escapeHtml(row.sku) + '</b></td>' +
        sampleCell(row.site) + sampleCell(invFmt(row.present)) +
        '<td style="color:var(--text);font-weight:600">' + invFmt(row.required) + '</td>' +
        sampleCell(invFmt(row.intransit)) + sampleCell(invFmt(row.openpo)) +
        sampleCell(invFmt(row.delta)) + sampleCell(row.frequency) + sampleCell(status) +
      '</tr>';
    }).join('');
  }

  window.invReqPickKpiTab = function (btn) {
    var tab = btn.dataset.kpiTab;
    if (tab !== 'required' && !invSampleEnabled) return;
    if (invReqState.activeKpiTab === tab) {
      invReqState.activeKpiTab = null; invReqState.sortKey = 'sku'; invReqState.sortDir = 'asc';
    } else {
      invReqState.activeKpiTab = tab; invReqState.sortKey = 'required'; invReqState.sortDir = 'desc';
    }
    invReqUpdateKpiTabUI();
    invReqRender();
  };

  function invReqWireEvents() {
    var skuSel = document.getElementById('invReqSkuFilter');
    var search = document.getElementById('invReqSearch');
    var resetBtn = document.getElementById('invReqResetBtn');
    var clearTabBtn = document.getElementById('invClearTabBtn');
    if (!skuSel) return; // this section's markup isn't on the current page
    document.getElementById('invSampleToggle').addEventListener('click', function () {
      invSampleEnabled = !invSampleEnabled;
      if (!invSampleEnabled && !['sku', 'required'].includes(invReqState.sortKey)) {
        invReqState.activeKpiTab = null;
        invReqState.sortKey = 'sku';
        invReqState.sortDir = 'asc';
      }
      invReqUpdateKpiTabUI();
      invReqRender();
    });
    skuSel.addEventListener('change', function (e) { invReqState.sku = e.target.value; invReqRender(); });
    if (search) search.addEventListener('input', function (e) { invReqState.search = e.target.value; invReqRender(); });
    if (clearTabBtn) clearTabBtn.addEventListener('click', function () {
      invReqState.activeKpiTab = null; invReqState.sortKey = 'sku'; invReqState.sortDir = 'asc';
      invReqUpdateKpiTabUI(); invReqRender();
    });
    if (resetBtn) resetBtn.addEventListener('click', function () {
      invReqState = { sku: 'ALL', search: '', activeKpiTab: null, sortKey: 'sku', sortDir: 'asc' };
      skuSel.value = 'ALL';
      if (search) search.value = '';
      invReqUpdateKpiTabUI(); invReqRender();
    });
    document.querySelectorAll('#inventoryReqTable .amp-sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sortKey;
        if (invReqState.sortKey === key) invReqState.sortDir = invReqState.sortDir === 'asc' ? 'desc' : 'asc';
        else { invReqState.sortKey = key; invReqState.sortDir = key === 'sku' ? 'asc' : 'desc'; }
        invReqRender();
      });
    });
  }

  function initInvReq() {
    if (!document.getElementById('inventoryReqBody')) return; // markup not on this page
    invReqRows = buildInvReqRows();
    invReqState = { sku: 'ALL', search: '', activeKpiTab: null, sortKey: 'sku', sortDir: 'asc' };
    invReqPopulateDropdowns();
    invReqUpdateKpiTabUI();
    invReqRender();
  }

  function init() {
    detailView.wireEvents();
    invReqWireEvents();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
