const CACHE_NAME = "beer-pos-v7";
const DB_NAME = "BeerPOS";
const STORE_SYNC_QUEUE = "sync_queue";

// Cloud URL set by main thread via postMessage
let _swCloudUrl = null;

// Main thread → SW: pass cloud URL when it changes
self.addEventListener('message', event => {
  if (event.data?.type === 'SET_CLOUD_URL') {
    _swCloudUrl = event.data.url || null;
  }
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

    // Parse URL to get API path
    const apiPath = new URL(url).pathname;

    // Infer entity from URL
    let entity = "unknown";
    if (apiPath.includes("/sales")) entity = "sale";
    else if (apiPath.includes("/customers")) entity = "customer";
    else if (apiPath.includes("/products")) entity = "product";
    else if (apiPath.includes("/expenses")) entity = "expense";
    else if (apiPath.includes("/purchases")) entity = "purchase";
    else if (apiPath.includes("/payments")) entity = "payment";
    else if (apiPath.includes("/kegs")) entity = "keg";
    else if (apiPath.includes("/devices")) entity = "device";

    // Determine action from method
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
    console.log(`[SW] Queued ${method} ${apiPath} for sync`);

    // Notify all clients about queued item
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

// URLs to cache for full offline
const urlsToCache = [
  "/",
  "/login",
  "/customers",
  "/sale",
  "/stock",
  "/report",
  "/purchases",
  "/products",
  "/backup",
  "/kegs",
  "/expenses",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/js/vendor/dexie.min.js",
  "/js/vendor/chart.umd.min.js",
  "/js/sync.js",
  "/js/db.js",
  "/js/numfmt.js",
  "/js/auth.js",
  "/js/layout.js",
  "/css/tailwind.css",
  "/css/unified.css"
];

// Install - cache all URLs
self.addEventListener("install", event => {
  console.log("[SW] Installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("[SW] Caching all static assets...");
      return cache.addAll(urlsToCache).catch(err => {
        console.warn("[SW] Some URLs failed to cache:", err);
      });
    }).then(() => {
      self.skipWaiting();
      console.log("[SW] Installed ✓");
    })
  );
});

// Activate - clean old caches
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

// Background sync event
self.addEventListener("sync", event => {
  console.log("[SW] Background sync event:", event.tag);
  if (event.tag === "sync-queue" || event.tag === "sync-all") {
    event.waitUntil(processSyncQueue());
  }
});

// Process all queued items from IndexedDB
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
      console.log("[SW] No pending items to sync");
      return;
    }

    console.log(`[SW] Processing ${all.length} queued items`);

    for (const item of all) {
      try {
        // Prefer cloud URL if configured, else fall back to local server
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
          // Mark as synced
          const updateTx = db.transaction(STORE_SYNC_QUEUE, "readwrite");
          await new Promise((resolve, reject) => {
            const req = updateTx.objectStore(STORE_SYNC_QUEUE).delete(item.id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
          console.log(`[SW] ✓ Synced: ${item.method} ${item.url}`);
        } else {
          console.warn(`[SW] ✗ Failed (${response.status}): ${item.method} ${item.url}`);
        }
      } catch (err) {
        console.warn(`[SW] ✗ Network error for ${item.method} ${item.url}:`, err.message);
        // Stop processing — we're offline
        break;
      }
    }

    // Notify clients
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: "SYNC_COMPLETE" });
    });
  } catch (err) {
    console.error("[SW] processSyncQueue error:", err);
  }
}

// Fetch handler
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Skip non-GET for caching decisions (process separately)
  if (event.request.method !== "GET" && event.request.method !== "HEAD") {
    // API write requests — try network, queue if offline
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(handleAPIMutation(event.request));
      return;
    }
    return;
  }

  // API GET requests — network only, no caching
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: "Offline", queued: false }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      })
    );
    return;
  }

  // Navigation requests — network first, fallback to cache
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then(response => {
            return response || caches.match("/");
          });
        })
    );
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

// Handle API mutations (POST/PUT/DELETE) — queue if offline
async function handleAPIMutation(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (err) {
    // Offline — queue the request
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

    // Return a user-friendly response
    return new Response(JSON.stringify({
      error: "Offline — đã lưu vào hàng đợi, sẽ đồng bộ khi có mạng",
      queued: true,
      url: new URL(url).pathname,
      method
    }), {
      status: 202, // Accepted
      headers: { "Content-Type": "application/json" }
    });
  }
}

console.log("[SW] BeerPOS Service Worker v7 loaded");
