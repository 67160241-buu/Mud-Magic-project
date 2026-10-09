// api-client.js — connects Mud Magic accounts and saved designs to Firebase
// (Firebase Authentication + Cloud Firestore). The AI endpoint still lives in
// the FastAPI backend (see ai-design.js); nothing here talks to it.
//
// The public surface is unchanged from the old Postgres client, so the pages
// that use window.MudMagicAPI (login, studio, create, nav) need no edits:
//   getAuth(), isLoggedIn(), registerOrLogin(email, password), logout(),
//   saveDesignAsProject(config, name), listMyDesigns()
//
// Auth model: the login form only collects an email + password, so one form
// acts as both sign-in and sign-up:
//   1. try signInWithEmailAndPassword;
//   2. if that fails with "invalid credential" the account either doesn't
//      exist yet or the password is wrong — try createUserWithEmailAndPassword;
//   3. "email-already-in-use" at that point means the password was wrong.
// Firebase keeps the session and refreshes tokens itself. isLoggedIn() must
// stay synchronous for the existing callers, so the signed-in user is cached
// in localStorage and reconciled with Firebase's auth state on every load.
//
// Firebase project settings come from js/firebase-config.js.
(function () {
  "use strict";

  const SDK_VERSION = "10.14.1";
  const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
  const AUTH_KEY = "mudmagic_firebase_auth";
  const DESIGNS = "designs";

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
      /* storage disabled — session simply won't show until Firebase loads */
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

  function toUser(fbUser) {
    const email = fbUser.email || "";
    return {
      id: fbUser.uid,
      email,
      username: fbUser.displayName || email.split("@")[0] || "user",
    };
  }

  /* ---------- lazy Firebase SDK loading ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`โหลด ${src} ไม่สำเร็จ`));
      document.head.appendChild(el);
    });
  }

  function scriptDir() {
    const me = document.currentScript && document.currentScript.src;
    return me ? me.slice(0, me.lastIndexOf("/") + 1) : "js/";
  }
  const DIR = scriptDir();

  let ready = null;
  function firebaseReady() {
    if (ready) return ready;
    ready = (async () => {
      if (!window.MUDMAGIC_FIREBASE_CONFIG) await loadScript(`${DIR}firebase-config.js`);
      const config = window.MUDMAGIC_FIREBASE_CONFIG;
      if (!config || !config.apiKey || /^YOUR_/.test(config.apiKey)) {
        throw new Error("ยังไม่ได้ตั้งค่า Firebase — ใส่ค่าใน web/js/firebase-config.js");
      }
      if (!window.firebase) await loadScript(`${SDK_BASE}/firebase-app-compat.js`);
      await Promise.all([
        window.firebase.auth ? null : loadScript(`${SDK_BASE}/firebase-auth-compat.js`),
        window.firebase.firestore ? null : loadScript(`${SDK_BASE}/firebase-firestore-compat.js`),
      ]);
      const app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp(config);
      const auth = app.auth();
      const db = app.firestore();

      // Resolves once Firebase has restored (or not) the previous session.
      await new Promise((resolve) => {
        let first = true;
        auth.onAuthStateChanged((fbUser) => {
          if (fbUser) setAuth({ user: toUser(fbUser) });
          else clearAuth();
          if (first) {
            first = false;
            resolve();
          }
        });
      });
      return { auth, db, FieldValue: window.firebase.firestore.FieldValue };
    })();
    ready.catch(() => {
      ready = null; // allow a retry after e.g. a network failure
    });
    return ready;
  }

  /* ---------- errors → the Thai messages the pages already show ---------- */
  function friendly(err) {
    const code = err && err.code;
    const messages = {
      "auth/network-request-failed": "เชื่อมต่อ Firebase ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
      "auth/too-many-requests": "ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่",
      "auth/user-disabled": "บัญชีนี้ถูกระงับการใช้งาน",
      "auth/invalid-email": "อีเมลไม่ถูกต้อง",
      "auth/weak-password": "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร",
      "auth/operation-not-allowed": "ยังไม่ได้เปิดวิธีเข้าสู่ระบบนี้ใน Firebase Console (Authentication → Sign-in method)",
      "auth/popup-blocked": "เบราว์เซอร์บล็อกหน้าต่าง Google ให้อนุญาตป๊อปอัปแล้วลองใหม่",
      "auth/unauthorized-domain": "โดเมนนี้ยังไม่ได้รับอนุญาต เพิ่มใน Firebase Console → Authentication → Settings → Authorized domains",
      "permission-denied": "ไม่มีสิทธิ์บันทึกข้อมูลนี้",
      unavailable: "เชื่อมต่อ Firebase ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
    };
    if (code && messages[code]) {
      const e = new Error(messages[code]);
      e.code = code;
      return e;
    }
    return err;
  }

  const BAD_LOGIN = new Set(["auth/invalid-credential", "auth/invalid-login-credentials", "auth/user-not-found", "auth/wrong-password"]);

  /** Sign in to an existing account; returns the user. */
  async function login(rawEmail, password) {
    const { auth } = await firebaseReady();
    const email = rawEmail.trim().toLowerCase();
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      const user = toUser(cred.user);
      setAuth({ user });
      return user;
    } catch (err) {
      if (BAD_LOGIN.has(err.code)) {
        const wrong = new Error("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
        wrong.status = 401;
        throw wrong;
      }
      throw friendly(err);
    }
  }

  /** Create a new account (displayName defaults to the email's local part). */
  async function register(rawEmail, password, displayName) {
    const { auth } = await firebaseReady();
    const email = rawEmail.trim().toLowerCase();
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const name = (displayName || "").trim() || email.split("@")[0];
      await cred.user.updateProfile({ displayName: name });
      const user = toUser(cred.user);
      setAuth({ user });
      return user;
    } catch (err) {
      if (err.code === "auth/email-already-in-use") {
        const taken = new Error("อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบแทน");
        taken.status = 409;
        throw taken;
      }
      throw friendly(err);
    }
  }

  /** Sign in with a Google account (creates it on first use); null if the popup was closed. */
  async function loginWithGoogle() {
    const { auth } = await firebaseReady();
    try {
      const cred = await auth.signInWithPopup(new window.firebase.auth.GoogleAuthProvider());
      const user = toUser(cred.user);
      setAuth({ user });
      return user;
    } catch (err) {
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return null;
      throw friendly(err);
    }
  }

  /** Sign in, or create the account on first use; returns the user. */
  async function registerOrLogin(rawEmail, password) {
    const { auth } = await firebaseReady();
    const email = rawEmail.trim().toLowerCase();
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      const user = toUser(cred.user);
      setAuth({ user });
      return user;
    } catch (err) {
      if (!BAD_LOGIN.has(err.code)) throw friendly(err);
    }

    // Either no account yet or a wrong password — try to sign up.
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: email.split("@")[0] });
      const user = toUser(cred.user);
      setAuth({ user });
      return user;
    } catch (err) {
      if (err.code === "auth/email-already-in-use") {
        const wrong = new Error("รหัสผ่านไม่ถูกต้อง");
        wrong.status = 401;
        throw wrong; // the account exists, so the password was wrong
      }
      throw friendly(err);
    }
  }

  function logout() {
    clearAuth();
    firebaseReady()
      .then(({ auth }) => auth.signOut())
      .catch(() => {});
  }

  function requireUser(auth) {
    const fbUser = auth.currentUser;
    if (!fbUser) {
      clearAuth();
      const e = new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
      e.status = 401;
      throw e;
    }
    return fbUser;
  }

  function toDesign(doc) {
    const d = doc.data();
    return {
      id: doc.id,
      name: d.name,
      description: d.description,
      owner_id: d.ownerId,
      created_at: d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().toISOString() : null,
    };
  }

  /** Saves a design to Firestore, owned by the logged-in user. */
  async function saveDesignAsProject(config, name) {
    const { auth, db, FieldValue } = await firebaseReady();
    const fbUser = requireUser(auth);
    try {
      const ref = await db.collection(DESIGNS).add({
        ownerId: fbUser.uid,
        name: name || `Ceramic design — ${new Date().toLocaleString()}`,
        // Stored as a JSON string: Firestore can't hold nested arrays, and the
        // pot profile (lab.nodes) uses them.
        description: JSON.stringify(config),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return toDesign(await ref.get());
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Lists the logged-in user's saved designs, newest first (50 unless `max` says otherwise). */
  async function listMyDesigns(max = 50) {
    if (!isLoggedIn()) return [];
    const { auth, db } = await firebaseReady();
    if (!auth.currentUser) return [];
    try {
      // Sorted here rather than with orderBy so no composite index is needed.
      const snap = await db.collection(DESIGNS).where("ownerId", "==", auth.currentUser.uid).limit(200).get();
      return snap.docs
        .map(toDesign)
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, max);
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Deletes one of the logged-in user's saved designs. */
  async function deleteDesign(id) {
    const { auth, db } = await firebaseReady();
    requireUser(auth);
    try {
      await db.collection(DESIGNS).doc(id).delete();
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Account details for the dashboard's profile panel. */
  async function getProfile() {
    const { auth } = await firebaseReady();
    const fbUser = requireUser(auth);
    const providers = (fbUser.providerData || []).map((p) => p && p.providerId).filter(Boolean);
    const created = fbUser.metadata && fbUser.metadata.creationTime;
    return {
      ...toUser(fbUser),
      displayName: fbUser.displayName || "",
      photoURL: fbUser.photoURL || "",
      providers: providers.length ? providers : ["password"],
      created_at: created ? new Date(created).toISOString() : null,
    };
  }

  /** Changes the name shown on the dashboard and in the nav. */
  async function updateDisplayName(rawName) {
    const name = String(rawName || "").trim().slice(0, 60);
    if (!name) throw new Error("กรุณาใส่ชื่อที่ต้องการแสดง");
    const { auth } = await firebaseReady();
    const fbUser = requireUser(auth);
    try {
      await fbUser.updateProfile({ displayName: name });
    } catch (err) {
      throw friendly(err);
    }
    const user = { ...toUser(fbUser), username: name };
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
    ready: firebaseReady,
  };

  // Start loading in the background so the cached session gets reconciled
  // (e.g. signed out elsewhere) and the first save/login is fast.
  if (isLoggedIn() || /(login|dashboard)\.html$/.test(location.pathname)) {
    firebaseReady().catch(() => {});
  }
})();
