/* ============================================================
   APRABot dashboard — onboarding flow (7 steps, matching the redesign
   mockup): Country, Sales data, Marketing spend, SKU master, Inbound
   receipts, Weather & festivals, Review & train.
   Uploads reuse the existing /scenarios/upload-url presigned S3
   endpoint (no new backend). Every count shown in a step is computed
   client-side from the user's own file; "—" means there's no data.
   Only the sales file (custom_input_key) feeds training today — spend,
   inbound receipts, a separate weather file, festivals, scheme IDs and
   launch dates are saved in the onboarding profile for later use.
============================================================ */
(function () {
  'use strict';

  var SCENARIOS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios';

  var histKey = null;
  var salesSkuIds = null, skuMasterIds = null, skuMasterKey = null;
  var skuMasterUploading = false, skuMasterUploadVersion = 0;
  var spendKey = null, spendSkipped = false;
  var inboundKey = null, inboundSkipped = false;
  var STEP_NAMES = ['country', 'shopify', 'sales', 'spend', 'sku', 'inbound', 'weather', 'review'];
  var TOTAL_STEPS = STEP_NAMES.length;
  var step = 1;
  var holidayCountryLoaded = null; // signature ("country|sorted,detected,states") of the defaults currently loaded into holidayState — see loadDefaultHolidays()

  // Latest warnings from each upload's own validation pass (see "Soft,
  // non-blocking upload validation" below) — stashed so the Review step
  // can reflect them without re-parsing any file. [] means "checked,
  // nothing to flag", not "not uploaded".
  var lastHistWarnings = [];
  var lastWeatherWarnings = [];

  // From the sales file: distinct postal codes (drive India state holidays
  // and the "Pincodes" count), scheme IDs (if a scheme_id column exists),
  // and the summary shown on the Sales data / Review steps.
  var salesPins = [];
  var schemeIds = [];
  var salesSummary = null; // {rows, pins, skus, rangeText} once a sales file has been read

  // Weather, tracked by source because only one of them reaches training:
  // sheetWeather comes from the sales file's Weather sheet (sent with the
  // sales file as custom_input_key — without it the runner falls back to
  // the platform's default raw/weather.tsv); fileWeather comes from a
  // separate upload on the Weather & festivals step, which is only saved
  // (weatherFileKey). Each is {points, range} or null.
  var sheetWeather = null, fileWeather = null, weatherFileKey = null;

  // id -> {firstDate: Date, totalUnits: number, auto: true, launchDate:
  // 'YYYY-MM-DD', confirmed: bool} — every entry comes from scanning the
  // sales file; launchDate starts as the first sale and the user can edit it.
  var newSkuState = {};

  // key -> {date: Date, name: String, auto: bool} — auto entries come from
  // HOLIDAY_RULES for the selected country, manual ones from the Festivals
  // card's Override row. Keyed by "YYYY-MM-DD|name" so duplicates can't stack.
  var holidayState = {};
  var holidayImportVersion = 0;

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

  function stepIs(n, name) { return STEP_NAMES[n - 1] === name; }

  function validPostal(code, country) {
    code = (code || '').trim();
    if (country === 'IN') return /^\d{6}$/.test(code);
    if (country === 'JP') return /^\d{3}-?\d{4}$/.test(code); // 123-4567 or 1234567
    if (country === 'US') return /^\d{5}(-\d{4})?$/.test(code); // 12345 or 12345-6789
    if (country === 'GB') return /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/.test(code); // e.g. SW1A 1AA
    return /^[A-Za-z0-9\- ]{3,10}$/.test(code);
  }

  // Reference facts per country for the Country step's "Defaults this
  // sets" panel. Postal pattern and festival calendar are what the rest of
  // the flow actually uses; the others are the country's standard
  // conventions, shown for reference.
  var COUNTRY_DEFAULTS = {
    IN: { currency: 'INR', weekStart: 'Monday', tz: 'Asia/Kolkata', postal: '6 digits', dateFmt: 'day-first', weather: 'India', festivals: 'India national + state', lang: 'English' },
    US: { currency: 'USD', weekStart: 'Sunday', tz: 'America/New_York', postal: '5-digit ZIP', dateFmt: 'month-first', weather: 'United States', festivals: 'None built in yet', lang: 'English' },
    JP: { currency: 'JPY', weekStart: 'Sunday', tz: 'Asia/Tokyo', postal: '7 digits (123-4567)', dateFmt: 'year-first', weather: 'Japan', festivals: 'Japan national', lang: 'English' },
    GB: { currency: 'GBP', weekStart: 'Monday', tz: 'Europe/London', postal: 'UK postcode', dateFmt: 'day-first', weather: 'United Kingdom', festivals: 'None built in yet', lang: 'English' },
  };

  function renderCountryDefaults() {
    var el = document.getElementById('obCountryDefaults');
    var d = COUNTRY_DEFAULTS[currentCountry()];
    if (!el || !d) return;
    var cells = [
      ['Currency', d.currency], ['Week start', d.weekStart],
      ['Time zone', d.tz], ['Postal pattern', d.postal],
      ['Date format', d.dateFmt], ['Weather region', d.weather],
      ['Festival calendar', d.festivals], ['Language', d.lang],
    ];
    el.innerHTML = cells.map(function (c) { return '<div>' + c[0] + ': <b>' + c[1] + '</b></div>'; }).join('');
  }

  // "Pick it once; it locks after your first file upload" — every later
  // step (postal validation, festival calendar) depends on the country, so
  // it can't silently change under files that were already checked against it.
  function lockCountry() {
    var sel = document.getElementById('obCountry');
    if (!sel || sel.disabled) return;
    sel.disabled = true;
    var note = document.getElementById('obCountryLockNote');
    if (note) note.style.display = '';
  }

  function unlockCountry() {
    var sel = document.getElementById('obCountry');
    if (sel) sel.disabled = false;
    var note = document.getElementById('obCountryLockNote');
    if (note) note.style.display = 'none';
  }

  function setStatus(el, text, cls) {
    if (!el) return; // background uploads (e.g. the onboarding profile) have no visible status UI
    el.textContent = text;
    el.className = 'stest-msg' + (cls ? ' ' + cls : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "18 Oct 2026" from a Date, read in UTC so a date-only value parsed as
  // UTC midnight doesn't slip a day in timezones west of Greenwich.
  function fmtDay(d) {
    var iso = d.toISOString().slice(0, 10);
    return parseInt(iso.slice(8, 10), 10) + ' ' + MONTHS[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + iso.slice(0, 4);
  }

  function rangeText(minD, maxD) {
    var days = Math.round((maxD - minD) / 86400000) + 1;
    if (days < 60) return days + ' day' + (days === 1 ? '' : 's');
    return Math.round(days / 30.44) + ' months';
  }

  function downloadText(filename, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function uploadFile(file, statusEl) {
    setStatus(statusEl, 'Requesting upload URL…');
    return APRA_SESSION.fetch(SCENARIOS_API + '/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
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

  var DATE_COLS = ['ship_day', 'date', 'day'];
  var UNITS_COLS = ['shipped_units', 'units', 'qty', 'quantity'];
  var SKU_COLS = ['sku', 'sku_id', 'asin'];

  function normalizedSku(value) { return String(value ?? '').trim(); }
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
        var sheetName = wb.SheetNames.find(function (n) { return n.trim().toLowerCase() === preferredSheet; })
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
    var skuCol = findCol(rows[0], SKU_COLS);
    if (!dateCol) warnings.push('No recognizable date column found (expected one of: ' + DATE_COLS.join(', ') + ') — shipment volume can’t be charted or checked further.');
    if (!unitsCol) warnings.push('No recognizable units column found (expected one of: ' + UNITS_COLS.join(', ') + ') — shipment volume can’t be charted or checked further.');
    if (!skuCol) warnings.push('No SKU column found. Include a sku column to detect newly launched SKUs.');
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

  // Day/week-bucketed average per date — temperature isn't additive
  // across postal codes/rows the way units are.
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
  // Per-theme chart colours — the dark theme's lime line and white grid are
  // too faint on the light theme's white cards.
  function chartPalette() {
    return document.documentElement.dataset.theme === 'light'
      ? { grid: 'rgba(17,19,24,.08)', axis: '#52606E', line: '#5A8A00', fill: '90,138,0' }
      : { grid: 'rgba(255,255,255,.06)', axis: '#8694A6', line: '#C8F24E', fill: '200,242,78' };
  }

  // Last drawing of each chart, so a theme switch can redraw it in the new colours.
  var drawnCharts = {};
  new MutationObserver(function () {
    Object.keys(drawnCharts).forEach(function (id) {
      var c = drawnCharts[id], wrap = document.getElementById(c[1]);
      if (wrap && wrap.style.display !== 'none') drawLineChart.apply(null, c);
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function drawLineChart(canvasId, wrapId, points, fmt) {
    fmt = fmt || function (v) { return Math.round(v); };
    var wrap = document.getElementById(wrapId);
    var cv = document.getElementById(canvasId);
    if (!points.length) { wrap.style.display = 'none'; delete drawnCharts[canvasId]; return false; }
    wrap.style.display = '';
    drawnCharts[canvasId] = [canvasId, wrapId, points, fmt];
    var P = chartPalette();

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
      ctx.strokeStyle = P.grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cw - padR, y); ctx.stroke();
      ctx.fillStyle = P.axis; ctx.textAlign = 'right';
      ctx.fillText(fmt(vMax - (g / 3) * (vMax - vMin)), padL - 8, y + 3);
    }

    ctx.beginPath();
    points.forEach(function (p, i) {
      var x = X(i), y = Y(p.units);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = P.line; ctx.lineWidth = 2; ctx.stroke();

    var grad = ctx.createLinearGradient(0, padT, 0, ch - padB);
    grad.addColorStop(0, 'rgba(' + P.fill + ',.28)');
    grad.addColorStop(1, 'rgba(' + P.fill + ',0)');
    ctx.lineTo(X(N - 1), Y(vMin)); ctx.lineTo(X(0), Y(vMin)); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.fillStyle = P.axis; ctx.textAlign = 'left';
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
    var skuCol = findCol(rows[0], SKU_COLS);
    if (!dateCol || !skuCol) return {};

    var perSku = {}, maxDate = null;
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      var sku = normalizedSku(row[skuCol]);
      if (isNaN(d.getTime()) || !sku) return;
      var u = unitsCol ? parseFloat(row[unitsCol]) : 0;
      if (isNaN(u)) u = 0;
      if (!maxDate || d > maxDate) maxDate = d;
      if (!perSku[sku]) perSku[sku] = { firstDate: d, totalUnits: 0 };
      if (d < perSku[sku].firstDate) perSku[sku].firstDate = d;
      perSku[sku].totalUnits += u;
    });
    if (!maxDate) return {};

    var flagged = Object.create(null);
    Object.keys(perSku).forEach(function (sku) {
      var info = perSku[sku];
      var ageDays = (maxDate - info.firstDate) / 86400000;
      if (ageDays <= NEW_SKU_WINDOW_DAYS) {
        flagged[sku] = { firstDate: info.firstDate, totalUnits: info.totalUnits, auto: true };
      }
    });
    return flagged;
  }

  var PIN_COLS = ['postal_code', 'pincode', 'zip', 'zip_code', 'postal code'];
  var SCHEME_COLS = ['scheme_id', 'scheme'];

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // SKU master step's "Newly launched SKUs" table — one row per SKU the
  // sales file flags as recent (see detectNewSkus), with an editable launch
  // date (defaults to the first sale) and a Confirm toggle.
  function renderNewSkuList() {
    var body = document.getElementById('obNewSkuBody');
    if (!body) return; // step not present on this page
    var ids = Object.keys(newSkuState).sort();
    body.innerHTML = '';
    if (!ids.length) {
      var msg = !salesSummary
        ? 'Upload your sales file on the Sales data step to find newly launched SKUs.'
        : salesSummary.skus == null
          ? 'Your sales file has no SKU column, so launches can’t be detected.'
          : 'None found — every SKU in your sales file has more than ' + NEW_SKU_WINDOW_DAYS + ' days of history.';
      body.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">' + escapeHtml(msg) + '</td></tr>';
      return;
    }
    ids.forEach(function (id) {
      var info = newSkuState[id];
      var tr = document.createElement('tr');

      var tdId = document.createElement('td');
      tdId.textContent = id;
      tdId.style.fontFamily = 'var(--mono)';

      var tdFirst = document.createElement('td');
      tdFirst.textContent = fmtDay(info.firstDate);

      var tdLaunch = document.createElement('td');
      var input = document.createElement('input');
      input.type = 'date';
      input.value = info.launchDate;
      input.setAttribute('aria-label', 'Launch date for ' + id);
      input.addEventListener('change', function () { if (input.value) info.launchDate = input.value; });
      tdLaunch.appendChild(input);

      var tdBtn = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dbtn';
      btn.style.padding = '4px 10px';
      btn.style.fontSize = '11.5px';
      var paint = function () {
        btn.textContent = info.confirmed ? 'Confirmed ✓' : 'Confirm';
        btn.style.background = info.confirmed ? 'var(--ink-3)' : '';
        btn.style.color = info.confirmed ? 'var(--text)' : '';
        btn.style.border = info.confirmed ? '1px solid var(--line-2)' : '';
      };
      paint();
      btn.addEventListener('click', function () { info.confirmed = !info.confirmed; paint(); });
      tdBtn.appendChild(btn);

      tr.appendChild(tdId); tr.appendChild(tdFirst); tr.appendChild(tdLaunch); tr.appendChild(tdBtn);
      body.appendChild(tr);
    });
  }

  // Sales data step's summary (Rows / Pincodes / SKUs / Date range) and the
  // scheme-ID callout, straight from the uploaded rows. A count whose column
  // doesn't exist in the file stays "—" rather than showing 0.
  function renderSalesSummary(rows) {
    var first = rows[0] || {};
    var dateCol = findCol(first, DATE_COLS);
    var skuCol = findCol(first, SKU_COLS);
    var pinCol = findCol(first, PIN_COLS);
    var schemeCol = findCol(first, SCHEME_COLS);
    var country = currentCountry();
    var pins = {}, skus = new Set(), schemes = {}, minD = null, maxD = null, badPins = 0;

    rows.forEach(function (row) {
      if (skuCol) {
        var sku = normalizedSku(row[skuCol]);
        if (sku) skus.add(sku);
      }
      if (pinCol && row[pinCol]) {
        var pc = String(row[pinCol]).trim();
        if (pc && !pins[pc]) {
          pins[pc] = true;
          if (!validPostal(pc, country)) badPins++;
        }
      }
      if (schemeCol && row[schemeCol]) {
        var sid = String(row[schemeCol]).trim();
        if (sid) schemes[sid] = true;
      }
      if (dateCol) {
        var d = new Date(row[dateCol]);
        if (!isNaN(d.getTime())) {
          if (!minD || d < minD) minD = d;
          if (!maxD || d > maxD) maxD = d;
        }
      }
    });

    salesSkuIds = skuCol ? skus : null;
    salesPins = pinCol ? Object.keys(pins) : [];
    schemeIds = schemeCol ? Object.keys(schemes) : [];
    salesSummary = {
      rows: rows.length,
      pins: pinCol ? salesPins.length : null,
      skus: salesSkuIds ? salesSkuIds.size : null,
      rangeText: minD ? rangeText(minD, maxD) : null,
      hasPinCol: !!pinCol,
      badPins: badPins,
    };

    setText('obSalesRows', rows.length.toLocaleString());
    setText('obSalesPins', salesSummary.pins == null ? '—' : salesSummary.pins.toLocaleString());
    setText('obSalesSkus', salesSummary.skus == null ? '—' : salesSummary.skus.toLocaleString());
    setText('obSalesRange', salesSummary.rangeText || '—');
    renderSkuMasterSummary();

    var callout = document.getElementById('obSchemeCallout');
    if (callout) {
      callout.style.display = schemeCol ? '' : 'none';
      callout.textContent = !schemeCol ? ''
        : schemeIds.length
          ? schemeIds.length.toLocaleString() + ' scheme ID' + (schemeIds.length === 1 ? '' : 's') + ' found in your sales file. View detected schemes under Forecast → Discount Schemes.'
          : 'A scheme_id column was found, but every value in it is empty.';
    }
  }

  // Reads the sales file locally (nothing sent anywhere — the upload itself
  // is separate) to fill the Sales data summary, the SKU master table, the
  // inline warnings, and the Weather card if the file carries a Weather sheet.
  function analyzeSalesFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' && typeof XLSX === 'undefined') return; // library failed to load — skip the read, upload still proceeds
    readShipmentRows(file).then(function (rows) {
      renderSalesSummary(rows);

      var flagged = detectNewSkus(rows), prev = newSkuState;
      newSkuState = {};
      Object.keys(flagged).forEach(function (id) {
        var p = prev[id], f = flagged[id];
        newSkuState[id] = {
          firstDate: f.firstDate, totalUnits: f.totalUnits, auto: true,
          launchDate: p ? p.launchDate : f.firstDate.toISOString().slice(0, 10),
          confirmed: p ? p.confirmed : false,
        };
      });
      renderNewSkuList();

      lastHistWarnings = validateShipmentRows(rows);
      if (rows.length && !salesSummary.hasPinCol) {
        lastHistWarnings.push('No postal_code column found — the pincode count and state holidays need it.');
      }
      if (salesSummary.badPins) {
        lastHistWarnings.push(salesSummary.badPins + ' of ' + salesSummary.pins + ' postal code(s) don’t match the ' +
          countryName(currentCountry()) + ' pattern (' + COUNTRY_DEFAULTS[currentCountry()].postal + ').');
      }
      renderWarnings('obHistWarnings', lastHistWarnings);
    }).catch(function () {});

    readWeatherRows(file).then(function (rows) {
      sheetWeather = weatherFromRows(rows);
      if (stepIs(step, 'weather')) renderWeatherCard();
    }).catch(function () { sheetWeather = null; });
  }

  // Range comes from the raw rows, not the chart points — those can be
  // week-bucketed, which would shift the first date back to a week start.
  function weatherFromRows(rows) {
    var pts = aggregateAvgByDate(rows);
    if (!pts.length) return null;
    var dateCol = findCol(rows[0], DATE_COLS), tempCol = findCol(rows[0], TEMP_COLS);
    var minD = null, maxD = null;
    rows.forEach(function (row) {
      var d = new Date(row[dateCol]);
      if (isNaN(d.getTime()) || isNaN(parseFloat(row[tempCol]))) return;
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    });
    return { points: pts, range: fmtDay(minD) + ' – ' + fmtDay(maxD) };
  }

  // Separate weather file uploaded on the Weather & festivals step.
  function previewWeatherFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' && typeof XLSX === 'undefined') return; // library failed to load — skip the preview
    readWeatherFile(file).then(function (rows) {
      fileWeather = weatherFromRows(rows);
      lastWeatherWarnings = validateWeatherRows(rows);
      renderWarnings('obWeatherWarnings', lastWeatherWarnings);
      renderWeatherCard();
    }).catch(function () {});
  }

  // Marketing spend summary — Campaigns, Past / planned (by each campaign's
  // latest date vs today), Detail level (which breakdown columns exist), and
  // spend share by channel. Any figure whose column is missing stays "—".
  var SPEND_CAMPAIGN_COLS = ['campaign', 'campaign_id', 'campaign_name'];
  var SPEND_CHANNEL_COLS = ['channel', 'platform', 'source', 'media'];
  var SPEND_AMOUNT_COLS = ['spend', 'amount', 'cost', 'spend_amount', 'budget'];
  var SPEND_DATE_COLS = DATE_COLS.concat(['start_date', 'end_date', 'week', 'month']);

  function resetSpendSummary() {
    ['obSpendCampaigns', 'obSpendPastPlanned', 'obSpendDetail'].forEach(function (id) { setText(id, '—'); });
    var pill = document.getElementById('obSpendChannels');
    if (pill) pill.style.display = 'none';
  }

  function analyzeSpendFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' && typeof XLSX === 'undefined') return;
    readTabularRows(file, 'spend').then(function (rows) {
      resetSpendSummary();
      if (!rows.length) return;
      var first = rows[0];
      var cCol = findCol(first, SPEND_CAMPAIGN_COLS), chCol = findCol(first, SPEND_CHANNEL_COLS);
      var aCol = findCol(first, SPEND_AMOUNT_COLS), dCol = findCol(first, SPEND_DATE_COLS);
      var pCol = findCol(first, PIN_COLS), sCol = findCol(first, SKU_COLS);
      var lastDate = {}, byChannel = {}, total = 0;

      rows.forEach(function (r) {
        var c = cCol ? r[cCol] : null;
        if (c) {
          if (!(c in lastDate)) lastDate[c] = null;
          if (dCol) {
            var d = new Date(r[dCol]);
            if (!isNaN(d.getTime()) && (!lastDate[c] || d > lastDate[c])) lastDate[c] = d;
          }
        }
        if (chCol && aCol) {
          var amt = parseFloat(String(r[aCol] == null ? '' : r[aCol]).replace(/,/g, ''));
          if (!isNaN(amt) && amt > 0) {
            var ch = r[chCol] || 'Unlabelled';
            byChannel[ch] = (byChannel[ch] || 0) + amt;
            total += amt;
          }
        }
      });

      var campaigns = Object.keys(lastDate);
      if (cCol) setText('obSpendCampaigns', campaigns.length.toLocaleString());
      if (cCol && dCol) {
        var now = new Date(), past = 0, planned = 0;
        campaigns.forEach(function (c) {
          if (!lastDate[c]) return;
          if (lastDate[c] <= now) past++; else planned++;
        });
        setText('obSpendPastPlanned', past + ' / ' + planned);
      }
      setText('obSpendDetail', pCol && sCol ? 'Pincode + SKU' : pCol ? 'Pincode' : sCol ? 'SKU' : 'Overall');

      if (total > 0) {
        var chans = Object.keys(byChannel).sort(function (a, b) { return byChannel[b] - byChannel[a]; });
        var parts = chans.slice(0, 3).map(function (ch) { return ch + ' ' + Math.round(byChannel[ch] / total * 100) + '%'; });
        if (chans.length > 3) {
          var rest = chans.slice(3).reduce(function (s, ch) { return s + byChannel[ch]; }, 0);
          parts.push('Other ' + Math.round(rest / total * 100) + '%');
        }
        var pill = document.getElementById('obSpendChannels');
        pill.textContent = 'Spend by channel: ' + parts.join(' · ');
        pill.style.display = 'inline-block';
      }
    }).catch(function () {});
  }

  // Inbound receipts site list — distinct site codes (and names, if there's
  // a name column) from the uploaded file. "In sales file?" stays "—": the
  // sales file has no site column to match against.
  var SITE_CODE_COLS = ['site_code', 'site', 'warehouse_code', 'warehouse', 'location_code', 'location', 'dc'];
  var SITE_NAME_COLS = ['site_name', 'warehouse_name', 'location_name', 'name'];

  function analyzeInboundFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx' && typeof XLSX === 'undefined') return;
    readTabularRows(file, 'receipts').then(function (rows) {
      var wrap = document.getElementById('obInboundSitesWrap');
      var body = document.getElementById('obInboundSites');
      var first = rows[0] || {};
      var codeCol = findCol(first, SITE_CODE_COLS), nameCol = findCol(first, SITE_NAME_COLS);
      if (!codeCol) { wrap.style.display = 'none'; body.innerHTML = ''; return; }
      var sites = {};
      rows.forEach(function (r) {
        var code = r[codeCol];
        if (code && !(code in sites)) sites[code] = nameCol ? (r[nameCol] || '') : '';
        else if (code && !sites[code] && nameCol && r[nameCol]) sites[code] = r[nameCol];
      });
      body.innerHTML = Object.keys(sites).sort().map(function (code) {
        return '<tr><td style="font-family:var(--mono)">' + escapeHtml(code) + '</td>' +
          '<td>' + (sites[code] ? escapeHtml(sites[code]) : '<span style="color:var(--muted-2)">—</span>') + '</td>' +
          '<td><span style="color:var(--muted-2)">—</span></td></tr>';
      }).join('');
      wrap.style.display = '';
    }).catch(function () {});
  }

  var SALES_TEMPLATE_PIN = { IN: '110001', US: '10001', JP: '135-0061', GB: 'SW1A 1AA' };

  function downloadSalesTemplate() {
    var pin = SALES_TEMPLATE_PIN[currentCountry()] || '110001';
    downloadText('apra_sales_template.csv',
      'ship_day,sku,postal_code,shipped_units\n' +
      '2025-01-06,SKU-EXAMPLE-001,' + pin + ',42\n' +
      '2025-01-06,SKU-EXAMPLE-002,' + pin + ',17\n');
  }

  function renderSkuMasterSummary() {
    var matched = salesSkuIds && skuMasterIds
      ? Array.from(salesSkuIds).filter(function (sku) { return skuMasterIds.has(sku); }).length
      : null;
    setText('obSkuInSales', salesSkuIds ? salesSkuIds.size.toLocaleString() : '—');
    setText('obSkuInMaster', skuMasterIds ? skuMasterIds.size.toLocaleString() : '—');
    setText('obSkuMatched', matched == null ? '—' : matched.toLocaleString());
    setText('obSkuMissing', matched == null ? '—'
      : (salesSkuIds.size + skuMasterIds.size - 2 * matched).toLocaleString());
  }

  async function uploadSkuMaster(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = '';
    var status = document.getElementById('obSkuMasterStatus');
    var version = ++skuMasterUploadVersion;
    skuMasterUploading = true;
    input.disabled = true;
    updateSubmitState();
    setStatus(status, 'Reading ' + file.name + '…');
    try {
      if (!/\.(csv|xlsx|tsv|txt)$/i.test(file.name)) throw new Error('Choose a CSV, TSV, TXT, or XLSX file.');
      var rows;
      if (/\.(csv|tsv|txt)$/i.test(file.name) && typeof XLSX !== 'undefined') {
        var text = await file.text();
        var delimiter = /\.tsv$/i.test(file.name) || (/\.txt$/i.test(file.name) && text.split(/\r?\n/, 1)[0].includes('\t')) ? '\t' : ',';
        var book = XLSX.read(text, {type: 'string', raw: true, FS: delimiter});
        var sheet = book.Sheets[book.SheetNames[0]];
        rows = sheet ? XLSX.utils.sheet_to_json(sheet, {defval: null}) : [];
      } else rows = await readTabularRows(file, 'sku master');
      var column = rows.length && findCol(rows[0], SKU_COLS);
      var ids = new Set(column ? rows.map(function (row) { return normalizedSku(row[column]); }).filter(Boolean) : []);
      if (!ids.size) throw new Error('Include a sku column with at least one SKU.');
      if (version !== skuMasterUploadVersion) return;

      setStatus(status, 'Uploading ' + file.name + '…');
      var key = await uploadFile(file, null);
      if (version !== skuMasterUploadVersion) return;
      skuMasterKey = key;
      skuMasterIds = ids;
      lockCountry();
      renderSkuMasterSummary();
      setStatus(status, file.name + ' saved with your setup.', 'ok');
    } catch (error) {
      if (version !== skuMasterUploadVersion) return;
      setStatus(status, (error.message || 'Could not upload the SKU master.') +
        (skuMasterKey ? ' The previous SKU master is still in use.' : ''), 'err');
    } finally {
      if (version === skuMasterUploadVersion) {
        skuMasterUploading = false;
        input.disabled = false;
        updateSubmitState();
        if (stepIs(step, 'review')) renderReviewSummary();
      }
    }
  }

  function downloadSkuMasterTemplate() {
    downloadText('apra_sku_master_template.csv', 'sku,product_name\nSKU-EXAMPLE-001,Example product\n');
  }

  function downloadInboundTemplate() {
    downloadText('apra_inbound_receipts_template.csv',
      'receipt_date,site_code,site_name,sku,units_received\n' +
      '2025-01-06,DC-01,Main DC,SKU-EXAMPLE-001,500\n');
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
  // State-level holidays for India, keyed by the same full state name shown
  // in PIN_PREFIX_TO_STATE_IN below. The full name is stored as the state
  // and shown alongside the festival date.
  //
  // Same bar as HOLIDAY_RULES above: only state holidays with a fixed (or
  // effectively fixed) Gregorian date are listed — state-formation-day
  // anniversaries (gazetted against the Gregorian calendar directly), plus
  // the handful of solar-calendar new year festivals that, like Baisakhi,
  // track the sun's entry into Mesha and so fall on April 13 or 14 (never
  // drifting further) rather than a true lunar date.
  //
  // Deliberately excluded, despite being well-known state holidays, because
  // their date actually shifts year to year on a lunar or lunisolar
  // calendar: Gudi Padwa and Ugadi (Maharashtra/Karnataka/Telangana/AP),
  // Onam (Malayalam calendar, Kerala), Bihu (Assamese calendar), Durga
  // Puja/Vijaya Dashami (West Bengal), and Pongal (commonly cited as Jan
  // 14/15, but several states' official calendars move it further some
  // years) — left for the user to confirm and add manually, same as
  // Diwali/Holi/Eid in the national list above.
  var HOLIDAY_RULES_STATE_IN = {
    'Maharashtra': [
      { month: 5, day: 1, name: 'Maharashtra Day' },
    ],
    'Tamil Nadu': [
      { month: 4, day: 14, name: 'Tamil New Year (Puthandu)' },
    ],
    'Karnataka': [
      { month: 11, day: 1, name: 'Karnataka Rajyotsava' },
    ],
    'Gujarat': [
      { month: 5, day: 1, name: 'Gujarat Day' },
    ],
    'West Bengal': [
      { month: 4, day: 14, name: 'Bengali New Year (Pohela Boishakh)' },
    ],
    'Punjab': [
      { month: 4, day: 13, name: 'Baisakhi' },
    ],
    'Kerala': [
      // Onam excluded (Malayalam-calendar lunar date, shifts every year) —
      // no other state holiday here clears the fixed-date bar.
    ],
    'Telangana': [
      { month: 6, day: 2, name: 'Telangana Formation Day' },
    ],
    'Delhi': [
      // No state-specific holiday here clears the fixed-date bar — Delhi
      // observes the IN national calendar as-is.
    ],
  };

  // India Post's postal circles assign the first 1-2 digits of a 6-digit PIN
  // to a state/UT — a long-stable public mapping (unchanged in decades), so
  // it's safe to hardcode rather than look up. Longer (2-digit) prefixes are
  // checked before shorter (1-digit) ones in pinToStatesIN() below, since a
  // state's range is sometimes a narrow slice of a wider single-digit zone
  // (e.g. Goa's 403 sits inside Maharashtra's broader 40-44 zone).
  //
  // Only the states covered by HOLIDAY_RULES_STATE_IN are listed — no point
  // mapping PIN prefixes for a state we have no holiday data for yet.
  var PIN_PREFIX_TO_STATE_IN = {
    '11': 'Delhi',
    '14': 'Punjab', '15': 'Punjab', '16': 'Punjab',
    '36': 'Gujarat', '37': 'Gujarat', '38': 'Gujarat', '39': 'Gujarat',
    '40': 'Maharashtra', '41': 'Maharashtra', '42': 'Maharashtra', '43': 'Maharashtra', '44': 'Maharashtra',
    '50': 'Telangana',
    '56': 'Karnataka', '57': 'Karnataka', '58': 'Karnataka', '59': 'Karnataka',
    '60': 'Tamil Nadu', '61': 'Tamil Nadu', '62': 'Tamil Nadu', '63': 'Tamil Nadu', '64': 'Tamil Nadu',
    '67': 'Kerala', '68': 'Kerala', '69': 'Kerala',
    '70': 'West Bengal', '71': 'West Bengal', '72': 'West Bengal', '73': 'West Bengal', '74': 'West Bengal',
  };

  // 3-digit carve-outs for union-territory enclaves that sit *inside* one of
  // the state ranges above — without this, e.g. every Chandigarh (UT) pincode
  // would be silently misattributed to Punjab. None of these UTs are in
  // HOLIDAY_RULES_STATE_IN, so excluding them is strictly safer than guessing
  // which state's holidays (if any) should apply to them. Lakshadweep is
  // handled separately below (a 682551-682559 sub-range, not the whole 682
  // prefix) since 682xxx is mostly genuine Kerala (Kochi/Ernakulam) addresses
  // — excluding all of 682 would wrongly drop real Kerala pincodes too.
  var PIN_PREFIX_EXCLUDE_IN = {
    '403': true, // Goa, inside Maharashtra's 40-44
    '160': true, // Chandigarh (UT), inside Punjab's 16
    '362': true, // Diu (Daman & Diu UT), inside Gujarat's 36
    '396': true, // Daman & Dadra and Nagar Haveli (UT), inside Gujarat's 39
    '605': true, '607': true, '609': true, // Puducherry (UT) enclaves, inside Tamil Nadu's 60
    '673': true, // Mahe, a Puducherry (UT) enclave, inside Kerala's 67
    '737': true, // Sikkim, inside West Bengal's 73
    '744': true, // Andaman & Nicobar Islands (UT), inside West Bengal's 74
  };

  // Resolves a list of raw pincode strings (as collected from the
  // sales file's postal_code column — see salesPins) to the distinct
  // Indian states they fall in, for merging state-level holidays into the
  // defaults. Multi-region businesses naturally resolve to multiple states;
  // dedupe is the caller's job via the returned array's uniqueness here.
  function pinToStatesIN(pincodes) {
    var states = {};
    (pincodes || []).forEach(function (code) {
      code = (code || '').trim();
      if (!/^\d{6}$/.test(code)) return;
      if (PIN_PREFIX_EXCLUDE_IN[code.slice(0, 3)]) return;
      var num = parseInt(code, 10);
      if (num >= 682551 && num <= 682559) return; // Lakshadweep (UT) — see comment above
      var state = PIN_PREFIX_TO_STATE_IN[code.slice(0, 2)];
      if (state) states[state] = true;
    });
    return Object.keys(states);
  }

  var HOLIDAY_WINDOW_DAYS = 365; // show defaults over the coming year, matching the forecast horizon

  function nthWeekdayOfMonth(year, month, weekday, n) {
    var d = new Date(Date.UTC(year, month - 1, 1));
    var offset = (weekday - d.getUTCDay() + 7) % 7;
    d.setUTCDate(1 + offset + (n - 1) * 7);
    return d;
  }

  // Shared by resolveHolidays/resolveStateHolidays below — turns a flat
  // rules array into concrete dates falling within the next
  // HOLIDAY_WINDOW_DAYS days (rules can span two calendar years).
  function resolveRules(rules) {
    var now = new Date();
    var today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    var horizon = new Date(today.getTime() + HOLIDAY_WINDOW_DAYS * 86400000);
    var out = [];
    [today.getUTCFullYear(), today.getUTCFullYear() + 1].forEach(function (year) {
      rules.forEach(function (rule) {
        var d = rule.day
          ? new Date(Date.UTC(year, rule.month - 1, rule.day))
          : nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.n);
        if (d >= today && d <= horizon) out.push({ date: d, name: rule.name });
      });
    });
    return out.sort(function (a, b) { return a.date - b.date; });
  }

  // Resolves a country's national holiday rules into concrete dates.
  function resolveHolidays(country) {
    var rules = HOLIDAY_RULES[country];
    if (!rules) return [];
    return resolveRules(rules);
  }

  function resolveStateHolidays(pincodes) {
    return pinToStatesIN(pincodes).flatMap(function (state) {
      return resolveRules(HOLIDAY_RULES_STATE_IN[state] || []).map(function (holiday) {
        return { ...holiday, state: state };
      });
    });
  }

  function holidayStateNames(country) {
    return country === 'IN' ? Object.keys(HOLIDAY_RULES_STATE_IN).sort() : [];
  }

  function normalizeHolidayState(value, country) {
    var state = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (state.length < 2 || state.length > 80 || !/\p{L}/u.test(state)) return null;
    return holidayStateNames(country).find(function (name) {
      return name.toLowerCase() === state.toLowerCase();
    }) || state;
  }

  function holidayKey(entry) {
    return JSON.stringify([entry.country, entry.state?.toLowerCase() || '', entry.date.toISOString().slice(0, 10),
      entry.name.toLowerCase()]);
  }

  function holidaysForCountry(country = currentCountry()) {
    return Object.values(holidayState).filter(function (holiday) { return holiday.country === country; });
  }

  function renderHolidayStateChoices() {
    var options = document.getElementById('obHolidayStateOptions');
    var states = holidayStateNames(currentCountry());
    options.replaceChildren(...states.map(function (state) { return new Option(state, state); }));
  }

  function renderHolidayList() {
    var listEl = document.getElementById('obHolidayList');
    var emptyEl = document.getElementById('obHolidayEmpty');
    if (!listEl) return; // step not present on this page
    var holidays = holidaysForCountry().sort(function (a, b) {
      return a.date - b.date || (a.state || '').localeCompare(b.state || '') || a.name.localeCompare(b.name);
    });
    listEl.innerHTML = '';
    emptyEl.style.display = holidays.length ? 'none' : '';
    emptyEl.textContent = HOLIDAY_RULES[currentCountry()]
      ? 'No holidays listed yet — add one below.'
      : "We don't have default holidays for this country yet — add any that apply below.";

    holidays.forEach(function (h) {
      var scope = h.state || 'Nationwide';
      var tag = document.createElement('span');
      tag.className = 'sku-tag';

      var label = document.createElement('span');
      label.textContent = h.name;
      tag.appendChild(label);

      var meta = document.createElement('span');
      meta.className = 'tag-meta';
      meta.textContent = h.date.toISOString().slice(0, 10) + ' · ' + scope;
      tag.appendChild(meta);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + h.name + ' in ' + scope);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        delete holidayState[holidayKey(h)];
        renderHolidayList();
      });
      tag.appendChild(rm);

      listEl.appendChild(tag);
    });
    renderFestivalCard();
  }

  // Festivals card on the Weather & festivals step: a count pill plus a
  // plain line saying where the list came from. The editable list itself
  // sits behind Override.
  function renderFestivalCard() {
    var pill = document.getElementById('obHolidayPill');
    var intro = document.getElementById('obHolidayIntro');
    if (!pill || !intro) return;
    var country = currentCountry();
    var n = holidaysForCountry(country).length;
    // Only name states that actually contributed holidays — a detected
    // state with no built-in state rules adds nothing.
    var states = (country === 'IN' ? pinToStatesIN(salesPins) : []).filter(function (s) {
      return HOLIDAY_RULES_STATE_IN[s] && HOLIDAY_RULES_STATE_IN[s].length;
    });
    var text;
    if (HOLIDAY_RULES[country]) {
      pill.className = 'pill ok';
      pill.textContent = n + ' festivals & holidays listed';
      text = countryName(country) + ' national calendar' +
        (states.length
          ? ', plus state holidays for ' + states.join(', ') + ' (from your sales file’s pincodes)'
          : country === 'IN' ? '. Upload a sales file with postal codes to add state holidays' : '') +
        '. Use Override to add festivals by state or region.';
    } else {
      pill.className = n ? 'pill ok' : 'pill warn';
      pill.textContent = n
        ? n + ' festival' + (n === 1 ? '' : 's') + ' & holidays added'
        : 'No built-in calendar for ' + countryName(country) + ' yet';
      text = 'Use Override to add festivals by state or region.';
    }
    intro.textContent = text + ' Saved with your setup — training doesn’t use festivals yet.';
  }

  // Loads default holidays for the currently selected country, replacing
  // any previously-loaded defaults but keeping manual additions — re-run
  // whenever the Weather & festivals step comes into view. For India, also
  // merges in state-level holidays inferred from the sales file's postal
  // codes; the signature includes the detected states so uploading a sales
  // file after already viewing this step still picks them up.
  function loadDefaultHolidays() {
    var country = currentCountry();
    var states = country === 'IN' ? pinToStatesIN(salesPins) : [];
    var signature = country + '|' + states.slice().sort().join(',');
    if (signature === holidayCountryLoaded) return;
    Object.keys(holidayState).forEach(function (key) {
      if (holidayState[key].auto) delete holidayState[key];
    });
    var detected = country === 'IN' ? resolveStateHolidays(salesPins) : [];
    resolveHolidays(country).concat(detected).forEach(function (holiday) {
      var entry = { ...holiday, state: holiday.state || null, country: country, auto: true };
      var key = holidayKey(entry);
      if (!holidayState[key]) holidayState[key] = entry;
    });
    holidayCountryLoaded = signature;
    renderHolidayList();
  }

  function parseHolidayDate(value) {
    var day = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    var date = new Date(day + 'T00:00:00Z');
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? date : null;
  }

  function addManualHoliday() {
    var dateInput = document.getElementById('obHolidayDate');
    var nameInput = document.getElementById('obHolidayName');
    var stateInput = document.getElementById('obHolidayState');
    var status = document.getElementById('obHolidayAddStatus');
    var country = currentCountry();
    var date = parseHolidayDate(dateInput.value);
    var name = nameInput.value.trim();
    var state = normalizeHolidayState(stateInput.value, country);
    if (!date || !name || !state) {
      setStatus(status, 'Enter a valid date, a festival name, and a state or region.', 'err');
      (!date ? dateInput : !name ? nameInput : stateInput).focus();
      return;
    }
    var entry = { date: date, name: name, state: state, country: country, auto: false };
    var key = holidayKey(entry);
    if (holidayState[key]) {
      setStatus(status, 'That festival is already listed for ' + state + ' on this date.', 'err');
      return;
    }
    holidayState[key] = entry;
    dateInput.value = ''; nameInput.value = '';
    setStatus(status, 'Added for ' + state + '.', 'ok');
    renderHolidayList();
  }

  async function importHolidayFile(input) {
    var file = input.files[0];
    if (!file) return;
    var status = document.getElementById('obHolidayFileStatus');
    var version = ++holidayImportVersion;
    var country = currentCountry();
    var defaultState = normalizeHolidayState(document.getElementById('obHolidayImportState').value, country);
    input.value = '';
    setStatus(status, 'Reading ' + file.name + '…');

    try {
      var extension = file.name.split('.').pop().toLowerCase();
      if (!['csv', 'tsv', 'xlsx'].includes(extension)) {
        throw new Error('Choose a CSV, TSV, or XLSX file.');
      }
      if (typeof XLSX === 'undefined') {
        throw new Error('The file reader could not load. Refresh and try again.');
      }

      var workbook = extension === 'xlsx'
        ? XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
        : XLSX.read(await file.text(), { type: 'string', raw: true, FS: extension === 'tsv' ? '\t' : ',' });
      if (version !== holidayImportVersion || country !== currentCountry()) return;
      var sheet = workbook.SheetNames.find(function (name) {
        return /^(festivals|holidays)$/i.test(name.trim());
      }) || workbook.SheetNames[0];
      var rows = sheet ? XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, defval: '', blankrows: false }) : [];
      var headers = (rows.shift() || []).map(function (value) { return String(value).trim().toLowerCase(); });
      var dateIndex = headers.indexOf('date');
      var nameIndex = headers.indexOf('name');
      var stateIndex = headers.indexOf('state');
      if (stateIndex === -1) stateIndex = headers.indexOf('region');
      if (dateIndex === -1 || nameIndex === -1 || !rows.length) {
        throw new Error('Include date and name columns and at least one festival.');
      }

      if (stateIndex === -1 && !defaultState) {
        throw new Error('Add a state column or enter a default state or region above the upload.');
      }
      var holidays = rows.map(function (row, index) {
        var value = row[dateIndex];
        var day = value instanceof Date && !isNaN(value.getTime())
          ? [String(value.getFullYear()).padStart(4, '0'), String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0')].join('-')
          : String(value ?? '').trim();
        var date = parseHolidayDate(day);
        var name = String(row[nameIndex] ?? '').trim();
        var stateValue = stateIndex < 0 ? '' : String(row[stateIndex] ?? '').trim();
        var state = stateValue ? normalizeHolidayState(stateValue, country) : defaultState;
        if (!date || !name || !state) {
          throw new Error('Check festival entry ' + (index + 1) + '. Include a valid YYYY-MM-DD date, name, and state or region.');
        }
        return { date: date, name: name, state: state, country: country, auto: false };
      });

      var added = 0;
      holidays.forEach(function (holiday) {
        var key = holidayKey(holiday);
        if (!holidayState[key]) {
          holidayState[key] = holiday;
          added++;
        }
      });
      renderHolidayList();
      setStatus(status, added + ' added, ' + (holidays.length - added) + ' duplicates skipped.', 'ok');
    } catch (error) {
      if (version === holidayImportVersion) setStatus(status, error.message || 'Could not read the festivals file.', 'err');
    }
  }

  // Override links on the Weather & festivals cards just reveal the
  // editable part underneath.
  function setOverrideOpen(panelId, btnId, open) {
    var panel = document.getElementById(panelId);
    var btn = document.getElementById(btnId);
    if (!panel || !btn) return;
    panel.style.display = open ? '' : 'none';
    btn.textContent = open ? 'Hide' : btn.getAttribute('data-label');
  }

  function toggleOverride(panelId, btnId) {
    var panel = document.getElementById(panelId);
    if (panel) setOverrideOpen(panelId, btnId, panel.style.display === 'none');
  }

  // Weather card: says plainly which weather training will use. The sales
  // file's Weather sheet goes to training with it; without one, the runner
  // uses the platform's default weather. A separate file is only saved.
  function renderWeatherCard() {
    var pill = document.getElementById('obWeatherPill');
    var intro = document.getElementById('obWeatherIntro');
    if (!pill || !intro) return;
    var lines = [];
    if (sheetWeather) {
      pill.className = 'pill ok';
      pill.textContent = 'From your sales file’s Weather sheet';
      lines.push(sheetWeather.range + '. This is the weather training uses.');
    } else {
      pill.className = 'pill warn';
      pill.textContent = 'No Weather sheet in your sales file';
      lines.push('Training will fall back to the platform’s default weather data, which may not cover your pincodes. Add a Weather sheet to your sales file to use your own.');
    }
    if (fileWeather) {
      lines.push('Your separate weather file (' + fileWeather.range + ') is saved with your setup, but training doesn’t use it yet.');
    }
    intro.textContent = lines.join(' ');

    var shown = sheetWeather || fileWeather;
    if (shown) {
      drawLineChart('obWeatherChart', 'obWeatherChartWrap', shown.points, function (v) { return v.toFixed(1) + '°C'; });
    } else {
      document.getElementById('obWeatherChartWrap').style.display = 'none';
    }
  }

  function updateSubmitState() {
    // Historical data is the only required upload — gates the final step's button.
    var btn = document.getElementById('obNext');
    if (btn && step === TOTAL_STEPS) btn.disabled = !histKey || skuMasterUploading;
  }

  // Done/current/upcoming state on the numbered stepper. Any step already
  // reached is a shortcut back to it (and forward again, up to the furthest
  // step reached); steps not reached yet stay inert. A jump goes through
  // showStep() exactly like Back/Continue, so the final step's Train button
  // keeps its own gating (no sales file, no training).
  var furthestStep = 1;

  function updateStepper(n) {
    furthestStep = Math.max(furthestStep, n);
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var el = document.getElementById('obStepperStep' + i);
      if (!el) continue;
      var canJump = i !== n && i <= furthestStep;
      el.classList.toggle('done', i < n);
      el.classList.toggle('current', i === n);
      el.classList.toggle('visited', i > n && i <= furthestStep);
      el.classList.toggle('can-jump', canJump);
      if (i === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
      if (canJump) {
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', 'Go to step ' + i + ': ' + el.querySelector('.lbl').textContent);
      } else {
        ['role', 'tabindex', 'aria-label'].forEach(function (name) { el.removeAttribute(name); });
      }
    }
  }

  function initStepperJump() {
    var stepper = document.getElementById('obStepper');
    if (!stepper) return;
    function jump(event) {
      var el = event.target.closest('.ob-stepper-step.can-jump');
      if (!el) return;
      event.preventDefault();
      var target = Number(el.id.replace('obStepperStep', ''));
      showStep(target);
      // The clicked node is now the current step (not focusable) — hand
      // keyboard focus to the step's main action instead of losing it.
      if (event.type === 'keydown') document.getElementById(target === TOTAL_STEPS ? 'obBack' : 'obNext').focus();
    }
    stepper.addEventListener('click', jump);
    stepper.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') jump(event);
    });
  }

  var shopifyConnection = null;
  var shopifyAttempt = null;
  var shopifyPolling = null;
  var shopifyStatusRequest = null;

  function updateShopifyStep(message, kind) {
    var controls = document.getElementById('obShopifyControls');
    var connect = document.getElementById('obShopifyConnect');
    var connected = shopifyConnection?.status === 'connected';
    controls.hidden = connected;
    connect.disabled = Boolean(shopifyAttempt);
    if (stepIs(step, 'shopify')) {
      document.getElementById('obNext').textContent = connected ? 'Continue →' : 'Skip for now →';
    }
    if (message != null) setStatus(document.getElementById('obShopifyStatus'), message, kind);
    if (stepIs(step, 'review')) renderReviewSummary();
  }

  function endShopifyAttempt() {
    if (shopifyPolling) clearInterval(shopifyPolling);
    shopifyPolling = null;
    shopifyAttempt = null;
  }

  function refreshShopifyConnection() {
    if (shopifyStatusRequest) return shopifyStatusRequest;
    shopifyStatusRequest = window.APRA_COMMERCE.shopifyStatus().then(function (status) {
      shopifyConnection = status;
      if (status.status === 'connected') {
        endShopifyAttempt();
        updateShopifyStep(status.external_account_id ? 'Connected to ' + status.external_account_id : 'Shopify connected.', 'ok');
      } else if (!shopifyAttempt) {
        updateShopifyStep(status.status === 'revoked' ? 'Shopify was disconnected.' : 'No Shopify store connected.');
      }
      return status;
    }).catch(function () {
      if (!shopifyAttempt) updateShopifyStep('Could not check your connection. Try again or skip this step.', 'err');
      return null;
    }).finally(function () {
      shopifyStatusRequest = null;
    });
    return shopifyStatusRequest;
  }

  async function checkShopifyConnection() {
    var button = document.getElementById('obShopifyRefresh');
    var result = document.getElementById('obShopifyCheckResult');
    button.disabled = true;
    button.textContent = 'Checking…';
    setStatus(result, 'Checking Shopify connection…');
    try {
      var status = await refreshShopifyConnection();
      if (!status) {
        setStatus(result, 'Check failed. Try again in a moment.', 'err');
        return;
      }
      var message = status.status === 'connected'
        ? 'Connection confirmed.'
        : 'Shopify authorization is still pending.';
      if (!shopifyAttempt && status.status !== 'connected') {
        message = 'No active Shopify connection. Select Connect with Shopify to authorize your store.';
      }
      var time = new Date().toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit', second:'2-digit'});
      setStatus(result, message + ' Checked at ' + time + '.', status.status === 'connected' ? 'ok' : '');
    } finally {
      button.disabled = false;
      button.textContent = 'Check connection';
    }
  }

  async function connectOnboardingShopify() {
    if (shopifyAttempt) return;
    var input = document.getElementById('obShopifyDomain');
    var shop = input.value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      updateShopifyStep('Enter a Shopify domain such as yourstore.myshopify.com.', 'err');
      input.focus();
      return;
    }
    var popup = window.open('about:blank', '_blank');
    if (!popup) {
      updateShopifyStep('Allow pop-ups for this site, then try again.', 'err');
      return;
    }

    setStatus(document.getElementById('obShopifyCheckResult'), '');
    var attempt = {id:crypto.randomUUID(), popup:popup};
    shopifyAttempt = attempt;
    updateShopifyStep('Opening Shopify authorization…');
    try {
      popup.sessionStorage.setItem('apra_onboarding_shopify', attempt.id);
      popup.opener = null;
      var address = new URL(await window.APRA_COMMERCE.authorize('shopify', shop));
      if (address.protocol !== 'https:' || address.hostname !== shop) {
        throw new Error('Shopify returned an unexpected authorization address.');
      }
      if (shopifyAttempt !== attempt) { popup.close(); return; }
      popup.location.replace(address.href);
      updateShopifyStep('Approve the connection in the Shopify tab, then return here.');
      var checks = 0;
      shopifyPolling = setInterval(function () {
        if (++checks <= 24) refreshShopifyConnection();
        else {
          endShopifyAttempt();
          updateShopifyStep('If you finished in Shopify, select Check connection.');
        }
      }, 5000);
    } catch (error) {
      popup.close();
      if (shopifyAttempt !== attempt) return;
      endShopifyAttempt();
      updateShopifyStep(error.message || 'Could not start Shopify authorization.', 'err');
    }
  }

  function initShopifyStep() {
    document.getElementById('obShopifyConnect').addEventListener('click', connectOnboardingShopify);
    document.getElementById('obShopifyRefresh').addEventListener('click', checkShopifyConnection);
    window.addEventListener('focus', function () {
      if (shopifyAttempt) refreshShopifyConnection();
    });
    if (typeof BroadcastChannel === 'function') {
      var channel = new BroadcastChannel('apra-onboarding-shopify');
      channel.addEventListener('message', function (event) {
        if (!shopifyAttempt || event.data?.id !== shopifyAttempt.id) return;
        if (event.data.connected) refreshShopifyConnection();
        else {
          endShopifyAttempt();
          updateShopifyStep('Shopify authorization did not complete. Try again or skip this step.', 'err');
        }
      });
    }
  }

  function showStep(n) {
    step = n;
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var el = document.getElementById('obStep' + i);
      if (el) el.style.display = (i === n) ? '' : 'none';
    }
    document.getElementById('obProgress').textContent = 'Question ' + n + ' of ' + TOTAL_STEPS;
    updateStepper(n);

    // Keep the walkthrough card out of the way once the user is actually
    // working through the questionnaire — only show it back on question 1.
    var walkthroughCard = document.getElementById('obWalkthroughCard');
    if (walkthroughCard) walkthroughCard.style.display = (n === 1) ? 'flex' : 'none';

    var back = document.getElementById('obBack');
    var next = document.getElementById('obNext');
    back.disabled = (n === 1);
    next.textContent = (n === TOTAL_STEPS) ? 'Train →' : 'Continue →';
    next.disabled = n === TOTAL_STEPS && (!histKey || skuMasterUploading);

    if (stepIs(n, 'shopify')) {
      updateShopifyStep();
      refreshShopifyConnection();
    }
    if (stepIs(n, 'sku')) { renderSkuMasterSummary(); renderNewSkuList(); }
    if (stepIs(n, 'weather')) {
      renderHolidayStateChoices();
      loadDefaultHolidays();
      renderFestivalCard();
      renderWeatherCard();
      // Nothing to review without a built-in calendar — open the editor straight away.
      if (!HOLIDAY_RULES[currentCountry()]) setOverrideOpen('obHolidayOverride', 'obHolidayOverrideBtn', true);
    }
    if (stepIs(n, 'review')) renderReviewSummary();
  }

  function joinList(a) {
    return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }

  // Review & train: one tile per step with its real state, then a plain
  // "Will use / Saved for later" line so it's clear what training actually
  // consumes (only the sales file today).
  function renderReviewSummary() {
    var tilesEl = document.getElementById('obReviewTiles');
    var note = document.getElementById('obWillUse');
    if (!tilesEl || !note) return;

    var unconfirmed = Object.keys(newSkuState).filter(function (id) { return !newSkuState[id].confirmed; }).length;
    var tile = function (label, cls, text) { return { label: label, cls: cls, text: text }; };
    var tiles = [
      tile('Country', 'ok', 'Ready'),
      shopifyConnection?.status === 'connected' ? tile('Shopify', 'ok', 'Connected')
        : tile('Shopify', '', shopifyAttempt ? 'Authorization pending' : shopifyConnection ? 'Skipped' : 'Connection unverified'),
      !histKey ? tile('Sales data', 'risk', 'Required')
        : lastHistWarnings.length ? tile('Sales data', 'warn', 'Usable w/ warnings')
        : tile('Sales data', 'ok', 'Ready'),
      spendKey ? tile('Marketing spend', 'ok', 'Received')
        : spendSkipped ? tile('Marketing spend', 'warn', 'Skipped')
        : tile('Marketing spend', '', 'Not provided'),
      skuMasterUploading ? tile('SKU master', '', 'Uploading')
        : skuMasterKey ? tile('SKU master', 'ok', unconfirmed ? 'Uploaded · ' + unconfirmed + ' to confirm' : 'Uploaded')
        : tile('SKU master', '', unconfirmed ? unconfirmed + ' launch dates to confirm' : 'Not uploaded'),
      inboundKey ? tile('Upload inbound data', 'ok', 'Received')
        : inboundSkipped ? tile('Upload inbound data', 'warn', 'Skipped')
        : tile('Upload inbound data', '', 'Not provided'),
      sheetWeather ? tile('Weather & festivals', 'ok', 'Ready')
        : tile('Weather & festivals', 'warn', 'Default weather'),
    ];
    tilesEl.innerHTML = tiles.map(function (x) {
      return '<div class="ob-review-tile"><div>' + escapeHtml(x.label) + '</div>' +
        '<span class="pill' + (x.cls ? ' ' + x.cls : '') + '">' + escapeHtml(x.text) + '</span></div>';
    }).join('');

    if (!histKey) {
      note.innerHTML = '<b>Not ready:</b> upload your sales file on the Sales data step — it’s the one file training needs.';
      return;
    }
    var used = 'your sales file';
    if (salesSummary) {
      var bits = [];
      if (salesSummary.rangeText) bits.push(salesSummary.rangeText);
      if (salesSummary.pins != null) bits.push('across ' + salesSummary.pins.toLocaleString() + ' pincode' + (salesSummary.pins === 1 ? '' : 's'));
      if (bits.length) used += ' (' + bits.join(' ') + ')';
    }
    used += sheetWeather ? ', including its Weather sheet' : ', with the platform’s default weather';
    var kept = ['festivals & holidays'];
    if (Object.keys(newSkuState).length) kept.push('launch dates');
    if (schemeIds.length) kept.push('scheme IDs');
    if (skuMasterKey) kept.push('SKU master');
    if (spendKey) kept.push('marketing spend');
    if (inboundKey) kept.push('inbound data');
    if (fileWeather) kept.push('your separate weather file');
    note.innerHTML = '<b>Will use:</b> ' + escapeHtml(used) + '. ' +
      '<b>Saved for later, not used in training yet:</b> ' + escapeHtml(joinList(kept)) + '.';
  }

  var POLL_MS = 8000;
  var MAX_POLLS = 100; // ~13 minutes, under the runner Lambda's 900s ceiling
  var pollTimer = null;
  var pollCount = 0;
  var ONBOARDING_SCENARIO_KEY = 'apra_onboarding_scenario_id';

  // Festivals, launch dates, scheme IDs and the keys of the optional
  // uploads aren't consumable by forecast.py yet (no CLI support for any of
  // them) — saved as a JSON profile for future use rather than silently
  // dropped. Filed as .txt since that's already an allowed upload
  // extension; only the S3 content-type metadata is cosmetically off.
  function buildOnboardingProfile() {
    var profile = {
      country: currentCountry(),
      submitted_at: new Date().toISOString(),
      new_skus: Object.keys(newSkuState).map(function (id) {
        var s = newSkuState[id];
        return { id: id, first_shipped: s.firstDate.toISOString().slice(0, 10), launch_date: s.launchDate, confirmed: s.confirmed };
      }),
      holidays: holidaysForCountry().map(function (h) {
        return { date: h.date.toISOString().slice(0, 10), name: h.name, country: h.country,
          scope: h.state ? 'state' : 'country', state: h.state, auto: h.auto };
      }),
      scheme_ids: schemeIds,
      sku_master_key: skuMasterKey,
      marketing_spend_key: spendKey, marketing_spend_skipped: spendSkipped,
      inbound_receipts_key: inboundKey, inbound_receipts_skipped: inboundSkipped,
      weather_file_key: weatherFileKey,
    };
    return new File([JSON.stringify(profile, null, 2)], 'onboarding-profile.txt', { type: 'application/json' });
  }

  function submitOnboardingProfile() {
    uploadFile(buildOnboardingProfile(), null).catch(function () {}); // best-effort, never blocks the main flow
  }

  function showPreparingResult(state, message, scenario, isAdmin) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    document.getElementById('obPreparing').style.display = 'none';
    document.getElementById('obReady').style.display = (state === 'ready') ? '' : 'none';
    document.getElementById('obFailed').style.display = (state === 'failed') ? '' : 'none';
    if (state === 'failed' && message) document.getElementById('obFailedMsg').textContent = message;
    if (state === 'ready') renderReadyForecast(scenario, isAdmin);
    if (state === 'ready' || state === 'failed') document.dispatchEvent(new Event('apra:scenarios-changed'));
  }

  // The runner records why a run failed (e.g. a missing column) — show that
  // instead of a generic message, so the user knows what to fix.
  function failedRunMessage(scenario) {
    return scenario && scenario.error
      ? 'The model run failed: ' + scenario.error
      : 'The model run failed — you can try again.';
  }

  // Review & train's result. When the run completes, an admin's onboarding
  // forecast becomes the organization's live forecast automatically (the
  // same approval the Scenarios tab's "Apply to plan" does), so it shows on
  // Forecasts / Overview right away and in Scenarios as the approved run.
  // Each run is made live at most once (remembered per browser), so coming
  // back to Getting Started later never overrides a forecast someone has
  // approved since. Non-admins see the forecast but can't approve it.
  var readyScenarioId = null;
  var AUTO_LIVE_KEY = 'apra_onboarding_live:';

  function wasMadeLive(id) {
    try { return localStorage.getItem(AUTO_LIVE_KEY + id) === '1'; } catch (e) { return false; }
  }

  function rememberMadeLive(id) {
    try { localStorage.setItem(AUTO_LIVE_KEY + id, '1'); } catch (e) {}
  }

  function showLive(status) {
    document.getElementById('obGoLive').hidden = true;
    document.getElementById('obOpenForecasts').hidden = false;
    setStatus(status, 'Live — this forecast is now on the Forecasts tab and approved in Scenarios.', 'ok');
  }

  function renderReadyForecast(scenario, isAdmin) {
    var preview = document.getElementById('obReadyPreview');
    var status = document.getElementById('obReadyStatus');
    var goLive = document.getElementById('obGoLive');
    preview.hidden = true;
    goLive.hidden = true;
    document.getElementById('obOpenForecasts').hidden = true;
    readyScenarioId = scenario ? scenario.id : null;
    if (!scenario) { setStatus(status, ''); return; }

    var autoLive = false, nextStep;
    if (scenario.approved) {
      rememberMadeLive(scenario.id);
      nextStep = null;
    } else if (isAdmin && !wasMadeLive(scenario.id)) {
      autoLive = true;
    } else if (isAdmin) {
      // Made live before, and a different forecast has been approved since.
      goLive.hidden = false;
      nextStep = ['A different forecast is live now. Make this one live again to show it on Forecasts.'];
    } else {
      nextStep = ['An admin in your organization needs to approve it in Scenarios before it shows on Forecasts.'];
    }

    setStatus(status, autoLive ? 'Making it your live forecast…' : 'Loading your forecast…');
    if (autoLive) makeOnboardingForecastLive();
    else if (!nextStep) showLive(status);

    APRA_SESSION.fetch(SCENARIOS_API + '/' + encodeURIComponent(scenario.id) + '/result')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('result unavailable')); })
      .then(function (result) {
        if (readyScenarioId !== scenario.id) return; // user started over meanwhile
        var start = Number.isInteger(result.backtestWeeks) ? result.backtestWeeks : 0;
        var weeks = (result.weeks || []).slice(start);
        var forecast = ((result.all || {}).f || []).slice(start);
        var points = [], total = 0;
        weeks.forEach(function (week, i) {
          if (!Number.isFinite(forecast[i])) return;
          points.push({ date: new Date(week), units: forecast[i] });
          total += forecast[i];
        });
        setText('obReadyUnitsLbl', points.length ? 'Forecast units · next ' + points.length + ' weeks' : 'Forecast units');
        setText('obReadyUnits', points.length ? Math.round(total).toLocaleString() : '—');
        setText('obReadySkus', result.skus ? Object.keys(result.skus).length.toLocaleString() : '—');
        setText('obReadyWape', Number.isFinite(result.overallWape) ? result.overallWape.toFixed(1) + '%' : '—');
        // Week labels are week starts, so the period ends six days after the last one.
        setText('obReadyRange', points.length
          ? fmtDay(points[0].date) + ' – ' + fmtDay(new Date(points[points.length - 1].date.getTime() + 6 * 86400000))
          : '—');
        preview.hidden = false;
        drawLineChart('obReadyChart', 'obReadyChartWrap', points);
        if (nextStep) setStatus(status, nextStep[0], nextStep[1]);
      })
      .catch(function () {
        if (readyScenarioId !== scenario.id || !nextStep) return;
        setStatus(status, 'The forecast finished, but its preview couldn’t be loaded. ' + nextStep[0], 'err');
      });
  }

  // Approves the run (copies it to the live forecast) and refreshes Overview,
  // Forecasts, Scenarios, AI Insights and Inventory — see approveScenario()
  // in js/scenarios.js. Also used by the retry button if the automatic
  // attempt fails.
  function makeOnboardingForecastLive() {
    var btn = document.getElementById('obGoLive');
    var status = document.getElementById('obReadyStatus');
    var id = readyScenarioId;
    if (!id || typeof window.approveScenario !== 'function') return;
    btn.hidden = true;
    setStatus(status, 'Making it your live forecast…');
    window.approveScenario(id, btn).then(function () {
      if (readyScenarioId !== id) return;
      rememberMadeLive(id);
      btn.disabled = false;
      btn.textContent = 'Make this my live forecast';
      showLive(status);
    }).catch(function (err) {
      if (readyScenarioId !== id) return;
      var reason = err && err.message && err.message !== 'approve failed' ? err.message : '';
      btn.hidden = false;
      setStatus(status, (reason || 'Could not make it your live forecast.') + ' Try again, or approve it in Scenarios.', 'err');
    });
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
      APRA_SESSION.fetch(SCENARIOS_API)
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          var match = (d.scenarios || []).filter(function (s) { return s.id === scenarioId; })[0];
          if (!match) return; // not indexed yet — try again next tick
          if (match.status === 'completed') showPreparingResult('ready', null, match, d.you_are_admin === true);
          else if (match.status === 'failed') showPreparingResult('failed', failedRunMessage(match));
        })
        .catch(function () {}); // transient error — just try again next tick
    }, POLL_MS);
  }

  function createOnboardingScenario() {
    APRA_SESSION.fetch(SCENARIOS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Onboarding — ' + countryName(currentCountry()) + ' setup',
        known_prices: true, calibrate: true, weather: true, refresh_days: 28,
        custom_input_key: histKey,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Could not start model preparation.');
        try { localStorage.setItem(ONBOARDING_SCENARIO_KEY, res.d.scenario_id); } catch (e) {}
        document.dispatchEvent(new Event('apra:scenarios-changed')); // show the running run in Scenarios
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

    APRA_SESSION.fetch(SCENARIOS_API)
      .then(function (r) {
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
        if (match.status === 'completed') { showPreparingResult('ready', null, match, d.you_are_admin === true); return; }
        if (match.status === 'failed') { showPreparingResult('failed', failedRunMessage(match)); return; }
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
    readyScenarioId = null;
    salesSkuIds = skuMasterIds = skuMasterKey = null;
    skuMasterUploading = false;
    skuMasterUploadVersion++;
    var skuInput = document.getElementById('obSkuMasterFile');
    skuInput.disabled = false;
    skuInput.value = '';
    setStatus(document.getElementById('obSkuMasterStatus'), '');
    renderSkuMasterSummary();
    if (shopifyAttempt) shopifyAttempt.popup.close();
    endShopifyAttempt();
    spendKey = null; spendSkipped = false;
    inboundKey = null; inboundSkipped = false;
    weatherFileKey = null;
    sheetWeather = null; fileWeather = null;
    salesPins = []; schemeIds = []; salesSummary = null;
    newSkuState = {};
    holidayState = {};
    holidayImportVersion++;
    ['obHolidayFileStatus', 'obHolidayAddStatus'].forEach(function (id) { setStatus(document.getElementById(id), ''); });
    ['obHolidayDate', 'obHolidayName', 'obHolidayState', 'obHolidayImportState'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    holidayCountryLoaded = null;
    lastHistWarnings = [];
    lastWeatherWarnings = [];
    unlockCountry();

    document.getElementById('obReady').style.display = 'none';
    document.getElementById('obFailed').style.display = 'none';
    document.getElementById('obPreparing').style.display = 'none';
    document.getElementById('obSetupForm').style.display = '';

    ['obHistFile', 'obSpendFile', 'obInboundFile', 'obWeatherFile'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    ['obHistStatus', 'obSpendStatus', 'obInboundStatus', 'obWeatherFileStatus'].forEach(function (id) { setText(id, ''); });
    ['obSalesRows', 'obSalesPins', 'obSalesSkus', 'obSalesRange', 'obSkuInSales'].forEach(function (id) { setText(id, '—'); });
    resetSpendSummary();
    document.getElementById('obSchemeCallout').style.display = 'none';
    document.getElementById('obInboundSitesWrap').style.display = 'none';
    document.getElementById('obWeatherChartWrap').style.display = 'none';
    ['obHistWarnings', 'obWeatherWarnings'].forEach(function (id) { renderWarnings(id, []); });
    setOverrideOpen('obWeatherOverride', 'obWeatherOverrideBtn', false);
    setOverrideOpen('obHolidayOverride', 'obHolidayOverrideBtn', false);
    renderNewSkuList();
    renderHolidayList();
    furthestStep = 1; // nothing reached yet in the fresh run
    showStep(1);
  }

  // Country step's decorative outline-map diagram — swaps which <g> is
  // visible inside the shared #obMapSvg based on the real #obCountry
  // <select>. Purely additive/cosmetic: only countries with a drawn outline
  // (India/US/Japan/UK) get a matching shape, everything else just leaves
  // whichever shape was last shown hidden-by-default on load (India, since
  // that's the select's own default) rather than guessing a new outline.
  var COUNTRY_MAP_IDS = { IN: 'obMapIndia', US: 'obMapUS', JP: 'obMapJapan', GB: 'obMapUK' };

  function updateCountryMap() {
    var svg = document.getElementById('obMapSvg');
    if (!svg) return; // step not present on this page
    var country = currentCountry();
    var shapeId = COUNTRY_MAP_IDS[country];
    Object.keys(COUNTRY_MAP_IDS).forEach(function (code) {
      var g = document.getElementById(COUNTRY_MAP_IDS[code]);
      if (g) g.style.display = (COUNTRY_MAP_IDS[code] === shapeId) ? '' : 'none';
    });
    var label = document.getElementById('obMapLabel');
    if (label) label.textContent = countryName(country) + (shapeId ? '' : ' (no outline drawn yet)');
  }

  function init() {
    var countrySelect = document.getElementById('obCountry');
    if (!countrySelect) return; // onboarding panel not present on this page

    countrySelect.addEventListener('change', function () {
      holidayImportVersion++;
      ['obHolidayState', 'obHolidayImportState'].forEach(function (id) { document.getElementById(id).value = ''; });
      ['obHolidayFileStatus', 'obHolidayAddStatus'].forEach(function (id) { setStatus(document.getElementById(id), ''); });
      updateCountryMap();
      renderCountryDefaults();
    });
    updateCountryMap();
    renderCountryDefaults();

    ['obWeatherOverrideBtn', 'obHolidayOverrideBtn'].forEach(function (id) {
      var btn = document.getElementById(id);
      btn.setAttribute('data-label', btn.textContent);
    });
    document.getElementById('obWeatherOverrideBtn').addEventListener('click', function () { toggleOverride('obWeatherOverride', 'obWeatherOverrideBtn'); });
    document.getElementById('obHolidayOverrideBtn').addEventListener('click', function () { toggleOverride('obHolidayOverride', 'obHolidayOverrideBtn'); });

    document.getElementById('obBack').addEventListener('click', function () {
      if (step > 1) showStep(step - 1);
    });

    document.getElementById('obNext').addEventListener('click', function () {
      if (step < TOTAL_STEPS) {
        showStep(step + 1);
        return;
      }
      // Final step — kick off real model preparation: a live scenario run
      // against the uploaded sales file, polled the same way the Scenarios
      // tab polls its own runs.
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
    document.getElementById('obGoLive').addEventListener('click', makeOnboardingForecastLive);
    document.getElementById('obOpenForecasts').addEventListener('click', function () {
      var forecasts = Array.prototype.find.call(document.querySelectorAll('.dnav li'), function (li) {
        return li.getAttribute('title') === 'Forecasts';
      });
      if (forecasts) forecasts.click();
    });
    initShopifyStep();
    initStepperJump();

    showStep(1);

    document.getElementById('obSalesTplCsv').addEventListener('click', downloadSalesTemplate);
    document.getElementById('obInboundTpl').addEventListener('click', downloadInboundTemplate);
    document.getElementById('obSkuMasterTpl').addEventListener('click', downloadSkuMasterTemplate);
    document.getElementById('obSkuMasterFile').addEventListener('change', function () { uploadSkuMaster(this); });

    document.getElementById('obHistFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obHistStatus');
      uploadFile(file, statusEl).then(function (key) {
        histKey = key;
        APRA_SESSION.fetch(SCENARIOS_API + '?view=schemes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'scan', custom_input_key: key }),
        }).catch(function () {});
        lockCountry();
        updateSubmitState();
      }).catch(function () {});
      analyzeSalesFile(file); // runs independently of the upload — just reads the local file
    });

    // Marketing spend / inbound receipts: real uploads via the same
    // presigned-S3 endpoint as every other file here, but not consumable by
    // forecast.py yet — their keys go into the onboarding profile. Both are
    // optional and never gate Continue.
    document.getElementById('obSpendFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      spendSkipped = false;
      var statusEl = document.getElementById('obSpendStatus');
      uploadFile(file, statusEl).then(function (key) {
        spendKey = key;
        lockCountry();
        setStatus(statusEl, file.name + ' received — saved with your setup; spend isn’t used in forecasting yet.', 'ok');
      }).catch(function () {});
      analyzeSpendFile(file);
    });
    document.getElementById('obSpendSkipBtn').addEventListener('click', function () {
      spendSkipped = true; spendKey = null;
      document.getElementById('obSpendFile').value = '';
      resetSpendSummary();
      setStatus(document.getElementById('obSpendStatus'), 'No marketing spend — noted.', 'ok');
    });

    document.getElementById('obInboundFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      inboundSkipped = false;
      var statusEl = document.getElementById('obInboundStatus');
      uploadFile(file, statusEl).then(function (key) {
        inboundKey = key;
        lockCountry();
        setStatus(statusEl, file.name + ' received — saved with your setup; receipts aren’t used yet.', 'ok');
      }).catch(function () {});
      analyzeInboundFile(file);
    });
    document.getElementById('obInboundSkipBtn').addEventListener('click', function () {
      inboundSkipped = true; inboundKey = null;
      document.getElementById('obInboundFile').value = '';
      document.getElementById('obInboundSitesWrap').style.display = 'none';
      setStatus(document.getElementById('obInboundStatus'), 'No inbound data — noted.', 'ok');
    });

    renderNewSkuList();

    document.getElementById('obHolidayFile').addEventListener('change', function () { importHolidayFile(this); });
    document.getElementById('obHolidayAdd').addEventListener('click', addManualHoliday);
    ['obHolidayDate', 'obHolidayName', 'obHolidayState'].forEach(function (id) {
      document.getElementById(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addManualHoliday(); }
      });
    });

    document.getElementById('obWeatherFile').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      var statusEl = document.getElementById('obWeatherFileStatus');
      uploadFile(file, statusEl).then(function (key) {
        weatherFileKey = key;
        lockCountry();
      }).catch(function () {});
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
