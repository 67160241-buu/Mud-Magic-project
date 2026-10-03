// journey.js — the guided AI design journey (create.html): idea → skill level →
// AI results (filtered so nothing shown is harder than the chosen level) →
// compare → customize (live 3D + freeform sculpt + real-time difficulty check)
// → confirm/download guide → build (offline) → feedback.
//
// Runs on the same engine as the free-form Studio: pot-engine.js builds the
// 3D pot for all six vessel types (vase, bowl, pitcher, plate, mug, sculpture),
// vessels.js holds the design vocabulary and the difficulty / feasibility
// assessment, vessel-ai.js turns the idea into complete configs, and sculpt.js
// does freeform vertex sculpting. The finished design can be handed to the
// Studio (studio.html?d=...) for fine control.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildPotGroup, disposePotGroup } from "./pot-engine.js";
import { Sculptor } from "./sculpt.js";
import { suggestVessels, offlineVessels, readPrompt } from "./vessel-ai.js";
import { simplifyForSkill } from "./skill-fit.js";
import {
  VESSELS, VESSEL_IDS, NECKS, FEET, HANDLES, CLAYS, FINISHES, GLAZES, RAW_GLAZE, PATTERNS, SKILLS,
  normalizeConfig, configForVessel, encodeConfig, assess, glazeLabel, buildGuide,
} from "./vessels.js";

const DRAFT_KEY = "mudmagic_journey_draft_v1";
const GALLERY_KEY = "mudmagic_gallery";
const FEEDBACK_LOG_KEY = "mudmagic_feedback_log";
const SKILL_KEY = "mudmagic_skill"; // shared with the Studio's feasibility card
const STUCK_THRESHOLD = 3;
const RESULT_COUNT = 4;
const POOL_SIZE = 8;
const POOL_ATTEMPTS = 4;
const STRENGTH_SCALE = 0.5; // same brush feel as the Studio

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const toast = (msg, icon) => window.MudMagic?.showToast(msg, icon ? { icon } : undefined);
const round1 = (n) => Math.round(n * 10) / 10;

const LEVEL = Object.fromEntries(SKILLS.map((s) => [s.id, { id: s.id, label: s.labelEn, labelTh: s.label, max: s.max }]));
const LEVEL_DOT = { beginner: "#7C8872", intermediate: "#C18A52", advanced: "#A65D45" };

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* storage disabled — non-fatal */ }
}

/* ------------------------------------------------------------------ */
/* Framing — one scale so every vessel fills the view the same way      */
/* ------------------------------------------------------------------ */
function fitScale(group) {
  const { height, radius } = group.userData.fit;
  return Math.min(30, Math.max(0.05, 1.35 / Math.max(height, radius * 2 * 0.85, 0.05)));
}
function placeGroup(group, rotY) {
  const scale = fitScale(group);
  group.scale.setScalar(scale);
  group.position.y = -(group.userData.fit.height * scale) / 2;
  group.rotation.y = rotY;
  return scale;
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
    thumbCamera.position.set(0, 0.5, 3.2);
    thumbCamera.lookAt(0, 0, 0);
    const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
    key.position.set(2.6, 3.6, 2.4);
    thumbScene.add(key);
    const fill = new THREE.DirectionalLight(0xffe9dd, 0.85);
    fill.position.set(-3, 1.2, -2.2);
    thumbScene.add(fill);
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.5));
  }
  if (thumbGroup) {
    thumbScene.remove(thumbGroup);
    disposePotGroup(thumbGroup);
  }
  thumbGroup = buildPotGroup(config, { rings: 56, sides: 64 });
  placeGroup(thumbGroup, 0.65);
  thumbScene.add(thumbGroup);
  thumbRenderer.render(thumbScene, thumbCamera);
  return thumbRenderer.domElement.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* Results generation (skill-filtered, prompt-biased, all six vessels) */
/* ------------------------------------------------------------------ */
function dimsText(c) {
  return c.vessel === "plate" || c.vessel === "bowl"
    ? `กว้าง ${round1(c.belly)} · สูง ${round1(c.height)} ซม.`
    : `สูง ${round1(c.height)} · กว้าง ${round1(c.belly)} ซม.`;
}

function designKey(c) {
  return [c.vessel, Math.round(c.height), Math.round(c.belly), c.neck, c.foot, c.handle, c.color, c.surface, c.clay, c.modulation ? "m" : "-"].join("|");
}

/** The prompt the generators see: an explicit vessel pick is added unless the text already names one. */
function effectivePrompt(prompt, vesselPref) {
  if (vesselPref && !readPrompt(prompt).vessel) return `${VESSELS[vesselPref].label} ${prompt}`;
  return prompt;
}

function makeResult(design, skillId, simplified) {
  const config = normalizeConfig(design.config);
  const a = assess(config, skillId);
  const vessel = VESSELS[config.vessel];
  return {
    id: uid(),
    config,
    a,
    name: design.name,
    chip: `${vessel.en} · ${glazeLabel(config)}`,
    simplified,
    thumb: renderThumbnail(config),
  };
}

async function generateResults(prompt, skillId, seed, vesselPref) {
  const tier = LEVEL[skillId];
  const effPrompt = effectivePrompt(prompt, vesselPref);
  const fallbackVessel = vesselPref || "vase";
  const accepted = [];
  const seen = new Set();
  let source = "offline";
  let notice = "";
  let lastPool = [];

  const tryAdd = (design, simplified) => {
    if (accepted.length >= RESULT_COUNT) return;
    const config = normalizeConfig(design.config);
    if (assess(config, skillId).d5 > tier.max) return;
    const key = designKey(config);
    if (seen.has(key)) return;
    seen.add(key);
    accepted.push(makeResult({ ...design, config }, skillId, simplified));
  };

  for (let attempt = 0; attempt < POOL_ATTEMPTS && accepted.length < RESULT_COUNT; attempt++) {
    const poolSeed = seed * 7 + attempt;
    let pool;
    if (attempt === 0) {
      const res = await suggestVessels(effPrompt, { count: POOL_SIZE, seed: poolSeed, fallbackVessel, skillLevel: skillId });
      pool = res.designs;
      source = res.source;
      notice = res.notice || "";
    } else {
      pool = offlineVessels(effPrompt, { count: POOL_SIZE, seed: poolSeed, fallbackVessel });
    }
    lastPool = lastPool.concat(pool);
    pool.forEach((d) => tryAdd(d, false));
  }

  // Not enough designs already within reach? Ease the closest ones down to the
  // chosen level (never changing the vessel type) rather than show too few.
  if (accepted.length < RESULT_COUNT) {
    for (const d of lastPool) {
      if (accepted.length >= RESULT_COUNT) break;
      const s = simplifyForSkill(d.config, skillId);
      if (s.fits && s.changed) tryAdd({ ...d, config: s.config }, true);
    }
  }
  return { results: accepted, source, notice };
}

/* ------------------------------------------------------------------ */
/* State + draft persistence                                           */
/* ------------------------------------------------------------------ */
function freshStudent() {
  return { results: [], generated: false, compareIds: [], activeConfig: null, genSeed: 0, regenerateAttempts: 0, source: "offline", notice: "", feedback: { rating: 0, publish: true, photo: null } };
}
const state = {
  step: "idea",
  prompt: "",
  vesselPref: null,
  skillLevel: null,
  studentCount: 1,
  activeStudent: 0,
  students: [freshStudent()],
};
const student = () => state.students[state.activeStudent];

function saveDraft() {
  safeSet(
    DRAFT_KEY,
    JSON.stringify({
      step: state.step,
      prompt: state.prompt,
      vesselPref: state.vesselPref,
      skillLevel: state.skillLevel,
      studentCount: state.studentCount,
      activeStudent: state.activeStudent,
      students: state.students.map((s) => ({ activeConfig: s.activeConfig, feedback: { rating: s.feedback.rating, publish: s.feedback.publish } })),
    })
  );
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
const SUGGESTED_IDEAS = [
  "แจกันทรงสูงเรียบ สีเซจ",
  "แก้วมัคทรงกลมลายร่องลึก",
  "ชามผิวหยาบสไตล์ญี่ปุ่น ดินทราย",
  "เหยือกหูห่วงเคลือบเงาสีครีม",
  "จานตื้นขอบหยัก สีชมพู",
  "ประติมากรรมนามธรรม ไม่เคลือบ",
];

function isVaguePrompt(text) {
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.length < 6) return true;
  if (VAGUE_PHRASES.some((p) => t.includes(p)) && t.length < 20) return true;
  const words = t.replace(/[^฀-๿a-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  return words.length <= 2 && t.length < 14;
}

const PICK_ON = ["border-primary", "bg-primary", "text-on-primary"];
const PICK_OFF = ["border-outline-variant", "bg-surface-container-lowest", "text-on-surface-variant"];
function paintPick(btn, active) {
  PICK_ON.forEach((c) => btn.classList.toggle(c, active));
  PICK_OFF.forEach((c) => btn.classList.toggle(c, !active));
}

function renderVesselPrefs() {
  const row = $("idea-vessel-row");
  if (!row) return;
  row.innerHTML = "";
  const options = [{ id: null, label: "ให้ AI เลือก", icon: "auto_awesome" }, ...VESSEL_IDS.map((id) => ({ id, label: VESSELS[id].label, icon: VESSELS[id].icon }))];
  options.forEach((o) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.vesselPref = o.id || "auto";
    btn.className = "flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-sm transition-colors";
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">${o.icon}</span>${esc(o.label)}`;
    paintPick(btn, (state.vesselPref || null) === o.id);
    btn.addEventListener("click", () => {
      state.vesselPref = o.id;
      renderVesselPrefs();
    });
    row.appendChild(btn);
  });
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
  renderVesselPrefs();
  textarea.addEventListener("input", () => {
    state.prompt = textarea.value;
    // A vessel pick only counts as "not vague" context; the hint is about the text itself.
    $("idea-vague-hint").classList.toggle("hidden", !isVaguePrompt(textarea.value));
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
      safeSet(SKILL_KEY, state.skillLevel); // the Studio opens with the same level
      state.students.forEach((s) => { s.genSeed = 0; s.results = []; s.generated = false; s.compareIds = []; s.regenerateAttempts = 0; });
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
let resultsToken = 0;

function renderResults() {
  const s = student();
  $("results-student-badge").textContent = `นักเรียนคนที่ ${state.activeStudent + 1}/${state.studentCount}`;
  $("results-student-badge").classList.toggle("hidden", state.studentCount <= 1);
  $("results-subtitle").textContent = `เราคัดแบบจากไอเดีย "${state.prompt}" ที่ผ่านการกรองแล้วว่าปั้นได้จริงในระดับ ${LEVEL[state.skillLevel].labelTh} — แตะ Compare เพื่อเลือกไปเปรียบเทียบ (สูงสุด 3 แบบ) หรือ Customize เพื่อไปปรับแต่งเลย`;

  if (!s.generated) {
    $("results-empty").classList.add("hidden");
    const token = ++resultsToken;
    const studentIndex = state.activeStudent;
    showResultsLoading(true);
    generateResults(state.prompt, state.skillLevel, s.genSeed, state.vesselPref)
      .then(({ results, source, notice }) => {
        if (token !== resultsToken) return; // a newer request superseded this one
        const target = state.students[studentIndex];
        target.results = results;
        target.generated = true;
        target.source = source;
        target.notice = notice;
        showResultsLoading(false);
        if (state.step === "results" && state.activeStudent === studentIndex) renderResults();
      })
      .catch(() => {
        if (token !== resultsToken) return;
        showResultsLoading(false);
        $("results-empty").classList.remove("hidden");
        toast("สร้างแบบไม่สำเร็จ ลองกด 'สร้างแบบใหม่' อีกครั้ง", "error");
      });
    $("results-grid").innerHTML = "";
    return;
  }

  $("results-empty").classList.toggle("hidden", s.results.length > 0);
  const note = $("results-notice");
  if (note) {
    note.textContent =
      s.source === "openai"
        ? "AI ช่วยคัดสีเคลือบและลวดลายจากไอเดียของคุณ แล้วระบบจัดทรงให้ครบทั้ง 6 ประเภทภาชนะ"
        : "สร้างโดยระบบแนะนำแบบออฟไลน์ (ยังไม่ได้เชื่อม OpenAI) — ตีความคำสำคัญในไอเดียของคุณแล้วจัดทรงให้ครบทั้ง 6 ประเภทภาชนะ";
    note.classList.remove("hidden");
  }

  const grid = $("results-grid");
  grid.innerHTML = "";
  s.results.forEach((r) => {
    const inCompare = s.compareIds.includes(r.id);
    const dot = LEVEL_DOT[r.a.level];
    const card = document.createElement("div");
    card.className = "bg-surface-container-lowest rounded-xl overflow-hidden soft-shadow group transition-all duration-500 hover:shadow-xl" + (inCompare ? " ring-2 ring-primary" : "");
    card.innerHTML = `
      <div class="relative h-64 w-full bg-surface-container overflow-hidden">
        <img class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" src="${r.thumb}" alt="${esc(r.name)} — 3D render" />
        <div class="absolute bottom-4 left-4">
          <span class="bg-surface-variant/80 backdrop-blur text-on-surface-variant font-label-sm text-label-sm px-3 py-1 rounded-full uppercase tracking-wider">${esc(r.chip)}</span>
        </div>
        ${inCompare ? '<div class="absolute top-4 right-4 bg-primary text-on-primary font-label-sm text-label-sm px-3 py-1 rounded-full">เลือกแล้ว</div>' : ""}
      </div>
      <div class="p-7">
        <div class="mb-5">
          <h2 class="font-headline-md text-[26px] leading-8 text-on-surface mb-2">${esc(r.name)}</h2>
          <div class="flex items-center gap-2 font-label-sm text-label-sm" style="color:${dot}">
            <span class="material-symbols-outlined fill text-[14px]">circle</span> ${esc(r.a.levelLabelEn)} · ${esc(r.a.levelLabel)}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-5 pb-5 border-b border-outline-variant/30">
          <div>
            <span class="block font-label-sm text-label-sm text-on-surface-variant mb-1 uppercase">Difficulty</span>
            <span class="font-body-lg text-body-lg text-primary">${r.a.d5}/5</span>
          </div>
          <div>
            <span class="block font-label-sm text-label-sm text-on-surface-variant mb-1 uppercase">Feasibility</span>
            <span class="font-body-lg text-body-lg text-primary">${r.a.feasibility}%</span>
          </div>
        </div>
        <ul class="space-y-2 font-body-md text-sm text-on-surface-variant mb-7">
          <li class="flex items-center gap-2"><span class="material-symbols-outlined text-secondary text-[20px]">check</span>${esc(r.a.method)}</li>
          <li class="flex items-center gap-2"><span class="material-symbols-outlined text-secondary text-[20px]">straighten</span>${esc(dimsText(r.config))}</li>
          <li class="flex items-start gap-2 text-xs"><span class="material-symbols-outlined text-secondary text-[18px]">check</span><span>${esc(r.a.notes[0])}</span></li>
          ${r.simplified ? '<li class="flex items-start gap-2 text-xs text-tertiary"><span class="material-symbols-outlined text-[18px]">tune</span><span>ปรับให้ง่ายลงจากแบบ AI เดิม เพื่อให้พอดีกับระดับฝีมือของคุณ</span></li>' : ""}
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
          toast("เปรียบเทียบได้สูงสุด 3 แบบ", "info");
          return;
        }
        s.compareIds.push(r.id);
        s.regenerateAttempts = 0;
      }
      renderResults();
    });
    card.querySelector('[data-act="customize"]').addEventListener("click", () => {
      s.activeConfig = normalizeConfig(r.config);
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

function showResultsLoading(on) {
  const el = $("results-loading");
  if (el) el.classList.toggle("hidden", !on);
  $("results-regenerate-btn").disabled = on;
  $("results-regenerate-btn").classList.toggle("opacity-50", on);
}

function initResults() {
  $("results-regenerate-btn").addEventListener("click", () => {
    const s = student();
    s.genSeed += 1;
    s.regenerateAttempts += 1;
    s.results = [];
    s.generated = false;
    s.compareIds = [];
    renderResults();
  });
  $("results-back-btn").addEventListener("click", () => goToStep("skill"));
  $("results-compare-btn").addEventListener("click", () => goToStep("compare"));
  $("stuck-simplify-btn").addEventListener("click", () => {
    goToStep("idea");
    toast("ลองเพิ่มรายละเอียดในไอเดีย เช่น ประเภท ทรง สี หรือผิวสัมผัส", "edit");
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
const LEVEL_DOTS = { beginner: 1, intermediate: 2, advanced: 3 };

function renderCompare() {
  const s = student();
  const picked = s.compareIds.map((id) => s.results.find((r) => r.id === id)).filter(Boolean);
  // Recommended = the design with the most feasibility headroom for the chosen level
  const recommendedId = picked.slice().sort((a, b) => b.a.feasibility - a.a.feasibility)[0]?.id;

  const grid = $("compare-grid");
  grid.innerHTML = "";
  picked.forEach((r) => {
    const isRec = r.id === recommendedId && picked.length > 1;
    const dots = LEVEL_DOTS[r.a.level] || 1;
    const vessel = VESSELS[r.config.vessel];
    const card = document.createElement("div");
    card.className = "design-card relative flex flex-col bg-surface-container-lowest rounded-xl overflow-hidden " + (isRec ? "border-2 border-primary/20 bg-surface-container-low shadow-sm" : "border border-outline-variant/30");
    card.innerHTML = `
      ${isRec ? '<div class="absolute top-4 left-4 z-10 bg-primary text-on-primary font-label-sm text-label-sm px-3 py-1.5 rounded-full flex items-center gap-1 shadow-sm"><span class="material-symbols-outlined fill text-[16px]">star</span> Recommended</div>' : ""}
      <div class="relative w-full h-64 md:h-72 bg-surface-container-high overflow-hidden">
        <img class="w-full h-full object-cover" src="${r.thumb}" alt="${esc(r.name)}" />
      </div>
      <div class="p-6 md:p-7 flex flex-col flex-grow">
        <h3 class="font-headline-md text-[26px] leading-8 text-on-background mb-2">${esc(r.name)}</h3>
        <div class="flex-grow mt-4">
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Shape</span>
            <span class="text-sm text-on-background font-medium text-right">${esc(vessel.label)} · ${esc(dimsText(r.config))}</span>
          </div>
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Style</span>
            <span class="${CHIP_STYLE[r.config.surface]} font-label-sm text-label-sm px-3 py-1 rounded-full">${esc(r.chip)}</span>
          </div>
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Technique</span>
            <span class="text-sm text-on-background text-right">${esc(r.a.method)}</span>
          </div>
          <div class="flex justify-between items-center py-3 border-b border-outline-variant/50">
            <span class="text-sm text-on-surface-variant">Feasibility</span>
            <span class="text-sm text-on-background font-medium">${r.a.feasibility}%</span>
          </div>
          <div class="flex justify-between items-center py-3">
            <span class="text-sm text-on-surface-variant">Difficulty · ${r.a.d5}/5</span>
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
      s.activeConfig = normalizeConfig(r.config);
      goToStep("customize");
    });
    grid.appendChild(card);
  });
}
function initCompare() {
  $("compare-back-btn").addEventListener("click", () => goToStep("results"));
}

/* ------------------------------------------------------------------ */
/* Step: ปรับแต่ง — live 3D + controls + sculpt + difficulty banner     */
/* ------------------------------------------------------------------ */
let scene, camera, renderer, controls, potGroup, sculptor, brushCursor, dimsChip, ground;
let potScale = 1;
let potRotY = 0.5;
let rebuildQueued = false;
let viewportReady = false;

function initViewport() {
  if (viewportReady) return;
  viewportReady = true;
  const container = $("customize-viewport");

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0.8, 3.5);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.6;
  controls.maxDistance = 6;
  controls.minPolarAngle = Math.PI * 0.12;
  controls.maxPolarAngle = Math.PI * 0.88;
  controls.target.set(0, 0, 0);
  controls.update();

  const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
  key.position.set(2.6, 3.6, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 10;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe9dd, 0.85);
  fill.position.set(-3, 1.2, -2.2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  ground = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), new THREE.ShadowMaterial({ opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  sculptor = new Sculptor(camera, renderer.domElement, controls);

  brushCursor = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.06, 32),
    new THREE.MeshBasicMaterial({ color: 0x88452f, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
  );
  brushCursor.visible = false;
  brushCursor.renderOrder = 10;
  scene.add(brushCursor);

  dimsChip = document.createElement("div");
  dimsChip.className = "absolute left-3 bottom-3 bg-surface/90 backdrop-blur text-on-surface-variant text-xs px-3 py-1.5 rounded-full pointer-events-none";
  dimsChip.id = "customize-dims";
  container.appendChild(dimsChip);

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

  buildControls();
  initSculptControls();
}

function updateBrushCursor() {
  if (!sculptor || !sculptor.active || !potGroup) {
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
  potGroup.localToWorld(brushCursor.position);
  brushCursor.scale.setScalar(sculptor.brushRadius * potScale);
  if (n) {
    const wn = n.clone().transformDirection(potGroup.matrixWorld);
    brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wn);
  }
}

function rebuildPot() {
  rebuildQueued = false;
  if (!scene) return;
  if (potGroup) {
    potRotY = potGroup.rotation.y;
    scene.remove(potGroup);
    disposePotGroup(potGroup);
  }
  potGroup = buildPotGroup(student().activeConfig);
  potScale = placeGroup(potGroup, potRotY);
  ground.position.y = potGroup.position.y - 0.003;
  scene.add(potGroup);
  sculptor.setTarget(potGroup.getObjectByName("pot-body"));
  updateDims();
}
function scheduleRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(rebuildPot);
}

function updateDims() {
  if (!dimsChip || !potGroup) return;
  const info = potGroup.userData.info || {};
  const c = student().activeConfig;
  const parts = [`สูง ${round1(info.heightCm ?? c.height)} ซม.`, `กว้างสุด ${round1(c.belly)} ซม.`];
  if (!VESSELS[c.vessel].solid && info.rimCm) parts.push(`ปาก ${round1(info.rimCm)} ซม.`);
  dimsChip.textContent = parts.join(" · ");
}

function currentPatternId(c) {
  if (!c.modulation) return "none";
  const m = c.modulation;
  const hit = PATTERNS.find(
    (p) =>
      p.mod &&
      p.mod.scallopMotif === m.scallopMotif &&
      p.mod.scallopWaveform === m.scallopWaveform &&
      (p.mod.ripples > 0) === (m.ripples > 0) &&
      (p.mod.ruffles > 0) === (m.ruffles > 0) &&
      (p.mod.scallops > 0) === (m.scallops > 0)
  );
  return hit ? hit.id : null; // null = a custom pattern (e.g. from the AI) — no preset highlighted
}

function applyConfig(partial) {
  const s = student();
  const cur = s.activeConfig;
  if (partial.vessel && partial.vessel !== cur.vessel) {
    s.activeConfig = configForVessel(partial.vessel, { clay: cur.clay, texture: cur.texture, color: cur.color, surface: cur.surface, modulation: cur.modulation });
  } else {
    s.activeConfig = normalizeConfig({ ...cur, ...partial });
  }
  scheduleRebuild();
  syncControls();
  refreshDifficultyBanner();
  saveDraft();
}

/* ---- control panel (built once, synced on every change) ---- */
const refs = { vessel: {}, neck: {}, foot: {}, handle: {}, finish: {}, pattern: {}, glaze: {}, sliders: {} };

function sectionEl(icon, title) {
  const wrap = document.createElement("div");
  wrap.className = "space-y-2.5";
  wrap.innerHTML = `<label class="font-label-sm text-label-sm text-tertiary uppercase tracking-wider flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:18px;">${icon}</span> ${esc(title)}</label>`;
  return wrap;
}
function optionGrid(cols, entries, store, onPick) {
  const grid = document.createElement("div");
  grid.className = `grid ${cols} gap-2`;
  entries.forEach(({ id, label, icon }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.opt = id;
    btn.className = "border font-body-md text-sm py-2.5 rounded-lg flex items-center justify-center gap-1.5";
    btn.innerHTML = (icon ? `<span class="material-symbols-outlined" style="font-size:18px;">${icon}</span>` : "") + esc(label);
    btn.addEventListener("click", () => onPick(id));
    store[id] = btn;
    grid.appendChild(btn);
  });
  return grid;
}
function sliderRow(key, label, step, onInput) {
  const row = document.createElement("div");
  row.innerHTML = `<div class="flex justify-between text-xs text-on-surface-variant mb-1"><span>${esc(label)}</span><span data-val class="font-medium text-on-surface"></span></div>`;
  const input = document.createElement("input");
  input.type = "range";
  input.step = step;
  input.className = "w-full accent-primary";
  input.id = `cz-${key}`;
  input.addEventListener("input", () => onInput(Number(input.value)));
  row.appendChild(input);
  refs.sliders[key] = { row, input, val: row.querySelector("[data-val]") };
  return row;
}

function buildControls() {
  const host = $("customize-controls");
  host.innerHTML = "";

  let sec = sectionEl("category", "ประเภทชิ้นงาน");
  sec.appendChild(optionGrid("grid-3", VESSEL_IDS.map((id) => ({ id, label: VESSELS[id].label, icon: VESSELS[id].icon })), refs.vessel, (id) => applyConfig({ vessel: id })));
  host.appendChild(sec);

  sec = sectionEl("straighten", "ขนาด");
  const sizes = document.createElement("div");
  sizes.className = "space-y-3";
  sizes.appendChild(sliderRow("height", "ความสูง (ซม.)", 0.5, (v) => applyConfig({ height: v })));
  sizes.appendChild(sliderRow("belly", "ความกว้างสุด (ซม.)", 0.5, (v) => applyConfig({ belly: v })));
  sizes.appendChild(sliderRow("wall", "ความหนาผนัง (ซม.)", 0.1, (v) => applyConfig({ wall: v })));
  sec.appendChild(sizes);
  host.appendChild(sec);

  sec = sectionEl("border_top", "ปากภาชนะ");
  sec.appendChild(optionGrid("grid-2", Object.keys(NECKS).map((id) => ({ id, label: NECKS[id].label })), refs.neck, (id) => applyConfig({ neck: id })));
  host.appendChild(sec);

  sec = sectionEl("vertical_align_bottom", "ฐาน");
  sec.appendChild(optionGrid("grid-3", Object.keys(FEET).map((id) => ({ id, label: FEET[id].label })), refs.foot, (id) => applyConfig({ foot: id })));
  host.appendChild(sec);

  sec = sectionEl("gesture", "หูจับ");
  sec.appendChild(optionGrid("grid-2", Object.keys(HANDLES).map((id) => ({ id, label: HANDLES[id].label })), refs.handle, (id) => applyConfig({ handle: id })));
  host.appendChild(sec);

  sec = sectionEl("waves", "ลวดลายผิว");
  sec.appendChild(
    optionGrid("grid-3", PATTERNS.map((p) => ({ id: p.id, label: p.label })), refs.pattern, (id) => {
      const preset = PATTERNS.find((p) => p.id === id);
      applyConfig({ modulation: preset.mod ? { ...preset.mod } : null });
    })
  );
  host.appendChild(sec);

  sec = sectionEl("texture", "พื้นผิว");
  sec.appendChild(optionGrid("grid-3", Object.keys(FINISHES).map((id) => ({ id, label: FINISHES[id].label })), refs.finish, (id) => applyConfig({ surface: id })));
  host.appendChild(sec);

  sec = sectionEl("palette", "สีเคลือบ");
  const row = document.createElement("div");
  row.className = "flex flex-wrap gap-2";
  GLAZES.forEach((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = g.label;
    b.dataset.color = g.hex;
    b.className = "w-8 h-8 rounded-full ring-1 ring-outline-variant/50";
    b.style.background = g.hex;
    b.addEventListener("click", () => applyConfig({ color: g.hex }));
    refs.glaze[g.hex.toLowerCase()] = b;
    row.appendChild(b);
  });
  const raw = document.createElement("button");
  raw.type = "button";
  raw.title = "ไม่เคลือบ (เห็นเนื้อดิน)";
  raw.dataset.color = RAW_GLAZE;
  raw.className = "w-8 h-8 rounded-full ring-1 ring-outline-variant/50 flex items-center justify-center text-on-surface-variant";
  raw.style.background = "repeating-linear-gradient(45deg,#e8dcc6,#e8dcc6 4px,#d9c9ad 4px,#d9c9ad 8px)";
  raw.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">block</span>';
  raw.addEventListener("click", () => applyConfig({ color: RAW_GLAZE }));
  refs.glaze[RAW_GLAZE] = raw;
  row.appendChild(raw);
  sec.appendChild(row);
  host.appendChild(sec);

  const link = document.createElement("a");
  link.id = "customize-studio-link";
  link.className = "flex items-center justify-between gap-3 border border-outline-variant rounded-lg px-4 py-3 text-sm text-on-surface-variant hover:border-primary hover:text-primary transition-colors";
  link.innerHTML = '<span class="flex flex-col"><span class="font-medium text-on-surface">ปรับละเอียดใน Studio</span><span class="text-xs">โปรไฟล์โค้ง ลายสี บิด/เหลี่ยม ดินและเคลือบเพิ่มเติม</span></span><span class="material-symbols-outlined">open_in_new</span>';
  host.appendChild(link);
}

const ACTIVE_BTN = ["border-primary", "bg-surface-container-low", "text-primary"];
const INACTIVE_BTN = ["border-outline-variant", "text-on-surface-variant", "bg-surface-container-lowest"];
function paintOption(btn, active) {
  ACTIVE_BTN.forEach((c) => btn.classList.toggle(c, active));
  INACTIVE_BTN.forEach((c) => btn.classList.toggle(c, !active));
}

function syncControls() {
  const c = student().activeConfig;
  const preset = VESSELS[c.vessel];
  Object.entries(refs.vessel).forEach(([id, b]) => paintOption(b, id === c.vessel));
  Object.entries(refs.neck).forEach(([id, b]) => paintOption(b, id === c.neck));
  Object.entries(refs.foot).forEach(([id, b]) => paintOption(b, id === c.foot));
  Object.entries(refs.handle).forEach(([id, b]) => paintOption(b, id === c.handle));
  Object.entries(refs.finish).forEach(([id, b]) => paintOption(b, id === c.surface));
  const pat = currentPatternId(c);
  Object.entries(refs.pattern).forEach(([id, b]) => paintOption(b, id === pat));

  const colorKey = String(c.color).toLowerCase();
  Object.entries(refs.glaze).forEach(([key, b]) => {
    const active = key === colorKey;
    b.classList.toggle("ring-2", active);
    b.classList.toggle("ring-primary", active);
    b.classList.toggle("ring-1", !active);
    b.classList.toggle("ring-outline-variant/50", !active);
  });

  const setSlider = (key, range, value, digits) => {
    const s = refs.sliders[key];
    s.input.min = range[0];
    s.input.max = range[1];
    if (Number(s.input.value) !== value) s.input.value = value;
    s.val.textContent = value.toFixed(digits);
  };
  setSlider("height", preset.height, c.height, 1);
  setSlider("belly", preset.belly, c.belly, 1);
  setSlider("wall", preset.wall, c.wall, 1);
  refs.sliders.wall.row.classList.toggle("hidden", !!preset.solid); // a solid sculpture has no wall

  const link = $("customize-studio-link");
  if (link) link.href = studioUrl(c);
}

function studioUrl(config) {
  return `studio.html?d=${encodeConfig(config)}`;
}

function refreshDifficultyBanner() {
  const cfg = student().activeConfig;
  const a = assess(cfg, state.skillLevel || "intermediate");
  const banner = $("difficulty-banner");
  const exceeds = a.d5 > LEVEL[state.skillLevel || "intermediate"].max;
  banner.classList.toggle("bg-amber-50", exceeds);
  banner.classList.toggle("border-amber-300", exceeds);
  banner.classList.toggle("text-amber-900", exceeds);
  banner.classList.toggle("bg-secondary-container", !exceeds);
  banner.classList.toggle("border-secondary/30", !exceeds);
  banner.classList.toggle("text-on-secondary-container", !exceeds);
  banner.querySelector("[data-banner-icon]").textContent = exceeds ? "warning" : "check_circle";
  const levelName = LEVEL[state.skillLevel || "intermediate"].labelTh;
  banner.querySelector("[data-banner-text]").textContent = exceeds
    ? `การปรับแต่งนี้ยากกว่าระดับที่คุณเลือกไว้ (${levelName}) — ตอนนี้อยู่ระดับ ${a.levelLabel} (${a.d5}/5) ยังปั้นได้แต่ต้องฝึกมือเพิ่ม · ${a.notes[0]}`
    : `อยู่ในระดับที่เหมาะกับคุณ (${a.levelLabel} · ${a.d5}/5 · ทำได้จริง ${a.feasibility}%)`;
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
  sculptor.setBrushStrength(Number(strength.value) * STRENGTH_SCALE);
  size.addEventListener("input", () => sculptor.setBrushRadius(Number(size.value)));
  strength.addEventListener("input", () => sculptor.setBrushStrength(Number(strength.value) * STRENGTH_SCALE));
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
    rebuildPot();
    toast("ล้างการปั้นอิสระ กลับเป็นทรงตั้งต้นแล้ว", "restart_alt");
  });
}

function enterCustomize() {
  initViewport();
  const s = student();
  if (!s.activeConfig) {
    const first = s.results[0];
    s.activeConfig = first ? normalizeConfig(first.config) : normalizeConfig({ vessel: "mug" });
  } else {
    s.activeConfig = normalizeConfig(s.activeConfig); // also upgrades drafts saved by the mug-only journey
  }
  rebuildPot();
  syncControls();
  refreshDifficultyBanner();
}
function initCustomize() {
  $("customize-back-btn").addEventListener("click", () => goToStep(student().compareIds.length > 0 ? "compare" : "results"));
  $("customize-next-btn").addEventListener("click", () => goToStep("confirm"));
}

/** Snapshot of the viewport as it is now (sculpt brush ring hidden). */
function snapshot() {
  if (brushCursor) brushCursor.visible = false;
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
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

/** Split the Studio's Thai Markdown guide into the pieces the screens and the PNG need. */
function guideParts(config) {
  const md = buildGuide(config, state.skillLevel || "intermediate");
  const sections = {};
  let cur = null;
  md.split("\n").forEach((line) => {
    if (line.startsWith("## ")) {
      cur = line.slice(3).trim();
      sections[cur] = [];
    } else if (cur && line.trim()) sections[cur].push(line.trim());
  });
  const bullets = (name) => (sections[name] || []).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return {
    md,
    specs: bullets("สเปกชิ้นงาน"),
    difficulty: bullets("ความยาก"),
    steps: (sections["ขั้นตอน"] || []).filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s*/, "")),
  };
}

async function buildGuideCanvas(config, snapshotDataUrl) {
  try {
    await document.fonts.load('600 40px "Noto Sans Thai"');
    await document.fonts.load('400 20px "Noto Sans Thai"');
  } catch (err) { /* font API unsupported — system fallback still renders Thai */ }
  const g = guideParts(config);
  const a = assess(config, state.skillLevel || "intermediate");
  const W = 1240;
  const measure = document.createElement("canvas").getContext("2d");

  // Pass 1: lay out so the page is exactly as tall as the content needs.
  const imgSize = 460;
  const tx = 560;
  const rightW = W - tx - 60;
  measure.font = '400 18px "Noto Sans Thai", sans-serif';
  const rightLines = [];
  g.specs.forEach((t) => wrapCanvasText(measure, t, rightW).forEach((l) => rightLines.push(l)));
  const rightHeight = 220 + rightLines.length * 27 + 20;
  const stepsTop = Math.max(170 + imgSize, rightHeight) + 70;
  measure.font = '400 21px "Noto Sans Thai", sans-serif';
  let stepsHeight = 44;
  g.steps.forEach((step, i) => {
    stepsHeight += wrapCanvasText(measure, `${i + 1}. ${step}`, W - 120).length * 30 + 12;
  });
  const H = Math.max(1754, stepsTop + stepsHeight + 90);

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
  ctx.fillText(`${VESSELS[config.vessel].label}  ·  ระดับที่เลือก: ${LEVEL[state.skillLevel || "intermediate"].labelTh}  ·  ความยากของแบบนี้: ${a.levelLabel} (${a.d5}/5)  ·  ทำได้จริง ${a.feasibility}%`, 60, 130);

  const img = await loadImage(snapshotDataUrl);
  // Keep the snapshot's aspect ratio instead of stretching it into a square.
  const ratio = img.width / img.height;
  const dw = ratio >= 1 ? imgSize : imgSize * ratio;
  const dh = ratio >= 1 ? imgSize / ratio : imgSize;
  ctx.fillStyle = "#F6ECE5";
  ctx.fillRect(60, 170, imgSize, imgSize);
  ctx.drawImage(img, 60 + (imgSize - dw) / 2, 170 + (imgSize - dh) / 2, dw, dh);

  let ty = 220;
  ctx.fillStyle = "#1F1B17";
  ctx.font = '600 24px "Noto Sans Thai", sans-serif';
  ctx.fillText("สเปกชิ้นงาน", tx, ty);
  ty += 40;
  ctx.font = '400 18px "Noto Sans Thai", sans-serif';
  rightLines.forEach((line) => {
    ctx.fillText(line, tx, ty);
    ty += 27;
  });

  let sy = stepsTop;
  ctx.font = '600 28px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#88452F";
  ctx.fillText("ขั้นตอนการปั้น", 60, sy);
  sy += 44;
  ctx.font = '400 21px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#1F1B17";
  g.steps.forEach((step, i) => {
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

function designName(config) {
  const c = normalizeConfig(config);
  return `${VESSELS[c.vessel].label} · ${glazeLabel(c)} · ${Math.round(c.height)}cm`;
}

function renderConfirm() {
  const cfg = student().activeConfig;
  const a = assess(cfg, state.skillLevel || "intermediate");
  const g = guideParts(cfg);
  $("confirm-name").textContent = designName(cfg);
  $("confirm-summary-vessel").textContent = `${VESSELS[cfg.vessel].label} (${VESSELS[cfg.vessel].en})`;
  $("confirm-summary-size").textContent = dimsText(cfg);
  $("confirm-summary-detail").textContent = `${NECKS[cfg.neck].label} · ${FEET[cfg.foot].label} · ${HANDLES[cfg.handle].label}`;
  $("confirm-summary-material").textContent = `${CLAYS[cfg.clay].label} · ${glazeLabel(cfg)} · ${FINISHES[cfg.surface].label}`;
  $("confirm-summary-level").textContent = `${a.levelLabelEn} (${a.levelLabel}) · ${a.d5}/5 · ทำได้จริง ${a.feasibility}%`;
  $("confirm-summary-method").textContent = a.method;
  $("confirm-summary-reasons").textContent = a.allNotes.join(" · ");
  const list = $("confirm-steps");
  list.innerHTML = "";
  g.steps.forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    list.appendChild(li);
  });
  $("confirm-image").src = snapshot();
  $("confirm-studio-link").href = studioUrl(cfg);
}

function download(filename, href) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = href;
  document.body.appendChild(link);
  link.click();
  link.remove();
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
      const canvas = await buildGuideCanvas(student().activeConfig, snapshot());
      download("mudmagic-guide.png", canvas.toDataURL("image/png"));
      toast("ดาวน์โหลดคู่มือแล้ว", "download");
    } catch (err) {
      toast("สร้างไฟล์คู่มือไม่สำเร็จ ลองใหม่อีกครั้ง", "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
  $("confirm-download-md-btn").addEventListener("click", () => {
    const md = guideParts(student().activeConfig).md;
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    download("mudmagic-guide.md", url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("ดาวน์โหลดคู่มือ (ข้อความ) แล้ว", "download");
  });
}

/* ------------------------------------------------------------------ */
/* Step: ลงมือปั้น (offline — no system response per spec)              */
/* ------------------------------------------------------------------ */
function renderBuild() {
  const list = $("build-steps");
  list.innerHTML = "";
  guideParts(student().activeConfig).steps.forEach((step) => {
    const li = document.createElement("li");
    li.className = "flex items-start gap-3 py-2.5";
    li.innerHTML = `<span class="material-symbols-outlined text-primary" style="font-size:20px;">check_circle</span><span>${esc(step)}</span>`;
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
        toast("บันทึกแบบเข้าบัญชีของคุณแล้ว", "cloud_done");
      } catch (err) { /* offline/expired token — local save already succeeded */ }
    }

    if (state.activeStudent + 1 < state.studentCount) {
      state.activeStudent += 1;
      goToStep("results");
      toast(`ไปต่อ: นักเรียนคนที่ ${state.activeStudent + 1}/${state.studentCount}`, "person");
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
    state.vesselPref = null;
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
    renderVesselPrefs();
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
    state.vesselPref = VESSELS[draft.vesselPref] ? draft.vesselPref : null;
    state.skillLevel = LEVEL[draft.skillLevel] ? draft.skillLevel : null;
    if (state.skillLevel) safeSet(SKILL_KEY, state.skillLevel);
    state.studentCount = draft.studentCount || 1;
    state.activeStudent = draft.activeStudent || 0;
    state.students = (draft.students || [null]).map((d) => {
      const fresh = freshStudent();
      if (d?.activeConfig) fresh.activeConfig = normalizeConfig(d.activeConfig); // old mug drafts upgrade here
      if (d?.feedback) fresh.feedback = { ...fresh.feedback, ...d.feedback };
      return fresh;
    });
    $("idea-prompt").value = state.prompt;
    $("idea-next-btn").disabled = !state.prompt.trim();
    $("idea-next-btn").classList.toggle("opacity-50", !state.prompt.trim());
    renderVesselPrefs();
    banner.classList.add("hidden");
    // Results/thumbnails regenerate from prompt+level+seed, so resuming past
    // "results" is safe even though we don't persist images.
    const resumeStep = state.skillLevel ? draft.step : "skill";
    goToStep(["customize", "confirm", "build", "feedback"].includes(resumeStep) && !state.students[state.activeStudent].activeConfig ? "results" : resumeStep);
    toast("กลับมาทำแบบร่างต่อแล้ว", "history");
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
  window.MudMagicJourney = { state, studioUrl }; // read-only handle for debugging and tests
}
boot();
