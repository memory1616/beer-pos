// Beer POS - Cloud Sync Functions
// Include this file in all pages

// Get cloud URL from localStorage
function getCloudUrl() {
  return localStorage.getItem('cloudUrl') || '';
}

// Smart Offline Indicator - 3 States
async function updateSmartStatus() {
  const el = document.getElementById('onlineStatus');
  const syncEl = document.getElementById('syncStatus');
  
  // Skip if elements don't exist on this page
  if (!el) return;
  
  const cloudUrl = getCloudUrl();
  
  // Get last sync time
  const lastSync = localStorage.getItem('lastSync');
  let lastSyncText = '';
  if (lastSync) {
    const date = new Date(lastSync);
    lastSyncText = ' • ' + date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  
  // Check if offline
  if (!navigator.onLine) {
    el.textContent = '🔴 Offline';
    el.className = 'text-xs px-2 py-1 rounded-full bg-red-100 text-red-700';
    return;
  }
  
  // No cloud URL configured
  if (!cloudUrl) {
    el.textContent = '🟡 No Sync';
    el.className = 'text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700';
    if (syncEl) {
      syncEl.textContent = '☁️ Cấu hình';
      syncEl.className = 'text-xs text-yellow-600';
    }
    return;
  }
  
  // Check if API is reachable
  try {
    const res = await fetch('/api/backup', { method: 'HEAD', cache: 'no-store' });
    if (res.ok) {
      el.textContent = '🟢 Online';
      el.className = 'text-xs px-2 py-1 rounded-full bg-green-100 text-green-700';
      if (syncEl) {
        syncEl.textContent = '✓' + lastSyncText;
        syncEl.className = 'text-xs text-green-600';
      }
    } else {
      throw 'error';
    }
  } catch (e) {
    el.textContent = '🟡 Online';
    el.className = 'text-xs px-2 py-1 rounded-full bg-yellow-100 text-yellow-700';
    if (syncEl) {
      syncEl.textContent = '⚠️ Lỗi';
      syncEl.className = 'text-xs text-orange-500';
    }
  }
}

// Sync pending data to cloud
async function syncData() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !navigator.onLine) return;
  
  try {
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUrl })
    });
    const data = await res.json();
    updateSyncStatus(data);
    updateSmartStatus(); // Update status after sync
  } catch (e) {
    console.log('Sync failed:', e.message);
    updateSmartStatus();
  }
}

// Pull data from cloud
async function pullData() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !navigator.onLine) return;
  
  try {
    const lastSync = localStorage.getItem('lastSync') || '';
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUrl, lastSync })
    });
    const data = await res.json();
    if (data.imported > 0) {
      localStorage.setItem('lastSync', new Date().toISOString());
      location.reload();
    }
  } catch (e) {
    console.log('Pull failed:', e.message);
  }
}

// Update sync status display
function updateSyncStatus(data) {
  const el = document.getElementById('syncStatus');
  if (el && data.synced !== undefined) {
    el.textContent = data.synced > 0 ? `🔄 ${data.synced}` : '✅';
  }
}

// Show cloud settings modal
function showCloudSettings() {
  const modal = document.getElementById('cloudModal');
  const input = document.getElementById('cloudUrlInput');
  if (modal && input) {
    input.value = getCloudUrl();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

// Close cloud settings modal
function closeCloudModal() {
  const modal = document.getElementById('cloudModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// Save cloud URL
function saveCloudUrl() {
  const input = document.getElementById('cloudUrlInput');
  if (input) {
    const url = input.value.trim();
    localStorage.setItem('cloudUrl', url);
    closeCloudModal();
    if (navigator.onLine && url) {
      syncData();
      pullData();
    }
    updateSmartStatus();
  }
}

// Download database backup
function downloadBackup() {
  window.location.href = '/api/backup';
}

// Online event handler
window.addEventListener('online', () => {
  updateSmartStatus();
  if (getCloudUrl()) {
    syncData();
    pullData();
  }
});

// Offline event handler  
window.addEventListener('offline', () => {
  updateSmartStatus();
});

// Check pending sync items in IndexedDB
async function checkPendingSync() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('BeerPOS', 2);
      request.onsuccess = (event) => {
        const db = event.target.result;
        if (db.objectStoreNames.contains('sync_queue')) {
          const transaction = db.transaction(['sync_queue'], 'readonly');
          const store = transaction.objectStore('sync_queue');
          const countRequest = store.count();
          countRequest.onsuccess = () => {
            resolve(countRequest.result);
          };
          countRequest.onerror = () => resolve(0);
        } else {
          resolve(0);
        }
      };
      request.onerror = () => resolve(0);
    } catch (e) {
      resolve(0);
    }
  });
}

// Update status with pending sync info
async function updateStatusWithPending() {
  const cloudUrl = getCloudUrl();
  const syncEl = document.getElementById('syncStatus');
  
  if (cloudUrl) {
    const pending = await checkPendingSync();
    if (syncEl && pending > 0) {
      syncEl.textContent = `⏳ ${pending} chờ`;
      syncEl.className = 'text-sm text-orange-500 font-medium';
    }
  }
}

// Auto sync every 20 seconds when online
setInterval(() => {
  if (navigator.onLine && getCloudUrl()) {
    syncData();
  }
  updateSmartStatus();
}, 20000);

// Initial status check on page load
setTimeout(() => {
  updateSmartStatus();
  updateStatusWithPending();
  
  // Initial sync if configured
  const cloudUrl = getCloudUrl();
  if (cloudUrl && navigator.onLine) {
    setTimeout(() => {
      syncData();
      pullData();
    }, 3000);
  }
}, 1500);

console.log('Cloud sync initialized');
