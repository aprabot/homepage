/* ============================================================
   APRABot dashboard — Support (FAQ + org-level ticket queue)

   Tickets are genuinely org-level: any member of an org can see and
   reply to a ticket a teammate opened, not just its original author
   (same as this file's own GET /tickets — org-scoped on the backend,
   not filtered to "my own tickets" client-side). APRABot's own team
   (anyone whose org resolves to aprabot-internal) sees and can reply
   to EVERY organization's tickets and close/reopen them — see
   scenarios-api's _is_staff()/list_tickets() for the actual
   enforcement; this file just reflects whatever the API already
   scoped the response to.
============================================================ */
(function () {
  'use strict';

  var TICKETS_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/tickets';

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtRelative(iso) {
    if (!iso) return '—';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function fmtAbsolute(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  var CATEGORY_LABEL = {
    'accuracy': 'Forecast accuracy', 'approvals-roles': 'Approvals & roles',
    'data-integration': 'Data & integration', 'billing': 'Billing',
    'bug': "Something's broken", 'other': 'Other',
  };

  // Self-serve first — answerable truthfully from what the product
  // actually does today, no invented SLA or capability. "Create a
  // ticket" is the explicit fallback right below this, not a dead end.
  var FAQS = [
    {
      q: 'How is forecast accuracy (WAPE) measured?',
      a: 'WAPE (weighted absolute percentage error) is computed over the backtest period only — ' +
         'real historical weeks where we know what actually shipped, compared to what the model ' +
         'predicted for that same week. It\'s volume-weighted, so a big SKU\'s error counts for more ' +
         'than a tiny one\'s, and lower is always better. You\'ll see it both as one overall number and ' +
         'broken out per SKU on the Forecasts page, with a High/Medium/Lower confidence tier per SKU ' +
         'based on that.',
    },
    {
      q: 'What does approving a scenario actually do?',
      a: 'It replaces the live forecast everyone in your organization sees on Overview and Forecasts — ' +
         'immediately, for every user, not just you. It is a real, visible change and cannot be undone ' +
         'through the UI once confirmed (you can always approve a different, earlier scenario again to ' +
         'effectively roll back). The Anomalies section on a scenario\'s detail view is there specifically ' +
         'to flag anything worth checking before you approve.',
    },
    {
      q: 'Who can approve a scenario?',
      a: 'Only an admin for your organization. A viewer can run and compare scenarios and use everything ' +
         'else, but not approve one. You can see and manage who\'s an admin vs. a viewer in Settings → Team. ' +
         'Note that admin status can be granted but not revoked there — promoting someone is permanent, by ' +
         'design, so one admin can never lock another one out.',
    },
    {
      q: 'How do I add teammates to my organization?',
      a: 'Anyone who signs up with a matching email joins your organization automatically — there\'s no ' +
         'invite step needed for a teammate on your own company domain. New members start as a viewer; an ' +
         'existing admin can promote them from Settings → Team whenever they\'re ready to approve forecasts too.',
    },
    {
      q: 'Is my organization\'s data isolated from other organizations?',
      a: 'Yes. Every organization\'s forecasts, scenarios, inventory numbers, and uploaded data live in a ' +
         'completely separate space — nothing is shared or visible across organizations. The one exception ' +
         'is this support queue itself: APRABot\'s own support team can see and reply to tickets across every ' +
         'organization in order to help with them, the same way any support team would.',
    },
    {
      q: 'How do I report a bug or request a feature?',
      a: 'Create a ticket below with category "Something\'s broken" (for a bug) or "Other" (for a feature ' +
         'request), and describe what you expected vs. what happened. We\'re a small team and read every ' +
         'ticket personally.',
    },
  ];

  function populateFaqSelect() {
    var sel = document.getElementById('supportFaqSelect');
    if (!sel || sel.dataset.populated) return;
    sel.dataset.populated = '1';
    FAQS.forEach(function (f, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = f.q;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      var ans = document.getElementById('supportFaqAnswer');
      if (!ans) return;
      if (sel.value === '') { ans.style.display = 'none'; return; }
      ans.textContent = FAQS[+sel.value].a;
      ans.style.display = '';
    });
  }

  var lastTickets = [];
  var isStaff = false;
  var statusFilter = 'all';

  function statusPill(status) {
    return status === 'closed'
      ? '<span class="pill" style="color:var(--muted);border-color:var(--line-2);background:var(--ink-3)">Closed</span>'
      : '<span class="pill ok">Open</span>';
  }

  function render() {
    var body = document.getElementById('supportTicketsBody');
    var empty = document.getElementById('supportEmpty');
    var orgHead = document.getElementById('supportOrgHead');
    if (!body) return;

    if (orgHead) orgHead.style.display = isStaff ? '' : 'none';

    var filtered = lastTickets.filter(function (t) {
      return statusFilter === 'all' || t.status === statusFilter;
    });

    if (!filtered.length) {
      body.innerHTML = '';
      if (empty) { empty.style.display = ''; empty.textContent = lastTickets.length ? 'No tickets match this filter.' : 'No tickets yet.'; }
      return;
    }
    if (empty) empty.style.display = 'none';

    body.innerHTML = filtered.map(function (t) {
      return '<tr onclick="viewTicket(\'' + t.id + '\')" style="cursor:pointer">' +
        '<td style="font-weight:600">' + escapeHtml(t.subject) + '</td>' +
        (isStaff ? '<td class="dsubtle" style="margin:0">' + escapeHtml(t.org || '') + '</td>' : '') +
        '<td class="dsubtle" style="margin:0">' + escapeHtml(CATEGORY_LABEL[t.category] || t.category) + '</td>' +
        '<td>' + statusPill(t.status) + '</td>' +
        '<td class="dsubtle" style="margin:0">' + (t.message_count || 1) + '</td>' +
        '<td class="dsubtle" style="margin:0" title="' + escapeHtml(t.updated_at || '') + '">' + fmtRelative(t.updated_at) + '</td>' +
        '</tr>';
    }).join('');
  }

  window.loadSupportTab = function () {
    populateFaqSelect();
    var sub = document.getElementById('supportSubtitle');
    fetch(TICKETS_API, { headers: authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        lastTickets = d.tickets || [];
        isStaff = !!d.is_staff;
        if (sub && isStaff) sub.textContent = 'Common questions, and every organization\'s support tickets — you\'re seeing this as APRABot support.';
        render();
      })
      .catch(function () {
        var body = document.getElementById('supportTicketsBody');
        if (body) body.innerHTML = '<tr><td colspan="6" class="auth-error">Could not load tickets right now.</td></tr>';
      });
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#supportStatusSeg button');
    if (!btn) return;
    document.querySelectorAll('#supportStatusSeg button').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
    statusFilter = btn.dataset.status;
    render();
  });

  /* ── New ticket modal ── */
  window.openNewTicketModal = function () {
    document.getElementById('nt-subject').value = '';
    document.getElementById('nt-message').value = '';
    document.getElementById('nt-category').value = 'other';
    document.getElementById('nt-error').textContent = '';
    document.getElementById('newTicketModal').classList.add('open');
    setTimeout(function () { document.getElementById('nt-subject').focus(); }, 60);
  };
  window.closeNewTicketModal = function () {
    document.getElementById('newTicketModal').classList.remove('open');
  };

  window.submitNewTicket = function (e) {
    e.preventDefault();
    var subject = document.getElementById('nt-subject').value.trim();
    var message = document.getElementById('nt-message').value.trim();
    var category = document.getElementById('nt-category').value;
    var errEl = document.getElementById('nt-error');
    var btn = e.target.querySelector('button[type=submit]');

    if (!subject || !message) { errEl.textContent = 'Please fill in a subject and a message.'; return; }

    btn.disabled = true; btn.textContent = 'Creating…';
    errEl.textContent = '';

    fetch(TICKETS_API, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ subject: subject, message: message, category: category }),
    })
      .then(function (r) { if (!r.ok) throw new Error('could not create the ticket'); return r.json(); })
      .then(function (d) {
        closeNewTicketModal();
        window.loadSupportTab();
        if (d.ticket_id) viewTicket(d.ticket_id);
      })
      .catch(function (err) { errEl.textContent = err.message; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Create ticket →'; });
  };

  /* ── Ticket detail + reply ── */
  var currentTicketId = null;

  window.viewTicket = function (id) {
    currentTicketId = id;
    var head = document.getElementById('ticketDetailHead');
    var body = document.getElementById('ticketDetailBody');
    head.innerHTML = '<button class="x" onclick="closeTicketDetail()" aria-label="Close">×</button>';
    body.innerHTML = '<p class="dsubtle">Loading…</p>';
    document.getElementById('ticketDetailModal').classList.add('open');

    fetch(TICKETS_API + '/' + id, { headers: authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(renderTicketDetail)
      .catch(function () {
        body.innerHTML = '<p class="auth-error">Could not load this ticket.</p>';
      });
  };
  window.closeTicketDetail = function () {
    document.getElementById('ticketDetailModal').classList.remove('open');
    currentTicketId = null;
  };

  function renderTicketDetail(ticket) {
    var head = document.getElementById('ticketDetailHead');
    var body = document.getElementById('ticketDetailBody');

    var closeAction = isStaff
      ? '<button class="dbtn" style="padding:6px 12px;font-size:12px" onclick="setTicketStatus(\'' +
        ticket.id + '\',\'' + (ticket.status === 'closed' ? 'open' : 'closed') + '\')">' +
        (ticket.status === 'closed' ? 'Reopen' : 'Close ticket') + '</button>'
      : '';

    head.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">' +
      '<div style="min-width:0"><h3 style="margin-bottom:8px">' + escapeHtml(ticket.subject) + '</h3>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + statusPill(ticket.status) +
      '<span class="dsubtle" style="margin:0;font-size:12px">' + escapeHtml(CATEGORY_LABEL[ticket.category] || ticket.category) + '</span>' +
      (isStaff && ticket.org ? '<span class="dsubtle" style="margin:0;font-size:12px">· ' + escapeHtml(ticket.org) + '</span>' : '') +
      '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex:none">' + closeAction +
      '<button class="x" onclick="closeTicketDetail()" aria-label="Close">×</button></div>' +
      '</div>' +
      '<div class="dsubtle" style="margin:10px 0 0">Opened by ' + escapeHtml((ticket.created_by || '').split('@')[0]) +
      ' · ' + fmtRelative(ticket.created_at) + '</div>';

    var thread = (ticket.messages || []).map(function (m) {
      var who = m.is_staff ? 'APRABot Support' : (m.from || '').split('@')[0];
      return '<div class="dcard" style="margin-top:14px;padding:14px' +
        (m.is_staff ? ';border-color:var(--signal-soft);background:var(--signal-soft)' : '') + '">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:6px">' +
        '<span style="font-weight:600;font-size:13px">' + escapeHtml(who) + (m.is_staff ? ' <span class="dsubtle" style="margin:0;font-size:11px">· staff</span>' : '') + '</span>' +
        '<span class="dsubtle" style="margin:0;font-size:11.5px" title="' + escapeHtml(m.created_at || '') + '">' + fmtAbsolute(m.created_at) + '</span>' +
        '</div>' +
        '<p style="margin:0;white-space:pre-wrap;font-size:13.5px;line-height:1.5">' + escapeHtml(m.body) + '</p>' +
        '</div>';
    }).join('');

    body.innerHTML = thread +
      '<div style="margin-top:18px">' +
      '<textarea id="ticketReplyBox" rows="3" placeholder="Write a reply…" style="width:100%;padding:10px 12px;border-radius:9px;background:var(--panel);border:1px solid var(--line);color:var(--text);font-family:var(--body);font-size:14px;resize:vertical"></textarea>' +
      '<p class="auth-error" id="ticketReplyError"></p>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:8px">' +
      '<button class="dbtn" style="background:var(--signal);color:#0A0E15;border-color:var(--signal)" onclick="submitTicketReply()">Reply</button>' +
      '</div></div>';
  }

  window.submitTicketReply = function () {
    var box = document.getElementById('ticketReplyBox');
    var errEl = document.getElementById('ticketReplyError');
    var message = box.value.trim();
    if (!message) { errEl.textContent = 'Write something first.'; return; }
    if (!currentTicketId) return;

    errEl.textContent = '';
    box.disabled = true;

    fetch(TICKETS_API + '/' + currentTicketId + '/reply', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ message: message }),
    })
      .then(function (r) { if (!r.ok) throw new Error('could not send the reply'); return r.json(); })
      .then(function () {
        window.loadSupportTab();
        return window.viewTicket(currentTicketId);
      })
      .catch(function (err) { errEl.textContent = err.message; box.disabled = false; });
  };

  window.setTicketStatus = function (id, status) {
    fetch(TICKETS_API + '/' + id + '/status', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ status: status }),
    })
      .then(function (r) { if (!r.ok) throw new Error('could not update status'); })
      .then(function () {
        window.loadSupportTab();
        return window.viewTicket(id);
      })
      .catch(function () {});
  };
})();
