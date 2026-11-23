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

  /* One flow per step, matched to the stepper's own labels so a reordered
     or renamed step can't get the wrong diagram. `soon` marks data that is
     saved but not used by the forecast yet (stated on the step itself). */
  var FLOWS = [
    { match: /country/i, title: 'How your country is used', nodes: [
      { icon: 'globe', t: 'Your country', s: 'Picked once, locked after the first upload' },
      { icon: 'sliders', t: 'Sets the defaults', s: 'Postal-code pattern, currency, date format, festival calendar' },
      { icon: 'steps', t: 'Every later step', s: 'Uploads are checked against these defaults', accent: true },
    ] },
    { match: /shopify/i, title: 'What connecting Shopify does', nodes: [
      { icon: 'store', t: 'Your Shopify store', s: 'Optional' },
      { icon: 'sync', t: 'Syncs catalog & inventory', s: 'Products and stock levels' },
      { icon: 'box', t: 'Products in APRABot', s: 'Training still uses your sales file, next step', accent: true },
    ] },
    { match: /sales/i, title: 'How your sales file becomes a forecast', nodes: [
      { icon: 'file', t: 'Sales file', s: 'ship_day · sku · postal_code · shipped_units' },
      { art: 'bars', t: 'Weekly demand history', s: 'Per SKU and postal code' },
      { art: 'line', t: 'Your forecast', s: 'Learned from that history', accent: true },
    ] },
    { match: /spend|marketing/i, title: 'Where marketing spend fits', nodes: [
      { icon: 'megaphone', t: 'Campaign spend', s: 'date · campaign · channel · spend' },
      { icon: 'archive', t: 'Kept on file', s: 'Saved with your setup' },
      { art: 'line', t: 'Spend → demand', s: 'Not used in the forecast yet', soon: true },
    ] },
    { match: /sku/i, title: 'How the SKU master is checked', nodes: [
      { icon: 'list', t: 'SKU master', s: 'One row per SKU' },
      { art: 'venn', t: 'Matched to sales', s: 'Missing on either side is flagged' },
      { icon: 'rocket', t: 'New launches', s: 'Confirm launch dates for new SKUs', accent: true },
    ] },
    { match: /inbound/i, title: 'Where inbound receipts fit', truck: true, nodes: [
      { icon: 'factory', t: 'Receipts', s: 'Stock arriving at each site' },
      { icon: 'warehouse', t: 'Your sites', s: 'Matched to the sites in your sales file' },
      { icon: 'box', t: 'Inventory projections', s: 'Not used yet — kept for when it is', soon: true },
    ] },
    { match: /weather|festival/i, title: 'Signals around your demand', nodes: [
      { art: 'weather', t: 'Weather', s: 'From the Weather sheet in your sales file' },
      { icon: 'calendar', t: 'Festivals & holidays', s: 'Built-in calendar plus state holidays — saved, not used in training yet' },
      { icon: 'model', t: 'Model training', s: 'Weather is used as a signal', accent: true },
    ] },
    { match: /review|train/i, title: 'What happens after you click Train', pipeline: true, nodes: [
      { icon: 'clock', t: 'Queued' },
      { icon: 'file', t: 'Preparing data' },
      { icon: 'model', t: 'Training' },
      { icon: 'shield', t: 'Validating' },
      { icon: 'check', t: 'Done' },
    ] },
  ];

  function nodeHtml(n, i) {
    var visual = n.art ? ART[n.art]() : icon(n.icon);
    return '<div class="obv-node' + (n.accent ? ' accent' : '') + (n.soon ? ' soon' : '') + '" style="--i:' + i + '">' +
      '<span class="obv-ic">' + visual + '</span>' +
      '<span class="obv-txt"><b>' + n.t + '</b>' + (n.s ? '<small>' + n.s + '</small>' : '') +
      (n.soon ? '<em class="obv-tag">Coming later</em>' : '') + '</span></div>';
  }

  function flowHtml(flow) {
    var parts = [];
    flow.nodes.forEach(function (n, i) {
      if (i) {
        var dashed = flow.nodes[i].soon ? ' dashed' : '';
        parts.push('<span class="obv-link' + dashed + (flow.truck && i === 1 ? ' truck' : '') + '" style="--i:' + i + '" aria-hidden="true">' +
          (flow.truck && i === 1 ? '<span class="obv-truck">' + truckSvg() + '</span>' : '<span class="obv-dot"></span>') + '</span>');
      }
      parts.push(nodeHtml(n, i));
    });
    return '<div class="obv' + (flow.pipeline ? ' obv-pipeline' : '') + '" role="img" aria-label="' +
      flow.title + ': ' + flow.nodes.map(function (n) { return n.t; }).join(', then ') + '">' +
      '<div class="obv-kicker">' + flow.title + '</div>' +
      '<div class="obv-flow" style="--cols:' + columns(flow) + '">' + parts.join('') + '</div></div>';
  }

  // Node, link, node, link, … — links narrower in the 5-stage pipeline.
  function columns(flow) {
    var link = flow.pipeline ? '28px' : '56px';
    return flow.nodes.map(function () { return 'minmax(0,1fr)'; }).join(' ' + link + ' ');
  }

  function truckSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h11v9H2zM13 10h4l3 3v3h-7"/>' +
      '<circle cx="6" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/></svg>';
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

  function init() {
    if (!document.getElementById('onboardingPanel')) return;
    addStepDiagrams();
    addTrainingVisual();
    var ready = document.getElementById('obReady');
    if (ready) ready.classList.add('obv-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
