(function () {
  'use strict';
  const api = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/scenarios?view=schemes';
  const get = id => document.getElementById(id);
  const form = get('scheme-form');
  const scopes = get('scheme-scope');
  const registry = get('scheme-registry');
  const status = get('scheme-status');
  let schemes = [], canEdit = false, editing = null, displayOnly = false, opener = null;

  async function request(payload) {
    const response = await APRA_SESSION.fetch(api, {
      method: payload ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load discount schemes.');
    return data;
  }

  async function load() {
    status.textContent = 'Loading schemes…';
    try {
      const data = await request();
      if (!Array.isArray(data.schemes)) throw new Error('The discount schemes service is unavailable.');
      schemes = data.schemes;
      canEdit = data.can_edit;
      get('scheme-new').disabled = !canEdit;
      render();
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function button(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dbtn';
    button.textContent = label;
    button.onclick = action;
    return button;
  }

  function render() {
    const search = get('scheme-search').value.trim().toLowerCase();
    const filter = get('scheme-filter').value;
    const source = get('scheme-source').value;
    const visible = schemes.filter(scheme =>
      (!filter || scheme.status === filter) &&
      (!source || (source === 'detected' ? scheme.detected : scheme.version)) &&
      (scheme.code + ' ' + (scheme.name || '')).toLowerCase().includes(search));
    const list = get('scheme-list');
    list.replaceChildren();
    status.textContent = visible.length ? '' : 'No matching discount schemes.';
    visible.forEach(scheme => {
      const line = list.insertRow();
      const starts = (scheme.scope || []).map(item => item.start_date).sort();
      const ends = (scheme.scope || []).map(item => item.end_date).sort();
      const dates = starts.length ? starts[0] + ' to ' + ends.at(-1)
        : scheme.first_seen ? scheme.first_seen + ' to ' + scheme.last_seen : '—';
      const today = new Date().toISOString().slice(0, 10);
      const stage = scheme.status === 'committed' && starts.length
        ? 'Committed · ' + (today < starts[0] ? 'Planned' : today > ends.at(-1) ? 'Past' : 'Active')
        : scheme.status === 'draft' ? 'Saved' : scheme.status === 'withdrawn' ? 'Withdrawn' : 'Needs details';
      [scheme.code, scheme.name || '—', offer(scheme) || scheme.mechanic || '—', dates,
        scheme.detected ? (scheme.version ? 'Created and detected' : 'Detected from sales') : 'Created',
        stage, scheme.observed_units?.toLocaleString() ?? '—', '—']
        .forEach(value => { line.insertCell().textContent = value; });
      const actions = line.insertCell();
      const editable = canEdit && scheme.status !== 'committed';
      actions.append(button(editable ? 'Edit' : 'View', () => open(scheme, !editable)));
      if (scheme.status === 'draft' && typeof window.useSchemeInScenario === 'function') {
        actions.append(button('Use in Scenarios', () => window.useSchemeInScenario(scheme.code)));
      }
      if (canEdit && scheme.status === 'committed') actions.append(button('Withdraw', async event => {
        if (!confirm('Withdraw this scheme from future runs?')) return;
        event.target.disabled = true;
        try {
          await request({code: scheme.code, version: scheme.version, action: 'withdraw'});
          form.hidden = true;
          await load();
        } catch (error) {
          status.textContent = error.message;
          event.target.disabled = false;
        }
      }));
    });
  }

  // "Buy 2 get 1" when every line has the same X and Y.
  function offer(scheme) {
    const lines = scheme.scope || [];
    const same = lines.length && lines.every(line => line.buy_quantity && line.free_quantity &&
      line.buy_quantity === lines[0].buy_quantity && line.free_quantity === lines[0].free_quantity);
    return scheme.mechanic === 'Buy X get Y' && same ? 'Buy ' + lines[0].buy_quantity + ' get ' + lines[0].free_quantity : '';
  }

  // Buy X get Y as the percentage off each unit that the forecast uses.
  function bundleDiscount(buy, free) {
    return 100 * Number(free) / (Number(buy) + Number(free));
  }

  function refreshBundlePreview(row) {
    const buy = row.querySelector('input[name="buy_quantity"]');
    const free = row.querySelector('input[name="free_quantity"]');
    const output = row.querySelector('[data-scheme-effective]');
    free.setCustomValidity('');
    if (!free.disabled && buy.value && free.value && bundleDiscount(buy.value, free.value) > 99) {
      free.setCustomValidity('That gives away more than 99%. Enter fewer free units or more units to buy.');
    }
    const complete = buy.value && free.value && buy.validity.valid && free.validity.valid;
    if (complete) {
      const total = Number(buy.value) + Number(free.value);
      output.textContent = 'Customer pays for ' + Number(buy.value).toLocaleString() + ' of every ' + total.toLocaleString() +
        ' units: ' + bundleDiscount(buy.value, free.value).toLocaleString(undefined, {maximumFractionDigits: 2}) + '% off each.';
    } else if (free.validity.customError) {
      output.textContent = free.validationMessage;
    } else {
      output.textContent = row.dataset.savedDiscount
        ? 'Saved as ' + row.dataset.savedDiscount + '% off. Enter X and Y to replace it.'
        : 'Enter whole numbers, for example buy 2, get 1 free.';
    }
  }

  function refreshScopeControls() {
    const rows = Array.from(scopes.children);
    const count = rows.length;
    get('scheme-scope-count').textContent = count ? count + (count === 1 ? ' line' : ' lines') : '';
    const mechanic = form.elements.mechanic.value;
    const flat = mechanic === 'Flat amount off';
    const bundle = mechanic === 'Buy X get Y';
    get('scheme-discount-help').textContent = bundle
      ? 'Enter how many units the customer buys (X) and how many more they get free (Y), for each scope line.'
      : flat ? 'Enter a discount amount in the selling price currency.'
        : 'Enter the effective discount percentage for each scope line.';
    rows.forEach((row, index) => {
      row.querySelector('legend').textContent = 'Scope line ' + (index + 1);
      const showBundle = bundle && (!displayOnly || row.dataset.hasBundle === 'true');
      const amount = row.querySelector('input[name="discount"]');
      row.querySelector('.scheme-scope-fields').classList.toggle('has-bundle', showBundle);
      row.querySelector('[data-scheme-bundle]').hidden = !showBundle;
      row.querySelector('[data-scheme-amount]').hidden = showBundle;
      row.querySelector('.scheme-discount-unit').hidden = flat;
      amount.disabled = showBundle || displayOnly;
      amount.required = !amount.disabled;
      amount.max = flat ? '1000000' : '99';
      row.querySelectorAll('[data-scheme-bundle] input').forEach(input => {
        input.disabled = !showBundle || displayOnly;
        input.required = !input.disabled;
      });
      refreshBundlePreview(row);
      const remove = row.querySelector('button');
      remove.hidden = displayOnly;
      remove.disabled = count < 2;
      remove.setAttribute('aria-label', 'Remove scope line ' + (index + 1));
    });
    get('scheme-add').disabled = count >= 30;
  }

  // All SKUs, or one from the approved forecast. A saved SKU that forecast no
  // longer has stays selectable so editing can't silently change it.
  function fillSkus(row) {
    const select = row.querySelector('[data-scheme-sku]');
    const value = row.querySelector('input[name="sku"]');
    const skus = window.DATA?.id ? Object.keys(window.DATA.skus || {}).sort() : [];
    if (value.value && value.value !== 'ALL' && !skus.includes(value.value)) skus.push(value.value);
    select.replaceChildren(new Option('Choose SKU', ''), new Option('All SKUs' + (window.DATA?.id ? ' (' + Object.keys(window.DATA.skus || {}).length + ')' : ''), 'ALL'),
      ...skus.map(sku => new Option(sku, sku)));
    select.value = value.value;
    select.addEventListener('change', () => { value.value = select.value; fillZips(row, true); });
  }

  // All postal codes, or one the chosen SKU sells in (any, for All SKUs).
  // After a SKU change a code that SKU doesn't sell in is cleared, since it
  // would have no effect; a saved scheme's own code is otherwise preserved.
  function fillZips(row, skuChanged) {
    const select = row.querySelector('[data-scheme-zip]');
    const value = row.querySelector('input[name="postal_code"]');
    const sku = row.querySelector('input[name="sku"]').value;
    const skus = window.DATA?.id ? window.DATA.skus || {} : {};
    const items = skus[sku] ? [skus[sku]] : Object.values(skus);
    const zips = [...new Set(items.flatMap(item => Object.keys(item.byZip || {})))].sort();
    if (value.value && value.value !== 'ALL' && !zips.includes(value.value)) {
      if (skuChanged && zips.length) value.value = '';
      else zips.push(value.value);
    }
    select.replaceChildren(new Option('Choose postal code', ''), new Option('All postal codes' + (window.DATA?.id ? ' (' + zips.length + ')' : ''), 'ALL'),
      ...zips.map(zip => new Option(zip, zip)));
    select.value = value.value;
    select.onchange = () => { value.value = select.value; };
  }

  function addLine(values = {}) {
    const row = get('scheme-line').content.firstElementChild.cloneNode(true);
    row.querySelectorAll('input').forEach(input => { input.value = values[input.name] ?? ''; });
    fillSkus(row);
    fillZips(row, false);
    row.dataset.hasBundle = String(values.buy_quantity != null && values.free_quantity != null);
    const amount = row.querySelector('input[name="discount"]');
    if (row.dataset.hasBundle === 'true') amount.value = ''; // worked out from X and Y
    else if (editing?.mechanic === 'Buy X get Y' && amount.value) row.dataset.savedDiscount = amount.value;
    row.querySelector('[data-scheme-bundle]').addEventListener('input', () => refreshBundlePreview(row));
    const start = row.querySelector('input[name="start_date"]');
    const end = row.querySelector('input[name="end_date"]');
    const syncDates = () => { end.min = start.value; };
    start.addEventListener('change', syncDates);
    syncDates();
    row.querySelector('button').onclick = () => {
      const neighbor = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      refreshScopeControls();
      neighbor?.querySelector('select, input:not([type="hidden"])').focus();
    };
    scopes.append(row);
    return row;
  }

  function open(scheme, readOnly = false) {
    editing = scheme;
    displayOnly = readOnly;
    opener = document.activeElement;
    form.reset();
    scopes.replaceChildren();
    get('scheme-error').textContent = '';
    get('scheme-title').textContent = scheme ? (readOnly ? scheme.code : 'Edit scheme') : 'Create scheme';
    ['code', 'name', 'mechanic'].forEach(name => {
      if (scheme?.[name]) form.elements[name].value = scheme[name];
    });
    form.elements.code.readOnly = Boolean(scheme);
    if (scheme?.scope?.length) scheme.scope.forEach(addLine);
    else if (!readOnly) addLine({ start_date: scheme?.first_seen, end_date: scheme?.last_seen });
    form.querySelectorAll('input, select').forEach(control => { control.disabled = readOnly; });
    ['scheme-add', 'scheme-draft', 'scheme-commit', 'scheme-save-help'].forEach(id => { get(id).hidden = readOnly; });
    refreshScopeControls();
    registry.hidden = true;
    form.hidden = false;
    form.scrollIntoView({block:'start'});
    get('scheme-title').focus({preventScroll:true});
  }

  function close() {
    form.hidden = true;
    registry.hidden = false;
    if (opener?.isConnected && !opener.disabled && opener !== document.body) opener.focus();
    else get('scheme-new').focus();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const action = event.submitter?.value || 'draft';
    const fields = form.elements;
    const mechanic = fields.mechanic.value;
    const scope = Array.from(scopes.children, row => {
      const entries = Object.fromEntries(Array.from(row.querySelectorAll('input:not(:disabled)'), input => [input.name, input.value.trim()]));
      entries.sku = entries.sku.toUpperCase();
      if (mechanic === 'Buy X get Y') {
        entries.buy_quantity = Number(entries.buy_quantity);
        entries.free_quantity = Number(entries.free_quantity);
        entries.discount = bundleDiscount(entries.buy_quantity, entries.free_quantity);
      } else entries.discount = Number(entries.discount);
      return entries;
    });
    if (action === 'commit' && !confirm('Commit this scheme and start a new forecast run?')) return;
    const controls = Array.from(form.querySelectorAll('button'));
    controls.forEach(button => { button.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    const message = get('scheme-error');
    message.textContent = 'Saving…';
    try {
      const result = await request({action, code: fields.code.value, name: fields.name.value,
        mechanic, scope, version: editing?.version || 0});
      await load();
      close();
      if (action === 'draft') status.textContent = 'Saved. Use it in Scenarios with the button on its row.';
      if (result.warning) status.textContent = result.warning;
      if (result.scenario_id) status.textContent = 'Scheme committed. A forecast run has started in Scenarios.';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      controls.forEach(button => { button.disabled = false; });
      refreshScopeControls();
      form.removeAttribute('aria-busy');
    }
  });

  get('scheme-new').onclick = () => open(null);
  get('scheme-close').onclick = close;
  get('scheme-add').onclick = () => {
    if (scopes.children.length >= 30) return;
    const row = addLine();
    refreshScopeControls();
    row.querySelector('select').focus();
  };
  form.elements.mechanic.addEventListener('change', refreshScopeControls);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !form.hasAttribute('aria-busy')) close();
  });
  get('scheme-search').oninput = render;
  get('scheme-filter').onchange = render;
  get('scheme-source').onchange = render;
  window.loadDiscountSchemes = load;
})();
