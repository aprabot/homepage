(function () {
  var KNOWLEDGE_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/knowledge';
  var CHAT_API      = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/chat';
  var loaded = false;
  var kbHistory = [];

  var CHIPS = [
    'What is Forecast Value Added?',
    "Why doesn't a bigger discount produce a proportionally bigger forecast change?",
    'What is the bullwhip effect?',
    'Why does WAPE hide bias?',
    'What causes error to compound in a recursive forecast?',
  ];

  function authHeaders() {
    var t = localStorage.getItem('apra_id');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function fmtDate(iso) {
    if (!iso) return 'not saved yet — showing the built-in default';
    var d = new Date(iso);
    return 'Last updated ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function mdLite(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n+/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  window.loadKnowledgeTab = function () {
    if (loaded) return;
    loaded = true;

    var editor = document.getElementById('kbEditor');
    var updated = document.getElementById('kbUpdated');
    fetch(KNOWLEDGE_API, { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        editor.value = d.content || '';
        updated.textContent = fmtDate(d.updated_at);
      })
      .catch(function () {
        editor.placeholder = 'Could not load — try refreshing the page.';
      });

    var saveBtn = document.getElementById('kbSaveBtn');
    var saveMsg = document.getElementById('kbSaveMsg');
    saveBtn.addEventListener('click', function () {
      var content = editor.value;
      if (!content.trim()) {
        saveMsg.textContent = "Can't save empty content.";
        saveMsg.className = 'stest-msg err';
        return;
      }
      saveBtn.disabled = true;
      saveMsg.textContent = 'Saving…';
      saveMsg.className = 'stest-msg';
      fetch(KNOWLEDGE_API, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ content: content }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          saveBtn.disabled = false;
          if (d.saved) {
            saveMsg.textContent = 'Saved — live for every user’s next message.';
            saveMsg.className = 'stest-msg ok';
            updated.textContent = fmtDate(d.updated_at);
          } else {
            saveMsg.textContent = d.error || 'Save failed — try again.';
            saveMsg.className = 'stest-msg err';
          }
        })
        .catch(function () {
          saveBtn.disabled = false;
          saveMsg.textContent = 'Connection error — try again.';
          saveMsg.className = 'stest-msg err';
        });
    });

    var chips = document.getElementById('kbChips');
    chips.innerHTML = CHIPS.map(function (q) {
      return '<button type="button">' + q.replace(/</g, '&lt;') + '</button>';
    }).join('');
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (btn) askKb(btn.textContent);
    });

    var form = document.getElementById('kbChatForm');
    var input = document.getElementById('kbChatInput');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      input.value = '';
      askKb(q);
    });
  };

  function pushKbMsg(html, who) {
    var body = document.getElementById('kbChatBody');
    var d = document.createElement('div');
    d.className = 'cb-msg ' + who;
    d.innerHTML = html;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
  }

  function askKb(q) {
    pushKbMsg(q.replace(/</g, '&lt;'), 'user');
    kbHistory.push({ role: 'user', content: q });

    var body = document.getElementById('kbChatBody');
    var typ = document.createElement('div');
    typ.className = 'cb-msg bot';
    typ.textContent = 'Thinking…';
    body.appendChild(typ);
    body.scrollTop = body.scrollHeight;

    fetch(CHAT_API, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        message: q,
        history: kbHistory.slice(0, -1).slice(-8),
        max_tokens: 512,
        temperature: 0.3,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typ.remove();
        var reply = d.reply || 'Sorry, something went wrong — please try again.';
        pushKbMsg(mdLite(reply), 'bot');
        kbHistory.push({ role: 'assistant', content: reply });
      })
      .catch(function () {
        typ.remove();
        pushKbMsg('Connection error — please try again.', 'bot');
      });
  }
})();
