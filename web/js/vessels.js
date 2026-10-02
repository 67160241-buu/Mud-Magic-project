// vessels.js — design vocabulary for the Mud Magic studio (pure JS, no three.js).
//
// Everything that is *data about a pot* lives here: the six vessel types and
// their starting profiles, the neck / foot / handle / clay / glaze options,
// config normalisation (including old share links from the mug-only studio),
// the "is this actually makeable?" assessment, and the written making guide.
// Geometry is built from this data in pot-mesh.js.
//
// The profile curves and the modulation vocabulary follow PotterDraw by
// Chris Korda (GPL-2.0-or-later). See LICENSE-POTTERDRAW.md.

import { DEFAULT_MODULATION } from "./wave.js";

/* ------------------------------------------------------------------ */
/* Option tables                                                        */
/* ------------------------------------------------------------------ */
export const GLAZES = [
  { id: "terracotta", label: "ดินเผา", hex: "#A65D45" },
  { id: "sage", label: "เซจ", hex: "#7C8872" },
  { id: "cream", label: "ครีม", hex: "#F3E9DD" },
  { id: "espresso", label: "เอสเพรสโซ", hex: "#3B2A20" },
  { id: "blush", label: "ชมพู", hex: "#E3A896" },
  { id: "charcoal", label: "ถ่าน", hex: "#2B2B2B" },
  { id: "denim", label: "เดนิม", hex: "#4C5A66" },
  { id: "ivory", label: "งาช้าง", hex: "#FBF6EF" },
];
export const RAW_GLAZE = "raw"; // unglazed — the clay body shows

export const CLAYS = {
  sand: { label: "ทรายจุดด่าง", short: "Speckled stoneware", hex: "#C9AE8B", speckle: 0.6, speckleHex: "#5B4030" },
  cream: { label: "สโตนครีม", short: "Cream stoneware", hex: "#E8DCC6", speckle: 0.18, speckleHex: "#7A6048" },
  terra: { label: "เทอร์ราอุ่น", short: "Terracotta earthenware", hex: "#B2603F", speckle: 0.2, speckleHex: "#5A2A1A" },
  charcoal: { label: "ดินถ่าน", short: "Black stoneware", hex: "#3B3633", speckle: 0.35, speckleHex: "#C9BDAE" },
};
export const CLAY_IDS = Object.keys(CLAYS);

export const TEXTURES = {
  thrown: { label: "ปั้นแป้นเรียบ" },
  pinch: { label: "บีบมืออิสระ" },
};

export const FINISHES = {
  smooth: { label: "เงา" },
  matte: { label: "ด้าน" },
  rough: { label: "หยาบ" },
};

export const NECKS = {
  clean: { label: "ตัดเรียบ", en: "Clean cut" },
  asym: { label: "ปากเบี้ยว", en: "Asymmetric lip" },
  fluted: { label: "ขอบร่อง", en: "Fluted rim" },
  flared: { label: "ปากบาน", en: "Flared opening" },
};
export const FEET = {
  flat: { label: "ฐานเรียบดิบ", en: "Raw flat" },
  trimmed: { label: "ฐานแต่ง", en: "Trimmed foot" },
  pedestal: { label: "ฐานสูง", en: "Pedestal" },
};
export const HANDLES = {
  none: { label: "ไม่มีหู", en: "None / seamless" },
  ear: { label: "หูเหลี่ยม", en: "Geometric ear" },
  loop: { label: "หูห่วง", en: "Classic loop" },
  lug: { label: "หูคู่ติดข้าง", en: "Double lug" },
};

/** Surface-pattern presets (scallops / ripples / ruffles). Same set the mug-only studio had. */
export const PATTERNS = [
  { id: "none", label: "เรียบ", mod: null },
  { id: "flutes", label: "ร่องลึก", mod: { ...DEFAULT_MODULATION, scallops: 12, scallopMotif: "flutes", scallopDepth: 0.035 } },
  { id: "reeds", label: "สันนูน", mod: { ...DEFAULT_MODULATION, scallops: 14, scallopMotif: "reeds", scallopDepth: 0.03 } },
  { id: "facets", label: "เหลี่ยม", mod: { ...DEFAULT_MODULATION, scallops: 8, scallopWaveform: "triangle", scallopDepth: 0.04 } },
  { id: "rings", label: "วงรอบ", mod: { ...DEFAULT_MODULATION, ripples: 14, rippleWaveform: "sine", rippleDepth: 0.012 } },
  { id: "twist", label: "บิดเกลียว", mod: { ...DEFAULT_MODULATION, scallops: 10, scallopDepth: 0.035, ruffles: 1, ruffleDepth: 0.55 } },
  { id: "wobble", label: "ขอบหยัก", mod: { ...DEFAULT_MODULATION, scallops: 6, scallopDepth: 0.05, ripples: 5, rippleDepth: 0.015 } },
];

export const COLOR_PATTERNS = {
  none: { label: "สีเดียว" },
  stripes: { label: "ลายทาง" },
  rings: { label: "ลายวง" },
  petals: { label: "ลายกลีบ" },
};

/* ------------------------------------------------------------------ */
/* Vessel types                                                         */
/* ------------------------------------------------------------------ */
// `nodes` is the outer-wall profile as [radius, height] pairs, both
// normalised: height 0 (base) .. 1 (rim), radius relative to the widest point
// (the sampler rescales so the widest point is exactly `belly / 2`).
export const VESSELS = {
  vase: {
    label: "แจกัน", en: "Vase", icon: "potted_plant",
    nodes: [[0.46, 0], [0.64, 0.08], [0.93, 0.28], [1.0, 0.45], [0.88, 0.64], [0.5, 0.82], [0.36, 0.9], [0.43, 1.0]],
    height: [12, 45, 24], belly: [8, 30, 14], wall: [0.4, 1.5, 0.7],
    handle: "none", neck: "asym", foot: "trimmed", handleSpan: [0.5, 0.86],
  },
  bowl: {
    label: "ชาม", en: "Bowl", icon: "soup_kitchen",
    nodes: [[0.42, 0], [0.55, 0.04], [0.76, 0.3], [0.93, 0.66], [1.0, 1.0]],
    height: [5, 16, 9], belly: [10, 32, 16], wall: [0.4, 1.5, 0.6],
    handle: "none", neck: "clean", foot: "trimmed", handleSpan: [0.62, 0.96],
  },
  pitcher: {
    label: "เหยือก", en: "Pitcher", icon: "local_drink",
    nodes: [[0.7, 0], [0.84, 0.1], [1.0, 0.4], [0.95, 0.66], [0.74, 0.88], [0.72, 1.0]],
    height: [12, 30, 20], belly: [9, 20, 13], wall: [0.4, 1.2, 0.6],
    handle: "loop", neck: "clean", foot: "flat", spout: true, handleSpan: [0.3, 0.86],
  },
  plate: {
    label: "จาน", en: "Plate", icon: "radio_button_unchecked",
    nodes: [[0.6, 0], [0.68, 0.08], [0.86, 0.3], [0.96, 0.68], [1.0, 1.0]],
    height: [2, 5, 3], belly: [18, 36, 26], wall: [0.5, 1.2, 0.7],
    handle: "none", neck: "clean", foot: "trimmed", handleSpan: [0.7, 0.98],
  },
  mug: {
    label: "แก้วมัค", en: "Mug", icon: "coffee",
    nodes: [[0.9, 0], [0.97, 0.05], [1.0, 0.5], [1.0, 0.95], [1.01, 1.0]],
    height: [7, 16, 10], belly: [6, 12, 8.5], wall: [0.4, 1.0, 0.6],
    handle: "loop", neck: "clean", foot: "trimmed", handleSpan: [0.26, 0.8],
  },
  sculpture: {
    label: "ประติมากรรม", en: "Sculpture", icon: "architecture",
    nodes: [[0.34, 0], [0.72, 0.1], [1.0, 0.36], [0.78, 0.6], [0.88, 0.78], [0.55, 0.92], [0.1, 1.0]],
    height: [12, 45, 26], belly: [8, 26, 14], wall: [0.5, 1.5, 0.7],
    handle: "none", neck: "clean", foot: "flat", solid: true, handleSpan: [0.45, 0.8],
  },
};
export const VESSEL_IDS = Object.keys(VESSELS);

/* ------------------------------------------------------------------ */
/* Config                                                               */
/* ------------------------------------------------------------------ */
export const DEFAULT_LAB = {
  nodes: null, // custom outer profile [[r, y], ...] or null = use the vessel preset
  twist: 0, // full turns of cross-section rotation from base to rim
  aspect: 1, // x-stretch of the cross-section (1 = round)
  polySides: 0, // 0 = round; 3.. = polygon cross-section
  polyRound: 0, // -1..1 corner rounding
  polyBulge: 0, // 0..1 outward bulge of the polygon's flats
  bends: 0, // lean cycles up the height
  bendDepth: 0.12, // fraction of belly radius
  bendPoles: 1, // lean lobes around the pot
  helixFreq: 0, // helical sweep of the whole pot axis
  helixAmp: 0.2, // fraction of belly radius
  colorPattern: "none",
  accent: "#2B2B2B",
  colorCycles: 6,
  colorSharp: 0.8,
};

export const DEFAULT_CONFIG = {
  v: 2,
  vessel: "vase",
  height: 24,
  belly: 14,
  wall: 0.7,
  neck: "asym",
  foot: "trimmed",
  handle: "none",
  clay: "sand",
  texture: "pinch",
  color: "#F3E9DD",
  surface: "matte",
  modulation: null,
  lab: { ...DEFAULT_LAB },
};

/** Fresh config for a vessel type, keeping the user's material choices. */
export function configForVessel(id, keep = {}) {
  const v = VESSELS[id] || VESSELS.mug;
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    clay: keep.clay,
    texture: keep.texture,
    color: keep.color,
    surface: keep.surface,
    modulation: keep.modulation ?? null,
    vessel: id,
    height: v.height[2],
    belly: v.belly[2],
    wall: v.wall[2],
    handle: v.handle,
    neck: v.neck,
    foot: v.foot,
    lab: { ...DEFAULT_LAB },
  });
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, fallback) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// How the old mug-only studio's four "shape" presets map onto real dimensions.
const LEGACY_SHAPES = {
  classic: { height: 10, belly: 8.5 },
  round: { height: 10.5, belly: 10.8 },
  tall: { height: 14, belly: 7.5 },
  wide: { height: 7.5, belly: 10.5 },
};
const LEGACY_HANDLES = { minimal: "ear", loop: "loop", organic: "loop" };

/**
 * Accepts anything the studio has ever produced (v2 configs, the old
 * shape/handle/surface/color mug configs, AI-suggested render configs) and
 * returns a complete, clamped v2 config.
 */
export function normalizeConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const legacy = !src.vessel && (src.shape || src.handle === "minimal" || src.handle === "organic");

  let vessel = VESSELS[src.vessel] ? src.vessel : legacy || src.shape ? "mug" : DEFAULT_CONFIG.vessel;
  const preset = VESSELS[vessel];

  let height = num(src.height, undefined);
  let belly = num(src.belly, undefined);
  if (legacy && LEGACY_SHAPES[src.shape]) {
    height = LEGACY_SHAPES[src.shape].height;
    belly = LEGACY_SHAPES[src.shape].belly;
  }
  if (height === undefined) height = preset.height[2];
  if (belly === undefined) belly = preset.belly[2];

  let handle = src.handle;
  if (LEGACY_HANDLES[handle] && !HANDLES[handle]) handle = LEGACY_HANDLES[handle];
  if (!HANDLES[handle]) handle = legacy ? "loop" : preset.handle;

  const labIn = src.lab && typeof src.lab === "object" ? src.lab : {};
  const lab = { ...DEFAULT_LAB };
  for (const key of Object.keys(DEFAULT_LAB)) {
    if (labIn[key] !== undefined) lab[key] = labIn[key];
  }
  lab.nodes =
    Array.isArray(lab.nodes) && lab.nodes.length >= 2 && lab.nodes.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      ? lab.nodes.map((p) => [clamp(p[0], 0.02, 3), clamp(p[1], 0, 1)])
      : null;
  lab.twist = clamp(num(lab.twist, 0), -3, 3);
  lab.aspect = clamp(num(lab.aspect, 1), 0.4, 2);
  lab.polySides = lab.polySides >= 3 ? clamp(num(lab.polySides, 0), 3, 24) : 0;
  lab.polyRound = clamp(num(lab.polyRound, 0), -1, 1);
  lab.polyBulge = clamp(num(lab.polyBulge, 0), 0, 0.95);
  lab.bends = clamp(num(lab.bends, 0), 0, 12);
  lab.bendDepth = clamp(num(lab.bendDepth, 0.12), 0, 0.5);
  lab.bendPoles = clamp(Math.round(num(lab.bendPoles, 1)), 0, 12);
  lab.helixFreq = clamp(num(lab.helixFreq, 0), 0, 6);
  lab.helixAmp = clamp(num(lab.helixAmp, 0.2), 0, 1);
  if (!COLOR_PATTERNS[lab.colorPattern]) lab.colorPattern = "none";
  if (!HEX_RE.test(lab.accent)) lab.accent = DEFAULT_LAB.accent;
  lab.colorCycles = clamp(num(lab.colorCycles, 6), 1, 24);
  lab.colorSharp = clamp(num(lab.colorSharp, 0.8), 0, 1);

  let color = src.color;
  if (color !== RAW_GLAZE && !(typeof color === "string" && HEX_RE.test(color))) color = DEFAULT_CONFIG.color;

  return {
    v: 2,
    vessel,
    height: clamp(height, preset.height[0], preset.height[1]),
    belly: clamp(belly, preset.belly[0], preset.belly[1]),
    wall: clamp(num(src.wall, preset.wall[2]), preset.wall[0], preset.wall[1]),
    neck: NECKS[src.neck] ? src.neck : legacy ? "clean" : preset.neck,
    foot: FEET[src.foot] ? src.foot : legacy ? "trimmed" : preset.foot,
    handle,
    clay: CLAYS[src.clay] ? src.clay : "sand",
    texture: TEXTURES[src.texture] ? src.texture : legacy ? "thrown" : DEFAULT_CONFIG.texture,
    color,
    surface: FINISHES[src.surface] ? src.surface : DEFAULT_CONFIG.surface,
    modulation: src.modulation && typeof src.modulation === "object" ? { ...DEFAULT_MODULATION, ...src.modulation } : null,
    lab,
  };
}

/** Compact, URL-safe encoding for share links. */
export function encodeConfig(config) {
  const json = JSON.stringify(normalizeConfig(config));
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeConfig(text) {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return normalizeConfig(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    return null;
  }
}

export function glazeLabel(config) {
  if (config.color === RAW_GLAZE) return "ไม่เคลือบ";
  const g = GLAZES.find((x) => x.hex.toLowerCase() === String(config.color).toLowerCase());
  return g ? g.label : "สีกำหนดเอง";
}

/* ------------------------------------------------------------------ */
/* Assessment: difficulty, feasibility, method                          */
/* ------------------------------------------------------------------ */
export const SKILLS = [
  { id: "beginner", label: "มือใหม่", labelEn: "Beginner", max: 2 },
  { id: "intermediate", label: "ปานกลาง", labelEn: "Intermediate", max: 3.5 },
  { id: "advanced", label: "มืออาชีพ", labelEn: "Advanced", max: 5 },
];

const BASE_SCORE = { plate: 2.5, bowl: 2, mug: 3.5, vase: 4, pitcher: 5.5, sculpture: 6 };

function activeMods(mod) {
  if (!mod) return { scallops: false, ripples: false, ruffles: false, count: 0 };
  const scallops = mod.scallops > 0 && mod.scallopDepth !== 0;
  const ripples = mod.ripples > 0 && mod.rippleDepth !== 0;
  const ruffles = scallops && mod.ruffles > 0 && mod.ruffleDepth !== 0;
  return { scallops, ripples, ruffles, count: (scallops ? 1 : 0) + (ripples ? 1 : 0) + (ruffles ? 1 : 0) };
}

/**
 * Honest heuristic — a weighted sum of things that really do make pots
 * harder to throw — not a physics simulation. Returns everything the
 * feasibility card shows.
 */
export function assess(rawConfig, skillId = "intermediate") {
  const c = normalizeConfig(rawConfig);
  const notes = [];
  let score = BASE_SCORE[c.vessel];

  const ratio = c.height / c.belly;
  if ((c.vessel === "vase" || c.vessel === "sculpture") && ratio > 2.3) {
    score += 1.5;
    notes.push("ทรงสูงเรียวมาก ผนังมีโอกาสยุบระหว่างดึงขึ้น ควรดึงทีละน้อยหลายรอบ");
  } else if (c.vessel === "mug" && ratio > 1.5) {
    score += 1;
    notes.push("แก้วทรงสูง ต้องคุมผนังให้บางสม่ำเสมอ");
  } else if (c.vessel === "plate" && c.belly / c.height > 10) {
    score += 1;
    notes.push("จานกว้างและบางมาก เสี่ยงบิดเบี้ยวตอนแห้งและเผา");
  }

  score += { clean: 0, flared: 1, fluted: 2, asym: 3 }[c.neck];
  if (c.neck === "asym") notes.push("ขอบปากเบี้ยวต้องตัดแต่งมือหลังหมาด ปรับสมดุลไม่ให้น้ำหนักเอียง");
  if (c.neck === "fluted") notes.push("ขอบร่องต้องกดร่องด้วยนิ้วหรือเครื่องมือขณะดินยังหมาด");

  score += { flat: 0, trimmed: 1, pedestal: 2 }[c.foot];

  const handleScore = { none: 0, ear: 3, loop: 2.5, lug: 1.5 }[c.handle];
  score += handleScore;
  if (c.handle === "ear" || c.handle === "loop") notes.push("รอยต่อหูจับเป็นจุดที่แตกร้าวบ่อยที่สุด ให้ขูดและทาน้ำดินก่อนติด");

  score += c.texture === "pinch" ? 1 : 0;
  score += { rough: 0, matte: 0.5, smooth: 1.5 }[c.surface];
  if (c.color !== RAW_GLAZE && c.surface === "smooth") notes.push("เคลือบเงาต้องเคลือบให้หนาสม่ำเสมอ ไม่ให้เกิดรอยไหลหรือหลุมเข็ม");

  const mods = activeMods(c.modulation);
  score += mods.scallops ? 1.5 : 0;
  score += mods.ripples ? 1 : 0;
  score += mods.ruffles ? 1 : 0;

  const lab = c.lab;
  if (lab.polySides >= 3) {
    score += 2;
    notes.push("ทรงเหลี่ยมต้องดันผนังจากด้านในหรือใช้แผ่นดินประกอบ");
  }
  if (lab.bends > 0 && lab.bendDepth > 0) score += 2;
  if (lab.helixFreq > 0 && lab.helixAmp > 0) {
    score += 3;
    notes.push("ทรงบิดเกลียวทั้งตัวต้องปั้นด้วยมือและมีแกนรองรับระหว่างแห้ง");
  }
  if (lab.nodes) score += 1;
  if (Math.abs(lab.twist) > 0 && (lab.polySides >= 3 || lab.aspect !== 1)) score += 1;

  if (c.vessel !== "sculpture") {
    if (c.wall < 0.45) {
      score += 1.5;
      notes.push("ผนังบางมาก (<0.45 ซม.) เสี่ยงแตกง่ายและบิดตอนเผา");
    } else if (c.wall < 0.55) {
      score += 0.8;
    } else if (c.wall > 1.1 && c.height > 20) {
      notes.push("ผนังหนาและชิ้นงานใหญ่ ต้องผึ่งแห้งช้าๆ กันแตกร้าว");
    }
  }

  const d5 = Math.round((1 + 4 * clamp((score - 2.5) / (19 - 2.5), 0, 1)) * 2) / 2;
  const level = d5 <= SKILLS[0].max ? SKILLS[0] : d5 <= SKILLS[1].max ? SKILLS[1] : SKILLS[2];

  const tier = SKILLS.find((s) => s.id === skillId) || SKILLS[1];
  const headroom = tier.max - d5;
  const feasibility = Math.round(clamp(headroom >= 0 ? 88 + headroom * 4 : 88 + headroom * 16, 28, 98));

  let method = "ปั้นแป้นหมุน (Wheel Thrown)";
  if (lab.helixFreq > 0 || c.vessel === "sculpture") method = "ปั้นมือ (Hand Building)";
  else if (c.texture === "pinch" && (c.vessel === "bowl" || c.vessel === "plate")) method = "ปั้นบีบ (Pinch Pot)";
  else if (c.texture === "pinch") method = "ปั้นแป้น + บีบแต่งมือ";
  else if (c.handle !== "none" && (c.vessel === "mug" || c.vessel === "pitcher")) method = "ปั้นแป้น + ดึงหูจับ";
  else if (c.neck === "flared" || c.neck === "asym") method = "ปั้นแป้น + ต่อคอ (Coil Neck)";
  else if (lab.polySides >= 3 || lab.bends > 0) method = "ปั้นแป้น + ดัดทรงด้วยมือ";

  if (!notes.length) notes.push("สัดส่วนและรายละเอียดอยู่ในช่วงที่ปั้นและเผาได้ปลอดภัย");

  // Dimensions the chip shows (rim diameter comes from the profile; see pot-mesh).
  return {
    score,
    d5,
    level: level.id,
    levelLabel: level.label,
    levelLabelEn: level.labelEn,
    skill: tier.id,
    feasibility,
    method,
    notes: notes.slice(0, 2),
    allNotes: notes,
  };
}

/* ------------------------------------------------------------------ */
/* Names and summaries                                                  */
/* ------------------------------------------------------------------ */
export function summaryLine(config) {
  const c = normalizeConfig(config);
  return `${VESSELS[c.vessel].label} · ${NECKS[c.neck].label} · ${FEET[c.foot].label} · ${HANDLES[c.handle].label} · ${CLAYS[c.clay].label} · ${FINISHES[c.surface].label} · ${glazeLabel(c)}`;
}
export function variationTitle(config, index) {
  const c = normalizeConfig(config);
  return `${VESSELS[c.vessel].label} ${String(index + 1).padStart(2, "0")} · ${NECKS[c.neck].label}`;
}
export function variationSubtitle(config) {
  const c = normalizeConfig(config);
  return `${CLAYS[c.clay].short} · ${Math.round(c.height)}cm`;
}

/* ------------------------------------------------------------------ */
/* Making guide                                                         */
/* ------------------------------------------------------------------ */
const FINISH_STEP = {
  rough: "ปล่อยผิวแบบดิบหลังแต่งรูปทรง ไม่ต้องขัดมาก แล้วเคลือบแบบด้านหนา",
  matte: "ขัดผิวด้วยฟองน้ำให้เรียบพอประมาณ แล้วเคลือบสูตรด้าน",
  smooth: "ขัดผิวหลายรอบให้เนียนไร้รอย แล้วเคลือบมันให้ทั่วอย่างสม่ำเสมอ",
};
const NECK_STEP = {
  clean: "ตัดขอบปากให้เรียบด้วยเข็มตัดหรือสายตัด แล้วใช้ฟองน้ำชื้นมนขอบ",
  asym: "ปล่อยให้ดินหมาด แล้วตัดขอบเฉียงด้วยมีดบาง ปรับให้ขอบเอียงสมดุลแล้วมนขอบให้นุ่ม",
  fluted: "ขณะดินหมาด ใช้นิ้วหรือเครื่องมือกดร่องรอบขอบปากให้ระยะเท่ากัน",
  flared: "ดึงขอบปากบานออกด้านนอกช้าๆ ระวังผนังบางเกินจนยุบ ใช้ซี่โครงไม้ช่วยพยุง",
};
const FOOT_STEP = {
  flat: "ปล่อยฐานเรียบ เก็บขอบด้านล่างให้มน",
  trimmed: "เมื่อดินหนังแข็ง กลับด้านวางบนแป้น แล้วแต่งฐานด้วยเหล็กขูดให้เป็นวงเท้าเล็กๆ",
  pedestal: "ต่อฐานสูงด้วยดินขด หรือแต่งจากก้อนดินหนาที่เผื่อไว้ตอนตั้งต้น",
};
const HANDLE_STEP = {
  none: null,
  ear: "ทำหูจับทรงเหลี่ยมจากแผ่นดินหนา ตัดและมนมุม ขูดรอยต่อ ทาน้ำดิน แล้วกดติดตามตำแหน่งที่วางไว้",
  loop: "รีดหรือดึงดินเป็นเส้นโค้งรูปตัว C ปล่อยให้หมาด แล้วต่อสองปลายให้สมมาตร",
  lug: "ปั้นก้อนหูเล็กสองข้างให้ขนาดเท่ากัน ติดตรงข้ามกันที่ระดับเดียวกัน",
};

export function buildGuide(rawConfig, skillId = "intermediate") {
  const c = normalizeConfig(rawConfig);
  const a = assess(c, skillId);
  const v = VESSELS[c.vessel];
  const mods = activeMods(c.modulation);
  const steps = [
    "นวดดินไล่ฟองอากาศจนเนื้อเนียน ชั่งน้ำหนักดินให้เผื่อประมาณ 25–30% จากน้ำหนักชิ้นงาน แล้วตั้งกลางแป้นให้ดิ่ง",
    c.texture === "pinch"
      ? `ขึ้นรูป${v.label}ด้วยการบีบมือ เริ่มจากก้อนกลม กดเปิดตรงกลางแล้วบีบผนังทีละรอบให้หนาประมาณ ${c.wall.toFixed(1)} ซม.`
      : `ขึ้นรูป${v.label}บนแป้นหมุน ดึงผนังให้หนาประมาณ ${c.wall.toFixed(1)} ซม. สูง ${Math.round(c.height)} ซม. ส่วนกว้างสุด ${c.belly} ซม.`,
    NECK_STEP[c.neck],
  ];
  if (mods.scallops || mods.ripples) steps.push("ขณะดินหมาด ใช้เครื่องมือกดหรือขูดลวดลายผิวตามที่ออกแบบ ทำให้ระยะห่างสม่ำเสมอ");
  steps.push("ตัดชิ้นงานออกจากแป้น ผึ่งให้หมาด");
  steps.push(FOOT_STEP[c.foot]);
  if (HANDLE_STEP[c.handle]) steps.push(HANDLE_STEP[c.handle]);
  steps.push(FINISH_STEP[c.surface]);
  steps.push(
    "ผึ่งให้แห้งสนิทช้าๆ (แนะนำคลุมผ้าหรือพลาสติกหลวมๆ 2–3 วัน) แล้วเผาดิบ (บิสกิต) ที่ประมาณ 900–1000°C"
  );
  steps.push(
    c.color === RAW_GLAZE
      ? "ชิ้นนี้ไม่เคลือบ — เผาอีกรอบตามอุณหภูมิของดินที่เลือก แล้วขัดผิวให้เนียนตามต้องการ"
      : `เคลือบสี${glazeLabel(c)} (${c.surface === "smooth" ? "เงา" : c.surface === "matte" ? "ด้าน" : "หยาบ"}) เช็ดก้นชิ้นงานให้สะอาด แล้วเผาเคลือบตามอุณหภูมิของดิน/น้ำเคลือบ`
  );

  const lines = [];
  lines.push(`# คู่มือการปั้น — ${v.label} (${v.en})`);
  lines.push("");
  lines.push(`สร้างจาก Mud Magic Studio · ${new Date().toLocaleDateString("th-TH")}`);
  lines.push("");
  lines.push("## สเปกชิ้นงาน");
  lines.push(`- ประเภท: ${v.label}`);
  lines.push(`- ขนาด: สูง ${Math.round(c.height)} ซม. · กว้างสุด ${c.belly} ซม.${c.vessel === "sculpture" ? "" : ` · ผนัง ${c.wall.toFixed(1)} ซม.`}`);
  lines.push(`- ปากภาชนะ: ${NECKS[c.neck].label} · ฐาน: ${FEET[c.foot].label} · หู: ${HANDLES[c.handle].label}`);
  lines.push(`- ดิน: ${CLAYS[c.clay].label} (${TEXTURES[c.texture].label})`);
  lines.push(`- เคลือบ: ${glazeLabel(c)} · พื้นผิว${FINISHES[c.surface].label}`);
  lines.push("");
  lines.push("## ความยาก");
  lines.push(`- ระดับ: ${a.levelLabel} (${a.d5}/5)`);
  lines.push(`- วิธีปั้นที่แนะนำ: ${a.method}`);
  lines.push(`- ความเป็นไปได้สำหรับระดับ${(SKILLS.find((s) => s.id === skillId) || SKILLS[1]).label}: ${a.feasibility}%`);
  a.allNotes.forEach((n) => lines.push(`- ${n}`));
  lines.push("");
  lines.push("## ขั้นตอน");
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");
  lines.push("> หมายเหตุ: ค่าความยากเป็นการประเมินจากสัดส่วนและรายละเอียดของแบบ ไม่ใช่การจำลองทางฟิสิกส์ ให้ทดลองกับชิ้นงานเล็กก่อนเสมอ");
  return lines.join("\n");
}
