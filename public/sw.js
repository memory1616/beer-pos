// BeerPOS Service Worker v29 — Performance Optimized
// ─────────────────────────────────────────────────────
// Strategies:
//   • App Shell + JS/CSS  → Cache-First  (instant load after 1st visit)
//   • API GET             → Stale-While-Revalidate  (fast + fresh)
//   • API mutations        → Queue offline → Background Sync
//   • Navigation          → Network-First (always fresh)
// ─────────────────────────────────────────────────────
const CACHE_NAME = 'beer-pos-v29';
const DB_NAME    = 'BeerPOS';
const STORE_SYNC = 'sync_queue';

// App Shell — must cache for instant PWA load
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/css/tailwind.css',
  '/css/unified.css',
];

// Cloud URL set by main thread
let _swCloudUrl = null;

self.addEventListener('message', event => {
  if (event.data?.type === 'SET_CLOUD_URL') {
    _swCloudUrl = event.data.url || null;
  }
});

// ─── IndexedDB ───────────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SYNC)) {
        const store = db.createObjectStore(STORE_SYNC, { keyPath: 'id', autoIncrement: true });
        store.createIndex('synced',     'synced',     { unique: false });
        store.createIndex('created_at',  'created_at', { unique: false });
      }
    };
  });
}

// ─── Sync Queue ──────────────────────────────────────────────────────────────

const ENTITY_MAP = {
  '/sales':    'sale',
  '/customers':'customer',
  '/products': 'product',
  '/expenses': 'expense',
  '/purchases':'purchase',
  '/payments': 'payment',
  '/kegs':     'keg',
  '/devices':  'device',
};

async function queueForSync(method, url, body, headers) {
  try {
    const db   = await openDB();
    const tx   = db.transaction(STORE_SYNC, 'readwrite');
    const store = tx.objectStore(STORE_SYNC);
    const apiPath = new URL(url).pathname;

    let entity = 'unknown';
    for (const [key, val] of Object.entries(ENTITY_MAP)) {
      if (apiPath.includes(key)) { entity = val; break; }
    }
    const action = method === 'DELETE' ? 'delete'
                 : method === 'PUT'    ? 'update'
                 : 'create';

    let parsedBody = {};
    try { parsedBody = JSON.parse(body); } catch {}

    await store.add({
      entity, action,
      data:    parsedBody,
      url:     apiPath,
      method,
      headers: headers || {},
      synced:      0,
      created_at:  new Date().toISOString(),
      retry_count: 0
    });
    await tx.complete;

    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SYNC_QUEUED' }));
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function incrementRetryCount(id, currentCount) {
  const MAX = 6;
  if (currentCount >= MAX) {
    const db = await openDB();
    const tx = db.transaction(STORE_SYNC, 'readwrite');
    tx.objectStore(STORE_SYNC).delete(id);
    return;
  }
  const db = await openDB();
  const tx = db.transaction(STORE_SYNC, 'readwrite');
  const store = tx.objectStore(STORE_SYNC);
  await new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const r = req.result;
      if (r) { r.retry_count++; store.put(r); }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Performance: don't fail if some assets missing
      await cache.addAll(APP_SHELL).catch(() => {});
    }).then(() => self.skipWaiting())
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

async function processSyncQueue() {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE_SYNC, 'readonly');
    const index = tx.objectStore(STORE_SYNC).index('synced');
    const all   = await new Promise((res, rej) => {
      const r = index.getAll(IDBKeyRange.only(0));
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });

    if (!all?.length) return;

    for (const item of all) {
      if (item.retry_count > 0) {
        await new Promise(r => setTimeout(r, Math.min((1 << item.retry_count) * 500, 30000)));
      }
      try {
        const base  = _swCloudUrl || self.registration.scope;
        const full  = base.replace(/\/$/, '') + item.url;
        const resp  = await fetch(full, {
          method: item.method,
          headers: { 'Content-Type': 'application/json', ...item.headers },
          body: item.method !== 'GET' && item.method !== 'HEAD'
              ? JSON.stringify(item.data) : undefined
        });

        if (resp.ok) {
          const dt  = db.transaction(STORE_SYNC, 'readwrite');
          dt.objectStore(STORE_SYNC).delete(item.id);
        } else {
          await incrementRetryCount(item.id, item.retry_count || 0);
        }
      } catch {
        await incrementRetryCount(item.id, item.retry_count || 0);
      }
    }

    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE' }));
    });
  } catch {}
}

// ─── Fetch Handler ────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache auth
  if (url.pathname.startsWith('/api/auth')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigation — Network-First (always fresh page)
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // API Mutations (POST/PUT/DELETE) → queue offline
  if (url.pathname.startsWith('/api/') && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
    event.respondWith(handleMutation(event.request));
    return;
  }

  // API GET → Stale-While-Revalidate (fast + fresh data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // /page/data endpoints → Stale-While-Revalidate (1h cache)
  if (url.pathname.endsWith('/data')) {
    event.respondWith(staleWhileRevalidate(event.request, { maxAge: 3600 }));
    return;
  }

  // App Shell & static assets → Cache-First (instant on repeat visits)
  event.respondWith(cacheFirst(event.request));
});

// ─── Fetch Strategies ─────────────────────────────────────────────────────────

/** Cache-First — best for static assets that rarely change */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/** Network-First — best for navigation (always get latest HTML) */
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    return resp;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/**
 * Stale-While-Revalidate — best for API data (serve cached immediately,
 * fetch fresh in background). Falls back to cache if network fails.
 */
async function staleWhileRevalidate(request, opts = {}) {
  const maxAge = opts.maxAge ?? 300; // default 5 min
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Fire fetch in background (non-blocking)
  const fetchPromise = fetch(request).then(async resp => {
    if (resp.ok && request.method === 'GET') {
      // Add timestamp so we can expire old entries
      const headers = new Headers(resp.headers);
      headers.set('sw-time', String(Date.now()));
      const clone = new Response(await resp.clone().text(), {
        status: resp.status, statusText: resp.statusText, headers
      });
      await cache.put(request, clone);
    }
    return resp;
  }).catch(() => null);

  if (cached) {
    // Serve stale immediately
    const swTime = parseInt(cached.headers.get('sw-time') || '0', 10);
    const age    = (Date.now() - swTime) / 1000;

    if (age < maxAge) {
      // Fresh enough — return cache without waiting for network
      return cached;
    }
    // Stale but served — background refresh already fired
    return cached;
  }

  // No cache — must wait for network
  const resp = await fetchPromise;
  return resp || new Response(JSON.stringify({ error: 'Offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── Mutation Handler ─────────────────────────────────────────────────────────

async function handleMutation(request) {
  try {
    return await fetch(request);
  } catch {
    const method  = request.method;
    const url     = request.url;
    let body      = '';
    let headers   = {};
    try {
      const cl = request.clone();
      body    = await cl.text();
      request.headers.forEach((v, k) => { headers[k] = v; });
    } catch {}

    await queueForSync(method, url, body, headers);

    if ('serviceWorker' in self && 'sync' in self.registration) {
      self.registration.sync.register('sync-queue').catch(() => {});
    }

    return new Response(JSON.stringify({
      error:   'Offline — đã lưu vào hàng đợi, sẽ đồng bộ khi có mạng',
      queued:  true,
      url:     new URL(url).pathname,
      method
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
}
