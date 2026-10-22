// Mud Magic Worker: routes /api/auth/* (accounts), /api/designs (saved
// designs in D1), /ai/* (OpenAI helpers) and serves everything else from
// ./web through the ASSETS binding.

import { handleAI } from "./ai.js";
import { fail, getUser, handleAuth, json, readJson } from "./auth.js";

const MAX_CONFIG_CHARS = 500_000; // same limit firestore.rules had
const MAX_NAME_CHARS = 150;

/** Cross-site writes are refused: SameSite=Lax plus an Origin check. */
function crossSite(request, url) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return true;
  return request.headers.get("sec-fetch-site") === "cross-site";
}

function toDesign(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.config, // the design config as a JSON string, as before
    owner_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readDesignBody(body, { partial = false } = {}) {
  if (!body) return { error: "ข้อมูลไม่ถูกต้อง" };
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name && !partial) out.name = `Ceramic design — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    else if (!name || name.length > MAX_NAME_CHARS) return { error: `ชื่อแบบต้องยาว 1-${MAX_NAME_CHARS} ตัวอักษร` };
    else out.name = name;
  }
  if (body.config !== undefined || !partial) {
    const config = typeof body.config === "string" ? body.config : JSON.stringify(body.config ?? null);
    try {
      JSON.parse(config);
    } catch {
      return { error: "ข้อมูลแบบไม่ถูกต้อง" };
    }
    if (config.length > MAX_CONFIG_CHARS) return { error: "แบบนี้ใหญ่เกินกว่าจะบันทึกได้" };
    out.config = config;
  }
  return out;
}

async function handleDesigns(request, env, path) {
  const user = await getUser(request, env);
  if (!user) return fail(401, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  const method = request.method;
  const id = path === "/api/designs" ? null : decodeURIComponent(path.slice("/api/designs/".length));
  if (id !== null && (!id || id.includes("/") || id.length > 100)) return fail(404, "ไม่พบแบบนี้");

  if (id === null && method === "GET") {
    const limit = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("limit"), 10) || 50, 1), 200);
    const { results } = await env.DB.prepare("SELECT * FROM designs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(user.id, limit).all();
    return json({ designs: results.map(toDesign) });
  }

  if (id === null && method === "POST") {
    const body = readDesignBody(await readJson(request, MAX_CONFIG_CHARS + 10_000));
    if (body.error) return fail(400, body.error);
    const t = new Date().toISOString();
    const row = { id: crypto.randomUUID(), user_id: user.id, name: body.name, config: body.config, created_at: t, updated_at: t };
    await env.DB.prepare("INSERT INTO designs (id, user_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.user_id, row.name, row.config, row.created_at, row.updated_at)
      .run();
    return json({ design: toDesign(row) }, 201);
  }

  if (id !== null && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM designs WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    return row ? json({ design: toDesign(row) }) : fail(404, "ไม่พบแบบนี้");
  }

  if (id !== null && method === "PUT") {
    const body = readDesignBody(await readJson(request, MAX_CONFIG_CHARS + 10_000), { partial: true });
    if (body.error) return fail(400, body.error);
    const row = await env.DB.prepare(
      `UPDATE designs SET name = COALESCE(?, name), config = COALESCE(?, config), updated_at = ?
       WHERE id = ? AND user_id = ? RETURNING *`
    )
      .bind(body.name ?? null, body.config ?? null, new Date().toISOString(), id, user.id)
      .first();
    return row ? json({ design: toDesign(row) }) : fail(404, "ไม่พบแบบนี้");
  }

  if (id !== null && method === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM designs WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    return res.meta.changes ? json({ ok: true }) : fail(404, "ไม่พบแบบนี้");
  }

  return fail(405, "Method not allowed");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path === "/api" || path.startsWith("/api/");
    const isAI = path === "/ai" || path.startsWith("/ai/");

    if (isApi || isAI) {
      if (crossSite(request, url)) return fail(403, "Cross-site request refused");
      try {
        if (path.startsWith("/api/auth/")) return await handleAuth(request, env, path);
        if (path === "/api/designs" || path.startsWith("/api/designs/")) return await handleDesigns(request, env, path);
        if (isAI) return await handleAI(request, env, path);
        return fail(404, "Not found");
      } catch (err) {
        console.error(`${request.method} ${path} failed:`, err && err.stack ? err.stack : err);
        return fail(500, "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ ลองใหม่อีกครั้ง");
      }
    }

    // html_handling is "none" (so /login.html stays /login.html), which means
    // directory URLs like "/" need their index.html spelled out.
    if (path.endsWith("/")) {
      const indexUrl = new URL(url);
      indexUrl.pathname = `${path}index.html`;
      const res = await env.ASSETS.fetch(new Request(indexUrl, request));
      if (res.status !== 404) return res;
    }
    return env.ASSETS.fetch(request);
  },
};
