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
  var TOTAL_STEPS = 7;
  var step = 1;
  var holidayCountryLoaded = null; // which country's defaults are currently loaded into holidayState
  var weatherLoaded = false; // whether the Weather step's data has already been resolved once

  // Latest warnings from each upload's own validation pass (see "Soft,
  // non-blocking upload validation" below) — stashed here so the final
  // "Review your data" step (7) can show one consolidated recap without
  // re-parsing any file. [] means "checked, nothing to flag", not
  // "not uploaded" — see renderValidationSummary()'s own uploaded check.
  var lastAreaWarnings = [];
  var lastHistWarnings = [];
  var lastWeatherWarnings = [];

  // Parsed rows from the serviceable-area upload — {channel, distributor,
  // pincode} per row. Not consumable by forecast.py yet (same status as
  // newSkuState/holidayState below), so just saved into the onboarding
  // profile JSON for future use rather than dropped.
  var channelDistributorRows = [];

  // id -> {firstDate: Date|null, totalUnits: number|null, auto: bool} — auto
  // entries come from scanning the uploaded data, manual ones from the text
  // field on the "Newly launched SKUs" step. firstDate/totalUnits are null
  // for manual entries since we have no data to back them.
  var newSkuState = {};

  // key -> {date: Date, name: String, auto: bool} — auto entries come from
  // HOLIDAY_RULES for the selected country, manual ones from the "Holidays"
  // step's add row. Keyed by "YYYY-MM-DD|name" so duplicates can't stack.
  var holidayState = {};

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  // A 401 here means the stored token expired mid-session (the page-load
  // guard only checks once, on load) — clear it and send the user back to
  // sign in again, rather than leaving a cryptic failed-request error.
  function signOutExpired() {
    try {
      localStorage.removeItem('apra_access');
      localStorage.removeItem('apra_id');
      localStorage.removeItem('apra_refresh');
    } catch (e) {}
    window.location.replace('/');
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
    if (!el) return; // background uploads (e.g. the onboarding profile) have no visible status UI
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
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) { signOutExpired(); throw new Error('Session expired.'); }
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

  var DATE_COLS = ['ship_day', 'date', 'day'];
  var UNITS_COLS = ['shipped_units', 'units', 'qty', 'quantity'];
  var ASIN_COLS = ['asin', 'sku', 'sku_id'];
  var TEMP_COLS = ['temp_mean', 'temperature', 'temp'];
  var NEW_SKU_WINDOW_DAYS = 90; // flag a SKU as "newly launched" if its first ship date is this close to the dataset's most recent day

  function findCol(row, candidates) {
    var keys = Object.keys(row);
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        if (keys[j].toLowerCase() === candidates[i]) return keys[j];
      }
    }
    return null;
  }

  // Reads tabular rows straight out of the file the user just picked
  // (client-side, nothing sent anywhere). For .xlsx, prefers a sheet named
  // preferredSheet, falling back to the first sheet if there isn't one —
  // right for files dedicated to a single kind of data (Shipments, or a
  // standalone weather upload). csv/tsv/txt have no sheet concept.
  function readTabularRows(file, preferredSheet) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx') {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array' });
        var sheetName = wb.SheetNames.filter(function (n) { return n.toLowerCase() === preferredSheet; })[0]
          || wb.SheetNames[0];
        return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
      });
    }
    return file.text().then(function (text) {
      var delim = ext === 'tsv' || text.indexOf('\t') !== -1 ? '\t' : ',';
      var lines = text.split(/\r\n|\n/).filter(function (l) { return l.trim(); });
      if (!lines.length) return [];
      var headers = lines[0].split(delim).map(function (h) { return h.trim(); });
      return lines.slice(1).map(function (line) {
        var cells = line.split(delim);
        var row = {};
        headers.forEach(function (h, idx) { row[h] = cells[idx] !== undefined ? cells[idx].trim() : null; });
        return row;
      });
    });
  }

  function readShipmentRows(file) { return readTabularRows(file, 'shipments'); }

  // Standalone weather-file upload (step 6) — the whole file is presumably
  // weather data, so fall back to the first sheet like readShipmentRows does.
  function readWeatherFile(file) { return readTabularRows(file, 'weather'); }

  // Reads the optional Weather sheet embedded in the historical-data upload
  // (step 3) — only .xlsx can carry it, and unlike readWeatherFile, there's
  // no fallback: without an exact "Weather" sheet match this would otherwise
  // wrongly grab the Shipments sheet and treat shipment data as weather data.
  function readWeatherRows(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'xlsx') return Promise.resolve([]);
    return file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' });
      var sheetName = wb.SheetNames.filter(function (n) { return n.toLowerCase() === 'weather'; })[0];
      if (!sheetName) return [];
      return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
    });
  }

  /* ===== Soft, non-blocking upload validation ==========================
     Every check here is a WARNING only — nothing blocks the upload or lets
     the wizard proceed differently. The real forecast run downstream is
     the actual source of truth on whether the data is usable; these are
     just an early, plain-English heads-up about the most common mistakes
     (wrong column names, a stray non-numeric row, an implausible value)
     before the user waits minutes to find out from a training run instead. */

  function renderWarnings(listId, warnings) {
    var el = document.getElementById(listId);
    if (!el) return;
    if (!warnings || !warnings.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.innerHTML = warnings.map(function (w) {
      return '<li>' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>';
    }).join('');
    el.style.display = '';
  }

  function validateShipmentRows(rows) {
    var warnings = [];
    if (!rows.length) {
      warnings.push('The file appears to be empty — no rows were found.');
      return warnings;
    }
    var dateCol = findCol(rows[0], DATE_COLS);
    var unitsCol = findCol(rows[0], UNITS_COLS);
    var asinCol = findCol(rows[0], ASIN_COLS);
    if (!dateCol) warnings.push('No recognizable date column found (expected one of: ' + DATE_COLS.join(', ') + ') — shipment volume can’t be charted or checked further.');
    if (!unitsCol) warnings.push('No recognizable units column found (expected one of: ' + UNITS_COLS.join(', ') + ') — shipment volume can’t be charted or checked further.');
    if (!asinCol) warnings.push('No recognizable SKU/ASIN column found (expected one of: ' + ASIN_COLS.join(', ') + ') — newly launched SKUs can’t be auto-detected.');
    if (!dateCol || !unitsCol) return warnings; // nothing further to check without both

    var badDates = 0, badUnits = 0, negUnits = 0, totalUnits = 0, days = {};
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      if (isNaN(d.getTime())) { badDates++; return; }
      days[d.toISOString().slice(0, 10)] = true;
      var u = parseFloat(row[unitsCol]);
      if (isNaN(u)) { badUnits++; return; }
      if (u < 0) negUnits++;
      totalUnits += u;
    });

    if (badDates) warnings.push(badDates + ' row(s) had a date that couldn’t be parsed and were skipped.');
    if (badUnits) warnings.push(badUnits + ' row(s) had a non-numeric units value and were skipped.');
    if (negUnits) warnings.push(negUnits + ' row(s) had a negative units value — shipped units are normally ≥ 0.');
    var dayCount = Object.keys(days).length;
    if (dayCount && dayCount < 60) warnings.push('Only ' + dayCount + ' distinct day(s) of history found — forecasts are usually more reliable with several months of data.');
    if (dayCount && totalUnits === 0) warnings.push('Every parsed row totals 0 units — double check this is the right file.');

    return warnings;
  }

  function validateWeatherRows(rows) {
    var warnings = [];
    if (!rows.length) {
      warnings.push('No weather rows found — check the file has a date and a temperature column (or a sheet named "Weather" for .xlsx).');
      return warnings;
    }
    var dateCol = findCol(rows[0], DATE_COLS);
    var tempCol = findCol(rows[0], TEMP_COLS);
    if (!dateCol) warnings.push('No recognizable date column found (expected one of: ' + DATE_COLS.join(', ') + ').');
    if (!tempCol) warnings.push('No recognizable temperature column found (expected one of: ' + TEMP_COLS.join(', ') + ').');
    if (!dateCol || !tempCol) return warnings;

    var badDates = 0, badTemp = 0, extreme = 0;
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      if (isNaN(d.getTime())) { badDates++; return; }
      var t = parseFloat(row[tempCol]);
      if (isNaN(t)) { badTemp++; return; }
      if (t < -60 || t > 60) extreme++; // plausible Celsius range — catches a Fahrenheit mix-up or a bad parse
    });
    if (badDates) warnings.push(badDates + ' row(s) had a date that couldn’t be parsed and were skipped.');
    if (badTemp) warnings.push(badTemp + ' row(s) had a non-numeric temperature value and were skipped.');
    if (extreme) warnings.push(extreme + ' row(s) have a temperature outside a plausible range (-60°C to 60°C) — worth double-checking the column or units.');
    return warnings;
  }

  // Serviceable-area file is a channel/distributor/pincode mapping, not a
  // bare pincode list — header row required (channel, distributor, pincode;
  // "postal_code"/"postal code" also accepted for the last one, matching
  // the terminology used everywhere else in the product). No quoted-field
  // handling — same simplicity level the old plain-pincode parsing already
  // had for this upload; the richer per-cell parsing lives in the .xlsx
  // Shipments/Price/Weather path via SheetJS, not here.
  var AREA_CHANNEL_COLS     = ['channel'];
  var AREA_DISTRIBUTOR_COLS = ['distributor'];
  var AREA_PINCODE_COLS     = ['pincode', 'postal_code', 'postal code'];

  function parseChannelDistributorFile(text) {
    var lines = String(text).split(/\r\n|\r|\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return { rows: [], headerFound: false };

    var header = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
    var channelIdx     = header.findIndex(function (h) { return AREA_CHANNEL_COLS.indexOf(h) > -1; });
    var distributorIdx = header.findIndex(function (h) { return AREA_DISTRIBUTOR_COLS.indexOf(h) > -1; });
    var pincodeIdx      = header.findIndex(function (h) { return AREA_PINCODE_COLS.indexOf(h) > -1; });
    if (pincodeIdx === -1) return { rows: [], headerFound: false }; // no recognizable header at all

    var rows = lines.slice(1).map(function (line) {
      var cells = line.split(',').map(function (c) { return c.trim(); });
      return {
        channel:     channelIdx > -1 ? (cells[channelIdx] || '') : '',
        distributor: distributorIdx > -1 ? (cells[distributorIdx] || '') : '',
        pincode:     cells[pincodeIdx] || '',
      };
    }).filter(function (r) { return r.pincode; });

    return { rows: rows, headerFound: true, hasChannelCol: channelIdx > -1, hasDistributorCol: distributorIdx > -1 };
  }

  function validateChannelDistributorRows(parsed, country) {
    var warnings = [];
    if (!parsed.headerFound) {
      warnings.push('No recognizable header row found (expected columns: channel, distributor, pincode) — ' +
        'the file will be treated as having no serviceable-area data.');
      return warnings;
    }
    if (!parsed.hasChannelCol) warnings.push('No "channel" column found — channel will be blank for every row.');
    if (!parsed.hasDistributorCol) warnings.push('No "distributor" column found — distributor will be blank for every row.');
    if (!parsed.rows.length) { warnings.push('No pincode rows were found in the file.'); return warnings; }

    var seen = {}, dupes = 0, invalid = 0, missingChannel = 0, missingDistributor = 0;
    parsed.rows.forEach(function (r) {
      var key = r.channel + '|' + r.distributor + '|' + r.pincode;
      if (seen[key]) dupes++; else seen[key] = true;
      if (!validPostal(r.pincode, country)) invalid++;
      if (parsed.hasChannelCol && !r.channel) missingChannel++;
      if (parsed.hasDistributorCol && !r.distributor) missingDistributor++;
    });
    if (invalid) warnings.push(invalid + ' of ' + parsed.rows.length + ' pincode(s) don’t look valid for the selected country and will be skipped.');
    if (dupes) warnings.push(dupes + ' duplicate channel/distributor/pincode row(s) found.');
    if (missingChannel) warnings.push(missingChannel + ' row(s) have a pincode but no channel value.');
    if (missingDistributor) warnings.push(missingDistributor + ' row(s) have a pincode but no distributor value.');
    return warnings;
  }

  // Sums shipped units per calendar day across every SKU/postal code, then
  // buckets into weeks if there are too many distinct days to read as a chart.
  function aggregateByDate(rows) {
    if (!rows.length) return [];
    var dateCol = findCol(rows[0], DATE_COLS);
    var unitsCol = findCol(rows[0], UNITS_COLS);
    if (!dateCol || !unitsCol) return [];

    var byDate = {};
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      var u = parseFloat(row[unitsCol]);
      if (isNaN(d.getTime()) || isNaN(u)) return;
      var key = d.toISOString().slice(0, 10);
      byDate[key] = (byDate[key] || 0) + u;
    });

    var days = Object.keys(byDate).sort().map(function (key) {
      return { date: new Date(key), units: byDate[key] };
    });
    if (days.length <= 60) return days;

    // Too many points to read as a daily line — bucket into weeks instead.
    var byWeek = {};
    days.forEach(function (d) {
      var weekStart = new Date(d.date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      var key = weekStart.toISOString().slice(0, 10);
      byWeek[key] = (byWeek[key] || 0) + d.units;
    });
    return Object.keys(byWeek).sort().map(function (key) {
      return { date: new Date(key), units: byWeek[key] };
    });
  }

  // Same day/week bucketing as aggregateByDate, but averages instead of
  // sums — temperature isn't additive across postal codes/rows like units are.
  function aggregateAvgByDate(rows) {
    if (!rows.length) return [];
    var dateCol = findCol(rows[0], DATE_COLS);
    var tempCol = findCol(rows[0], TEMP_COLS);
    if (!dateCol || !tempCol) return [];

    var byDate = {};
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      var t = parseFloat(row[tempCol]);
      if (isNaN(d.getTime()) || isNaN(t)) return;
      var key = d.toISOString().slice(0, 10);
      if (!byDate[key]) byDate[key] = { sum: 0, n: 0 };
      byDate[key].sum += t; byDate[key].n++;
    });

    var days = Object.keys(byDate).sort().map(function (key) {
      return { date: new Date(key), units: byDate[key].sum / byDate[key].n };
    });
    if (days.length <= 60) return days;

    var byWeek = {};
    days.forEach(function (d) {
      var weekStart = new Date(d.date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      var key = weekStart.toISOString().slice(0, 10);
      if (!byWeek[key]) byWeek[key] = { sum: 0, n: 0 };
      byWeek[key].sum += d.units; byWeek[key].n++;
    });
    return Object.keys(byWeek).sort().map(function (key) {
      return { date: new Date(key), units: byWeek[key].sum / byWeek[key].n };
    });
  }

  // Generic day/week-bucketed line chart, reused for both shipment volume
  // and temperature. Non-negative series (units) keep a zero baseline;
  // series that dip below zero (temperature) get their own min instead.
  function drawLineChart(canvasId, wrapId, points, fmt) {
    fmt = fmt || function (v) { return Math.round(v); };
    var wrap = document.getElementById(wrapId);
    var cv = document.getElementById(canvasId);
    if (!points.length) { wrap.style.display = 'none'; return false; }
    wrap.style.display = '';

    var dpr = window.devicePixelRatio || 1;
    var cw = cv.clientWidth || 600, ch = cv.clientHeight || 200;
    cv.width = cw * dpr; cv.height = ch * dpr;
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var padL = 44, padR = 12, padT = 12, padB = 22;
    var vals = points.map(function (p) { return p.units; });
    var vMax = Math.max.apply(null, vals);
    var vMin = Math.min.apply(null, vals);
    if (vMin > 0) vMin = 0;
    if (vMax === vMin) vMax = vMin + 1;
    var N = points.length;
    var X = function (i) { return N === 1 ? padL : padL + (i / (N - 1)) * (cw - padL - padR); };
    var Y = function (v) { return padT + (1 - (v - vMin) / (vMax - vMin)) * (ch - padT - padB); };

    ctx.font = '10px JetBrains Mono, monospace';
    for (var g = 0; g <= 3; g++) {
      var y = padT + (g / 3) * (ch - padT - padB);
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cw - padR, y); ctx.stroke();
      ctx.fillStyle = '#5C6878'; ctx.textAlign = 'right';
      ctx.fillText(fmt(vMax - (g / 3) * (vMax - vMin)), padL - 8, y + 3);
    }

    ctx.beginPath();
    points.forEach(function (p, i) {
      var x = X(i), y = Y(p.units);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#C8F24E'; ctx.lineWidth = 2; ctx.stroke();

    var grad = ctx.createLinearGradient(0, padT, 0, ch - padB);
    grad.addColorStop(0, 'rgba(200,242,78,.28)');
    grad.addColorStop(1, 'rgba(200,242,78,0)');
    ctx.lineTo(X(N - 1), Y(vMin)); ctx.lineTo(X(0), Y(vMin)); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.fillStyle = '#5C6878'; ctx.textAlign = 'left';
    ctx.fillText(points[0].date.toISOString().slice(0, 10), padL, ch - 6);
    ctx.textAlign = 'right';
    ctx.fillText(points[N - 1].date.toISOString().slice(0, 10), cw - padR, ch - 6);
    return true;
  }

  // Flags any SKU whose earliest ship date falls within NEW_SKU_WINDOW_DAYS
  // of the most recent day in the dataset — a first pass at "this looks like
  // a recent launch, it won't have much history to forecast from yet".
  function detectNewSkus(rows) {
    if (!rows.length) return {};
    var dateCol = findCol(rows[0], DATE_COLS);
    var unitsCol = findCol(rows[0], UNITS_COLS);
    var asinCol = findCol(rows[0], ASIN_COLS);
    if (!dateCol || !asinCol) return {};

    var perAsin = {}, maxDate = null;
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      var asin = row[asinCol];
      if (isNaN(d.getTime()) || !asin) return;
      var u = unitsCol ? parseFloat(row[unitsCol]) : 0;
      if (isNaN(u)) u = 0;
      if (!maxDate || d > maxDate) maxDate = d;
      if (!perAsin[asin]) perAsin[asin] = { firstDate: d, totalUnits: 0 };
      if (d < perAsin[asin].firstDate) perAsin[asin].firstDate = d;
      perAsin[asin].totalUnits += u;
    });
    if (!maxDate) return {};

    var flagged = {};
    Object.keys(perAsin).forEach(function (asin) {
      var info = perAsin[asin];
      var ageDays = (maxDate - info.firstDate) / 86400000;
      if (ageDays <= NEW_SKU_WINDOW_DAYS) {
        flagged[asin] = { firstDate: info.firstDate, totalUnits: info.totalUnits, auto: true };
      }
    });
    return flagged;
  }

  function renderNewSkuList() {
    var listEl = document.getElementById('obNewSkuList');
    var emptyEl = document.getElementById('obNewSkuEmpty');
    if (!listEl) return; // step not present on this page
    var ids = Object.keys(newSkuState).sort();
    listEl.innerHTML = '';
    emptyEl.style.display = ids.length ? 'none' : '';

    ids.forEach(function (id) {
      var info = newSkuState[id];
      var tag = document.createElement('span');
      tag.className = 'sku-tag';

      var label = document.createElement('span');
      label.textContent = id;
      tag.appendChild(label);

      var meta = document.createElement('span');
      meta.className = 'tag-meta';
      meta.textContent = info.firstDate
        ? 'first shipped ' + info.firstDate.toISOString().slice(0, 10)
        : 'added manually';
      tag.appendChild(meta);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + id);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        delete newSkuState[id];
        renderNewSkuList();
      });
      tag.appendChild(rm);

      listEl.appendChild(tag);
    });
  }

  function addManualNewSku() {
    var input = document.getElementById('obNewSkuInput');
    var id = input.value.trim();
    if (!id) return;
    if (!newSkuState[id]) newSkuState[id] = { firstDate: null, totalUnits: null, auto: false };
    input.value = '';
    renderNewSkuList();
  }

  var weatherChartPoints = []; // temperature points parsed from the uploaded file's Weather sheet, if any

  function previewHistChart(file) {
    if (typeof XLSX === 'undefined') return; // library failed to load — skip the preview, upload still proceeds
    readShipmentRows(file).then(function (rows) {
      drawLineChart('obHistChart', 'obHistChartWrap', aggregateByDate(rows));

      var flagged = detectNewSkus(rows);
      Object.keys(newSkuState).forEach(function (id) {
        if (newSkuState[id].auto) delete newSkuState[id]; // replace prior auto-detections, keep manual ones
      });
      Object.assign(newSkuState, flagged);
      renderNewSkuList();

      lastHistWarnings = validateShipmentRows(rows);
      renderWarnings('obHistWarnings', lastHistWarnings);
    }).catch(function () {
      document.getElementById('obHistChartWrap').style.display = 'none';
    });

    readWeatherRows(file).then(function (rows) {
      weatherChartPoints = aggregateAvgByDate(rows);
      weatherLoaded = false; // let the Weather step re-render with this file's data next time it's shown
      if (step === 6) loadWeatherPreview();
    }).catch(function () { weatherChartPoints = []; });
  }

  // Standalone weather file uploaded directly on the Weather step — takes
  // priority over whatever came from the historical-data upload's Weather
  // sheet, since it's a more deliberate, dedicated action.
  function previewWeatherFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' && typeof XLSX === 'undefined') return; // library failed to load — skip the preview
    readWeatherFile(file).then(function (rows) {
      weatherChartPoints = aggregateAvgByDate(rows);
      weatherLoaded = false;
      loadWeatherPreview();
      lastWeatherWarnings = validateWeatherRows(rows);
      renderWarnings('obWeatherWarnings', lastWeatherWarnings);
    }).catch(function () {});
  }

  // Only fixed-date and "nth weekday of month" holidays are listed here —
  // both are exact government-defined rules we can compute correctly for
  // any year. Lunar/astronomical holidays (Diwali, Holi, Eid, the Japanese
  // equinox days, etc.) shift every year in ways we can't safely predict,
  // so those are left for the user to add themselves rather than guessed.
  var HOLIDAY_RULES = {
    IN: [
      { month: 1, day: 26, name: 'Republic Day' },
      { month: 4, day: 14, name: 'Ambedkar Jayanti' },
      { month: 5, day: 1, name: 'May Day' },
      { month: 8, day: 15, name: 'Independence Day' },
      { month: 10, day: 2, name: 'Gandhi Jayanti' },
      { month: 12, day: 25, name: 'Christmas' },
    ],
    JP: [
      { month: 1, day: 1, name: "New Year's Day" },
      { month: 1, weekday: 1, n: 2, name: 'Coming of Age Day' },
      { month: 2, day: 11, name: 'National Foundation Day' },
      { month: 2, day: 23, name: "Emperor's Birthday" },
      { month: 4, day: 29, name: 'Showa Day' },
      { month: 5, day: 3, name: 'Constitution Memorial Day' },
      { month: 5, day: 4, name: 'Greenery Day' },
      { month: 5, day: 5, name: "Children's Day" },
      { month: 7, weekday: 1, n: 3, name: 'Marine Day' },
      { month: 8, day: 11, name: 'Mountain Day' },
      { month: 9, weekday: 1, n: 3, name: 'Respect for the Aged Day' },
      { month: 10, weekday: 1, n: 2, name: 'Sports Day' },
      { month: 11, day: 3, name: 'Culture Day' },
      { month: 11, day: 23, name: 'Labor Thanksgiving Day' },
    ],
  };
  var HOLIDAY_WINDOW_DAYS = 365; // show defaults over the coming year, matching the forecast horizon

  function nthWeekdayOfMonth(year, month, weekday, n) {
    var d = new Date(year, month - 1, 1);
    var offset = (weekday - d.getDay() + 7) % 7;
    d.setDate(1 + offset + (n - 1) * 7);
    return d;
  }

  // Resolves a country's holiday rules into concrete dates falling within
  // the next HOLIDAY_WINDOW_DAYS days (rules can span two calendar years).
  function resolveHolidays(country) {
    var rules = HOLIDAY_RULES[country];
    if (!rules) return [];
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var horizon = new Date(today.getTime() + HOLIDAY_WINDOW_DAYS * 86400000);
    var out = [];
    [today.getFullYear(), today.getFullYear() + 1].forEach(function (year) {
      rules.forEach(function (rule) {
        var d = rule.day
          ? new Date(year, rule.month - 1, rule.day)
          : nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n);
        if (d >= today && d <= horizon) out.push({ date: d, name: rule.name });
      });
    });
    return out.sort(function (a, b) { return a.date - b.date; });
  }

  function holidayKey(date, name) { return date.toISOString().slice(0, 10) + '|' + name; }

  function renderHolidayList() {
    var listEl = document.getElementById('obHolidayList');
    var emptyEl = document.getElementById('obHolidayEmpty');
    if (!listEl) return; // step not present on this page
    var keys = Object.keys(holidayState).sort(function (a, b) {
      return holidayState[a].date - holidayState[b].date;
    });
    listEl.innerHTML = '';
    emptyEl.style.display = keys.length ? 'none' : '';
    emptyEl.textContent = HOLIDAY_RULES[currentCountry()]
      ? 'No holidays listed yet — add one below.'
      : "We don't have default holidays for this country yet — add any that apply below.";

    keys.forEach(function (key) {
      var h = holidayState[key];
      var tag = document.createElement('span');
      tag.className = 'sku-tag';

      var label = document.createElement('span');
      label.textContent = h.name;
      tag.appendChild(label);

      var meta = document.createElement('span');
      meta.className = 'tag-meta';
      meta.textContent = h.date.toISOString().slice(0, 10);
      tag.appendChild(meta);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + h.name);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        delete holidayState[key];
        renderHolidayList();
      });
      tag.appendChild(rm);

      listEl.appendChild(tag);
    });
  }

  // Loads default holidays for the currently selected country, replacing
  // any previously-loaded defaults but keeping manual additions/overrides —
  // re-run whenever the Holidays step comes into view, so switching the
  // country on step 1 and coming back updates the list.
  function loadDefaultHolidays() {
    var country = currentCountry();
    if (country === holidayCountryLoaded) return;
    Object.keys(holidayState).forEach(function (key) {
      if (holidayState[key].auto) delete holidayState[key];
    });
    resolveHolidays(country).forEach(function (h) {
      holidayState[holidayKey(h.date, h.name)] = { date: h.date, name: h.name, auto: true };
    });
    holidayCountryLoaded = country;
    renderHolidayList();
  }

  function addManualHoliday() {
    var dateInput = document.getElementById('obHolidayDate');
    var nameInput = document.getElementById('obHolidayName');
    var dateStr = dateInput.value;
    var name = nameInput.value.trim();
    if (!dateStr || !name) return;
    var date = new Date(dateStr + 'T00:00:00');
    if (isNaN(date.getTime())) return;
    holidayState[holidayKey(date, name)] = { date: date, name: name, auto: false };
    dateInput.value = ''; nameInput.value = '';
    renderHolidayList();
  }

  // Fetches today's current temperature (no key needed, CORS-friendly) for a
  // handful of the plotted serviceable-area points, as a fallback when the
  // uploaded file didn't include a Weather sheet.
  // Weather sheet data (from either the historical-data upload or a
  // standalone weather file) drives the chart; otherwise a plain message
  // explaining there's nothing to show yet.
  function loadWeatherPreview() {
    if (weatherLoaded) return;
    weatherLoaded = true;

    var chartWrap = document.getElementById('obWeatherChartWrap');
    var emptyEl = document.getElementById('obWeatherEmpty');
    chartWrap.style.display = 'none';
    emptyEl.style.display = 'none';

    if (weatherChartPoints.length) {
      drawLineChart('obWeatherChart', 'obWeatherChartWrap', weatherChartPoints,
        function (v) { return v.toFixed(1) + '°C'; });
      return;
    }
    emptyEl.style.display = '';
    emptyEl.textContent = 'No weather data yet — upload a weather file above, or include a Weather sheet with your historical data.';
  }

  function updateSubmitState() {
    // Historical data is the only required upload — gates the final step's button.
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

    // Keep the walkthrough card out of the way once the user is actually
    // working through the questionnaire — only show it back on question 1.
    var walkthroughCard = document.getElementById('obWalkthroughCard');
    if (walkthroughCard) walkthroughCard.style.display = (n === 1) ? 'flex' : 'none';

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

    if (n === 5) loadDefaultHolidays();
    if (n === 6) loadWeatherPreview();
    if (n === 7) renderValidationSummary();
  }

  // Final-step recap of the same soft validation warnings shown inline on
  // steps 2/3/6 as each file was uploaded — one consolidated look before
  // "Prepare my model", rather than only ever seeing each file's own
  // checks in isolation. Still purely informational: every check here is
  // a warning, never a block (see the section comment above these
  // functions), so this never disables the button below it.
  function renderValidationSummary() {
    var pill = document.getElementById('obValidationPill');
    var body = document.getElementById('obValidationSummary');
    if (!pill || !body) return;

    var areaFile = document.getElementById('obAreaFile');
    var sections = [
      { label: 'Serviceable area (channel/distributor/pincode)', warnings: lastAreaWarnings, uploaded: !!(areaFile && areaFile.files.length), required: false },
      { label: 'Historical shipment data', warnings: lastHistWarnings, uploaded: !!histKey, required: true },
      { label: 'Weather', warnings: lastWeatherWarnings, uploaded: weatherChartPoints.length > 0, required: false },
    ];

    var totalWarnings = sections.reduce(function (n, s) { return n + (s.uploaded ? s.warnings.length : 0); }, 0);
    var missingRequired = sections.some(function (s) { return s.required && !s.uploaded; });
    pill.className = 'pill ' + (missingRequired ? 'risk' : totalWarnings ? 'warn' : 'ok');
    pill.textContent = missingRequired
      ? 'Missing required data'
      : totalWarnings
        ? totalWarnings + ' warning' + (totalWarnings > 1 ? 's' : '')
        : 'All checks passed';

    body.innerHTML = sections.map(function (s) {
      // Unlike the "not provided (optional)" cases, a missing REQUIRED
      // upload is the actual reason "Prepare my model" below is disabled —
      // called out with a risk pill instead of blending in as just another
      // optional skip, so it isn't a mystery why the button won't click.
      var statusPill = !s.uploaded
        ? (s.required
          ? '<span class="pill risk" style="margin-left:6px">not uploaded — required</span>'
          : '<span class="dsubtle" style="margin:0 0 0 6px">not provided (optional)</span>')
        : (s.warnings.length
          ? '<span class="pill warn" style="margin-left:6px">' + s.warnings.length + ' warning' + (s.warnings.length > 1 ? 's' : '') + '</span>'
          : '<span class="pill ok" style="margin-left:6px">looks good</span>');
      var list = (s.uploaded && s.warnings.length)
        ? '<ul class="ob-warn-list" style="display:block;margin-top:6px">' +
          s.warnings.map(function (w) { return '<li>' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>'; }).join('') +
          '</ul>'
        : '';
      return '<div style="margin-bottom:16px"><b>' + s.label + '</b>' + statusPill + list + '</div>';
    }).join('');
  }

  var POLL_MS = 8000;
  var MAX_POLLS = 100; // ~13 minutes, under the runner Lambda's 900s ceiling
  var pollTimer = null;
  var pollCount = 0;
  var ONBOARDING_SCENARIO_KEY = 'apra_onboarding_scenario_id';

  // Holidays, newly-launched SKUs, and the channel/distributor/pincode
  // mapping aren't consumable by forecast.py yet (no CLI support for any of
  // them) — saved as a JSON profile for future use rather than silently
  // dropped. Filed as .txt since that's already an allowed upload
  // extension; only the S3 content-type metadata is cosmetically off.
  function buildOnboardingProfile() {
    var profile = {
      country: currentCountry(),
      submitted_at: new Date().toISOString(),
      new_skus: Object.keys(newSkuState).map(function (id) {
        var s = newSkuState[id];
        return { id: id, auto: s.auto, first_shipped: s.firstDate ? s.firstDate.toISOString().slice(0, 10) : null };
      }),
      holidays: Object.keys(holidayState).map(function (key) {
        var h = holidayState[key];
        return { date: h.date.toISOString().slice(0, 10), name: h.name, auto: h.auto };
      }),
      channel_distributor_mapping: channelDistributorRows,
    };
    return new File([JSON.stringify(profile, null, 2)], 'onboarding-profile.txt', { type: 'application/json' });
  }

  function submitOnboardingProfile() {
    uploadFile(buildOnboardingProfile(), null).catch(function () {}); // best-effort, never blocks the main flow
  }

  function showPreparingResult(state, message) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    document.getElementById('obPreparing').style.display = 'none';
    document.getElementById('obReady').style.display = (state === 'ready') ? '' : 'none';
    document.getElementById('obFailed').style.display = (state === 'failed') ? '' : 'none';
    if (state === 'failed' && message) document.getElementById('obFailedMsg').textContent = message;
  }

  // Mirrors js/scenarios.js's own polling (8s interval on GET /scenarios,
  // watching for status !== 'running') rather than a dedicated status route —
  // there isn't one, and the Scenarios tab already proves this pattern works.
  function pollOnboardingScenario(scenarioId) {
    pollCount = 0;
    pollTimer = setInterval(function () {
      pollCount++;
      if (pollCount > MAX_POLLS) {
        clearInterval(pollTimer); pollTimer = null;
        // Stop polling but leave the preparing state up — the run may still finish;
        // the Scenarios tab's own polling will pick it up regardless.
        document.getElementById('obPreparingMsg').textContent =
          'Still working — this is taking longer than usual. Check the Scenarios tab shortly.';
        return;
      }
      fetch(SCENARIOS_API, { headers: authHeaders() })
        .then(function (r) {
          if (r.status === 401) { signOutExpired(); throw new Error('Session expired.'); }
          return r.json();
        })
        .then(function (d) {
          var match = (d.scenarios || []).filter(function (s) { return s.id === scenarioId; })[0];
          if (!match) return; // not indexed yet — try again next tick
          if (match.status === 'completed') showPreparingResult('ready');
          else if (match.status === 'failed') showPreparingResult('failed', 'The model run failed — you can try again.');
        })
        .catch(function () {}); // transient error — just try again next tick
    }, POLL_MS);
  }

  function createOnboardingScenario() {
    fetch(SCENARIOS_API, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        label: 'Onboarding — ' + countryName(currentCountry()) + ' setup',
        known_prices: true, calibrate: true, weather: true, refresh_days: 28,
        custom_input_key: histKey,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) { signOutExpired(); return; }
        if (!res.ok) throw new Error(res.d.error || 'Could not start model preparation.');
        try { localStorage.setItem(ONBOARDING_SCENARIO_KEY, res.d.scenario_id); } catch (e) {}
        pollOnboardingScenario(res.d.scenario_id);
      })
      .catch(function (err) {
        showPreparingResult('failed', err.message || 'Could not start model preparation.');
      });
  }

  // Lets the user leave Getting Started and come back — even after a full
  // page reload — and still see where their submitted run stands, instead
  // of the wizard resetting to question 1 with no memory of it.
  function resumeExistingOnboardingRun() {
    var scenarioId;
    try { scenarioId = localStorage.getItem(ONBOARDING_SCENARIO_KEY); } catch (e) { scenarioId = null; }
    if (!scenarioId) return;

    document.getElementById('obWalkthroughCard').style.display = 'none';
    document.getElementById('obSetupForm').style.display = 'none';
    document.getElementById('obPreparingMsg').textContent = 'Checking on your model…';
    document.getElementById('obPreparing').style.display = '';

    fetch(SCENARIOS_API, { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { signOutExpired(); throw new Error('Session expired.'); }
        return r.json();
      })
      .then(function (d) {
        var match = (d.scenarios || []).filter(function (s) { return s.id === scenarioId; })[0];
        if (!match) {
          try { localStorage.removeItem(ONBOARDING_SCENARIO_KEY); } catch (e) {}
          document.getElementById('obPreparing').style.display = 'none';
          document.getElementById('obSetupForm').style.display = '';
          document.getElementById('obWalkthroughCard').style.display = (step === 1) ? 'flex' : 'none';
          return;
        }
        if (match.status === 'completed') { showPreparingResult('ready'); return; }
        if (match.status === 'failed') { showPreparingResult('failed', 'The model run failed — you can try again.'); return; }
        document.getElementById('obPreparingMsg').textContent =
          'Training a forecasting model on your uploaded data — this can take a few minutes.';
        pollOnboardingScenario(scenarioId);
      })
      .catch(function () {
        document.getElementById('obPreparing').style.display = 'none';
        document.getElementById('obSetupForm').style.display = '';
      });
  }

  // Full reset — clears the remembered run and every piece of wizard state,
  // so the user can set up a fresh model from question 1.
  function startOnboardingOver() {
    try { localStorage.removeItem(ONBOARDING_SCENARIO_KEY); } catch (e) {}
    histKey = null;
    newSkuState = {};
    holidayState = {};
    holidayCountryLoaded = null;
    weatherLoaded = false;
    weatherChartPoints = [];
    lastAreaWarnings = [];
    lastHistWarnings = [];
    lastWeatherWarnings = [];
    channelDistributorRows = [];

    document.getElementById('obReady').style.display = 'none';
    document.getElementById('obFailed').style.display = 'none';
    document.getElementById('obPreparing').style.display = 'none';
    document.getElementById('obSetupForm').style.display = '';

    ['obAreaFile', 'obHistFile', 'obWeatherFile'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('obAreaStatus').textContent = '';
    document.getElementById('obHistStatus').textContent = '';
    document.getElementById('obHistChartWrap').style.display = 'none';
    document.getElementById('obWeatherFileStatus').textContent = '';
    document.getElementById('obWeatherChartWrap').style.display = 'none';
    ['obAreaWarnings', 'obHistWarnings', 'obWeatherWarnings'].forEach(function (id) { renderWarnings(id, []); });
    renderNewSkuList();
    renderHolidayList();
    showStep(1);
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
      // Final step — kick off real model preparation: a live scenario run
      // against the uploaded historical data, polled the same way the
      // Scenarios tab polls its own runs.
      document.getElementById('obSetupForm').style.display = 'none';
      document.getElementById('obFailed').style.display = 'none';
      document.getElementById('obPreparingMsg').textContent =
        'Training a forecasting model on your uploaded data — this can take a few minutes.';
      document.getElementById('obPreparing').style.display = '';
      submitOnboardingProfile();
      createOnboardingScenario();
    });

    document.getElementById('obTryAgain').addEventListener('click', function () {
      try { localStorage.removeItem(ONBOARDING_SCENARIO_KEY); } catch (e) {}
      document.getElementById('obFailed').style.display = 'none';
      document.getElementById('obSetupForm').style.display = '';
      document.getElementById('obWalkthroughCard').style.display = (step === 1) ? 'flex' : 'none';
    });

    document.getElementById('obStartOver').addEventListener('click', startOnboardingOver);

    showStep(1);

    document.getElementById('obAreaFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obAreaStatus');
      uploadFile(file, statusEl).then(function () {
        var reader = new FileReader();
        reader.onload = function () {
          var parsed = parseChannelDistributorFile(String(reader.result));
          channelDistributorRows = parsed.rows;
          lastAreaWarnings = validateChannelDistributorRows(parsed, currentCountry());
          renderWarnings('obAreaWarnings', lastAreaWarnings);
          // The map only cares about the pincode itself, not which channel/
          // distributor serves it.
          plotBulk(parsed.rows.map(function (r) { return r.pincode; }), currentCountry());
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
      previewHistChart(file); // runs independently of the upload — just reads the local file
    });

    document.getElementById('obNewSkuAdd').addEventListener('click', addManualNewSku);
    document.getElementById('obNewSkuInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addManualNewSku(); }
    });
    renderNewSkuList();

    document.getElementById('obHolidayAdd').addEventListener('click', addManualHoliday);
    document.getElementById('obHolidayName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addManualHoliday(); }
    });

    document.getElementById('obWeatherFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obWeatherFileStatus');
      uploadFile(file, statusEl).catch(function () {}); // fire-and-forget — doesn't gate anything downstream
      previewWeatherFile(file);
    });

    document.getElementById('obGoScenarios').addEventListener('click', function () {
      var target = Array.prototype.filter.call(document.querySelectorAll('.dnav li'), function (li) {
        return li.textContent.trim() === 'Scenarios';
      })[0];
      if (target) target.click();
    });

    resumeExistingOnboardingRun();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
