// api-client.js — connects Mud Magic to the real Project API backend
// (../api). Handles register/login/token storage and lets the Studio save
// designs as real database records instead of only localStorage.
//
// Auth model: the login form only collects an email + password, so one form
// acts as both sign-in and sign-up:
//   1. try POST /login with the email as the identifier (the API accepts
//      username OR email);
//   2. if that is a 401 the account either doesn't exist yet or the password
//      is wrong — try POST /register with a username derived from the email;
//   3. "Email already registered" at that point means the account exists, so
//      the password was simply wrong.
// Access tokens last 30 minutes, so authenticated calls transparently use the
// refresh token (POST /refresh) once when the API answers 401.
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

  /** Candidate usernames for an email: readable first, then collision-proof. */
  function usernameCandidates(email) {
    const local = email.split("@")[0] || "user";
    let base = local.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    if (base.length < 3) base = `user_${base}`;
    let h = 5381;
    for (let i = 0; i < email.length; i++) h = ((h * 33) ^ email.charCodeAt(i)) >>> 0;
    const suffix = h.toString(16).slice(0, 6);
    const rand = Math.floor(1000 + Math.random() * 9000);
    return [base, `${base}_${suffix}`, `${base}_${suffix}${rand}`];
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
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      const error = new Error(detail);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /* ---------- token refresh ---------- */
  let refreshing = null; // shared promise so parallel 401s refresh only once

  function refreshTokens() {
    if (refreshing) return refreshing;
    const auth = getAuth();
    if (!auth || !auth.refresh_token) return Promise.reject(new Error("Not logged in"));
    refreshing = apiFetch("/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
    })
      .then((tokens) => {
        setAuth({ ...auth, ...tokens });
        return tokens;
      })
      .catch((err) => {
        clearAuth(); // refresh token expired/revoked — the user must sign in again
        const expired = new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
        expired.status = err.status || 401;
        throw expired;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /** fetch with the Bearer token; on 401 refresh once and retry. */
  async function authedFetch(path, options = {}) {
    const auth = getAuth();
    if (!auth || !auth.access_token) throw new Error("Not logged in");
    const run = (token) =>
      apiFetch(path, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
      });
    try {
      return await run(auth.access_token);
    } catch (err) {
      if (err.status !== 401) throw err;
      const tokens = await refreshTokens();
      return run(tokens.access_token);
    }
  }

  async function loginWith(identifier, password) {
    const tokens = await apiFetch("/login", {
      method: "POST",
      body: JSON.stringify({ username: identifier, password }),
    });
    setAuth(tokens);
    const me = await apiFetch("/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    setAuth({ ...tokens, user: me });
    return me;
  }

  /** Sign in, or create the account on first use; returns the user. */
  async function registerOrLogin(rawEmail, password) {
    const email = rawEmail.trim().toLowerCase();
    try {
      return await loginWith(email, password);
    } catch (err) {
      if (err.status !== 401) throw err; // network / deactivated account etc.
    }

    // 401: either no account yet or wrong password — try to sign up.
    for (const username of usernameCandidates(email)) {
      try {
        await apiFetch("/register", {
          method: "POST",
          body: JSON.stringify({ username, email, password }),
        });
        return await loginWith(email, password);
      } catch (err) {
        if (err.status !== 409) throw err;
        if (/email/i.test(err.message)) {
          const wrong = new Error("รหัสผ่านไม่ถูกต้อง");
          wrong.status = 401;
          throw wrong; // the account exists, so the password was wrong
        }
        // otherwise the username is taken — try the next candidate
      }
    }
    throw new Error("สร้างบัญชีไม่สำเร็จ ลองใช้อีเมลอื่นอีกครั้ง");
  }

  function logout() {
    const auth = getAuth();
    clearAuth();
    if (auth && auth.refresh_token) {
      // best effort: revoke the refresh token on the server
      apiFetch("/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: auth.refresh_token }),
      }).catch(() => {});
    }
  }

  /** Saves a design as a Project record owned by the logged-in user. */
  async function saveDesignAsProject(config, name) {
    return authedFetch("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: name || `Ceramic design — ${new Date().toLocaleString()}`,
        description: JSON.stringify(config),
      }),
    });
  }

  /** Lists the logged-in user's saved designs (Projects). */
  async function listMyDesigns() {
    if (!isLoggedIn()) return [];
    const page = await authedFetch("/projects?page=1&limit=50");
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
