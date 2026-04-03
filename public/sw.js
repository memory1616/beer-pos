// BeerPOS Service Worker v27
// Clean PWA: only cache static assets, never touch navigation or API
const CACHE_NAME = "beer-pos-v27";
const DB_NAME = "BeerPOS";
const STORE_SYNC_QUEUE = "sync_queue";

// Cloud URL set by main thread via postMessage
let _swCloudUrl = null;

self.addEventListener('message', event => {
  if (event.data?.type === 'SET_CLOUD_URL') {
    _swCloudUrl = event.data.url || null;
  }
});

// Clear old caches on activation
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
});

// Open IndexedDB for offline queue
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
        const store = db.createObjectStore(STORE_SYNC_QUEUE, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("synced", "synced", { unique: false });
        store.createIndex("created_at", "created_at", { unique: false });
      }
    };
  });
}

// Save failed POST request to IndexedDB sync queue
async function queueForSync(method, url, body, headers) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_SYNC_QUEUE, "readwrite");
    const store = tx.objectStore(STORE_SYNC_QUEUE);
    const apiPath = new URL(url).pathname;

    let entity = "unknown";
    if (apiPath.includes("/sales")) entity = "sale";
    else if (apiPath.includes("/customers")) entity = "customer";
    else if (apiPath.includes("/products")) entity = "product";
    else if (apiPath.includes("/expenses")) entity = "expense";
    else if (apiPath.includes("/purchases")) entity = "purchase";
    else if (apiPath.includes("/payments")) entity = "payment";
    else if (apiPath.includes("/kegs")) entity = "keg";
    else if (apiPath.includes("/devices")) entity = "device";

    const action = method === "DELETE" ? "delete"
                   : method === "PUT" ? "update"
                   : "create";

    let parsedBody = {};
    try { parsedBody = JSON.parse(body); } catch {}

    await store.add({
      entity,
      action,
      data: parsedBody,
      url: apiPath,
      method,
      headers: headers || {},
      synced: 0,
      created_at: new Date().toISOString(),
      retry_count: 0
    });
    await tx.complete;

    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: "SYNC_QUEUED" });
    });
    return true;
  } catch (err) {
    console.error("[SW] Failed to queue:", err);
    return false;
  }
}

// URLs to cache — static assets ONLY (images, fonts, manifest)
// JS files are intentionally omitted: browser fetches fresh copies each time
// to ensure version busting works without waiting for SW update
const urlsToCache = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/css/tailwind.css",
  "/css/unified.css"
];

// Install
self.addEventListener("install", event => {
  console.log("[SW] Installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("[SW] Caching static assets...");
      return cache.addAll(urlsToCache).catch(err => {
        console.warn("[SW] Some URLs failed to cache:", err);
      });
    }).then(() => {
      self.skipWaiting();
      console.log("[SW] Installed ✓");
    })
  );
});

// Activate
self.addEventListener("activate", event => {
  console.log("[SW] Activating...");
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log("[SW] Deleting old cache:", name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      self.clients.claim();
      console.log("[SW] Activated ✓");
    })
  );
});

// Background sync
self.addEventListener("sync", event => {
  console.log("[SW] Background sync:", event.tag);
  if (event.tag === "sync-queue" || event.tag === "sync-all") {
    event.waitUntil(processSyncQueue());
  }
});

// Process queued items with exponential backoff retry
async function processSyncQueue() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_SYNC_QUEUE, "readonly");
    const store = tx.objectStore(STORE_SYNC_QUEUE);
    const index = store.index("synced");

    const all = await new Promise((resolve, reject) => {
      const req = index.getAll(IDBKeyRange.only(0));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (!all || all.length === 0) {
      console.log("[SW] No pending items");
      return;
    }

    console.log(`[SW] Syncing ${all.length} items`);

    for (const item of all) {
      // Exponential backoff: wait (2^retry_count) * 500ms before retrying
      if (item.retry_count > 0) {
        const delay = Math.min((1 << item.retry_count) * 500, 30000);
        console.log(`[SW] Backoff ${delay}ms for item (attempt ${item.retry_count + 1})`);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const baseUrl = _swCloudUrl || self.registration.scope;
        const fullUrl = baseUrl.replace(/\/$/, "") + item.url;

        const response = await fetch(fullUrl, {
          method: item.method,
          headers: {
            "Content-Type": "application/json",
            ...item.headers
          },
          body: item.method !== "GET" && item.method !== "HEAD"
            ? JSON.stringify(item.data)
            : undefined
        });

        if (response.ok) {
          const updateTx = db.transaction(STORE_SYNC_QUEUE, "readwrite");
          await new Promise((resolve, reject) => {
            const req = updateTx.objectStore(STORE_SYNC_QUEUE).delete(item.id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
          console.log(`[SW] ✓ Synced: ${item.method} ${item.url}`);
        } else {
          // Server error — increment retry count
          await incrementRetryCount(item.id, item.retry_count || 0);
          console.warn(`[SW] ✗ Failed (${response.status}): ${item.method} ${item.url} — queued for retry`);
        }
      } catch (err) {
        // Network error — increment retry count
        await incrementRetryCount(item.id, item.retry_count || 0);
        console.warn(`[SW] ✗ Network error: ${item.method} ${item.url}:`, err.message);
        // Don't break on network error — try next items
      }
    }

    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: "SYNC_COMPLETE" });
    });
  } catch (err) {
    console.error("[SW] processSyncQueue error:", err);
  }
}

// Increment retry count for an item, delete after max retries (max 6 = ~32s backoff)
async function incrementRetryCount(id, currentCount) {
  const MAX_RETRIES = 6;
  if (currentCount >= MAX_RETRIES) {
    // Max retries reached — delete from queue (give up silently)
    const db = await openDB();
    const tx = db.transaction(STORE_SYNC_QUEUE, "readwrite");
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(STORE_SYNC_QUEUE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    console.warn(`[SW] Max retries reached — dropped item id ${id}`);
    return;
  }
  const db = await openDB();
  const tx = db.transaction(STORE_SYNC_QUEUE, "readwrite");
  const store = tx.objectStore(STORE_SYNC_QUEUE);
  await new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (record) {
        record.retry_count = (record.retry_count || 0) + 1;
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      } else {
        resolve();
      }
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// Fetch handler — CLEAN: only cache static assets, pass through everything else
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // NEVER cache auth endpoints
  if (url.pathname.startsWith("/api/auth")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // API mutations (POST/PUT/DELETE) — queue if offline
  if (url.pathname.startsWith("/api/") && event.request.method !== "GET" && event.request.method !== "HEAD") {
    event.respondWith(handleAPIMutation(event.request));
    return;
  }

  // API GET — network only, never cache
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Page JSON endpoints (/dashboard/data, /sale/data, …) — NEVER cache.
  // Previously these matched the static branch and were cached forever → stale "Hôm nay".
  if (url.pathname.endsWith("/data")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigation — ALWAYS network only, never cache
  // This prevents the redirect loop entirely
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static assets — cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;
      return fetch(event.request).then(networkResponse => {
        if (networkResponse.ok && event.request.method === "GET") {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    })
  );
});

// Handle API mutations — queue if offline
async function handleAPIMutation(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (err) {
    const url = request.url;
    const method = request.method;

    let body = "";
    try {
      const clonedReq = request.clone();
      body = await clonedReq.text();
    } catch {}

    const headers = {};
    request.headers.forEach((value, key) => { headers[key] = value; });

    await queueForSync(method, url, body, headers);

    if ('serviceWorker' in self && 'sync' in self.registration) {
      try {
        await self.registration.sync.register('sync-queue');
      } catch (syncErr) {
        console.warn('[SW] Background sync not supported:', syncErr.message);
      }
    }

    return new Response(JSON.stringify({
      error: "Offline — đã lưu vào hàng đợi, sẽ đồng bộ khi có mạng",
      queued: true,
      url: new URL(url).pathname,
      method
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    });
  }
}

console.log("[SW] BeerPOS Service Worker v27 loaded");
