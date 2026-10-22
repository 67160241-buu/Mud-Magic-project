// auth.js — accounts and login sessions, stored in D1.
//
//   POST /api/auth/signup            {email, password, display_name}
//   POST /api/auth/login             {email, password}
//   POST /api/auth/logout
//   GET  /api/auth/me                → {user} (user is null when signed out)
//   PUT  /api/auth/profile           {display_name}
//   GET  /api/auth/google?next=…     → redirect to Google
//   GET  /api/auth/google/callback   ← Google redirects back here
//
// A session is a random token in the mm_session cookie (HttpOnly, Secure,
// SameSite=Lax, 30 days). Only its SHA-256 is stored, in `sessions`, so a
// leaked database can't be replayed as cookies.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from "./crypto.js";

const SESSION_COOKIE = "mm_session";
const OAUTH_COOKIE = "mm_oauth";
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAD_LOGIN = "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/* ---------------- small helpers (shared with index.js) ---------------- */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function fail(status, detail) {
  return json({ detail }, status);
}

export async function readJson(request, maxBytes = 1_000_000) {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, { maxAge, path = "/" } = {}) {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const now = () => new Date().toISOString();

function publicUser(row) {
  const email = row.email || "";
  const name = row.display_name || email.split("@")[0] || "user";
  const providers = [];
  if (row.password_hash) providers.push("password");
  if (row.google_sub) providers.push("google.com");
  return {
    id: row.id,
    email,
    username: name,
    displayName: name,
    photoURL: row.photo_url || "",
    providers,
    created_at: row.created_at,
  };
}

/** Only same-site paths are allowed as a post-login destination. */
function safeNext(next, origin) {
  try {
    const raw = String(next || "").trim();
    if (!raw) return "/index.html";
    const url = new URL(raw.startsWith("/") ? raw : `/${raw}`, origin);
    if (url.origin !== origin || raw.startsWith("//") || raw.includes("\\")) return "/index.html";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/index.html";
  }
}

/* ---------------- sessions ---------------- */
async function startSession(env, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), userId, expires),
  ]);
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 });
}

const clearSession = () => cookie(SESSION_COOKIE, "", { maxAge: 0 });

/** The signed-in user's row for this request, or null. */
export async function getUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  return env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256(token), now())
    .first();
}

/* ---------------- email + password ---------------- */
function readCredentials(body) {
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  return { email, password };
}

async function signup(request, env) {
  const body = await readJson(request);
  const { email, password } = readCredentials(body);
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, "อีเมลไม่ถูกต้อง");
  if (password.length < 6) return fail(400, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร");
  if (password.length > 200) return fail(400, "รหัสผ่านยาวเกินไป");
  const name = (typeof body.display_name === "string" ? body.display_name.trim() : "").slice(0, 60) || email.split("@")[0];

  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return fail(409, "อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบแทน");

  const user = { id: crypto.randomUUID(), email, password_hash: await hashPassword(password), google_sub: null, display_name: name, photo_url: "", created_at: now() };
  try {
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.password_hash, user.display_name, user.created_at)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return fail(409, "อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบแทน");
    throw err;
  }
  return json({ user: publicUser(user) }, 201, { "set-cookie": await startSession(env, user.id) });
}

async function login(request, env) {
  const { email, password } = readCredentials(await readJson(request));
  if (!email || !password || password.length > 200) return fail(401, BAD_LOGIN);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || !user.password_hash) {
    await burnPasswordCheck(password); // same timing as a real check
    return fail(401, BAD_LOGIN);
  }
  if (!(await verifyPassword(password, user.password_hash))) return fail(401, BAD_LOGIN);
  return json({ user: publicUser(user) }, 200, { "set-cookie": await startSession(env, user.id) });
}

async function logout(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token && token.length <= 100) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSession() });
}

async function updateProfile(request, env) {
  const user = await getUser(request, env);
  if (!user) return fail(401, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  const body = await readJson(request);
  const name = (typeof body?.display_name === "string" ? body.display_name.trim() : "").slice(0, 60);
  if (!name) return fail(400, "กรุณาใส่ชื่อที่ต้องการแสดง");
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, user.id).run();
  return json({ user: publicUser({ ...user, display_name: name }) });
}

/* ---------------- Google sign-in (OAuth 2.0 code flow) ---------------- */
function googleStart(request, env) {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID || /^YOUR_/.test(env.GOOGLE_CLIENT_ID) || !env.GOOGLE_CLIENT_SECRET) {
    return Response.redirect(`${url.origin}/login.html?error=google_config`, 302);
  }
  const state = randomToken(24);
  const nonce = randomToken(24);
  const next = safeNext(url.searchParams.get("next"), url.origin);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  });
  const value = encodeURIComponent(JSON.stringify({ state, nonce, next }));
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), "set-cookie": cookie(OAUTH_COOKIE, value, { maxAge: 600, path: "/api/auth/google" }) },
  });
}

async function googleCallback(request, env) {
  const url = new URL(request.url);
  const clearOauth = cookie(OAUTH_COOKIE, "", { maxAge: 0, path: "/api/auth/google" });
  let saved = null;
  try {
    saved = JSON.parse(decodeURIComponent(parseCookies(request)[OAUTH_COOKIE] || ""));
  } catch {
    saved = null;
  }
  const next = safeNext(saved?.next, url.origin);
  const back = (code) =>
    new Response(null, {
      status: 302,
      headers: { location: `${url.origin}/login.html?error=${code}&next=${encodeURIComponent(next.replace(/^\//, ""))}`, "set-cookie": clearOauth },
    });

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return back("google_cancelled");
  if (!saved?.state || !state || state !== saved.state || !code) return back("google_state");

  let claims;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await res.json();
    if (!res.ok || !tokens.id_token) throw new Error(`token exchange failed (${res.status}): ${tokens.error || "no id_token"}`);
    ({ payload: claims } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.GOOGLE_CLIENT_ID,
    }));
    if (claims.nonce !== saved.nonce) throw new Error("nonce mismatch");
  } catch (err) {
    console.warn("Google sign-in failed:", err.message);
    return back("google_failed");
  }
  if (!claims.sub || !claims.email || claims.email_verified !== true) return back("google_unverified");

  const email = String(claims.email).toLowerCase();
  const photo = typeof claims.picture === "string" ? claims.picture : "";
  let user = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(claims.sub).first();
  if (!user) {
    user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (user) {
      if (user.google_sub) return back("google_failed"); // email already linked to another Google account
      // Signing up with a password never proved the email, so someone else
      // could have registered it first. Like Firebase, the verified Google
      // owner takes the account over: the password and old sessions go.
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET google_sub = ?, password_hash = NULL, photo_url = CASE WHEN photo_url = '' THEN ? ELSE photo_url END WHERE id = ?").bind(
          claims.sub,
          photo,
          user.id
        ),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      ]);
    } else {
      const name = (typeof claims.name === "string" && claims.name.trim()) || email.split("@")[0];
      user = { id: crypto.randomUUID() };
      await env.DB.prepare("INSERT INTO users (id, email, google_sub, display_name, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(user.id, email, claims.sub, name.slice(0, 60), photo, now())
        .run();
    }
  }

  const headers = new Headers({ location: `${url.origin}${next}` });
  headers.append("set-cookie", await startSession(env, user.id));
  headers.append("set-cookie", clearOauth);
  return new Response(null, { status: 302, headers });
}

/* ---------------- router ---------------- */
export async function handleAuth(request, env, path) {
  const method = request.method;
  if (path === "/api/auth/signup" && method === "POST") return signup(request, env);
  if (path === "/api/auth/login" && method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && method === "POST") return logout(request, env);
  if (path === "/api/auth/me" && method === "GET") {
    const user = await getUser(request, env);
    return json({ user: user ? publicUser(user) : null });
  }
  if (path === "/api/auth/profile" && method === "PUT") return updateProfile(request, env);
  if (path === "/api/auth/google" && method === "GET") return googleStart(request, env);
  if (path === "/api/auth/google/callback" && method === "GET") return googleCallback(request, env);
  return fail(404, "Not found");
}
