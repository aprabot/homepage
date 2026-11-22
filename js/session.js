/* Shared Cognito session for the sign-in page and dashboard. */
var APRA_SESSION = (function () {
  'use strict';

  var clientId = '5g9h8366bt5j8el588eh3lh5n4';
  var endpoint = 'https://cognito-idp.us-east-1.amazonaws.com/';
  var refreshPending = null;

  function parseJwt(token) {
    try {
      var payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var bytes = Uint8Array.from(atob(payload), function (character) { return character.charCodeAt(0); });
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      return {};
    }
  }

  function expiresAt(token) {
    return Number(parseJwt(token).exp || 0) * 1000;
  }

  async function cognitoPost(target, body) {
    var response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + target,
      },
      body: JSON.stringify(body),
    });
    var data = await response.json();
    if (!response.ok) {
      var error = new Error(data.message || data.__type || 'Authentication failed');
      error.code = String(data.__type || '').split('#').pop();
      throw error;
    }
    return data;
  }

  function clear() {
    ['apra_access', 'apra_id', 'apra_refresh', 'apra_remember', 'apra_forecast_cache'].forEach(function (key) {
      localStorage.removeItem(key);
    });
  }

  function set(tokens, remember) {
    if (!tokens || !tokens.IdToken || !tokens.AccessToken) throw new Error('Sign-in did not return a session.');
    clear();
    localStorage.setItem('apra_access', tokens.AccessToken);
    localStorage.setItem('apra_id', tokens.IdToken);
    if (remember && tokens.RefreshToken) {
      localStorage.setItem('apra_refresh', tokens.RefreshToken);
      localStorage.setItem('apra_remember', '1');
    }
  }

  function rememberedToken() {
    var token = localStorage.getItem('apra_refresh');
    return localStorage.getItem('apra_remember') === '1' && token && token !== 'undefined' ? token : null;
  }

  function refresh(token) {
    if (refreshPending && refreshPending.token === token) return refreshPending.promise;
    var pending = { token: token };
    refreshPending = pending;
    pending.promise = cognitoPost('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: token },
    }).then(function (data) {
      if (rememberedToken() !== token) return null;
      var result = data.AuthenticationResult;
      if (!result || !result.AccessToken || expiresAt(result.IdToken) <= Date.now()) {
        throw new Error('Session renewal did not return usable tokens.');
      }
      localStorage.setItem('apra_access', result.AccessToken);
      localStorage.setItem('apra_id', result.IdToken);
      return result.IdToken;
    }).catch(function (error) {
      if (rememberedToken() !== token) return null;
      if (error.code === 'NotAuthorizedException' || error.code === 'UserNotFoundException') {
        clear();
        return null;
      }
      throw error;
    }).finally(function () {
      if (refreshPending === pending) refreshPending = null;
    });
    return pending.promise;
  }

  async function getIdToken() {
    var current = localStorage.getItem('apra_id');
    var remembered = rememberedToken();
    var expiration = expiresAt(current);
    if (expiration > Date.now() + (remembered ? 30000 : 0)) return current;
    if (remembered) {
      try {
        return await refresh(remembered);
      } catch (error) {
        if (localStorage.getItem('apra_id') === current && expiration > Date.now()) return current;
        throw error;
      }
    }
    if (current || localStorage.getItem('apra_refresh')) clear();
    return null;
  }

  function requireSignIn() {
    location.replace('/');
    return new Error('Session expired. Sign in again.');
  }

  async function authenticatedFetch(url, options) {
    var token = await getIdToken();
    if (!token) throw requireSignIn();
    var remembered = rememberedToken();
    function send(value) {
      var headers = new Headers(options && options.headers);
      headers.set('Authorization', 'Bearer ' + value);
      return fetch(url, Object.assign({}, options, { headers: headers }));
    }
    var response = await send(token);
    if (response.status !== 401) return response;
    if (!remembered) {
      if (localStorage.getItem('apra_id') === token) {
        clear();
        throw requireSignIn();
      }
      return response;
    }
    if (rememberedToken() !== remembered) return response;
    var current = localStorage.getItem('apra_id');
    var fresh = current !== token && expiresAt(current) > Date.now() ? current : await refresh(remembered);
    if (!fresh) {
      if (!localStorage.getItem('apra_id')) throw requireSignIn();
      return response;
    }
    return send(fresh);
  }

  async function getAccessToken() {
    if (!await getIdToken()) throw requireSignIn();
    return localStorage.getItem('apra_access');
  }

  return {
    cognitoPost: cognitoPost,
    set: set,
    clear: clear,
    getIdToken: getIdToken,
    getAccessToken: getAccessToken,
    fetch: authenticatedFetch,
  };
})();
