// mug-model.js
// Procedural, parametric ceramic-mug geometry for Mud Magic.
// Builds a hollow lathe-revolved body + a tube-swept handle from a small
// set of design tokens (shape / handle / surface / glaze). No external
// model files are loaded — everything here is generated at runtime so the
// "3D model" is genuinely editable, not a static asset.

import * as THREE from "three";

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
};

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

function buildBodyGeometry(shape) {
  const profile = densifyProfile(profileForShape(shape), 56);
  const geo = new THREE.LatheGeometry(profile, 64);
  geo.computeVertexNormals();
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

  const bodyGeo = buildBodyGeometry(cfg.shape);
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
