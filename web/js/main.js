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
  /* Account-aware nav: swaps "Get Started" -> "Logout (username)"     */
  /* when the API reports an active session (see api-client.js).       */
  /* ---------------------------------------------------------------- */
  function initAccountNav() {
    const link = document.getElementById("mm-account-link");
    const mobileLink = document.getElementById("mm-account-link-mobile");
    if ((!link && !mobileLink) || !window.MudMagicAPI) return;

    if (window.MudMagicAPI.isLoggedIn()) {
      const auth = window.MudMagicAPI.getAuth();
      const username = auth?.user?.username || "account";
      [link, mobileLink].forEach((el) => {
        if (!el) return;
        el.textContent = `ออกจากระบบ (${username})`;
        el.setAttribute("href", "#");
        el.addEventListener("click", (e) => {
          e.preventDefault();
          window.MudMagicAPI.logout();
          window.location.reload();
        });
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MudMagic = { showToast, initScrollReveal, initTilt };
})();
