// api-client.js — connects Mud Magic accounts and saved designs to the
// site's own Cloudflare Worker (src/index.js, data in D1). Everything is
// same-origin: /api/auth/* for accounts, /api/designs for saved designs.
// The login session is an HttpOnly cookie, so no token ever touches JS.
//
// The public surface is unchanged from the Firebase client, so the pages
// that use window.MudMagicAPI need no edits:
//   getAuth(), isLoggedIn(), login(), register(), loginWithGoogle(),
//   registerOrLogin(), logout(), saveDesignAsProject(config, name),
//   listMyDesigns(max), deleteDesign(id), getProfile(), updateDisplayName(name),
//   ready()
//
// isLoggedIn() must stay synchronous for the existing callers, so the
// signed-in user is cached in localStorage and reconciled with /api/auth/me
// on every page load.
(function () {
  "use strict";

  const AUTH_KEY = "mudmagic_auth";
  try {
    localStorage.removeItem("mudmagic_firebase_auth"); // left over from the Firebase version
  } catch (err) {
    /* ignore */
  }

  /* ---------- cached session (sync reads for existing callers) ---------- */
  function getAuth() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    } catch (err) {
      return null;
    }
  }
  function setAuth(auth) {
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    } catch (err) {
      /* storage disabled — the session still works, the nav just won't know */
    }
  }
  function clearAuth() {
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch (err) {
      /* ignore */
    }
  }
  function isLoggedIn() {
    const auth = getAuth();
    return !!(auth && auth.user && auth.user.id);
  }

  function toUser(u) {
    return { id: u.id, email: u.email || "", username: u.username || (u.email || "").split("@")[0] || "user" };
  }

  /* ---------- HTTP ---------- */
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && !/\/auth\/login$/.test(path)) clearAuth();
      const e = new Error((data && typeof data.detail === "string" && data.detail) || "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง");
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // Resolves once the cached session has been checked against the server.
  let ready = null;
  function serverReady() {
    if (ready) return ready;
    ready = request("GET", "/api/auth/me").then((data) => {
      if (data && data.user) setAuth({ user: toUser(data.user) });
      else clearAuth();
      return data && data.user;
    });
    ready.catch(() => {
      ready = null; // allow a retry after e.g. a network failure
    });
    return ready;
  }

  function signedIn(data) {
    const user = toUser(data.user);
    setAuth({ user });
    ready = Promise.resolve(data.user);
    return user;
  }

  /** Sign in to an existing account; returns the user. */
  async function login(rawEmail, password) {
    const email = String(rawEmail || "").trim().toLowerCase();
    return signedIn(await request("POST", "/api/auth/login", { email, password }));
  }

  /** Create a new account (displayName defaults to the email's local part). */
  async function register(rawEmail, password, displayName) {
    const email = String(rawEmail || "").trim().toLowerCase();
    return signedIn(await request("POST", "/api/auth/signup", { email, password, display_name: (displayName || "").trim() }));
  }

  /**
   * Sign in with Google. This leaves the page (full redirect to Google and
   * back to the current page), so the returned promise never resolves.
   */
  function loginWithGoogle(next) {
    const here = next || location.pathname.replace(/^\//, "") + location.search;
    location.href = `/api/auth/google?next=${encodeURIComponent(here || "index.html")}`;
    return new Promise(() => {});
  }

  /** Sign in, or create the account on first use; returns the user. */
  async function registerOrLogin(rawEmail, password) {
    try {
      return await login(rawEmail, password);
    } catch (err) {
      if (err.status !== 401) throw err;
    }
    // Either no account yet or a wrong password — try to sign up.
    try {
      return await register(rawEmail, password);
    } catch (err) {
      if (err.status === 409) {
        const wrong = new Error("รหัสผ่านไม่ถูกต้อง");
        wrong.status = 401;
        throw wrong; // the account exists, so the password was wrong
      }
      throw err;
    }
  }

  function logout() {
    clearAuth();
    ready = Promise.resolve(null);
    return request("POST", "/api/auth/logout").catch(() => {});
  }

  function requireLoggedIn() {
    if (!isLoggedIn()) {
      const e = new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
      e.status = 401;
      throw e;
    }
  }

  /** Saves a design, owned by the logged-in user. */
  async function saveDesignAsProject(config, name) {
    requireLoggedIn();
    const data = await request("POST", "/api/designs", {
      name: name || `Ceramic design — ${new Date().toLocaleString()}`,
      config: JSON.stringify(config),
    });
    return data.design;
  }

  /** Lists the logged-in user's saved designs, newest first (50 unless `max` says otherwise). */
  async function listMyDesigns(max = 50) {
    if (!isLoggedIn()) return [];
    const data = await request("GET", `/api/designs?limit=${encodeURIComponent(max)}`);
    return data.designs || [];
  }

  /** Deletes one of the logged-in user's saved designs. */
  async function deleteDesign(id) {
    requireLoggedIn();
    await request("DELETE", `/api/designs/${encodeURIComponent(id)}`);
  }

  /** Account details for the dashboard's profile panel. */
  async function getProfile() {
    const data = await request("GET", "/api/auth/me");
    if (!data || !data.user) {
      clearAuth();
      const e = new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
      e.status = 401;
      throw e;
    }
    const u = data.user;
    setAuth({ user: toUser(u) });
    return {
      ...toUser(u),
      displayName: u.displayName || "",
      photoURL: u.photoURL || "",
      providers: u.providers && u.providers.length ? u.providers : ["password"],
      created_at: u.created_at || null,
    };
  }

  /** Changes the name shown on the dashboard and in the nav. */
  async function updateDisplayName(rawName) {
    const name = String(rawName || "").trim().slice(0, 60);
    if (!name) throw new Error("กรุณาใส่ชื่อที่ต้องการแสดง");
    const data = await request("PUT", "/api/auth/profile", { display_name: name });
    const user = toUser(data.user);
    setAuth({ user });
    return user;
  }

  window.MudMagicAPI = {
    getAuth,
    isLoggedIn,
    login,
    register,
    loginWithGoogle,
    registerOrLogin,
    logout,
    saveDesignAsProject,
    listMyDesigns,
    deleteDesign,
    getProfile,
    updateDisplayName,
    ready: serverReady,
  };

  // Reconcile the cached session in the background (e.g. signed out
  // elsewhere, or just back from Google sign-in). If the answer changes who
  // is signed in, refresh the nav.
  const before = isLoggedIn();
  serverReady()
    .then(() => {
      if (isLoggedIn() !== before) window.dispatchEvent(new CustomEvent("mudmagic:auth-changed"));
    })
    .catch(() => {});
})();
