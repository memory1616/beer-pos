/**
 * Beer POS - Toast Notification System
 * Accessible, touch-friendly, performant
 */
(function () {
  'use strict';

  let container = null;
  let toasts = [];
  const MAX_TOASTS = 5;
  const DEFAULT_DURATION = 4000;

  // Icons for each type
  const ICONS = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  /**
   * Create toast container if not exists
   */
  function ensureContainer() {
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-atomic', 'false');
      document.body.appendChild(container);
    }
  }

  /**
   * Show toast notification
   * @param {string} message - Toast message
   * @param {object} options - { type, title, duration, action }
   */
  function show(message, options = {}) {
    ensureContainer();

    const type = options.type || 'info';
    const title = options.title || '';
    const duration = options.duration !== undefined ? options.duration : DEFAULT_DURATION;
    const action = options.action || null;

    // Limit to MAX_TOASTS
    while (toasts.length >= MAX_TOASTS) {
      dismiss(toasts[0].id);
    }

    const id = Date.now() + Math.random();
    const icon = ICONS[type] || ICONS.info;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.id = `toast-${id}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-labelledby', `toast-title-${id}`);

    toast.innerHTML = `
      <span class="toast__icon" aria-hidden="true">${icon}</span>
      <div class="toast__content">
        ${title ? `<div class="toast__title" id="toast-title-${id}">${title}</div>` : ''}
        <div class="toast__message">${escapeHtml(message)}</div>
      </div>
      ${action ? `<button class="btn btn--sm btn--ghost" onclick="window.__toastAction('${id}', '${action.handler}')">${action.label}</button>` : ''}
      <button class="toast__close" aria-label="Đóng thông báo" onclick="window.__dismissToast('${id}')">✕</button>
    `;

    container.appendChild(toast);
    toasts.push({ id, element: toast });

    // Auto dismiss
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }

    return id;
  }

  /**
   * Dismiss toast by id
   */
  function dismiss(id) {
    const index = toasts.findIndex(t => t.id === id);
    if (index === -1) return;

    const toast = toasts[index];
    toast.element.classList.add('toast--exiting');

    setTimeout(() => {
      if (toast.element.parentNode) {
        toast.element.remove();
      }
      toasts = toasts.filter(t => t.id !== id);
    }, 250);
  }

  /**
   * Dismiss all toasts
   */
  function dismissAll() {
    toasts.forEach(t => dismiss(t.id));
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Expose to global
  window.__toast = {
    show,
    success: (msg, opts) => show(msg, { ...opts, type: 'success' }),
    error: (msg, opts) => show(msg, { ...opts, type: 'error', duration: opts?.duration ?? 6000 }),
    warning: (msg, opts) => show(msg, { ...opts, type: 'warning' }),
    info: (msg, opts) => show(msg, { ...opts, type: 'info' }),
    dismiss,
    dismissAll
  };

  // Global helper functions
  window.__dismissToast = (id) => dismiss(parseFloat(id));
  window.__toastAction = (id, handler) => {
    try {
      const fn = new Function('return ' + handler)();
      if (typeof fn === 'function') fn();
    } catch (e) {
      console.error('Toast action error:', e);
    }
    dismiss(parseFloat(id));
  };

  // Shortcut functions
  window.toast = window.__toast.show.bind(window.__toast);
  window.toastSuccess = window.__toast.success.bind(window.__toast);
  window.toastError = window.__toast.error.bind(window.__toast);
  window.toastWarning = window.__toast.warning.bind(window.__toast);
  window.toastInfo = window.__toast.info.bind(window.__toast);

})();