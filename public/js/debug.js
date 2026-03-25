// Shared debug utilities

// ===== GLOBAL ERROR BOUNDARY — catches all uncaught JS errors =====
(function() {
  // Simple toast (works before showToast is defined)
  function errToast(msg, duration = 5000) {
    if (typeof showToast === 'function') {
      showToast(msg, 'error');
    } else {
      const el = document.createElement('div');
      el.className = 'fixed bottom-20 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg z-[9999] text-sm';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), duration);
    }
  }

  // Catch all uncaught errors
  window.onerror = function(message, source, lineno, colno, error) {
    // Ignore known benign errors
    if (message && (
      message.includes('ResizeObserver') ||
      message.includes('Non-Error promise rejection') ||
      message.includes('Failed to fetch') ||
      message.includes('net::ERR_')
    )) return false;

    const err = `[JS ERROR] ${message} at ${source}:${lineno}:${colno}`;
    console.error(err, error);
    if (typeof logger !== 'undefined' && logger.error) {
      logger.error(err);
    }
    errToast('⚠️ Lỗi: ' + message);
    return false; // let default handler run too
  };

  // Catch unhandled promise rejections
  window.addEventListener('unhandledrejection', function(e) {
    const err = e.reason;
    if (!err || typeof err !== 'object') return;
    const msg = err.message || String(err);
    // Ignore network errors (normal in offline mode)
    if (msg.includes('Failed to fetch') || msg.includes('net::ERR') || msg.includes('NetworkError')) return;

    console.error('[UNHANDLED REJECTION]', err);
    if (typeof logger !== 'undefined' && logger.error) {
      logger.error('[UNHANDLED REJECTION] ' + msg);
    }
  });
})();

function initDebugBadge() {
  const html = `
    <div id="debugBadge" class="fixed top-2 right-2 z-50 bg-black/70 text-white text-xs px-2 py-1 rounded pointer-events-none">
      <span id="debugHostname"></span>:<span id="debugPort"></span> | <span id="debugBuildTime"></span>
    </div>
  `;
  document.body.insertAdjacentHTML('afterbegin', html);
  
  document.getElementById('debugHostname').textContent = window.location.hostname;
  document.getElementById('debugPort').textContent = window.location.port || '80';
  document.getElementById('debugBuildTime').textContent = '2026-03-22';
}

// Auto-init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDebugBadge);
} else {
  initDebugBadge();
}
