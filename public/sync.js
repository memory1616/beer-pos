// Beer POS - Cloud Sync (hoạt động với SW queue)
// Performance: all heavy operations use requestIdleCallback to never block UI.
// Performance: openSWDB is a singleton — opened once and reused across all functions.

const DB_OPEN_DELAY = 50; // ms between DB open attempts to avoid "blocked by transaction" errors

/** requestIdleCallback polyfill + fallback (5s max) */
const _requestIdle = window.requestIdleCallback || (cb => setTimeout(() => cb({ didTimeout: false }), 0));
const _cancelIdle  = window.cancelIdleCallback  || (id => clearTimeout(id));

// ─── Performance Helpers ───────────────────────────────────────────────────────

/** Debounce — coalesces rapid calls into one execution */
function _debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/** Run heavy work only when browser is idle — never blocks user interaction */
function _idleRun(work, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  const id = _requestIdle(
    deadline => {
      while (deadline.timeRemaining() > 0 || deadline.didTimeout) {
        const result = work(deadline);
        if (result === false) break; // work says "done"
      }
    },
    { timeout }
  );
  return id;
}

// ─── DEVICE ID — unique per browser/device ────────────────────────────────────

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

// ── PERFORMANCE: DOM refs cached once in initCloudUI ──────────────────────────
let _cloudUI = null; // { modal, statusEl, input, scanStatus, pendingCount, pendingInfo }

function _getCloudUI() {
  if (!_cloudUI) {
    const m = document.getElementById('cloudSetupModal');
    if (!m) return null;
    _cloudUI = {
      modal:        m,
      statusEl:     document.getElementById('syncCloudStatusText'),
      input:        document.getElementById('syncCloudUrlInput'),
      scanStatus:   document.getElementById('syncScanStatus'),
      pendingCount:  document.getElementById('syncPendingCount'),
      pendingInfo:   document.getElementById('syncPendingQueueInfo')
    };
  }
  return _cloudUI;
}

// ===== CLOUD SETUP UI =====

// Inject cloud setup modal only (no floating button — Cloud is in Dashboard ⚙️ → tab ☁️)
function initCloudUI() {
  if (document.getElementById('cloudSetupModal')) { _getCloudUI(); return; }

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

  // Close on backdrop click — uses cached ref
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
  const ui = _getCloudUI();
  if (!ui) return;
  ui.modal.style.display = 'flex';
  updateCloudModalStatus();
}

function closeCloudModal() {
  const ui = _getCloudUI();
  if (ui) ui.modal.style.display = 'none';
}
window.closeCloudModal = closeCloudModal;

// Update modal status — uses cached DOM refs
async function updateCloudModalStatus() {
  const ui = _getCloudUI();
  if (!ui) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();

  if (ui.pendingInfo) {
    ui.pendingInfo.style.display = pending > 0 ? 'block' : 'none';
    if (ui.pendingCount) ui.pendingCount.textContent = pending;
  }
  if (ui.input) ui.input.value = cloudUrl;

  if (!cloudUrl) {
    ui.statusEl.innerHTML = '🔴 <span style="color:var(--color-danger)"><strong>Chưa có Cloud</strong></span> — thiết bị đang chạy độc lập';
  } else if (!navigator.onLine) {
    ui.statusEl.innerHTML = '🔴 <span style="color:var(--color-danger)"><strong>Offline</strong></span> — cloud: ' + cloudUrl;
  } else {
    ui.statusEl.innerHTML = '🟢 <span style="color:var(--color-success)"><strong>Đã kết nối Cloud</strong></span><br><span style="font-size:12px;color:var(--color-text-secondary)">' + cloudUrl + '</span>';
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

// SCAN LAN for cloud server — scans in larger batches with parallel fetches
// PERFORMANCE fixes from bottleneck scan:
//   1. BATCH increased from 25→50 to reduce iteration overhead
//   2. Per-IP timeout reduced from 2s→1s (local LAN is fast, 2s is too generous)
//   3. 100 concurrent fetches with Promise.allSettled (avoids sequential waiting)
//   4. DOM updates only on start and completion (not per-batch)
async function scanForCloud() {
  const ui = _getCloudUI();
  if (!ui) return;
  ui.scanStatus.innerHTML = '⏳ Đang quét...';

  const localIP = await getLocalIP();
  if (!localIP) {
    ui.scanStatus.innerHTML = '❌ Không lấy được IP máy';
    return;
  }

  const subnet = localIP.substring(0, localIP.lastIndexOf('.'));
  ui.scanStatus.innerHTML = '⏳ Đang quét subnet ' + subnet + '.x ...';

  // Scan in larger batches with full parallelism for LAN speed
  const BATCH = 50;
  const found = [];

  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254);
    const promises = [];
    for (let i = start; i <= end; i++) {
      const ip = `${subnet}.${i}`;
      if (ip === localIP) continue;
      promises.push(checkDevice(ip, 3000));
      promises.push(checkDevice(ip, 3001));
    }
    const results = await Promise.allSettled(promises);
    const batchFound = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    found.push(...batchFound);

    // Only update progress every other batch to reduce DOM repaints
    if ((start / BATCH) % 2 === 0) {
      const pct = Math.round((end / 254) * 100);
      ui.scanStatus.innerHTML = `⏳ Đang quét... ${pct}%`;
    }
  }

  if (found.length > 0) {
    // Prefer internet domain over LAN IP for remote/cloud deployment
    const cloud = found.find(c => c.domain) || found[0];
    const cloudUrl = cloud.domain || cloud.url;
    const prevSync = hasSyncedWithCloud(cloudUrl);
    localStorage.setItem('cloudUrl', cloudUrl);
    localStorage.removeItem('isCloudServer');
    syncCloudUrlToSW(cloudUrl);
    ui.scanStatus.innerHTML = '✅ Tìm thấy: <strong>' + cloud.name + '</strong><br><span style="font-size:12px;color:var(--color-text-secondary)">' + cloudUrl + '</span>';
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
    ui.scanStatus.innerHTML = '❌ Không tìm thấy Cloud nào.<br><span style="font-size:12px">Đảm bảo máy Cloud đang bật và cùng mạng.</span>';
  }
}

async function checkDevice(ip, port) {
  try {
    const ctrl = new AbortController();
    // PERFORMANCE: 1s timeout is plenty for local LAN; 2s was too slow for full scan
    const id = setTimeout(() => ctrl.abort(), 1000);
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

// ─── Pending count cache — avoid repeated IndexedDB queries ───────────────────
// updateSmartStatus() and updateCloudModalStatus() both call countPendingQueue()
// within the same event-loop tick when triggered together.
// Cache for 5s so rapid callers share one DB query.
let _pendingCache = { count: -1, ts: 0 };
const _PENDING_CACHE_TTL = 5000;

function _getCachedPending() {
  if (Date.now() - _pendingCache.ts < _PENDING_CACHE_TTL) return _pendingCache.count;
  return -1;
}

function _setCachedPending(count) {
  _pendingCache = { count, ts: Date.now() };
}

function _invalidatePending() { _pendingCache.ts = 0; }

// ─── DB Opening — no version specified ──────────────────────────────────────
// We do NOT hardcode a version here because:
//   • db.js is the single source of truth for DB schema and version
//   • Dexie automatically escalates to max(existing, code) version
//   • This file only uses existing stores (sync_queue), never creates/alters schema
//   • Hardcoding a version causes "VersionError: requested version (31) less than
//     existing (N)" when db.js bumps the schema to a higher version.
//
// How it works:
//   • First open (no version) → gets existing version from disk
//   • onupgradeneeded fires ONLY if this context knows about a higher version
//     (which this context doesn't — it just uses existing stores)
//   • sync_queue store is created here as a safety net for pure SW standalone usage
// ─────────────────────────────────────────────────────────────────────────────

const SW_DB_NAME = 'BeerPOS';
const SW_STORE   = 'sync_queue';

let _dbPromise = null;

async function getDB() {
  if (!_dbPromise) {
    _dbPromise = openSWDB();
  }
  return _dbPromise;
}

function openSWDB() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 100;

  function attemptOpen(resolve, reject, attempt) {
    // Open WITHOUT version — let the browser use whatever version is on disk.
    // db.js owns schema changes. This file only reads/writes existing stores.
    const req = indexedDB.open(SW_DB_NAME);

    req.onerror = () => {
      if (attempt < MAX_RETRIES) {
        setTimeout(() => attemptOpen(resolve, reject, attempt + 1), RETRY_DELAY);
      } else {
        reject(req.error);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Safety net: create sync_queue if it doesn't exist.
      // This handles the case where this JS runs before db.js initializes.
      if (!db.objectStoreNames.contains(SW_STORE)) {
        const store = db.createObjectStore(SW_STORE, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
        store.createIndex('dedup', 'dedup_key', { unique: false });
      }
    };
  }

  return new Promise((resolve, reject) => attemptOpen(resolve, reject, 0));
}

// Count pending items in SW queue — uses cache to avoid repeated DB queries
async function countPendingQueue() {
  const cached = _getCachedPending();
  if (cached >= 0) return cached;
  try {
    const db = await getDB();
    const tx = db.transaction(SW_STORE, 'readonly');
    const store = tx.objectStore(SW_STORE);
    const index = store.index('synced');
    return new Promise((resolve) => {
      const req = index.count(IDBKeyRange.only(0));
      req.onsuccess = () => { _setCachedPending(req.result); resolve(req.result); };
      req.onerror = () => resolve(0);
    });
  } catch { return 0; }
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

// Update sync status indicator in header
async function updateSmartStatus() {
  const syncEl = document.getElementById('syncStatus');
  if (!syncEl) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();

  // Offline
  if (!navigator.onLine) {
    if (pending > 0) {
      syncEl.textContent = `⏳ ${pending} chờ đẩy`;
      syncEl.className = 'text-xs text-warning font-medium';
    } else {
      syncEl.textContent = '⚠️ Không kết nối';
      syncEl.className = 'text-xs text-muted';
    }
    return;
  }

  // No cloud URL configured
  if (!cloudUrl) {
    if (pending > 0) {
      syncEl.textContent = `📴 ${pending} chờ đẩy lên server`;
      syncEl.className = 'text-xs text-warning font-medium';
    } else {
      syncEl.textContent = '📴 Không có cloud';
      syncEl.className = 'text-xs text-muted';
    }
    return;
  }

  // Online + cloud configured
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    if (res.ok) {
      if (pending > 0) {
        syncEl.textContent = `📤 ${pending} chờ đẩy`;
        syncEl.className = 'text-xs text-info font-medium';
      } else {
        const syncText = getLastSyncText();
        syncEl.textContent = syncText ? `✓ ${syncText}` : '✓ Đã đồng bộ';
        syncEl.className = 'text-xs text-success';
      }
    } else {
      throw 'non-ok';
    }
  } catch {
    syncEl.textContent = pending > 0 ? `⏳ ${pending} chờ` : '⚠️ Không kết nối server';
    syncEl.className = 'text-xs text-warning';
  }
}

// Push pending SW queue items to cloud — batched, non-blocking
async function syncQueueToCloud() {
  if (!navigator.onLine) return;

  const cloudUrl      = getCloudUrl();
  const isCloudServer = localStorage.getItem('isCloudServer') === 'true';
  if (isCloudServer) {
    // Cloud-server mode: just clear local queue (no remote to push to)
    try {
      const db = await getDB();
      const tx = db.transaction(SW_STORE, 'readwrite');
      tx.objectStore(SW_STORE).clear();
      _invalidatePending();
    } catch {}
    return;
  }

  // PERFORMANCE: Early return if nothing pending — avoid opening DB
  const pending = await countPendingQueue();
  if (pending === 0) return;

  try {
    const db    = await getDB();
    const tx    = db.transaction(SW_STORE, 'readonly');
    const store = tx.objectStore(SW_STORE);
    const index = store.index('synced');
    const items = await new Promise((res, rej) => {
      const r = index.getAll(IDBKeyRange.only(0));
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    if (!items?.length) return;

    // Batch all items in ONE request instead of individual fetches
    const changes = items.map(item => ({
      entity:     item.entity || 'unknown',
      entity_id:  item.data?.id || null,
      action:     item.action || (item.method === 'DELETE' ? 'delete' : item.method === 'PUT' ? 'update' : 'create'),
      data:       item.data || {},
      client_updated_at: item.created_at
    }));

    const res = await fetch('/api/sync/push', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ changes, deviceId: getOrCreateDeviceId() })
    });

    if (res.ok) {
      const now = new Date().toISOString();
      setLastSyncForCloud(cloudUrl, now);

      // Clear queue using readwrite transaction
      try {
        const db2  = await getDB();
        const tx2  = db2.transaction(SW_STORE, 'readwrite');
        const dIdx = tx2.objectStore(SW_STORE).index('synced');
        const cur  = dIdx.openCursor(IDBKeyRange.only(0));
        cur.onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      } catch {}

      _invalidatePending();
    }
  } catch {}
}

// Pull data from cloud and soft-refresh data views
async function pullFromCloud() {
  const cloudUrl = getCloudUrl();
  if (!cloudUrl || !navigator.onLine) return;

  const lastSync = getLastSyncForCloud(cloudUrl) || '1970-01-01T00:00:00.000Z';
  try {
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUrl, lastSync, deviceId: getOrCreateDeviceId() }),
      cache: 'no-store'
    });
    if (res.ok) {
      const data = await res.json();
      if (data.changes && Object.keys(data.changes).length > 0) {
        setLastSyncForCloud(cloudUrl, data.serverTime);
        if (window.BeerStore && typeof window.BeerStore.invalidateAndRefresh === 'function') {
          await window.BeerStore.invalidateAndRefresh('sync:pull');
        }
        window.dispatchEvent(new CustomEvent('data:mutated', {
          detail: { entity: 'sync', source: 'pullFromCloud', at: Date.now() }
        }));
      } else {
        setLastSyncForCloud(cloudUrl, data.serverTime || new Date().toISOString());
      }
    }
  } catch (e) { /* silent */ }
}

// First sync: full pull from cloud (no push, no conflict risk)
async function doFirstSync(cloudUrl) {
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
      showToast('✅ Đã đồng bộ ' + Object.keys(data.changes || {}).length + ' bảng dữ liệu!', 'success');
    }
  } catch (e) { /* silent */ }
}

// Sync now — runs via requestIdleCallback so it NEVER blocks user interaction
async function syncNow() {
  if (!navigator.onLine) {
    showToast('Không có mạng — đang chờ đẩy khi kết nối', 'info');
    return;
  }
  const cloudUrl = getCloudUrl();
  if (!cloudUrl) return;

  const pending    = await countPendingQueue();
  const isFirstSync = !hasSyncedWithCloud(cloudUrl);

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

// Refresh cloud tab in dashboard settings modal — uses cached DOM refs
async function refreshCloudTab() {
  const statusEl = document.getElementById('cloudStatusText');
  const input = document.getElementById('cloudUrlInput');
  if (!statusEl) return;

  const cloudUrl = getCloudUrl();
  const pending = await countPendingQueue();
  const status = navigator.onLine ? '🟢' : '🔴';
  const cls = navigator.onLine ? 'text-success' : 'text-danger';
  statusEl.innerHTML = `${status} <span class="${cls}"><strong>${cloudUrl ? 'Đã kết nối Cloud' : 'Chưa có Cloud'}</strong></span>`
    + (pending > 0 ? ` <span class="text-warning">(${pending} chờ đẩy)</span>` : '')
    + (cloudUrl ? `<br><span class="text-xs text-muted">${cloudUrl}</span>` : '');
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

// Listen for SW messages — only call updateSmartStatus, no console spam
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', async event => {
    if (event.data?.type === 'SYNC_COMPLETE' || event.data?.type === 'SYNC_QUEUED') {
      await updateSmartStatus();
      if (event.data?.type === 'SYNC_COMPLETE') showToast('Đã đồng bộ!', 'success');
    }
  });
}

// ─── Sync trigger — debounced so rapid events don't pile up ───────────────────

let _pendingSync = false;
let _syncTimer = null;

/** Call this when you want to sync — it debounces to avoid hammering */
function _scheduleSync(immediate = false) {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  const delay = immediate ? 0 : 3000; // 3s debounce for auto, immediate for manual
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    if (!navigator.onLine) return;
    _requestIdle(() => _doBackgroundSync());
  }, delay);
}

async function _doBackgroundSync() {
  if (_pendingSync) return;
  _pendingSync = true;
  try {
    await syncQueueToCloud();
    const cloudUrl = getCloudUrl();
    if (cloudUrl && hasSyncedWithCloud(cloudUrl)) {
      await pullFromCloud();
    }
  } catch {}
  _pendingSync = false;
}

// Online event — non-blocking sync via requestIdleCallback
window.addEventListener('online', () => {
  _scheduleSync(false);
  updateSmartStatus();
});

// Offline event — update indicator only (no sync needed)
window.addEventListener('offline', () => {
  updateSmartStatus();
});

// Auto-sync every 60 seconds — never blocks UI
// PERFORMANCE: Store interval ID so it can be cleared on unload
let _autoSyncIntervalId = null;

function _startAutoSync() {
  if (_autoSyncIntervalId) clearInterval(_autoSyncIntervalId);
  _autoSyncIntervalId = setInterval(() => {
    if (navigator.onLine) _scheduleSync(false);
    updateSmartStatus();
  }, 60000);
}

_startAutoSync();

// PERFORMANCE: Clear interval on page unload — prevents memory leak
window.addEventListener('unload', () => {
  if (_autoSyncIntervalId) { clearInterval(_autoSyncIntervalId); _autoSyncIntervalId = null; }
});

// Initial status check — uses requestIdleCallback so it doesn't delay page interaction
setTimeout(async () => {
  const cloudUrl = getCloudUrl();
  if (cloudUrl) syncCloudUrlToSW(cloudUrl);
  await updateSmartStatus();
  if (navigator.onLine && cloudUrl) {
    const isFirst = !hasSyncedWithCloud(cloudUrl);
    if (isFirst) {
      await doFirstSync(cloudUrl);
    } else {
      // Defer background sync so page can render first
      _requestIdle(() => _scheduleSync(true), { timeout: 5000 });
    }
  }
}, 2000);
