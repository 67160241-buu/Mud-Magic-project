// ai-design.js — asks the backend to turn a free-text idea into concrete
// mug configs the 3D renderer can build.
//
// The OpenAI key is NOT here and never reaches the browser. This calls our
// own /ai/suggest-designs endpoint, which holds the key server side.
//
// Availability is treated as optional on purpose: if the server has no key,
// is down, is rate-limiting, or returns junk, `suggestDesigns` resolves with
// offline results from the existing keyword generator rather than throwing.
// Callers get designs either way and can tell which by checking `.source`.
import { PATTERNS, DEFAULT_MODULATION, GLAZES, SHAPES, HANDLES, SURFACES } from "./mug-model.js";

const API_BASE = window.MUDMAGIC_API_BASE || "http://localhost:8000";

let statusCache = null;

/** Is the server-side AI actually configured? Cached after first check. */
export async function aiAvailable() {
  if (statusCache !== null) return statusCache;
  try {
    const res = await fetch(`${API_BASE}/ai/status`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("status not ok");
    const body = await res.json();
    statusCache = !!body.enabled;
  } catch (err) {
    statusCache = false;
  }
  return statusCache;
}

/**
 * Converts the API's flat pattern fields into the modulation object that
 * mug-model.js expects, reusing the same presets the Studio buttons use so
 * an AI-chosen "flutes" looks identical to a hand-picked one.
 */
export function patternToModulation(pattern, count, depth, twist) {
  const preset = PATTERNS.find((p) => p.id === pattern);
  if (!preset || !preset.mod) return null;
  const mod = { ...DEFAULT_MODULATION, ...preset.mod };
  const isRipple = mod.ripples > 0 && !(mod.scallops > 0);
  if (isRipple) {
    mod.ripples = count;
    mod.rippleDepth = depth * 0.4;
  } else {
    mod.scallops = count;
    mod.scallopDepth = depth;
    if (mod.ripples > 0) mod.rippleDepth = depth * 0.4;
  }
  if (twist > 0) {
    mod.ruffles = mod.ruffles || 1;
    mod.ruffleDepth = twist;
  }
  return mod;
}

/** Shapes an API design into the config object buildMugGroup() takes. */
function toRenderConfig(design) {
  const c = design.config;
  return {
    shape: c.shape,
    handle: c.handle,
    surface: c.surface,
    color: c.color,
    modulation: patternToModulation(c.pattern, c.pattern_count, c.pattern_depth, c.pattern_twist),
  };
}

/* ------------------------------------------------------------------ */
/* Offline fallback — the original keyword generator                   */
/* ------------------------------------------------------------------ */
const KEYWORDS = {
  shape: {
    tall: ["สูง", "เรียว", "ชะลูด", "tall", "slim"],
    round: ["ป่อง", "กลม", "โค้ง", "round", "curvy"],
    wide: ["เตี้ย", "กว้าง", "ชาม", "wide", "short"],
    classic: ["คลาสสิก", "เรียบ", "classic"],
  },
  handle: {
    minimal: ["หูเล็ก", "มินิมอล", "minimal"],
    organic: ["อิสระ", "หยัก", "organic", "handmade"],
    loop: ["หูห่วง", "loop"],
  },
  surface: {
    smooth: ["เงา", "มัน", "glossy", "smooth"],
    rough: ["หยาบ", "ดิบ", "rough", "rustic", "unglazed"],
    matte: ["ด้าน", "matte"],
  },
  pattern: {
    flutes: ["ร่อง", "ร่องลึก", "flute", "groove", "carved"],
    reeds: ["สัน", "นูน", "reed", "rib"],
    facets: ["เหลี่ยม", "facet", "angular", "geometric"],
    rings: ["วง", "วงรอบ", "ring", "ridge"],
    twist: ["เกลียว", "บิด", "twist", "spiral"],
    wobble: ["หยัก", "คลื่น", "wobble", "wavy"],
  },
  glaze: {
    "#A65D45": ["ดินเผา", "ส้ม", "terracotta", "clay"],
    "#7C8872": ["เขียว", "เซจ", "ใบไม้", "sage", "green"],
    "#F3E9DD": ["ครีม", "ขาวนวล", "cream"],
    "#3B2A20": ["น้ำตาล", "กาแฟ", "espresso", "brown"],
    "#E3A896": ["ชมพู", "blush", "pink"],
    "#2B2B2B": ["ดำ", "ถ่าน", "charcoal", "black"],
    "#4C5A66": ["ฟ้า", "น้ำเงิน", "denim", "blue"],
    "#FBF6EF": ["งาช้าง", "ขาว", "ivory", "white"],
  },
};

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function matchKeyword(promptLower, dict) {
  for (const key of Object.keys(dict)) {
    if (dict[key].some((k) => promptLower.includes(k))) return key;
  }
  return null;
}

/** Deterministic, no-network design generation. Honest about being simple. */
export function offlineSuggestions(prompt, count = 4, seed = 0) {
  const p = prompt.toLowerCase();
  const rng = mulberry32(hashSeed(`${p}::${seed}`));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const hinted = {
    shape: matchKeyword(p, KEYWORDS.shape),
    handle: matchKeyword(p, KEYWORDS.handle),
    surface: matchKeyword(p, KEYWORDS.surface),
    pattern: matchKeyword(p, KEYWORDS.pattern),
    color: matchKeyword(p, KEYWORDS.glaze),
  };

  const out = [];
  for (let i = 0; i < count; i++) {
    // First result honours every keyword hit; the rest vary the unhinted
    // fields so the set isn't four near-identical mugs.
    const shape = hinted.shape && i === 0 ? hinted.shape : hinted.shape || pick(SHAPES);
    const handle = hinted.handle && i === 0 ? hinted.handle : pick(HANDLES);
    const surface = hinted.surface && i === 0 ? hinted.surface : hinted.surface || pick(SURFACES);
    const patternId = i === 0 && hinted.pattern ? hinted.pattern : pick(PATTERNS).id;
    const color = hinted.color && i === 0 ? hinted.color : hinted.color || pick(GLAZES).hex;
    const count2 = 6 + Math.floor(rng() * 14);
    const depth = 0.02 + rng() * 0.04;

    out.push({
      name: `แบบที่ ${i + 1}`,
      rationale: "สร้างจากคำสำคัญในคำอธิบายของคุณ (โหมดออฟไลน์)",
      config: {
        shape,
        handle,
        surface,
        color,
        pattern: patternId,
        pattern_count: count2,
        pattern_depth: depth,
        pattern_twist: patternId === "twist" ? 0.5 : 0,
      },
    });
  }
  return out;
}

/**
 * Main entry point. Always resolves.
 * @returns {Promise<{designs: Array<{name,rationale,config,renderConfig}>, source: "openai"|"offline", notice?: string}>}
 */
export async function suggestDesigns(prompt, { skillLevel = null, count = 4, seed = 0 } = {}) {
  const fallback = (notice) => {
    const designs = offlineSuggestions(prompt, count, seed);
    return {
      designs: designs.map((d) => ({ ...d, renderConfig: toRenderConfig(d) })),
      source: "offline",
      notice,
    };
  };

  if (!(await aiAvailable())) {
    return fallback("ยังไม่ได้ตั้งค่า OpenAI บนเซิร์ฟเวอร์ — ใช้โหมดออฟไลน์แทน");
  }

  try {
    const res = await fetch(`${API_BASE}/ai/suggest-designs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, skill_level: skillLevel, count }),
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch (err) {
        /* non-JSON error body */
      }
      return fallback(`AI ใช้งานไม่ได้ (${detail}) — ใช้โหมดออฟไลน์แทน`);
    }
    const body = await res.json();
    if (!Array.isArray(body.designs) || !body.designs.length) {
      return fallback("AI ไม่ได้ส่งแบบกลับมา — ใช้โหมดออฟไลน์แทน");
    }
    return {
      designs: body.designs.map((d) => ({ ...d, renderConfig: toRenderConfig(d) })),
      source: "openai",
    };
  } catch (err) {
    return fallback("เชื่อมต่อ AI ไม่ได้ — ใช้โหมดออฟไลน์แทน");
  }
}
