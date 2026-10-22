// ai.js — AI design suggestions (port of api/app/routers/ai.py).
//
// Turns a free-text idea ("แจกันลายดอกไม้มินิมอล") into concrete, buildable
// configs that the Three.js front end can render directly.
//
// - The OpenAI key lives ONLY here, as the OPENAI_API_KEY secret. The browser
//   never sees it; it calls these endpoints instead.
// - The model's output is NEVER trusted as-is: every field is validated
//   against the same enums the renderer supports, and anything invalid falls
//   back to a safe default.
// - With no key, or when OpenAI errors/times out, the endpoint returns 503/502
//   with {detail} and the front end falls back to its offline generator.

import { fail, json, readJson } from "./auth.js";

const TIMEOUT_MS = 60_000;

// --- What the renderer can actually build -----------------------------
// These must stay in sync with web/js/mug-model.js and web/js/wave.js.
const SHAPES = ["classic", "round", "tall", "wide"];
const HANDLES = ["minimal", "loop", "organic"];
const SURFACES = ["smooth", "matte", "rough"];
const PATTERNS = ["none", "flutes", "reeds", "facets", "rings", "twist", "wobble"];
const GLAZES = {
  terracotta: "#A65D45",
  sage: "#7C8872",
  cream: "#F3E9DD",
  espresso: "#3B2A20",
  blush: "#E3A896",
  charcoal: "#2B2B2B",
  ivory: "#FBF6EF",
  denim: "#4C5A66",
};
const SKILL_LEVELS = ["beginner", "intermediate", "advanced"];

const SYSTEM_PROMPT = `You are a ceramics design assistant for a 3D pottery web app.

The app can only render mugs from this fixed parameter set. You MUST choose
values from these lists exactly — never invent new ones:

shape: classic | round | tall | wide
handle: minimal | loop | organic
surface: smooth | matte | rough
glaze: terracotta | sage | cream | espresso | blush | charcoal | ivory | denim
pattern: none | flutes | reeds | facets | rings | twist | wobble
  - none   = smooth walls
  - flutes = vertical carved grooves
  - reeds  = vertical raised ribs
  - facets = angular flat panels
  - rings  = horizontal throwing rings
  - twist  = spiralling ribs
  - wobble = irregular wavy walls
pattern_count: integer 3-24 (how many grooves/ribs/rings; ignored if pattern is none)
pattern_depth: number 0.005-0.09 (how pronounced; ignored if pattern is none)
pattern_twist: number 0-1.2 (spiral amount; 0 for straight)

Difficulty guidance, if a skill level is given:
- beginner: prefer classic/wide shape, minimal/loop handle, rough/matte
  surface, pattern none/rings/reeds, shallow depth (<=0.03), twist 0.
- intermediate: any shape except very tall, any handle except organic,
  moderate patterns.
- advanced: anything, including organic handles, tall shapes, twist.

Reply with ONLY a JSON object, no prose, in exactly this form:
{"designs":[{"name":"...","rationale":"...","config":{"shape":"...","handle":"...","surface":"...","glaze":"...","pattern":"...","pattern_count":12,"pattern_depth":0.03,"pattern_twist":0}}]}

"name" is a short evocative title. "rationale" is ONE short sentence saying
why this suits the request (and the skill level, if given). Write both in
the SAME LANGUAGE as the user's prompt — if the prompt is Thai, reply in Thai.
Make the designs meaningfully different from each other, not minor variations.`;

/* ---------------- Python-compatible helpers ---------------- */
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
/** str(x)[:n], counting characters like Python does. */
const cut = (text, n) => Array.from(String(text)).slice(0, n).join("");
const roundTo = (x, digits) => Number(x.toFixed(digits));

/** Python float(): numbers, bools and numeric strings; anything else → null. */
function toFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string") {
    const s = value.trim().replace(/_/g, "");
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  }
  return null;
}

/** Whitelist a model-supplied string; fall back if it invented something. */
function pick(value, allowed, fallback) {
  if (typeof value === "string" && allowed.includes(value.trim().toLowerCase())) return value.trim().toLowerCase();
  return fallback;
}

function clamp(value, low, high, fallback) {
  const v = toFloat(value);
  return v === null ? fallback : Math.max(low, Math.min(high, v));
}

function validateDesign(raw, index) {
  const cfg = isDict(raw.config) ? raw.config : {};
  const glaze = pick(cfg.glaze, Object.keys(GLAZES), "terracotta");
  const pattern = pick(cfg.pattern, PATTERNS, "none");
  return {
    name: cut(raw.name || `Design ${index + 1}`, 80),
    rationale: cut(raw.rationale || "", 300),
    config: {
      shape: pick(cfg.shape, SHAPES, "classic"),
      handle: pick(cfg.handle, HANDLES, "loop"),
      surface: pick(cfg.surface, SURFACES, "matte"),
      color: GLAZES[glaze],
      glaze,
      pattern,
      pattern_count: Math.trunc(clamp(cfg.pattern_count, 3, 24, 12)),
      pattern_depth: roundTo(clamp(cfg.pattern_depth, 0.005, 0.09, 0.03), 4),
      pattern_twist: roundTo(clamp(cfg.pattern_twist, 0, 1.2, 0), 3),
    },
  };
}

// --- Crude per-IP rate limit ------------------------------------------
// These endpoints spend real money per call and allow anonymous access, so a
// script could run up the bill. In-memory per Worker isolate, so it's only a
// speed bump (each isolate keeps its own count) — same spirit as the old API.
const HITS = new Map();
const WINDOW_SECONDS = 60;
const MAX_PER_WINDOW = 10;

function rateLimit(request) {
  const client = request.headers.get("cf-connecting-ip") || "unknown";
  const t = Date.now() / 1000;
  const hits = (HITS.get(client) || []).filter((h) => t - h < WINDOW_SECONDS);
  if (hits.length >= MAX_PER_WINDOW) {
    const left = Math.trunc(WINDOW_SECONDS - (t - hits[0]));
    return fail(429, `Too many AI requests. Try again in ${left}s.`);
  }
  hits.push(t);
  HITS.set(client, hits);
  if (HITS.size > 5000) HITS.clear(); // keep memory bounded
  return null;
}

/* ---------------- OpenAI ---------------- */
class AIError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

const STATUS_ERRORS = { 400: "BadRequestError", 401: "AuthenticationError", 403: "PermissionDeniedError", 404: "NotFoundError", 422: "UnprocessableEntityError", 429: "RateLimitError" };

/** One chat completion in JSON mode; returns the parsed reply (throws on any failure). */
async function chatJSON(env, messages, extra = {}) {
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: model(env), response_format: { type: "json_object" }, ...extra, messages }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AIError(err.name === "TimeoutError" ? "APITimeoutError" : "APIConnectionError", err.message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AIError(STATUS_ERRORS[res.status] || (res.status >= 500 ? "InternalServerError" : "APIStatusError"), `${res.status} ${body.slice(0, 500)}`);
  }
  const completion = await res.json();
  const content = completion?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new AIError("JSONDecodeError", err.message);
  }
}

const model = (env) => env.OPENAI_MODEL || "gpt-4o-mini";
const noKey = () => fail(503, "OPENAI_API_KEY is not configured on the server.");

function aiFailed(err) {
  if (err.name === "JSONDecodeError") return fail(502, "The AI returned malformed JSON.");
  // OpenAI's own message says why (bad key, no credit, unknown model); it goes
  // to the Worker logs, never to the browser.
  console.warn(`OpenAI call failed: ${err.name}: ${err.message}`);
  return fail(502, `AI request failed: ${err.name}`);
}

/** Request-body checks standing in for the old pydantic models (422 like FastAPI). */
function badRequest(detail) {
  return fail(422, detail);
}

function optionalString(value) {
  return value === undefined || value === null || typeof value === "string";
}

function countIn(value, fallback, low, high) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= low && value <= high ? value : null;
}

/* ---------------- /ai/status, /ai/suggest-designs ---------------- */
function status(env) {
  return json({ enabled: !!env.OPENAI_API_KEY, model: model(env) });
}

async function suggestDesigns(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest("Invalid JSON body.");
  if (typeof body.prompt !== "string" || body.prompt.length < 1 || body.prompt.length > 500) return badRequest("prompt must be 1-500 characters.");
  if (!optionalString(body.skill_level)) return badRequest("skill_level must be a string.");
  const count = countIn(body.count, 4, 1, 6);
  if (count === null) return badRequest("count must be an integer 1-6.");

  if (!env.OPENAI_API_KEY) return noKey();
  const limited = rateLimit(request);
  if (limited) return limited;

  const skill = SKILL_LEVELS.includes(body.skill_level) ? body.skill_level : null;
  let userMsg = `Idea: ${body.prompt}\nNumber of designs: ${count}`;
  if (skill) userMsg += `\nSkill level: ${skill}`;

  // GPT-5 and o-series reasoning models only accept the default temperature,
  // so the variety boost is sent to older models only.
  const extra = {};
  if (!model(env).startsWith("gpt-5") && !model(env).startsWith("o")) extra.temperature = 0.9;

  let data;
  try {
    data = await chatJSON(
      env,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      extra
    );
  } catch (err) {
    return aiFailed(err);
  }

  const rawDesigns = isDict(data) ? data.designs : null;
  if (!Array.isArray(rawDesigns) || !rawDesigns.length) return fail(502, "The AI returned no usable designs.");
  const designs = rawDesigns
    .slice(0, count)
    .map((d, i) => (isDict(d) ? validateDesign(d, i) : null))
    .filter(Boolean);
  if (!designs.length) return fail(502, "The AI returned no usable designs.");
  return json({ designs, source: "openai" });
}

// --- Studio command box -------------------------------------------------
// "ทำคอให้สูงขึ้น" → a small patch on the Studio's vessel config. Same rule as
// above: the model only proposes; every field is whitelisted and clamped here,
// and the browser clamps again with normalizeConfig().
// These must stay in sync with web/js/vessels.js.
const VESSEL_RANGES = {
  vase: { height: [12, 45], belly: [8, 30], wall: [0.4, 1.5] },
  bowl: { height: [5, 16], belly: [10, 32], wall: [0.4, 1.5] },
  pitcher: { height: [12, 30], belly: [9, 20], wall: [0.4, 1.2] },
  plate: { height: [2, 5], belly: [18, 36], wall: [0.5, 1.2] },
  mug: { height: [7, 16], belly: [6, 12], wall: [0.4, 1.0] },
  sculpture: { height: [12, 45], belly: [8, 26], wall: [0.5, 1.5] },
};
const STUDIO_ENUMS = {
  neck: ["clean", "asym", "fluted", "flared"],
  foot: ["flat", "trimmed", "pedestal"],
  handle: ["none", "ear", "loop", "lug"],
  clay: ["sand", "cream", "terra", "charcoal"],
  texture: ["thrown", "pinch"],
  surface: SURFACES,
};
const COLOR_PATTERNS = ["none", "stripes", "rings", "petals"];
const OUTLINES = ["round", "heart", "star", "flower", "cloud", "clover", "teardrop", "leaf", "squircle"];
const LAB_RANGES = {
  twist: [-3, 3], aspect: [0.4, 2], polySides: [0, 24], polyRound: [-1, 1],
  polyBulge: [0, 0.95], bends: [0, 12], bendDepth: [0, 0.5], bendPoles: [0, 12],
  helixFreq: [0, 6], helixAmp: [0, 1], colorCycles: [1, 24], colorSharp: [0, 1],
};

function hex(value) {
  if (typeof value === "string") {
    const v = value.trim();
    if (has(GLAZES, v.toLowerCase())) return GLAZES[v.toLowerCase()];
    if (v === "raw" || /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  }
  return null;
}

const FIELDS_DOC = `Editable fields (use these exact names and values):
vessel: vase | bowl | pitcher | plate | mug | sculpture  (only if the user asks for a different kind of pot)
height, belly (widest diameter), wall (thickness): centimetres. Allowed ranges per vessel:
  vase h12-45 b8-30 w0.4-1.5 | bowl h5-16 b10-32 | pitcher h12-30 b9-20 | plate h2-5 b18-36 | mug h7-16 b6-12 | sculpture h12-45 b8-26
neck: clean | asym (wonky lip) | fluted | flared
foot: flat | trimmed | pedestal
handle: none | ear | loop | lug
clay: sand | cream | terra | charcoal
texture: thrown (wheel) | pinch (hand-built)
surface: smooth (glossy) | matte | rough
color: "#RRGGBB" glaze colour, or "raw" for unglazed
pattern: none | flutes | reeds | facets | rings | twist | wobble  (carved surface pattern)
lab (advanced shaping, include only keys you change):
  outline round|heart|star|flower|cloud|clover|teardrop|leaf|squircle: the cross-section seen from
    above (squircle = rounded square). Use it whenever the idea names such a shape,
    and feel free to use it for playful or unusual pieces,
  twist -3..3 (turns of spiral), aspect 0.4..2 (oval squash), polySides 0 or 3..24 (polygon cross-section),
  polyRound -1..1, polyBulge 0..0.95, bends 0..12 (wavy lean), bendDepth 0..0.5,
  helixFreq 0..6, helixAmp 0..1, colorPattern none|stripes|rings|petals,
  accent "#RRGGBB" (second colour for colorPattern), colorCycles 1..24, colorSharp 0..1
profile: the outer wall silhouette as [r, y] points from base (y=0) to rim (y=1);
  r is radius relative to the widest point (widest = 1.0). Use it for neck, shoulder,
  belly, waist or rim shape changes ("taller neck", "narrower top", "rounder belly").
  Return the FULL new list, 4-12 points, y strictly increasing from 0 to 1. For plates
  and bowls r should only grow from base to rim (no inward steps), or the piece
  looks like a ring stacked on a disc. Start from the
  current profile and move only the points that matter.

`;

const EDIT_PROMPT =
  `You edit a pottery design in a 3D studio. The user gives a command
(often in Thai) and the current design. Change ONLY what the command asks for.

` +
  FIELDS_DOC +
  `"Bigger/smaller" steps are about 15-25% unless the user gives numbers.

Reply with ONLY JSON: {"changes": {...only changed fields...}, "message": "..."}
"message" is one short friendly sentence in the user's language saying what you changed.
If the command cannot be done with these fields, return {"changes": {}, "message": "<explain briefly>"}.`;

function validateEdit(raw, current) {
  const ch = isDict(raw.changes) ? raw.changes : {};
  const patch = {};

  const vessel = ch.vessel;
  if (has(VESSEL_RANGES, vessel) && vessel !== current.vessel) patch.vessel = vessel;
  const target = patch.vessel || (has(VESSEL_RANGES, current.vessel) ? current.vessel : "vase");
  for (const [key, [low, high]] of Object.entries(VESSEL_RANGES[target])) {
    if (key in ch) {
      const value = clamp(ch[key], low, high, null);
      if (value !== null) patch[key] = roundTo(value, 2);
    }
  }

  for (const [key, allowed] of Object.entries(STUDIO_ENUMS)) {
    if (typeof ch[key] === "string" && allowed.includes(ch[key].trim().toLowerCase())) patch[key] = ch[key].trim().toLowerCase();
  }
  const color = hex(ch.color);
  if (color) patch.color = color;

  const lab = {};
  const labIn = isDict(ch.lab) ? ch.lab : {};
  for (const [key, [low, high]] of Object.entries(LAB_RANGES)) {
    if (key in labIn) {
      const value = clamp(labIn[key], low, high, null);
      if (value !== null) lab[key] = ["polySides", "bends", "bendPoles"].includes(key) ? Math.round(value) : roundTo(value, 3);
    }
  }
  if (OUTLINES.includes(labIn.outline)) lab.outline = labIn.outline;
  if (COLOR_PATTERNS.includes(labIn.colorPattern)) lab.colorPattern = labIn.colorPattern;
  const accent = hex(labIn.accent);
  if (accent && accent !== "raw") lab.accent = accent;

  const profile = ch.profile;
  if (Array.isArray(profile) && profile.length >= 2 && profile.length <= 16) {
    const points = [];
    for (const p of profile) {
      if (Array.isArray(p) && p.length === 2) {
        const r = clamp(p[0], 0.02, 3, null);
        const y = clamp(p[1], 0, 1, null);
        if (r !== null && y !== null) points.push([roundTo(r, 3), roundTo(y, 3)]);
      }
    }
    points.sort((a, b) => a[1] - b[1]);
    if (points.length >= 2) lab.nodes = points;
  }
  if (Object.keys(lab).length) patch.lab = lab;

  const pattern = PATTERNS.includes(ch.pattern) ? ch.pattern : null;
  const message = cut(raw.message || "", 200);
  return { patch, pattern, message };
}

function validProfile(profile) {
  return (
    profile === undefined ||
    profile === null ||
    (Array.isArray(profile) && profile.every((p) => Array.isArray(p) && p.every((n) => typeof n === "number" && Number.isFinite(n))))
  );
}

async function editDesign(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest("Invalid JSON body.");
  if (typeof body.command !== "string" || body.command.length < 1 || body.command.length > 300) return badRequest("command must be 1-300 characters.");
  if (!isDict(body.config)) return badRequest("config must be an object.");
  if (!validProfile(body.profile)) return badRequest("profile must be a list of [r, y] numbers.");

  if (!env.OPENAI_API_KEY) return noKey();
  const limited = rateLimit(request);
  if (limited) return limited;

  const { modulation, ...current } = body.config; // eslint-disable-line no-unused-vars
  const userMsg = JSON.stringify({ command: body.command, current, profile: body.profile ?? null });
  let data;
  try {
    data = await chatJSON(env, [
      { role: "system", content: EDIT_PROMPT },
      { role: "user", content: userMsg },
    ]);
  } catch (err) {
    return aiFailed(err);
  }
  if (!isDict(data)) return fail(502, "The AI returned no usable changes.");
  return json(validateEdit(data, body.config));
}

// --- Whole-vessel suggestions ----------------------------------------------
// The older /suggest-designs only knows mug colours and patterns, so the shape
// came from the offline keyword matcher. This one lets the model pick the
// vessel, proportions and silhouette too, validated by validateEdit().
const VESSEL_PROMPT =
  `You design handmade ceramics for a 3D pottery web app. Turn the user's
idea (often Thai) into distinct designs the app can build from these fields:

` +
  FIELDS_DOC +
  `
Always set vessel, height, belly, neck, foot, handle, clay, texture, surface, color
and a profile for every design, so each one has its own silhouette. Use lab and
pattern when they help express the idea (e.g. heart/star/flower/cloud/leaf/teardrop ideas -> lab.outline; a hexagon -> polySides; an oval or squashed form -> aspect; a twisted vase -> twist).
Shapes the app cannot make exactly (animals, letters, faces) should be
approximated with the closest form, and the rationale should say so honestly.

Skill level, if given: beginner -> simple profiles, no lab effects, wall >= 0.6,
handle none or loop; intermediate -> moderate; advanced -> anything.

Reply with ONLY JSON:
{"designs":[{"name":"...","rationale":"...","changes":{...fields...}}]}
"name" is a short evocative title, "rationale" one short sentence, both in the
SAME language as the user's idea. Make the designs clearly different from each other.`;

async function suggestVessels(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest("Invalid JSON body.");
  if (typeof body.prompt !== "string" || body.prompt.length < 1 || body.prompt.length > 500) return badRequest("prompt must be 1-500 characters.");
  if (!optionalString(body.skill_level) || !optionalString(body.vessel)) return badRequest("skill_level and vessel must be strings.");
  const requested = countIn(body.count, 4, 1, 12); // the Create page asks for a pool of 8
  if (requested === null) return badRequest("count must be an integer 1-12.");

  if (!env.OPENAI_API_KEY) return noKey();
  const limited = rateLimit(request);
  if (limited) return limited;

  const count = Math.min(requested, 6); // more than 6 gets slow; the page pads the rest
  let userMsg = `Idea: ${body.prompt}\nNumber of designs: ${count}`;
  if (SKILL_LEVELS.includes(body.skill_level)) userMsg += `\nSkill level: ${body.skill_level}`;
  if (has(VESSEL_RANGES, body.vessel)) userMsg += `\nIf the idea names no vessel type, use: ${body.vessel}`;

  let data;
  try {
    data = await chatJSON(env, [
      { role: "system", content: VESSEL_PROMPT },
      { role: "user", content: userMsg },
    ]);
  } catch (err) {
    return aiFailed(err);
  }

  const raw = isDict(data) ? data.designs : null;
  const designs = [];
  (Array.isArray(raw) ? raw.slice(0, count) : []).forEach((d, i) => {
    if (!isDict(d)) return;
    const fallbackVessel = has(VESSEL_RANGES, body.vessel) ? body.vessel : "vase";
    const changes = isDict(d.changes) ? d.changes : {};
    const edit = validateEdit(d, changes.vessel ? { vessel: "__none__" } : { vessel: fallbackVessel });
    if (!("vessel" in edit.patch)) edit.patch.vessel = fallbackVessel;
    designs.push({
      name: cut(d.name || `Design ${i + 1}`, 80),
      rationale: cut(d.rationale || "", 300),
      patch: edit.patch,
      pattern: edit.pattern,
    });
  });
  if (!designs.length) return fail(502, "The AI returned no usable designs.");
  return json({ designs, source: "openai" });
}

// --- Idea helper (Create page, step 1) --------------------------------------
const IDEA_PROMPT = `You help people describe a handmade ceramic piece for a pottery design app.
Write ONE idea in Thai, 1-2 short sentences (max ~140 characters), naming the
vessel type (แจกัน ชาม เหยือก จาน แก้วมัค or ประติมากรรม), its shape, a colour,
and a surface or texture. Shapes the app can make well include tall, squat,
flared, wonky lips, pedestals, twists, ovals, polygons and top-view outlines
like หัวใจ ดาว ดอกไม้ ก้อนเมฆ ใบโคลเวอร์ หยดน้ำ ใบไม้ เหลี่ยมมน.
If the user gave an idea, keep everything they asked for and make it more
specific. If they gave none, invent a fresh, charming idea (vary it each time).
Reply with ONLY JSON: {"idea": "..."}`;

async function idea(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest("Invalid JSON body.");
  const prompt = body.prompt === undefined ? "" : body.prompt;
  if (typeof prompt !== "string" || prompt.length > 500) return badRequest("prompt must be at most 500 characters.");
  if (!optionalString(body.vessel)) return badRequest("vessel must be a string.");

  if (!env.OPENAI_API_KEY) return noKey();
  const limited = rateLimit(request);
  if (limited) return limited;

  let userMsg = `User idea: ${prompt.trim() || "(none - surprise me)"}`;
  if (has(VESSEL_RANGES, body.vessel)) userMsg += `\nVessel type to use: ${body.vessel}`;
  userMsg += `\nRandom seed: ${crypto.getRandomValues(new Uint16Array(1))[0] % 10000}`;
  let data;
  try {
    data = await chatJSON(env, [
      { role: "system", content: IDEA_PROMPT },
      { role: "user", content: userMsg },
    ]);
  } catch (err) {
    // network error, auth error, quota, timeout, bad JSON
    console.warn(`OpenAI call failed: ${err.name}: ${err.message}`);
    return fail(502, `AI request failed: ${err.name}`);
  }
  const text = isDict(data) ? String(data.idea || "").trim() : "";
  if (!text) return fail(502, "The AI returned no idea.");
  return json({ idea: cut(text, 300) });
}

/* ---------------- router ---------------- */
export async function handleAI(request, env, path) {
  const method = request.method;
  if (path === "/ai/status" && method === "GET") return status(env);
  if (path === "/ai/suggest-designs" && method === "POST") return suggestDesigns(request, env);
  if (path === "/ai/edit-design" && method === "POST") return editDesign(request, env);
  if (path === "/ai/suggest-vessels" && method === "POST") return suggestVessels(request, env);
  if (path === "/ai/idea" && method === "POST") return idea(request, env);
  return fail(404, "Not Found");
}
