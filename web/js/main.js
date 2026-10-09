// main.js — shared behaviour across every Mud Magic page.
// Plain script (not a module) so every page can call window.MudMagic.* ,
// including the module-based studio.js.
(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* Sticky nav shadow + mobile menu                                   */
  /* ---------------------------------------------------------------- */
  function initNav() {
    const nav = document.getElementById("top-nav");
    if (nav) {
      const onScroll = () => {
        if (window.scrollY > 8) {
          nav.classList.add("shadow-md", "bg-background/95");
          nav.classList.remove("shadow-sm");
        } else {
          nav.classList.remove("shadow-md", "bg-background/95");
          nav.classList.add("shadow-sm");
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    const toggle = document.getElementById("mobile-menu-toggle");
    const menu = document.getElementById("mobile-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", () => {
        const isOpen = menu.classList.toggle("mobile-menu-open");
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        const iconOpen = toggle.querySelector(".icon-open");
        const iconClose = toggle.querySelector(".icon-close");
        if (iconOpen && iconClose) {
          iconOpen.classList.toggle("hidden", isOpen);
          iconClose.classList.toggle("hidden", !isOpen);
        }
      });
      menu.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => {
          menu.classList.remove("mobile-menu-open");
          toggle.setAttribute("aria-expanded", "false");
        })
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scroll-reveal via IntersectionObserver                            */
  /* ---------------------------------------------------------------- */
  function initScrollReveal() {
    const targets = document.querySelectorAll(".reveal");
    if (!targets.length) return;

    if (!("IntersectionObserver" in window)) {
      targets.forEach((t) => t.classList.add("reveal-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const delay = entry.target.dataset.revealDelay || 0;
            window.setTimeout(() => {
              entry.target.classList.add("reveal-visible");
            }, Number(delay));
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    targets.forEach((t) => observer.observe(t));
  }

  /* ---------------------------------------------------------------- */
  /* Card tilt / magnetic hover interactions                           */
  /* ---------------------------------------------------------------- */
  function initTilt() {
    const cards = document.querySelectorAll("[data-tilt]");
    cards.forEach((card) => {
      let frame = null;
      const strength = Number(card.dataset.tiltStrength || 8);

      const handleMove = (e) => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          card.style.transform = `perspective(900px) rotateX(${(-y * strength).toFixed(2)}deg) rotateY(${(x * strength).toFixed(2)}deg) translateY(-4px)`;
        });
      };
      const reset = () => {
        if (frame) cancelAnimationFrame(frame);
        card.style.transform = "";
      };

      card.addEventListener("mousemove", handleMove);
      card.addEventListener("mouseleave", reset);
      card.addEventListener("touchstart", reset, { passive: true });
    });

    const magnets = document.querySelectorAll("[data-magnet]");
    magnets.forEach((btn) => {
      const strength = Number(btn.dataset.magnetStrength || 10);
      btn.addEventListener("mousemove", (e) => {
        const rect = btn.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        btn.style.transform = `translate(${(x * strength).toFixed(1)}px, ${(y * strength).toFixed(1)}px)`;
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.transform = "";
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Toast notifications                                               */
  /* ---------------------------------------------------------------- */
  let toastTimer = null;
  function showToast(message, { icon = "check_circle" } = {}) {
    let el = document.getElementById("mm-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "mm-toast";
      el.className =
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-inverse-surface text-inverse-on-surface px-5 py-3 rounded-full shadow-lg flex items-center gap-2 font-body-md text-sm opacity-0 pointer-events-none transition-all duration-300 translate-y-2";
      document.body.appendChild(el);
    }
    el.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">${icon}</span><span>${message}</span>`;
    requestAnimationFrame(() => {
      el.classList.remove("opacity-0", "translate-y-2");
    });
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.classList.add("opacity-0", "translate-y-2");
    }, 2600);
  }

  /* ---------------------------------------------------------------- */
  /* Smooth-scroll for in-page anchor links                            */
  /* ---------------------------------------------------------------- */
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      const targetId = a.getAttribute("href");
      if (!targetId || targetId === "#") return;
      a.addEventListener("click", (e) => {
        const target = document.querySelector(targetId);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Account-aware nav: once signed in, the "login" link becomes a     */
  /* profile chip (initial + name) that opens the dashboard, where     */
  /* the profile and logout live (see dashboard.html).                 */
  /* ---------------------------------------------------------------- */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function initAccountNav() {
    const link = document.getElementById("mm-account-link");
    const mobileLink = document.getElementById("mm-account-link-mobile");
    if ((!link && !mobileLink) || !window.MudMagicAPI) return;
    if (!window.MudMagicAPI.isLoggedIn()) return;

    const auth = window.MudMagicAPI.getAuth();
    const name = auth?.user?.username || "My account";
    const initial = (name.trim()[0] || "M").toUpperCase();
    const onDashboard = /dashboard\.html$/.test(location.pathname);

    if (link) {
      // Keep the page's own "hide on phones" choice (index/studio have a mobile menu).
      const display = link.classList.contains("hidden") ? "hidden sm:inline-flex" : "inline-flex";
      link.href = "dashboard.html";
      link.title = "My profile & dashboard";
      link.setAttribute("aria-label", `Profile: ${name}`);
      link.className = `mm-profile-chip ${display} items-center gap-2 pl-1 pr-3 py-1 rounded-full font-label-sm text-label-sm transition-colors whitespace-nowrap ${
        onDashboard ? "bg-primary-fixed text-on-primary-fixed-variant" : "bg-surface-container-high text-on-surface hover:bg-surface-variant"
      }`;
      link.innerHTML = `<span class="w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center text-[13px] font-semibold">${escapeHtml(initial)}</span><span class="max-w-[120px] truncate">${escapeHtml(name)}</span>`;
    }
    if (mobileLink) {
      mobileLink.href = "dashboard.html";
      mobileLink.textContent = `My Profile (${name})`;
    }
  }


  /* ---------------------------------------------------------------- */
  /* Login pop-up. requireLogin() resolves true once the visitor is    */
  /* signed in (immediately if they already are) or false if they      */
  /* close it. Used to gate "เลือกแบบนี้" on Create and every way      */
  /* into Studio for Pro.                                              */
  /* ---------------------------------------------------------------- */
  let loginModalPromise = null;
  function requireLogin({ message = "เข้าสู่ระบบหรือสมัครสมาชิกเพื่อไปต่อ แบบที่คุณทำจะถูกเก็บไว้ในบัญชี", closable = true } = {}) {
    const api = window.MudMagicAPI;
    if (!api || api.isLoggedIn()) return Promise.resolve(true);
    if (loginModalPromise) return loginModalPromise;

    loginModalPromise = new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = "mm-login-modal";
      overlay.className = "fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.innerHTML = `
        <div class="relative w-full max-w-[420px] bg-surface rounded-2xl shadow-2xl p-6 sm:p-8">
          ${closable ? `<button type="button" data-mm-close class="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high" aria-label="ปิด"><span class="material-symbols-outlined">close</span></button>` : ""}
          <img src="img/logo-horizontal.png" alt="Mud Magic" class="h-12 w-auto mb-4" />
          <h2 class="font-headline-md text-[22px] text-on-surface mb-1" data-mm-title>เข้าสู่ระบบก่อนไปต่อ</h2>
          <p class="font-body-md text-sm text-on-surface-variant mb-5">${escapeHtml(message)}</p>
          <div class="grid grid-cols-2 gap-1 p-1 mb-4 bg-surface-container-low rounded-lg" role="tablist">
            <button type="button" data-mm-mode="login" class="py-2 rounded-md text-sm transition-colors">เข้าสู่ระบบ</button>
            <button type="button" data-mm-mode="register" class="py-2 rounded-md text-sm transition-colors">สมัครสมาชิก</button>
          </div>
          <form data-mm-form class="flex flex-col gap-3">
            <input name="email" type="email" required autocomplete="email" placeholder="อีเมล" class="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-sm focus:border-primary focus:ring-primary" />
            <input name="password" type="password" required minlength="6" autocomplete="current-password" placeholder="รหัสผ่าน (อย่างน้อย 6 ตัว)" class="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3 text-sm focus:border-primary focus:ring-primary" />
            <p data-mm-error class="hidden text-sm text-error"></p>
            <button type="submit" data-mm-submit class="w-full bg-primary text-on-primary py-3 rounded-full text-sm font-medium hover:bg-surface-tint transition-colors disabled:opacity-60">เข้าสู่ระบบ</button>
          </form>
          <div class="flex items-center gap-3 my-4 text-xs text-outline"><span class="flex-1 h-px bg-outline-variant"></span>หรือ<span class="flex-1 h-px bg-outline-variant"></span></div>
          <button type="button" data-mm-google class="w-full border border-outline-variant py-3 rounded-full text-sm text-on-surface hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            ดำเนินการต่อด้วย Google
          </button>
        </div>`;
      document.body.appendChild(overlay);
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      const form = overlay.querySelector("[data-mm-form]");
      const errEl = overlay.querySelector("[data-mm-error]");
      const submit = overlay.querySelector("[data-mm-submit]");
      let mode = "login";
      const setMode = (m) => {
        mode = m;
        overlay.querySelectorAll("[data-mm-mode]").forEach((b) => {
          const on = b.dataset.mmMode === m;
          b.className = `py-2 rounded-md text-sm transition-colors ${on ? "bg-surface-container-lowest text-primary shadow-sm" : "text-on-surface-variant hover:text-primary"}`;
        });
        submit.textContent = m === "login" ? "เข้าสู่ระบบ" : "สมัครสมาชิก";
        overlay.querySelector("[data-mm-title]").textContent = m === "login" ? "เข้าสู่ระบบก่อนไปต่อ" : "สมัครสมาชิกก่อนไปต่อ";
        form.password.autocomplete = m === "login" ? "current-password" : "new-password";
        errEl.classList.add("hidden");
      };
      setMode("login");
      overlay.querySelectorAll("[data-mm-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mmMode)));

      const finish = (ok, user) => {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prevOverflow;
        overlay.remove();
        loginModalPromise = null;
        if (ok) {
          initAccountNav();
          showToast(`ยินดีต้อนรับ ${user?.username || ""}`.trim());
        }
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === "Escape" && closable) finish(false);
      };
      document.addEventListener("keydown", onKey);
      if (closable) {
        overlay.querySelector("[data-mm-close]").addEventListener("click", () => finish(false));
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) finish(false);
        });
      }
      const showError = (err) => {
        errEl.textContent = (err && err.message) || "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
        errEl.classList.remove("hidden");
      };

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        submit.disabled = true;
        errEl.classList.add("hidden");
        try {
          const email = form.email.value;
          const password = form.password.value;
          const user = mode === "login" ? await api.login(email, password) : await api.register(email, password);
          finish(true, user);
        } catch (err) {
          showError(err);
        } finally {
          submit.disabled = false;
        }
      });
      overlay.querySelector("[data-mm-google]").addEventListener("click", async () => {
        errEl.classList.add("hidden");
        try {
          const user = await api.loginWithGoogle();
          if (user) finish(true, user);
        } catch (err) {
          showError(err);
        }
      });
      window.setTimeout(() => form.email.focus(), 50);
    });
    return loginModalPromise;
  }

  // Every link into Studio for Pro asks for a login first.
  function isStudioLink(a) {
    const href = a.getAttribute("href") || "";
    return /(^|\/)studio\.html(\?|#|$)/.test(href);
  }
  function initStudioGate() {
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a || !isStudioLink(a) || !window.MudMagicAPI || window.MudMagicAPI.isLoggedIn()) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        const href = a.href;
        requireLogin({ message: "Studio for Pro ใช้ได้เมื่อเข้าสู่ระบบแล้ว งานที่ปั้นจะบันทึกเข้าบัญชีของคุณ" }).then((ok) => {
          if (ok) window.location.href = href;
        });
      },
      true
    );

    // Opening studio.html directly (not the Create-page embed) also needs a login.
    const params = new URLSearchParams(location.search);
    if (/studio\.html$/.test(location.pathname) && params.get("embed") !== "1" && window.MudMagicAPI && !window.MudMagicAPI.isLoggedIn()) {
      requireLogin({ message: "Studio for Pro ใช้ได้เมื่อเข้าสู่ระบบแล้ว งานที่ปั้นจะบันทึกเข้าบัญชีของคุณ" }).then((ok) => {
        if (!ok) window.location.href = "index.html";
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Community gallery (reads localStorage entries saved from the      */
  /* AI journey's feedback step, if the visitor opted to publish one)  */
  /* ---------------------------------------------------------------- */
  function initCommunityGallery() {
    const wrap = document.getElementById("user-gallery-wrap");
    const grid = document.getElementById("user-gallery");
    if (!wrap || !grid) return;

    let entries = [];
    try {
      entries = JSON.parse(localStorage.getItem("mudmagic_gallery") || "[]");
    } catch (err) {
      entries = [];
    }
    if (!Array.isArray(entries) || entries.length === 0) return;

    const levelLabel = { beginner: "มือใหม่", intermediate: "ปานกลาง", advanced: "มืออาชีพ" };
    grid.innerHTML = "";
    entries
      .slice()
      .reverse()
      .forEach((entry) => {
        const card = document.createElement("figure");
        card.className = "reveal reveal-visible hover-lift rounded-xl overflow-hidden relative group bg-surface-container-low";
        card.innerHTML = `
          <img class="w-full h-full object-cover aspect-square" src="${entry.photo || entry.thumb || ""}" alt="ผลงานจริงที่เผาเสร็จแล้ว จากแบบที่ AI แนะนำ" loading="lazy" />
          <span class="absolute top-3 left-3 font-label-sm text-[10px] uppercase tracking-wider bg-surface/90 text-on-surface px-2 py-1 rounded-full">${levelLabel[entry.skillLevel] || "Piece"}</span>
          <figcaption class="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-on-background/70 to-transparent text-surface-container-lowest">
            <span class="font-label-sm text-[10px] uppercase tracking-wider">${"★".repeat(entry.rating || 0)}${"☆".repeat(5 - (entry.rating || 0))}</span>
          </figcaption>`;
        grid.appendChild(card);
      });
    wrap.classList.remove("hidden");
  }

  function boot() {
    initNav();
    initScrollReveal();
    initTilt();
    initSmoothScroll();
    initAccountNav();
    initCommunityGallery();
    initStudioGate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MudMagic = { showToast, initScrollReveal, initTilt, requireLogin };
})();
