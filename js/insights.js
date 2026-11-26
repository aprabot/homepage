(function () {
  var INSIGHTS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/insights';
  var loaded = false;
  var lastData = null;
  var fetchPromise = null;

  // GET /insights now requires the signed-in user's Cognito ID token — the
  // API resolves it to an organization and serves only that org's data.
  // Reusable by other features (e.g. the PDF report) that want the same
  // insights payload without duplicating the fetch/cache logic.
  window.fetchInsights = function () {
    if (lastData) return Promise.resolve(lastData);
    if (fetchPromise) return fetchPromise;
    fetchPromise = APRA_SESSION.fetch(INSIGHTS_API)
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

  // lastData never expired on its own (no TTL, unlike apra_forecast_cache) —
  // approving a new scenario left both the AI Insights tab and Generate
  // report's embedded insights (headline/summary/findings) frozen on
  // whatever was cached before, until a full page reload reset this
  // closure's state. Called from approveScenario() right alongside its own
  // forecast-cache invalidation, so the very next access (opening AI
  // Insights, or generating a report) fetches fresh instead of reusing this.
  // Deliberately just clears state rather than eagerly re-fetching — no
  // point spending the round-trip if nothing looks at insights again this
  // session.
  window.invalidateInsights = function () {
    loaded = false;
    lastData = null;
  };

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // Opens Lyra with a question about one item. Never sends it; the user
  // reviews it first, like every other chat-adjacent feature. A draft the
  // user typed themselves is kept; one this page filled in is replaced.
  var lastPrefill = '';
  function askLyra(question) {
    if (typeof window.cbOpen === 'function') window.cbOpen();
    var input = document.getElementById('cbText');
    if (!input) return;
    if (!input.value || input.value === lastPrefill) { input.value = question; lastPrefill = question; }
    input.focus();
  }
  function askBtn(question, about) {
    var b = node('button', 'ins-ask', 'Ask Lyra');
    b.type = 'button';
    b.setAttribute('aria-label', 'Ask Lyra about ' + about);
    b.onclick = function () { askLyra(question); };
    return b;
  }

  // Pulls what a finding is about (a SKU or a week) and its number out of
  // Lyra's sentence, so they can be shown large. Only text that is in the
  // sentence is used; if nothing matches, the card shows the sentence alone.
  function parseFinding(f) {
    var d = String(f.detail || '');
    var conf = null;
    var c = d.match(/,?\s*with a confidence level of (\w+)\s*\.?/i);
    if (c) { conf = c[1]; d = d.replace(c[0], '.').replace(/\.\.$/, '.'); }
    var subject = null, metric = null;
    var sku = d.match(/\bSKU[-_A-Za-z0-9]*\d\b/);
    var day = d.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (sku) subject = sku[0];
    else if (day) subject = 'Week of ' + new Date(Date.UTC(+day[1], +day[2] - 1, +day[3]))
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    var units = d.match(/([\d,]+(?:\.\d+)?)\s+(?:total\s+)?(?:forecast(?:ed)?\s+)?units\b/i);
    var pct = d.match(/[+\-−]?\d[\d,]*(?:\.\d+)?%/);
    if (units) metric = units[1] + ' units';
    else if (pct) metric = pct[0].replace('-', '−');
    return { subject: subject, metric: metric, conf: conf, detail: d };
  }

  function findingCard(f) {
    var p = parseFinding(f);
    var el = node('li', 'ins-card');
    el.append(node('p', 'ins-card-label', f.title));
    if (p.metric) {
      var big = node('p', 'ins-card-value');
      big.append(node('b', '', p.metric));
      if (p.subject) big.append(node('span', '', p.subject));
      el.append(big);
    }
    el.append(node('p', 'ins-card-detail', p.detail));
    var foot = node('div', 'ins-card-foot');
    if (p.conf) {
      var level = p.conf.toLowerCase();
      var chip = node('span', 'ins-conf', p.conf.charAt(0).toUpperCase() + p.conf.slice(1) + ' confidence');
      chip.dataset.level = /high/.test(level) ? 'high' : /med/.test(level) ? 'medium' : 'low';
      foot.append(chip);
    }
    foot.append(askBtn('Tell me more about this finding: "' + f.title + ': ' + p.detail + '"', f.title));
    el.append(foot);
    return el;
  }

  function listItem(text, question) {
    var el = node('li', '');
    el.append(node('p', '', text), askBtn(question, text.slice(0, 60)));
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
    var taglineEl = document.getElementById('insightsTagline');
    taglineEl.textContent = data.tagline || '';
    taglineEl.hidden = !data.tagline;   // older briefs have no tagline
    document.getElementById('insightsHeadline').textContent = data.headline || '';
    document.getElementById('insightsSummary').textContent = data.summary || '';

    // "Ask Lyra" opens the chat pre-filled with a question about this brief.
    var ask = document.getElementById('insightsAskLyraBtn');
    ask.hidden = false;
    ask.onclick = function () {
      askLyra('Can you go deeper on this: "' + (data.tagline || data.headline || 'today’s AI Insights brief') + '"?');
    };

    var speakSlot = document.getElementById('insightsSpeakSlot');
    speakSlot.innerHTML = '';
    if (typeof window.cbSpeakBtn === 'function') {
      var speakBtn = window.cbSpeakBtn(narrateInsights(data), 'ins-speak');
      if (speakBtn) { speakBtn.title = 'Read the brief aloud'; speakSlot.appendChild(speakBtn); }
    }

    // What the brief is based on, as numbers rather than a line of text.
    var based = data.based_on || {};
    var stats = document.getElementById('insightsStats');
    stats.innerHTML = '';
    [['Forecast error', based.overall_wape != null ? based.overall_wape + '%' : null, 'WAPE over the backtest'],
     ['Backtest', based.backtest_weeks != null ? based.backtest_weeks + ' weeks' : null, 'checked against actual sales'],
     ['Looking ahead', based.forward_weeks != null ? based.forward_weeks + ' weeks' : null, 'of forecast covered']]
      .forEach(function (s) {
        if (s[1] == null) return;
        var d = node('div', '');
        d.append(node('dt', '', s[0]), node('dd', '', s[1]), node('dd', 'ins-stat-note', s[2]));
        stats.append(d);
      });
    stats.hidden = !stats.children.length;

    var findings = data.key_findings || [];
    var fl = document.getElementById('insightsFindings');
    fl.innerHTML = '';
    findings.forEach(function (f) { fl.appendChild(findingCard(f)); });
    document.getElementById('insightsFindingsSec').hidden = !findings.length;

    var watch = data.watch_areas || data.risks || [];
    var wl = document.getElementById('insightsWatch');
    wl.innerHTML = '';
    watch.forEach(function (r) { wl.appendChild(listItem(r, 'What should I do about this: "' + r + '"?')); });
    document.getElementById('insightsWatchSec').hidden = !watch.length;

    var opps = data.opportunities || [];
    var ol = document.getElementById('insightsOpportunities');
    ol.innerHTML = '';
    opps.forEach(function (o) { ol.appendChild(listItem(o, 'How can I act on this opportunity: "' + o + '"?')); });
    document.getElementById('insightsOppSec').hidden = !opps.length;

    document.getElementById('insightsSubtitle').textContent = data.generated_at ? 'Generated ' + fmtDate(data.generated_at) : '';

    // Which scenario this brief was written for (older briefs don't say).
    var scenarioRef = document.getElementById('insightsScenarioRef');
    scenarioRef.innerHTML = '';
    scenarioRef.hidden = !data.scenario_id;
    if (data.scenario_id) {
      scenarioRef.append(document.createTextNode('From scenario '));
      var link = node('a', '', data.scenario_label || data.scenario_id);
      link.href = '#';
      link.onclick = function (e) {
        e.preventDefault();
        if (typeof window.viewScenario === 'function') window.viewScenario(data.scenario_id);
      };
      scenarioRef.append(link);
    }

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
