const CACHE_NAME = "beer-pos-v6";

// URLs to cache for full offline
const urlsToCache = [
  "/",
  "/login",
  "/customers",
  "/sale",
  "/stock",
  "/report",
  "/purchases",
  "/delivery",
  "/products",
  "/backup",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/sync.js",
  "/db.js"
];

// Install - cache all URLs
self.addEventListener("install", event => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Service Worker: Caching all URLs');
      return cache.addAll(urlsToCache);
    }).then(() => {
      self.skipWaiting();
      console.log('Service Worker: Installed and skipped waiting');
    })
  );
});

// Activate - clean old caches
self.addEventListener("activate", event => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      self.clients.claim();
      console.log('Service Worker: Activated');
    })
  );
});

// Fetch - network first, fallback to cache
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // API calls - network only, never cache 404
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          return response;
        })
        .catch(() => {
          // Return error response if offline
          console.log('Service Worker: API offline for', event.request.url);
          return new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // HTML pages (navigation) - network first, fallback to cache
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the HTML page for offline use
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline fallback - try to serve from cache
          console.log('Service Worker: Offline, serving from cache:', event.request.url);
          return caches.match(event.request).then(response => {
            if (response) {
              return response;
            }
            // If specific page not cached, serve root
            return caches.match('/');
          });
        })
    );
    return;
  }

  // Static assets (JS, CSS, images) - cache first, then network
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        
        return fetch(event.request).then(networkResponse => {
          // Cache new static assets
          if (networkResponse.ok && event.request.method === 'GET') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        });
      })
  );
});

console.log('Service Worker: Loaded');
