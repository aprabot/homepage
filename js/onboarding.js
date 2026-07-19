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

  var map = null, markersLayer = null, areaLayer = null;
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

  // High-level country views so the map opens already framed on the right
  // country instead of a generic default — falls back to a world view for
  // countries we don't have a tuned center/zoom for.
  var COUNTRY_VIEWS = {
    IN: [[22.0, 79.0], 4.2],
    JP: [[36.5, 138.0], 4.8],
  };

  function ensureMap() {
    if (map) return map;
    var view = COUNTRY_VIEWS[currentCountry()] || [[20.0, 10.0], 1.8];
    map = L.map('obMap', { scrollWheelZoom: false }).setView(view[0], view[1]);
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
  }

  // Draws a highlighted rectangle over the bounding area of all plotted
  // points, so the serviceable area reads as a region rather than a scatter
  // of pins. Deliberately does not pan/zoom the map — keeps the country-level
  // view steady instead of jumping around as each new point lands.
  function highlightArea(points) {
    if (!points.length) return;
    ensureMap();
    if (areaLayer) { map.removeLayer(areaLayer); areaLayer = null; }
    var bounds = L.latLngBounds(points);
    areaLayer = L.rectangle(bounds.pad(0.08), {
      color: '#C8F24E', weight: 2, fillColor: '#C8F24E', fillOpacity: 0.12,
    }).addTo(map);
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

  // Onboarding panel has to still be the visible section for plotting to keep
  // going — lets a big list keep geocoding in the background while the user
  // stays on this page, but stops as soon as they navigate elsewhere so we're
  // not burning requests against Nominatim's public instance for no one.
  function onboardingVisible() {
    var panel = document.getElementById('onboardingPanel');
    return !!panel && panel.style.display !== 'none';
  }

  // Throttled, sequential geocode for a bulk-uploaded list. Nominatim's public
  // instance asks for a max of ~1 request/sec and no concurrent requests — going
  // faster risks it blocking the whole feature, so instead we plot everything
  // at that safe pace, redrawing the highlighted area after every point (so
  // the shape reads as "done" well before the full list finishes), and stop
  // outright if the user leaves this page. Progress is shown as a blinking
  // yellow border on the map itself rather than a running text counter.
  function plotBulk(codes, country) {
    var statusEl = document.getElementById('obAreaStatus');
    var mapEl = document.getElementById('obMap');
    var toPlot = codes.filter(function (c, idx) { return codes.indexOf(c) === idx; });
    var plotted = 0, i = 0;
    var points = [];

    function next() {
      if (!onboardingVisible()) { mapEl.classList.remove('ob-plotting'); return; } // navigated away — stop quietly

      if (i >= toPlot.length) {
        mapEl.classList.remove('ob-plotting');
        setStatus(statusEl, 'Plotted ' + plotted + ' of ' + toPlot.length + ' postal code(s).', 'ok');
        return;
      }
      var code = toPlot[i]; i++;
      if (!validPostal(code, country)) { next(); return; }
      geocode(code, country).then(function (results) {
        if (results && results.length) {
          var r = results[0];
          var lat = parseFloat(r.lat), lon = parseFloat(r.lon);
          plotPoint(lat, lon, code);
          points.push([lat, lon]);
          plotted++;
          highlightArea(points); // redraw immediately so the area fills in as pins land
        }
      }).catch(function () {}).then(function () {
        setTimeout(next, 1000);
      });
    }

    setStatus(statusEl, '');
    mapEl.classList.add('ob-plotting');
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

    // Render the base map as soon as this step comes into view, rather than
    // waiting for an upload to succeed — otherwise the box just looks blank.
    if (n === 2) {
      ensureMap();
      setTimeout(function () { map.invalidateSize(); }, 0);
    }
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
