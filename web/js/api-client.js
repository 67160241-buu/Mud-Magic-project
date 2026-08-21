// api-client.js — connects Mud Magic to the real Project API backend
// (../api). Handles register/login/token storage and lets the Studio save
// designs as real database records instead of only localStorage.
//
// Auth model: the API's /register needs a username; this site's login form
// only collects email, so on submit we derive a username from the email's
// local-part and try register-then-login. If the account already exists,
// register 409s and we just log in — giving a single-field sign-in/sign-up
// flow without changing the API's contract.
(function () {
  "use strict";

  const API_BASE = window.MUDMAGIC_API_BASE || "http://localhost:8000";
  const TOKEN_KEY = "mudmagic_api_auth";

  function getAuth() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    } catch (err) {
      return null;
    }
  }
  function setAuth(auth) {
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(auth));
    } catch (err) {
      /* storage disabled — session simply won't persist across reloads */
    }
  }
  function clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (err) {
      /* ignore */
    }
  }
  function isLoggedIn() {
    const auth = getAuth();
    return !!(auth && auth.access_token);
  }

  function usernameFromEmail(email) {
    const local = email.split("@")[0] || "user";
    const cleaned = local.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    return cleaned.length >= 3 ? cleaned : `user_${cleaned}`;
  }

  async function apiFetch(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch (err) {
        /* non-JSON error body */
      }
      const error = new Error(detail);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /** Register-then-login using an email address; returns the auth user. */
  async function registerOrLogin(email, password) {
    const username = usernameFromEmail(email);
    try {
      await apiFetch("/register", {
        method: "POST",
        body: JSON.stringify({ username, email, password }),
      });
    } catch (err) {
      if (err.status !== 409) throw err; // 409 = already registered, fall through to login
    }
    const tokens = await apiFetch("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setAuth(tokens);
    const me = await apiFetch("/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    setAuth({ ...tokens, user: me });
    return me;
  }

  function logout() {
    clearAuth();
  }

  /** Saves a mug design as a Project record owned by the logged-in user. */
  async function saveDesignAsProject(config, name) {
    const auth = getAuth();
    if (!auth || !auth.access_token) throw new Error("Not logged in");
    return apiFetch("/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.access_token}` },
      body: JSON.stringify({
        name: name || `Mug design — ${new Date().toLocaleString()}`,
        description: JSON.stringify(config),
      }),
    });
  }

  /** Lists the logged-in user's saved designs (Projects). */
  async function listMyDesigns() {
    const auth = getAuth();
    if (!auth || !auth.access_token) return [];
    const page = await apiFetch("/projects?page=1&limit=50", {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    });
    return page.items || [];
  }

  window.MudMagicAPI = {
    API_BASE,
    getAuth,
    isLoggedIn,
    registerOrLogin,
    logout,
    saveDesignAsProject,
    listMyDesigns,
  };
})();
