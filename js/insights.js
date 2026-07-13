(function () {
  var INSIGHTS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/insights';
  var loaded = false;

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function li(text) {
    var el = document.createElement('li');
    el.textContent = text;
    return el;
  }

  function findingLi(f) {
    var el = document.createElement('li');
    var strong = document.createElement('span');
    strong.className = 'nmx';
    strong.textContent = f.title;
    var detail = document.createElement('span');
    detail.className = 'sku';
    detail.style.textAlign = 'right';
    detail.style.maxWidth = '65%';
    detail.textContent = f.detail;
    el.appendChild(strong);
    el.appendChild(detail);
    return el;
  }

  function render(data) {
    document.getElementById('insightsHeadline').textContent = data.headline || '';
    document.getElementById('insightsSummary').textContent = data.summary || '';

    var findings = document.getElementById('insightsFindings');
    findings.innerHTML = '';
    (data.key_findings || []).forEach(function (f) { findings.appendChild(findingLi(f)); });

    var watch = document.getElementById('insightsWatch');
    watch.innerHTML = '';
    (data.watch_areas || data.risks || []).forEach(function (r) { watch.appendChild(li(r)); });

    var opps = document.getElementById('insightsOpportunities');
    opps.innerHTML = '';
    (data.opportunities || []).forEach(function (o) { opps.appendChild(li(o)); });

    var sub = document.getElementById('insightsSubtitle');
    var based = data.based_on || {};
    var parts = ['Generated ' + fmtDate(data.generated_at)];
    if (based.backtest_weeks != null) {
      parts.push(based.backtest_weeks + 'wk backtest + ' + (based.forward_weeks || 0) + 'wk forward, ' +
        based.overall_wape + '% WAPE');
    }
    sub.textContent = parts.join(' · ');

    document.getElementById('insightsLoading').style.display = 'none';
    document.getElementById('insightsError').style.display = 'none';
    document.getElementById('insightsContent').style.display = '';
  }

  window.loadInsights = function (force) {
    if (loaded && !force) return;
    var loadingEl = document.getElementById('insightsLoading');
    var errorEl = document.getElementById('insightsError');
    var contentEl = document.getElementById('insightsContent');
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading insights…';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';

    fetch(INSIGHTS_API)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        loaded = true;
        render(data);
      })
      .catch(function (err) {
        loadingEl.style.display = 'none';
        errorEl.style.display = '';
        errorEl.textContent = 'Could not load insights right now (' + err.message + ').';
      });
  };
})();
