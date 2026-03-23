// Beer POS - Cloud Sync (hoạt động với SW queue)
// Include this file in all pages (after layout.js)

// ===== CLOUD SETUP UI =====

// Inject cloud setup modal only (no floating button — Cloud is in Dashboard ⚙️ → tab ☁️)
function initCloudUI() {
  if (document.getElementById('cloudSetupModal')) return;

  // Modal
  const modal = document.createElement('div');
  modal.id = 'cloudSetupModal';
  modal.style.cssText = `
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.5);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 16px;
  `;
  modal.innerHTML = `
    <div id="cloudSetupCard" style="background:white;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="font-size:18px;font-weight:700;color:#111">☁️ Cài đặt Cloud</h2>
        <button id="syncCloseCloudBtn" type="button" style="background:none;border:none;font-size:24px;cursor:pointer;padding:4px;line-height:1;color:#9ca3af">×</button>
      </div>

      <!-- Current status (IDs prefixed sync* — tránh trùng với tab Cloud trên Dashboard) -->
      <div id="syncCloudStatusBox" style="background:#f9fafb;border-radius:10px;padding:12px;margin-bottom:16px;font-size:14px">
        <div style="font-weight:600;color:#374151;margin-bottom:4px">Trạng thái hiện tại:</div>
        <div id="syncCloudStatusText" style="color:#6b7280">Đang kiểm tra...</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="syncBecomeCloudBtn" type="button" style="
          width:100%;padding:14px 16px;border-radius:12px;border:2px solid #1e40af;
          background:white;color:#1e40af;font-size:15px;font-weight:600;cursor:pointer;text-align:left">
          🖥️ <strong>Dùng máy này làm Cloud</strong>
          <div style="font-weight:400;font-size:13px;margin-top:2px;color:#6b7280">
            Các thiết bị khác tự động phát hiện máy này
          </div>
        </button>

        <button id="syncScanCloudBtn" type="button" style="
          width:100%;padding:14px 16px;border-radius:12px;border:2px solid #d1d5db;
          background:white;color:#374151;font-size:15px;font-weight:600;cursor:pointer;text-align:left">
          🔍 <strong>Tìm Cloud trong mạng LAN</strong>
          <div id="syncScanStatus" style="font-weight:400;font-size:13px;margin-top:2px;color:#6b7280">
            Quét các máy trong mạng...
          </div>
        </button>

        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px">
          <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px">Hoặc nhập thủ công:</div>
          <input id="syncCloudUrlInput" type="url" placeholder="http://192.168.1.x:3000"
            style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box">
          <button id="syncSaveCloudUrlBtn" type="button" style="
            width:100%;margin-top:8px;padding:10px;border-radius:8px;
            border:none;background:#1e40af;color:white;font-weight:600;cursor:pointer;font-size:14px">
            Lưu URL Cloud
          </button>
        </div>
      </div>

      <div id="syncPendingQueueInfo" style="margin-top:16px;padding:10px;background:#fef3c7;border-radius:8px;font-size:13px;color:#92400e;display:none">
        <strong>⚠️</strong> Có <span id="syncPendingCount">0</span> thay đổi đang chờ đẩy lên cloud
      </div>
    </div>
  `;

  modal.querySelector('#syncCloseCloudBtn').addEventListener('click', closeCloudModal);
  modal.querySelector('#syncBecomeCloudBtn').addEventListener('click', becomeCloud);
  modal.querySelector('#syncScanCloudBtn').addEventListener('click', scanForCloud);
  modal.querySelector('#syncSaveCloudUrlBtn').addEventListener('click', saveCloudUrl);

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCloudModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('cloudSetupModal');
      if (m && m.style.display !== 'none') closeCloudModal();
    }
  });

  document.body.appendChild(modal);
}

// Show modal
function showCloudModal() {
  const modal = document.getElementById('cloudSetupModal');
  if (!modal) return;
  modal.style.display = 'flex';
  updateCloudModalStatus();
}

function closeCloudModal() {
  const modal = document.getElementById('cloudSetupModal');
  if (modal) modal.style.display = 'none';
}
window.closeCloudModal = closeCloudModal;

// Update modal status
async function updateCloudModalStatus() {
  const statusEl = document.getElementById('syncCloudStatusText');
  const input = document.getElementById('syncCloudUrlInput');
  const pendingInfo = document.getElementById('syncPendingQueueInfo');
  const pendingCount = document.getElementById('syncPendingCount');

  if (!statusEl) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();

  if (pendingInfo) {
    pendingInfo.style.display = pending > 0 ? 'block' : 'none';
    if (pendingCount) pendingCount.textContent = pending;
  }

  if (input) input.value = cloudUrl;

  if (!cloudUrl) {
    statusEl.innerHTML = '🔴 <span style="color:#dc2626"><strong>Chưa có Cloud</strong></span> — thiết bị đang chạy độc lập';
  } else if (!navigator.onLine) {
    statusEl.innerHTML = '🔴 <span style="color:#dc2626"><strong>Offline</strong></span> — cloud: ' + cloudUrl;
  } else {
    statusEl.innerHTML = '🟢 <span style="color:#16a34a"><strong>Đã kết nối Cloud</strong></span><br><span style="font-size:12px;color:#6b7280">' + cloudUrl + '</span>';
  }
}

// USE THIS DEVICE AS CLOUD — just save current origin as cloud URL
async function becomeCloud() {
  const selfUrl = window.location.origin;
  localStorage.setItem('cloudUrl', selfUrl);
  localStorage.setItem('isCloudServer', 'true');
  await updateCloudModalStatus();
  await updateSmartStatus();
  if (navigator.onLine) {
    showToast('☁️ Máy này đã là Cloud! Các thiết bị khác sẽ tự động phát hiện.', 'success');
  }
  closeCloudModal();
}

// SCAN LAN for cloud server
async function scanForCloud() {
  const scanEl = document.getElementById('syncScanStatus') || document.getElementById('scanStatus');
  if (!scanEl) return;
  scanEl.innerHTML = '⏳ Đang quét...';

  const localIP = await getLocalIP();
  if (!localIP) {
    scanEl.innerHTML = '❌ Không lấy được IP máy';
    return;
  }

  const subnet = localIP.substring(0, localIP.lastIndexOf('.'));

  // Check common ports on subnet (1-30)
  const promises = [];
  for (let i = 1; i <= 30; i++) {
    const ip = `${subnet}.${i}`;
    if (ip === localIP) continue; // skip self
    promises.push(checkDevice(ip, 3000));
    promises.push(checkDevice(ip, 3001));
  }

  const results = await Promise.allSettled(promises);
  const found = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (found.length > 0) {
    const cloud = found[0];
    localStorage.setItem('cloudUrl', cloud.url);
    localStorage.removeItem('isCloudServer');
    scanEl.innerHTML = '✅ Tìm thấy: <strong>' + cloud.name + '</strong><br><span style="font-size:12px;color:#6b7280">' + cloud.url + '</span>';
    setTimeout(async () => {
      await updateCloudModalStatus();
      await updateSmartStatus();
      showToast('☁️ Đã kết nối: ' + cloud.name, 'success');
      closeCloudModal();
    }, 1500);
  } else {
    scanEl.innerHTML = '❌ Không tìm thấy Cloud nào.<br><span style="font-size:12px">Đảm bảo máy Cloud đang bật và cùng mạng.</span>';
  }
}

async function checkDevice(ip, port) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://${ip}:${port}/api/discover`, {
      signal: ctrl.signal,
      cache: 'no-store'
    });
    clearTimeout(id);
    if (res.ok) {
      const data = await res.json();
      return { ip, port, name: data.name || 'BeerPOS Cloud', url: data.url || `http://${ip}:${port}` };
    }
  } catch {}
  return null;
}
window.checkDevice = checkDevice;
window.getLocalIP = getLocalIP;

// Save cloud URL manually
function saveCloudUrl() {
  // syncCloudUrlInput = popup inject; cloudUrlInput = Dashboard tab ☁️
  const input =
    document.getElementById('syncCloudUrlInput') ||
    document.getElementById('cloudUrlInput') ||
    document.getElementById('cloudUrl');
  if (!input) return;
  const url = input.value.trim();

  localStorage.setItem('cloudUrl', url);
  localStorage.removeItem('isCloudServer');
  closeCloudModal();
  updateSmartStatus();
  if (navigator.onLine && url) {
    syncNow();
    showToast('☁️ Đã lưu: ' + url, 'success');
  } else {
    showToast('☁️ Đã lưu: ' + url, 'success');
  }
}
window.saveCloudUrl = saveCloudUrl;

// Init cloud UI after DOM ready (chỉ inject modal ẩn — Cloud: Dashboard ⚙️ → tab ☁️)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initCloudUI, 500));
} else {
  setTimeout(initCloudUI, 500);
}

// ===== END CLOUD SETUP UI =====

// Get cloud URL from localStorage
function getCloudUrl() {
  return localStorage.getItem('cloudUrl') || '';
}

// Open IndexedDB (same DB name as sw.js)
const SW_DB_NAME = 'BeerPOS';
const SW_STORE = 'sync_queue';

function openSWDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SW_DB_NAME, 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(SW_STORE)) {
        const store = db.createObjectStore(SW_STORE, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
    };
  });
}

// Count pending items in SW queue
async function countPendingQueue() {
  try {
    const db = await openSWDB();
    const tx = db.transaction(SW_STORE, 'readonly');
    const store = tx.objectStore(SW_STORE);
    const index = store.index('synced');
    return new Promise((resolve) => {
      const req = index.count(IDBKeyRange.only(0));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

// Get last sync time
function getLastSyncText() {
  const lastSync = localStorage.getItem('lastSync');
  if (!lastSync) return '';
  const date = new Date(lastSync);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'vừa xong';
  if (diffMins < 60) return diffMins + ' phút trước';
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return diffHours + ' giờ trước';
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

// Update smart online/offline indicator in header
async function updateSmartStatus() {
  const el = document.getElementById('onlineStatus');
  const syncEl = document.getElementById('syncStatus');
  if (!el) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();

  // Offline
  if (!navigator.onLine) {
    el.textContent = '🔴 Offline';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700';
    if (syncEl) {
      if (pending > 0) {
        syncEl.textContent = `⏳ ${pending} chờ đẩy`;
        syncEl.className = 'text-xs text-orange-500 font-medium';
      } else {
        syncEl.textContent = '⚠️ Không kết nối';
        syncEl.className = 'text-xs text-gray-400';
      }
    }
    return;
  }

  // No cloud URL configured — still show pending queue status
  if (!cloudUrl) {
    el.textContent = '🟡 Cục bộ';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700';
    if (syncEl) {
      if (pending > 0) {
        syncEl.textContent = `📴 ${pending} chờ đẩy lên server`;
        syncEl.className = 'text-xs text-orange-500 font-medium';
      } else {
        syncEl.textContent = '📴 Không có cloud';
        syncEl.className = 'text-xs text-gray-400';
      }
    }
    return;
  }

  // Online + cloud configured — check reachability
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    if (res.ok) {
      el.textContent = '🟢 Online';
      el.className = 'text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700';
      if (syncEl) {
        if (pending > 0) {
          syncEl.textContent = `📤 ${pending} chờ đẩy`;
          syncEl.className = 'text-xs text-blue-500 font-medium';
        } else {
          const syncText = getLastSyncText();
          syncEl.textContent = syncText ? `✓ ${syncText}` : '✓ Đã đồng bộ';
          syncEl.className = 'text-xs text-green-600';
        }
      }
    } else {
      throw 'non-ok';
    }
  } catch {
    el.textContent = '🟡 Lỗi mạng';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700';
    if (syncEl) {
      syncEl.textContent = pending > 0 ? `⏳ ${pending} chờ` : '⚠️ Không kết nối server';
      syncEl.className = 'text-xs text-orange-500';
    }
  }
}

// Push pending SW queue items to server
async function syncQueueToCloud() {
  if (!navigator.onLine) return;

  // Nếu máy này là Cloud Server → dữ liệu đã ở DB, chỉ clear queue
  const isCloudServer = localStorage.getItem('isCloudServer') === 'true';
  if (isCloudServer) {
    const pending = await countPendingQueue();
    if (pending > 0) {
      const db = await openSWDB();
      const tx = db.transaction(SW_STORE, 'readwrite');
      tx.objectStore(SW_STORE).clear();
      console.log(`[Sync] Cloud Server: cleared ${pending} queued items (local DB is source of truth)`);
    }
    return;
  }

  const pending = await countPendingQueue();
  if (pending === 0) return;

  try {
    const db = await openSWDB();
    const tx = db.transaction(SW_STORE, 'readonly');
    const store = tx.objectStore(SW_STORE);
    const index = store.index('synced');
    const items = await new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only(0));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });

    if (!items || items.length === 0) return;

    // Format as server expects
    const changes = items.map(item => ({
      entity: item.entity || 'unknown',
      entity_id: item.data?.id || null,
      action: item.action || (item.method === 'DELETE' ? 'delete' : item.method === 'PUT' ? 'update' : 'create'),
      data: item.data || {},
      client_updated_at: item.created_at
    }));

    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[Sync] Pushed ${data.synced || 0} items to server`);
      localStorage.setItem('lastSync', new Date().toISOString());
    }
  } catch (e) {
    console.log('[Sync] Cloud push failed:', e.message);
  }
}

// Pull data from cloud and reload
async function pullFromCloud() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !navigator.onLine) return;

  const lastSync = localStorage.getItem('lastSync') || '';
  try {
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUrl, lastSync })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.changes && Object.keys(data.changes).length > 0) {
        localStorage.setItem('lastSync', data.serverTime);
        console.log('[Sync] Pulled changes, reloading...');
        location.reload();
      }
    }
  } catch (e) {
    console.log('[Sync] Cloud pull failed:', e.message);
  }
}

// Sync now — push then pull
async function syncNow() {
  if (!navigator.onLine) {
    showToast('Không có mạng — đang chờ đẩy khi kết nối', 'info');
    return;
  }
  const pending = await countPendingQueue();
  if (pending > 0) {
    showToast(`Đang đẩy ${pending} thay đổi...`, 'info');
    await syncQueueToCloud();
  }
  await pullFromCloud();
  await updateSmartStatus();
}

// Manual sync button handler — call this from UI
window.syncNow = syncNow;

// Download database backup
function downloadBackup() {
  window.location.href = '/api/backup';
}
window.downloadBackup = downloadBackup;

// Listen for SW messages
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async event => {
    if (event.data?.type === 'SYNC_COMPLETE') {
      console.log('[Sync] SW sync complete');
      await updateSmartStatus();
      showToast('Đã đồng bộ!', 'success');
    }
    if (event.data?.type === 'SYNC_QUEUED') {
      console.log('[Sync] Item queued by SW');
      await updateSmartStatus();
    }
  });
}

// Online event — trigger background sync + cloud push
window.addEventListener('online', async () => {
  console.log('[Sync] Back online!');
  await syncQueueToCloud();
  await syncNow();
  await updateSmartStatus();
});

// Offline event — update indicator
window.addEventListener('offline', async () => {
  await updateSmartStatus();
});

// Auto-sync every 60 seconds
setInterval(async () => {
  if (navigator.onLine) {
    await syncQueueToCloud();
  }
  await updateSmartStatus();
}, 60000);

// Initial status check
setTimeout(async () => {
  await updateSmartStatus();
  if (navigator.onLine && getCloudUrl()) {
    setTimeout(() => syncNow(), 3000);
  }
}, 2000);

console.log('[Sync] BeerPOS sync initialized');
