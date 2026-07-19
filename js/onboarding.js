/* ============================================================
   APRABot dashboard — onboarding "Set up your forecast" flow.
   Uploads reuse the existing /scenarios/upload-url presigned S3
   endpoint (no new backend). Map plots serviceable-area postal codes
   via Leaflet + OpenStreetMap tiles, geocoded through Nominatim.
   Model selection is a UI-only placeholder for now — no real
   analysis is run yet.
============================================================ */
(function () {
  'use strict';

  var SCENARIOS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var MAX_PLOTTED = 25; // cap bulk geocoding so a big list doesn't hammer Nominatim's public instance

  var map = null, markersLayer = null;
  var histKey = null;
  var TOTAL_STEPS = 3;
  var step = 1;

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function currentCountry() {
    var sel = document.getElementById('obCountry');
    return sel ? sel.value : 'IN';
  }

  function countryName(c) {
    var sel = document.getElementById('obCountry');
    if (!sel) return 'India';
    var opt = sel.querySelector('option[value="' + c + '"]');
    return opt ? opt.textContent : sel.options[sel.selectedIndex].textContent;
  }

  function validPostal(code, country) {
    code = (code || '').trim();
    if (country === 'IN') return /^\d{6}$/.test(code);
    if (country === 'JP') return /^\d{3}-?\d{4}$/.test(code); // Japan: 123-4567 or 1234567
    return /^[A-Za-z0-9\- ]{3,10}$/.test(code); // generic fallback for other countries
  }

  function ensureMap() {
    if (map) return map;
    map = L.map('obMap', { scrollWheelZoom: false }).setView([22.0, 79.0], 4.2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 0); // guards against sizing to a 0-height container on first paint
    return map;
  }

  function plotPoint(lat, lon, label) {
    ensureMap();
    L.marker([lat, lon]).addTo(markersLayer).bindPopup(label || '');
    map.setView([lat, lon], 10);
  }

  function geocode(code, country) {
    var params = new URLSearchParams({
      postalcode: code,
      country: countryName(country),
      format: 'json',
      limit: '1',
    });
    return fetch(NOMINATIM + '?' + params.toString(), { headers: { 'Accept-Language': 'en' } })
      .then(function (r) { return r.json(); });
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'stest-msg' + (cls ? ' ' + cls : '');
  }

  function checkSingleZip() {
    var input = document.getElementById('obZipInput');
    var statusEl = document.getElementById('obZipStatus');
    var country = currentCountry();
    var code = input.value.trim();
    if (!validPostal(code, country)) {
      setStatus(statusEl, 'Enter a valid ' + countryName(country) + ' postal code.', 'err');
      return;
    }
    setStatus(statusEl, 'Looking up ' + code + '…');
    geocode(code, country).then(function (results) {
      if (!results || !results.length) {
        setStatus(statusEl, 'Could not find that postal code on the map.', 'err');
        return;
      }
      var r = results[0];
      plotPoint(parseFloat(r.lat), parseFloat(r.lon), code);
      setStatus(statusEl, code + ' — shown on the map.', 'ok');
    }).catch(function () {
      setStatus(statusEl, 'Lookup failed — please try again.', 'err');
    });
  }

  // Throttled, sequential geocode for a bulk-uploaded list — stays under
  // Nominatim's public-instance rate limit (~1 req/sec) and caps how many
  // points we actually plot.
  function plotBulk(codes, country) {
    var statusEl = document.getElementById('obAreaStatus');
    var toPlot = codes.slice(0, MAX_PLOTTED);
    var plotted = 0, i = 0;

    function next() {
      if (i >= toPlot.length) {
        var note = codes.length > MAX_PLOTTED
          ? ' (showing first ' + MAX_PLOTTED + ' of ' + codes.length + ')' : '';
        setStatus(statusEl, 'Plotted ' + plotted + ' postal code(s)' + note + '.', 'ok');
        return;
      }
      var code = toPlot[i]; i++;
      if (!validPostal(code, country)) { next(); return; }
      geocode(code, country).then(function (results) {
        if (results && results.length) {
          var r = results[0];
          plotPoint(parseFloat(r.lat), parseFloat(r.lon), code);
          plotted++;
        }
      }).catch(function () {}).then(function () {
        setTimeout(next, 1100);
      });
    }

    setStatus(statusEl, 'Plotting postal codes…');
    next();
  }

  function uploadFile(file, statusEl) {
    setStatus(statusEl, 'Requesting upload URL…');
    return fetch(SCENARIOS_API + '/upload-url', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ filename: file.name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Could not get an upload URL.');
        setStatus(statusEl, 'Uploading ' + file.name + '…');
        return fetch(res.d.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': res.d.content_type },
          body: file,
        }).then(function (putRes) {
          if (!putRes.ok) throw new Error('Upload failed (' + putRes.status + ').');
          setStatus(statusEl, 'Upload complete.', 'ok');
          return res.d.key;
        });
      })
      .catch(function (err) {
        setStatus(statusEl, err.message || 'Upload failed.', 'err');
        throw err;
      });
  }

  function updateSubmitState() {
    // Only the final step (historical data) is required to proceed.
    var btn = document.getElementById('obNext');
    if (btn && step === TOTAL_STEPS) btn.disabled = !histKey;
  }

  function showStep(n) {
    step = n;
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var el = document.getElementById('obStep' + i);
      if (el) el.style.display = (i === n) ? '' : 'none';
    }
    document.getElementById('obProgress').textContent = 'Question ' + n + ' of ' + TOTAL_STEPS;

    var back = document.getElementById('obBack');
    var next = document.getElementById('obNext');
    back.disabled = (n === 1);
    next.textContent = (n === TOTAL_STEPS) ? 'Prepare my model →' : 'Next →';
    next.disabled = (n === TOTAL_STEPS) ? !histKey : false;

    // Leaving the map into view for the first time needs a resize nudge.
    if (n === 2 && map) setTimeout(function () { map.invalidateSize(); }, 0);
  }

  function init() {
    var countrySelect = document.getElementById('obCountry');
    if (!countrySelect) return; // onboarding panel not present on this page

    document.getElementById('obBack').addEventListener('click', function () {
      if (step > 1) showStep(step - 1);
    });

    document.getElementById('obNext').addEventListener('click', function () {
      if (step < TOTAL_STEPS) {
        showStep(step + 1);
        return;
      }
      // Final step — kick off the (UI-only) model preparation state.
      document.getElementById('obSetupForm').style.display = 'none';
      document.getElementById('obPreparing').style.display = '';
      setTimeout(function () {
        document.getElementById('obPreparing').style.display = 'none';
        document.getElementById('obReady').style.display = '';
      }, 6000);
    });

    showStep(1);

    document.getElementById('obZipCheck').addEventListener('click', checkSingleZip);
    document.getElementById('obZipInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') checkSingleZip();
    });

    document.getElementById('obAreaFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obAreaStatus');
      uploadFile(file, statusEl).then(function () {
        var reader = new FileReader();
        reader.onload = function () {
          var codes = String(reader.result).split(/[\r\n,]+/)
            .map(function (s) { return s.trim(); }).filter(Boolean);
          plotBulk(codes, currentCountry());
        };
        reader.readAsText(file);
      }).catch(function () {});
    });

    document.getElementById('obHistFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obHistStatus');
      uploadFile(file, statusEl).then(function (key) {
        histKey = key;
        updateSubmitState();
      }).catch(function () {});
    });

    document.getElementById('obGoScenarios').addEventListener('click', function () {
      var target = Array.prototype.filter.call(document.querySelectorAll('.dnav li'), function (li) {
        return li.textContent.trim() === 'Scenarios';
      })[0];
      if (target) target.click();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
