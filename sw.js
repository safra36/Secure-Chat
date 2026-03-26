// Service Worker for Secure Chat PWA
const CACHE_NAME = 'secure-chat-v6';
const STATIC_ASSETS = [
  '/index.html',
  '/login.html',
  '/auth.js',
  '/encryption.js',
  '/password-loader.js',
  '/asset-loader.js',
  '/pako.min.js',
  '/content-cache-db.js',
  '/p2p-transfer-manager.js',
  '/manifest.json',
  '/sw.js',
  '/pwa-register.js'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          // Some assets might not exist, that's ok
          console.log('[SW] Some assets failed to cache:', err);
          return Promise.resolve();
        });
      })
      .then(() => {
        console.log('[SW] Installation complete, skipping waiting');
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete, claiming clients');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // For navigation requests (HTML pages), always go to network first
  // This ensures authentication redirects work properly
  if (request.mode === 'navigate' || 
      request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          // Cache the page for offline use, but don't serve stale cached versions
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed, try cache as fallback
          return caches.match(request);
        })
    );
    return;
  }

  // For binary-body requests (uploads/downloads/transfers), skip SW entirely
  // to avoid body stream consumption issues in some browsers
  if (url.pathname.startsWith('/upload') ||
      url.pathname.startsWith('/download') ||
      url.pathname.startsWith('/transfer/')) {
    return; // Let browser handle directly
  }

  // For API requests, always go to network
  if (url.pathname === '/bots' ||
      url.pathname.startsWith('/messages/') ||
      url.pathname.startsWith('/send/') ||
      url.pathname.startsWith('/heartbeat/') ||
      url.pathname.startsWith('/call/') ||
      url.pathname.startsWith('/verify') ||
      url.pathname.startsWith('/time-sync') ||
      url.pathname.startsWith('/bot/') ||
      url.pathname.startsWith('/chat/')) {

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Return network response
          return response;
        })
        .catch(() => {
          // Network failed, return offline error
          return new Response(JSON.stringify({
            error: 'Offline',
            message: 'You are not connected to the server'
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // For static assets (JS, CSS, images), use cache-first strategy
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          console.log('[SW] Serving from cache:', request.url);
          return cachedResponse;
        }
        
        // Not in cache, fetch from network
        console.log('[SW] Fetching from network:', request.url);
        return fetch(request)
          .then((networkResponse) => {
            // Cache successful responses
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(request, responseClone);
                });
            }
            return networkResponse;
          })
          .catch((err) => {
            console.log('[SW] Fetch failed:', err);
          });
      })
  );
});

// Handle messages from main app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skipping waiting as requested');
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLIENTS_CLAIM') {
    console.log('[SW] Claiming clients as requested');
    self.clients.claim();
  }
});

// Push notification support (future enhancement)
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);
  
  if (event.data) {
    try {
      const data = event.data.json();
      const options = {
        body: data.body || 'New message',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-72x72.png',
        vibrate: [100, 50, 100],
        data: {
          dateOfArrival: Date.now(),
          primaryKey: 1
        }
      };
      
      event.waitUntil(
        self.registration.showNotification(data.title || 'Secure Chat', options)
      );
    } catch (err) {
      console.log('[SW] Push error:', err);
    }
  }
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.title);
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({ type: 'window' })
      .then((clientList) => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            return client.focus();
          }
        }
        // Open new window if none exists
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
  );
});

console.log('[SW] Service worker loaded');
