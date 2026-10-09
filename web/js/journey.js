// journey.js — the guided AI design journey (create.html), four steps:
//   1. idea      — prompt, optional vessel type and skill level on one screen
//   2. results   — AI designs filtered to the chosen level, "more like this"
//                  remixes and an inline side-by-side compare
//   3. customize — the full Studio editor, embedded (live difficulty check)
//   4. finish    — summary, clay estimate, step checklist, guide downloads,
//                  save to the account, share link and optional photo feedback
//
// Runs on the same engine as the free-form Studio: pot-engine.js builds the
// 3D pot for all six vessel types, vessels.js holds the design vocabulary and
// the difficulty / feasibility assessment and vessel-ai.js turns the idea into
// complete configs. The customize step embeds studio.html?embed=1 and receives
// every change back through postMessage.
import * as THREE from "three";
import { buildPotGroup, disposePotGroup } from "./pot-engine.js";
import { suggestVessels, offlineVessels, readPrompt, remixConfig } from "./vessel-ai.js";
import { aiAvailable } from "./ai-design.js";
import { simplifyForSkill } from "./skill-fit.js";
import {
  VESSELS, VESSEL_IDS, NECKS, FEET, HANDLES, CLAYS, FINISHES, SKILLS,
  normalizeConfig, encodeConfig, assess, glazeLabel, buildGuide,
} from "./vessels.js";

const DRAFT_KEY = "mudmagic_journey_draft_v2";
const GALLERY_KEY = "mudmagic_gallery";
const FEEDBACK_LOG_KEY = "mudmagic_feedback_log";
const RECENT_KEY = "mudmagic_recent_ideas";
const SKILL_KEY = "mudmagic_skill"; // shared with the Studio's feasibility card
const RESULT_COUNT = 4;
const POOL_SIZE = 8;
const POOL_ATTEMPTS = 4;
const MAX_COMPARE = 3;
const SHRINK = 0.88; // typical stoneware: ~12% linear shrinkage from wet to fired

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const toast = (msg, icon) => window.MudMagic?.showToast(esc(msg), icon ? { icon } : undefined);
const round1 = (n) => Math.round(n * 10) / 10;

const LEVEL = Object.fromEntries(SKILLS.map((s) => [s.id, { id: s.id, label: s.labelEn, labelTh: s.label, max: s.max }]));
const LEVEL_DOT = { beginner: "#7C8872", intermediate: "#C18A52", advanced: "#A65D45" };

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (err) { /* storage disabled — non-fatal */ }
}
function safeGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch (err) { return fallback; }
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
/* Offscreen thumbnail renderer (result cards)                          */
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
  // Flat pieces (plates, low bowls) are shot from higher up so their outline reads.
  const flat = config.height < config.belly * 0.5;
  thumbCamera.position.set(0, flat ? 2.2 : 0.5, flat ? 2.4 : 3.2);
  thumbCamera.lookAt(0, 0, 0);
  thumbRenderer.render(thumbScene, thumbCamera);
  return thumbRenderer.domElement.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* Results generation (skill-filtered, prompt-biased, all six vessels) */
/* ------------------------------------------------------------------ */
function dimsText(c, k = 1) {
  const h = round1(c.height * k);
  const w = round1(c.belly * k);
  return c.vessel === "plate" || c.vessel === "bowl" ? `กว้าง ${w} · สูง ${h} ซม.` : `สูง ${h} · กว้าง ${w} ซม.`;
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

/** Keeps designs within the level, de-duplicated; eases the closest ones down when too few fit. */
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function collect(pools, skillId) {
  const tier = LEVEL[skillId];
  const accepted = [];
  const seen = new Set();
  // Each thumbnail is a WebGL render; yield between them so the page stays responsive.
  const tryAdd = async (design, simplified) => {
    if (accepted.length >= RESULT_COUNT) return;
    const config = normalizeConfig(design.config);
    if (assess(config, skillId).d5 > tier.max) return;
    const key = designKey(config);
    if (seen.has(key)) return;
    seen.add(key);
    await nextFrame();
    accepted.push(makeResult({ ...design, config }, skillId, simplified));
  };
  for (const d of pools) await tryAdd(d, false);
  if (accepted.length < RESULT_COUNT) {
    for (const d of pools) {
      if (accepted.length >= RESULT_COUNT) break;
      const s = simplifyForSkill(d.config, skillId);
      if (s.fits && s.changed) await tryAdd({ ...d, config: s.config }, true);
    }
  }
  return accepted;
}

async function generateResults(prompt, skillId, seed, vesselPref) {
  const effPrompt = effectivePrompt(prompt, vesselPref);
  const fallbackVessel = vesselPref || "vase";
  let source = "offline";
  let notice = "";
  let pool = [];
  for (let attempt = 0; attempt < POOL_ATTEMPTS; attempt++) {
    const poolSeed = seed * 7 + attempt;
    if (attempt === 0) {
      const res = await suggestVessels(effPrompt, { count: POOL_SIZE, seed: poolSeed, fallbackVessel, skillLevel: skillId });
      pool = pool.concat(res.designs);
      source = res.source;
      notice = res.notice || "";
    } else {
      pool = pool.concat(offlineVessels(effPrompt, { count: POOL_SIZE, seed: poolSeed, fallbackVessel }));
    }
    const fitting = pool.filter((d) => assess(normalizeConfig(d.config), skillId).d5 <= LEVEL[skillId].max);
    if (fitting.length >= RESULT_COUNT * 2) break;
  }
  return { results: await collect(pool, skillId), source, notice };
}

/** "More like this": seeded remixes of one design, kept within the level. */
async function remixResults(base, skillId, seed) {
  const pool = [];
  for (let i = 0; i < 4; i++) pool.push(...remixConfig(base.config, seed * 10 + i, 4));
  return collect(pool, skillId);
}

/* ------------------------------------------------------------------ */
/* State + draft persistence                                           */
/* ------------------------------------------------------------------ */
const state = {
  step: "idea",
  prompt: "",
  vesselPref: null,
  skillLevel: null,
  results: [],
  generated: false,
  genSeed: 0,
  source: "offline",
  notice: "",
  remix: null, // { from: name, previous: results[] } while showing "more like this"
  compareIds: [],
  activeConfig: null,
  stepsDone: [],
  savedKey: null, // configKey of the design last saved to the account
  feedback: { rating: 0, publish: true, photo: null },
};

function saveDraft() {
  safeSet(
    DRAFT_KEY,
    JSON.stringify({
      step: state.step,
      prompt: state.prompt,
      vesselPref: state.vesselPref,
      skillLevel: state.skillLevel,
      genSeed: state.genSeed,
      activeConfig: state.activeConfig,
      stepsDone: state.stepsDone,
    })
  );
}
function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem("mudmagic_journey_draft_v1");
  } catch (err) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Step navigation + stepper                                           */
/* ------------------------------------------------------------------ */
const STEPS = [
  { id: "idea", label: "ไอเดีย" },
  { id: "results", label: "เลือกแบบ" },
  { id: "customize", label: "ปรับแต่ง" },
  { id: "finish", label: "พร้อมปั้น" },
];
const stepIndex = (id) => STEPS.findIndex((s) => s.id === id);

/** A step can be opened once what it needs exists. */
function canOpen(id) {
  if (id === "idea") return true;
  if (id === "results") return !!(state.prompt.trim() && state.skillLevel);
  return !!(state.skillLevel && state.activeConfig);
}

function renderStepper() {
  const ol = $("stepper");
  if (!ol) return;
  const cur = stepIndex(state.step);
  ol.innerHTML = "";
  STEPS.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "flex items-center gap-1.5 sm:gap-3";
    const done = i < cur;
    const active = i === cur;
    const open = !active && canOpen(s.id);
    const btn = document.createElement(open ? "button" : "span");
    if (open) btn.type = "button";
    btn.dataset.stepTarget = s.id;
    btn.className = "flex items-center gap-2 rounded-full pl-1 pr-3 py-1 transition-colors " + (open ? "hover:bg-surface-container cursor-pointer" : "");
    if (active) btn.setAttribute("aria-current", "step");
    const dotCls = active ? "bg-primary text-on-primary" : done ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container text-on-surface-variant";
    btn.innerHTML = `<span class="step-dot ${dotCls}">${done ? '<span class="material-symbols-outlined" style="font-size:16px;">check</span>' : i + 1}</span><span class="${active ? "text-primary font-medium" : "text-on-surface-variant"} ${active ? "" : "hidden sm:inline"}">${s.label}</span>`;
    if (open) btn.addEventListener("click", () => goToStep(s.id));
    li.appendChild(btn);
    if (i < STEPS.length - 1) {
      const bar = document.createElement("span");
      bar.className = "w-4 sm:w-10 h-px " + (i < cur ? "bg-secondary" : "bg-outline-variant");
      li.appendChild(bar);
    }
    ol.appendChild(li);
  });
}

function goToStep(step) {
  if (!canOpen(step)) step = canOpen("results") ? "results" : "idea";
  state.step = step;
  if (step !== "idea") $("draft-banner")?.classList.add("hidden"); // the resume offer only makes sense at the start
  document.querySelectorAll(".step-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.step !== step));
  renderStepper();
  window.scrollTo({ top: 0, behavior: "smooth" });
  saveDraft();

  if (step === "results") renderResults();
  if (step === "customize") enterCustomize();
  if (step === "finish") renderFinish();
}

/* ------------------------------------------------------------------ */
/* Step 1: ไอเดีย + ระดับฝีมือ                                           */
/* ------------------------------------------------------------------ */
const VAGUE_PHRASES = ["สวยๆ", "อะไรก็ได้", "ไม่รู้", "งามๆ", "เท่ๆ", "น่ารักๆ", "ดีๆ", "สวย"];
const SUGGESTED_IDEAS = [
  "แจกันทรงสูงเรียบ สีเซจ",
  "แก้วมัคทรงกลมลายร่องลึก",
  "ชามผิวหยาบสไตล์ญี่ปุ่น ดินทราย",
  "เหยือกหูห่วงเคลือบเงาสีครีม",
  "จานรูปหัวใจ สีชมพู",
];
const SURPRISE_IDEAS = [
  ...SUGGESTED_IDEAS,
  "จานตื้นขอบหยัก สีชมพู",
  "จานรูปหัวใจ สีชมพู",
  "ชามทรงดอกไม้ เคลือบครีม",
  "แจกันหน้าตัดรูปดาว สีน้ำเงิน",
  "จานรองแก้วรูปก้อนเมฆ",
  "จานใบไม้ เคลือบเขียวเซจ",
  "แจกันทรงหยดน้ำ ผิวด้าน",
  "ประติมากรรมนามธรรม ไม่เคลือบ",
  "แก้วมัคดินถ่าน เคลือบด้านสีเอสเพรสโซ",
  "ชามสลัดใบใหญ่ ผิวด้าน สีครีม",
  "แจกันดอกไม้ทรงป่อง คอแคบ ดินเผา",
  "เหยือกน้ำทรงสูง ลายเกลียว สีเซจ",
  "ชามข้าวใบเล็ก ปากบาง ผิวเรียบ",
  "แก้วกาแฟไม่มีหู ทรงบีบมือ",
  "จานรองแก้ว ดินทรายจุดด่าง ไม่เคลือบ",
  "แจกันทรงเหลี่ยม บิดเกลียว สีชมพู",
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
  row.innerHTML = "";
  const options = [{ id: null, label: "ให้ AI เลือก", icon: "auto_awesome" }, ...VESSEL_IDS.map((id) => ({ id, label: VESSELS[id].label, icon: VESSELS[id].icon }))];
  options.forEach((o) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.vesselPref = o.id || "auto";
    btn.className = "flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 rounded-full border text-[13px] transition-colors";
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px;">${o.icon}</span>${esc(o.label)}`;
    paintPick(btn, (state.vesselPref || null) === o.id);
    btn.addEventListener("click", () => {
      state.vesselPref = o.id;
      invalidateResults();
      renderVesselPrefs();
    });
    row.appendChild(btn);
  });
}

function renderSkillPicks() {
  document.querySelectorAll("[data-skill]").forEach((card) => {
    const on = card.dataset.skill === state.skillLevel;
    card.classList.toggle("is-active", on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function setSkill(level) {
  if (!LEVEL[level]) return;
  if (state.skillLevel !== level) invalidateResults();
  state.skillLevel = level;
  safeSet(SKILL_KEY, level); // the Studio opens with the same level
  renderSkillPicks();
  refreshIdeaNext();
}

const AI_BASE = window.MUDMAGIC_API_BASE || "http://localhost:8000";
let aiOnline = false;

function refreshAiStatus() {
  const on = aiOnline;
  $("idea-ai-status").innerHTML = on
    ? '<span class="w-2 h-2 rounded-full bg-green-600"></span>AI พร้อมใช้งาน: ออกแบบทรง สี และลวดลายจากไอเดียของคุณ'
    : '<span class="w-2 h-2 rounded-full bg-amber-500"></span>โหมดออฟไลน์: ยังไม่ได้เชื่อม AI จะตีความจากคำสำคัญแทน';
  $("idea-ai-refine").classList.toggle("hidden", !on);
}

/** Ask the server for an idea: empty prompt = a fresh one, otherwise a richer rewrite. */
async function askIdea(prompt, btn) {
  const label = btn.querySelector("[data-label]");
  const before = label ? label.textContent : null;
  btn.disabled = true;
  if (label) label.textContent = "AI กำลังคิด...";
  try {
    const res = await fetch(`${AI_BASE}/ai/idea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, vessel: state.vesselPref }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) throw new Error("ใช้ AI ถี่เกินไป รอสักครู่แล้วลองใหม่");
    if (!res.ok) throw new Error("AI คิดไอเดียไม่สำเร็จ ลองอีกครั้ง");
    const body = await res.json();
    return (body.idea || "").trim() || null;
  } catch (err) {
    toast(err.name === "TimeoutError" ? "AI ใช้เวลานานเกินไป ลองอีกครั้ง" : err.message || "ติดต่อ AI ไม่ได้", "error");
    return null;
  } finally {
    btn.disabled = false;
    if (label) label.textContent = before;
  }
}

function setPrompt(text) {
  const textarea = $("idea-prompt");
  textarea.value = text;
  textarea.dispatchEvent(new Event("input"));
}

function refreshIdeaNext() {
  const nextBtn = $("idea-next-btn");
  const hasPrompt = $("idea-prompt").value.trim().length > 0;
  nextBtn.disabled = !(hasPrompt && state.skillLevel);
  nextBtn.classList.toggle("opacity-50", nextBtn.disabled);
  $("idea-next-hint").textContent = !hasPrompt ? "พิมพ์ไอเดียก่อน" : !state.skillLevel ? "เลือกระดับฝีมือก่อน" : "";
}

function invalidateResults() {
  state.results = [];
  state.generated = false;
  state.compareIds = [];
  state.remix = null;
}

function renderRecent() {
  const recent = safeGet(RECENT_KEY, []).filter((t) => typeof t === "string");
  const wrap = $("idea-recent");
  wrap.innerHTML = "";
  recent.forEach((phrase) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "px-3 py-1.5 rounded-full border border-outline-variant text-[13px] text-on-surface-variant hover:border-primary hover:text-primary transition-colors";
    chip.textContent = phrase;
    chip.addEventListener("click", () => setPrompt(phrase));
    wrap.appendChild(chip);
  });
  $("idea-recent-wrap").classList.toggle("hidden", recent.length === 0);
}

function rememberIdea(text) {
  const recent = safeGet(RECENT_KEY, []).filter((t) => typeof t === "string" && t !== text);
  safeSet(RECENT_KEY, JSON.stringify([text, ...recent].slice(0, 5)));
}

function initIdea() {
  const textarea = $("idea-prompt");
  SUGGESTED_IDEAS.forEach((phrase) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "px-3.5 py-1.5 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant text-[13px] hover:bg-primary hover:text-on-primary transition-colors";
    chip.textContent = phrase;
    chip.addEventListener("click", () => { setPrompt(phrase); textarea.focus(); });
    $("idea-suggestions").appendChild(chip);
  });
  let lastSurprise = -1;
  $("idea-surprise-btn").addEventListener("click", async () => {
    // With AI on, ask it for a fresh idea; the fixed list is the fallback.
    if (aiOnline) {
      const idea = await askIdea("", $("idea-surprise-btn"));
      if (idea) return setPrompt(idea);
    }
    let i;
    do { i = Math.floor(Math.random() * SURPRISE_IDEAS.length); } while (i === lastSurprise && SURPRISE_IDEAS.length > 1);
    lastSurprise = i;
    setPrompt(SURPRISE_IDEAS[i]);
  });
  $("idea-ai-refine").addEventListener("click", async () => {
    const idea = await askIdea(textarea.value.trim(), $("idea-ai-refine"));
    if (idea) {
      setPrompt(idea);
      toast("AI เขียนไอเดียให้แล้ว แก้ต่อได้ตามใจ", "auto_awesome");
    }
  });
  aiAvailable().then((on) => {
    aiOnline = on;
    refreshAiStatus();
  });

  renderVesselPrefs();
  renderRecent();

  textarea.addEventListener("input", () => {
    if (state.prompt.trim() !== textarea.value.trim()) invalidateResults();
    state.prompt = textarea.value;
    $("idea-vague-hint").classList.toggle("hidden", !isVaguePrompt(textarea.value));
    refreshIdeaNext();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("idea-next-btn").disabled) $("idea-next-btn").click();
  });

  // Skill level: inline cards, remembered from the last visit.
  document.querySelectorAll("[data-skill]").forEach((card) => card.addEventListener("click", () => setSkill(card.dataset.skill)));
  const remembered = (() => { try { return localStorage.getItem(SKILL_KEY); } catch (err) { return null; } })();
  if (LEVEL[remembered]) state.skillLevel = remembered;
  renderSkillPicks();

  $("idea-next-btn").addEventListener("click", async () => {
    if (!textarea.value.trim() || !state.skillLevel) return;
    // Re-check AI (the server may have started after this page loaded), and
    // don't reuse a set made offline when AI can design it now.
    const on = await aiAvailable(true);
    if (on !== aiOnline) {
      aiOnline = on;
      refreshAiStatus();
    }
    if (on && state.generated && state.source !== "openai") invalidateResults();
    state.prompt = textarea.value.trim();
    rememberIdea(state.prompt);
    renderRecent();
    goToStep("results");
  });

  initQuiz();

  // Prefill from the dashboard's AI box (create.html?idea=...).
  const ideaParam = new URLSearchParams(location.search).get("idea");
  if (ideaParam && ideaParam.trim()) setPrompt(ideaParam.trim().slice(0, 500));
  refreshIdeaNext();
}

const QUIZ = [
  { q: "เคยปั้นเซรามิกมาก่อนไหม?", options: [["ไม่เคยเลย", 0], ["เคยลอง 1-2 ครั้ง", 1], ["ปั้นเป็นประจำ", 2]] },
  { q: "คุมแป้นหมุนให้ดินอยู่กึ่งกลางได้ไหม?", options: [["ยังไม่ได้", 0], ["ได้บ้างบางครั้ง", 1], ["ได้สบาย", 2]] },
  { q: "เคยต่อหูจับหรือเก็บรายละเอียดผิวไหม?", options: [["ยังไม่เคย", 0], ["เคยแบบง่ายๆ", 1], ["ทำได้คล่อง", 2]] },
];

function initQuiz() {
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
    setSkill(e.currentTarget.dataset.level);
  });
}

/* ------------------------------------------------------------------ */
/* Step 2: เลือกแบบ (results + remix + inline compare)                  */
/* ------------------------------------------------------------------ */
let resultsToken = 0;

function renderResults() {
  $("results-subtitle").textContent = `จากไอเดีย "${state.prompt}" · ทุกแบบปั้นได้จริงในระดับ ${LEVEL[state.skillLevel].labelTh} — ติ๊กเปรียบเทียบได้สูงสุด ${MAX_COMPARE} แบบ`;

  if (!state.generated) {
    $("results-empty").classList.add("hidden");
    $("compare-wrap").classList.add("hidden");
    $("results-remix-bar").classList.add("hidden");
    const token = ++resultsToken;
    showResultsLoading(true);
    $("results-grid").innerHTML = "";
    generateResults(state.prompt, state.skillLevel, state.genSeed, state.vesselPref)
      .then(({ results, source, notice }) => {
        if (token !== resultsToken) return; // a newer request superseded this one
        state.results = results;
        state.generated = true;
        state.source = source;
        state.notice = notice;
        showResultsLoading(false);
        if (state.step === "results") renderResults();
      })
      .catch(() => {
        if (token !== resultsToken) return;
        showResultsLoading(false);
        $("results-empty").classList.remove("hidden");
        toast("สร้างแบบไม่สำเร็จ ลองกด 'สร้างชุดใหม่' อีกครั้ง", "error");
      });
    return;
  }

  $("results-empty").classList.toggle("hidden", state.results.length > 0);
  const note = $("results-notice");
  note.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px;">${state.source === "openai" ? "auto_awesome" : "offline_bolt"}</span>${
    state.source === "openai" ? "AI ออกแบบทรงและสีจากไอเดียของคุณ" : "โหมดออฟไลน์ (ยังไม่ได้เชื่อม OpenAI) — ตีความคำสำคัญในไอเดียของคุณ"
  }`;
  note.classList.remove("hidden");
  // Results restored from a saved draft keep the mode they were made in; if AI
  // has come online since, say so instead of implying it's still offline.
  if (state.source !== "openai") {
    aiAvailable().then((on) => {
      if (on && state.source !== "openai") {
        note.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px;">auto_awesome</span>ชุดนี้สร้างตอนยังไม่ได้เชื่อม AI — ตอนนี้ AI พร้อมแล้ว กด "สร้างชุดใหม่" เพื่อให้ AI ออกแบบ`;
      }
    });
  }

  $("results-remix-bar").classList.toggle("hidden", !state.remix);
  if (state.remix) $("results-remix-text").textContent = `แบบที่คล้าย "${state.remix.from}"`;

  const grid = $("results-grid");
  grid.innerHTML = "";
  state.results.forEach((r) => {
    const inCompare = state.compareIds.includes(r.id);
    const dot = LEVEL_DOT[r.a.level];
    const card = document.createElement("div");
    card.dataset.resultId = r.id;
    card.className = "bg-surface-container-lowest rounded-xl overflow-hidden soft-shadow group transition-all duration-300 hover:shadow-xl flex flex-col border border-outline-variant/30" + (inCompare ? " ring-2 ring-primary" : "");
    card.innerHTML = `
      <div class="relative h-48 w-full bg-surface-container overflow-hidden">
        <img class="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500 ease-out" src="${r.thumb}" alt="${esc(r.name)} — 3D render" />
        <span class="absolute bottom-2 left-2 bg-surface-variant/80 backdrop-blur text-on-surface-variant text-xs px-2 py-0.5 rounded-full uppercase tracking-wider">${esc(r.chip)}</span>
        <label class="absolute top-2 right-2 flex items-center gap-1.5 bg-surface-container-lowest/90 backdrop-blur rounded-full pl-2 pr-2.5 py-1 text-xs cursor-pointer ${inCompare ? "text-primary" : "text-on-surface-variant"}">
          <input data-act="compare" type="checkbox" ${inCompare ? "checked" : ""} class="w-3.5 h-3.5 rounded border-outline-variant text-primary focus:ring-primary" /> เปรียบเทียบ
        </label>
      </div>
      <div class="p-4 flex flex-col flex-1">
        <h2 class="card-title text-on-surface text-[18px] mb-1">${esc(r.name)}</h2>
        <div class="flex items-center gap-1.5 text-xs mb-3" style="color:${dot}">
          <span class="material-symbols-outlined fill" style="font-size:12px;">circle</span> ${esc(r.a.levelLabelEn)} · ยาก ${r.a.d5}/5 · ทำได้จริง ${r.a.feasibility}%
        </div>
        <ul class="space-y-1.5 text-sm text-on-surface-variant mb-4 flex-1">
          <li class="flex items-start gap-1.5"><span class="material-symbols-outlined text-secondary" style="font-size:17px;">pan_tool</span><span>${esc(r.a.method)}</span></li>
          <li class="flex items-start gap-1.5"><span class="material-symbols-outlined text-secondary" style="font-size:17px;">straighten</span><span>${esc(dimsText(r.config))}</span></li>
          ${r.simplified ? '<li class="flex items-start gap-1.5 text-xs text-tertiary"><span class="material-symbols-outlined" style="font-size:17px;">tune</span><span>ปรับให้ง่ายลงให้พอดีกับระดับของคุณ</span></li>' : ""}
        </ul>
        <div class="flex gap-2">
          <button data-act="remix" title="แบบคล้ายกัน" class="border border-outline-variant text-on-surface-variant px-3 py-2 rounded-md hover:border-primary hover:text-primary transition-colors text-sm flex items-center gap-1">
            <span class="material-symbols-outlined" style="font-size:17px;">auto_fix_high</span> คล้ายกัน
          </button>
          <button data-act="pick" class="flex-1 bg-primary text-on-primary py-2 rounded-md hover:bg-surface-tint transition-colors text-sm">เลือกแบบนี้</button>
        </div>
      </div>`;
    card.querySelector('[data-act="compare"]').addEventListener("change", (e) => {
      const idx = state.compareIds.indexOf(r.id);
      if (idx >= 0) state.compareIds.splice(idx, 1);
      else if (state.compareIds.length >= MAX_COMPARE) {
        e.target.checked = false;
        toast(`เปรียบเทียบได้สูงสุด ${MAX_COMPARE} แบบ`, "info");
        return;
      } else state.compareIds.push(r.id);
      renderResults();
    });
    card.querySelector('[data-act="remix"]').addEventListener("click", () => showRemix(r));
    card.querySelector('[data-act="pick"]').addEventListener("click", () => pickDesign(r));
    grid.appendChild(card);
  });
  renderCompare();
}

function pickDesign(r) {
  state.activeConfig = normalizeConfig(r.config);
  state.stepsDone = [];
  goToStep("customize");
}

let remixSeed = 0;
let remixBusy = false;
async function showRemix(r) {
  if (remixBusy) return;
  remixBusy = true;
  showResultsLoading(true);
  let results = [];
  try {
    results = await remixResults(r, state.skillLevel, ++remixSeed);
  } finally {
    remixBusy = false;
    showResultsLoading(false);
  }
  if (state.step !== "results") return;
  if (!results.length) {
    toast("ยังหาแบบคล้ายกันที่เหมาะกับระดับนี้ไม่ได้", "info");
    return;
  }
  // Keep the picked design first so it stays comparable with its variations.
  const keep = { ...r, id: uid() };
  state.remix = { from: r.name, previous: state.remix ? state.remix.previous : state.results };
  state.results = [keep, ...results].slice(0, RESULT_COUNT);
  state.compareIds = [];
  renderResults();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const CHIP_STYLE = {
  smooth: "bg-secondary-fixed text-on-secondary-fixed-variant",
  matte: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
  rough: "bg-surface-variant text-on-surface-variant",
};

function renderCompare() {
  const picked = state.compareIds.map((id) => state.results.find((r) => r.id === id)).filter(Boolean);
  const wrap = $("compare-wrap");
  wrap.classList.toggle("hidden", picked.length < 2);
  if (picked.length < 2) return;
  // Recommended = the most feasibility headroom for the chosen level, then the lowest difficulty.
  const rec = picked.slice().sort((a, b) => b.a.feasibility - a.a.feasibility || a.a.d5 - b.a.d5)[0];
  const best = (fn, pickMin) => {
    const vals = picked.map(fn);
    const target = pickMin ? Math.min(...vals) : Math.max(...vals);
    return (r) => fn(r) === target && vals.some((v) => v !== target);
  };
  const easiest = best((r) => r.a.d5, true);
  const surest = best((r) => r.a.feasibility, false);
  const lightest = best((r) => clayEstimate(r.config).grams, true);
  const hl = (on) => (on ? "text-secondary font-semibold" : "");

  const rows = [
    ["", (r) => `<div class="relative"><img class="w-full h-32 object-contain bg-surface-container rounded-lg" src="${r.thumb}" alt="" />${r === rec ? '<span class="absolute top-1.5 left-1.5 bg-primary text-on-primary text-[11px] px-2 py-0.5 rounded-full flex items-center gap-0.5"><span class="material-symbols-outlined fill" style="font-size:12px;">star</span>แนะนำ</span>' : ""}</div><p class="mt-2 font-medium text-on-surface">${esc(r.name)}</p>`],
    ["ประเภท · ขนาด", (r) => `${esc(VESSELS[r.config.vessel].label)} · ${esc(dimsText(r.config))}`],
    ["สไตล์", (r) => `<span class="${CHIP_STYLE[r.config.surface] || ""} text-xs px-2.5 py-0.5 rounded-full">${esc(glazeLabel(r.config))} · ${esc(FINISHES[r.config.surface].label)}</span>`],
    ["วิธีปั้น", (r) => esc(r.a.method)],
    ["ความยาก", (r) => `<span class="${hl(easiest(r))}">${r.a.d5}/5</span>`],
    ["ทำได้จริง", (r) => `<span class="${hl(surest(r))}">${r.a.feasibility}%</span>`],
    ["ดินที่ใช้", (r) => `<span class="${hl(lightest(r))}">${clayEstimate(r.config).text}</span>`],
    ["", (r) => `<button data-pick="${r.id}" class="w-full ${r === rec ? "bg-primary text-on-primary hover:bg-surface-tint" : "border border-outline-variant hover:border-primary text-on-surface"} px-4 py-2 rounded-lg text-sm transition-colors">เลือกแบบนี้</button>`],
  ];
  const table = $("compare-table");
  table.innerHTML = rows
    .map(([label, fn], i) => `<tr class="${i > 0 && i < rows.length - 1 ? "border-t border-outline-variant/30" : ""}"><th class="text-left font-normal text-on-surface-variant p-3 w-28 align-top">${label}</th>${picked.map((r) => `<td class="p-3 align-top">${fn(r)}</td>`).join("")}</tr>`)
    .join("");
  table.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", () => pickDesign(picked.find((r) => r.id === btn.dataset.pick))));
}

function showResultsLoading(on) {
  $("results-loading").classList.toggle("hidden", !on);
  $("results-regenerate-btn").disabled = on;
  $("results-regenerate-btn").classList.toggle("opacity-50", on);
}

function initResults() {
  $("results-regenerate-btn").addEventListener("click", () => {
    state.genSeed += 1;
    invalidateResults();
    renderResults();
  });
  $("results-edit-btn").addEventListener("click", () => {
    goToStep("idea");
    $("idea-prompt").focus();
  });
  $("results-remix-back").addEventListener("click", () => {
    if (!state.remix) return;
    state.results = state.remix.previous;
    state.remix = null;
    state.compareIds = [];
    renderResults();
  });
  $("compare-clear-btn").addEventListener("click", () => {
    state.compareIds = [];
    renderResults();
  });
}

/* ------------------------------------------------------------------ */
/* Step 3: ปรับแต่ง — the real Studio editor, embedded (studio.html?embed=1) */
/* The iframe posts every config change back; we keep it as activeConfig.  */
/* ------------------------------------------------------------------ */
let studioFrame = null;
let studioReady = false;
let studioSyncedKey = null; // JSON of the config the iframe currently holds
let studioBooted = false; // the iframe has a running Studio we can send new designs to

function studioUrl(config) {
  return `studio.html?d=${encodeConfig(config)}`;
}

function refreshDifficultyBanner() {
  const cfg = state.activeConfig;
  const level = state.skillLevel || "intermediate";
  const a = assess(cfg, level);
  const banner = $("difficulty-banner");
  const exceeds = a.d5 > LEVEL[level].max;
  banner.classList.toggle("bg-amber-50", exceeds);
  banner.classList.toggle("border-amber-300", exceeds);
  banner.classList.toggle("text-amber-900", exceeds);
  banner.classList.toggle("bg-secondary-container", !exceeds);
  banner.classList.toggle("border-secondary/30", !exceeds);
  banner.classList.toggle("text-on-secondary-container", !exceeds);
  banner.querySelector("[data-banner-icon]").textContent = exceeds ? "warning" : "check_circle";
  banner.querySelector("[data-banner-text]").textContent = exceeds
    ? `ยากกว่าระดับที่เลือกไว้ (${LEVEL[level].labelTh}) — ตอนนี้อยู่ระดับ ${a.levelLabel} (${a.d5}/5) · ${a.notes[0]}`
    : `อยู่ในระดับที่เหมาะกับคุณ (${a.levelLabel} · ${a.d5}/5 · ทำได้จริง ${a.feasibility}%)`;
  $("difficulty-ease-btn").classList.toggle("hidden", !exceeds);
}

const configKey = (c) => JSON.stringify(c);

function loadIntoStudio(config) {
  safeSet(SKILL_KEY, state.skillLevel || "intermediate");
  studioFrame = $("customize-frame");
  studioSyncedKey = configKey(config);
  if (studioBooted && studioFrame.contentWindow) {
    // Reuse the running editor: no page reload, no new WebGL context.
    studioFrame.contentWindow.postMessage({ type: "mudmagic-studio-load", config }, window.location.origin);
    return;
  }
  studioReady = false;
  studioFrame.src = `studio.html?embed=1&d=${encodeConfig(config)}`;
}

function enterCustomize() {
  state.activeConfig = normalizeConfig(state.activeConfig);
  refreshDifficultyBanner();
  // Re-entering with the very same design keeps the editor (and any freeform sculpting) as it was.
  if (studioReady && studioSyncedKey === configKey(state.activeConfig)) return;
  loadIntoStudio(state.activeConfig);
}

function onStudioMessage(e) {
  if (e.origin !== window.location.origin || !studioFrame || e.source !== studioFrame.contentWindow) return;
  const msg = e.data;
  if (msg?.type === "mudmagic-studio-config" && msg.config) {
    studioReady = true;
    studioBooted = true;
    const cfg = normalizeConfig(msg.config);
    if (configKey(cfg) !== configKey(state.activeConfig)) state.stepsDone = [];
    state.activeConfig = cfg;
    studioSyncedKey = configKey(cfg);
    refreshDifficultyBanner();
    saveDraft();
  }
}

/** PNG of the editor's viewport (includes freeform sculpting); falls back to a plain render of the config. */
function snapshot() {
  return new Promise((resolve) => {
    const cfg = state.activeConfig;
    const fallback = () => resolve(renderThumbnail(cfg));
    if (!studioFrame || !studioReady || !studioFrame.contentWindow) return fallback();
    const id = uid();
    const timer = setTimeout(() => { window.removeEventListener("message", onMsg); fallback(); }, 1500);
    function onMsg(e) {
      if (e.source !== studioFrame.contentWindow || e.data?.type !== "mudmagic-snapshot" || e.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(e.data.png || renderThumbnail(cfg));
    }
    window.addEventListener("message", onMsg);
    studioFrame.contentWindow.postMessage({ type: "mudmagic-snapshot-request", id }, window.location.origin);
  });
}

function initCustomize() {
  window.addEventListener("message", onStudioMessage);
  $("customize-back-btn").addEventListener("click", () => goToStep("results"));
  $("customize-next-btn").addEventListener("click", () => goToStep("finish"));
  $("customize-next-top").addEventListener("click", () => goToStep("finish"));
  $("difficulty-ease-btn").addEventListener("click", () => {
    const s = simplifyForSkill(state.activeConfig, state.skillLevel);
    if (!s.changed) return;
    state.activeConfig = s.config;
    state.stepsDone = [];
    refreshDifficultyBanner();
    loadIntoStudio(s.config);
    saveDraft();
    toast(s.fits ? "ปรับให้ง่ายลงจนพอดีกับระดับของคุณแล้ว" : "ปรับให้ง่ายลงแล้ว แต่ยังยากกว่าระดับที่เลือกเล็กน้อย", "tune");
  });
}

/* ------------------------------------------------------------------ */
/* Clay estimate — wall shell of the profile, scaled to wet size        */
/* ------------------------------------------------------------------ */
function clayEstimate(rawConfig) {
  const c = normalizeConfig(rawConfig);
  const nodes = c.lab.nodes || VESSELS[c.vessel].nodes;
  const maxR = Math.max(...nodes.map((n) => n[0]), 0.01);
  const pts = nodes.map(([r, y]) => [(r / maxR) * (c.belly / 2) * Math.sqrt(c.lab.aspect || 1), y * c.height]);
  const t = c.wall;
  let vol = Math.PI * pts[0][0] ** 2 * t; // base
  for (let i = 1; i < pts.length; i++) {
    const [r0, y0] = pts[i - 1];
    const [r1, y1] = pts[i];
    vol += 2 * Math.PI * ((r0 + r1) / 2) * Math.hypot(r1 - r0, y1 - y0) * t;
  }
  if (c.handle !== "none") vol += c.height * 0.9 * 1.6 * t; // a pulled handle strap
  const wetVol = vol / SHRINK ** 3;
  const thrown = !/ปั้นมือ|บีบ/.test(assess(c).method);
  const grams = Math.round((wetVol * 1.9 * (thrown ? 1.3 : 1.1)) / 50) * 50; // wet clay ≈ 1.9 g/cm³ + trimming allowance
  const text = grams >= 1000 ? `~${round1(grams / 1000)} กก.` : `~${Math.max(50, grams)} กรัม`;
  return { grams, text };
}

/* ------------------------------------------------------------------ */
/* Step 4: พร้อมปั้น + single-file guide download (Thai-safe canvas)    */
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
    steps: (sections["ขั้นตอน"] || []).filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s*/, "")),
  };
}

function materialLines(config) {
  const est = clayEstimate(config);
  return [
    `ดิน: ${CLAYS[config.clay].label} ${est.text} (โดยประมาณ)`,
    `ขนาดตอนปั้น (เผื่อหด ~12%): ${dimsText(config, 1 / SHRINK)}`,
    `ความหนาผนัง: ~${round1(config.wall / SHRINK)} ซม. ตอนปั้น`,
  ];
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
  const specLines = [];
  g.specs.forEach((t) => wrapCanvasText(measure, t, rightW).forEach((l) => specLines.push(l)));
  const matLines = [];
  materialLines(config).forEach((t) => wrapCanvasText(measure, t, rightW).forEach((l) => matLines.push(l)));
  const rightHeight = 220 + specLines.length * 27 + 60 + matLines.length * 27 + 20;
  const stepsTop = Math.max(170 + imgSize, rightHeight) + 70;
  measure.font = '400 21px "Noto Sans Thai", sans-serif';
  let stepsHeight = 44;
  g.steps.forEach((step, i) => {
    stepsHeight += wrapCanvasText(measure, `☐ ${i + 1}. ${step}`, W - 120).length * 30 + 12;
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
  ctx.fillText(`${VESSELS[config.vessel].label}  ·  ระดับที่เลือก: ${LEVEL[state.skillLevel || "intermediate"].labelTh}  ·  ความยาก: ${a.levelLabel} (${a.d5}/5)  ·  ทำได้จริง ${a.feasibility}%`, 60, 130);

  const img = await loadImage(snapshotDataUrl);
  const ratio = img.width / img.height;
  const dw = ratio >= 1 ? imgSize : imgSize * ratio;
  const dh = ratio >= 1 ? imgSize / ratio : imgSize;
  ctx.fillStyle = "#F6ECE5";
  ctx.fillRect(60, 170, imgSize, imgSize);
  ctx.drawImage(img, 60 + (imgSize - dw) / 2, 170 + (imgSize - dh) / 2, dw, dh);

  let ty = 220;
  const heading = (text) => {
    ctx.fillStyle = "#1F1B17";
    ctx.font = '600 24px "Noto Sans Thai", sans-serif';
    ctx.fillText(text, tx, ty);
    ty += 40;
    ctx.font = '400 18px "Noto Sans Thai", sans-serif';
  };
  heading("สเปกชิ้นงาน");
  specLines.forEach((line) => { ctx.fillText(line, tx, ty); ty += 27; });
  ty += 20;
  heading("เตรียมวัสดุ");
  matLines.forEach((line) => { ctx.fillText(line, tx, ty); ty += 27; });

  let sy = stepsTop;
  ctx.font = '600 28px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#88452F";
  ctx.fillText("ขั้นตอนการปั้น", 60, sy);
  sy += 44;
  ctx.font = '400 21px "Noto Sans Thai", sans-serif';
  ctx.fillStyle = "#1F1B17";
  g.steps.forEach((step, i) => {
    wrapCanvasText(ctx, `☐ ${i + 1}. ${step}`, W - 120).forEach((line) => {
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

function shareUrl(config) {
  return new URL(studioUrl(config), window.location.href).href;
}

function renderFinish() {
  const cfg = state.activeConfig;
  const a = assess(cfg, state.skillLevel || "intermediate");
  const est = clayEstimate(cfg);
  $("finish-name").textContent = designName(cfg);
  const levelEl = $("finish-level");
  levelEl.style.color = LEVEL_DOT[a.level];
  levelEl.textContent = `${a.levelLabelEn} · ${a.levelLabel} · ยาก ${a.d5}/5 · ทำได้จริง ${a.feasibility}%`;
  $("finish-size").textContent = dimsText(cfg);
  $("finish-method").textContent = a.method;
  $("finish-detail").textContent = `${NECKS[cfg.neck].label} · ${FEET[cfg.foot].label} · ${HANDLES[cfg.handle].label}`;
  $("finish-material").textContent = `${CLAYS[cfg.clay].label} · ${glazeLabel(cfg)} · ${FINISHES[cfg.surface].label}`;
  $("finish-clay-weight").textContent = `${CLAYS[cfg.clay].label} ${est.text}`;
  $("finish-wet-size").textContent = dimsText(cfg, 1 / SHRINK);
  $("finish-wall").textContent = `~${round1(cfg.wall / SHRINK)} ซม.`;
  $("finish-notes").textContent = a.allNotes.join(" · ");
  $("finish-studio-link").href = studioUrl(cfg);
  renderChecklist();
  renderSaveButton();
  renderFeedback();
  $("finish-image").removeAttribute("src");
  snapshot().then((png) => { if (state.step === "finish") $("finish-image").src = png; });
}

function renderChecklist() {
  const steps = guideParts(state.activeConfig).steps;
  state.stepsDone = state.stepsDone.filter((i) => i < steps.length);
  const list = $("finish-steps");
  list.innerHTML = "";
  steps.forEach((step, i) => {
    const done = state.stepsDone.includes(i);
    const li = document.createElement("li");
    li.innerHTML = `<label class="flex items-start gap-3 rounded-lg px-2 py-2 cursor-pointer hover:bg-surface-container-low ${done ? "text-on-surface-variant" : "text-on-surface"}">
      <input type="checkbox" ${done ? "checked" : ""} class="mt-0.5 w-5 h-5 rounded border-outline-variant text-secondary focus:ring-secondary shrink-0" />
      <span class="text-sm leading-relaxed ${done ? "line-through" : ""}"><span class="text-on-surface-variant mr-1">${i + 1}.</span>${esc(step)}</span></label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.stepsDone.push(i);
      else state.stepsDone = state.stepsDone.filter((x) => x !== i);
      saveDraft();
      renderChecklist();
      if (state.stepsDone.length === steps.length) {
        $("finish-feedback").open = true;
        toast("ปั้นครบทุกขั้นแล้ว เยี่ยมมาก!", "celebration");
      }
    });
    list.appendChild(li);
  });
  const pct = steps.length ? Math.round((state.stepsDone.length / steps.length) * 100) : 0;
  $("finish-progress-text").textContent = `ทำแล้ว ${state.stepsDone.length}/${steps.length}`;
  $("finish-progress-bar").style.width = `${pct}%`;
}

function renderSaveButton() {
  const btn = $("finish-save-btn");
  const saved = state.savedKey === configKey(state.activeConfig);
  const loggedIn = !!window.MudMagicAPI?.isLoggedIn();
  btn.querySelector(".material-symbols-outlined").textContent = saved ? "cloud_done" : loggedIn ? "cloud_upload" : "login";
  btn.querySelector("[data-label]").textContent = saved ? "บันทึกแล้ว" : loggedIn ? "บันทึกเข้าบัญชี" : "เข้าสู่ระบบเพื่อบันทึก";
  btn.disabled = saved;
  btn.classList.toggle("opacity-60", saved);
  $("finish-dashboard-link").classList.toggle("hidden", !saved);
}

function download(filename, href) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = href;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
}

function initFinish() {
  $("finish-back-btn").addEventListener("click", () => goToStep("customize"));

  $("finish-save-btn").addEventListener("click", async () => {
    const api = window.MudMagicAPI;
    if (!api?.isLoggedIn()) {
      saveDraft(); // the draft banner brings them back here after signing in
      window.location.href = "login.html?next=create.html";
      return;
    }
    const btn = $("finish-save-btn");
    btn.disabled = true;
    btn.querySelector("[data-label]").textContent = "กำลังบันทึก...";
    try {
      await api.saveDesignAsProject(state.activeConfig, designName(state.activeConfig));
      state.savedKey = configKey(state.activeConfig);
      toast("บันทึกแบบเข้าบัญชีแล้ว ดูได้ที่หน้า Dashboard", "cloud_done");
    } catch (err) {
      toast("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง", "error");
    }
    renderSaveButton();
  });

  $("finish-share-btn").addEventListener("click", async () => {
    const ok = await copyText(shareUrl(state.activeConfig));
    toast(ok ? "คัดลอกลิงก์แล้ว เปิดลิงก์นี้เพื่อดูแบบใน 3D Studio" : "คัดลอกไม่สำเร็จ", ok ? "link" : "error");
  });

  $("finish-download-btn").addEventListener("click", async () => {
    const btn = $("finish-download-btn");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "กำลังเตรียมไฟล์...";
    try {
      const canvas = await buildGuideCanvas(state.activeConfig, await snapshot());
      download("mudmagic-guide.png", canvas.toDataURL("image/png"));
      toast("ดาวน์โหลดคู่มือแล้ว", "download");
    } catch (err) {
      toast("สร้างไฟล์คู่มือไม่สำเร็จ ลองใหม่อีกครั้ง", "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
  $("finish-download-md-btn").addEventListener("click", () => {
    const cfg = state.activeConfig;
    const md = `${guideParts(cfg).md}\n\n## เตรียมวัสดุ\n${materialLines(cfg).map((l) => `- ${l}`).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    download("mudmagic-guide.md", url);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("ดาวน์โหลดคู่มือ (ข้อความ) แล้ว", "download");
  });
  $("finish-print-btn").addEventListener("click", () => window.print());

  $("finish-restart-btn").addEventListener("click", restart);
  initFeedback();
}

/* Optional feedback on the real piece (photo + rating + gallery) */
function renderFeedback() {
  const f = state.feedback;
  $("feedback-photo-preview").src = f.photo || "";
  $("feedback-photo-preview").classList.toggle("hidden", !f.photo);
  $("feedback-photo-placeholder").classList.toggle("hidden", !!f.photo);
  $("feedback-publish").checked = f.publish;
  renderStars();
}
function renderStars() {
  const wrap = $("feedback-stars");
  wrap.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("button");
    star.type = "button";
    star.setAttribute("aria-label", `${i} ดาว`);
    star.className = "material-symbols-outlined text-3xl transition-colors " + (i <= state.feedback.rating ? "text-primary fill" : "text-outline-variant");
    star.textContent = "star";
    star.addEventListener("click", () => {
      state.feedback.rating = i;
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
      state.feedback.photo = reader.result;
      renderFeedback();
    };
    reader.readAsDataURL(file);
  });
  $("feedback-publish").addEventListener("change", (e) => (state.feedback.publish = e.target.checked));
  $("feedback-submit-btn").addEventListener("click", () => {
    const f = state.feedback;
    if (!f.rating && !f.photo) {
      toast("เลือกดาวหรืออัปโหลดรูปก่อนนะ", "info");
      return;
    }
    try {
      const log = safeGet(FEEDBACK_LOG_KEY, []);
      log.push({ config: state.activeConfig, rating: f.rating, skillLevel: state.skillLevel, timestamp: new Date().toISOString() });
      localStorage.setItem(FEEDBACK_LOG_KEY, JSON.stringify(log.slice(-200)));
    } catch (err) { /* non-fatal */ }
    if (f.publish && f.photo) {
      try {
        const gallery = safeGet(GALLERY_KEY, []);
        gallery.push({ photo: f.photo, config: state.activeConfig, rating: f.rating, skillLevel: state.skillLevel });
        localStorage.setItem(GALLERY_KEY, JSON.stringify(gallery.slice(-60)));
      } catch (err) {
        toast("รูปใหญ่เกินกว่าจะเก็บในเครื่อง ลองรูปที่เล็กลง", "error");
        return;
      }
    }
    $("finish-feedback").open = false;
    state.feedback = { rating: 0, publish: true, photo: null };
    renderFeedback();
    toast(f.publish && f.photo ? "ส่งผลงานแล้ว ขึ้นคลังผลงานหน้าแรกเรียบร้อย" : "ขอบคุณสำหรับฟีดแบ็ก!", "celebration");
  });
}

function restart() {
  clearDraft();
  Object.assign(state, {
    prompt: "",
    vesselPref: null,
    genSeed: 0,
    source: "offline",
    notice: "",
    activeConfig: null,
    stepsDone: [],
    savedKey: null,
    feedback: { rating: 0, publish: true, photo: null },
  });
  invalidateResults();
  $("idea-prompt").value = "";
  $("idea-vague-hint").classList.add("hidden");
  renderVesselPrefs();
  refreshIdeaNext();
  goToStep("idea");
}

/* ------------------------------------------------------------------ */
/* Draft resume                                                        */
/* ------------------------------------------------------------------ */
function initDraftBanner() {
  const draft = safeGet(DRAFT_KEY, null) || safeGet("mudmagic_journey_draft_v1", null);
  if (!draft || !draft.step || draft.step === "idea" || draft.step === "done") return;
  const banner = $("draft-banner");
  banner.classList.remove("hidden");
  $("draft-resume-btn").addEventListener("click", () => {
    state.prompt = draft.prompt || "";
    state.vesselPref = VESSELS[draft.vesselPref] ? draft.vesselPref : null;
    if (LEVEL[draft.skillLevel]) setSkill(draft.skillLevel);
    state.genSeed = Number(draft.genSeed) || 0;
    // v1 drafts kept one config per student; take the first.
    const cfg = draft.activeConfig || draft.students?.[draft.activeStudent || 0]?.activeConfig;
    state.activeConfig = cfg ? normalizeConfig(cfg) : null;
    state.stepsDone = Array.isArray(draft.stepsDone) ? draft.stepsDone.filter(Number.isInteger) : [];
    $("idea-prompt").value = state.prompt;
    renderVesselPrefs();
    refreshIdeaNext();
    banner.classList.add("hidden");
    // Results/thumbnails regenerate from prompt+level+seed, so we don't persist images.
    const map = { skill: "idea", compare: "results", confirm: "finish", build: "finish", feedback: "finish" };
    goToStep(map[draft.step] || draft.step);
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
  initResults();
  initCustomize();
  initFinish();
  initDraftBanner();
  renderStepper();
  window.MudMagicJourney = { state, studioUrl, clayEstimate }; // read-only handle for debugging and tests
}
boot();
