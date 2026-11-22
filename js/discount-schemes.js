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
      (!filter || (scheme.status || 'draft') === filter) &&
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
        : scheme.status || 'Draft · Needs details';
      [scheme.code, scheme.name || '—', scheme.mechanic || '—', dates,
        scheme.detected ? (scheme.version ? 'Created and detected' : 'Detected from sales') : 'Created',
        stage, scheme.observed_units?.toLocaleString() ?? '—', '—']
        .forEach(value => { line.insertCell().textContent = value; });
      const actions = line.insertCell();
      const editable = canEdit && scheme.status !== 'committed';
      actions.append(button(editable ? 'Edit' : 'View', () => open(scheme, !editable)));
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

  function refreshScopeControls() {
    const rows = Array.from(scopes.children);
    const count = rows.length;
    get('scheme-scope-count').textContent = count ? count + (count === 1 ? ' line' : ' lines') : '';
    const flat = form.elements.mechanic.value === 'Flat amount off';
    get('scheme-discount-help').textContent = flat
      ? 'Enter a discount amount in the selling price currency.'
      : 'Enter the effective discount percentage for each scope line.';
    rows.forEach((row, index) => {
      row.querySelector('legend').textContent = 'Scope line ' + (index + 1);
      row.querySelector('.scheme-discount-unit').hidden = flat;
      row.querySelector('input[name="discount"]').max = flat ? '1000000' : '99';
      const remove = row.querySelector('button');
      remove.hidden = displayOnly;
      remove.disabled = count < 2;
      remove.setAttribute('aria-label', 'Remove scope line ' + (index + 1));
    });
    get('scheme-add').disabled = count >= 30;
  }

  function addLine(values = {}) {
    const row = get('scheme-line').content.firstElementChild.cloneNode(true);
    row.querySelectorAll('input').forEach(input => { input.value = values[input.name] ?? ''; });
    const start = row.querySelector('input[name="start_date"]');
    const end = row.querySelector('input[name="end_date"]');
    const syncDates = () => { end.min = start.value; };
    start.addEventListener('change', syncDates);
    syncDates();
    row.querySelector('button').onclick = () => {
      const neighbor = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      refreshScopeControls();
      neighbor?.querySelector('input').focus();
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
    ['scheme-add', 'scheme-draft', 'scheme-commit'].forEach(id => { get(id).hidden = readOnly; });
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
    const scope = Array.from(scopes.children, row => {
      const entries = Object.fromEntries(Array.from(row.querySelectorAll('input'), input => [input.name, input.value.trim()]));
      return {...entries, sku: entries.sku.toUpperCase(), discount: Number(entries.discount)};
    });
    if (action === 'commit' && !confirm('Commit this scheme and start a new forecast run?')) return;
    const controls = Array.from(form.querySelectorAll('button'));
    controls.forEach(button => { button.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    const message = get('scheme-error');
    message.textContent = 'Saving…';
    try {
      const result = await request({action, code: fields.code.value, name: fields.name.value,
        mechanic: fields.mechanic.value, scope, version: editing?.version || 0});
      await load();
      close();
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
    row.querySelector('input').focus();
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
