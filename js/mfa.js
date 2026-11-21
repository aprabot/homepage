/* ============================================================
   APRABot — TOTP (authenticator app) MFA via Cognito
   User Pool : us-east-1_fb34nECGY
   Client ID : 5g9h8366bt5j8el588eh3lh5n4

   Shared by the login flow (index.html) and the Settings
   enrollment UI (dashboard/index.html). Kept separate from
   auth.js because auth.js runs an unconditional "redirect to
   /dashboard if already signed in" check at load time — loading
   that file inside the dashboard itself would re-trigger that
   redirect on every single page load.
============================================================ */

var APRA_MFA = (function () {
  var CLIENT_ID = '5g9h8366bt5j8el588eh3lh5n4';
  var ENDPOINT  = 'https://cognito-idp.us-east-1.amazonaws.com/';

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
        // __type (e.g. "CodeMismatchException") is what friendlyError()
        // actually matches against — Cognito's human-readable `message`
        // text doesn't reliably contain the exception name itself, so
        // include both rather than let errors fall through to the raw text
        if (!res.ok) throw new Error([data.__type, data.message].filter(Boolean).join(': ') || 'Request failed');
        return data;
      });
    });
  }

  function friendlyError(msg) {
    if (!msg) return 'Something went wrong. Please try again.';
    if (/EnableSoftwareTokenMFAException/i.test(msg))      return 'Could not confirm that code. Check your authenticator app and try again.';
    if (/CodeMismatchException|CodeMismatch/i.test(msg))   return 'Incorrect code. Check your authenticator app and try again.';
    if (/ExpiredCodeException|ExpiredCode/i.test(msg))     return 'That code expired — enter the current one from your authenticator app.';
    if (/NotAuthorizedException|NotAuthorized/i.test(msg)) return 'Your session has expired — please sign in again.';
    if (/TooManyRequests|LimitExceeded/i.test(msg))        return 'Too many attempts. Please wait a moment and try again.';
    return msg;
  }

  // Step 1 of enrollment — ask Cognito to generate a new TOTP secret for
  // the signed-in user. Returns the base32 secret to show them.
  function associateSoftwareToken(accessToken) {
    return cognitoPost('AssociateSoftwareToken', { AccessToken: accessToken })
      .then(function (data) { return data.SecretCode; });
  }

  // Step 2 — the user added the secret to their authenticator app and
  // typed back the 6-digit code it's showing. This proves the secret
  // actually works before Cognito allows it to become an active MFA method.
  function verifySoftwareToken(accessToken, code) {
    return cognitoPost('VerifySoftwareToken', { AccessToken: accessToken, UserCode: code })
      .then(function (data) {
        // a non-matching code can come back as a 200 with Status: "ERROR"
        // rather than an HTTP-level exception, depending on the failure —
        // don't let that silently read as success
        if (data.Status !== 'SUCCESS') throw new Error('CodeMismatchException');
        return data;
      });
  }

  // Step 3 — flip the user's MFA preference. VerifySoftwareToken alone only
  // proves the secret works; this is what makes Cognito actually challenge
  // for it on future logins.
  function setMfaPreference(accessToken, enabled) {
    return cognitoPost('SetUserMFAPreference', {
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: enabled, PreferredMfa: enabled }
    });
  }

  // Current status, for rendering the Settings card correctly on load.
  function getMfaStatus(accessToken) {
    return cognitoPost('GetUser', { AccessToken: accessToken }).then(function (data) {
      var list = data.UserMFASettingList || [];
      return { enabled: list.indexOf('SOFTWARE_TOKEN_MFA') !== -1 };
    });
  }

  // Login-time challenge response — used when InitiateAuth comes back with
  // ChallengeName === 'SOFTWARE_TOKEN_MFA' instead of tokens.
  function respondToMfaChallenge(email, session, code) {
    return cognitoPost('RespondToAuthChallenge', {
      ClientId: CLIENT_ID,
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: session,
      ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code }
    });
  }

  return {
    friendlyError: friendlyError,
    associateSoftwareToken: associateSoftwareToken,
    verifySoftwareToken: verifySoftwareToken,
    setMfaPreference: setMfaPreference,
    getMfaStatus: getMfaStatus,
    respondToMfaChallenge: respondToMfaChallenge
  };
})();
