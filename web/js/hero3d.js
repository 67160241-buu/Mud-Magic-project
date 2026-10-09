// hero3d.js — live 3D preview for the landing-page hero.
// Uses the same vessel engine as the Studio and cycles through every vessel
// type (vase, mug, bowl, pitcher, plate, sculpture) so the first screen shows
// that Mud Magic is for all ceramics, not just mugs. Every time a vessel comes
// up it is a freshly randomised design (size, glaze, clay, pattern, outline).
import * as THREE from "three";
import { buildPotGroup, disposePotGroup } from "./pot-engine.js";
import { VESSELS, GLAZES, CLAY_IDS, PATTERNS, OUTLINES, SCULPTURE_FORMS, RAW_GLAZE, configForVessel, normalizeConfig } from "./vessels.js";

const SHOWCASE = [{ id: "vase" }, { id: "mug" }, { id: "bowl" }, { id: "pitcher" }, { id: "plate" }, { id: "sculpture" }];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = ([lo, hi], inner = 0.2) => {
  const a = lo + (hi - lo) * inner;
  return Math.round((a + Math.random() * (hi - lo) * (1 - inner * 2)) * 10) / 10;
};
const EXTRA_GLAZES = ["#8E6FB5", "#7FA7C9", "#B8433A", "#E2B84C", "#5E7F6E", "#C98B6B"];
const FLAT_OUTLINES = Object.keys(OUTLINES).filter((o) => o !== "round");

/** A new random but always buildable design for one vessel type. */
function randomDesign(id) {
  const v = VESSELS[id];
  const color = Math.random() < 0.12 ? RAW_GLAZE : pick([...GLAZES.map((g) => g.hex), ...EXTRA_GLAZES]);
  const cfg = configForVessel(id, {
    clay: pick(CLAY_IDS),
    color,
    surface: pick(["matte", "smooth", "rough"]),
    texture: id === "sculpture" || Math.random() < 0.25 ? "pinch" : "thrown",
  });
  cfg.height = between(v.height);
  cfg.belly = between(v.belly);
  if (id === "sculpture") {
    cfg.lab = { ...cfg.lab, ...pick(Object.values(SCULPTURE_FORMS)).lab };
    return normalizeConfig(cfg);
  }
  if (Math.random() < 0.5) {
    const preset = pick(PATTERNS.filter((p) => p.mod));
    cfg.modulation = { ...preset.mod };
  }
  if ((id === "vase" || id === "pitcher") && Math.random() < 0.35) cfg.neck = pick(["flared", "fluted"]);
  const flat = id === "plate" || id === "bowl";
  if (flat && Math.random() < 0.45) {
    cfg.lab = { ...cfg.lab, outline: pick(FLAT_OUTLINES) };
    cfg.modulation = null;
  } else if (id === "vase" && Math.random() < 0.25) {
    cfg.lab = { ...cfg.lab, polySides: pick([5, 6, 8]) };
  } else if ((id === "vase" || id === "bowl") && Math.random() < 0.25) {
    cfg.lab = { ...cfg.lab, aspect: between([0.7, 0.85], 0) };
  }
  return normalizeConfig(cfg);
}

const FIT_HEIGHT = 1.2; // on-screen size of the biggest dimension, in scene units
const CYCLE_MS = 5200;
const OUT_MS = 320;
const IN_MS = 620;
const SPIN = 0.22; // rad / second

const easeInCubic = (t) => t * t * t;
const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function initHero3D() {
  const container = document.getElementById("hero-3d");
  if (!container) return;
  const frame = container.parentElement;
  const labelEl = document.getElementById("hero-3d-label");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 1.0, 3.1);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.touchAction = "pan-y";
  renderer.domElement.style.cursor = "grab";
  container.appendChild(renderer.domElement);

  const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
  key.position.set(2.5, 3.5, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe9dd, 0.9);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  /* ---------- vessels (a fresh random design each time one is shown) ---------- */
  const pots = new Array(SHOWCASE.length).fill(null); // the next design, built ahead
  const outlineOf = new Map();

  function getPot(i) {
    if (pots[i]) return pots[i];
    const cfg = randomDesign(SHOWCASE[i].id);
    const group = buildPotGroup(cfg, { rings: 72, sides: 72 });
    outlineOf.set(group, cfg.lab.outline);
    const { height, radius } = group.userData.fit;
    const base = Math.min(30, FIT_HEIGHT / Math.max(height, radius * 2 * 0.85, 0.05));
    group.userData.baseScale = base;
    group.userData.yOffset = -(height * base) / 2 + 0.03;
    pots[i] = group;
    return group;
  }

  function place(group, mult) {
    const s = Math.max(0.0001, group.userData.baseScale * mult);
    group.scale.setScalar(s);
    group.position.y = group.userData.yOffset * (s / group.userData.baseScale);
  }

  // Hand out a design and queue a fresh one for the next time this vessel comes up.
  function takePot(i) {
    const g = getPot(i);
    pots[i] = null;
    setTimeout(() => {
      try { getPot(i); } catch (e) { console.error("hero3d: build failed", SHOWCASE[i].id, e); }
    }, 1200);
    return g;
  }

  let cur = Math.floor(Math.random() * SHOWCASE.length);
  let current = takePot(cur);
  current.rotation.y = 0.6;
  place(current, 1);
  scene.add(current);

  // Build the rest a little later so the first frame is not delayed.
  SHOWCASE.forEach((_, i) => {
    if (i === cur) return;
    setTimeout(() => {
      try { getPot(i); } catch (e) { console.error("hero3d: build failed", SHOWCASE[i].id, e); }
    }, 400 + i * 250);
  });

  /* ---------- UI: label + dots ---------- */
  const dotsWrap = document.createElement("div");
  dotsWrap.style.cssText = "position:absolute;top:16px;right:16px;display:flex;gap:6px;align-items:center;z-index:2;";
  const dots = SHOWCASE.map((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", VESSELS[s.id].label);
    b.title = VESSELS[s.id].label;
    b.style.cssText =
      "height:8px;width:8px;border-radius:9999px;border:0;padding:0;cursor:pointer;background:#d9c1bb;transition:width .3s ease,background .3s ease;";
    b.addEventListener("click", () => {
      holdUntil = performance.now() + 9000;
      show(i);
    });
    dotsWrap.appendChild(b);
    return b;
  });
  frame.appendChild(dotsWrap);

  function updateUI(i) {
    dots.forEach((d, k) => {
      d.style.width = k === i ? "22px" : "8px";
      d.style.background = k === i ? "#88452f" : "#d9c1bb";
    });
    const outline = outlineOf.get(current);
    const shape = outline && outline !== "round" ? `ทรง${OUTLINES[outline].label}` : "";
    if (labelEl) labelEl.textContent = `${VESSELS[SHOWCASE[i].id].label}${shape ? " " + shape : ""} · ลากเพื่อหมุนดู`;
  }
  updateUI(cur);

  /* ---------- sizing / visibility ---------- */
  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let paused = false;
  new IntersectionObserver((entries) => entries.forEach((e) => (paused = !e.isIntersecting)), {
    threshold: 0.05,
  }).observe(container);

  /* ---------- drag to rotate ---------- */
  let dragging = false;
  let lastX = 0;
  let holdUntil = 0; // auto-cycle / spin pause deadline
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    el.style.cursor = "grabbing";
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    current.rotation.y += (e.clientX - lastX) * 0.011;
    lastX = e.clientX;
    holdUntil = performance.now() + 4000;
  });
  const endDrag = () => {
    dragging = false;
    el.style.cursor = "grab";
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  /* ---------- transition between vessels ---------- */
  let anim = null; // { t0, next, swapped }
  let lastSwitch = performance.now();

  function show(i) {
    if (i === cur || anim) return;
    try { getPot(i); } catch (e) { console.error("hero3d: build failed", SHOWCASE[i].id, e); return; }
    anim = { t0: performance.now(), next: i, swapped: false };
  }

  function stepAnim(now) {
    if (!anim) return;
    const t = now - anim.t0;
    if (t < OUT_MS) {
      place(current, 1 - easeInCubic(t / OUT_MS));
      return;
    }
    if (!anim.swapped) {
      const next = takePot(anim.next);
      next.rotation.y = current.rotation.y;
      scene.remove(current);
      outlineOf.delete(current);
      disposePotGroup(current);
      cur = anim.next;
      current = next;
      place(current, 0);
      scene.add(current);
      updateUI(cur);
      anim.swapped = true;
    }
    const p = Math.min(1, (t - OUT_MS) / IN_MS);
    place(current, easeOutBack(p));
    if (p >= 1) {
      place(current, 1);
      anim = null;
      lastSwitch = now;
    }
  }

  /* ---------- loop ---------- */
  let prev = performance.now();
  let firstFrame = true;
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (paused) return;

    if (!reduced && !dragging && now > holdUntil) current.rotation.y += SPIN * dt;
    if (!reduced && !anim && now > holdUntil && now - lastSwitch > CYCLE_MS) {
      show((cur + 1) % SHOWCASE.length);
      lastSwitch = now;
    }
    stepAnim(now);
    renderer.render(scene, camera);

    if (firstFrame) {
      firstFrame = false;
      container.classList.remove("mm-shimmer"); // loading skeleton no longer needed
    }
  }
  requestAnimationFrame(animate);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHero3D);
} else {
  initHero3D();
}
