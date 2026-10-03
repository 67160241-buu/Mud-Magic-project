// studio.js — the Mud Magic studio editor.
//
// One config object (see vessels.js) drives everything: the 3D pot built by
// pot-engine.js, the profile-curve editor, the feasibility card, the guide
// export and the AI variations. Every control changes the config through
// `apply()`, which rebuilds the pot, refreshes the UI, records undo history and
// autosaves. Nothing here is faked: the feasibility numbers come from the
// heuristic in vessels.js, the variations are real configs rendered to real
// offscreen snapshots, and Save / Share persist the actual config.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildPotGroup, disposePotGroup, exportGroupObj } from "./pot-engine.js";
import { createProfileEditor } from "./profile-editor.js";
import { Sculptor } from "./sculpt.js";
import { aiAvailable } from "./ai-design.js";
import { suggestVessels, remixConfig } from "./vessel-ai.js";
import {
  VESSELS, VESSEL_IDS, NECKS, FEET, HANDLES, CLAYS, TEXTURES, FINISHES, GLAZES, RAW_GLAZE,
  PATTERNS, COLOR_PATTERNS, DEFAULT_LAB, DEFAULT_CONFIG, SKILLS,
  normalizeConfig, encodeConfig, decodeConfig, assess, summaryLine, buildGuide, variationTitle, variationSubtitle,
} from "./vessels.js";

const $ = (id) => document.getElementById(id);
const toast = (msg, icon) => window.MudMagic?.showToast(msg, icon ? { icon } : undefined);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = "mudmagic_design_v2";
const LEGACY_STORAGE_KEY = "mudmagic_design_v1";
const SKILL_KEY = "mudmagic_skill";

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

// ?embed=1 → running inside the create-page wizard: no localStorage autosave
// (it would overwrite the user's own saved Studio design); every change is
// posted to the parent window instead.
const EMBED = new URLSearchParams(window.location.search).get("embed") === "1" && window.parent !== window;

function loadInitialConfig() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("d")) {
    const decoded = decodeConfig(params.get("d"));
    if (decoded) return decoded;
  }
  const legacy = {};
  ["shape", "handle", "surface", "color"].forEach((key) => {
    if (params.get(key)) legacy[key] = params.get(key);
  });
  if (Object.keys(legacy).length) return normalizeConfig(legacy);

  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const saved = JSON.parse(safeGet(key) || "null");
      if (saved) return normalizeConfig(saved);
    } catch (err) {
      /* ignore malformed storage */
    }
  }
  return normalizeConfig(DEFAULT_CONFIG);
}

let config = loadInitialConfig();
let skill = SKILLS.some((s) => s.id === safeGet(SKILL_KEY)) ? safeGet(SKILL_KEY) : "intermediate";
let history = [JSON.stringify(config)];
let historyIndex = 0;

/* ------------------------------------------------------------------ */
/* Main viewport scene                                                 */
/* ------------------------------------------------------------------ */
const viewport = $("mug-viewport");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 0.8, 3.5);
const DEFAULT_TARGET = new THREE.Vector3(0, 0, 0);
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
controls.minDistance = 1.6;
controls.maxDistance = 6;
controls.minPolarAngle = Math.PI * 0.12;
controls.maxPolarAngle = Math.PI * 0.88;
controls.target.copy(DEFAULT_TARGET);
controls.update();

const keyLight = new THREE.DirectionalLight(0xfff4ea, 2.4);
keyLight.position.set(2.6, 3.6, 2.4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 10;
keyLight.shadow.bias = -0.0004; // curved walls shadow themselves; a little bias avoids acne
keyLight.shadow.normalBias = 0.015;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffe9dd, 0.85);
fillLight.position.set(-3, 1.2, -2.2);
scene.add(fillLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const ground = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), new THREE.ShadowMaterial({ opacity: 0.16 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const sculptor = new Sculptor(camera, renderer.domElement, controls);

// Brush cursor: a ring that follows the sculpt brush over the pot.
const brushCursor = new THREE.Mesh(
  new THREE.RingGeometry(1, 1.06, 32),
  new THREE.MeshBasicMaterial({ color: 0x88452f, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
);
brushCursor.visible = false;
brushCursor.renderOrder = 10;
scene.add(brushCursor);

let potGroup = null;
let potScale = 1;
let potRotY = 0.5;
let wireframe = false;
let autoRotate = false;
let rebuildQueued = false;

/** World scale that frames any vessel at roughly the same size on screen. */
function fitScale(group) {
  const { height, radius } = group.userData.fit;
  return Math.min(30, Math.max(0.05, 1.35 / Math.max(height, radius * 2 * 0.85, 0.05)));
}

function rebuildPot() {
  rebuildQueued = false;
  if (potGroup) {
    potRotY = potGroup.rotation.y;
    scene.remove(potGroup);
    disposePotGroup(potGroup);
  }
  potGroup = buildPotGroup(config);
  potScale = fitScale(potGroup);
  potGroup.scale.setScalar(potScale);
  potGroup.position.y = -(potGroup.userData.fit.height * potScale) / 2;
  potGroup.rotation.y = potRotY;
  ground.position.y = potGroup.position.y - 0.003;
  const body = potGroup.getObjectByName("pot-body");
  if (body) body.material.wireframe = wireframe;
  scene.add(potGroup);
  sculptor.setTarget(body);
  updateReadouts();
}

function scheduleRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(rebuildPot);
}

function updateBrushCursor() {
  if (!sculptor.active || !potGroup) {
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
  potGroup.localToWorld(brushCursor.position);
  brushCursor.scale.setScalar(sculptor.brushRadius * potScale);
  if (localNormal) {
    const worldNormal = localNormal.clone().transformDirection(potGroup.matrixWorld);
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

function animate() {
  requestAnimationFrame(animate);
  if (autoRotate && potGroup) potGroup.rotation.y += 0.006;
  sculptor.tick();
  updateBrushCursor();
  controls.update();
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ */
/* UI building blocks                                                  */
/* ------------------------------------------------------------------ */
const OPT_BASE = "border text-xs py-1.5 px-2 rounded-md text-left transition-colors ";
const OPT_ON = "border-primary bg-surface-container-low text-primary font-medium";
const OPT_OFF = "border-outline-variant/60 bg-white text-on-surface-variant hover:border-primary";

/** A grid of single-choice buttons. Returns { refresh(currentId) }. */
function optionGrid(containerId, entries, onPick) {
  const container = $(containerId);
  container.innerHTML = "";
  const buttons = new Map();
  entries.forEach((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.id = entry.id;
    if (entry.title) btn.title = entry.title;
    btn.dataset.extra = entry.extraClass || "";
    btn.className = OPT_BASE + btn.dataset.extra;
    btn.innerHTML = entry.html;
    btn.addEventListener("click", () => onPick(entry.id));
    container.appendChild(btn);
    buttons.set(entry.id, btn);
  });
  return {
    refresh(currentId) {
      buttons.forEach((btn, id) => {
        const on = id === currentId;
        btn.className = OPT_BASE + (btn.dataset.extra || "") + (on ? OPT_ON : OPT_OFF);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    },
  };
}

/** A labelled range slider. spec: {id,label,min,max,step,fmt,get,set,commit} */
const sliders = [];
function addSlider(containerId, spec) {
  const wrap = document.createElement("div");
  wrap.className = "space-y-1";
  wrap.innerHTML = `
    <div class="flex justify-between text-xs text-on-surface-variant">
      <label for="in-${spec.id}">${spec.label}</label>
      <span id="val-${spec.id}" class="font-medium text-on-surface"></span>
    </div>
    <input id="in-${spec.id}" type="range" class="w-full accent-primary h-1 cursor-pointer" />`;
  $(containerId).appendChild(wrap);
  const input = wrap.querySelector("input");
  const out = wrap.querySelector("span");
  input.min = spec.min;
  input.max = spec.max;
  input.step = spec.step;
  const show = (v) => (out.textContent = spec.fmt ? spec.fmt(Number(v)) : String(v));
  input.addEventListener("input", () => {
    show(input.value);
    spec.set(Number(input.value));
  });
  input.addEventListener("change", () => pushHistory());
  const entry = {
    spec,
    input,
    refresh() {
      const range = spec.range ? spec.range() : null;
      if (range) {
        input.min = range[0];
        input.max = range[1];
      }
      if (document.activeElement !== input) input.value = spec.get();
      show(spec.get());
    },
  };
  sliders.push(entry);
  entry.refresh();
  return entry;
}

/* ------------------------------------------------------------------ */
/* Config changes, history, persistence                                */
/* ------------------------------------------------------------------ */
let saveTimer = null;
function persistSoon() {
  window.clearTimeout(saveTimer);
  if (EMBED) {
    saveTimer = window.setTimeout(() => {
      window.parent.postMessage({ type: "mudmagic-studio-config", config: JSON.parse(JSON.stringify(config)) }, window.location.origin);
    }, 120);
    return;
  }
  saveTimer = window.setTimeout(() => {
    const ok = safeSet(STORAGE_KEY, JSON.stringify(config));
    const label = $("mm-save-status");
    if (label) {
      const t = new Date();
      label.textContent = ok
        ? `บันทึกอัตโนมัติ ${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}`
        : "เก็บในเครื่องไม่ได้";
    }
  }, 350);
}

function pushHistory() {
  const snap = JSON.stringify(config);
  if (snap === history[historyIndex]) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > 80) history.shift();
  historyIndex = history.length - 1;
  refreshHistoryButtons();
}
function refreshHistoryButtons() {
  $("mm-undo-btn").disabled = historyIndex <= 0;
  $("mm-redo-btn").disabled = historyIndex >= history.length - 1;
}
function stepHistory(delta) {
  const next = historyIndex + delta;
  if (next < 0 || next >= history.length) return;
  historyIndex = next;
  config = normalizeConfig(JSON.parse(history[historyIndex]));
  scheduleRebuild();
  refreshUI();
  refreshHistoryButtons();
  persistSoon();
}

/**
 * The single entry point for changing the design.
 * @param {object} partial fields to overwrite on the config
 * @param {{commit?:boolean, skipEditor?:boolean}} [opts] commit=false while a slider is being dragged
 */
function apply(partial, { commit = true, skipEditor = false } = {}) {
  config = normalizeConfig({ ...config, ...partial });
  scheduleRebuild();
  refreshUI({ skipEditor });
  persistSoon();
  if (commit) pushHistory();
}
const applyLab = (patch, opts) => apply({ lab: { ...config.lab, ...patch } }, opts);

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */
const vesselGrid = optionGrid(
  "vessel-grid",
  VESSEL_IDS.map((id) => ({
    id,
    title: VESSELS[id].en,
    extraClass: "flex flex-col items-center gap-0.5 text-center ",
    html: `<span class="material-symbols-outlined text-[18px]">${VESSELS[id].icon}</span>${VESSELS[id].label}`,
  })),
  (id) => {
    if (id === config.vessel) return;
    const fresh = normalizeConfig({
      ...config,
      vessel: id,
      height: undefined,
      belly: undefined,
      wall: undefined,
      neck: undefined,
      foot: undefined,
      handle: undefined,
      lab: { ...config.lab, nodes: null },
    });
    apply(fresh);
  }
);

const neckGrid = optionGrid(
  "neck-grid",
  Object.entries(NECKS).map(([id, n]) => ({ id, title: n.en, html: n.label })),
  (id) => apply({ neck: id })
);
const footGrid = optionGrid(
  "foot-grid",
  Object.entries(FEET).map(([id, f]) => ({ id, title: f.en, html: f.label, extraClass: "text-center " })),
  (id) => apply({ foot: id })
);
const handleGrid = optionGrid(
  "handle-grid",
  Object.entries(HANDLES).map(([id, h]) => ({ id, title: h.en, html: h.label })),
  (id) => apply({ handle: id })
);
const clayGrid = optionGrid(
  "clay-grid",
  Object.entries(CLAYS).map(([id, c]) => ({
    id,
    title: c.short,
    html: `<span class="inline-block w-3 h-3 rounded-full border border-outline/30 align-middle mr-1.5" style="background:${c.hex}"></span>${c.label}`,
  })),
  (id) => apply({ clay: id })
);
const textureGrid = optionGrid(
  "texture-grid",
  Object.entries(TEXTURES).map(([id, t]) => ({ id, html: t.label })),
  (id) => apply({ texture: id })
);
const finishGrid = optionGrid(
  "finish-grid",
  Object.entries(FINISHES).map(([id, f]) => ({ id, html: f.label, extraClass: "text-center " })),
  (id) => apply({ surface: id })
);

// Glaze swatches + unglazed + custom colour
const glazeRow = $("glaze-row");
const glazeButtons = [];
GLAZES.forEach((g) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = g.label;
  btn.dataset.color = g.hex;
  btn.setAttribute("aria-label", `สีเคลือบ ${g.label}`);
  btn.className = "w-7 h-7 rounded-full transition-all";
  btn.style.background = g.hex;
  btn.addEventListener("click", () => apply({ color: g.hex }));
  glazeRow.appendChild(btn);
  glazeButtons.push(btn);
});
const rawBtn = document.createElement("button");
rawBtn.type = "button";
rawBtn.title = "ไม่เคลือบ (เห็นเนื้อดิน)";
rawBtn.dataset.color = RAW_GLAZE;
rawBtn.setAttribute("aria-label", "ไม่เคลือบ");
rawBtn.className = "w-7 h-7 rounded-full transition-all flex items-center justify-center bg-white";
rawBtn.innerHTML = '<span class="material-symbols-outlined text-outline" style="font-size:16px;">block</span>';
rawBtn.addEventListener("click", () => apply({ color: RAW_GLAZE }));
glazeRow.appendChild(rawBtn);
glazeButtons.push(rawBtn);
const customColor = document.createElement("input");
customColor.type = "color";
customColor.title = "เลือกสีเอง";
customColor.setAttribute("aria-label", "เลือกสีเคลือบเอง");
customColor.className = "w-7 h-7 p-0 border border-outline-variant rounded-full cursor-pointer bg-white overflow-hidden";
customColor.value = "#A65D45";
customColor.addEventListener("input", () => apply({ color: customColor.value }, { commit: false }));
customColor.addEventListener("change", () => pushHistory());
glazeRow.appendChild(customColor);

function refreshGlaze() {
  const cur = String(config.color).toLowerCase();
  glazeButtons.forEach((btn) => {
    const on = btn.dataset.color.toLowerCase() === cur;
    btn.className =
      "w-7 h-7 rounded-full transition-all flex items-center justify-center " +
      (btn.dataset.color === RAW_GLAZE ? "bg-white " : "") +
      (on ? "ring-2 ring-primary ring-offset-2 ring-offset-white" : "ring-1 ring-outline-variant/60 hover:scale-110");
  });
  if (/^#[0-9a-f]{6}$/i.test(cur)) customColor.value = cur;
}

/* ---- surface pattern (scallops / ripples / ruffles) ---- */
function isRippleMod(mod) {
  return !!mod && mod.ripples > 0 && !(mod.scallops > 0);
}
function inferPatternId(mod) {
  if (!mod) return "none";
  const hit = PATTERNS.find(
    (p) =>
      p.mod &&
      p.mod.scallopMotif === mod.scallopMotif &&
      p.mod.scallopWaveform === mod.scallopWaveform &&
      p.mod.ripples > 0 === mod.ripples > 0 &&
      p.mod.scallops > 0 === mod.scallops > 0 &&
      p.mod.ruffles > 0 === mod.ruffles > 0
  );
  return hit ? hit.id : null; // null = a custom mix; keep the sliders visible, highlight nothing
}
let activePatternId = inferPatternId(config.modulation) || "none";

const patternGrid = optionGrid(
  "pattern-grid",
  PATTERNS.map((p) => ({ id: p.id, html: p.label, extraClass: "text-center " })),
  (id) => {
    activePatternId = id;
    const preset = PATTERNS.find((p) => p.id === id);
    apply({ modulation: preset && preset.mod ? { ...preset.mod } : null });
  }
);

function patternPart(mod) {
  const ripple = isRippleMod(mod);
  return {
    count: mod ? (ripple ? mod.ripples : mod.scallops) : 12,
    depth: mod ? (ripple ? mod.rippleDepth / 0.4 : mod.scallopDepth) : 0.035,
    twist: mod && mod.ruffles > 0 ? mod.ruffleDepth : 0,
  };
}
function editPattern(patch) {
  const mod = config.modulation ? { ...config.modulation } : null;
  if (!mod) return;
  const cur = patternPart(mod);
  const next = { ...cur, ...patch };
  if (isRippleMod(mod)) {
    mod.ripples = next.count;
    mod.rippleDepth = next.depth * 0.4;
  } else {
    mod.scallops = next.count;
    mod.scallopDepth = next.depth;
    if (mod.ripples > 0) mod.rippleDepth = next.depth * 0.4;
  }
  if (next.twist > 0) {
    mod.ruffles = mod.ruffles || 1;
    mod.ruffleDepth = next.twist;
  } else {
    mod.ruffles = 0;
  }
  apply({ modulation: mod }, { commit: false });
}
addSlider("pattern-controls", {
  id: "pat-count", label: "จำนวนร่อง/วง", min: 3, max: 28, step: 1,
  get: () => patternPart(config.modulation).count, set: (v) => editPattern({ count: v }),
});
addSlider("pattern-controls", {
  id: "pat-depth", label: "ความลึก", min: 0.005, max: 0.09, step: 0.005, fmt: (v) => v.toFixed(3),
  get: () => patternPart(config.modulation).depth, set: (v) => editPattern({ depth: v }),
});
addSlider("pattern-controls", {
  id: "pat-twist", label: "บิดเกลียว", min: 0, max: 1.2, step: 0.05, fmt: (v) => v.toFixed(2),
  get: () => patternPart(config.modulation).twist, set: (v) => editPattern({ twist: v }),
});

/* ---- geometry sliders ---- */
addSlider("geo-sliders", {
  id: "height", label: "ความสูง", min: 5, max: 45, step: 0.5, fmt: (v) => `${Math.round(v * 10) / 10} ซม.`,
  range: () => VESSELS[config.vessel].height, get: () => config.height, set: (v) => apply({ height: v }, { commit: false }),
});
addSlider("geo-sliders", {
  id: "belly", label: "เส้นผ่านศูนย์กลางตัว", min: 6, max: 36, step: 0.5, fmt: (v) => `${Math.round(v * 10) / 10} ซม.`,
  range: () => VESSELS[config.vessel].belly, get: () => config.belly, set: (v) => apply({ belly: v }, { commit: false }),
});
addSlider("geo-sliders", {
  id: "wall", label: "ความหนาผนัง", min: 0.4, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)} ซม.`,
  range: () => VESSELS[config.vessel].wall, get: () => config.wall, set: (v) => apply({ wall: v }, { commit: false }),
});

/* ---- lab sliders ---- */
const labSlider = (container, key, label, min, max, step, fmt) =>
  addSlider(container, {
    id: `lab-${key}`, label, min, max, step, fmt,
    get: () => (key === "polySides" && config.lab.polySides < 3 ? 0 : config.lab[key]),
    set: (v) => applyLab({ [key]: key === "polySides" && v < 3 ? 0 : v }, { commit: false }),
  });
const f2 = (v) => v.toFixed(2);
labSlider("lab-sliders-shape", "polySides", "หน้าตัดหลายเหลี่ยม", 0, 12, 1, (v) => (v < 3 ? "กลม" : `${v} ด้าน`));
labSlider("lab-sliders-shape", "polyRound", "ความมนของมุม", -1, 1, 0.05, f2);
labSlider("lab-sliders-shape", "polyBulge", "ความป่องของด้าน", 0, 0.9, 0.05, f2);
labSlider("lab-sliders-shape", "aspect", "ยืดหน้าตัด (กว้าง/ลึก)", 0.5, 1.8, 0.05, f2);
labSlider("lab-sliders-shape", "twist", "บิดหน้าตัด (รอบ)", -2, 2, 0.05, f2);
labSlider("lab-sliders-shape", "bends", "จำนวนรอบโยกตัว", 0, 8, 0.5, (v) => (v === 0 ? "ปิด" : String(v)));
labSlider("lab-sliders-shape", "bendDepth", "ความลึกการโยก", 0, 0.4, 0.01, f2);
labSlider("lab-sliders-shape", "bendPoles", "จำนวนกลีบโยก", 1, 8, 1);
labSlider("lab-sliders-shape", "helixFreq", "เกลียวทั้งตัว (รอบ)", 0, 4, 0.1, (v) => (v === 0 ? "ปิด" : v.toFixed(1)));
labSlider("lab-sliders-shape", "helixAmp", "ความกว้างเกลียว", 0, 0.6, 0.02, f2);
labSlider("lab-sliders-color", "colorCycles", "จำนวนลาย", 1, 16, 1);
labSlider("lab-sliders-color", "colorSharp", "ความคมของลาย", 0, 1, 0.05, f2);

const cpatGrid = optionGrid(
  "cpat-grid",
  Object.entries(COLOR_PATTERNS).map(([id, c]) => ({ id, html: c.label, extraClass: "text-center " })),
  (id) => applyLab({ colorPattern: id })
);
$("in-accent").addEventListener("input", (e) => applyLab({ accent: e.target.value }, { commit: false }));
$("in-accent").addEventListener("change", () => pushHistory());

/* ---- profile editor ---- */
const profileEditor = createProfileEditor($("profile-canvas"), {
  onChange: (nodes) => applyLab({ nodes }, { commit: false, skipEditor: true }),
  onCommit: (nodes) => applyLab({ nodes }, { commit: true, skipEditor: true }),
});
$("profile-delete").addEventListener("click", () => {
  if (!profileEditor.deleteSelected()) toast("เลือกจุดบนเส้นโค้งก่อน (ต้องเหลืออย่างน้อย 3 จุด)", "info");
});
$("profile-reset").addEventListener("click", () => {
  applyLab({ nodes: null });
});
$("lab-reset").addEventListener("click", () => {
  apply({ lab: { ...DEFAULT_LAB } });
  toast("ล้างค่าห้องทดลองแล้ว", "restart_alt");
});
$("lab-panel").addEventListener("toggle", () => profileEditor.redraw());

/* ---- skill level ---- */
const skillGrid = optionGrid(
  "skill-grid",
  SKILLS.map((s) => ({ id: s.id, title: s.labelEn, html: s.label, extraClass: "flex-1 text-center !px-1 !py-1 text-[11px] " })),
  (id) => {
    skill = id;
    safeSet(SKILL_KEY, id);
    refreshUI({ skipEditor: true });
  }
);

/* ------------------------------------------------------------------ */
/* Readouts: feasibility card, dimensions, summary                     */
/* ------------------------------------------------------------------ */
function updateAssessment() {
  const a = assess(config, skill);
  const pct = $("feas-pct");
  const dot = $("feas-dot");
  let tone = "secondary";
  if (a.feasibility < 50) tone = "error";
  else if (a.feasibility < 75) tone = "tertiary";
  pct.textContent = `${a.feasibility}% ทำได้`;
  pct.className =
    "text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap " +
    { secondary: "text-secondary bg-secondary-container/70", tertiary: "text-tertiary bg-tertiary-fixed", error: "text-error bg-error-container" }[tone];
  dot.className = "w-2 h-2 rounded-full animate-pulse " + { secondary: "bg-secondary", tertiary: "bg-tertiary-container", error: "bg-error" }[tone];
  $("feas-level").textContent = `${a.levelLabel} · ${a.d5}/5`;
  $("feas-method").textContent = a.method;
  $("feas-notes").textContent = a.notes.join(" ");
}

function updateReadouts() {
  updateAssessment();
  const info = potGroup?.userData.info;
  const sculpture = VESSELS[config.vessel].solid;
  const chip = [`สูง ${round1(config.height)} ซม.`, `กว้าง ${round1(config.belly)} ซม.`];
  if (info && !sculpture) chip.push(`ปาก ${round1(info.rimCm)} ซม.`);
  $("dim-chip").textContent = chip.join(" · ");
}
const round1 = (n) => Math.round(n * 10) / 10;

/** Syncs every control to the current config. */
function refreshUI({ skipEditor = false } = {}) {
  vesselGrid.refresh(config.vessel);
  neckGrid.refresh(config.neck);
  footGrid.refresh(config.foot);
  handleGrid.refresh(config.handle);
  clayGrid.refresh(config.clay);
  textureGrid.refresh(config.texture);
  finishGrid.refresh(config.surface);
  skillGrid.refresh(skill);
  cpatGrid.refresh(config.lab.colorPattern);
  const inferred = inferPatternId(config.modulation);
  if (inferred !== null) activePatternId = inferred;
  patternGrid.refresh(inferred === null ? "" : activePatternId);
  $("pattern-controls").classList.toggle("hidden", !config.modulation);
  $("lab-sliders-color").classList.toggle("hidden", config.lab.colorPattern === "none");
  $("in-accent").value = config.lab.accent;
  refreshGlaze();
  sliders.forEach((s) => s.refresh());
  if (!skipEditor) profileEditor.setNodes(config.lab.nodes || VESSELS[config.vessel].nodes);
  $("dim-summary").textContent = `${round1(config.height)} × ${round1(config.belly)} ซม.`;
  $("mm-config-summary").textContent = summaryLine(config);
  updateAssessment();
}

/* ------------------------------------------------------------------ */
/* Viewport controls                                                   */
/* ------------------------------------------------------------------ */
const rotateBtn = $("mm-rotate-btn");
const zoomBtn = $("mm-zoom-btn");
const wireBtn = $("mm-wire-btn");

rotateBtn.addEventListener("click", () => {
  autoRotate = !autoRotate;
  rotateBtn.classList.toggle("text-primary", autoRotate);
});
let zoomedIn = false;
zoomBtn.addEventListener("click", () => {
  zoomedIn = !zoomedIn;
  const targetDistance = zoomedIn ? controls.minDistance + 0.5 : DEFAULT_CAMERA_POS.length();
  const dir = camera.position.clone().sub(controls.target).normalize();
  animateCameraTo(controls.target.clone().add(dir.multiplyScalar(targetDistance)));
  zoomBtn.classList.toggle("text-primary", zoomedIn);
});
wireBtn.addEventListener("click", () => {
  wireframe = !wireframe;
  wireBtn.classList.toggle("text-primary", wireframe);
  const body = potGroup?.getObjectByName("pot-body");
  if (body) body.material.wireframe = wireframe;
});
$("mm-reset-btn").addEventListener("click", () => {
  autoRotate = false;
  zoomedIn = false;
  rotateBtn.classList.remove("text-primary");
  zoomBtn.classList.remove("text-primary");
  animateCameraTo(DEFAULT_CAMERA_POS, DEFAULT_TARGET);
});

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
/* Sculpt tool                                                         */
/* ------------------------------------------------------------------ */
const sculptToggleBtn = $("mm-sculpt-toggle");
const STRENGTH_SCALE = 0.5; // pots are smaller in scene units than the old mug
sculptor.setBrushRadius(Number($("mm-brush-size").value));
sculptor.setBrushStrength(Number($("mm-brush-strength").value) * STRENGTH_SCALE);

sculptToggleBtn.addEventListener("click", () => {
  const next = !sculptor.active;
  sculptor.setActive(next);
  sculptToggleBtn.classList.toggle("bg-primary", next);
  sculptToggleBtn.classList.toggle("text-on-primary", next);
  sculptToggleBtn.classList.toggle("bg-white", !next);
  sculptToggleBtn.classList.toggle("text-on-surface-variant", !next);
  $("mm-sculpt-controls").classList.toggle("hidden", !next);
  $("mm-sculpt-hint").classList.toggle("hidden", !next);
  if (next) {
    autoRotate = false;
    rotateBtn.classList.remove("text-primary");
  }
});
$("mm-brush-size").addEventListener("input", (e) => sculptor.setBrushRadius(Number(e.target.value)));
$("mm-brush-strength").addEventListener("input", (e) => sculptor.setBrushStrength(Number(e.target.value) * STRENGTH_SCALE));
document.querySelectorAll("[data-sculpt-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    sculptor.setMode(btn.dataset.sculptMode);
    document.querySelectorAll("[data-sculpt-mode]").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("bg-primary", on);
      b.classList.toggle("text-on-primary", on);
      b.classList.toggle("bg-white", !on);
      b.classList.toggle("text-on-surface-variant", !on);
    });
  });
});
$("mm-sculpt-reset").addEventListener("click", () => {
  rebuildPot();
  toast("ล้างการปั้นอิสระ กลับเป็นทรงตั้งต้นแล้ว", "restart_alt");
});

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadGuide() {
  const md = buildGuide(config, skill);
  download(`mud-magic-${config.vessel}-guide.md`, md, "text/markdown;charset=utf-8");
  toast("ดาวน์โหลดคู่มือการปั้นแล้ว", "description");
}
$("mm-guide-btn").addEventListener("click", downloadGuide);
$("export-guide").addEventListener("click", downloadGuide);
$("export-obj").addEventListener("click", () => {
  if (!potGroup) return;
  download(`mud-magic-${config.vessel}.obj`, exportGroupObj(potGroup), "text/plain;charset=utf-8");
  toast("ดาวน์โหลดโมเดล 3D (.obj) แล้ว — หน่วยเป็นเซนติเมตร", "deployed_code");
});

$("mm-undo-btn").addEventListener("click", () => stepHistory(-1));
$("mm-redo-btn").addEventListener("click", () => stepHistory(1));
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    stepHistory(-1);
  } else if ((k === "z" && e.shiftKey) || k === "y") {
    e.preventDefault();
    stepHistory(1);
  }
});

$("mm-save-btn").addEventListener("click", async () => {
  if (!safeSet(STORAGE_KEY, JSON.stringify(config))) {
    toast("บันทึกไม่ได้ — พื้นที่จัดเก็บใช้งานไม่ได้", "error");
    return;
  }
  if (window.MudMagicAPI?.isLoggedIn()) {
    const btn = $("mm-save-btn");
    btn.disabled = true;
    try {
      const name = `${VESSELS[config.vessel].label} — ${new Date().toLocaleString("th-TH")}`;
      await window.MudMagicAPI.saveDesignAsProject(config, name);
      toast("บันทึกแบบเข้าบัญชีของคุณแล้ว", "cloud_done");
    } catch (err) {
      toast("บันทึกลงเครื่องแล้ว — เชื่อมต่อเซิร์ฟเวอร์บัญชีไม่ได้", "save");
    } finally {
      btn.disabled = false;
    }
  } else {
    toast("บันทึกลงเบราว์เซอร์นี้แล้ว — เข้าสู่ระบบเพื่อบันทึกเข้าบัญชี", "save");
  }
});

function togglePreview(on) {
  document.body.classList.toggle("mm-preview-mode", on);
  window.setTimeout(resizeViewport, 50);
}
$("mm-preview-btn").addEventListener("click", () => togglePreview(true));
$("mm-exit-preview").addEventListener("click", () => togglePreview(false));

$("mm-share-btn").addEventListener("click", async () => {
  const query = `?d=${encodeConfig(config)}`;
  const url = `${window.location.origin}${window.location.pathname}${query}`;
  window.history.replaceState(null, "", query);
  try {
    await navigator.clipboard.writeText(url);
    toast("คัดลอกลิงก์แชร์แล้ว", "link");
  } catch (err) {
    toast("ลิงก์พร้อมแล้วในแถบที่อยู่เบราว์เซอร์", "link");
  }
});

/* ------------------------------------------------------------------ */
/* AI panel                                                            */
/* ------------------------------------------------------------------ */
let thumbRenderer = null;
let thumbScene = null;
let thumbCamera = null;
function ensureThumbRig() {
  if (thumbRenderer) return;
  thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(320, 320);
  thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
  thumbScene = new THREE.Scene();
  thumbCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  thumbCamera.position.set(0, 0.6, 3.5);
  thumbCamera.lookAt(0, -0.02, 0);
  const key = new THREE.DirectionalLight(0xfff4ea, 2.3);
  key.position.set(2, 3, 2.2);
  thumbScene.add(key);
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.65));
}
function renderThumbnail(cfg) {
  ensureThumbRig();
  const group = buildPotGroup(cfg, { rings: 56, sides: 56 });
  const s = fitScale(group);
  group.scale.setScalar(s);
  group.position.y = -(group.userData.fit.height * s) / 2;
  group.rotation.y = 0.65;
  thumbScene.add(group);
  thumbRenderer.render(thumbScene, thumbCamera);
  const url = thumbRenderer.domElement.toDataURL("image/png");
  thumbScene.remove(group);
  disposePotGroup(group);
  return url;
}

const promptInput = $("mm-prompt");
const generateBtn = $("mm-generate-btn");
const variationGrid = $("mm-variation-grid");
let designs = [];
let thumbs = [];
let selectedIndex = 0;
let genNonce = 0;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setVariations(list, selected = 0) {
  designs = list;
  selectedIndex = selected;
  thumbs = list.map((d) => {
    try {
      return renderThumbnail(d.config);
    } catch (err) {
      return "";
    }
  });
  $("variation-count").textContent = `${list.length} แบบ`;
  drawVariations();
}

function drawVariations() {
  variationGrid.innerHTML = "";
  designs.forEach((d, i) => {
    const on = i === selectedIndex;
    const tile = document.createElement("div");
    tile.className =
      "mm-variation bg-white rounded-xl p-2 border cursor-pointer relative group transition-all " +
      (on ? "border-primary shadow-sm is-selected" : "border-outline-variant/50 hover:border-primary/60 hover:shadow-sm");
    tile.innerHTML = `
      ${on ? '<div class="absolute top-2 right-2 bg-primary text-white text-[10px] px-2 py-0.5 rounded-full font-label-sm z-10 shadow-sm">ที่เลือก</div>' : ""}
      <div class="aspect-square bg-[#F9F7F5] rounded-lg overflow-hidden flex items-center justify-center relative">
        ${thumbs[i] ? `<img class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" src="${thumbs[i]}" alt="${esc(d.name)}" />` : ""}
      </div>
      <div class="mt-2 px-1 pb-1">
        <p class="font-label-sm text-xs font-semibold text-on-surface truncate">${esc(d.name)}</p>
        <p class="text-[10px] text-on-surface-variant truncate">${esc(d.rationale || "")}</p>
      </div>`;
    tile.addEventListener("click", () => {
      selectedIndex = i;
      apply(d.config);
      drawVariations();
    });
    variationGrid.appendChild(tile);
  });
}

function seedVariations() {
  const others = remixConfig(config, 1, 3);
  setVariations(
    [{ name: variationTitle(config, 0), rationale: variationSubtitle(config), config }, ...others.map((o, i) => ({ ...o, name: variationTitle(o.config, i + 1) }))],
    0
  );
}

generateBtn.addEventListener("click", async () => {
  const prompt = (promptInput.value || "").trim() || `${VESSELS[config.vessel].label} สไตล์อบอุ่น งานทำมือ`;
  genNonce += 1;
  generateBtn.disabled = true;
  generateBtn.classList.add("opacity-70");
  const original = generateBtn.innerHTML;
  generateBtn.textContent = "กำลังคิดแบบ...";
  try {
    const { designs: out, source, notice } = await suggestVessels(prompt, {
      count: 4,
      seed: genNonce,
      fallbackVessel: config.vessel,
      skillLevel: skill,
    });
    setVariations(out, 0);
    apply(out[0].config);
    toast(notice || (source === "openai" ? "AI สร้างแบบใหม่ 4 แบบแล้ว" : "สร้างตัวเลือกใหม่ 4 แบบแล้ว"), notice ? "info" : "auto_awesome");
  } finally {
    generateBtn.disabled = false;
    generateBtn.classList.remove("opacity-70");
    generateBtn.innerHTML = original;
  }
});

$("prompt-clear").addEventListener("click", () => {
  promptInput.value = "";
  promptInput.focus();
});
const CHIPS = ["ปากบาน", "ปากเบี้ยว", "บีบมือ", "เคลือบเซจ", "ดินทรายจุดด่าง", "ร่องลึก", "ผิวด้าน", "ฐานสูง"];
CHIPS.forEach((phrase) => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "text-[11px] font-label-sm bg-surface-variant/80 hover:bg-surface-variant text-on-surface-variant px-2.5 py-1 rounded-full transition-colors";
  chip.textContent = `+ ${phrase}`;
  chip.addEventListener("click", () => {
    const cur = promptInput.value.trim();
    promptInput.value = cur ? `${cur} ${phrase}` : phrase;
  });
  $("prompt-chips").appendChild(chip);
});

$("mm-remix-btn").addEventListener("click", () => {
  genNonce += 1;
  const base = designs[selectedIndex]?.config || config;
  const out = remixConfig(base, genNonce, 3);
  setVariations(
    [{ name: variationTitle(base, 0), rationale: variationSubtitle(base), config: base }, ...out.map((o, i) => ({ ...o, name: variationTitle(o.config, i + 1) }))],
    0
  );
  toast("สร้างแบบใหม่จากแบบที่เลือกแล้ว", "tune");
});

/* compare */
const modal = $("compare-modal");
function closeCompare() {
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}
$("compare-close").addEventListener("click", closeCompare);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeCompare();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCompare();
});
$("mm-compare-btn").addEventListener("click", () => {
  const body = $("compare-body");
  body.innerHTML = "";
  designs.forEach((d, i) => {
    const a = assess(d.config, skill);
    const c = normalizeConfig(d.config);
    const card = document.createElement("div");
    card.className = "bg-white rounded-xl border border-outline-variant/50 p-3 space-y-2 flex flex-col";
    card.innerHTML = `
      <div class="aspect-square bg-[#F9F7F5] rounded-lg overflow-hidden">${thumbs[i] ? `<img class="w-full h-full object-cover" src="${thumbs[i]}" alt="${esc(d.name)}" />` : ""}</div>
      <p class="font-label-sm text-xs font-semibold text-on-surface">${esc(d.name)}</p>
      <dl class="text-[11px] text-on-surface-variant space-y-1 flex-1">
        <div class="flex justify-between gap-2"><dt>ความยาก</dt><dd class="font-medium text-on-surface">${a.levelLabel} · ${a.d5}/5</dd></div>
        <div class="flex justify-between gap-2"><dt>ทำได้</dt><dd class="font-medium text-on-surface">${a.feasibility}%</dd></div>
        <div class="flex justify-between gap-2"><dt>ขนาด</dt><dd class="font-medium text-on-surface">${round1(c.height)} × ${round1(c.belly)} ซม.</dd></div>
        <div class="flex justify-between gap-2"><dt>ดิน</dt><dd class="font-medium text-on-surface">${esc(CLAYS[c.clay].label)}</dd></div>
        <div class="flex justify-between gap-2"><dt>วิธี</dt><dd class="font-medium text-on-surface text-right">${esc(a.method)}</dd></div>
      </dl>
      <button type="button" class="w-full bg-primary text-on-primary text-xs py-1.5 rounded-md hover:bg-surface-tint transition-colors">ใช้แบบนี้</button>`;
    card.querySelector("button").addEventListener("click", () => {
      selectedIndex = i;
      apply(d.config);
      drawVariations();
      closeCompare();
    });
    body.appendChild(card);
  });
  modal.classList.remove("hidden");
  modal.classList.add("flex");
});

// Say plainly which mode is active — whether the prompt leaves the browser is a privacy-relevant fact.
aiAvailable().then((enabled) => {
  $("mm-ai-mode-note").textContent = enabled
    ? "ใช้ OpenAI ผ่านเซิร์ฟเวอร์ของเรา — ข้อความที่คุณพิมพ์จะถูกส่งไปประมวลผล"
    : "โหมดออฟไลน์ — ประมวลผลในเบราว์เซอร์ของคุณเอง ไม่ส่งข้อมูลออกไปไหน";
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
refreshUI();
refreshHistoryButtons();
rebuildPot();
seedVariations();
animate();

// Small hook so the page can be inspected / driven from the console and tests.
/** PNG of the viewport as it is now (brush ring hidden) — used by the create page. */
function snapshotPng() {
  const was = brushCursor.visible;
  brushCursor.visible = false;
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  brushCursor.visible = was;
  return url;
}
if (EMBED) {
  document.documentElement.classList.add("mm-embed");
  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin || e.source !== window.parent) return;
    if (e.data?.type === "mudmagic-snapshot-request") {
      window.parent.postMessage({ type: "mudmagic-snapshot", id: e.data.id, png: snapshotPng() }, window.location.origin);
    }
  });
  window.parent.postMessage({ type: "mudmagic-studio-config", config: JSON.parse(JSON.stringify(config)), ready: true }, window.location.origin);
}

window.MudMagicStudio = {
  snapshot: snapshotPng,
  getConfig: () => JSON.parse(JSON.stringify(config)),
  apply: (partial) => apply(partial),
  getGroup: () => potGroup,
};
