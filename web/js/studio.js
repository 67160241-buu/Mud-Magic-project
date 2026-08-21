// studio.js — the actual 3D editor. Everything here is real: geometry is
// rebuilt live from the toolbar state, the "AI" panel is a deterministic
// client-side generator (seeded by the prompt text) that renders genuine
// offscreen snapshots of candidate designs, and Save/Share persist state
// to localStorage / the URL. There is no backend in this build, so no
// network call is faked — the generator says what it is in the UI copy.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildMugGroup,
  disposeMugGroup,
  GLAZES,
  SHAPES,
  HANDLES,
  SURFACES,
  DEFAULT_CONFIG,
} from "./mug-model.js";
import { Sculptor } from "./sculpt.js";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = "mudmagic_design_v1";

function loadInitialConfig() {
  const fromQuery = {};
  const params = new URLSearchParams(window.location.search);
  ["shape", "handle", "surface", "color"].forEach((key) => {
    if (params.get(key)) fromQuery[key] = params.get(key);
  });
  if (Object.keys(fromQuery).length) return { ...DEFAULT_CONFIG, ...fromQuery };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) return { ...DEFAULT_CONFIG, ...saved };
  } catch (err) {
    /* ignore malformed storage */
  }
  return { ...DEFAULT_CONFIG };
}

let config = loadInitialConfig();

/* ------------------------------------------------------------------ */
/* Main viewport scene                                                 */
/* ------------------------------------------------------------------ */
const viewport = document.getElementById("mug-viewport");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 0.95, 3.4);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.1, 0);
camera.position.copy(DEFAULT_CAMERA_POS);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.9;
controls.maxDistance = 5.2;
controls.minPolarAngle = Math.PI * 0.18;
controls.maxPolarAngle = Math.PI * 0.85;
controls.target.copy(DEFAULT_TARGET);
controls.update();

const keyLight = new THREE.DirectionalLight(0xfff4ea, 2.4);
keyLight.position.set(2.6, 3.6, 2.4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 10;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffe9dd, 0.85);
fillLight.position.set(-3, 1.2, -2.2);
scene.add(fillLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(2.4, 48),
  new THREE.ShadowMaterial({ opacity: 0.16 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
ground.receiveShadow = true;
scene.add(ground);

const sculptor = new Sculptor(camera, renderer.domElement, controls);

/* Brush cursor: a ring showing the sculpt brush's size/position while
 * hovering the mesh. Kept as a direct child of the scene (not of mugGroup,
 * which gets fully disposed and rebuilt on every shape change) and
 * positioned each frame by transforming the sculptor's local-space hit
 * point/normal through mugGroup's current world transform. */
const brushCursor = new THREE.Mesh(
  new THREE.RingGeometry(1, 1.06, 32),
  new THREE.MeshBasicMaterial({ color: 0x88452f, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
);
brushCursor.visible = false;
brushCursor.renderOrder = 10;
scene.add(brushCursor);

let mugGroup = null;
function rebuildMug() {
  if (mugGroup) {
    scene.remove(mugGroup);
    disposeMugGroup(mugGroup);
  }
  mugGroup = buildMugGroup(config);
  mugGroup.position.y = -0.5;
  mugGroup.rotation.y = 0.5;
  scene.add(mugGroup);
  sculptor.setTarget(mugGroup.getObjectByName("mug-body"));
}
rebuildMug();

function updateBrushCursor() {
  if (!sculptor.active) {
    brushCursor.visible = false;
    return;
  }
  const localPoint = sculptor.getCursorLocal();
  const localNormal = sculptor.getCursorNormalLocal();
  if (!localPoint) {
    brushCursor.visible = false;
    return;
  }
  brushCursor.visible = true;
  brushCursor.position.copy(localPoint);
  mugGroup.localToWorld(brushCursor.position);
  brushCursor.scale.setScalar(sculptor.brushRadius);
  if (localNormal) {
    const worldNormal = localNormal.clone().transformDirection(mugGroup.matrixWorld);
    brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  }
}

function resizeViewport() {
  const { clientWidth, clientHeight } = viewport;
  if (!clientWidth || !clientHeight) return;
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight);
}
new ResizeObserver(resizeViewport).observe(viewport);
resizeViewport();

let autoRotate = false;
function animate() {
  requestAnimationFrame(animate);
  if (autoRotate) mugGroup.rotation.y += 0.006;
  sculptor.tick();
  updateBrushCursor();
  controls.update();
  renderer.render(scene, camera);
}
animate();

/* ------------------------------------------------------------------ */
/* Toolbar wiring                                                      */
/* ------------------------------------------------------------------ */
const ACTIVE_BTN = ["border-primary", "bg-surface-container-low", "text-primary"];
const INACTIVE_BTN = ["border-outline-variant", "text-on-surface-variant", "bg-white"];

function refreshToolbarState() {
  document.querySelectorAll("[data-shape]").forEach((btn) => {
    const active = btn.dataset.shape === config.shape;
    ACTIVE_BTN.forEach((c) => btn.classList.toggle(c, active));
    INACTIVE_BTN.forEach((c) => btn.classList.toggle(c, !active));
  });
  document.querySelectorAll("[data-handle]").forEach((btn) => {
    const active = btn.dataset.handle === config.handle;
    ACTIVE_BTN.forEach((c) => btn.classList.toggle(c, active));
    INACTIVE_BTN.forEach((c) => btn.classList.toggle(c, !active));
  });
  document.querySelectorAll("[data-surface]").forEach((btn) => {
    const active = btn.dataset.surface === config.surface;
    btn.classList.toggle("border-primary", active);
    btn.classList.toggle("bg-surface-container-low", active);
    btn.classList.toggle("text-primary", active);
    btn.classList.toggle("border-outline-variant", !active);
    btn.classList.toggle("bg-white", !active);
    btn.classList.toggle("text-on-surface-variant", !active);
    const icon = btn.querySelector(".mm-radio-icon");
    if (icon) icon.textContent = active ? "radio_button_checked" : "radio_button_unchecked";
  });
  document.querySelectorAll("[data-color]").forEach((btn) => {
    const active = btn.dataset.color.toLowerCase() === config.color.toLowerCase();
    btn.classList.toggle("ring-2", active);
    btn.classList.toggle("ring-primary", active);
    btn.classList.toggle("ring-offset-2", active);
    btn.classList.toggle("ring-offset-surface", active);
    btn.classList.toggle("ring-1", !active);
    btn.classList.toggle("ring-outline-variant/50", !active);
  });
  const shapeLabel = document.getElementById("mm-config-summary");
  if (shapeLabel) {
    const glaze = GLAZES.find((g) => g.hex.toLowerCase() === config.color.toLowerCase());
    shapeLabel.textContent = `${cap(config.shape)} \u00b7 ${cap(config.handle)} handle \u00b7 ${cap(config.surface)} \u00b7 ${glaze ? glaze.label : "Custom"} glaze`;
  }
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function applyConfig(partial, { persist = true } = {}) {
  config = { ...config, ...partial };
  rebuildMug();
  refreshToolbarState();
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      /* storage disabled — non-fatal */
    }
  }
}

document.querySelectorAll("[data-shape]").forEach((btn) =>
  btn.addEventListener("click", () => applyConfig({ shape: btn.dataset.shape }))
);
document.querySelectorAll("[data-handle]").forEach((btn) =>
  btn.addEventListener("click", () => applyConfig({ handle: btn.dataset.handle }))
);
document.querySelectorAll("[data-surface]").forEach((btn) =>
  btn.addEventListener("click", () => applyConfig({ surface: btn.dataset.surface }))
);
document.querySelectorAll("[data-color]").forEach((btn) =>
  btn.addEventListener("click", () => applyConfig({ color: btn.dataset.color }))
);

refreshToolbarState();

/* ------------------------------------------------------------------ */
/* Sculpt tool: toggle, brush size/strength, push/pull, reset           */
/* ------------------------------------------------------------------ */
const sculptToggleBtn = document.getElementById("mm-sculpt-toggle");
const sculptControls = document.getElementById("mm-sculpt-controls");
const brushSizeInput = document.getElementById("mm-brush-size");
const brushStrengthInput = document.getElementById("mm-brush-strength");
const sculptResetBtn = document.getElementById("mm-sculpt-reset");
const sculptHint = document.getElementById("mm-sculpt-hint");

if (sculptToggleBtn) {
  sculptToggleBtn.addEventListener("click", () => {
    const nextActive = !sculptor.active;
    sculptor.setActive(nextActive);
    sculptToggleBtn.classList.toggle("bg-primary", nextActive);
    sculptToggleBtn.classList.toggle("text-on-primary", nextActive);
    sculptToggleBtn.classList.toggle("bg-white", !nextActive);
    sculptToggleBtn.classList.toggle("text-on-surface-variant", !nextActive);
    if (sculptControls) sculptControls.classList.toggle("hidden", !nextActive);
    if (sculptHint) sculptHint.classList.toggle("hidden", !nextActive);
    if (nextActive) {
      // Auto-rotate and drag-to-sculpt would fight each other over the pointer.
      autoRotate = false;
      if (rotateBtn) rotateBtn.classList.remove("text-primary");
    }
  });
}

if (brushSizeInput) {
  sculptor.setBrushRadius(Number(brushSizeInput.value));
  brushSizeInput.addEventListener("input", () => sculptor.setBrushRadius(Number(brushSizeInput.value)));
}
if (brushStrengthInput) {
  sculptor.setBrushStrength(Number(brushStrengthInput.value));
  brushStrengthInput.addEventListener("input", () => sculptor.setBrushStrength(Number(brushStrengthInput.value)));
}

document.querySelectorAll("[data-sculpt-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    sculptor.setMode(btn.dataset.sculptMode);
    document.querySelectorAll("[data-sculpt-mode]").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("bg-primary", isActive);
      b.classList.toggle("text-on-primary", isActive);
      b.classList.toggle("bg-white", !isActive);
      b.classList.toggle("text-on-surface-variant", !isActive);
    });
  });
});

if (sculptResetBtn) {
  sculptResetBtn.addEventListener("click", () => {
    // Rebuilding from the current preset config discards all sculpt
    // displacement and restores the clean parametric surface.
    rebuildMug();
    window.MudMagic?.showToast("Sculpt reset to base shape", { icon: "restart_alt" });
  });
}
/* ------------------------------------------------------------------ */
const rotateBtn = document.getElementById("mm-rotate-btn");
const zoomBtn = document.getElementById("mm-zoom-btn");
const resetBtn = document.getElementById("mm-reset-btn");

if (rotateBtn) {
  rotateBtn.addEventListener("click", () => {
    autoRotate = !autoRotate;
    rotateBtn.classList.toggle("text-primary", autoRotate);
  });
}
if (zoomBtn) {
  let zoomedIn = false;
  zoomBtn.addEventListener("click", () => {
    zoomedIn = !zoomedIn;
    const targetDistance = zoomedIn ? controls.minDistance + 0.4 : DEFAULT_CAMERA_POS.length();
    const dir = camera.position.clone().sub(controls.target).normalize();
    const newPos = controls.target.clone().add(dir.multiplyScalar(targetDistance));
    animateCameraTo(newPos);
    zoomBtn.classList.toggle("text-primary", zoomedIn);
  });
}
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    autoRotate = false;
    if (rotateBtn) rotateBtn.classList.remove("text-primary");
    if (zoomBtn) zoomBtn.classList.remove("text-primary");
    animateCameraTo(DEFAULT_CAMERA_POS, DEFAULT_TARGET);
  });
}

function animateCameraTo(position, target) {
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endTarget = target || controls.target.clone();
  const duration = 500;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(startPos, position, eased);
    controls.target.lerpVectors(startTarget, endTarget, eased);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ */
/* Top bar: Save / Preview / Share                                     */
/* ------------------------------------------------------------------ */
const saveBtn = document.getElementById("mm-save-btn");
const previewBtn = document.getElementById("mm-preview-btn");
const shareBtn = document.getElementById("mm-share-btn");
const exitPreviewBtn = document.getElementById("mm-exit-preview");

if (saveBtn) {
  saveBtn.addEventListener("click", async () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      window.MudMagic?.showToast("Couldn't save — storage unavailable", { icon: "error" });
      return;
    }

    if (window.MudMagicAPI?.isLoggedIn()) {
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      try {
        await window.MudMagicAPI.saveDesignAsProject(config);
        window.MudMagic?.showToast("Design saved to your account", { icon: "cloud_done" });
      } catch (err) {
        window.MudMagic?.showToast("Saved locally — couldn't reach the account server", { icon: "save" });
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
    } else {
      window.MudMagic?.showToast("Saved to this browser — log in to save to your account", { icon: "save" });
    }
  });
}

function togglePreview(on) {
  document.body.classList.toggle("mm-preview-mode", on);
}
if (previewBtn) previewBtn.addEventListener("click", () => togglePreview(true));
if (exitPreviewBtn) exitPreviewBtn.addEventListener("click", () => togglePreview(false));

if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const params = new URLSearchParams({
      shape: config.shape,
      handle: config.handle,
      surface: config.surface,
      color: config.color,
    });
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", `?${params.toString()}`);
    try {
      await navigator.clipboard.writeText(url);
      window.MudMagic?.showToast("Share link copied to clipboard", { icon: "link" });
    } catch (err) {
      window.MudMagic?.showToast("Link ready in your address bar", { icon: "link" });
    }
  });
}

/* ------------------------------------------------------------------ */
/* AI panel: deterministic, prompt-seeded design generator             */
/* ------------------------------------------------------------------ */
const KEYWORD_MAP = {
  shape: {
    tall: ["tall", "slim", "narrow", "elegant", "elongated"],
    round: ["round", "belly", "bulg", "curvy", "plump"],
    wide: ["wide", "short", "squat", "stout", "chunky"],
  },
  handle: {
    minimal: ["minimal", "sleek", "thin handle", "delicate", "small handle"],
    organic: ["organic", "wavy", "asymmetric", "handmade handle", "sculpted"],
    loop: ["loop", "classic handle", "c-handle", "traditional handle"],
  },
  surface: {
    smooth: ["smooth", "glossy", "glazed", "shiny", "polished"],
    rough: ["rough", "raw", "unglazed", "stoneware", "textured", "rustic", "speckled"],
    matte: ["matte", "satin"],
  },
  color: {
    terracotta: ["terracotta", "clay", "orange", "rust", "burnt"],
    sage: ["green", "sage", "olive", "leaf", "forest"],
    cream: ["cream", "beige", "sand"],
    espresso: ["espresso", "brown", "coffee", "chocolate", "walnut"],
    blush: ["blush", "pink", "rose", "peach"],
    charcoal: ["charcoal", "black", "dark", "graphite"],
    denim: ["blue", "denim", "navy", "indigo", "cobalt"],
    ivory: ["ivory", "white", "snow"],
  },
};

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
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
function pickFromKeywords(promptLower, dict, fallbackList, rng) {
  for (const key of Object.keys(dict)) {
    if (dict[key].some((phrase) => promptLower.includes(phrase))) return key;
  }
  return fallbackList[Math.floor(rng() * fallbackList.length)];
}

function generateVariations(prompt, nonce) {
  const promptLower = prompt.toLowerCase();
  const seed = hashSeed(`${promptLower}::${nonce}`);
  const rng = mulberry32(seed);

  const colorIds = GLAZES.map((g) => g.id);
  const primary = {
    shape: pickFromKeywords(promptLower, KEYWORD_MAP.shape, SHAPES, rng),
    handle: pickFromKeywords(promptLower, KEYWORD_MAP.handle, HANDLES, rng),
    surface: pickFromKeywords(promptLower, KEYWORD_MAP.surface, SURFACES, rng),
    color: GLAZES.find((g) => g.id === pickFromKeywords(promptLower, KEYWORD_MAP.color, colorIds, rng)).hex,
  };

  const variants = [primary];
  while (variants.length < 4) {
    variants.push({
      shape: SHAPES[Math.floor(rng() * SHAPES.length)],
      handle: HANDLES[Math.floor(rng() * HANDLES.length)],
      surface: SURFACES[Math.floor(rng() * SURFACES.length)],
      color: GLAZES[Math.floor(rng() * GLAZES.length)].hex,
    });
  }
  return variants;
}

/* Offscreen renderer reused for every thumbnail snapshot. */
let thumbRenderer, thumbScene, thumbCamera, thumbGroup;
function ensureThumbRig() {
  if (thumbRenderer) return;
  thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(320, 320);
  thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
  thumbScene = new THREE.Scene();
  thumbCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  thumbCamera.position.set(0, 0.75, 3.05);
  thumbCamera.lookAt(0, 0.05, 0);
  const key = new THREE.DirectionalLight(0xfff4ea, 2.3);
  key.position.set(2, 3, 2.2);
  thumbScene.add(key);
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.65));
}
function renderThumbnail(variantConfig) {
  ensureThumbRig();
  if (thumbGroup) {
    thumbScene.remove(thumbGroup);
    disposeMugGroup(thumbGroup);
  }
  thumbGroup = buildMugGroup(variantConfig);
  thumbGroup.position.y = -0.48;
  thumbGroup.rotation.y = 0.65;
  thumbScene.add(thumbGroup);
  thumbRenderer.render(thumbScene, thumbCamera);
  return thumbRenderer.domElement.toDataURL("image/png");
}

const promptInput = document.getElementById("mm-prompt");
const generateBtn = document.getElementById("mm-generate-btn");
const variationGrid = document.getElementById("mm-variation-grid");
let currentVariants = [];
let selectedVariantIndex = 0;
let genNonce = 0;

function renderVariationGrid(variants, selectedIndex = 0) {
  currentVariants = variants;
  selectedVariantIndex = selectedIndex;
  variationGrid.innerHTML = "";
  variants.forEach((variant, i) => {
    const dataUrl = renderThumbnail(variant);
    const tile = document.createElement("div");
    tile.className =
      "mm-variation bg-white rounded-xl p-2 border cursor-pointer relative group transition-all " +
      (i === selectedIndex
        ? "border-primary shadow-sm is-selected"
        : "border-outline-variant/50 hover:border-outline-variant hover:shadow-sm");
    tile.innerHTML = `
      ${i === selectedIndex ? '<div class="absolute top-2 right-2 bg-primary text-white text-[10px] px-2 py-1 rounded-full font-label-sm z-10">Selected</div>' : ""}
      <div class="aspect-square bg-[#F9F7F5] rounded-lg overflow-hidden flex items-center justify-center relative">
        <img class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" src="${dataUrl}" alt="Mug variation: ${variant.shape}, ${variant.handle} handle, ${variant.surface} surface" />
      </div>`;
    tile.addEventListener("click", () => {
      applyConfig(variant);
      renderVariationGrid(currentVariants, i);
    });
    variationGrid.appendChild(tile);
  });
}

if (generateBtn) {
  generateBtn.addEventListener("click", () => {
    const prompt = (promptInput?.value || "").trim() || "warm ceramic mug with an organic glaze";
    genNonce += 1;
    generateBtn.disabled = true;
    generateBtn.classList.add("opacity-70");
    // Small delay purely for perceived-work feedback; the generation
    // itself is synchronous and instant.
    window.setTimeout(() => {
      const variants = generateVariations(prompt, genNonce);
      renderVariationGrid(variants, 0);
      applyConfig(variants[0]);
      generateBtn.disabled = false;
      generateBtn.classList.remove("opacity-70");
      window.MudMagic?.showToast("Generated 4 new variations", { icon: "auto_awesome" });
    }, 380);
  });
}

// Seed the panel with an initial set of variations so it never looks empty.
renderVariationGrid(generateVariations("warm terracotta mug, matte glaze", 0), 0);
