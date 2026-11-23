/* Onboarding visuals — an animated "how this step is used" diagram at the
   top of each Getting Started step, plus the training and ready states.

   Purely presentational: it only inserts new elements (never moves,
   changes or removes the wizard's own), so js/onboarding.js keeps working
   exactly as before. The diagrams are schematic — no numbers, no fake
   progress — and say plainly when a step's data isn't used by the
   forecast yet. Animations re-run whenever a step is shown (CSS animations
   restart when an element goes from display:none to visible) and are off
   for anyone who prefers reduced motion. Styles: css/dashboard-polish.css,
   "Onboarding visuals". */
(function () {
  'use strict';

  var ICON = {
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.8 2.6 15.2 0 18M12 3c-2.6 2.8-2.6 15.2 0 18"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    steps: '<path d="M4 7h4v4H4zM10 13h4v4h-4zM16 7h4v4h-4z"/><path d="M8 9h2a2 2 0 0 1 2 2v2M14 15h1a2 2 0 0 0 2-2v-2"/>',
    store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 11z"/><path d="M5 14v6h14v-6"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
    archive: '<path d="M3 5h18v4H3z"/><path d="M5 9v10h14V9M10 13h4"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 15l-3-3c1-4 4.5-8 12-8 0 7.5-4 11-8 12z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
    factory: '<path d="M3 20V9l5 3V9l5 3V5h4l1 15z"/><path d="M3 20h18"/>',
    warehouse: '<path d="M3 9l9-5 9 5v11H3z"/><path d="M7 20v-7h10v7M7 16h10"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h2v2H8z"/>',
    model: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 11l3.3-3.7M7 13l3.3 3.7M14 7l3.3 3.7M14 17l3.3-3.7"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>';
  }

  // Small illustrations used inside a node in place of a plain icon.
  var ART = {
    bars: function () {
      var h = [38, 55, 46, 70, 62, 84, 74, 92];
      return '<span class="obv-bars" aria-hidden="true">' + h.map(function (v, i) {
        return '<i style="height:' + v + '%;animation-delay:' + (0.25 + i * 0.06) + 's"></i>';
      }).join('') + '</span>';
    },
    line: function () {
      return '<svg class="obv-line" viewBox="0 0 48 32" aria-hidden="true">' +
        '<path class="obv-line-hist" d="M2 26 L10 21 L17 23 L24 15"/>' +
        '<path class="obv-line-fc" d="M24 15 L31 11 L38 13 L46 6"/></svg>';
    },
    venn: function () {
      return '<svg class="obv-venn" viewBox="0 0 48 32" aria-hidden="true">' +
        '<circle class="a" cx="18" cy="16" r="11"/><circle class="b" cx="30" cy="16" r="11"/></svg>';
    },
    weather: function () {
      return '<span class="obv-weather" aria-hidden="true">' + icon('sun') + '</span>';
    },
  };

  /* One slim flow per step, matched to the stepper's own labels so a
     reordered or renamed step can't get the wrong diagram. Each node is a
     short label; the longer explanation is its tooltip. `soon` marks data
     that is saved but not used by the forecast yet (the step says so too).
     Connect with Shopify and Review & train have no strip: Shopify's card
     already explains it, and Review & train has its own Queued → Done
     pipeline, which is animated in place instead (animateTrainPipeline). */
  var FLOWS = [
    { match: /country/i, title: 'How your country is used', nodes: [
      { icon: 'globe', t: 'Country', s: 'Picked once, locked after the first upload' },
      { icon: 'sliders', t: 'Defaults', s: 'Postal-code pattern, currency, date format, festival calendar' },
      { icon: 'steps', t: 'Every later step', s: 'Uploads are checked against these defaults', accent: true },
    ] },
    { match: /sales/i, title: 'How your sales file becomes a forecast', nodes: [
      { icon: 'file', t: 'Sales file', s: 'ship_day, sku, postal_code, shipped_units' },
      { art: 'bars', t: 'Weekly history', s: 'Demand per SKU and postal code' },
      { art: 'line', t: 'Forecast', s: 'Learned from that history', accent: true },
    ] },
    { match: /spend|marketing/i, title: 'Where marketing spend fits', nodes: [
      { icon: 'megaphone', t: 'Spend file', s: 'date, campaign, channel, spend' },
      { icon: 'archive', t: 'Kept on file', s: 'Saved with your setup' },
      { art: 'line', t: 'Forecast', s: 'Spend is not used in the forecast yet', soon: true },
    ] },
    { match: /sku/i, title: 'How the SKU master is checked', nodes: [
      { icon: 'list', t: 'SKU master', s: 'One row per SKU' },
      { art: 'venn', t: 'Matched to sales', s: 'SKUs missing on either side are flagged' },
      { icon: 'rocket', t: 'Launch dates', s: 'Confirm launch dates for new SKUs', accent: true },
    ] },
    { match: /inbound/i, title: 'Where inbound receipts fit', nodes: [
      { icon: 'factory', t: 'Receipts', s: 'Stock arriving at each site' },
      { icon: 'warehouse', t: 'Sites & frequency', s: 'Units received and how often deliveries arrive' },
      { icon: 'box', t: 'Inventory', s: 'Shown on the Inventory page', accent: true },
    ] },
    { match: /weather|festival/i, title: 'Signals around your demand', nodes: [
      { art: 'weather', t: 'Weather', s: 'From the Weather sheet in your sales file — used in training' },
      { icon: 'calendar', t: 'Holidays', s: 'National holidays for India and Japan are used in training; state and added festivals are saved for later' },
      { icon: 'model', t: 'Training', s: 'Weather is used as a signal', accent: true },
    ] },
  ];

  function nodeHtml(n, i) {
    var visual = n.art ? ART[n.art]() : icon(n.icon);
    return '<span class="obv-node' + (n.accent ? ' accent' : '') + (n.soon ? ' soon' : '') + '" style="--i:' + i + '" title="' + n.s + '">' +
      '<span class="obv-ic">' + visual + '</span><b>' + n.t + '</b>' +
      (n.soon ? '<em class="obv-tag">later</em>' : '') + '</span>';
  }

  function flowHtml(flow) {
    var parts = [];
    flow.nodes.forEach(function (n, i) {
      if (i) {
        parts.push('<span class="obv-link' + (n.soon ? ' dashed' : '') + '" style="--i:' + i + '" aria-hidden="true">' +
          '<span class="obv-dot"></span></span>');
      }
      parts.push(nodeHtml(n, i));
    });
    return '<div class="obv" role="img" aria-label="' + flow.title + ': ' +
      flow.nodes.map(function (n) { return n.t + ' (' + n.s + ')'; }).join(', then ') + '">' + parts.join('') + '</div>';
  }

  function addStepDiagrams() {
    for (var n = 1; n <= 12; n++) {
      var step = document.getElementById('obStep' + n);
      if (!step) break;
      if (step.querySelector('.obv')) continue;
      var label = document.querySelector('#obStepperStep' + n + ' .lbl');
      var text = label ? label.textContent : '';
      var flow = null;
      for (var f = 0; f < FLOWS.length; f++) { if (FLOWS[f].match.test(text)) { flow = FLOWS[f]; break; } }
      if (!flow) continue;
      var wrap = document.createElement('div');
      wrap.innerHTML = flowHtml(flow);
      var intro = step.querySelector(':scope > p.dsubtle');
      if (intro) intro.insertAdjacentElement('afterend', wrap.firstChild);
      else step.insertAdjacentElement('afterbegin', wrap.firstChild);
    }
  }

  // Review & train's own pipeline: its stages light up one after another.
  function animateTrainPipeline() {
    var flow = document.querySelector('#onboardingPanel .flowd');
    if (!flow) return;
    flow.classList.add('obv-flowd');
    flow.querySelectorAll('.flowd-box').forEach(function (box, i) { box.style.setProperty('--i', i); });
  }

  // Training: data → model → forecast, with pulses travelling along the
  // links. It doesn't claim a stage — the run only reports running/done.
  function addTrainingVisual() {
    var prep = document.getElementById('obPreparing');
    if (!prep || prep.querySelector('.obv-train')) return;
    var el = document.createElement('div');
    el.className = 'obv-train';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<span class="obv-train-node">' + ART.bars() + '<small>Your data</small></span>' +
      '<span class="obv-train-link"><i></i><i></i><i></i></span>' +
      '<span class="obv-train-node core">' + icon('model') + '<small>Model</small></span>' +
      '<span class="obv-train-link"><i></i><i></i><i></i></span>' +
      '<span class="obv-train-node">' + ART.line() + '<small>Forecast</small></span>';
    prep.insertAdjacentElement('afterbegin', el);
  }

  /* Review & train: a readiness summary (ring + headline) above the status
     checklist, and the step's icon on each row. Everything is read from the
     tiles js/onboarding.js renders (their labels and pill classes), and it
     re-runs whenever those tiles are re-rendered. */
  var REVIEW_ICONS = [[/country/i, 'globe'], [/shopify/i, 'store'], [/sales/i, 'file'], [/spend|marketing/i, 'megaphone'],
    [/sku/i, 'list'], [/inbound/i, 'warehouse'], [/weather|festival/i, 'sun']];

  function decorateReview() {
    var tilesEl = document.getElementById('obReviewTiles');
    if (!tilesEl) return;
    var summary = document.createElement('div');
    summary.className = 'obv-sum';
    summary.setAttribute('role', 'status');
    tilesEl.insertAdjacentElement('beforebegin', summary);

    function update() {
      var tiles = tilesEl.querySelectorAll('.ob-review-tile');
      tiles.forEach(function (t) {
        if (t.querySelector('.obv-rt-ic')) return;
        var label = (t.firstElementChild && t.firstElementChild.textContent) || '';
        var name = 'check';
        for (var i = 0; i < REVIEW_ICONS.length; i++) { if (REVIEW_ICONS[i][0].test(label)) { name = REVIEW_ICONS[i][1]; break; } }
        t.insertAdjacentHTML('afterbegin', '<span class="obv-rt-ic">' + icon(name) + '</span>');
      });
      if (!tiles.length) { summary.hidden = true; return; }
      var total = tiles.length;
      var ok = tilesEl.querySelectorAll('.pill.ok').length;
      var risk = tilesEl.querySelectorAll('.pill.risk').length;
      var warn = tilesEl.querySelectorAll('.pill.warn').length;
      var r = 22, c = 2 * Math.PI * r, frac = ok / total;
      var title = risk ? risk + (risk === 1 ? ' item needs' : ' items need') + ' attention' : 'Ready to train';
      var sub = risk ? 'Fix what’s marked Required, then click Train. Optional steps can stay empty.'
        : warn ? 'Everything required is in place — a few items will use defaults.'
        : 'Everything required is in place. Optional steps can stay empty.';
      summary.hidden = false;
      summary.dataset.state = risk ? 'risk' : 'ok';
      summary.innerHTML =
        '<svg class="obv-ring" viewBox="0 0 56 56" aria-hidden="true">' +
          '<circle class="track" cx="28" cy="28" r="' + r + '"/>' +
          '<circle class="val" cx="28" cy="28" r="' + r + '" style="stroke-dasharray:' + c.toFixed(1) + ';--off:' + (c * (1 - frac)).toFixed(1) + ';--full:' + c.toFixed(1) + '"/>' +
          '<text x="28" y="32" text-anchor="middle">' + ok + '/' + total + '</text></svg>' +
        '<div><b>' + title + '</b><span>' + sub + '</span></div>';
    }
    new MutationObserver(update).observe(tilesEl, { childList: true });
    update();
  }

  function init() {
    if (!document.getElementById('onboardingPanel')) return;
    addStepDiagrams();
    addTrainingVisual();
    animateTrainPipeline();
    decorateReview();
    var ready = document.getElementById('obReady');
    if (ready) ready.classList.add('obv-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
