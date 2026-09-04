(function () {
  var INSIGHTS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/insights';
  var loaded = false;
  var lastData = null;
  var fetchPromise = null;

  // Reusable by other features (e.g. the PDF report) that want the same
  // insights payload without duplicating the fetch/cache logic.
  window.fetchInsights = function () {
    if (lastData) return Promise.resolve(lastData);
    if (fetchPromise) return fetchPromise;
    fetchPromise = fetch(INSIGHTS_API)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        lastData = data;
        return data;
      })
      .finally(function () { fetchPromise = null; });
    return fetchPromise;
  };

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

  // Plain-text narration for the "read brief aloud" button — same content
  // as the visible cards, in reading order, joined into flowing sentences
  // rather than the bullet-list shape the page itself uses.
  function narrateInsights(data) {
    var parts = [];
    if (data.tagline) parts.push(data.tagline + '.');
    if (data.headline) parts.push(data.headline + '.');
    if (data.summary) parts.push(data.summary);
    var findings = data.key_findings || [];
    if (findings.length) {
      parts.push('Key findings:');
      findings.forEach(function (f) { parts.push(f.title + ': ' + f.detail + '.'); });
    }
    var watch = data.watch_areas || data.risks || [];
    if (watch.length) parts.push('Watch areas: ' + watch.join('. ') + '.');
    var opps = data.opportunities || [];
    if (opps.length) parts.push('Opportunities: ' + opps.join('. ') + '.');
    return parts.join(' ');
  }

  function render(data) {
    // tagline is a newer field — older cached insights.json (generated
    // before this was added, or a manual re-run hasn't happened yet) won't
    // have it, so hide the line entirely rather than show it empty.
    var taglineEl = document.getElementById('insightsTagline');
    if (taglineEl) {
      if (data.tagline) { taglineEl.textContent = data.tagline; taglineEl.style.display = ''; }
      else { taglineEl.textContent = ''; taglineEl.style.display = 'none'; }
    }

    document.getElementById('insightsHeadline').textContent = data.headline || '';
    document.getElementById('insightsSummary').textContent = data.summary || '';

    // "Ask Lyra for more" — opens the real chat, pre-filled with a question
    // that references this actual brief (not a generic prompt), so Lyra's
    // reply picks up right where the static brief leaves off. Doesn't
    // auto-send — same review-before-send caution as voice input and the
    // rest of this product's chat-adjacent features.
    var askBtn = document.getElementById('insightsAskLyraBtn');
    if (askBtn) {
      askBtn.onclick = function () {
        if (typeof window.cbOpen === 'function') window.cbOpen();
        var input = document.getElementById('cbText');
        if (input && !input.value) {
          var about = data.tagline || data.headline || 'today’s AI Insights brief';
          input.value = 'Can you go deeper on this: "' + about + '"?';
          input.focus();
        }
      };
    }

    var speakSlot = document.getElementById('insightsSpeakSlot');
    if (speakSlot && typeof window.cbSpeakBtn === 'function') {
      speakSlot.innerHTML = '';
      var speakBtn = window.cbSpeakBtn(narrateInsights(data));
      if (speakBtn) speakSlot.appendChild(speakBtn);
    }

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
    if (force) lastData = null;
    var loadingEl = document.getElementById('insightsLoading');
    var errorEl = document.getElementById('insightsError');
    var contentEl = document.getElementById('insightsContent');
    loadingEl.style.display = '';
    document.getElementById('insightsLoadingText').textContent = 'Loading insights…';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';

    window.fetchInsights()
      .then(function (data) {
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
