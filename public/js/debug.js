// Shared debug utilities
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
