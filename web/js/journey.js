// journey.js — the guided AI design journey (create.html), implementing the
// product's User Journey end-to-end: idea → skill level → AI results
// (filtered so nothing shown is harder than the chosen level) → compare →
// customize (live 3D + freeform sculpt + real-time difficulty check) →
// confirm/download (single-file guide) → build (offline) → feedback.
//
// Reuses the same engine as the free-form Studio: mug-model.js for
// geometry/difficulty, sculpt.js for freeform vertex sculpting.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildMugGroup,
  disposeMugGroup,
  GLAZES,
  SHAPES,
  HANDLES,
  SURFACES,
  SKILL_LEVELS,
  computeDifficulty,
  fitsSkillLevel,
  skillLevelRank,
  difficultyOutOf5,
  feasibilityFor,
  designName,
  styleChip,
  techniqueFor,
  shapeWord,
  buildStepGuide,
} from "./mug-model.js";
import { Sculptor } from "./sculpt.js";

const DRAFT_KEY = "mudmagic_journey_draft_v1";
const GALLERY_KEY = "mudmagic_gallery";
const FEEDBACK_LOG_KEY = "mudmagic_feedback_log";
const STUCK_THRESHOLD = 3;

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const LEVEL = Object.fromEntries(SKILL_LEVELS.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ */
/* Seeded RNG + prompt keyword bias                                    */
/* ------------------------------------------------------------------ */
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
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
const KEYWORD_MAP = {
  shape: {
    tall: ["สูง", "เรียว", "ชะลูด", "tall", "slim"],
    round: ["ป่อง", "กลม", "โค้ง", "round", "curvy"],
    wide: ["เตี้ย", "กว้าง", "wide", "short", "ชาม"],
    classic: ["คลาสสิก", "เรียบ", "classic"],
  },
  handle: {
    minimal: ["หูเล็ก", "มินิมอล", "minimal"],
    organic: ["อิสระ", "หยัก", "organic", "handmade"],
    loop: ["หูห่วง", "loop"],
  },
  surface: {
    smooth: ["เงา", "มัน", "เคลือบมัน", "glossy", "smooth"],
    rough: ["หยาบ", "ดิบ", "unglazed", "rough", "rustic"],
    matte: ["ด้าน", "matte"],
  },
  color: {
    "#A65D45": ["ดินเผา", "ส้ม", "terracotta", "clay"],
    "#7C8872": ["เขียว", "ใบไม้", "เซจ", "sage", "green"],
    "#F3E9DD": ["ครีม", "ขาวนวล", "cream", "ivory"],
    "#3B2A20": ["น้ำตาล", "กาแฟ", "espresso", "brown"],
    "#E3A896": ["ชมพู", "blush", "pink"],
    "#2B2B2B": ["ดำ", "ถ่าน", "charcoal", "black"],
    "#4C5A66": ["ฟ้า", "น้ำเงิน", "denim", "blue"],
    "#FBF6EF": ["งาช้าง", "ขาว", "white"],
  },
};
function scoreComboAgainstPrompt(combo, promptLower) {
  let score = 0;
  if (KEYWORD_MAP.shape[combo.shape]?.some((k) => promptLower.includes(k))) score += 3;
  if (KEYWORD_MAP.handle[combo.handle]?.some((k) => promptLower.includes(k))) score += 3;
  if (KEYWORD_MAP.surface[combo.surface]?.some((k) => promptLower.includes(k))) score += 3;
  return score;
}
function pickColor(promptLower, rng) {
  for (const hex of Object.keys(KEYWORD_MAP.color)) {
    if (KEYWORD_MAP.color[hex].some((k) => promptLower.includes(k))) return hex;
  }
  return GLAZES[Math.floor(rng() * GLAZES.length)].hex;
}
function allValidCombos(skillLevelId) {
  const combos = [];
  for (const shape of SHAPES)
    for (const handle of HANDLES)
      for (const surface of SURFACES) {
        const combo = { shape, handle, surface };
        if (fitsSkillLevel(combo, skillLevelId)) combos.push(combo);
      }
  return combos;
}

/* ------------------------------------------------------------------ */
/* Offscreen thumbnail renderer (results/compare cards)                */
/* ------------------------------------------------------------------ */
let thumbRenderer, thumbScene, thumbCamera, thumbGroup;
function renderThumbnail(config) {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(480, 360);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbScene = new THREE.Scene();
    thumbScene.background = new THREE.Color("#f6ece5");
    thumbCamera = new THREE.PerspectiveCamera(30, 480 / 360, 0.1, 50);
    thumbCamera.position.set(0, 0.7, 3.0);
    thumbCamera.lookAt(0, 0.05, 0);
    const key = new THREE.DirectionalLight(0xfff4ea, 2.3);
    key.position.set(2, 3, 2.2);
    thumbScene.add(key);
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  }
  if (thumbGroup) {
    thumbScene.remove(thumbGroup);
    disposeMugGroup(thumbGroup);
  }
  thumbGroup = buildMugGroup(config);
  thumbGroup.position.y = -0.48;
  thumbGroup.rotation.y = 0.65;
  thumbScene.add(thumbGroup);
  thumbRenderer.render(thumbScene, thumbCamera);
  return thumbRenderer.domElement.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* Results generation (skill-filtered, prompt-biased)                  */
/* ------------------------------------------------------------------ */
function englishReasons(config, skillLevelId) {
  const cfg = config;
  const shapeR = {
    classic: "Straightforward symmetrical form",
    wide: "Wide, stable base — easy to centre",
    round: "Curved walls need steady hands",
    tall: "Tall pull requires wall control",
  }[cfg.shape];
  const handleR = {
    minimal: "Small handle, quick to attach",
    loop: "Classic loop handle join",
    organic: "Freeform handle needs hand-building skill",
  }[cfg.handle];
  return [shapeR, handleR];
}

function generateResults(prompt, skillLevelId, seed, count = 4) {
  const combos = allValidCombos(skillLevelId);
  if (combos.length === 0) return []; // defensive: structurally unreachable, kept per journey edge case
  const promptLower = prompt.toLowerCase();
  const rng = mulberry32(hashSeed(`${promptLower}::${skillLevelId}::${seed}`));
  const scored = combos
    .map((c) => ({ c, s: scoreComboAgainstPrompt(c, promptLower) + rng() * 0.6 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(count, combos.length));
  const keyColor = pickColor(promptLower, rng);

  return scored.map(({ c }, i) => {
    const color = i === 0 ? keyColor : GLAZES[Math.floor(rng() * GLAZES.length)].hex;
    const config = { ...c, color };
    const diff = computeDifficulty(config);
    return {
      id: uid(),
      config,
      diff,
      name: designName(config),
      chip: styleChip(config),
      technique: techniqueFor(config),
      shapeWord: shapeWord(config),
      outOf5: difficultyOutOf5(diff.score),
      feasibility: feasibilityFor(config, skillLevelId),
      reasons: englishReasons(config, skillLevelId),
      thumb: renderThumbnail(config),
    };
  });
}

/* ------------------------------------------------------------------ */
/* State + draft persistence                                           */
/* ------------------------------------------------------------------ */
function freshStudent() {
  return { results: [], compareIds: [], activeConfig: null, genSeed: 0, regenerateAttempts: 0, feedback: { rating: 0, publish: true, photo: null } };
}
const state = {
  step: "idea",
  prompt: "",
  skillLevel: null,
  studentCount: 1,
  activeStudent: 0,
  students: [freshStudent()],
};
const student = () => state.students[state.activeStudent];

function saveDraft() {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: state.step,
        prompt: state.prompt,
        skillLevel: state.skillLevel,
        studentCount: state.studentCount,
        activeStudent: state.activeStudent,
        students: state.students.map((s) => ({ activeConfig: s.activeConfig, feedback: { rating: s.feedback.rating, publish: s.feedback.publish } })),
      })
    );
  } catch (err) {
    /* storage disabled — draft simply won't resume */
  }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (err) { return null; }
}

/* ------------------------------------------------------------------ */
/* Step navigation                                                     */
/* ------------------------------------------------------------------ */
const STEP_ORDER = ["idea", "skill", "results", "compare", "customize", "confirm", "build", "feedback", "done"];
const STEP_LABEL_TH = { idea: "ไอเดีย", skill: "ระดับฝีมือ", results: "ผลลัพธ์ AI", compare: "เปรียบเทียบ", customize: "ปรับแต่ง", confirm: "ยืนยัน", build: "ลงมือปั้น", feedback: "ฟีดแบ็ก", done: "เสร็จสิ้น" };

function goToStep(step) {
  state.step = step;
  document.querySelectorAll(".step-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.step !== step));
  const label = $("progress-label");
  if (label) label.textContent = `${STEP_ORDER.indexOf(step) + 1}/${STEP_ORDER.length} · ${STEP_LABEL_TH[step]}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (step !== "done") saveDraft();

  if (step === "results") renderResults();
  if (step === "compare") renderCompare();
  if (step === "customize") enterCustomize();
  if (step === "confirm") renderConfirm();
  if (step === "build") renderBuild();
  if (step === "feedback") renderFeedback();
  if (step === "done") $("done-count").textContent = state.studentCount;
}

/* ------------------------------------------------------------------ */
/* Step: ไอเดีย                                                         */
/* ------------------------------------------------------------------ */
const VAGUE_PHRASES = ["สวยๆ", "อะไรก็ได้", "ไม่รู้", "งามๆ", "เท่ๆ", "น่ารักๆ", "ดีๆ", "สวย"];
const SUGGESTED_IDEAS = ["แจกันลายดอกไม้มินิมอล", "แก้วทรงกลมลายคลื่นทะเล", "แก้วทรงสูงเรียบเคลือบมัน", "แก้วผิวหยาบทรงเตี้ยสไตล์ญี่ปุ่น", "แจกันลายใบไม้สีเซจ", "แก้วหูจับทรงอิสระ สีดินเผา"];

function isVaguePrompt(text) {
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.length < 6) return true;
  if (VAGUE_PHRASES.some((p) => t.includes(p)) && t.length < 20) return true;
  const words = t.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.length <= 2 && t.length < 14;
}

function initIdea() {
  const textarea = $("idea-prompt");
  const nextBtn = $("idea-next-btn");
  SUGGESTED_IDEAS.forEach((phrase) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "px-4 py-2 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant text-sm hover:bg-primary hover:text-on-primary transition-colors";
    chip.textContent = phrase;
    chip.addEventListener("click", () => {
      textarea.value = phrase;
      textarea.dispatchEvent(new Event("input"));
      textarea.focus();
    });
    $("idea-suggestions").appendChild(chip);
  });
  textarea.addEventListener("input", () => {
    state.prompt = textarea.value;
    const vague = isVaguePrompt(textarea.value);
    $("idea-vague-hint").classList.toggle("hidden", !vague);
    nextBtn.disabled = textarea.value.trim().length === 0;
    nextBtn.classList.toggle("opacity-50", nextBtn.disabled);
  });
  $("student-count").addEventListener("change", () => {
    const n = Math.min(10, Math.max(1, Number($("student-count").value) || 1));
    $("student-count").value = n;
    state.studentCount = n;
    state.students = Array.from({ length: n }, () => freshStudent());
    $("student-mode-note").classList.toggle("hidden", n <= 1);
  });
  nextBtn.addEventListener("click", () => {
    if (!textarea.value.trim()) return;
    state.prompt = textarea.value.trim();
    goToStep("skill");
  });
}

/* ------------------------------------------------------------------ */
/* Step: ระดับฝีมือ + quiz                                              */
/* ------------------------------------------------------------------ */
const QUIZ = [
  { q: "เคยปั้นเซรามิกมาก่อนไหม?", options: [["ไม่เคยเลย", 0], ["เคยลอง 1-2 ครั้ง", 1], ["ปั้นเป็นประจำ", 2]] },
  { q: "คุมแป้นหมุนให้ดินอยู่กึ่งกลางได้ไหม?", options: [["ยังไม่ได้", 0], ["ได้บ้างบางครั้ง", 1], ["ได้สบาย", 2]] },
  { q: "เคยต่อหูจับหรือเก็บรายละเอียดผิวไหม?", options: [["ยังไม่เคย", 0], ["เคยแบบง่ายๆ", 1], ["ทำได้คล่อง", 2]] },
];

function initSkill() {
  document.querySelectorAll("[data-skill]").forEach((card) => {
    card.addEventListener("click", () => {
      state.skillLevel = card.dataset.skill;
      state.students.forEach((s) => { s.genSeed = 0; s.results = []; s.compareIds = []; s.regenerateAttempts = 0; });
      goToStep("results");
    });
  });
  $("skill-back-btn").addEventListener("click", () => goToStep("idea"));

  // Mini quiz per the mockup's "ทำแบบทดสอบสั้นๆ" link
  const modal = $("skill-quiz-modal");
  const body = $("skill-quiz-body");
  let answers = [];
  function renderQuiz() {
    body.innerHTML = "";
    $("skill-quiz-result").classList.add("hidden");
    answers = [];
    QUIZ.forEach((item, qi) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = `<p class="text-sm font-medium text-on-surface mb-2">${qi + 1}. ${item.q}</p>`;
      const opts = document.createElement("div");
      opts.className = "flex flex-wrap gap-2";
      item.options.forEach(([label, score]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "px-3.5 py-1.5 rounded-full border border-outline-variant text-sm text-on-surface-variant hover:border-primary";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          answers[qi] = score;
          opts.querySelectorAll("button").forEach((b) => {
            b.classList.toggle("bg-primary", b === btn);
            b.classList.toggle("text-on-primary", b === btn);
            b.classList.toggle("border-primary", b === btn);
          });
          if (answers.filter((a) => a !== undefined).length === QUIZ.length) {
            const total = answers.reduce((a, b) => a + b, 0); // 0..6
            const level = total <= 2 ? "beginner" : total <= 4 ? "intermediate" : "advanced";
            $("skill-quiz-result-level").textContent = `${LEVEL[level].label} (${LEVEL[level].labelTh})`;
            $("skill-quiz-result").classList.remove("hidden");
            $("skill-quiz-apply").dataset.level = level;
          }
        });
        opts.appendChild(btn);
      });
      wrap.appendChild(opts);
      body.appendChild(wrap);
    });
  }
  $("skill-quiz-open").addEventListener("click", () => { renderQuiz(); modal.classList.remove("hidden"); });
  $("skill-quiz-close").addEventListener("click", () => modal.classList.add("hidden"));
  $("skill-quiz-scrim").addEventListener("click", () => modal.classList.add("hidden"));
  $("skill-quiz-apply").addEventListener("click", (e) => {
    modal.classList.add("hidden");
    const level = e.currentTarget.dataset.level;
    const card = document.querySelector(`[data-skill="${level}"]`);
    if (card) card.click();
  });
}

/* ------------------------------------------------------------------ */
/* Step: ผลลัพธ์ AI                                                     */
/* ------------------------------------------------------------------ */
function renderResults() {
  const s = student();
  $("results-student-badge").textContent = `นักเรียนคนที่ ${state.activeStudent + 1}/${state.studentCount}`;
  $("results-student-badge").classList.toggle("hidden", state.studentCount <= 1);
  $("results-subtitle").textContent = `เราคัดแบบจากไอเดีย "${state.prompt}" ที่ผ่านการกรองแล้วว่าปั้นได้จริงในระดับ ${LEVEL[state.skillLevel].labelTh} — แตะ Compare เพื่อเลือกไปเปรียบเทียบ (สูงสุด 3 แบบ) หรือ Customize เพื่อไปปรับแต่งเลย`;

  if (s.results.length === 0) s.results = generateResults(state.prompt, state.skillLevel, s.genSeed);
  $("results-empty").classList.toggle("hidden", s.results.length > 0);

  const grid = $("results-grid");
  grid.innerHTML = "";
  s.results.forEach((r) => {
    const inCompare = s.compareIds.includes(r.id);
    const card = document.createElement("div");
    card.className = "bg-surface-container-lowest rounded-xl overflow-hidden soft-shadow group transition-all duration-500 hover:shadow-xl" + (inCompare ? " ring-2 ring-primary" : "");
    card.innerHTML = `
      <div class="relative h-64 w-full bg-surface-container overflow-hidden">
        <img class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" src="${r.thumb}" alt="${r.name} — 3D render" />
        <div class="absolute bottom-4 left-4">
          <span class="bg-surface-variant/80 backdrop-blur text-on-surface-variant font-label-sm text-label-sm px-3 py-1 rounded-full uppercase tracking-wider">${r.chip}</span>
        </div>
        ${inCompare ? '<div class="absolute top-4 right-4 bg-primary text-on-primary font-label-sm text-label-sm px-3 py-1 rounded-full">เลือกแล้ว</div>' : ""}
      </div>
      <div class="p-7">
        <div class="mb-5">
          <h2 class="font-headline-md text-[26px] leading-8 text-on-surface mb-2">${r.name}</h2>
          <div class="flex items-center gap-2 font-label-sm text-label-sm" style="color:${r.diff.dot}">
            <span class="material-symbols-outlined fill text-[14px]">circle</span> ${r.diff.levelLabel}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-5 pb-5 border-b border-outline-variant/30">
          <div>
            <span class="block font-label-sm text-label-sm text-on-surface-variant mb-1 uppercase">Difficulty</span>
            <span class="font-body-lg text-body-lg text-primary">${r.outOf5}/5</span>
          </div>
          <div>
            <span class="block font-label-sm text-label-sm text-on-surface-variant mb-1 uppercase">Feasibility</span>
            <span class="font-body-lg text-body-lg text-primary">${r.feasibility}%</span>
          </div>
        </div>
        <ul class="space-y-2 font-body-md text-sm text-on-surface-variant mb-7">
          ${r.reasons.map((reason) => `<li class="flex items-center gap-2"><span class="material-symbols-outlined text-secondary text-[20px]">check</span>${reason}</li>`).join("")}
          <li class="flex items-center gap-2 text-xs"><span class="material-symbols-outlined text-secondary text-[18px]">check</span>${r.diff.reasons[0]}</li>
        </ul>
        <div class="flex gap-3">
          <button data-act="compare" class="flex-1 border ${inCompare ? "border-primary text-primary" : "border-outline text-on-surface"} py-3 rounded hover:bg-surface-variant transition-colors font-label-sm text-label-sm">${inCompare ? "เอาออก" : "Compare"}</button>
          <button data-act="customize" class="flex-1 bg-primary text-on-primary py-3 rounded hover:bg-surface-tint transition-colors font-label-sm text-label-sm">Customize</button>
        </div>
      </div>`;
    card.querySelector('[data-act="compare"]').addEventListener("click", () => {
      const idx = s.compareIds.indexOf(r.id);
      if (idx >= 0) s.compareIds.splice(idx, 1);
      else {
        if (s.compareIds.length >= 3) {
          window.MudMagic?.showToast("เปรียบเทียบได้สูงสุด 3 แบบ", { icon: "info" });
          return;
        }
        s.compareIds.push(r.id);
        s.regenerateAttempts = 0;
      }
      renderResults();
    });
    card.querySelector('[data-act="customize"]').addEventListener("click", () => {
      s.activeConfig = { ...r.config };
      goToStep("customize");
    });
    grid.appendChild(card);
  });

  $("results-stuck-banner").classList.toggle("hidden", !(s.regenerateAttempts >= STUCK_THRESHOLD && s.compareIds.length === 0));
  const cmpBtn = $("results-compare-btn");
  $("results-compare-count").textContent = s.compareIds.length;
  cmpBtn.disabled = s.compareIds.length === 0;
  cmpBtn.classList.toggle("opacity-50", cmpBtn.disabled);
}

function initResults() {
  $("results-regenerate-btn").addEventListener("click", () => {
    const s = student();
    s.genSeed += 1;
    s.regenerateAttempts += 1;
    s.results = [];
    s.compareIds = [];
    renderResults();
  });
  $("results-back-btn").addEventListener("click", () => goToStep("skill"));
  $("results-compare-btn").addEventListener("click", () => goToStep("compare"));
  $("stuck-simplify-btn").addEventListener("click", () => {
    goToStep("idea");
    window.MudMagic?.showToast("ลองเพิ่มรายละเอียดในไอเดีย เช่น ทรง สี หรือผิวสัมผัส", { icon: "edit" });
  });
}

/* ------------------------------------------------------------------ */
/* Step: เปรียบเทียบ                                                    */
/* ------------------------------------------------------------------ */
const CHIP_STYLE = {
  smooth: "bg-secondary-fixed text-on-secondary-fixed-variant",
  matte: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
  rough: "bg-surface-variant text-on-surface-variant",
};

function renderCompare() {
  const s = student();
  const picked = s.compareIds.map((id) => s.results.find((r) => r.id === id)).filter(Boolean);
  // Recommended = the design with the most feasibility headroom for the chosen level
  const recommendedId = picked.slice().sort((a, b) => b.feasibility - a.feasibility)[0]?.id;

  const grid = $("compare-grid");
  grid.innerHTML = "";
  picked.forEach((r) => {
    const isRec = r.id === recommendedId && picked.length > 1;
    const dots = Math.max(1, Math.min(3, skillLevelRank(r.diff.level) + 1));
    const card = document.createElement("div");
    card.className = "design-card relative flex flex-col bg-surface-container-lowest rounded-xl overflow-hidden " + (isRec ? "border-2 border-primary/20 bg-surface-container-low shadow-sm" : "border border-outline-variant/30");
    card.innerHTML = `
      ${isRec ? '<div class="absolute top-4 left-4 z-10 bg-primary text-on-primary font-label-sm text-label-sm px-3 py-1.5 rounded-full flex items-center gap-1 shadow-sm"><span class="material-symbols-outlined fill text-[16px]">star</span> Recommended</div>' : ""}
      <div class="relative w-full h-64 md:h-72 bg-surface-container-high overflow-hidden">
        <img class="w-full h-full object-cover" src="${r.thumb}" alt="${r.name}" />
      </div>
      <div class="p-6 md:p-7 flex flex-col flex-grow">
        <h3 class="font-headline-md text-[26px] leading-8 text-on-background mb-2">${r.name}</h3>
        <div class="flex-grow mt-4">
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Shape</span>
            <span class="text-sm text-on-background font-medium">${r.shapeWord}</span>
          </div>
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Style</span>
            <span class="${CHIP_STYLE[r.config.surface]} font-label-sm text-label-sm px-3 py-1 rounded-full">${r.chip}</span>
          </div>
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Technique</span>
            <span class="text-sm text-on-background">${r.technique}</span>
          </div>
          <div class="flex justify-between items-center py-3">
            <span class="text-sm text-on-surface-variant">Difficulty</span>
            <div class="flex gap-1 text-primary">
              ${[1, 2, 3].map((n) => `<span class="material-symbols-outlined ${n <= dots ? "fill" : ""} text-[18px] ${n <= dots ? "" : "opacity-40"}">circle</span>`).join("")}
            </div>
          </div>
        </div>
        <button class="mt-7 w-full ${isRec ? "bg-primary text-on-primary hover:bg-primary-container" : "bg-surface-container-lowest border border-outline-variant text-on-surface hover:border-primary"} font-label-sm text-label-sm px-6 py-3.5 rounded-lg transition-colors duration-300 flex justify-center items-center gap-2 group">
          เลือกแบบนี้ <span class="material-symbols-outlined group-hover:translate-x-1 transition-transform" style="font-size:18px;">arrow_forward</span>
        </button>
      </div>`;
    card.querySelector("button").addEventListener("click", () => {
      s.activeConfig = { ...r.config };
      goToStep("customize");
    });
    grid.appendChild(card);
  });
}
function initCompare() {
  $("compare-back-btn").addEventListener("click", () => goToStep("results"));
}

/* ------------------------------------------------------------------ */
/* Step: ปรับแต่ง — live 3D + toolbar + sculpt + difficulty banner      */
/* ------------------------------------------------------------------ */
let scene, camera, renderer, controls, mugGroup, sculptor, brushCursor;
let viewportReady = false;

function initViewport() {
  if (viewportReady) return;
  viewportReady = true;
  const container = $("customize-viewport");

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0.95, 3.4);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.9;
  controls.maxDistance = 5.2;
  controls.target.set(0, 0.1, 0);

  const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
  key.position.set(2.6, 3.6, 2.4);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  sculptor = new Sculptor(camera, renderer.domElement, controls);

  brushCursor = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.06, 32),
    new THREE.MeshBasicMaterial({ color: 0x88452f, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
  );
  brushCursor.visible = false;
  brushCursor.renderOrder = 10;
  scene.add(brushCursor);

  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  (function animate() {
    requestAnimationFrame(animate);
    sculptor.tick();
    updateBrushCursor();
    controls.update();
    renderer.render(scene, camera);
  })();

  document.querySelectorAll("[data-shape]").forEach((b) => b.addEventListener("click", () => applyConfig({ shape: b.dataset.shape })));
  document.querySelectorAll("[data-handle]").forEach((b) => b.addEventListener("click", () => applyConfig({ handle: b.dataset.handle })));
  document.querySelectorAll("[data-surface]").forEach((b) => b.addEventListener("click", () => applyConfig({ surface: b.dataset.surface })));
  document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => applyConfig({ color: b.dataset.color })));

  initSculptControls();
}

function updateBrushCursor() {
  if (!sculptor || !sculptor.active || !mugGroup) {
    if (brushCursor) brushCursor.visible = false;
    return;
  }
  const p = sculptor.getCursorLocal();
  const n = sculptor.getCursorNormalLocal();
  if (!p) {
    brushCursor.visible = false;
    return;
  }
  brushCursor.visible = true;
  brushCursor.position.copy(p);
  mugGroup.localToWorld(brushCursor.position);
  brushCursor.scale.setScalar(sculptor.brushRadius);
  if (n) {
    const wn = n.clone().transformDirection(mugGroup.matrixWorld);
    brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wn);
  }
}

function rebuildMug() {
  if (mugGroup) {
    scene.remove(mugGroup);
    disposeMugGroup(mugGroup);
  }
  mugGroup = buildMugGroup(student().activeConfig);
  mugGroup.position.y = -0.5;
  mugGroup.rotation.y = 0.5;
  scene.add(mugGroup);
  sculptor.setTarget(mugGroup.getObjectByName("mug-body"));
}

function applyConfig(partial) {
  const s = student();
  s.activeConfig = { ...s.activeConfig, ...partial };
  rebuildMug();
  refreshToolbar();
  refreshDifficultyBanner();
  saveDraft();
}

const ACTIVE_BTN = ["border-primary", "bg-surface-container-low", "text-primary"];
const INACTIVE_BTN = ["border-outline-variant", "text-on-surface-variant", "bg-surface-container-lowest"];
function refreshToolbar() {
  const cfg = student().activeConfig;
  const setActive = (sel, key) => {
    document.querySelectorAll(sel).forEach((b) => {
      const active = b.dataset[key] === cfg[key];
      ACTIVE_BTN.forEach((c) => b.classList.toggle(c, active));
      INACTIVE_BTN.forEach((c) => b.classList.toggle(c, !active));
    });
  };
  setActive("[data-shape]", "shape");
  setActive("[data-handle]", "handle");
  setActive("[data-surface]", "surface");
  document.querySelectorAll("[data-color]").forEach((b) => {
    const active = b.dataset.color.toLowerCase() === cfg.color.toLowerCase();
    b.classList.toggle("ring-2", active);
    b.classList.toggle("ring-primary", active);
    b.classList.toggle("ring-1", !active);
    b.classList.toggle("ring-outline-variant/50", !active);
  });
}

function refreshDifficultyBanner() {
  const cfg = student().activeConfig;
  const diff = computeDifficulty(cfg);
  const banner = $("difficulty-banner");
  const exceeds = skillLevelRank(diff.level) > skillLevelRank(state.skillLevel);
  banner.classList.toggle("bg-amber-50", exceeds);
  banner.classList.toggle("border-amber-300", exceeds);
  banner.classList.toggle("text-amber-900", exceeds);
  banner.classList.toggle("bg-secondary-container", !exceeds);
  banner.classList.toggle("border-secondary/30", !exceeds);
  banner.classList.toggle("text-on-secondary-container", !exceeds);
  banner.querySelector("[data-banner-icon]").textContent = exceeds ? "warning" : "check_circle";
  banner.querySelector("[data-banner-text]").textContent = exceeds
    ? `การปรับแต่งนี้ยากกว่าระดับที่คุณเลือกไว้ (${LEVEL[state.skillLevel].labelTh}) — ตอนนี้อยู่ระดับ ${diff.levelLabelTh} ยังปั้นได้แต่ต้องฝึกมือเพิ่ม`
    : `อยู่ในระดับที่เหมาะกับคุณ (${diff.levelLabelTh})`;
}

function initSculptControls() {
  $("mm-sculpt-toggle").addEventListener("click", () => {
    const next = !sculptor.active;
    sculptor.setActive(next);
    const t = $("mm-sculpt-toggle");
    t.classList.toggle("bg-primary", next);
    t.classList.toggle("text-on-primary", next);
    t.classList.toggle("bg-surface-container-lowest", !next);
    t.classList.toggle("text-on-surface-variant", !next);
    $("mm-sculpt-controls").classList.toggle("hidden", !next);
    $("mm-sculpt-hint").classList.toggle("hidden", !next);
  });
  const size = $("mm-brush-size");
  const strength = $("mm-brush-strength");
  sculptor.setBrushRadius(Number(size.value));
  sculptor.setBrushStrength(Number(strength.value));
  size.addEventListener("input", () => sculptor.setBrushRadius(Number(size.value)));
  strength.addEventListener("input", () => sculptor.setBrushStrength(Number(strength.value)));
  document.querySelectorAll("[data-sculpt-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sculptor.setMode(btn.dataset.sculptMode);
      document.querySelectorAll("[data-sculpt-mode]").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("bg-primary", active);
        b.classList.toggle("text-on-primary", active);
        b.classList.toggle("bg-surface-container-lowest", !active);
        b.classList.toggle("text-on-surface-variant", !active);
      });
    });
  });
  $("mm-sculpt-reset").addEventListener("click", () => {
    rebuildMug();
    window.MudMagic?.showToast("ล้างการปั้นอิสระ กลับเป็นทรงตั้งต้นแล้ว", { icon: "restart_alt" });
  });
}

function enterCustomize() {
  initViewport();
  const s = student();
  if (!s.activeConfig) {
    const first = s.results[0];
    s.activeConfig = first ? { ...first.config } : { shape: "classic", handle: "loop", surface: "matte", color: "#A65D45" };
  }
  rebuildMug();
  refreshToolbar();
  refreshDifficultyBanner();
}
function initCustomize() {
  $("customize-back-btn").addEventListener("click", () => goToStep(student().compareIds.length > 0 ? "compare" : "results"));
  $("customize-next-btn").addEventListener("click", () => goToStep("confirm"));
}

/* ------------------------------------------------------------------ */
/* Step: ยืนยัน + single-file guide download (Thai-safe canvas raster)  */
/* ------------------------------------------------------------------ */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let current = "";
  for (const ch of text) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
    } else current = test;
  }
  if (current) lines.push(current);
  return lines;
}

async function buildGuideCanvas(config, diff, snapshotDataUrl) {
  try {
    await document.fonts.load('600 40px "Noto Sans Thai"');
    await document.fonts.load('400 20px "Noto Sans Thai"');
  } catch (err) { /* font API unsupported — system fallback still renders Thai */ }
  const W = 1240, H = 1754;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFF8F5";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#88452F";
  ctx.font = '600 40px "Noto Sans Thai", sans-serif';
  ctx.fillText("Mud Magic — คู่มือปั้นของคุณ", 60, 90);
  ctx.fillStyle = "#54433E";
  ctx.font = '400 20px "Noto Sans Thai", sans-serif';
  ctx.fillText(`${designName(config)}  ·  ระดับที่เลือก: ${LEVEL[state.skillLevel].labelTh}  ·  ความยากของแบบนี้: ${diff.levelLabelTh}`, 60, 130);

  const img = await loadImage(snapshotDataUrl);
  const imgSize = 460;
  ctx.drawImage(img, 60, 170, imgSize, imgSize);

  let tx = 560, ty = 220;
  ctx.font = '600 24px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#1F1B17";
  [["ทรง", config.shape], ["หูจับ", config.handle], ["พื้นผิว", config.surface]].forEach(([label, val]) => {
    ctx.fillText(`${label}: ${val}`, tx, ty);
    ty += 40;
  });
  ty += 16;
  ctx.font = '400 18px "Noto Sans Thai", sans-serif';
  wrapCanvasText(ctx, `เหตุผล: ${diff.reasons.join(" · ")}`, W - tx - 60).forEach((line) => {
    ctx.fillText(line, tx, ty);
    ty += 26;
  });

  let sy = 170 + imgSize + 70;
  ctx.font = '600 28px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#88452F";
  ctx.fillText("ขั้นตอนการปั้น", 60, sy);
  sy += 44;
  ctx.font = '400 21px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#1F1B17";
  buildStepGuide(config).forEach((step, i) => {
    wrapCanvasText(ctx, `${i + 1}. ${step}`, W - 120).forEach((line) => {
      ctx.fillText(line, 60, sy);
      sy += 30;
    });
    sy += 12;
  });
  ctx.font = '400 14px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#86736D";
  ctx.fillText("สร้างด้วย Mud Magic — AI Ceramic Design Studio", 60, H - 40);
  return canvas;
}

function renderConfirm() {
  const cfg = student().activeConfig;
  const diff = computeDifficulty(cfg);
  $("confirm-name").textContent = designName(cfg);
  $("confirm-summary-shape").textContent = cfg.shape;
  $("confirm-summary-handle").textContent = cfg.handle;
  $("confirm-summary-surface").textContent = cfg.surface;
  $("confirm-summary-level").textContent = `${diff.levelLabel} (${diff.levelLabelTh})`;
  $("confirm-summary-reasons").textContent = diff.reasons.join(" · ");
  const list = $("confirm-steps");
  list.innerHTML = "";
  buildStepGuide(cfg).forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    list.appendChild(li);
  });
  $("confirm-image").src = renderer.domElement.toDataURL("image/png");
}

function initConfirm() {
  $("confirm-back-btn").addEventListener("click", () => goToStep("customize"));
  $("confirm-next-btn").addEventListener("click", () => goToStep("build"));
  $("confirm-download-btn").addEventListener("click", async () => {
    const btn = $("confirm-download-btn");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "กำลังเตรียมไฟล์...";
    try {
      const cfg = student().activeConfig;
      const diff = computeDifficulty(cfg);
      const canvas = await buildGuideCanvas(cfg, diff, renderer.domElement.toDataURL("image/png"));
      const link = document.createElement("a");
      link.download = "mudmagic-guide.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      window.MudMagic?.showToast("ดาวน์โหลดคู่มือแล้ว", { icon: "download" });
    } catch (err) {
      window.MudMagic?.showToast("สร้างไฟล์คู่มือไม่สำเร็จ ลองใหม่อีกครั้ง", { icon: "error" });
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Step: ลงมือปั้น (offline — no system response per spec)              */
/* ------------------------------------------------------------------ */
function renderBuild() {
  const list = $("build-steps");
  list.innerHTML = "";
  buildStepGuide(student().activeConfig).forEach((step) => {
    const li = document.createElement("li");
    li.className = "flex items-start gap-3 py-2.5";
    li.innerHTML = `<span class="material-symbols-outlined text-primary" style="font-size:20px;">check_circle</span><span>${step}</span>`;
    list.appendChild(li);
  });
}
function initBuild() {
  $("build-back-btn").addEventListener("click", () => goToStep("confirm"));
  $("build-next-btn").addEventListener("click", () => goToStep("feedback"));
}

/* ------------------------------------------------------------------ */
/* Step: ฟีดแบ็ก                                                        */
/* ------------------------------------------------------------------ */
function renderFeedback() {
  const f = student().feedback;
  $("feedback-photo-preview").src = f.photo || "";
  $("feedback-photo-preview").classList.toggle("hidden", !f.photo);
  $("feedback-photo-placeholder").classList.toggle("hidden", !!f.photo);
  $("feedback-publish").checked = f.publish;
  renderStars();
}
function renderStars() {
  const f = student().feedback;
  const wrap = $("feedback-stars");
  wrap.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "material-symbols-outlined text-3xl transition-colors " + (i <= f.rating ? "text-primary fill" : "text-outline-variant");
    star.textContent = "star";
    star.addEventListener("click", () => {
      f.rating = i;
      renderStars();
    });
    wrap.appendChild(star);
  }
}
function initFeedback() {
  $("feedback-photo-input").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      student().feedback.photo = reader.result;
      renderFeedback();
    };
    reader.readAsDataURL(file);
  });
  $("feedback-publish").addEventListener("change", (e) => (student().feedback.publish = e.target.checked));
  $("feedback-back-btn").addEventListener("click", () => goToStep("build"));

  $("feedback-submit-btn").addEventListener("click", async () => {
    const s = student();
    try {
      const log = JSON.parse(localStorage.getItem(FEEDBACK_LOG_KEY) || "[]");
      log.push({ config: s.activeConfig, rating: s.feedback.rating, skillLevel: state.skillLevel, timestamp: new Date().toISOString() });
      localStorage.setItem(FEEDBACK_LOG_KEY, JSON.stringify(log.slice(-200)));
    } catch (err) { /* non-fatal */ }

    if (s.feedback.publish && s.feedback.photo) {
      try {
        const gallery = JSON.parse(localStorage.getItem(GALLERY_KEY) || "[]");
        gallery.push({ photo: s.feedback.photo, config: s.activeConfig, rating: s.feedback.rating, skillLevel: state.skillLevel });
        localStorage.setItem(GALLERY_KEY, JSON.stringify(gallery.slice(-60)));
      } catch (err) { /* non-fatal */ }
    }

    // Continuity with the account system: if logged in, also save the final
    // design to the API as a Project (same repurposing the Studio Save uses).
    if (window.MudMagicAPI?.isLoggedIn()) {
      try {
        await window.MudMagicAPI.saveDesignAsProject(s.activeConfig, designName(s.activeConfig));
        window.MudMagic?.showToast("บันทึกแบบเข้าบัญชีของคุณแล้ว", { icon: "cloud_done" });
      } catch (err) { /* offline/expired token — local save already succeeded */ }
    }

    if (state.activeStudent + 1 < state.studentCount) {
      state.activeStudent += 1;
      goToStep("results");
      window.MudMagic?.showToast(`ไปต่อ: นักเรียนคนที่ ${state.activeStudent + 1}/${state.studentCount}`, { icon: "person" });
    } else {
      goToStep("done");
      clearDraft();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Done + draft resume                                                 */
/* ------------------------------------------------------------------ */
function initDone() {
  $("done-restart-btn").addEventListener("click", () => {
    state.prompt = "";
    state.skillLevel = null;
    state.studentCount = 1;
    state.activeStudent = 0;
    state.students = [freshStudent()];
    $("idea-prompt").value = "";
    $("student-count").value = 1;
    $("student-mode-note").classList.add("hidden");
    $("idea-vague-hint").classList.add("hidden");
    $("idea-next-btn").disabled = true;
    $("idea-next-btn").classList.add("opacity-50");
    goToStep("idea");
  });
}

function initDraftBanner() {
  const draft = loadDraft();
  if (!draft || draft.step === "idea" || draft.step === "done") return;
  const banner = $("draft-banner");
  banner.classList.remove("hidden");
  $("draft-resume-btn").addEventListener("click", () => {
    state.prompt = draft.prompt || "";
    state.skillLevel = draft.skillLevel || null;
    state.studentCount = draft.studentCount || 1;
    state.activeStudent = draft.activeStudent || 0;
    state.students = (draft.students || [null]).map((d) => {
      const fresh = freshStudent();
      if (d?.activeConfig) fresh.activeConfig = d.activeConfig;
      if (d?.feedback) fresh.feedback = { ...fresh.feedback, ...d.feedback };
      return fresh;
    });
    $("idea-prompt").value = state.prompt;
    banner.classList.add("hidden");
    // Results/thumbnails regenerate deterministically from prompt+level+seed,
    // so resuming past "results" is safe even though we don't persist images.
    const resumeStep = state.skillLevel ? draft.step : "skill";
    goToStep(["customize", "confirm", "build", "feedback"].includes(resumeStep) && !state.students[state.activeStudent].activeConfig ? "results" : resumeStep);
    window.MudMagic?.showToast("กลับมาทำแบบร่างต่อแล้ว", { icon: "history" });
  });
  $("draft-discard-btn").addEventListener("click", () => {
    clearDraft();
    banner.classList.add("hidden");
  });
}

/* ------------------------------------------------------------------ */
function boot() {
  initIdea();
  initSkill();
  initResults();
  initCompare();
  initCustomize();
  initConfirm();
  initBuild();
  initFeedback();
  initDone();
  initDraftBanner();
  const label = $("progress-label");
  if (label) label.textContent = `1/${STEP_ORDER.length} · ${STEP_LABEL_TH.idea}`;
}
boot();
