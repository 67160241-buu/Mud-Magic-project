// pot-engine.js — turns the pure pot mesh (pot-mesh.js) into three.js objects.
//
// buildPotGroup(config) -> THREE.Group containing
//   "pot-body"   the sculptable body (indexed, shared-seam, vertex-coloured)
//   "pot-handle" one tube per handle (not sculptable, same material family)
//
// The group is built in real-world scale (1 unit = 20 cm) with its origin at
// the centre of the base. `group.userData.fit` carries the numbers the studio
// needs to frame it (height, widest radius) and `group.userData.info` the
// dimensions for the on-screen chip.
import * as THREE from "three";
import { buildPotMesh, handlePaths, CM, toObj } from "./pot-mesh.js";
import { normalizeConfig, CLAYS, RAW_GLAZE } from "./vessels.js";

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function surfaceParams(config) {
  const raw = config.color === RAW_GLAZE;
  if (config.surface === "smooth") {
    return raw
      ? { roughness: 0.5, clearcoat: 0.12, clearcoatRoughness: 0.5 }
      : { roughness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.2 };
  }
  if (config.surface === "rough") return { roughness: 0.94, clearcoat: 0, clearcoatRoughness: 1 };
  return raw
    ? { roughness: 0.82, clearcoat: 0, clearcoatRoughness: 1 }
    : { roughness: 0.55, clearcoat: 0.05, clearcoatRoughness: 0.7 };
}

function makeMaterial(config, { vertexColors }) {
  const p = surfaceParams(config);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: p.roughness,
    metalness: 0.02,
    clearcoat: p.clearcoat,
    clearcoatRoughness: p.clearcoatRoughness,
    vertexColors,
  });
  return mat;
}

/**
 * @param {object} rawConfig any studio config (normalised internally)
 * @param {{rings?:number, sides?:number}} [quality]
 */
export function buildPotGroup(rawConfig, quality = {}) {
  const config = normalizeConfig(rawConfig);
  const mesh = buildPotMesh(config, { rings: quality.rings ?? 96, sides: quality.sides ?? 96 });

  const group = new THREE.Group();

  // --- body ---
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  const lin = new Float32Array(mesh.colors.length);
  for (let i = 0; i < lin.length; i++) lin[i] = srgbToLinear(mesh.colors[i]);
  geo.setAttribute("color", new THREE.BufferAttribute(lin, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geo.computeBoundingSphere();

  const body = new THREE.Mesh(geo, makeMaterial(config, { vertexColors: true }));
  body.name = "pot-body";
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // --- handles ---
  const paths = handlePaths(config, mesh);
  if (paths.length) {
    const hex = config.color === RAW_GLAZE ? CLAYS[config.clay].hex : config.color;
    const hMat = makeMaterial(config, { vertexColors: false });
    hMat.color.set(hex);
    paths.forEach((path, i) => {
      const curve = new THREE.CatmullRomCurve3(
        path.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
        false,
        "centripetal"
      );
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, path.radius, 14, false), hMat);
      tube.name = "pot-handle";
      tube.userData.index = i;
      tube.castShadow = true;
      tube.receiveShadow = true;
      group.add(tube);
    });
  }

  const handleReach = paths.reduce(
    (m, p) => Math.max(m, ...p.points.map((pt) => Math.hypot(pt[0], pt[2]))),
    0
  );
  group.userData.info = mesh.info;
  group.userData.fit = {
    height: mesh.heightUnits,
    radius: Math.max(mesh.info.maxRadius, handleReach),
  };
  group.userData.cm = CM;
  return group;
}

export function disposePotGroup(group) {
  if (!group) return;
  const seen = new Set();
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material && !seen.has(obj.material)) {
      seen.add(obj.material);
      obj.material.dispose();
    }
  });
}

/** OBJ text of the current (possibly sculpted) pot, centimetre-scaled. */
export function exportGroupObj(group) {
  const parts = [];
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const pos = obj.geometry.attributes.position;
    const idx = obj.geometry.index;
    if (!pos || !idx) return;
    const scaled = new Float32Array(pos.array.length);
    for (let i = 0; i < scaled.length; i++) scaled[i] = pos.array[i] / CM;
    parts.push({ name: obj.name || "part", positions: scaled, indices: idx.array });
  });
  return toObj(parts).replace("1 unit = 20 cm", "units = centimetres");
}
