/* ─── Auth Module ─────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var AUTH_KEY = 'disc_auth';

  function getAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
  }

  function setAuth(data) {
    if (data) localStorage.setItem(AUTH_KEY, JSON.stringify(data));
    else localStorage.removeItem(AUTH_KEY);
  }

  function getToken() {
    return getAuth()?.token || null;
  }

  function getUser() {
    return getAuth()?.user || null;
  }

  function isLoggedIn() {
    return !!getToken();
  }

  async function login(username, password) {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed');
    setAuth({ token: data.token, user: data.user });
    return data;
  }

  async function register(username, password) {
    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Register failed');
    setAuth({ token: data.token, user: data.user });
    return data;
  }

  function logout() {
    setAuth(null);
    location.reload();
  }

  // Intercept X-Refresh-Token header to slide token silently
  function handleRefreshToken(res) {
    const fresh = res.headers.get('X-Refresh-Token');
    if (fresh) {
      const auth = getAuth();
      if (auth) { auth.token = fresh; setAuth(auth); }
    }
  }

  window.Auth = { getToken, getUser, isLoggedIn, login, register, logout, handleRefreshToken };
})();
