/* ============================================================
   APRABot — Cognito auth (replaces demo stubs in main.js)
   User Pool : us-east-1_fb34nECGY
   Client ID : 5g9h8366bt5j8el588eh3lh5n4
============================================================ */

var APRA_AUTH = (function () {
  var CLIENT_ID = '5g9h8366bt5j8el588eh3lh5n4';
  var ENDPOINT  = 'https://cognito-idp.us-east-1.amazonaws.com/';
  var _signupEmail = '';

  function cognitoPost(target, body) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-amz-json-1.1',
        'X-Amz-Target':  'AWSCognitoIdentityProviderService.' + target
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
    try {
      var b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(
        atob(b64).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')
      ));
    } catch (e) { return {}; }
  }

  function friendlyError(msg) {
    if (!msg) return 'Something went wrong. Please try again.';
    if (/NotAuthorized|Incorrect username or password/i.test(msg))  return 'Incorrect email or password.';
    if (/UserNotFoundException|UserNotFound/i.test(msg))            return 'No account found with that email.';
    if (/UserNotConfirmedException|not confirmed/i.test(msg))       return 'Please verify your email first — check your inbox.';
    if (/TooManyRequests|LimitExceeded/i.test(msg))                 return 'Too many attempts. Please wait a moment and try again.';
    if (/UsernameExistsException|already exists/i.test(msg))        return 'An account with that email already exists. Try signing in.';
    if (/CodeMismatchException|CodeMismatch/i.test(msg))            return 'Incorrect code. Please try again.';
    if (/ExpiredCodeException|ExpiredCode/i.test(msg))              return 'Code expired — click "Resend code" to get a new one.';
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
    localStorage.removeItem('apra_remember');
  }

  // "Keep me signed in" — the ID/access tokens Cognito issues are short-
  // lived (1hr, this app client's default), so without this every user
  // gets bounced back to login every hour regardless of activity. The
  // refresh token this app client already gets (ALLOW_REFRESH_TOKEN_AUTH
  // is enabled) lasts 30 days — this silently trades a spent access/id
  // token for a fresh pair using it, only when the user opted in at login.
  function refreshSession() {
    var refreshToken = localStorage.getItem('apra_refresh');
    if (!refreshToken) return Promise.reject(new Error('no refresh token stored'));
    return cognitoPost('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken }
    }).then(function (data) {
      var result = data.AuthenticationResult || {};
      if (!result.IdToken) throw new Error('refresh did not return new tokens');
      // REFRESH_TOKEN_AUTH doesn't reissue a refresh token (no rotation on
      // this app client) — only access/id actually renew, the existing
      // refresh token stays valid until its own 30-day expiry.
      localStorage.setItem('apra_access', result.AccessToken);
      localStorage.setItem('apra_id',     result.IdToken);
      return result;
    });
  }

  function applyUser(email) {
    var display = (email || 'User').split('@')[0];
    ['userName', 'greetName'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = display;
    });
    var av = document.getElementById('userAvatar');
    if (av) av.textContent = display.charAt(0).toUpperCase();
  }

  function enterDashboard(email) {
    applyUser(email);
    var modal = document.getElementById('loginModal');
    if (modal) modal.classList.remove('open');
    window.location.href = '/dashboard';
  }

  /* restore session on load — redirect to dashboard if already signed in.
     An expired id token with "Keep me signed in" checked at login gets one
     silent refresh attempt before giving up — this is what actually lets a
     return visit skip re-entering credentials for up to the refresh
     token's own 30-day life, not just whatever's left of the 1hr id token. */
  var _stored = localStorage.getItem('apra_id');
  if (_stored) {
    var _p = parseJwt(_stored);
    if (_p.exp && _p.exp * 1000 > Date.now()) {
      window.location.replace('/dashboard');
    } else if (localStorage.getItem('apra_remember') === '1' && localStorage.getItem('apra_refresh')) {
      refreshSession().then(function () {
        window.location.replace('/dashboard');
      }).catch(function () {
        clearSession();
      });
    } else {
      clearSession();
    }
  }

  return {
    cognitoPost:  cognitoPost,
    friendlyError: friendlyError,
    setSession:   setSession,
    clearSession: clearSession,
    refreshSession: refreshSession,
    applyUser:    applyUser,
    enterDashboard: enterDashboard,
    getSignupEmail: function () { return _signupEmail; },
    setSignupEmail: function (e) { _signupEmail = e; }
  };
})();

/* ── Sign-in ── */
function openLogin() {
  var m = document.getElementById('loginModal');
  if (m) m.classList.add('open');
  var err = document.getElementById('auth-error');
  if (err) err.textContent = '';
  setTimeout(function () { var f = document.getElementById('uid'); if (f) f.focus(); }, 60);
}

function closeLogin() {
  var m = document.getElementById('loginModal');
  if (m) m.classList.remove('open');
}

function doLogin(e) {
  e.preventDefault();
  var email    = (document.getElementById('uid').value  || '').trim();
  var password =  document.getElementById('pwd').value  || '';
  var remember =  document.getElementById('rememberMe');
  var errEl    =  document.getElementById('auth-error');
  var btn      =  e.target.querySelector('button[type=submit]');

  if (!email || !password) { if (errEl) errEl.textContent = 'Please enter your email and password.'; return; }

  btn.disabled = true; btn.textContent = 'Signing in…';
  if (errEl) errEl.textContent = '';

  APRA_AUTH.cognitoPost('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: '5g9h8366bt5j8el588eh3lh5n4',
    AuthParameters: { USERNAME: email, PASSWORD: password }
  }).then(function (data) {
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      if (errEl) errEl.textContent = 'Your account requires a password reset — check your email.';
      btn.disabled = false; btn.textContent = 'Sign in →';
      return;
    }
    APRA_AUTH.setSession(data.AuthenticationResult);
    // Drives the silent-refresh-on-return-visit check in auth.js's own
    // restore-session-on-load logic — unchecked means a return visit after
    // the 1hr id token lapses goes back to a normal login, same as today.
    if (remember && remember.checked) localStorage.setItem('apra_remember', '1');
    else localStorage.removeItem('apra_remember');
    APRA_AUTH.enterDashboard(email);
  }).catch(function (err) {
    if (errEl) errEl.textContent = APRA_AUTH.friendlyError(err.message);
    btn.disabled = false; btn.textContent = 'Sign in →';
  });
}

function logout() {
  APRA_AUTH.clearSession();
  window.location.replace('./');
}

/* ── Sign-up ── */
function openSignup() {
  var m = document.getElementById('signupModal');
  if (!m) return;
  m.classList.add('open');
  document.getElementById('su-step1').style.display = '';
  document.getElementById('su-step2').style.display = 'none';
  var err = document.getElementById('su-error');
  if (err) err.textContent = '';
  setTimeout(function () { var f = document.getElementById('su-email'); if (f) f.focus(); }, 60);

  var pwdInput = document.getElementById('su-pwd');
  if (pwdInput && !pwdInput._reqsBound) {
    pwdInput._reqsBound = true;
    pwdInput.addEventListener('input', function () {
      var v = pwdInput.value;
      function set(id, ok) { var el = document.getElementById(id); if (el) el.classList.toggle('ok', ok); }
      set('req-len',   v.length >= 8);
      set('req-upper', /[A-Z]/.test(v));
      set('req-num',   /[0-9]/.test(v));
      set('req-spec',  /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(v));
    });
  }
}

function closeSignup() {
  var m = document.getElementById('signupModal');
  if (m) m.classList.remove('open');
}

function doSignup(e) {
  e.preventDefault();
  var email = (document.getElementById('su-email').value || '').trim();
  var pwd   =  document.getElementById('su-pwd').value   || '';
  var pwd2  =  document.getElementById('su-pwd2').value  || '';
  var errEl =  document.getElementById('su-error');
  var btn   =  e.target.querySelector('button[type=submit]');

  if (!email || !pwd)            { errEl.textContent = 'Please fill in all fields.'; return; }
  if (pwd !== pwd2)              { errEl.textContent = 'Passwords do not match.'; return; }
  if (pwd.length < 8)            { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (!/[A-Z]/.test(pwd))        { errEl.textContent = 'Password must contain an uppercase letter.'; return; }
  if (!/[0-9]/.test(pwd))        { errEl.textContent = 'Password must contain a number.'; return; }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd)) { errEl.textContent = 'Password must contain a special character.'; return; }

  btn.disabled = true; btn.textContent = 'Creating account…';
  errEl.textContent = '';

  APRA_AUTH.cognitoPost('SignUp', {
    ClientId:        '5g9h8366bt5j8el588eh3lh5n4',
    Username:        email,
    Password:        pwd,
    UserAttributes:  [{ Name: 'email', Value: email }]
  }).then(function () {
    APRA_AUTH.setSignupEmail(email);
    document.getElementById('su-sent-to').textContent = email;
    document.getElementById('su-step1').style.display = 'none';
    document.getElementById('su-step2').style.display = '';
    setTimeout(function () { var f = document.getElementById('su-code'); if (f) f.focus(); }, 60);
  }).catch(function (err) {
    errEl.textContent = APRA_AUTH.friendlyError(err.message);
    btn.disabled = false; btn.textContent = 'Create account →';
  });
}

function doVerify(e) {
  e.preventDefault();
  var code  = (document.getElementById('su-code').value || '').trim();
  var errEl =  document.getElementById('su-verify-error');
  var btn   =  e.target.querySelector('button[type=submit]');

  if (!code) { errEl.textContent = 'Please enter the verification code.'; return; }

  btn.disabled = true; btn.textContent = 'Verifying…';
  errEl.textContent = '';

  APRA_AUTH.cognitoPost('ConfirmSignUp', {
    ClientId:         '5g9h8366bt5j8el588eh3lh5n4',
    Username:         APRA_AUTH.getSignupEmail(),
    ConfirmationCode: code
  }).then(function () {
    closeSignup();
    openLogin();
    var f = document.getElementById('uid');
    if (f) f.value = APRA_AUTH.getSignupEmail();
    setTimeout(function () { var p = document.getElementById('pwd'); if (p) p.focus(); }, 80);
  }).catch(function (err) {
    errEl.textContent = APRA_AUTH.friendlyError(err.message);
    btn.disabled = false; btn.textContent = 'Verify & sign in →';
  });
}

function resendCode() {
  APRA_AUTH.cognitoPost('ResendConfirmationCode', {
    ClientId: '5g9h8366bt5j8el588eh3lh5n4',
    Username: APRA_AUTH.getSignupEmail()
  }).then(function () {
    document.getElementById('su-verify-error').textContent = 'Code resent — check your inbox.';
  }).catch(function (err) {
    document.getElementById('su-verify-error').textContent = APRA_AUTH.friendlyError(err.message);
  });
}
