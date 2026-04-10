// Dark Mode — Auto-switch at 6PM + manual toggle
// MUST be placed in <head> before body renders to avoid flash of wrong theme
(function () {
  const KEY = 'theme'; // 'light' | 'dark' | 'auto'

  // Apply theme: 'light', 'dark', or auto-detect from time
  function apply(theme) {
    const h = document.documentElement;
    const now = new Date();
    const isNight = now.getHours() >= 18 || now.getHours() < 6;

    // Binance mode: default = dark. light mode only if explicitly set
    if (theme === 'light') {
      h.setAttribute('data-theme', 'light');
    } else {
      // dark or auto → use dark (auto: night = dark, day = dark for Binance)
      h.setAttribute('data-theme', 'dark');
    }

    // Persist user choice
    if (theme !== 'auto') {
      localStorage.setItem(KEY, theme);
    } else {
      localStorage.removeItem(KEY);
    }
  }

  // Toggle: dark → light → dark → auto → dark
  function cycle() {
    const saved = localStorage.getItem(KEY) || 'dark';
    const map = { dark: 'light', light: 'dark', auto: 'dark' };
    apply(map[saved]);
    updateIcon();
  }

  // Set icon on the toggle button
  function updateIcon() {
    const h = document.documentElement;
    const current = h.getAttribute('data-theme') || 'dark';
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const sun = document.getElementById('themeToggleSun');
    const moon = document.getElementById('themeToggleMoon');
    if (current === 'dark') {
      if (sun) sun.style.display = 'none';
      if (moon) moon.style.display = '';
      btn.title = 'Chế độ sáng';
    } else {
      if (sun) sun.style.display = '';
      if (moon) moon.style.display = 'none';
      btn.title = 'Chế độ tối';
    }
  }

  // Run immediately (before first paint) — default to dark (Binance mode)
  apply(localStorage.getItem(KEY) || 'dark');

  // Update every minute (for auto switch)
  setInterval(() => {
    const saved = localStorage.getItem(KEY) || 'dark';
    apply(saved);
    updateIcon();
  }, 60 * 1000);

  // Expose globally so header can wire up the button
  window.__darkMode = { cycle, updateIcon };

  // Wire up toggle button once DOM is ready
  document.addEventListener('DOMContentLoaded', updateIcon);
})();

// ===== Haptic Feedback — call on button tap =====
window.haptic = function(type = 'light') {
  if (!navigator.vibrate) return;
  const patterns = {
    light: 10,
    medium: 25,
    heavy: 50,
    success: [10, 50, 10],
    error: [50, 30, 50],
  };
  const p = patterns[type] || 10;
  navigator.vibrate(p);
};
