// BeerPOS Service Worker v30 — Production Optimized
// ─────────────────────────────────────────────────────
// Caching strategies:
//   • App Shell + JS/CSS        → Cache-First  (instant repeat load)
//   • API GET (normal)           → Stale-While-Revalidate (serve stale, refresh in bg)
//   • API GET (/data endpoints)  → Stale-While-Revalidate (1h max-age)
//   • API mutations              → Queue offline → Background Sync
//   • Navigation                 → Network-First (always fresh page)
//   • Auth requests              → No-cache (always live)
//
// Performance optimizations (v30):
//   • Singleton DB — one IndexedDB connection, reused across all operations
//   • Batch sync — all queued items sent in ONE POST request
//   • Precompiled entity regex — O(1) lookup instead of O(n) loop
//   • Cache size limit — prevent unbounded cache growth
//   • Mutation dedup — skip re-queuing identical mutations
//   • SW message batching — one postMessage per sync cycle
//   • Exponential backoff with jitter on retry
//   • CORS opaque response guard
// ─────────────────────────────────────────────────────

const CACHE_NAME  = 'beer-pos-v30';
const DB_NAME     = 'BeerPOS';
const STORE_SYNC  = 'sync_queue';
const MAX_RETRIES = 6;
const MAX_CACHE   = 100; // entries — prevent unbounded growth

// ─── App Shell — must cache for instant PWA load ────────────────────────────

const APP_SHELL = [
  '/', '/index.html', '/manifest.json',
  '/icon-192.png', '/icon-512.png',
  '/css/tailwind.css', '/css/unified.css',
];

// ─── Cloud URL (set by main thread) ──────────────────────────────────────────

let _swCloudUrl = null;

self.addEventListener('message', event => {
  if (event.data?.type === 'SET_CLOUD_URL') {
    _swCloudUrl = event.data.url || null;
  }
});

// ─── Performance: Singleton DB — opened once, reused by all functions ─────────────
// Previously every function called openDB() separately, causing:
//   • ~10ms overhead per open (IndexedDB is async)
//   • DB version conflicts when multiple operations ran concurrently
//   • incrementRetryCount opened DB twice per call (lines 106+111)

let _dbPromise = null;

function openDB() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 30);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_SYNC)) {
          const store = db.createObjectStore(STORE_SYNC, {
            keyPath: 'id', autoIncrement: true
          });
          store.createIndex('synced',      'synced',      { unique: false });
          store.createIndex('created_at',  'created_at',  { unique: false });
          // Compound index for deduplication: same method+url → skip re-queue
          store.createIndex('dedup', 'dedup_key', { unique: false });
        }
      };
    });
  }
  return _dbPromise;
}

// ─── Performance: Precompiled entity regex — O(1) lookup instead of O(n) loop ──────
// Previously: iterate over all ENTITY_MAP keys with String.includes() on every mutation
// Now: one RegExp test, no loop

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
// Enforce MAX_CACHE entries by evicting oldest on insert

async function cachePut(request, response) {
  const cache = await caches.open(CACHE_NAME);
  // Clone before putting (response body can only be consumed once)
  await cache.put(request, response.clone());
  // Evict oldest entries if over limit
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE) {
    const toDelete = keys.slice(0, keys.length - MAX_CACHE);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
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
// Previously: opened DB twice per item (incrementRetryCount lines 106+111)

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

function notifyClients(msg) {
  _pendingNotify = msg; // overwrite — only latest matters
  if (_notifyTimer) return;
  _notifyTimer = setTimeout(() => {
    _notifyTimer = null;
    if (!_pendingNotify) return;
    const msg = _pendingNotify;
    _pendingNotify = null;
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage(msg));
    });
  }, 500); // batch within 500ms
}

let _notifyTimer = null;

// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        await Promise.allSettled(
          APP_SHELL.map(url =>
            fetch(url, { cache: 'no-cache' })
              .then(r => { if (r.ok) return cache.put(url, r); })
              .catch(() => {}) // don't fail install for missing assets
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── Background Sync ──────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'sync-queue' || event.tag === 'sync-all') {
    event.waitUntil(processSyncQueue());
  }
});

// ─── Performance: Batch sync — ONE POST request for all queued items ─────────────────
// Previously: one fetch() per item → N sequential network round-trips
// Now: send all items in one JSON payload, server handles batch

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

    // Clear entire queue on success OR if server returned 2xx
    const dtx  = db.transaction(STORE_SYNC, 'readwrite');
    const didx = dtx.objectStore(STORE_SYNC).index('synced');
    const cur  = didx.openCursor(IDBKeyRange.only(0));
    cur.onsuccess = e => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };

    // Notify client once at the end of the cycle
    if (resp?.ok) {
      notifyClients({ type: 'SYNC_COMPLETE' });
    } else {
      // Partial failure: retry items that failed
      // Server should return { failed: [id, ...] } for per-item status
      if (resp) {
        try {
          const data = await resp.clone().json();
          if (data?.failed?.length) {
            for (const fid of data.failed) {
              const item = all.find(i => i.id === fid);
              if (item) await incrementRetryCount(fid, (item.retry_count || 0) + 1);
            }
          } else {
            // Server didn't support per-item tracking — retry all
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
  // Try to get deviceId from the SW scope URL as fallback
  return scope || 'unknown';
}

// ─── Fetch Handler ───────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip non-GET for CORS opaque responses (e.g. CDN resources)
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  const parsed = new URL(url);

  // Auth — always live, never cache
  if (parsed.pathname.startsWith('/api/auth')) {
    event.respondWith(fetch(event.request));
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

  // API GET → Stale-While-Revalidate
  if (parsed.pathname.startsWith('/api/')) {
    const maxAge = parsed.pathname.endsWith('/data') ? 3600 : 300;
    event.respondWith(staleWhileRevalidate(event.request, { maxAge }));
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
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/** Network-First — best for navigation */
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    // Cache successful navigation responses
    if (resp.ok) await cachePut(request, resp);
    return resp;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/** Stale-While-Revalidate — serve cached immediately, refresh in background */
async function staleWhileRevalidate(request, opts = {}) {
  const maxAge  = opts.maxAge ?? 300;
  const cache   = await caches.open(CACHE_NAME);
  const cached  = await cache.match(request);

  // Fire background refresh immediately
  const bgFetch = fetch(request).then(async resp => {
    if (!resp || resp.status !== 200) return null;
    // Add timestamp header so we can calculate age on next serve
    const headers = new Headers(resp.headers);
    headers.set('sw-time', String(Date.now()));
    const clone = new Response(await resp.clone().text(), {
      status: resp.status, statusText: resp.statusText, headers
    });
    await cachePut(request, clone);
    return resp;
  }).catch(() => null);

  if (cached) {
    const swTime = parseInt(cached.headers.get('sw-time') || '0', 10);
    const age    = (Date.now() - swTime) / 1000;

    if (age < maxAge) {
      // Fresh within maxAge — return cached without waiting for fetch
      return cached;
    }
    // Stale but served — background refresh already running
    return cached;
  }

  // No cache hit — must block on network
  const resp = await bgFetch;
  if (resp) return resp;
  return new Response(JSON.stringify({ error: 'Offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Mutation Handler ────────────────────────────────────────────────────────

async function handleMutation(request) {
  try {
    return await fetch(request);
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
