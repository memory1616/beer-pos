// Dark Mode — Auto-switch at 6PM + manual toggle
// MUST be placed in <head> before body renders to avoid flash of wrong theme
(function () {
  const KEY = 'theme'; // 'light' | 'dark' | 'auto'

  // Apply theme: 'light', 'dark', or auto-detect from time
  function apply(theme) {
    const h = document.documentElement;
    const now = new Date();
    const isNight = now.getHours() >= 18 || now.getHours() < 6;

    if (theme === 'dark' || (theme === 'auto' && isNight)) {
      h.setAttribute('data-theme', 'dark');
    } else {
      h.setAttribute('data-theme', 'light');
    }

    // Persist user choice (don't override if they manually picked)
    if (theme !== 'auto') {
      localStorage.setItem(KEY, theme);
    } else {
      localStorage.removeItem(KEY);
    }
  }

  // Toggle: light → dark → auto → light
  function cycle() {
    const saved = localStorage.getItem(KEY) || 'auto';
    const map = { light: 'dark', dark: 'auto', auto: 'light' };
    apply(map[saved]);
    updateIcon();
  }

  // Set icon/text on the toggle button
  function updateIcon() {
    const saved = localStorage.getItem(KEY) || 'auto';
    const h = document.documentElement;
    const current = h.getAttribute('data-theme') || 'light';
    const btn = document.getElementById('themeToggle');
    if (btn) {
      if (current === 'dark') {
        btn.textContent = '🌙';
        btn.title = 'Chế độ tối (auto lúc 6AM)';
      } else {
        btn.textContent = '☀️';
        btn.title = 'Chế độ sáng';
      }
    }
  }

  // Run immediately (before first paint)
  apply(localStorage.getItem(KEY) || 'auto');

  // Update every minute (for auto 6AM/6PM switch)
  setInterval(() => {
    const saved = localStorage.getItem(KEY) || 'auto';
    apply(saved);
    updateIcon();
  }, 60 * 1000);

  // Expose globally so header can wire up the button
  window.__darkMode = { cycle, updateIcon };

  // Wire up toggle button once DOM is ready
  document.addEventListener('DOMContentLoaded', updateIcon);
})();
