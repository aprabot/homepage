/* ============================================================
   APRABot dashboard — guided product walkthrough.
   Spotlights real nav items (and the Lyra launch button), actually
   navigating the dashboard as the user steps through, rather than
   showing static screenshots or copy.
============================================================ */
(function () {
  'use strict';

  var steps = [
    { name: 'Overview', title: 'Overview', desc: 'Your at-a-glance snapshot — KPI cards, fastest movers, and the full SKU table, refreshed with the latest approved forecast.' },
    { name: 'Forecasts', title: 'Forecasts', desc: 'The forward-looking chart for shipped units, with backtest, forecast, and confidence bands. Toggle series in the legend, switch the week range, or show/hide the backtest.' },
    { name: 'Scenarios', title: 'Scenarios', desc: 'Run what-if forecasts against the default dataset or your own uploaded data, compare them side by side, then approve one to make it live.' },
    { name: 'AI Insights', title: 'AI Insights', desc: 'Lyra’s narrative read on the forecast — headline performance, key findings, watch areas, and opportunities, grounded in the real numbers.' },
    { name: 'Settings', title: 'Settings', desc: 'Manage your account and preferences here.' },
    { selector: '#cbLaunch', title: 'Ask Lyra', desc: 'Have a question about the forecast, a SKU, or a scenario? Ask Lyra directly, any time, from anywhere in the dashboard.' },
  ];

  var idx = -1;
  var spotlighted = null;
  var returnPanel = null;

  function navLi(name) {
    var items = document.querySelectorAll('.dnav li');
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent.trim() === name) return items[i];
    }
    return null;
  }

  function clearSpotlight() {
    if (spotlighted) { spotlighted.classList.remove('tour-spotlight'); spotlighted = null; }
  }

  function positionCardAwayFrom(el) {
    var card = document.getElementById('tourCard');
    if (!el) { card.style.left = '32px'; card.style.right = ''; return; }
    var r = el.getBoundingClientRect();
    // Nav items sit on the left edge — push the card to the right side instead.
    if (r.left < window.innerWidth / 2) {
      card.style.left = '';
      card.style.right = '32px';
    } else {
      card.style.right = '';
      card.style.left = '32px';
    }
  }

  function showStep(i) {
    clearSpotlight();
    var step = steps[i];
    if (!step) return;

    var target = null;
    if (step.selector === '#cbLaunch') {
      // Make sure the chat panel is closed so the launch button is actually visible to spotlight.
      var panel = document.getElementById('cbPanel');
      var launch = document.getElementById('cbLaunch');
      if (panel) panel.classList.remove('open');
      if (launch) launch.classList.remove('hide');
      target = launch;
    } else if (step.name) {
      target = navLi(step.name);
      if (target) target.click();
    }

    if (target) {
      target.classList.add('tour-spotlight');
      spotlighted = target;
    }
    positionCardAwayFrom(target);

    document.getElementById('tourStepCount').textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourDesc').textContent = step.desc;
    document.getElementById('tourBack').disabled = (i === 0);
    document.getElementById('tourNext').textContent = (i === steps.length - 1) ? 'Finish' : 'Next →';
  }

  function startTour() {
    try { returnPanel = localStorage.getItem('apra_dashboard_panel') || 'Overview'; } catch (e) { returnPanel = 'Overview'; }
    idx = 0;
    document.getElementById('tourBackdrop').style.display = '';
    document.getElementById('tourCard').style.display = '';
    showStep(idx);
  }

  function endTour() {
    clearSpotlight();
    document.getElementById('tourBackdrop').style.display = 'none';
    document.getElementById('tourCard').style.display = 'none';
    idx = -1;
    if (returnPanel) {
      var target = navLi(returnPanel);
      if (target) target.click();
      returnPanel = null;
    }
  }

  function init() {
    var startBtn = document.getElementById('tourStartBtn');
    if (!startBtn) return; // walkthrough not present on this page

    startBtn.addEventListener('click', startTour);

    document.getElementById('tourNext').addEventListener('click', function () {
      if (idx >= steps.length - 1) { endTour(); return; }
      idx++;
      showStep(idx);
    });

    document.getElementById('tourBack').addEventListener('click', function () {
      if (idx <= 0) return;
      idx--;
      showStep(idx);
    });

    document.getElementById('tourSkip').addEventListener('click', endTour);
    document.getElementById('tourBackdrop').addEventListener('click', endTour);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
