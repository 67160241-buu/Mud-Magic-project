// vessel-ai.js — turns a free-text idea into complete vessel configs.
//
// Two layers, both honest about what they are:
//   1. A deterministic keyword reader (Thai + English) that picks the vessel
//      type, neck, foot, handle, clay, finish, glaze and surface pattern. It
//      runs in the browser and never sends the text anywhere.
//   2. When the server-side OpenAI helper is configured, its glaze / finish /
//      pattern suggestions (the API is mug-oriented) are blended into the
//      vessel forms chosen by layer 1.
//
// `suggestVessels` always resolves — if the server is missing or fails, the
// offline variations are returned together with a notice.
import { aiAvailable } from "./ai-design.js";
import {
  VESSELS, VESSEL_IDS, NECKS, FEET, HANDLES, CLAYS, CLAY_IDS, GLAZES, PATTERNS, RAW_GLAZE,
  configForVessel, normalizeConfig, variationTitle, variationSubtitle,
} from "./vessels.js";

const WORDS = {
  vessel: {
    vase: ["แจกัน", "vase"],
    bowl: ["ชาม", "bowl"],
    pitcher: ["เหยือก", "ที่เทน้ำ", "pitcher", "jug", "ewer"],
    plate: ["จาน", "plate", "dish", "platter"],
    mug: ["แก้ว", "มัค", "mug", "cup"],
    sculpture: ["ประติมากรรม", "รูปปั้น", "sculpture", "statue", "abstract"],
  },
  outline: {
    heart: ["หัวใจ", "heart"],
    star: ["ดาว", "star"],
    flower: ["ดอกไม้", "กลีบ", "flower", "petal"],
    cloud: ["เมฆ", "cloud"],
    clover: ["โคลเวอร์", "clover", "สามแฉก"],
    teardrop: ["หยดน้ำ", "teardrop", "drop"],
    leaf: ["ใบไม้", "leaf"],
    squircle: ["เหลี่ยมมน", "สี่เหลี่ยม", "square", "squircle"],
  },
  neck: {
    asym: ["เบี้ยว", "ไม่สมมาตร", "asymmetric", "uneven lip", "asym"],
    fluted: ["ขอบร่อง", "fluted rim", "fluted neck", "scalloped rim"],
    flared: ["ปากบาน", "บานออก", "flare", "flared"],
    clean: ["ตัดเรียบ", "ปากเรียบ", "clean cut", "clean rim"],
  },
  foot: {
    pedestal: ["ฐานสูง", "pedestal", "stemmed"],
    flat: ["ฐานเรียบ", "flat base", "flat foot"],
    trimmed: ["ฐานแต่ง", "trimmed", "foot ring"],
  },
  handle: {
    none: ["ไม่มีหู", "no handle", "seamless", "handleless"],
    ear: ["หูเหลี่ยม", "ear handle", "geometric ear", "minimal handle", "หูเล็ก"],
    loop: ["หูห่วง", "loop", "classic handle", "c-handle"],
    lug: ["หูคู่", "lug", "double handle", "two handles"],
  },
  clay: {
    sand: ["ทราย", "speckle", "จุดด่าง", "sand"],
    cream: ["สโตนครีม", "cream stone", "cream clay", "porcelain", "เซรามิกขาว"],
    terra: ["เอิร์ธเธนแวร์", "earthenware", "terra clay", "เทอร์รา"],
    charcoal: ["ดินถ่าน", "ดินดำ", "black stoneware", "black clay", "charcoal clay"],
  },
  texture: {
    pinch: ["บีบ", "pinch", "organic", "ออร์แกนิก", "handmade", "ทำมือ"],
    thrown: ["ปั้นแป้น", "thrown", "wheel", "สมมาตร", "perfect"],
  },
  surface: {
    smooth: ["เงา", "มัน", "glossy", "gloss", "shiny", "smooth glaze"],
    rough: ["หยาบ", "ดิบ", "rough", "rustic", "textured", "stoneware look"],
    matte: ["ด้าน", "matte", "satin"],
  },
  glaze: {
    "#A65D45": ["ดินเผา", "ส้ม", "terracotta", "rust", "orange"],
    "#7C8872": ["เขียว", "เซจ", "ใบไม้", "sage", "green", "olive"],
    "#F3E9DD": ["ครีม", "ขาวนวล", "cream", "beige"],
    "#3B2A20": ["น้ำตาล", "กาแฟ", "espresso", "brown", "coffee"],
    "#E3A896": ["ชมพู", "blush", "pink", "peach", "rose"],
    "#2B2B2B": ["ดำ", "ถ่าน", "charcoal", "black", "graphite"],
    "#8E6FB5": ["ม่วง", "ลาเวนเดอร์", "purple", "violet", "lavender"],
    "#4C5A66": ["น้ำเงิน", "denim", "navy", "indigo"],
    "#7FA7C9": ["ฟ้า", "blue", "sky"],
    "#B8433A": ["แดง", "red", "crimson"],
    "#E2B84C": ["เหลือง", "yellow", "mustard"],
    "#8E9196": ["เทา", "grey", "gray"],
    "#FBF6EF": ["งาช้าง", "ขาว", "ivory", "white", "snow"],
  },
  pattern: {
    flutes: ["ร่องลึก", "ร่อง", "flute", "groove", "carved"],
    reeds: ["สันนูน", "สัน", "reed", "rib"],
    facets: ["เหลี่ยม", "facet", "angular", "geometric"],
    rings: ["วงรอบ", "วง", "ring", "ridge", "ripple"],
    twist: ["เกลียว", "บิด", "twist", "spiral"],
    wobble: ["หยัก", "คลื่น", "wobble", "wavy", "ruffle"],
  },
};
const UNGLAZED = ["ไม่เคลือบ", "unglazed", "bare clay", "raw clay"];

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

function match(text, dict) {
  for (const key of Object.keys(dict)) if (dict[key].some((w) => text.includes(w))) return key;
  return null;
}

/** What the prompt explicitly asks for. Anything null is free for variation. */
export function readPrompt(prompt) {
  const t = String(prompt || "").toLowerCase();
  const sizeUp = ["สูง", "เรียว", "tall", "slim", "elegant"].some((w) => t.includes(w));
  const sizeDown = ["เตี้ย", "กว้าง", "short", "squat", "wide", "chunky"].some((w) => t.includes(w));
  const big = ["ใหญ่", "large", "big"].some((w) => t.includes(w));
  const small = ["เล็ก", "จิ๋ว", "small", "tiny", "mini"].some((w) => t.includes(w)) && !t.includes("หูเล็ก");
  return {
    vessel: match(t, WORDS.vessel),
    outline: match(t, WORDS.outline),
    neck: match(t, WORDS.neck),
    foot: match(t, WORDS.foot),
    handle: match(t, WORDS.handle),
    clay: match(t, WORDS.clay),
    texture: match(t, WORDS.texture),
    surface: match(t, WORDS.surface),
    glaze: UNGLAZED.some((w) => t.includes(w)) ? RAW_GLAZE : match(t, WORDS.glaze),
    pattern: match(t, WORDS.pattern),
    tall: sizeUp && !sizeDown,
    short: sizeDown && !sizeUp,
    big,
    small,
  };
}

function patternMod(id, rng) {
  const preset = PATTERNS.find((p) => p.id === id);
  if (!preset || !preset.mod) return null;
  const mod = { ...preset.mod };
  if (mod.scallops > 0) mod.scallops = Math.max(3, Math.round(mod.scallops + (rng() - 0.5) * 6));
  if (mod.scallops > 0) mod.scallopDepth = Math.min(0.09, mod.scallopDepth * (0.8 + rng() * 0.5));
  return mod;
}

function pickKey(obj, rng) {
  const keys = Object.keys(obj);
  return keys[Math.floor(rng() * keys.length)];
}

/** Deterministic offline variations. First honours every hint. */
export function offlineVessels(prompt, { count = 4, seed = 0, fallbackVessel = "vase" } = {}) {
  const hint = readPrompt(prompt);
  const rng = mulberry32(hashSeed(`${String(prompt || "").toLowerCase()}::${seed}`));
  const out = [];

  for (let i = 0; i < count; i++) {
    const first = i === 0;
    const vessel =
      hint.vessel ||
      (first ? fallbackVessel : VESSEL_IDS[Math.floor(rng() * VESSEL_IDS.length)]);
    const preset = VESSELS[vessel];

    const glaze = hint.glaze || GLAZES[Math.floor(rng() * GLAZES.length)].hex;
    const clay = hint.clay || CLAY_IDS[Math.floor(rng() * CLAY_IDS.length)];
    const texture = hint.texture || (rng() < 0.5 ? "pinch" : "thrown");
    const surface = hint.surface || pickKey({ smooth: 1, matte: 1, rough: 1 }, rng);
    const patternId = hint.pattern && first ? hint.pattern : hint.pattern || PATTERNS[Math.floor(rng() * PATTERNS.length)].id;

    let height = preset.height[2];
    let belly = preset.belly[2];
    const jitter = () => 0.88 + rng() * 0.28;
    height *= jitter();
    belly *= jitter();
    if (hint.tall) {
      height *= 1.22;
      belly *= 0.88;
    }
    if (hint.short) {
      height *= 0.82;
      belly *= 1.14;
    }
    if (hint.big) {
      height *= 1.18;
      belly *= 1.18;
    }
    if (hint.small) {
      height *= 0.82;
      belly *= 0.82;
    }

    const config = configForVessel(vessel, { clay, texture, color: glaze, surface, modulation: patternMod(patternId, rng) });
    config.height = height;
    config.belly = belly;
    config.neck = hint.neck || (first && !hint.vessel ? config.neck : pickKey(NECKS, rng));
    config.foot = hint.foot || pickKey(FEET, rng);
    config.handle =
      hint.handle ||
      (preset.handle !== "none" || vessel === "mug" || vessel === "pitcher"
        ? pickKey(HANDLES, rng)
        : "none");
    if (vessel === "sculpture" || vessel === "plate") config.handle = hint.handle || "none";
    if (hint.outline) config.lab = { ...config.lab, outline: hint.outline };
    out.push(normalizeConfig(config));
  }

  return out.map((config, i) => ({
    name: variationTitle(config, i),
    rationale: variationSubtitle(config),
    config,
  }));
}

/** Seeded perturbation of one design: keeps the vessel, shifts the details. */
export function remixConfig(base, seed = 1, count = 4) {
  const b = normalizeConfig(base);
  const rng = mulberry32(hashSeed(JSON.stringify(b) + seed));
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = normalizeConfig(b);
    c.height = b.height * (0.88 + rng() * 0.26);
    c.belly = b.belly * (0.88 + rng() * 0.26);
    if (rng() < 0.6) c.neck = pickKey(NECKS, rng);
    if (rng() < 0.4) c.foot = pickKey(FEET, rng);
    if (rng() < 0.5 && (b.vessel === "mug" || b.vessel === "pitcher" || b.vessel === "vase")) c.handle = pickKey(HANDLES, rng);
    if (rng() < 0.6) c.color = GLAZES[Math.floor(rng() * GLAZES.length)].hex;
    if (rng() < 0.35) c.clay = CLAY_IDS[Math.floor(rng() * CLAY_IDS.length)];
    if (rng() < 0.5) c.modulation = patternMod(PATTERNS[Math.floor(rng() * PATTERNS.length)].id, rng);
    const n = normalizeConfig(c);
    out.push({ name: variationTitle(n, i), rationale: variationSubtitle(n), config: n });
  }
  return out;
}

/**
 * Main entry. Always resolves.
 * @returns {Promise<{designs:Array<{name,rationale,config}>, source:"openai"|"offline", notice?:string}>}
 */
const API_BASE = window.MUDMAGIC_API_BASE || "http://localhost:8000";

/** Turns a server patch ({vessel, height, lab, ...} + pattern id) into a full config. */
export function configFromPatch(patch = {}, pattern = null, fallbackVessel = "vase") {
  const base = configForVessel(VESSELS[patch.vessel] ? patch.vessel : fallbackVessel);
  const next = { ...base, ...patch, lab: { ...base.lab, ...(patch.lab || {}) } };
  if (pattern) {
    const preset = PATTERNS.find((p) => p.id === pattern);
    next.modulation = preset?.mod ? { ...preset.mod } : null;
  }
  return normalizeConfig(next);
}

export async function suggestVessels(prompt, { count = 4, seed = 0, fallbackVessel = "vase", skillLevel = null } = {}) {
  const offline = offlineVessels(prompt, { count, seed, fallbackVessel });
  if (!(await aiAvailable())) {
    return { designs: offline, source: "offline", notice: "ยังไม่ได้ตั้งค่า OpenAI บนเซิร์ฟเวอร์ — ใช้โหมดออฟไลน์แทน" };
  }
  try {
    const res = await fetch(`${API_BASE}/ai/suggest-vessels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, count, skill_level: skillLevel, vessel: fallbackVessel }),
      signal: AbortSignal.timeout(70000),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const body = await res.json();
    // A shape the person named ("รูปดาว", "heart") is kept even if the model forgot to set it.
    const wanted = readPrompt(prompt).outline;
    const designs = (body.designs || []).map((d) => {
      let config = configFromPatch(d.patch, d.pattern, fallbackVessel);
      if (wanted && config.lab.outline === "round") config = normalizeConfig({ ...config, lab: { ...config.lab, outline: wanted } });
      return { name: d.name, rationale: d.rationale, config };
    });
    if (!designs.length) throw new Error("no designs");
    // Pad with offline picks if the model returned fewer than asked.
    while (designs.length < count) designs.push(offline[designs.length]);
    return { designs, source: "openai" };
  } catch (err) {
    return { designs: offline, source: "offline", notice: "เชื่อมต่อ AI ไม่ได้ — ใช้โหมดออฟไลน์แทน" };
  }
}
