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

  var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
  var map = null, markersLayer = null, areaLayer = null;
  var histKey = null;
  var TOTAL_STEPS = 6;
  var step = 1;
  var holidayCountryLoaded = null; // which country's defaults are currently loaded into holidayState
  var lastAreaPoints = []; // {lat, lon, code} from the most recently plotted serviceable-area codes
  var weatherLoaded = false; // whether the Weather step's data has already been resolved once

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
    lastAreaPoints = []; // reset — this run's results become the new serviceable-area sample for the Weather step

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
          lastAreaPoints.push({ lat: lat, lon: lon, code: code });
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

  // Reads the Shipments sheet/rows straight out of the file the user just
  // picked (client-side, nothing sent anywhere) and returns [{date, units}]
  // rows — no aggregation yet.
  function readShipmentRows(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx') {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array' });
        var sheetName = wb.SheetNames.filter(function (n) { return n.toLowerCase() === 'shipments'; })[0]
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

  // Reads the optional Weather sheet, if the file has one — only .xlsx
  // uploads can carry it, since csv/tsv/txt uploads are just Shipments rows.
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
    }).catch(function () {
      document.getElementById('obHistChartWrap').style.display = 'none';
    });

    readWeatherRows(file).then(function (rows) {
      weatherChartPoints = aggregateAvgByDate(rows);
      weatherLoaded = false; // let the Weather step re-render with this file's data next time it's shown
      if (step === 6) loadWeatherPreview();
    }).catch(function () { weatherChartPoints = []; });
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
  function fetchLiveWeather(points) {
    var listEl = document.getElementById('obWeatherLiveList');
    listEl.innerHTML = '';
    var sample = points.slice(0, 5);
    sample.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'weather-card';
      var label = document.createElement('span');
      label.className = 'wc-label';
      label.textContent = p.code;
      var temp = document.createElement('span');
      temp.className = 'wc-temp';
      temp.textContent = '…';
      card.appendChild(label); card.appendChild(temp);
      listEl.appendChild(card);

      fetch(OPEN_METEO + '?latitude=' + p.lat + '&longitude=' + p.lon + '&current=temperature_2m')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var t = d && d.current && d.current.temperature_2m;
          temp.textContent = (t != null) ? Math.round(t) + '°C' : '—';
        })
        .catch(function () { temp.textContent = '—'; });
    });
  }

  // Weather sheet data (if the upload had one) takes priority; otherwise
  // falls back to live current temperature for the plotted serviceable-area
  // points; otherwise a plain message explaining there's nothing to show yet.
  function loadWeatherPreview() {
    if (weatherLoaded) return;
    weatherLoaded = true;

    var chartWrap = document.getElementById('obWeatherChartWrap');
    var liveWrap = document.getElementById('obWeatherLiveWrap');
    var emptyEl = document.getElementById('obWeatherEmpty');
    chartWrap.style.display = 'none';
    liveWrap.style.display = 'none';
    emptyEl.style.display = 'none';

    if (weatherChartPoints.length) {
      drawLineChart('obWeatherChart', 'obWeatherChartWrap', weatherChartPoints,
        function (v) { return v.toFixed(1) + '°C'; });
      return;
    }
    if (lastAreaPoints.length) {
      liveWrap.style.display = '';
      fetchLiveWeather(lastAreaPoints);
      return;
    }
    emptyEl.style.display = '';
    emptyEl.textContent = 'No weather data yet — include a Weather sheet with your historical data, or add serviceable-area postal codes on an earlier step.';
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

    document.getElementById('obGoScenarios').addEventListener('click', function () {
      var target = Array.prototype.filter.call(document.querySelectorAll('.dnav li'), function (li) {
        return li.textContent.trim() === 'Scenarios';
      })[0];
      if (target) target.click();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
