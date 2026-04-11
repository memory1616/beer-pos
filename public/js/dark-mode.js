// ============================================================
// Beer POS Pro — Theme Manager v2.0
// ============================================================
// Priority:
//   1. User override (localStorage: 'light' | 'dark') — LUON UU TIEN CAO NHAT
//   2. System auto   (matchMedia prefers-color-scheme)
//   3. Time auto     (06:00–18:00 → light, else → dark)
//   4. Default       (dark)
// ============================================================
(function () {
  'use strict';

  var STORAGE_KEY = 'theme';
  var DEFAULTS = { light: 'light', dark: 'dark' };

  // ── Core: lay system theme ─────────────────────────────────────
  function getSystemTheme() {
    if (typeof window === 'undefined' || !window.matchMedia) return DEFAULTS.dark;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? DEFAULTS.dark
      : DEFAULTS.light;
  }

  // ── Core: lay theme theo gio ──────────────────────────────────
  function getTimeTheme() {
    var hour = new Date().getHours();
    return (hour >= 6 && hour < 18) ? DEFAULTS.light : DEFAULTS.dark;
  }

  // ── Core: phan giai theme cuoi cung ────────────────────────────
  function resolveTheme(userOverride) {
    if (userOverride === DEFAULTS.light || userOverride === DEFAULTS.dark) {
      return userOverride; // User da set → dung y het
    }
    // Auto mode: thu system truoc
    var systemTheme = getSystemTheme();
    if (systemTheme) return systemTheme;
    // Fallback: theo gio
    return getTimeTheme();
  }

  // ── Core: apply theme len DOM ─────────────────────────────────
  function apply(theme) {
    var html = document.documentElement;
    html.setAttribute('data-theme', theme);
    html.classList.remove('light', 'dark');
    html.classList.add(theme);
  }

  // ── Core: update icon tren toggle button ──────────────────────
  function updateIcon(theme) {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    var sun = document.getElementById('themeToggleSun');
    var moon = document.getElementById('themeToggleMoon');
    if (theme === DEFAULTS.dark) {
      btn.title = 'Che do sang';
      if (sun) sun.style.display = 'none';
      if (moon) moon.style.display = '';
    } else {
      btn.title = 'Che do toi';
      if (sun) sun.style.display = '';
      if (moon) moon.style.display = 'none';
    }
  }

  // ── Sync icon khi DOM ready ────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var current = document.documentElement.getAttribute('data-theme') || DEFAULTS.dark;
    updateIcon(current);
  });

  // ── Listen system change (matchMedia) ─────────────────────────
  (function watchSystemChange() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved !== 'auto') return; // User da set → khong auto switch

    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', function (e) {
      var s = localStorage.getItem(STORAGE_KEY);
      if (s && s !== 'auto') return;
      var t = e.matches ? DEFAULTS.dark : DEFAULTS.light;
      apply(t);
      updateIcon(t);
    });
  })();

  // ── Timer: kiem tra doi gio moi phut ───────────────────────────
  (function startTimeWatcher() {
    setInterval(function () {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== 'auto') return; // Co user override → bo qua
      var theme = resolveTheme(saved);
      var current = document.documentElement.getAttribute('data-theme');
      if (current !== theme) {
        apply(theme);
        updateIcon(theme);
      }
    }, 60 * 1000);
  })();

  // ── PUBLIC: khoi tao — goi TRUOC body render (trong <head>) ────
  function init() {
    var saved = localStorage.getItem(STORAGE_KEY);
    var theme = resolveTheme(saved);
    apply(theme);
    updateIcon(theme);
  }

  // ── PUBLIC: toggle ─────────────────────────────────────────────
  function toggle() {
    var current = document.documentElement.getAttribute('data-theme') || DEFAULTS.dark;
    var next = current === DEFAULTS.dark ? DEFAULTS.light : DEFAULTS.dark;
    setTheme(next);
  }

  // ── PUBLIC: set theme thu cong ────────────────────────────────
  function setTheme(theme) {
    if (theme !== DEFAULTS.light && theme !== DEFAULTS.dark) theme = DEFAULTS.dark;
    localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
    updateIcon(theme);
  }

  // ── PUBLIC: lay theme hien tai ─────────────────────────────────
  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || DEFAULTS.dark;
  }

  // ── PUBLIC: xoa override, ve auto ─────────────────────────────
  function resetToAuto() {
    localStorage.removeItem(STORAGE_KEY);
    var theme = resolveTheme(null);
    apply(theme);
    updateIcon(theme);
  }

  // ── Expose globally ─────────────────────────────────────────────
  window.__darkMode = {
    init: init,
    cycle: toggle,
    set: setTheme,
    get: getTheme,
    reset: resetToAuto,
    updateIcon: updateIcon,
  };

  // Auto-init ngay (ho tro inline script goi truoc <body>)
  init();
})();
