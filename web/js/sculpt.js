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
    this.mode = "push"; // "push" | "pull"
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
    this._displace(hit.point);
  }

  _displace(centerLocal) {
    const geometry = this.target.geometry;
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const radius = this.brushRadius;
    const sign = this.mode === "push" ? 1 : -1;
    // Falloff step size is scaled down so a single frame's drag is a gentle
    // nudge, not a spike — sculpting is a gesture built from many small
    // frame-by-frame displacements, not one big jump per click.
    const step = this.brushStrength * 0.05;

    for (let i = 0; i < position.count; i++) {
      _vertex.fromBufferAttribute(position, i);
      const dist = _vertex.distanceTo(centerLocal);
      if (dist >= radius) continue;

      const t = 1 - dist / radius;
      const falloff = t * t * (3 - 2 * t); // smoothstep: gentle at the rim, fuller at the center

      _normal.fromBufferAttribute(normal, i);
      _displacement.copy(_normal).multiplyScalar(step * falloff * sign);
      _vertex.add(_displacement);
      position.setXYZ(i, _vertex.x, _vertex.y, _vertex.z);
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
