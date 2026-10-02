// pot-mesh.js — PotterDraw-style parametric pot mesh, in plain JavaScript.
//
// This is the engine behind the Studio. It is a hand port of the ideas in
// PotterDraw's CPotGraphics::CalcPotMesh (Chris Korda, GPL-2.0-or-later,
// http://potterdraw.sourceforge.net/):
//
//   * the pot is a stack of rings; each ring's radius comes from a sampled
//     side-profile curve (PotterDraw's spline bar -> `sampleProfile`)
//   * ripples change the radius by height, scallops by angle, ruffles drift
//     the scallop phase with height (see wave.js for the waveform math)
//   * polygon cross-sections, bends (lean lobes), a helical axis, twist and
//     aspect ratio, exactly as in the original property list
//   * the inner wall is the outer wall offset along the surface normal by the
//     wall thickness (outer radius - thickness / cos(atan(slope)))
//
// Studio additions on top of PotterDraw: vessel presets, neck / rim shaping,
// foot profiles, pinch-pot noise, handle paths and glaze/clay colouring.
//
// No three.js in here on purpose — it returns plain typed arrays so the mesh
// can be built, tested and exported without a renderer.

import { modulateRadius, hasModulation, applyMotif } from "./wave.js";
import { VESSELS, CLAYS, RAW_GLAZE, normalizeConfig } from "./vessels.js";

/** Scene units per centimetre (1 unit = 20 cm). */
export const CM = 0.05;
const TAU = Math.PI * 2;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap1 = (x) => x - Math.floor(x);
function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* Value noise (seamless around the pot because it is sampled in 3D)    */
/* ------------------------------------------------------------------ */
function hash3(ix, iy, iz) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export function noise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);
  return lerp(
    lerp(lerp(c000, c100, sx), lerp(c010, c110, sx), sy),
    lerp(lerp(c001, c101, sx), lerp(c011, c111, sx), sy),
    sz
  );
}

/* ------------------------------------------------------------------ */
/* Profile curve                                                         */
/* ------------------------------------------------------------------ */
/**
 * Samples the side-profile curve at `n` evenly spaced heights (PotterDraw's
 * SampleX). Nodes are [radius, height]; the curve is a cubic Hermite spline
 * through them (Catmull-Rom tangents), so it passes through every node the
 * user drags. Result is normalised so the widest ring has radius 1.
 */
export function sampleProfile(nodes, n) {
  const out = sampleProfileRaw(nodes, n);
  const max = maxOf(out);
  for (let k = 0; k < out.length; k++) out[k] /= max;
  return out;
}

function maxOf(arr) {
  let m = 1e-9;
  for (let k = 0; k < arr.length; k++) if (arr[k] > m) m = arr[k];
  return m;
}

/** The widest radius of the un-normalised curve (what sampleProfile divides by). */
export function profileMax(nodes) {
  return maxOf(sampleProfileRaw(nodes, 160));
}

/** Same curve as sampleProfile but in the nodes' own radius units. */
export function sampleProfileRaw(nodes, n) {
  let pts = nodes
    .map((p) => [Math.max(0.02, p[0]), clamp(p[1], 0, 1)])
    .sort((a, b) => a[1] - b[1]);
  const clean = [];
  for (const p of pts) {
    if (clean.length && p[1] - clean[clean.length - 1][1] < 1e-3) clean[clean.length - 1] = p;
    else clean.push(p);
  }
  if (clean.length < 2) clean.push([clean[0][0], clean[0][1] >= 1 ? 0 : 1]);
  clean.sort((a, b) => a[1] - b[1]);
  if (clean[0][1] > 0) clean.unshift([clean[0][0], 0]);
  if (clean[clean.length - 1][1] < 1) clean.push([clean[clean.length - 1][0], 1]);

  const m = clean.length;
  const slope = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = clean[Math.max(0, i - 1)];
    const b = clean[Math.min(m - 1, i + 1)];
    slope[i] = (b[0] - a[0]) / (b[1] - a[1] || 1);
  }

  const out = new Float64Array(n);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const y = n === 1 ? 0 : k / (n - 1);
    while (seg < m - 2 && y > clean[seg + 1][1]) seg++;
    const p0 = clean[seg];
    const p1 = clean[seg + 1];
    const h = p1[1] - p0[1] || 1;
    const t = clamp((y - p0[1]) / h, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    const r =
      (2 * t3 - 3 * t2 + 1) * p0[0] +
      (t3 - 2 * t2 + t) * h * slope[seg] +
      (-2 * t3 + 3 * t2) * p1[0] +
      (t3 - t2) * h * slope[seg + 1];
    out[k] = Math.max(0.02, r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Foot and neck shaping                                                 */
/* ------------------------------------------------------------------ */
function footFactor(kind, t) {
  if (kind === "trimmed") return t < 0.06 ? 0.84 + 0.16 * smooth(0, 0.06, t) : 1;
  if (kind === "pedestal") {
    let f = t < 0.14 ? 0.55 + 0.45 * smooth(0, 0.14, t) : 1;
    if (t < 0.035) f *= 1 + 0.28 * (1 - smooth(0, 0.035, t));
    return f;
  }
  return 1;
}

/** Radius multiplier, radius add (fraction of local radius) and height offset (fraction of H). */
function neckEffect(kind, t, theta) {
  const w = smooth(0.74, 1.0, t);
  switch (kind) {
    case "flared":
      return { rm: 1 + 0.2 * w * w, add: 0, dy: 0 };
    case "fluted":
      return { rm: 1, add: 0.05 * w * Math.cos(theta * 8), dy: 0 };
    case "asym":
      return {
        rm: 1 + 0.1 * Math.pow(w, 1.5) * Math.cos(theta - 0.6),
        add: 0,
        dy: 0.07 * smooth(0.8, 1, t) * Math.cos(theta - 0.6 + Math.PI / 2),
      };
    default:
      return { rm: 1, add: 0, dy: 0 };
  }
}

const SPOUT_THETA = (Math.PI * 3) / 2; // opposite the +x handle

/* ------------------------------------------------------------------ */
/* Colour                                                                */
/* ------------------------------------------------------------------ */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** PotterDraw's texture-coordinate patterns, reduced to a single 0..1 blend value. */
function patternBlend(kind, t, side, lab) {
  const cycles = lab.colorCycles;
  let u;
  if (kind === "stripes") {
    u = (side + Math.sin(t * TAU) * 0.125) * Math.round(cycles);
  } else if (kind === "rings") {
    u = (t + Math.cos(side * TAU * 3) * 0.06) * cycles;
  } else if (kind === "petals") {
    u = (t + Math.cos(side * TAU * Math.max(3, Math.round(cycles))) * 0.5 + Math.sin(t * TAU) * 0.125) * 2;
  } else {
    return 0;
  }
  const v = Math.abs(wrap1(u) * 2 - 1); // triangle wave 0..1
  const w = (1 - lab.colorSharp) * 0.5 + 0.001;
  return smooth(0.5 - w, 0.5 + w, v);
}

/* ------------------------------------------------------------------ */
/* Mesh                                                                  */
/* ------------------------------------------------------------------ */
function computeNormals(pos, idx) {
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      nrm[o] += nx;
      nrm[o + 1] += ny;
      nrm[o + 2] += nz;
    }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l;
    nrm[i + 1] /= l;
    nrm[i + 2] /= l;
  }
  return nrm;
}

/**
 * Builds the pot body.
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array,
 *   indices:Uint32Array, info:object, radiusAt:(f:number)=>number, heightUnits:number, bellyRadius:number}}
 */
export function buildPotMesh(rawConfig, { rings = 112, sides = 112 } = {}) {
  const cfg = normalizeConfig(rawConfig);
  const preset = VESSELS[cfg.vessel];
  const lab = cfg.lab;
  const nR = Math.max(8, rings);
  const nS = Math.max(8, sides);

  const H = cfg.height * CM;
  const Rb = (cfg.belly / 2) * CM;
  const zStep = H / (nR - 1);
  const solid = !!preset.solid;

  const prof = sampleProfile(lab.nodes || preset.nodes, nR);
  const baseR = new Float64Array(nR);
  for (let i = 0; i < nR; i++) baseR[i] = Rb * prof[i] * footFactor(cfg.foot, i / (nR - 1));

  // Legacy mug depths were authored for a 0.4-unit radius; scale to this pot.
  const ampScale = Rb / 0.4;
  let mod = null;
  if (hasModulation(cfg.modulation)) {
    mod = { ...cfg.modulation };
    mod.scallopDepth *= ampScale;
    mod.rippleDepth *= ampScale;
  }

  const wallRaw = clamp(cfg.wall * CM, zStep * 1.5, H * 0.45);
  let iFirstInner = Math.round(wallRaw / zStep);
  iFirstInner = clamp(iFirstInner, 1, nR - 2);
  const wall = iFirstInner * zStep; // snap so the floor sits exactly on a ring

  const innerRings = solid ? 0 : nR - iFirstInner;
  const nOuter = nR * nS;
  const nInner = innerRings * nS;
  const vCount = nOuter + nInner + 2; // + bottom centre + (inner floor | top cap) centre
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);

  const clay = CLAYS[cfg.clay];
  const clayRgb = hexToRgb(clay.hex);
  const speckleRgb = hexToRgb(clay.speckleHex);
  const glazed = cfg.color !== RAW_GLAZE;
  const glazeRgb = glazed ? hexToRgb(cfg.color) : clayRgb;
  const accentRgb = hexToRgb(lab.accent);
  const pinch = cfg.texture === "pinch";
  const rough = cfg.surface === "rough";
  const hasPoly = lab.polySides >= 3;
  const polyN = lab.polySides;

  // PotterDraw polygon roundness constants (per-pot, not per-vertex).
  let polyExp = 0;
  let polyOffset = 0;
  if (hasPoly && lab.polyRound) {
    const fMin = 1 - Math.cos(Math.PI / polyN);
    const b = Math.min(Math.abs(lab.polyRound), 1) * fMin;
    const fExp = fMin - b;
    polyExp = fExp > 1e-12 ? Math.log(fExp) / Math.log(fMin) : Infinity;
    polyOffset = lab.polyRound > 0 ? 0 : b;
  }

  const outerRad = new Float64Array(nOuter);
  const yOff = new Float64Array(nOuter);

  const writeVertex = (index, phi, rad, yy, hx, hz) => {
    const o = index * 3;
    pos[o] = Math.sin(phi) * rad * lab.aspect + hx;
    pos[o + 1] = yy;
    pos[o + 2] = Math.cos(phi) * rad + hz;
  };

  const colorAt = (index, kind, t, side) => {
    const o = index * 3;
    const px = pos[o];
    const py = pos[o + 1];
    const pz = pos[o + 2];
    let c = glazeRgb;
    if (glazed) {
      if (kind === "outer") c = mix3(clayRgb, glazeRgb, smooth(0.012, 0.05, t)); // raw foot ring
      if (lab.colorPattern !== "none") {
        const k = patternBlend(lab.colorPattern, t, side, lab);
        const mask = kind === "outer" ? smooth(0.012, 0.05, t) : 1;
        c = mix3(c, accentRgb, k * mask);
      }
    } else {
      c = clayRgb;
    }
    // speckles show strongly on bare clay, faintly through glaze
    const amount = clay.speckle * (glazed ? 0.35 : 1);
    if (amount > 0.01) {
      const n = noise3(px * 70 + 11, py * 70 + 3, pz * 70 + 7);
      const dot = smooth(1 - 0.32 * amount - 0.06, 1 - 0.32 * amount + 0.04, n);
      c = mix3(c, speckleRgb, dot * 0.72);
    }
    const drift = 1 + 0.07 * (noise3(px * 3.1, py * 3.1, pz * 3.1) - 0.5);
    col[o] = clamp(c[0] * drift, 0, 1);
    col[o + 1] = clamp(c[1] * drift, 0, 1);
    col[o + 2] = clamp(c[2] * drift, 0, 1);
  };

  const helix = (t) => {
    if (!(lab.helixFreq > 0) || !(lab.helixAmp > 0)) return [0, 0];
    const h = t * lab.helixFreq * TAU;
    const a = lab.helixAmp * Rb;
    return [Math.sin(h) * a, (1 - Math.cos(h)) * a];
  };

  /* ---- outer wall ---- */
  for (let i = 0; i < nR; i++) {
    const t = i / (nR - 1);
    const [hx, hz] = helix(t);
    const ringBend = lab.bends > 0 ? applyMotif("none", Math.cos(t * lab.bends * TAU)) : 0;
    for (let j = 0; j < nS; j++) {
      const side = j / nS;
      const theta = side * TAU;
      let rad = baseR[i];

      if (mod) rad = modulateRadius(rad, t, side, mod);

      if (hasPoly) {
        let r = Math.cos(Math.PI / polyN) / Math.cos(wrap1(side * polyN) * (TAU / polyN) - Math.PI / polyN);
        if (lab.polyRound) r = 1 - Math.pow(1 - r, polyExp) - polyOffset;
        if (lab.polyBulge) r = Math.pow(Math.max(r, 0), 1 - lab.polyBulge);
        rad *= r;
      }

      const ne = neckEffect(cfg.neck, t, theta);
      rad = rad * ne.rm + rad * ne.add;
      let dy = ne.dy;

      if (preset.spout) {
        let d = Math.abs(theta - SPOUT_THETA);
        if (d > Math.PI) d = TAU - d;
        const g = Math.exp(-(d * d) / (2 * 0.3 * 0.3));
        rad += 0.42 * baseR[nR - 1] * g * Math.pow(smooth(0.8, 1, t), 2);
        dy -= 0.05 * g * smooth(0.88, 1, t);
      }

      if (lab.bends > 0 && lab.bendDepth > 0) {
        rad += ringBend * Math.cos(side * lab.bendPoles * TAU) * lab.bendDepth * Rb;
      }

      if (pinch) {
        const n1 = noise3(Math.sin(theta) * 1.5 + 5, t * 3.4, Math.cos(theta) * 1.5 + 9) - 0.5;
        const n2 = noise3(Math.sin(theta) * 3.7 + 31, t * 8.2, Math.cos(theta) * 3.7 + 17) - 0.5;
        rad *= 1 + 0.085 * n1 + 0.03 * n2;
      }
      if (rough) {
        rad += (noise3(Math.sin(theta) * 20 + 2, t * 55, Math.cos(theta) * 20 + 6) - 0.5) * 0.004 * Rb * 8;
      }

      rad = Math.max(rad, 0.0005);
      const idx = i * nS + j;
      outerRad[idx] = rad;
      yOff[idx] = dy * H;
      const phi = theta + lab.twist * t * TAU;
      writeVertex(idx, phi, rad, t * H + dy * H, hx, hz);
    }
  }

  /* ---- inner wall ---- */
  const innerBase = nOuter;
  if (!solid) {
    for (let i = iFirstInner; i < nR; i++) {
      const t = i / (nR - 1);
      const [hx, hz] = helix(t);
      for (let j = 0; j < nS; j++) {
        const side = j / nS;
        const theta = side * TAU;
        const idx = i * nS + j;
        let slope = 0;
        if (i > 0 && i < nR - 1) slope = (outerRad[idx + nS] - outerRad[idx - nS]) / (zStep * 2);
        const a = Math.atan(slope);
        const rad = Math.max(outerRad[idx] - wall / Math.cos(a), 0);
        const phi = theta + lab.twist * t * TAU;
        writeVertex(innerBase + (i - iFirstInner) * nS + j, phi, rad, t * H + yOff[idx], hx, hz);
      }
    }
  }

  /* ---- centres ---- */
  const cBottom = nOuter + nInner;
  const cTop = cBottom + 1; // inner floor (open vessels) or top cap (solid)
  {
    const [hx0, hz0] = helix(0);
    pos[cBottom * 3] = hx0;
    pos[cBottom * 3 + 1] = 0;
    pos[cBottom * 3 + 2] = hz0;
    if (solid) {
      const [hx1, hz1] = helix(1);
      pos[cTop * 3] = hx1;
      pos[cTop * 3 + 1] = H;
      pos[cTop * 3 + 2] = hz1;
    } else {
      const [hxf, hzf] = helix(iFirstInner / (nR - 1));
      pos[cTop * 3] = hxf;
      pos[cTop * 3 + 1] = iFirstInner * zStep;
      pos[cTop * 3 + 2] = hzf;
    }
  }

  /* ---- indices ---- */
  const faces = [];
  const wrapJ = (j) => (j + 1 === nS ? 0 : j + 1);
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < nS; j++) {
      const j1 = wrapJ(j);
      const a = i * nS + j;
      const b = i * nS + j1;
      const c = (i + 1) * nS + j;
      const d = (i + 1) * nS + j1;
      faces.push(a, b, c, b, d, c); // outward
    }
  }
  if (!solid) {
    for (let i = iFirstInner; i < nR - 1; i++) {
      for (let j = 0; j < nS; j++) {
        const j1 = wrapJ(j);
        const a = innerBase + (i - iFirstInner) * nS + j;
        const b = innerBase + (i - iFirstInner) * nS + j1;
        const c = innerBase + (i + 1 - iFirstInner) * nS + j;
        const d = innerBase + (i + 1 - iFirstInner) * nS + j1;
        faces.push(a, c, b, b, c, d); // inward
      }
    }
    // lip: outer top ring -> inner top ring, facing up
    const topOuter = (nR - 1) * nS;
    const topInner = innerBase + (nR - 1 - iFirstInner) * nS;
    for (let j = 0; j < nS; j++) {
      const j1 = wrapJ(j);
      faces.push(topOuter + j, topOuter + j1, topInner + j, topOuter + j1, topInner + j1, topInner + j);
    }
    // inner floor, facing up
    const floorRing = innerBase;
    for (let j = 0; j < nS; j++) faces.push(cTop, floorRing + j, floorRing + wrapJ(j));
  } else {
    const topOuter = (nR - 1) * nS;
    for (let j = 0; j < nS; j++) faces.push(cTop, topOuter + j, topOuter + wrapJ(j));
  }
  // outer bottom, facing down
  for (let j = 0; j < nS; j++) faces.push(cBottom, wrapJ(j), j);

  const indices = new Uint32Array(faces);

  /* ---- colour ---- */
  for (let i = 0; i < nR; i++) {
    const t = i / (nR - 1);
    for (let j = 0; j < nS; j++) colorAt(i * nS + j, "outer", t, j / nS);
  }
  if (!solid) {
    for (let i = iFirstInner; i < nR; i++) {
      const t = i / (nR - 1);
      for (let j = 0; j < nS; j++) colorAt(innerBase + (i - iFirstInner) * nS + j, "inner", t, j / nS);
    }
  }
  colorAt(cBottom, "bottom", 0, 0);
  col[cBottom * 3] = clayRgb[0];
  col[cBottom * 3 + 1] = clayRgb[1];
  col[cBottom * 3 + 2] = clayRgb[2];
  colorAt(cTop, "inner", 1, 0);

  const normals = computeNormals(pos, indices);

  const radiusAt = (f) => baseR[clamp(Math.round(f * (nR - 1)), 0, nR - 1)];

  return {
    positions: pos,
    normals,
    colors: col,
    indices,
    heightUnits: H,
    bellyRadius: Rb,
    radiusAt,
    info: {
      heightCm: cfg.height,
      bellyCm: cfg.belly,
      rimCm: (baseR[nR - 1] * 2) / CM,
      rings: nR,
      sides: nS,
      solid,
      wallCm: wall / CM,
      maxRadius: Math.max(Rb * 1.3, ...Array.from(baseR)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Handle paths                                                          */
/* ------------------------------------------------------------------ */
function chaikin(points, rounds) {
  let pts = points;
  for (let r = 0; r < rounds; r++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push([lerp(a[0], b[0], 0.25), lerp(a[1], b[1], 0.25)]);
      next.push([lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75)]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * Handle centre-lines as dense 3D point lists. Computed in the pot's own
 * (radial, height) plane then rotated to each attachment angle, so handles
 * grow out of the real wall of any vessel instead of a fixed mug position.
 * @returns {{points:number[][], radius:number}[]}
 */
export function handlePaths(rawConfig, mesh) {
  const cfg = normalizeConfig(rawConfig);
  if (cfg.handle === "none") return [];
  const preset = VESSELS[cfg.vessel];
  const H = mesh.heightUnits;
  const single = cfg.vessel === "mug" || cfg.vessel === "pitcher";
  const angles = cfg.handle === "lug" || !single ? [Math.PI / 2, -Math.PI / 2] : [Math.PI / 2];
  const [f0, f1] = preset.handleSpan;
  const tubeR = clamp(cfg.height * 0.045, 0.35, 0.9) * CM * (cfg.handle === "lug" ? 1.15 : 1);

  const profileFor = (yTopF, yBotF, out) => {
    // returns [radial, y] samples in the pot's plane
    const yTop = yTopF * H;
    const yBot = yBotF * H;
    const rTop = mesh.radiusAt(yTopF);
    const rBot = mesh.radiusAt(yBotF);
    const inset = tubeR * 0.9;
    if (cfg.handle === "ear") {
      const e = out;
      const d = Math.min(0.12 * (yTop - yBot), tubeR * 3);
      const raw = [
        [rTop - inset, yTop],
        [rTop + e * 0.5, yTop],
        [Math.max(rTop, rBot) + e, yTop - d],
        [Math.max(rTop, rBot) + e, yBot + d],
        [rBot + e * 0.5, yBot],
        [rBot - inset, yBot],
      ];
      return chaikin(raw, 3);
    }
    const pts = [];
    const steps = 40;
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const a = Math.PI * u;
      const y = lerp(yTop, yBot, (1 - Math.cos(a)) / 2);
      const base = lerp(rTop, rBot, u);
      pts.push([base - inset * (1 - Math.sin(a)) + out * Math.pow(Math.sin(a), 0.85), y]);
    }
    return pts;
  };

  const spanCm = (f1 - f0) * cfg.height;
  const out = (cfg.handle === "lug" ? 1.7 : clamp(0.45 * spanCm, 2.2, 5)) * CM;
  let yTopF = f1;
  let yBotF = f0;
  if (cfg.handle === "lug") {
    const mid = (f0 + f1) / 2;
    const halfF = (0.9 / cfg.height) * 1.0;
    yTopF = clamp(mid + halfF, 0.05, 0.98);
    yBotF = clamp(mid - halfF, 0.02, 0.9);
  }
  const plane = profileFor(yTopF, yBotF, out);
  return angles.map((phi) => ({
    radius: tubeR,
    points: plane.map(([xr, y]) => [Math.sin(phi) * xr, y, Math.cos(phi) * xr]),
  }));
}

/* ------------------------------------------------------------------ */
/* Export                                                                */
/* ------------------------------------------------------------------ */
/** Wavefront OBJ text for a set of {name, positions, indices} parts. */
export function toObj(parts) {
  const lines = ["# Mud Magic Studio export", "# 1 unit = 20 cm"];
  let base = 1;
  for (const part of parts) {
    lines.push(`o ${part.name}`);
    for (let i = 0; i < part.positions.length; i += 3) {
      lines.push(`v ${part.positions[i].toFixed(5)} ${part.positions[i + 1].toFixed(5)} ${part.positions[i + 2].toFixed(5)}`);
    }
    for (let i = 0; i < part.indices.length; i += 3) {
      lines.push(`f ${part.indices[i] + base} ${part.indices[i + 1] + base} ${part.indices[i + 2] + base}`);
    }
    base += part.positions.length / 3;
  }
  return lines.join("\n");
}
