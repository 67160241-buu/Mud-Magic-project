// crypto.js — password hashing and tokens with Web Crypto (no Node APIs).
//
// Passwords: PBKDF2-SHA256, random 16-byte salt, stored as
//   pbkdf2$<iterations>$<salt base64url>$<hash base64url>
// Workers caps PBKDF2 at 100,000 iterations, so that is what we use. The
// iteration count is stored with each hash so it can be raised later.

const ITERATIONS = 100000;
const HASH_BYTES = 32;
const enc = new TextEncoder();

export function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  const expected = fromB64url(parts[3]);
  const actual = await pbkdf2(password, fromB64url(parts[2]), iterations);
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

// A dummy hash so a login for an unknown email costs the same time as a real one.
let dummyHash = null;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword("mud-magic-dummy-password");
  await verifyPassword(password, dummyHash);
}

/** Random URL-safe token (32 bytes → 43 chars). */
export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a string, as lowercase hex. */
export async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
