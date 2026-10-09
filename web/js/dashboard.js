// dashboard.js — the signed-in user's home: saved designs (from Firestore via
// MudMagicAPI), feasibility stats at their skill level, an AI prompt that hands
// off to create.html, and the profile panel (display name, logout).
import * as THREE from "three";
import { buildPotGroup, disposePotGroup } from "./pot-engine.js";
import { VESSELS, SKILLS, normalizeConfig, encodeConfig, assess, summaryLine, glazeLabel } from "./vessels.js";

const SKILL_KEY = "mudmagic_skill"; // shared with the Studio and the AI journey
const api = window.MudMagicAPI;
const $ = (id) => document.getElementById(id);

const IDEAS = {
  beginner: ["ชามข้าวทรงเตี้ยปากกว้าง", "จานรองแก้วผิวดิบ", "แก้วมัคทรงตรงหูจับเรียบ", "ถ้วยชาเล็กแบบบีบมือ"],
  intermediate: ["แจกันทรงน้ำเต้า เคลือบเซลาดอน", "ชามมัทฉะแบบวาบิซาบิ", "เหยือกน้ำปากจีบ", "มัคลายคลื่นสีครามเข้ม"],
  advanced: ["แจกันคอบิดเกลียวสูง 40 ซม.", "ประติมากรรมทรงอิสระผิวแตกลายงา", "เหยือกทรงสูงหูจับโค้งยาว", "จานขอบหยักเคลือบไหลสองชั้น"],
};

const state = { designs: [], filter: "all", skill: "intermediate" };

/* ---------------- helpers ---------------- */
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
function toast(message, icon) {
  if (window.MudMagic?.showToast) window.MudMagic.showToast(message, icon ? { icon } : undefined);
}
function readSkill() {
  try {
    const id = localStorage.getItem(SKILL_KEY);
    return SKILLS.some((s) => s.id === id) ? id : "intermediate";
  } catch (err) {
    return "intermediate";
  }
}
function skillInfo(id) {
  return SKILLS.find((s) => s.id === id) || SKILLS[1];
}
function thaiDate(iso, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { day: "numeric", month: "short", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("th-TH", opts);
}
function parseConfig(design) {
  try {
    const raw = JSON.parse(design.description || "null");
    if (!raw || typeof raw !== "object") return null;
    return normalizeConfig(raw);
  } catch (err) {
    return null;
  }
}

/* ---------------- 3D thumbnails (one shared renderer) ---------------- */
let thumb = null;
function renderThumbnail(config) {
  if (!thumb) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(480, 360);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f6ece5");
    const camera = new THREE.PerspectiveCamera(30, 480 / 360, 0.1, 50);
    camera.position.set(0, 0.5, 3.2);
    camera.lookAt(0, 0, 0);
    const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
    key.position.set(2.6, 3.6, 2.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe9dd, 0.85);
    fill.position.set(-3, 1.2, -2.2);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    thumb = { renderer, scene, camera, group: null };
  }
  if (thumb.group) {
    thumb.scene.remove(thumb.group);
    disposePotGroup(thumb.group);
  }
  const group = buildPotGroup(config, { rings: 56, sides: 64 });
  // Fit the piece into the frame whatever its real size.
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const scale = 1.3 / Math.max(size.x, size.y, size.z, 1e-3);
  group.scale.setScalar(scale);
  const center = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  group.position.sub(center);
  group.rotation.y = -0.35;
  thumb.group = group;
  thumb.scene.add(group);
  thumb.renderer.render(thumb.scene, thumb.camera);
  return thumb.renderer.domElement.toDataURL("image/png");
}

const thumbCache = new Map();
function fillThumbnails() {
  const imgs = [...document.querySelectorAll("img[data-thumb-id]")].filter((img) => !img.src);
  let i = 0;
  const step = () => {
    const img = imgs[i++];
    if (!img) return;
    const design = state.designs.find((d) => d.id === img.dataset.thumbId);
    if (design?.config) {
      try {
        if (!thumbCache.has(design.id)) thumbCache.set(design.id, renderThumbnail(design.config));
        img.src = thumbCache.get(design.id);
        img.parentElement.classList.remove("thumb-shimmer");
      } catch (err) {
        img.closest("[data-thumb-wrap]")?.classList.remove("thumb-shimmer");
      }
    }
    requestAnimationFrame(step); // one per frame keeps the page responsive
  };
  requestAnimationFrame(step);
}

/* ---------------- rendering ---------------- */
function renderSkill() {
  const info = skillInfo(state.skill);
  document.querySelectorAll("[data-skill-label]").forEach((el) => (el.textContent = info.label));
  const picker = $("skill-picker");
  picker.innerHTML = SKILLS.map(
    (s) => `<button type="button" data-skill="${s.id}" aria-pressed="${s.id === state.skill}"
      class="px-2.5 py-1 rounded-full text-[12px] transition-colors ${
        s.id === state.skill ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant hover:bg-surface-variant"
      }">${s.label}</button>`
  ).join("");
  const ideas = IDEAS[state.skill] || IDEAS.intermediate;
  $("assistant-ideas").innerHTML = ideas
    .map(
      (idea) =>
        `<button type="button" data-idea="${escapeHtml(idea)}" class="px-3.5 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant hover:bg-primary hover:text-on-primary transition-colors text-[13px]">${escapeHtml(idea)}</button>`
    )
    .join("");
}

function renderStats() {
  const designs = state.designs.filter((d) => d.config);
  const total = state.designs.length;
  const set = (key, text) => {
    const el = document.querySelector(`[data-stat="${key}"]`);
    if (el) el.textContent = text;
  };

  set("count", String(total));
  set("count-note", total ? `ล่าสุด ${thaiDate(state.designs[0].created_at)}` : "ยังไม่มีแบบที่บันทึก");

  if (designs.length) {
    const scores = designs.map((d) => assess(d.config, state.skill).feasibility);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const ready = scores.filter((s) => s >= 80).length;
    set("feasibility", `${avg}%`);
    set("feasibility-note", `${ready} จาก ${designs.length} แบบ ทำได้สบายที่ระดับ${skillInfo(state.skill).label}`);

    const counts = {};
    designs.forEach((d) => (counts[d.config.vessel] = (counts[d.config.vessel] || 0) + 1));
    const [topId, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    set("top", VESSELS[topId].label);
    set("top-note", `${topCount} แบบ จากทั้งหมด ${designs.length} แบบ`);
    const icon = document.querySelector('[data-stat="top-icon"]');
    if (icon) icon.textContent = VESSELS[topId].icon || "potted_plant";
  } else {
    set("feasibility", "–");
    set("feasibility-note", "บันทึกแบบแรกเพื่อดูคะแนน");
    set("top", "–");
    set("top-note", "ยังไม่มีข้อมูล");
  }

  const intro = total
    ? `คุณมีแบบเซรามิกบันทึกไว้ ${total} แบบ เปิดกลับไปแก้ในสตูดิโอ 3D หรือให้ AI ช่วยคิดแบบใหม่ได้เลย`
    : "เริ่มออกแบบชิ้นแรกของคุณ แล้วกดบันทึกในสตูดิโอ 3D แบบจะมาอยู่ในหน้านี้";
  $("dash-intro").textContent = intro;
}

function renderFilters() {
  const counts = {};
  state.designs.forEach((d) => {
    if (d.config) counts[d.config.vessel] = (counts[d.config.vessel] || 0) + 1;
  });
  const chips = [["all", "ทั้งหมด", state.designs.length], ...Object.keys(VESSELS).filter((id) => counts[id]).map((id) => [id, VESSELS[id].label, counts[id]])];
  if (state.filter !== "all" && !counts[state.filter]) state.filter = "all";
  $("works-filters").innerHTML = state.designs.length
    ? chips
        .map(
          ([id, label, n]) => `<button type="button" data-filter="${id}" aria-pressed="${state.filter === id}"
            class="px-3.5 py-1.5 rounded-full text-[13px] transition-colors ${
              state.filter === id ? "bg-on-surface text-surface" : "bg-surface-container-high text-on-surface-variant hover:bg-surface-variant"
            }">${label} (${n})</button>`
        )
        .join("")
    : "";
}

function badgeClass(score) {
  if (score >= 80) return "bg-secondary-container text-on-secondary-fixed-variant";
  if (score >= 60) return "bg-tertiary-fixed text-on-tertiary-fixed-variant";
  return "bg-error-container text-on-error-container";
}

function renderWorks() {
  const grid = $("works-grid");
  const list = state.designs.filter((d) => state.filter === "all" || d.config?.vessel === state.filter);
  $("works-empty").classList.toggle("hidden", state.designs.length > 0);
  grid.innerHTML = list
    .map((d) => {
      const c = d.config;
      if (!c) {
        return `<article class="rounded-xl bg-surface-container-low border border-outline-variant/30 p-5 flex flex-col gap-3">
          <p class="font-label-sm text-[11px] uppercase tracking-[0.1em] text-on-surface-variant">ไฟล์แบบเก่า</p>
          <h3 class="font-headline-md text-[20px] leading-snug text-on-surface">${escapeHtml(d.name)}</h3>
          <p class="text-[13px] text-on-surface-variant">เปิดแบบนี้ในสตูดิโอไม่ได้ เพราะข้อมูลทรงไม่ครบ</p>
          <div class="mt-auto flex items-center justify-between pt-2 border-t border-outline-variant/30">
            <span class="text-[12px] text-on-surface-variant">${thaiDate(d.created_at)}</span>
            <button type="button" data-delete="${escapeHtml(d.id)}" class="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container" aria-label="ลบแบบนี้"><span class="material-symbols-outlined text-[18px]">delete</span></button>
          </div>
        </article>`;
      }
      const a = assess(c, state.skill);
      const vessel = VESSELS[c.vessel];
      const studioUrl = `studio.html?d=${encodeConfig(c)}`;
      return `<article class="group rounded-xl bg-surface-container-lowest border border-outline-variant/30 overflow-hidden flex flex-col hover:shadow-md transition-shadow">
        <a href="${studioUrl}" class="relative block aspect-[4/3] thumb-shimmer" data-thumb-wrap>
          <img data-thumb-id="${escapeHtml(d.id)}" alt="ภาพ 3D ของ ${escapeHtml(d.name)}" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500" />
          <span class="absolute top-3 left-3 inline-flex items-center gap-1 bg-surface/90 text-on-surface px-2.5 py-1 rounded-full text-[12px]"><span class="material-symbols-outlined text-[14px]">${vessel.icon || "potted_plant"}</span>${vessel.label}</span>
          <span class="absolute bottom-3 right-3 px-2.5 py-1 rounded-full text-[12px] ${badgeClass(a.feasibility)}">ทำได้ ${a.feasibility}%</span>
        </a>
        <div class="p-5 flex flex-col gap-2 flex-1">
          <p class="font-label-sm text-[11px] uppercase tracking-[0.08em] text-on-surface-variant">${escapeHtml(glazeLabel(c))} · ความยาก ${a.levelLabel}</p>
          <h3 class="font-headline-md text-[20px] leading-snug text-on-surface line-clamp-2">${escapeHtml(d.name)}</h3>
          <p class="text-[13px] text-on-surface-variant line-clamp-2">${escapeHtml(summaryLine(c))}</p>
          <div class="mt-auto pt-3 flex items-center justify-between border-t border-outline-variant/30">
            <span class="text-[12px] text-on-surface-variant">${thaiDate(d.created_at)}</span>
            <div class="flex items-center gap-1">
              <button type="button" data-delete="${escapeHtml(d.id)}" class="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container transition-colors" aria-label="ลบแบบ ${escapeHtml(d.name)}"><span class="material-symbols-outlined text-[18px]">delete</span></button>
              <a href="${studioUrl}" class="inline-flex items-center gap-1 pl-3 pr-2 py-1.5 rounded-full text-primary hover:bg-primary-fixed transition-colors font-label-sm text-[13px]">เปิดในสตูดิโอ<span class="material-symbols-outlined text-[18px]">arrow_forward</span></a>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join("");
  fillThumbnails();
}

function renderAll() {
  renderSkill();
  renderStats();
  renderFilters();
  renderWorks();
}

function renderProfile(profile) {
  const name = profile.displayName || profile.username;
  $("dash-name").textContent = name;
  $("profile-name").textContent = name;
  $("profile-email").textContent = profile.email || "–";
  $("profile-display-name").value = name;
  const avatar = $("profile-avatar");
  if (profile.photoURL) {
    avatar.innerHTML = `<img src="${escapeHtml(profile.photoURL)}" alt="" referrerpolicy="no-referrer" class="w-full h-full object-cover" />`;
  } else {
    avatar.textContent = (name.trim()[0] || "M").toUpperCase();
  }
  const providerNames = { password: "อีเมลและรหัสผ่าน", "google.com": "Google" };
  $("profile-provider").textContent = profile.providers.map((p) => providerNames[p] || p).join(", ");
  $("profile-since").textContent = thaiDate(profile.created_at) || "–";
}

/* ---------------- events ---------------- */
function bindEvents() {
  document.addEventListener("click", async (e) => {
    const skillBtn = e.target.closest("[data-skill]");
    if (skillBtn) {
      state.skill = skillBtn.dataset.skill;
      try {
        localStorage.setItem(SKILL_KEY, state.skill);
      } catch (err) {
        /* ignore */
      }
      renderAll();
      return;
    }
    const filterBtn = e.target.closest("[data-filter]");
    if (filterBtn) {
      state.filter = filterBtn.dataset.filter;
      renderFilters();
      renderWorks();
      return;
    }
    const ideaBtn = e.target.closest("[data-idea]");
    if (ideaBtn) {
      $("assistant-prompt").value = ideaBtn.dataset.idea;
      $("assistant-prompt").focus();
      return;
    }
    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      const design = state.designs.find((d) => d.id === delBtn.dataset.delete);
      if (!design || !window.confirm(`ลบแบบ “${design.name}” ใช่ไหม? ลบแล้วกู้คืนไม่ได้`)) return;
      delBtn.disabled = true;
      try {
        await api.deleteDesign(design.id);
        state.designs = state.designs.filter((d) => d.id !== design.id);
        thumbCache.delete(design.id);
        renderStats();
        renderFilters();
        renderWorks();
        toast("ลบแบบแล้ว", "delete");
      } catch (err) {
        delBtn.disabled = false;
        toast(err.message || "ลบไม่สำเร็จ", "error");
      }
      return;
    }
    if (e.target.closest("[data-logout]")) {
      api.logout();
      window.location.href = "index.html";
    }
  });

  $("assistant-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const idea = $("assistant-prompt").value.trim();
    window.location.href = idea ? `create.html?idea=${encodeURIComponent(idea)}` : "create.html";
  });

  $("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("profile-save");
    btn.disabled = true;
    try {
      const user = await api.updateDisplayName($("profile-display-name").value);
      $("dash-name").textContent = user.username;
      $("profile-name").textContent = user.username;
      const chip = document.querySelector("#mm-account-link .truncate");
      if (chip) chip.textContent = user.username;
      if (!document.querySelector("#profile-avatar img")) $("profile-avatar").textContent = user.username[0].toUpperCase();
      toast("บันทึกชื่อแล้ว");
    } catch (err) {
      toast(err.message || "บันทึกชื่อไม่สำเร็จ", "error");
    } finally {
      btn.disabled = false;
    }
  });

  // Highlight the sidebar entry for the section in view.
  const links = [...document.querySelectorAll(".side-link")];
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((l) => l.setAttribute("aria-current", String(l.getAttribute("href") === `#${entry.target.id}`)));
      });
    },
    { rootMargin: "-40% 0px -55% 0px" }
  );
  document.querySelectorAll(".dash-section").forEach((s) => observer.observe(s));
}

/* ---------------- boot ---------------- */
async function boot() {
  $("dash-today").textContent = new Date().toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long" });
  state.skill = readSkill();
  bindEvents();

  if (!api) return;
  try {
    await api.ready();
  } catch (err) {
    $("dash-loading").innerHTML = `<p class="text-error">${escapeHtml(err.message || "เชื่อมต่อ Firebase ไม่ได้")}</p>`;
    return;
  }
  if (!api.isLoggedIn()) {
    window.location.replace("login.html?next=dashboard.html");
    return;
  }

  $("dash-loading").classList.add("hidden");
  $("dash-content").classList.remove("hidden");
  renderSkill();

  api
    .getProfile()
    .then(renderProfile)
    .catch(() => {
      const user = api.getAuth()?.user;
      if (user) renderProfile({ ...user, displayName: user.username, providers: [], created_at: null });
    });

  try {
    const designs = await api.listMyDesigns(200);
    state.designs = designs.map((d) => ({ ...d, config: parseConfig(d) }));
  } catch (err) {
    $("works-error").textContent = err.message || "โหลดผลงานไม่สำเร็จ";
    $("works-error").classList.remove("hidden");
  }
  renderAll();
}

boot();
