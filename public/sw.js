// BeerPOS Service Worker v33 — Version-safe, single-source-of-truth
// ─────────────────────────────────────────────────────
// Caching strategies:
//   • App Shell + JS/CSS        → Cache-First  (instant repeat load)
//   • API GET (normal)          → Stale-While-Revalidate (serve stale, refresh in bg)
//   • API GET (/data endpoints) → Stale-While-Revalidate (1h max-age)
//   • API mutations             → Queue offline → Background Sync
//   • Navigation                → Network-First (always fresh page)
//   • Auth requests             → No-cache (always live)
//
// Versioning (v33):
//   • DB + cache version: read from _meta store on disk — NEVER hardcode here
//   • Singleton DB — one connection, reused
//   • Batch sync — all queued items in ONE POST
//   • Exponential backoff with jitter
//   • SW message batching
//   • CLS Prevention: App Shell includes layout.js
// ─────────────────────────────────────────────────────

const DB_NAME     = 'BeerPOS';
const STORE_META  = '_meta';
const STORE_SYNC  = 'sync_queue';
const MAX_RETRIES = 6;
const MAX_CACHE   = 100; // entries — prevent unbounded cache growth

// ─── App Shell — must cache for instant PWA load ────────────────────────────
const APP_SHELL = [
  '/', '/index.html', '/manifest.json',
  '/icon-192.png', '/icon-512.png',
  '/css/tailwind.css', '/css/unified.css',
  '/js/layout.js', '/js/auth.js', '/js/dark-mode.js',
];

// ─── Cloud URL (set by main thread) ──────────────────────────────────────────

let _swCloudUrl = null;

self.addEventListener('message', event => {
  if (event.data?.type === 'SET_CLOUD_URL') {
    _swCloudUrl = event.data.url || null;
  }
  if (event.data?.type === 'REGISTER_VERSION') {
    // Main thread writes the version to _meta store — we just log it
    writeVersionToMeta(event.data.dbVersion);
  }
  // ── Real-time WebSocket invalidation ────────────────────────────────────
  if (event.data?.type === 'REALTIME_INVALIDATE') {
    // Wrapped in async IIFE because addEventListener handler is not async
    (async () => {
      const { paths = [], ts } = event.data;
      const cname = await getCacheName();
      const cache = await caches.open(cname);
      const keys = await cache.keys();
      await Promise.all(keys.map(async key => {
        const keyPath = new URL(key.url).pathname;
        if (paths.some(p => keyPath === p || keyPath.startsWith(p + '/') || keyPath.startsWith(p + '?'))) {
          await cache.delete(key);
        }
      }));
    })().catch(() => {});
  }
});

// ─── Write DB version to _meta store (called by main thread via postMessage) ─
async function writeVersionToMeta(version) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key: 'db_version', value: version });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    _DB_VERSION = parseInt(version, 10);
    _CACHE_NAME = `beer-pos-v${_DB_VERSION}`;
    console.log(`[SW] Registered DB version ${_DB_VERSION}, cache ${_CACHE_NAME}`);
  } catch {}
}

// ─── Singleton DB — opened once, reused by all functions ────────────────────
// Previously every function called openDB() separately, causing:
//   • ~10ms overhead per open (IndexedDB is async)
//   • DB version conflicts when multiple operations ran concurrently
//   • incrementRetryCount opened DB twice per call

let _dbPromise = null;
let _DB_VERSION = null;
let _CACHE_NAME = null;
const DEFAULT_DB_VERSION = 33;
const DEFAULT_CACHE_NAME = `beer-pos-v${DEFAULT_DB_VERSION}`;

// Resolve version from _meta store, then open at that exact version.
// This ensures we NEVER open at a version lower than what's on disk.
async function resolveVersion() {
  if (_DB_VERSION !== null) return _DB_VERSION;

  try {
    // Step 1: open without version to read current DB version
    const db1 = await new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME);
      r.onerror = () => rej(r.error);
      r.onsuccess = () => { r.result.close(); res(r.result); };
      r.onupgradeneeded = e => bootstrapMeta(e.target.result);
    });

    // Step 2: open at the discovered version
    const db2 = await new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, db1.version);
      r.onerror = () => rej(r.error);
      r.onsuccess = () => res(r.result);
      r.onupgradeneeded = e => bootstrapMeta(e.target.result);
    });

    // Step 3: read version from _meta
    const stored = await new Promise((res) => {
      const tx  = db2.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get('db_version');
      req.onsuccess = () => res(req.result?.value ?? db2.version);
      req.onerror   = () => res(db2.version);
    });

    _DB_VERSION = parseInt(stored, 10) || db2.version;
    if (!Number.isFinite(_DB_VERSION) || _DB_VERSION < DEFAULT_DB_VERSION) {
      _DB_VERSION = DEFAULT_DB_VERSION;
    }
    _CACHE_NAME = `beer-pos-v${_DB_VERSION}`;
    db2.close();
  } catch {
    // Keep cache namespace stable if version resolution fails
    _DB_VERSION = DEFAULT_DB_VERSION;
    _CACHE_NAME = DEFAULT_CACHE_NAME;
  }

  console.log(`[SW] DB version: ${_DB_VERSION}, cache: ${_CACHE_NAME}`);
  return _DB_VERSION;
}

function bootstrapMeta(db) {
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_SYNC)) {
    const store = db.createObjectStore(STORE_SYNC, {
      keyPath: 'id', autoIncrement: true
    });
    store.createIndex('synced',      'synced',      { unique: false });
    store.createIndex('created_at',  'created_at',  { unique: false });
    store.createIndex('dedup', 'dedup_key', { unique: false });
  }
}

function openDB() {
  if (_dbPromise) return _dbPromise;

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 100;

  function attemptOpen(resolve, reject, attempt) {
    const req = indexedDB.open(DB_NAME);
    req.onerror = () => {
      if (attempt < MAX_RETRIES) {
        setTimeout(() => attemptOpen(resolve, reject, attempt + 1), RETRY_DELAY);
      } else {
        reject(req.error);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => bootstrapMeta(e.target.result);
  }

  _dbPromise = new Promise((resolve, reject) => attemptOpen(resolve, reject, 0));
  return _dbPromise;
}

// ─── Performance: Precompiled entity regex — O(1) lookup instead of O(n) loop ──────

const ENTITY_RE = /\/(sales|customers|products|expenses|purchases|payments|kegs|devices)\b/;
const ENTITY_MAP = {
  sale: 'sale', customer: 'customer', product: 'product', expense: 'expense',
  purchase: 'purchase', payment: 'payment', keg: 'keg', device: 'device',
};

function getEntityFromPath(path) {
  const m = path.match(ENTITY_RE);
  return m ? (ENTITY_MAP[m[1]] || 'unknown') : 'unknown';
}

// Dedup key: same method + pathname + body hash
function getDedupKey(method, pathname, body) {
  let hash = 0;
  if (body) {
    for (let i = 0; i < body.length; i++) {
      hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0;
    }
  }
  return `${method}:${pathname}:${hash}`;
}

// ─── Cache size management — prevent unbounded growth ──────────────────────────

async function cachePut(request, response) {
  const cname = await getCacheName();
  const cache = await caches.open(cname);
  await cache.put(request, response.clone());
  // Evict oldest entries if over limit
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE) {
    const toDelete = keys.slice(0, keys.length - MAX_CACHE);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

async function getCacheName() {
  if (!_CACHE_NAME) await resolveVersion();
  return _CACHE_NAME;
}

// ─── Sync Queue ──────────────────────────────────────────────────────────────

async function queueForSync(method, url, body, headers) {
  try {
    const db     = await openDB();
    const tx     = db.transaction(STORE_SYNC, 'readwrite');
    const store  = tx.objectStore(STORE_SYNC);
    const apiPath = new URL(url).pathname;
    const entity  = getEntityFromPath(apiPath);
    const dedup   = getDedupKey(method, apiPath, body);

    const action = method === 'DELETE' ? 'delete'
                 : method === 'PUT'    ? 'update'
                 : 'create';

    let parsedBody = {};
    try { parsedBody = JSON.parse(body); } catch {}

    // DELETE /api/sales/:id — body thường rỗng; cần id để /api/sync/push hoàn kho đúng
    const saleDel = apiPath.match(/^\/api\/sales\/(\d+)$/);
    if (method === 'DELETE' && saleDel) {
      const sid = parseInt(saleDel[1], 10);
      if (Number.isFinite(sid)) parsedBody = { ...parsedBody, id: sid };
    }

    // Dedup: check if identical mutation already queued
    const existing = await new Promise(res => {
      const idx  = store.index('dedup');
      const req  = idx.get(dedup);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(null);
    });
    if (existing) return true; // skip re-queue

    await store.add({
      entity,
      action,
      dedup_key: dedup,
      data:      parsedBody,
      url:       apiPath,
      method,
      headers:   headers || {},
      synced:      0,
      created_at:  new Date().toISOString(),
      retry_count: 0
    });
    await tx.complete;

    notifyClients({ type: 'SYNC_QUEUED' });
    return true;
  } catch (err) {
    return false;
  }
}

// ─── Performance: Batch DB operations — one open, one transaction ─────────────

async function incrementRetryCount(id, currentCount) {
  if (currentCount >= MAX_RETRIES) {
    // Max retries reached — delete silently
    const db = await openDB();
    const tx = db.transaction(STORE_SYNC, 'readwrite');
    tx.objectStore(STORE_SYNC).delete(id);
    return;
  }

  const db    = await openDB();
  const tx    = db.transaction(STORE_SYNC, 'readwrite');
  const store = tx.objectStore(STORE_SYNC);

  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const r = req.result;
      if (r) { r.retry_count++; store.put(r); }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Performance: SW message batching — one postMessage per cycle ──────────────

let _pendingNotify = null;
let _notifyTimer = null;

function notifyClients(msg) {
  _pendingNotify = msg;
  if (_notifyTimer) return;
  _notifyTimer = setTimeout(() => {
    _notifyTimer = null;
    if (!_pendingNotify) return;
    const m = _pendingNotify;
    _pendingNotify = null;
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage(m));
    });
  }, 500);
}

// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  console.log('[SW] Installing, version=' + DEFAULT_CACHE_NAME);
  event.waitUntil(
    caches.open(DEFAULT_CACHE_NAME)
      .then(async cache => {
        const results = await Promise.allSettled(
          APP_SHELL.map(url =>
            fetch(url, { cache: 'reload' })
              .then(r => { if (r.ok) return cache.put(url, r); })
              .catch(() => {})
          )
        );
        const ok = results.filter(r => r.status === 'fulfilled').length;
        console.log('[SW] Install complete — cached ' + ok + '/' + APP_SHELL.length + ' app shell assets');
        self.skipWaiting(); // take control immediately
      })
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  console.log('[SW] Activating — cleaning old caches');
  event.waitUntil(
    resolveVersion().then(async () => {
      const cname = await getCacheName();
      const all   = await caches.keys();
      const stale = all.filter(k => k !== cname);
      if (stale.length > 0) {
        console.log('[SW] Deleting ' + stale.length + ' stale cache(s): ' + stale.join(', '));
      }
      await Promise.all(stale.map(k => caches.delete(k)));
      console.log('[SW] Activated — now controlling: ' + cname);
      self.clients.claim(); // take control of all clients immediately
    })
  );
});

// ─── Background Sync ──────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'sync-queue' || event.tag === 'sync-all') {
    event.waitUntil(processSyncQueue());
  }
});

// ─── Batch sync — ONE POST request for all queued items ─────────────────────

async function processSyncQueue() {
  let db;
  try {
    db   = await openDB();
    const tx    = db.transaction(STORE_SYNC, 'readonly');
    const index = tx.objectStore(STORE_SYNC).index('synced');
    const all   = await new Promise((res, rej) => {
      const r = index.getAll(IDBKeyRange.only(0));
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });

    if (!all?.length) return;

    // Exponential backoff with jitter: 500ms * 2^retry + random(0-500ms)
    for (const item of all) {
      if (item.retry_count > 0) {
        const base  = Math.min((1 << item.retry_count) * 500, 30000);
        const jitter = Math.random() * 500;
        await new Promise(r => setTimeout(r, base + jitter));
      }
    }

    const base = _swCloudUrl || self.registration.scope;

    // Batch all changes in ONE request
    const changes = all.map(item => ({
      entity:            item.entity,
      entity_id:         item.data?.id || null,
      action:            item.action,
      data:              item.data,
      client_updated_at: item.created_at
    }));

    const full = base.replace(/\/$/, '') + '/api/sync/push';
    const resp = await fetch(full, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes, deviceId: getDeviceIdFromScope(base) })
    }).catch(() => null);

    // Clear entire queue
    const dtx  = db.transaction(STORE_SYNC, 'readwrite');
    const didx = dtx.objectStore(STORE_SYNC).index('synced');
    const cur  = didx.openCursor(IDBKeyRange.only(0));
    cur.onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };

    if (resp?.ok) {
      notifyClients({ type: 'SYNC_COMPLETE' });
    } else {
      if (resp) {
        try {
          const data = await resp.clone().json();
          if (data?.failed?.length) {
            for (const fid of data.failed) {
              const item = all.find(i => i.id === fid);
              if (item) await incrementRetryCount(fid, (item.retry_count || 0) + 1);
            }
          } else {
            for (const item of all) {
              await incrementRetryCount(item.id, (item.retry_count || 0) + 1);
            }
          }
        } catch {
          for (const item of all) {
            await incrementRetryCount(item.id, (item.retry_count || 0) + 1);
          }
        }
      }
      notifyClients({ type: 'SYNC_COMPLETE' });
    }
  } catch {
    notifyClients({ type: 'SYNC_COMPLETE' });
  }
}

function getDeviceIdFromScope(scope) {
  return scope || 'unknown';
}

// ─── Fetch Handler ───────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = event.request.url;

  const parsed = new URL(url);

  // ── CRITICAL: Never cache realtime-related files ────────────────────────────
  // Socket.IO protocol files and realtime client MUST always be fresh.
  // Caching stale versions causes connection failures and duplicate events.
  if (parsed.pathname.startsWith('/socket.io/') ||
      parsed.pathname === '/js/realtime.js' ||
      parsed.pathname === '/js/socketSingleton.js' ||
      parsed.pathname === '/db.js') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // Auth/login — always live, never cache
  if (parsed.pathname.startsWith('/api/auth') || parsed.pathname.startsWith('/auth')) {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // Sale history — always fresh from server
  if (parsed.pathname === '/sale/history') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // Navigation — Network-First (always fresh page)
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // API Mutations (POST/PUT/DELETE) → queue offline
  if (parsed.pathname.startsWith('/api/') && event.request.method !== 'GET') {
    event.respondWith(handleMutation(event.request));
    return;
  }

  // Sale create/update — same offline queue logic as API mutations
  if ((parsed.pathname === '/sale/create' || parsed.pathname.startsWith('/sale/update/'))
      && event.request.method !== 'GET') {
    event.respondWith(handleMutation(event.request));
    return;
  }

  // ── CRITICAL: Disable API caching — always fresh data from server ─────────────────
  // API GET requests must always come from network to ensure data consistency.
  // Stale data causes stock mismatch, price errors, and data race conditions.
  if (parsed.pathname.startsWith('/api/') && event.request.method === 'GET') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // Page data endpoints (/sale/data, /purchases/data, etc.) — never cache
  if (parsed.pathname.endsWith('/data') && event.request.method === 'GET') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // Sale individual record — always fresh from server (used by invoice modal)
  if (parsed.pathname.match(/^\/sale\/\d+$/) && event.request.method === 'GET') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }

  // App Shell & static assets → Cache-First
  event.respondWith(cacheFirst(event.request));
});

// ─── Fetch Strategies ───────────────────────────────────────────────────────

/** Cache-First — best for static assets */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp.ok) await cachePut(request, resp);
    return resp;
  } catch {
    return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

/** Network-First — best for navigation */
async function networkFirst(request) {
  try {
    const req = request.mode === 'navigate'
      ? request
      : new Request(request, { cache: 'no-store' });
    const resp = await fetch(req);
    if (resp.ok) await cachePut(request, resp);
    if (self.__CONSISTENCY_DEBUG__) {
      console.log('[CONSISTENCY][SW] networkFirst network', request.url);
    }
    return resp;
  } catch {
    const cached = await caches.match(request);
    if (self.__CONSISTENCY_DEBUG__) {
      console.log('[CONSISTENCY][SW] networkFirst fallback-cache', request.url, !!cached);
    }
    return cached || new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

/** Stale-While-Revalidate — serve cached immediately, refresh in background */
async function staleWhileRevalidate(request, opts = {}) {
  const maxAge   = opts.maxAge ?? 300;
  const cname    = await getCacheName();
  const cache    = await caches.open(cname);
  const cached   = await cache.match(request);

  const networkRequest = new Request(request, { cache: 'no-store' });

  // Fire background refresh immediately
  const bgFetch = fetch(networkRequest).then(async resp => {
    if (!resp || resp.status !== 200) return null;
    const headers = new Headers(resp.headers);
    headers.set('sw-time', String(Date.now()));
    const clone = new Response(await resp.clone().text(), {
      status: resp.status, statusText: resp.statusText, headers
    });
    await cache.put(request, clone);
    if (self.__CONSISTENCY_DEBUG__) {
      console.log('[CONSISTENCY][SW] staleWhileRevalidate refreshed', request.url);
    }
    return resp;
  }).catch(() => null);

  if (cached) {
    const swTime = parseInt(cached.headers.get('sw-time') || '0', 10);
    const age    = (Date.now() - swTime) / 1000;
    if (self.__CONSISTENCY_DEBUG__) {
      console.log('[CONSISTENCY][SW] staleWhileRevalidate cache-hit', request.url, { age: age, maxAge: maxAge });
    }
    if (age < maxAge) return cached;

    const fresh = await Promise.race([
      bgFetch,
      new Promise(resolve => setTimeout(() => resolve(null), 3000))
    ]);
    return fresh || cached;
  }

  if (self.__CONSISTENCY_DEBUG__) {
    console.log('[CONSISTENCY][SW] staleWhileRevalidate cache-miss', request.url);
  }

  // No cache hit — block on network
  const resp = await bgFetch;
  if (resp) return resp;
  return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
    status: 503, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Mutation Handler ────────────────────────────────────────────────────────

async function invalidateRelatedCaches(url) {
  const pathname = new URL(url).pathname;
  const entity = getEntityFromPath(pathname);
  const cname = await getCacheName();
  const cache = await caches.open(cname);
  const keys = await cache.keys();
  const patterns = [
    pathname,
    '/dashboard/data',
    '/report/data'
  ];

  if (entity === 'sale') patterns.push('/api/sales', '/api/customers', '/api/products', '/api/kegs');
  if (entity === 'expense') patterns.push('/api/expenses');
  if (entity === 'product') patterns.push('/api/products', '/api/stock', '/api/sales');
  if (entity === 'customer') patterns.push('/api/customers', '/api/sales');
  if (entity === 'purchase') patterns.push('/api/purchases', '/api/products', '/api/stock');

  await Promise.all(keys.map(async key => {
    const keyPath = new URL(key.url).pathname;
    if (patterns.some(pattern => keyPath === pattern || keyPath.startsWith(pattern + '?') || keyPath.startsWith(pattern + '/'))) {
      await cache.delete(key);
      if (self.__CONSISTENCY_DEBUG__) {
        console.log('[CONSISTENCY][SW] invalidated', key.url, 'after', pathname);
      }
    }
  }));
}

async function handleMutation(request) {
  try {
    const response = await fetch(new Request(request, { cache: 'no-store' }));
    if (response && response.ok) {
      await invalidateRelatedCaches(request.url);
      notifyClients({ type: 'DATA_INVALIDATED', path: new URL(request.url).pathname, at: Date.now() });
    }
    return response;
  } catch {
    const method  = request.method;
    const url     = request.url;
    let body      = '';
    const headers = {};
    try {
      const cl = request.clone();
      body = await cl.text();
      request.headers.forEach((v, k) => { headers[k] = v; });
    } catch {}

    await queueForSync(method, url, body, headers);

    if ('serviceWorker' in self && 'sync' in self.registration) {
      self.registration.sync.register('sync-queue').catch(() => {});
    }

    return new Response(JSON.stringify({
      error:  'Offline — đã lưu vào hàng đợi, sẽ đồng bộ khi có mạng',
      queued: true,
      url:    new URL(url).pathname,
      method
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
}
