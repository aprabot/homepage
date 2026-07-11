(function () {
  'use strict';

  const CLIENT_ID = '5g9h8366bt5j8el588eh3lh5n4';
  const REGION    = 'us-east-1';
  const ENDPOINT  = 'https://cognito-idp.' + REGION + '.amazonaws.com/';

  function cognitoPost(target, body) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + target
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.message || data.__type || 'Authentication failed');
        return data;
      });
    });
  }

  function parseJwt(token) {
    var base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(
      atob(base64).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')
    ));
  }

  function friendlyError(msg) {
    if (/NotAuthorized|Incorrect username or password/i.test(msg)) return 'Incorrect email or password.';
    if (/UserNotFoundException|UserNotFound/i.test(msg))           return 'No account found with that email.';
    if (/UserNotConfirmedException|not confirmed/i.test(msg))      return 'Please verify your email first — check your inbox.';
    if (/TooManyRequests|LimitExceeded/i.test(msg))                return 'Too many attempts. Please wait a moment and try again.';
    return msg;
  }

  function setSession(tokens) {
    localStorage.setItem('apra_access',  tokens.AccessToken);
    localStorage.setItem('apra_id',      tokens.IdToken);
    localStorage.setItem('apra_refresh', tokens.RefreshToken);
  }

  function clearSession() {
    localStorage.removeItem('apra_access');
    localStorage.removeItem('apra_id');
    localStorage.removeItem('apra_refresh');
  }

  function applyUser(email) {
    var display = (email || 'User').split('@')[0];
    var el = function (id) { return document.getElementById(id); };
    if (el('userName'))   el('userName').textContent   = display;
    if (el('greetName'))  el('greetName').textContent  = display;
    if (el('userAvatar')) el('userAvatar').textContent = display.charAt(0).toUpperCase();
  }

  /* ── public API ── */

  window.openLogin = function () {
    var modal = document.getElementById('loginModal');
    if (modal) modal.classList.add('open');
    var err = document.getElementById('auth-error');
    if (err) err.textContent = '';
    setTimeout(function () {
      var f = document.getElementById('uid');
      if (f) f.focus();
    }, 60);
  };

  window.closeLogin = function () {
    var modal = document.getElementById('loginModal');
    if (modal) modal.classList.remove('open');
  };

  window.doLogin = function (e) {
    e.preventDefault();
    var email    = (document.getElementById('uid').value  || '').trim();
    var password = (document.getElementById('pwd').value  || '');
    var errEl    = document.getElementById('auth-error');
    var btn      = e.target.querySelector('button[type=submit]');

    if (!email || !password) {
      if (errEl) errEl.textContent = 'Please enter your email and password.';
      return;
    }

    btn.disabled    = true;
    btn.textContent = 'Signing in…';
    if (errEl) errEl.textContent = '';

    cognitoPost('InitiateAuth', {
      AuthFlow:       'USER_PASSWORD_AUTH',
      ClientId:       CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    }).then(function (data) {
      if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        if (errEl) errEl.textContent = 'Your account requires a password reset — check your email.';
        btn.disabled    = false;
        btn.textContent = 'Sign in →';
        return;
      }

      setSession(data.AuthenticationResult);
      applyUser(email);

      window.closeLogin();
      document.getElementById('uid').value = '';
      document.getElementById('pwd').value = '';
      document.getElementById('dashboard').classList.add('open');
      document.body.style.overflow = 'hidden';
      if (typeof initDashboard === 'function') initDashboard();

    }).catch(function (err) {
      if (errEl) errEl.textContent = friendlyError(err.message);
      btn.disabled    = false;
      btn.textContent = 'Sign in →';
    });
  };

  window.logout = function () {
    clearSession();
    document.getElementById('dashboard').classList.remove('open');
    document.body.style.overflow = '';
    window.scrollTo(0, 0);
  };

  /* ── restore session on page load ── */
  var idToken = localStorage.getItem('apra_id');
  if (idToken) {
    try {
      var payload = parseJwt(idToken);
      if (payload.exp * 1000 > Date.now()) {
        applyUser(payload.email || '');
      } else {
        clearSession();
      }
    } catch (e) {
      clearSession();
    }
  }
})();
