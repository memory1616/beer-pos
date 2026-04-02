// Beer POS - Cloud Sync (hoạt động với SW queue)
// Include this file in all pages (after layout.js)

// ===== DEVICE ID — unique per browser/device =====

function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    // Generate a unique device ID based on random + timestamp
    deviceId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('deviceId', deviceId);
  }
  return deviceId;
}

// Per-cloud lastSync: map<cloudUrl, lastSyncTimestamp>
// This lets a device connect to MULTIPLE cloud servers independently
function getLastSyncForCloud(cloudUrl) {
  const map = JSON.parse(localStorage.getItem('cloudLastSyncMap') || '{}');
  return map[cloudUrl] || null;
}

function setLastSyncForCloud(cloudUrl, timestamp) {
  const map = JSON.parse(localStorage.getItem('cloudLastSyncMap') || '{}');
  map[cloudUrl] = timestamp;
  localStorage.setItem('cloudLastSyncMap', JSON.stringify(map));
}

// Check if this device has ever synced with a given cloud
function hasSyncedWithCloud(cloudUrl) {
  return getLastSyncForCloud(cloudUrl) !== null;
}

// ===== CLOUD SETUP UI =====

// Inject cloud setup modal only (no floating button — Cloud is in Dashboard ⚙️ → tab ☁️)
function initCloudUI() {
  if (document.getElementById('cloudSetupModal')) return;

  // Modal
  const modal = document.createElement('div');
  modal.id = 'cloudSetupModal';
  modal.className = 'cloud-modal';
  modal.innerHTML = `
    <div class="cloud-card">
      <div class="cloud-card-header">
        <h2 class="cloud-card-title">☁️ Cài đặt Cloud</h2>
        <button id="syncCloseCloudBtn" type="button" class="cloud-card-close">×</button>
      </div>

      <!-- Current status (IDs prefixed sync* — tránh trùng với tab Cloud trên Dashboard) -->
      <div class="cloud-status-box">
        <div class="cloud-status-label">Trạng thái hiện tại:</div>
        <div id="syncCloudStatusText" class="cloud-status-text">Đang kiểm tra...</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="syncBecomeCloudBtn" type="button" class="cloud-option-btn">
          🖥️ <strong>Dùng máy này làm Cloud</strong>
          <div style="font-weight:400;font-size:13px;margin-top:2px;color:var(--color-text-secondary)">
            Các thiết bị khác tự động phát hiện máy này
          </div>
        </button>

        <button id="syncScanCloudBtn" type="button" class="cloud-option-btn">
          🔍 <strong>Tìm Cloud trong mạng LAN</strong>
          <div id="syncScanStatus" style="font-weight:400;font-size:13px;margin-top:2px;color:var(--color-text-secondary)">
            Quét các máy trong mạng...
          </div>
        </button>

        <div class="cloud-manual-box">
          <div class="cloud-manual-label">Hoặc nhập thủ công:</div>
          <input id="syncCloudUrlInput" type="url" placeholder="http://192.168.1.x:3000"
            class="cloud-input">
          <button id="syncSaveCloudUrlBtn" type="button" class="btn btn-secondary" style="margin-top:8px;width:100%">
            Lưu URL Cloud
          </button>
        </div>
      </div>

      <div id="syncPendingQueueInfo" class="cloud-pending">
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
    statusEl.innerHTML = '🔴 <span style="color:var(--color-danger)"><strong>Chưa có Cloud</strong></span> — thiết bị đang chạy độc lập';
  } else if (!navigator.onLine) {
    statusEl.innerHTML = '🔴 <span style="color:var(--color-danger)"><strong>Offline</strong></span> — cloud: ' + cloudUrl;
  } else {
    statusEl.innerHTML = '🟢 <span style="color:var(--color-success)"><strong>Đã kết nối Cloud</strong></span><br><span style="font-size:12px;color:var(--color-text-secondary)">' + cloudUrl + '</span>';
  }
}

// USE THIS DEVICE AS CLOUD — just save current origin as cloud URL
async function becomeCloud() {
  const selfUrl = window.location.origin;
  localStorage.setItem('cloudUrl', selfUrl);
  localStorage.setItem('isCloudServer', 'true');
  syncCloudUrlToSW(selfUrl);
  await updateCloudModalStatus();
  await updateSmartStatus();
  if (navigator.onLine) {
    showToast('☁️ Máy này đã là Cloud! Các thiết bị khác sẽ tự động phát hiện.', 'success');
  }
  closeCloudModal();
}

async function getLocalIP() {
  // Tầng 1: WebRTC ICE candidate (nhanh, không cần server)
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('');
    const offer = await pc.createOffer();
    pc.setLocalDescription(offer);
    return new Promise(resolve => {
      pc.onicecandidate = e => {
        if (e.candidate && e.candidate.candidate.includes('srflx')) {
          const match = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (match) resolve(match[1]);
        }
      };
      setTimeout(resolve, 3000);
    });
  } catch {}

  // Tầng 2: Thử gọi /api/discover trên chính máy này (localhost)
  // Server sẽ trả về mảng LAN IPs
  try {
    const res = await fetch('/api/discover?deviceId=self-probe', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.lanIPs && data.lanIPs.length > 0) {
        return data.lanIPs[0];
      }
    }
  } catch {}

  return null;
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
  scanEl.innerHTML = '⏳ Đang quét subnet ' + subnet + '.x ...';

  // Scan full subnet (1-254) in batches to avoid browser connection throttling
  const BATCH = 25;
  const found = [];

  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254);
    const promises = [];
    for (let i = start; i <= end; i++) {
      const ip = `${subnet}.${i}`;
      if (ip === localIP) continue; // skip self
      promises.push(checkDevice(ip, 3000));
      promises.push(checkDevice(ip, 3001));
    }
    const results = await Promise.allSettled(promises);
    const batchFound = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    found.push(...batchFound);

    // Update progress
    const pct = Math.round((end / 254) * 100);
    scanEl.innerHTML = `⏳ Đang quét... ${pct}%`;

    // Small yield to keep UI responsive and avoid thundering herd
    await new Promise(r => setTimeout(r, 50));
  }

  if (found.length > 0) {
    // Prefer internet domain over LAN IP for remote/cloud deployment
    const cloud = found.find(c => c.domain) || found[0];
    const cloudUrl = cloud.domain || cloud.url;
    const prevSync = hasSyncedWithCloud(cloudUrl);
    localStorage.setItem('cloudUrl', cloudUrl);
    localStorage.removeItem('isCloudServer');
    syncCloudUrlToSW(cloudUrl);
    scanEl.innerHTML = '✅ Tìm thấy: <strong>' + cloud.name + '</strong><br><span style="font-size:12px;color:var(--color-text-secondary)">' + cloudUrl + '</span>';
    setTimeout(async () => {
      await updateCloudModalStatus();
      await updateSmartStatus();
      showToast('☁️ Đã kết nối: ' + cloud.name, 'success');
      if (!prevSync) {
        showToast('🔄 Đồng bộ lần đầu — đang tải dữ liệu từ cloud...', 'info');
        await doFirstSync(cloudUrl);
      }
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
    const deviceId = getOrCreateDeviceId();
    const res = await fetch(`http://${ip}:${port}/api/discover?deviceId=${encodeURIComponent(deviceId)}`, {
      signal: ctrl.signal,
      cache: 'no-store'
    });
    clearTimeout(id);
    if (res.ok) {
      const data = await res.json();
      return {
        ip,
        port,
        name: data.name || 'BeerPOS Cloud',
        url: data.url || `http://${ip}:${port}`,
        isCloudServer: data.isCloudServer || false
      };
    }
  } catch {}
  return null;
}
window.checkDevice = checkDevice;
// Save cloud URL manually
// Tell SW the cloud URL so background sync can reach it
function syncCloudUrlToSW(url) {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SET_CLOUD_URL', url });
  }
}

// Push cloud URL to SW when it changes
function saveCloudUrl() {
  // syncCloudUrlInput = popup inject; cloudUrlInput = Dashboard tab ☁️
  const input =
    document.getElementById('syncCloudUrlInput') ||
    document.getElementById('cloudUrlInput') ||
    document.getElementById('cloudUrl');
  if (!input) return;
  const url = input.value.trim();

  const prevSync = hasSyncedWithCloud(url);
  localStorage.setItem('cloudUrl', url);
  localStorage.removeItem('isCloudServer');
  syncCloudUrlToSW(url);
  closeCloudModal();
  updateSmartStatus();
  if (navigator.onLine && url) {
    if (!prevSync) {
      showToast('🔄 Đồng bộ lần đầu — đang tải dữ liệu...', 'info');
      doFirstSync(url).then(() => showToast('☁️ Đã kết nối cloud', 'success'));
    } else {
      syncNow();
      showToast('☁️ Đã lưu: ' + url, 'success');
    }
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
window.getCloudUrl = getCloudUrl;

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

// Get last sync time for current cloud
function getLastSyncText() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl) return '';
  const lastSync = getLastSyncForCloud(cloudUrl);
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
    el.className = 'badge badge-danger';
    if (syncEl) {
      if (pending > 0) {
        syncEl.textContent = `⏳ ${pending} chờ đẩy`;
        syncEl.className = 'text-xs text-warning font-medium';
      } else {
        syncEl.textContent = '⚠️ Không kết nối';
        syncEl.className = 'text-xs text-muted';
      }
    }
    return;
  }

  // No cloud URL configured — still show pending queue status
  if (!cloudUrl) {
    el.textContent = '🟡 Cục bộ';
    el.className = 'badge badge-warning';
    if (syncEl) {
      if (pending > 0) {
        syncEl.textContent = `📴 ${pending} chờ đẩy lên server`;
        syncEl.className = 'text-xs text-warning font-medium';
      } else {
        syncEl.textContent = '📴 Không có cloud';
        syncEl.className = 'text-xs text-muted';
      }
    }
    return;
  }

  // Online + cloud configured — check reachability
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    if (res.ok) {
      el.textContent = '🟢 Online';
      el.className = 'badge badge-success';
      if (syncEl) {
        if (pending > 0) {
          syncEl.textContent = `📤 ${pending} chờ đẩy`;
          syncEl.className = 'text-xs text-info font-medium';
        } else {
          const syncText = getLastSyncText();
          syncEl.textContent = syncText ? `✓ ${syncText}` : '✓ Đã đồng bộ';
          syncEl.className = 'text-xs text-success';
        }
      }
    } else {
      throw 'non-ok';
    }
  } catch {
    el.textContent = '🟡 Lỗi mạng';
    el.className = 'badge badge-warning';
    if (syncEl) {
      syncEl.textContent = pending > 0 ? `⏳ ${pending} chờ` : '⚠️ Không kết nối server';
      syncEl.className = 'text-xs text-warning';
    }
  }
}

// Push pending SW queue items to server
async function syncQueueToCloud() {
  if (!navigator.onLine) return;

  const cloudUrl = getCloudUrl();

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
      body: JSON.stringify({ changes, deviceId: getOrCreateDeviceId() })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`[Sync] Pushed ${data.synced || 0} items to server`);
      const now = new Date().toISOString();
      setLastSyncForCloud(cloudUrl, now);

      // Clear synced items from queue so they're not re-pushed next time
      const delTx = db.transaction(SW_STORE, 'readwrite');
      const delStore = delTx.objectStore(SW_STORE);
      const delIndex = delStore.index('synced');
      const delReq = delIndex.openCursor(IDBKeyRange.only(0));
      delReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    }
  } catch (e) {
    console.log('[Sync] Cloud push failed:', e.message);
  }
}

// Pull data from cloud and reload
async function pullFromCloud() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !navigator.onLine) return;

  const lastSync = getLastSyncForCloud(cloudUrl) || '1970-01-01T00:00:00.000Z';
  try {
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUrl, lastSync, deviceId: getOrCreateDeviceId() })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.changes && Object.keys(data.changes).length > 0) {
        setLastSyncForCloud(cloudUrl, data.serverTime);
        console.log('[Sync] Pulled changes, reloading...');
        location.reload();
      } else {
        // No changes but mark as synced so we don't re-pull unnecessarily
        setLastSyncForCloud(cloudUrl, data.serverTime || new Date().toISOString());
      }
    }
  } catch (e) {
    console.log('[Sync] Cloud pull failed:', e.message);
  }
}

// First sync: full pull from cloud (no push, no conflict risk)
async function doFirstSync(cloudUrl) {
  console.log('[Sync] 🔄 First-time sync with', cloudUrl);
  try {
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudUrl,
        lastSync: '1970-01-01T00:00:00.000Z',
        deviceId: getOrCreateDeviceId(),
        firstSync: true
      })
    });
    if (res.ok) {
      const data = await res.json();
      setLastSyncForCloud(cloudUrl, data.serverTime || new Date().toISOString());
      console.log('[Sync] ✅ First sync complete, data received:', JSON.stringify(data.changes || {}));
      showToast('✅ Đã đồng bộ ' + Object.keys(data.changes || {}).length + ' bảng dữ liệu!', 'success');
    } else {
      console.warn('[Sync] First sync failed:', res.status);
    }
  } catch (e) {
    console.error('[Sync] First sync error:', e.message);
  }
}

// Sync now — for first sync: pull before push to avoid overwriting cloud data with empty local queue
async function syncNow() {
  if (!navigator.onLine) {
    showToast('Không có mạng — đang chờ đẩy khi kết nối', 'info');
    return;
  }
  const cloudUrl = getCloudUrl();
  if (!cloudUrl) return;

  const pending = await countPendingQueue();
  const isFirstSync = !hasSyncedWithCloud(cloudUrl);

  // First sync: pull cloud data first so local queue won't overwrite it
  if (isFirstSync) {
    await doFirstSync(cloudUrl);
  }

  if (pending > 0) {
    showToast(`Đang đẩy ${pending} thay đổi...`, 'info');
    await syncQueueToCloud();
  }

  if (!isFirstSync) {
    await pullFromCloud();
  }
  await updateSmartStatus();
}

// Manual sync button handler — call this from UI
window.syncNow = syncNow;

// Refresh cloud tab in dashboard settings modal
async function refreshCloudTab() {
  const statusEl = document.getElementById('cloudStatusText');
  const input = document.getElementById('cloudUrlInput');
  if (!statusEl) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();
  if (!cloudUrl) {
    statusEl.innerHTML = '🔴 <span class="text-danger"><strong>Chưa có Cloud</strong></span> — đang chạy độc lập' +
      (pending > 0 ? ` <span class="text-warning">(${pending} chờ đẩy)</span>` : '');
  } else if (!navigator.onLine) {
    statusEl.innerHTML = '🔴 <span class="text-danger"><strong>Offline</strong></span> — cloud: ' + cloudUrl;
  } else {
    statusEl.innerHTML = '🟢 <span class="text-success"><strong>Đã kết nối Cloud</strong></span>' +
      (pending > 0 ? ` <span class="text-warning">(${pending} chờ đẩy)</span>` : '') +
      '<br><span class="text-xs text-muted">' + cloudUrl + '</span>';
  }
  if (input) input.value = cloudUrl;
}

window.becomeCloud = becomeCloud;
window.scanForCloud = scanForCloud;
window.checkDevice = checkDevice;
window.saveCloudUrl = saveCloudUrl;
window.refreshCloudTab = refreshCloudTab;
window.getCloudUrl = getCloudUrl;
window.syncQueueToCloud = syncQueueToCloud;
window.pullFromCloud = pullFromCloud;
window.doFirstSync = doFirstSync;
window.hasSyncedWithCloud = hasSyncedWithCloud;
window.getOrCreateDeviceId = getOrCreateDeviceId;

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

// Auto-sync every 60 seconds (push queue + pull changes)
setInterval(async () => {
  if (navigator.onLine) {
    await syncQueueToCloud();
    // Pull cloud changes (skip full reload, just update local DB via reload)
    const cloudUrl = getCloudUrl();
    if (cloudUrl && hasSyncedWithCloud(cloudUrl)) {
      await pullFromCloud();
    }
  }
  await updateSmartStatus();
}, 60000);

// Initial status check
setTimeout(async () => {
  const cloudUrl = getCloudUrl();
  if (cloudUrl) syncCloudUrlToSW(cloudUrl);
  await updateSmartStatus();
  if (navigator.onLine && cloudUrl) {
    const isFirst = !hasSyncedWithCloud(cloudUrl);
    if (isFirst) {
      console.log('[Sync] New cloud connection detected — initiating first sync');
      await doFirstSync(cloudUrl);
    } else {
      setTimeout(() => syncNow(), 3000);
    }
  }
}, 2000);

console.log('[Sync] BeerPOS sync initialized');
