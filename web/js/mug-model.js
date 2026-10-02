// mug-model.js
// Procedural, parametric ceramic-mug geometry for Mud Magic.
// Builds a hollow lathe-revolved body + a tube-swept handle from a small
// set of design tokens (shape / handle / surface / glaze). No external
// model files are loaded — everything here is generated at runtime so the
// "3D model" is genuinely editable, not a static asset.

import * as THREE from "three";
import { DEFAULT_MODULATION, hasModulation, modulateRadius } from "./wave.js";

export const GLAZES = [
  { id: "terracotta", label: "Terracotta", hex: "#A65D45" },
  { id: "sage", label: "Sage", hex: "#7C8872" },
  { id: "cream", label: "Cream", hex: "#F3E9DD" },
  { id: "espresso", label: "Espresso", hex: "#3B2A20" },
  { id: "blush", label: "Blush", hex: "#E3A896" },
  { id: "charcoal", label: "Charcoal", hex: "#2B2B2B" },
  { id: "ivory", label: "Ivory", hex: "#FBF6EF" },
  { id: "denim", label: "Denim", hex: "#4C5A66" },
];

export const SHAPES = ["classic", "round", "tall", "wide"];
export const HANDLES = ["minimal", "loop", "organic"];
export const SURFACES = ["smooth", "matte", "rough"];

export const DEFAULT_CONFIG = {
  shape: "classic",
  handle: "loop",
  surface: "matte",
  color: "#A65D45",
  // Surface modulation (scallops / ripples / ruffles). Off by default, so
  // an unset config produces exactly the same mug as before this existed.
  modulation: null,
};

export { DEFAULT_MODULATION };

/** Named modulation presets exposed as one-click "surface pattern" options. */
export const PATTERNS = [
  { id: "none", label: "เรียบ", mod: null },
  {
    id: "flutes",
    label: "ร่องลึก",
    mod: { ...DEFAULT_MODULATION, scallops: 12, scallopMotif: "flutes", scallopDepth: 0.035 },
  },
  {
    id: "reeds",
    label: "สันนูน",
    mod: { ...DEFAULT_MODULATION, scallops: 14, scallopMotif: "reeds", scallopDepth: 0.03 },
  },
  {
    id: "facets",
    label: "เหลี่ยม",
    mod: { ...DEFAULT_MODULATION, scallops: 8, scallopWaveform: "triangle", scallopDepth: 0.04 },
  },
  {
    id: "rings",
    label: "วงรอบ",
    mod: { ...DEFAULT_MODULATION, ripples: 14, rippleWaveform: "sine", rippleDepth: 0.012 },
  },
  {
    id: "twist",
    label: "บิดเกลียว",
    mod: { ...DEFAULT_MODULATION, scallops: 10, scallopDepth: 0.035, ruffles: 1, ruffleDepth: 0.55 },
  },
  {
    id: "wobble",
    label: "ขอบหยัก",
    mod: { ...DEFAULT_MODULATION, scallops: 6, scallopDepth: 0.05, ripples: 5, rippleDepth: 0.015 },
  },
];

/**
 * Returns the lathe revolution profile (outer wall up, rim, inner wall
 * down, interior floor) for a given shape id. Units are arbitrary scene
 * units; body height is normalised to roughly 1.0 before shape scaling.
 */
function profileForShape(shape) {
  // Base "classic" profile: (radius, height) pairs, bottom -> top.
  const base = [
    [0.001, 0.0],
    [0.34, 0.0],
    [0.36, 0.035],
    [0.375, 0.08],
    [0.4, 0.55],
    [0.415, 0.86],
    [0.43, 0.94],
    [0.435, 0.975], // rim outer top
    [0.375, 0.99], // rim lip
    [0.375, 0.93], // inner wall start
    [0.36, 0.55],
    [0.34, 0.12],
    [0.001, 0.09], // interior floor
  ];

  let pts = base.map(([r, y]) => [r, y]);

  if (shape === "round") {
    // Bulge the belly, taper the shoulders in.
    pts = pts.map(([r, y]) => {
      const belly = Math.sin(Math.PI * Math.min(y, 0.95)) * 0.16;
      return [r + belly * (y > 0.05 && y < 0.95 ? 1 : 0.15), y];
    });
  } else if (shape === "tall") {
    pts = pts.map(([r, y]) => [r * 0.86, y * 1.42]);
  } else if (shape === "wide") {
    pts = pts.map(([r, y]) => [r * 1.22, y * 0.72]);
  }

  return pts.map(([r, y]) => new THREE.Vector2(r, y));
}

function buildBodyGeometry(shape, mod) {
  const profile = densifyProfile(profileForShape(shape), 56);
  if (!hasModulation(mod)) {
    // Unmodulated: plain lathe. Cheaper, and keeps the exact geometry the
    // rest of the app was built and tested against.
    const geo = new THREE.LatheGeometry(profile, 64);
    geo.computeVertexNormals();
    return geo;
  }
  return buildRevolvedGeometry(profile, 64, mod);
}

/**
 * Same revolve as THREE.LatheGeometry (identical vertex order, indices and
 * UVs) but the radius of every vertex can be modulated per ring and per
 * side. Lathe can't do this — it spins one profile, so every horizontal
 * slice is a perfect circle. Scallops/flutes need radius to vary *around*
 * the pot, which means generating the surface ourselves.
 */
function buildRevolvedGeometry(points, segments, mod) {
  const geo = new THREE.BufferGeometry();
  const positions = [];
  const uvs = [];
  const indices = [];
  const rows = points.length;

  // Height range of the profile, so "ring" is a normalised 0..1 height
  // rather than a raw index — keeps ripple frequency consistent across
  // shapes with different heights (tall vs wide).
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanY = maxY - minY || 1;

  for (let i = 0; i <= segments; i++) {
    const side = i / segments; // 0..1 around the pot
    const phi = side * Math.PI * 2;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);

    for (let j = 0; j < rows; j++) {
      const p = points[j];
      const ring = (p.y - minY) / spanY;
      const radius = modulateRadius(p.x, ring, side, mod);

      positions.push(radius * sin, p.y, radius * cos);
      uvs.push(side, j / (rows - 1));
    }
  }

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const base = i * rows + j;
      const a = base;
      const b = base + rows;
      const c = base + rows + 1;
      const d = base + 1;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  geo.setIndex(indices);
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Resamples a lathe profile to `targetCount` evenly-spaced points using a
 * Catmull-Rom spline through the original control points. The hand-authored
 * profiles above have ~13 points, which is plenty for a smooth silhouette
 * but far too sparse to sculpt — freeform vertex displacement needs enough
 * vertical resolution to actually push/pull detail into the surface.
 */
function densifyProfile(points, targetCount) {
  const curve = new THREE.SplineCurve(points);
  return curve.getPoints(targetCount - 1);
}

/**
 * Handle geometries are swept tubes along a hand-authored curve. The curve
 * shape (and therefore silhouette) changes per handle style; "organic"
 * additionally breaks left/right symmetry for a hand-thrown feel.
 */
function handleCurve(handle, bodyHeight) {
  const topY = bodyHeight * 0.78;
  const botY = bodyHeight * 0.28;
  const attachR = 0.42;

  let points;
  if (handle === "minimal") {
    points = [
      new THREE.Vector3(attachR - 0.02, bodyHeight * 0.62, 0),
      new THREE.Vector3(attachR + 0.1, bodyHeight * 0.58, 0),
      new THREE.Vector3(attachR + 0.13, bodyHeight * 0.46, 0),
      new THREE.Vector3(attachR + 0.1, bodyHeight * 0.34, 0),
      new THREE.Vector3(attachR - 0.02, bodyHeight * 0.3, 0),
    ];
  } else if (handle === "organic") {
    points = [
      new THREE.Vector3(attachR - 0.01, topY + 0.03, 0.01),
      new THREE.Vector3(attachR + 0.19, topY - 0.02, -0.04),
      new THREE.Vector3(attachR + 0.27, (topY + botY) / 2 + 0.05, 0.05),
      new THREE.Vector3(attachR + 0.21, botY + 0.05, -0.03),
      new THREE.Vector3(attachR - 0.02, botY - 0.02, 0.02),
    ];
  } else {
    // loop (classic C handle)
    points = [
      new THREE.Vector3(attachR - 0.01, topY, 0),
      new THREE.Vector3(attachR + 0.24, topY - 0.02, 0),
      new THREE.Vector3(attachR + 0.31, (topY + botY) / 2, 0),
      new THREE.Vector3(attachR + 0.24, botY + 0.02, 0),
      new THREE.Vector3(attachR - 0.01, botY, 0),
    ];
  }
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

function buildHandleGeometry(handle, shape) {
  const heightScale = shape === "tall" ? 1.42 : shape === "wide" ? 0.72 : 1;
  const radiusScale = shape === "wide" ? 1.22 : shape === "round" ? 1.08 : 1;
  const tubeRadius = handle === "minimal" ? 0.026 : handle === "organic" ? 0.036 : 0.032;

  const curve = handleCurve(handle, heightScale);
  const geo = new THREE.TubeGeometry(curve, 48, tubeRadius, 10, false);
  geo.scale(radiusScale, 1, radiusScale);
  return geo;
}

/** Small canvas-based noise texture, used as a bump map for "rough" glazes. */
let cachedNoiseTexture = null;
function noiseTexture() {
  if (cachedNoiseTexture) return cachedNoiseTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(size, size);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const v = 150 + Math.random() * 105;
    imgData.data[i] = v;
    imgData.data[i + 1] = v;
    imgData.data[i + 2] = v;
    imgData.data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  cachedNoiseTexture = tex;
  return tex;
}

function materialForSurface(surface, colorHex) {
  const color = new THREE.Color(colorHex);
  if (surface === "smooth") {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.18,
      metalness: 0.02,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    });
  }
  if (surface === "rough") {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0,
      bumpMap: noiseTexture(),
      bumpScale: 0.006,
    });
  }
  // matte (default)
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.03,
  });
}

/**
 * Builds a THREE.Group containing the mug body + handle meshes for the
 * given config. Caller owns disposal of the returned group's geometries
 * and materials when it is discarded.
 */
export function buildMugGroup(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const group = new THREE.Group();
  group.name = "mug";

  const bodyGeo = buildBodyGeometry(cfg.shape, cfg.modulation);
  const material = materialForSurface(cfg.surface, cfg.color);
  const body = new THREE.Mesh(bodyGeo, material);
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = "mug-body";
  group.add(body);

  const handleGeo = buildHandleGeometry(cfg.handle, cfg.shape);
  const handle = new THREE.Mesh(handleGeo, material);
  handle.castShadow = true;
  handle.receiveShadow = true;
  handle.name = "mug-handle";
  group.add(handle);

  group.userData.config = cfg;
  return group;
}

export function disposeMugGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Guided-journey helpers: skill levels, difficulty scoring, naming,   */
/* and step-by-step guides. Used by create.html (the AI design         */
/* journey); the free-form Studio doesn't depend on any of this.       */
/* ------------------------------------------------------------------ */
const SHAPE_DIFFICULTY = { classic: 2, wide: 2, round: 5, tall: 7 };
const HANDLE_DIFFICULTY = { minimal: 2, loop: 4, organic: 8 };
const SURFACE_DIFFICULTY = { rough: 2, matte: 4, smooth: 7 };

const SHAPE_NOTES = {
  classic: "ทรงตรงไปตรงมา ควบคุมบนแป้นหมุนง่าย",
  wide: "ทรงเตี้ยกว้าง เซนเตอร์ดินง่ายกว่าทรงสูง",
  round: "ทรงป่องต้องคุมผนังให้บางสม่ำเสมอ ต้องฝึกมือมาบ้าง",
  tall: "ทรงสูงชะลูด ต้องคุมแรงเหวี่ยงและผนังบางให้มั่นคง",
};
const HANDLE_NOTES = {
  minimal: "หูจับเล็กเรียบง่าย ต่อไว เสี่ยงหลุดน้อย",
  loop: "หูจับทรงห่วงคลาสสิก ต้องฝึกต่อหูให้สมมาตร",
  organic: "หูจับทรงอิสระ ต้องมีทักษะปั้นมือระดับสูง",
};
const SURFACE_NOTES = {
  rough: "พื้นผิวหยาบ ให้อภัยรอยมือ เหมาะมือใหม่",
  matte: "พื้นผิวด้าน ต้องเกลี่ยผิวให้เนียนพอสมควร",
  smooth: "พื้นผิวเงามัน ต้องขัดและเคลือบให้เนียนไร้ตำหนิ",
};

export const SKILL_LEVELS = [
  { id: "beginner", label: "Beginner", labelTh: "มือใหม่", maxScore: 10, dot: "#7C8872" },
  { id: "intermediate", label: "Intermediate", labelTh: "ปานกลาง", maxScore: 16, dot: "#C18A52" },
  { id: "advanced", label: "Advanced", labelTh: "มืออาชีพ", maxScore: 22, dot: "#A65D45" },
];

export function computeDifficulty(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const score = SHAPE_DIFFICULTY[cfg.shape] + HANDLE_DIFFICULTY[cfg.handle] + SURFACE_DIFFICULTY[cfg.surface];
  const tier = SKILL_LEVELS.find((s) => score <= s.maxScore) || SKILL_LEVELS[SKILL_LEVELS.length - 1];
  return {
    score,
    level: tier.id,
    levelLabel: tier.label,
    levelLabelTh: tier.labelTh,
    dot: tier.dot,
    reasons: [SHAPE_NOTES[cfg.shape], HANDLE_NOTES[cfg.handle], SURFACE_NOTES[cfg.surface]],
  };
}

export function skillLevelRank(levelId) {
  return SKILL_LEVELS.findIndex((s) => s.id === levelId);
}
export function fitsSkillLevel(config, skillLevelId) {
  return skillLevelRank(computeDifficulty(config).level) <= skillLevelRank(skillLevelId);
}

/** Difficulty presented the way the design mockups show it: "2.5/5".
 * Derived from the same underlying score (range 6..22), rounded to halves. */
export function difficultyOutOf5(score) {
  const scaled = ((score - 6) / (22 - 6)) * 4 + 1; // 6 -> 1, 22 -> 5
  return Math.round(scaled * 2) / 2;
}

/** Feasibility % for a config at a chosen skill level: how comfortably the
 * design sits within that tier. Honest heuristic from the same score —
 * designs near the tier's ceiling get lower feasibility. */
export function feasibilityFor(config, skillLevelId) {
  const { score } = computeDifficulty(config);
  const tier = SKILL_LEVELS.find((s) => s.id === skillLevelId) || SKILL_LEVELS[2];
  const headroom = tier.maxScore - score; // can be negative if design exceeds tier
  return Math.max(40, Math.min(98, Math.round(90 + headroom * 2)));
}

const NAME_SHAPE = { classic: "Classic Cylinder", round: "Organic Form", tall: "Tall Vessel", wide: "Earth Bowl" };
const NAME_SURFACE = { smooth: "Glazed", matte: "Matte", rough: "Raw" };
export function designName(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return `The ${NAME_SURFACE[cfg.surface]} ${NAME_SHAPE[cfg.shape]}`;
}
export function styleChip(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return { smooth: "Glazed", matte: "Matte", rough: "Raw Exterior" }[cfg.surface];
}
export function techniqueFor(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (cfg.handle === "organic") return "Hand Building";
  if (cfg.shape === "wide") return "Pinch Pot";
  return "Wheel Thrown";
}
export function shapeWord(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return { classic: "Symmetrical", round: "Curved", tall: "Elongated", wide: "Wide Base" }[cfg.shape];
}

const SHAPE_STEP = {
  classic: "ขึ้นรูปทรงกระบอกตรงกลางแป้นหมุน คุมผนังให้หนาสม่ำเสมอ",
  wide: "เปิดปากดินให้กว้างแต่เตี้ย เกลี่ยฐานให้กว้างมั่นคงก่อนดึงผนังขึ้น",
  round: "ดึงผนังขึ้นแล้วดันโป่งตรงกลางเบาๆ ระวังผนังบางเกินจนยุบ",
  tall: "ดึงดินขึ้นทีละน้อยหลายรอบ คุมแรงเหวี่ยงไม่ให้เอียงระหว่างทาง",
};
const HANDLE_STEP = {
  minimal: "ปั้นหูจับชิ้นเล็กแล้วแปะติดข้างตัวแก้ว เกลี่ยรอยต่อให้เนียน",
  loop: "รีดดินเป็นเส้นโค้งรูปตัว C แล้วต่อปลายทั้งสองด้านให้สมมาตร",
  organic: "ปั้นหูจับทรงอิสระด้วยมือ ปรับสมดุลให้จับถนัดก่อนติด",
};
const SURFACE_STEP = {
  rough: "ปล่อยผิวแบบดิบหลังแต่งรูปทรง ไม่ต้องขัดมาก เคลือบแบบด้านหนา",
  matte: "ขัดผิวด้วยฟองน้ำให้เรียบพอประมาณ แล้วเคลือบน้ำยาสูตรด้าน",
  smooth: "ขัดผิวหลายรอบให้เนียนไร้รอย แล้วเคลือบมันให้ทั่วอย่างสม่ำเสมอ",
};
export function buildStepGuide(config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return [
    "นวดดินไล่ฟองอากาศจนเนื้อเนียน แล้ววางกึ่งกลางแป้นหมุนให้ดิ่ง",
    SHAPE_STEP[cfg.shape],
    HANDLE_STEP[cfg.handle],
    "ตัดออกจากแป้น ผึ่งให้หมาด แต่งขอบและฐานด้วยเครื่องมือแต่งผิว",
    SURFACE_STEP[cfg.surface],
    "ผึ่งให้แห้งสนิท เผาดิบ (บิสกิต) แล้วเคลือบตามสี/ผิวที่เลือก ก่อนเผาเคลือบรอบสุดท้าย",
  ];
}
