// sculpt.js — freeform 3D sculpting via vertex displacement.
//
// Core technique (as opposed to the parametric shape/handle/surface presets
// in mug-model.js): cast a ray from the pointer through the camera into the
// scene, find where it hits the target mesh, then push or pull every vertex
// within a brush radius of that hit point along its normal, with falloff
// based on distance from the brush center. This is what lets someone add
// freeform dents, bumps, and asymmetry on top of a preset shape — the kind
// of detail no dropdown of shape options could offer.
import * as THREE from "three";

const _ndc = new THREE.Vector2();
const _localPoint = new THREE.Vector3();
const _vertex = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _displacement = new THREE.Vector3();

export class Sculptor {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement - the renderer's canvas
   * @param {object} controls - OrbitControls instance, disabled while sculpting
   */
  constructor(camera, domElement, controls) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = controls;
    this.raycaster = new THREE.Raycaster();

    this.target = null; // THREE.Mesh currently being sculpted
    this.active = false; // sculpt mode toggled on/off
    this.mode = "push"; // "push" | "pull" | "smooth"
    this.brushRadius = 0.18;
    this.brushStrength = 0.35;

    this._pointerDown = false;
    this._pointerNdc = null; // latest pointer position in NDC, or null if off-canvas
    this._lastHitLocal = null; // last raycast hit point in the target's local space, for the brush cursor
    this._lastHitNormalLocal = null; // local-space face normal at that hit, for orienting the cursor

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  setTarget(mesh) {
    this.target = mesh;
    this._topology = null; // rebuilt lazily for the new mesh
  }

  /**
   * Welds vertices that share a position (the UV seam, the rim, the base
   * centre) so a stroke moves them together instead of tearing the surface
   * open, and records each welded vertex's neighbours for smoothing.
   */
  _buildTopology() {
    const geometry = this.target.geometry;
    const position = geometry.attributes.position;
    const n = position.count;
    const canon = new Int32Array(n);
    const keyToId = new Map();
    const members = [];
    for (let i = 0; i < n; i++) {
      const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;
      let id = keyToId.get(key);
      if (id === undefined) {
        id = members.length;
        keyToId.set(key, id);
        members.push([]);
      }
      canon[i] = id;
      members[id].push(i);
    }
    const neighbours = members.map(() => new Set());
    const index = geometry.index;
    if (index) {
      for (let t = 0; t < index.count; t += 3) {
        const a = canon[index.getX(t)], b = canon[index.getX(t + 1)], c = canon[index.getX(t + 2)];
        neighbours[a].add(b).add(c);
        neighbours[b].add(a).add(c);
        neighbours[c].add(a).add(b);
      }
    }
    this._topology = { canon, members, neighbours: neighbours.map((set) => Int32Array.from(set)) };
    return this._topology;
  }

  setActive(active) {
    this.active = active;
    if (this.controls) this.controls.enabled = !active;
    if (active) {
      this.domElement.addEventListener("pointerdown", this._onPointerDown);
      this.domElement.addEventListener("pointermove", this._onPointerMove);
      window.addEventListener("pointerup", this._onPointerUp);
    } else {
      this.domElement.removeEventListener("pointerdown", this._onPointerDown);
      this.domElement.removeEventListener("pointermove", this._onPointerMove);
      window.removeEventListener("pointerup", this._onPointerUp);
      this._pointerDown = false;
      this._pointerNdc = null;
    }
  }

  setMode(mode) {
    this.mode = mode;
  }
  setBrushRadius(r) {
    this.brushRadius = r;
  }
  setBrushStrength(s) {
    this.brushStrength = s;
  }

  _updateNdc(event) {
    const rect = this.domElement.getBoundingClientRect();
    _ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._pointerNdc = _ndc.clone();
  }

  _onPointerDown(event) {
    if (event.button !== 0) return; // left click only; other buttons stay free for future use
    this._updateNdc(event);
    this._pointerDown = true;
  }
  _onPointerMove(event) {
    this._updateNdc(event);
  }
  _onPointerUp() {
    this._pointerDown = false;
  }

  /** Raycasts the current pointer position against the target; returns the
   * hit in { point, normal } (both in the target's local space), or null. */
  _raycastLocal() {
    if (!this.target || !this._pointerNdc) return null;
    this.raycaster.setFromCamera(this._pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.target, false);
    if (hits.length === 0) return null;
    _localPoint.copy(hits[0].point);
    this.target.worldToLocal(_localPoint);
    // face.normal from Raycaster is already in the geometry's local (object) space.
    return { point: _localPoint, normal: hits[0].face ? hits[0].face.normal : null };
  }

  /** Call once per animation frame. Applies a displacement step if the
   * sculptor is active, the pointer is down, and it's over the mesh. */
  tick() {
    if (!this.active) return;

    const hit = this._raycastLocal();
    this._lastHitLocal = hit ? hit.point.clone() : null;
    this._lastHitNormalLocal = hit && hit.normal ? hit.normal.clone() : null;

    if (!this._pointerDown || !hit) return;
    this._displace(hit.point, hit.normal);
  }

  _displace(centerLocal, hitNormal) {
    const geometry = this.target.geometry;
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const topo = this._topology || this._buildTopology();
    const radius = this.brushRadius;
    const mode = this.mode;
    const sign = mode === "push" ? 1 : -1;
    // A single frame is a gentle nudge; a stroke is built from many frames.
    const step = this.brushStrength * 0.04;

    // 1. Welded vertices near the brush on the side being touched. Vertices
    //    facing away (the inside wall of a thin pot) are left alone so the two
    //    walls can't be pushed through each other.
    // The relax zone reaches a little past the brush so the edge of a dent
    // blends into the untouched surface instead of leaving a step.
    const reach = radius * 1.4;
    const picked = [];
    const weights = [];
    const relaxW = [];
    const area = new THREE.Vector3();
    for (let id = 0; id < topo.members.length; id++) {
      const i = topo.members[id][0];
      _vertex.fromBufferAttribute(position, i);
      const dist = _vertex.distanceTo(centerLocal);
      if (dist >= reach) continue;
      _normal.fromBufferAttribute(normal, i);
      if (hitNormal && _normal.dot(hitNormal) < -0.3) continue;
      const t = Math.max(0, 1 - dist / radius);
      const falloff = t * t * (3 - 2 * t); // smoothstep: soft at the rim of the brush
      const u = 1 - dist / reach;
      picked.push(id);
      weights.push(falloff);
      relaxW.push(u * u * (3 - 2 * u));
      area.addScaledVector(_normal, falloff);
    }
    if (!picked.length) return;

    // 2. Move along one shared direction (the brush's average normal) rather
    //    than each vertex's own normal: per-vertex normals on a rough or
    //    already-dented surface point every which way, which is what turned
    //    strokes into spikes.
    if (area.lengthSq() < 1e-8) area.copy(hitNormal || _normal);
    area.normalize();
    const next = new Float32Array(picked.length * 3);
    for (let k = 0; k < picked.length; k++) {
      const id = picked[k];
      _vertex.fromBufferAttribute(position, topo.members[id][0]);
      const w = weights[k];
      // 3. Relax toward the neighbours' average so the dent stays smooth.
      //    The smooth brush only does this part, more strongly.
      const nb = topo.neighbours[id];
      const rw = relaxW[k];
      const relax = mode === "smooth" ? 0.5 * rw * Math.min(1, this.brushStrength * 2) : 0.3 * rw;
      if (nb.length && relax > 0) {
        _displacement.set(0, 0, 0);
        for (let j = 0; j < nb.length; j++) {
          const v = topo.members[nb[j]][0];
          _displacement.x += position.getX(v);
          _displacement.y += position.getY(v);
          _displacement.z += position.getZ(v);
        }
        _displacement.multiplyScalar(1 / nb.length);
        _vertex.lerp(_displacement, relax);
      }
      if (mode !== "smooth") _vertex.addScaledVector(area, step * w * sign);
      next[k * 3] = _vertex.x;
      next[k * 3 + 1] = _vertex.y;
      next[k * 3 + 2] = _vertex.z;
    }
    for (let k = 0; k < picked.length; k++) {
      for (const i of topo.members[picked[k]]) position.setXYZ(i, next[k * 3], next[k * 3 + 1], next[k * 3 + 2]);
    }

    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere(); // keep raycasting accurate as the mesh grows/shrinks
  }

  /** Local-space hit point for drawing a brush cursor, or null if not hovering the mesh. */
  getCursorLocal() {
    return this._lastHitLocal;
  }
  /** Local-space surface normal at the last hit, for orienting a brush cursor. */
  getCursorNormalLocal() {
    return this._lastHitNormalLocal;
  }
}
