// Shared debug utilities
function initDebugBadge() {
  if (!document.body) {
    setTimeout(initDebugBadge, 50);
    return;
  }
  var html = `
    <div id="debugBadge" class="fixed top-2 right-2 z-50 bg-overlay-70 text-main text-xs px-2 py-1 rounded pointer-events-none">
      <span id="debugHostname"></span>:<span id="debugPort"></span> | <span id="debugBuildTime"></span>
    </div>
  `;
  document.body.insertAdjacentHTML('afterbegin', html);

  var hostnameEl = document.getElementById('debugHostname');
  var portEl = document.getElementById('debugPort');
  var buildTimeEl = document.getElementById('debugBuildTime');
  if (hostnameEl) hostnameEl.textContent = window.location.hostname;
  if (portEl) portEl.textContent = window.location.port || '80';
  if (buildTimeEl) buildTimeEl.textContent = '2026-03-22';
}

// Auto-init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDebugBadge);
} else {
  initDebugBadge();
}
