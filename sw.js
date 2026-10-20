/* born-somewhere service worker v5.48
 * Cache-first strategy for the static app shell + countries/i18n JSON.
 * Falls back to network when cache misses, then caches the response.
 */
const CACHE_NAME = 'born-somewhere-v5.48';
const APP_VERSION = '5.48.0';

// Files we want in the offline shell. List both the entry HTML and the data
// blob so the game can boot without network.
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './gedcom.js',
  './data/world-coords.js',
  './data/countries.json',
  './data/i18n.json',
  './manifest.json',
  './CHANGELOG.md',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Use addAll with individual fallbacks so a single 404 doesn't break install
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] failed to pre-cache', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Cache-first with network fallback + background revalidation.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Only handle same-origin GETs (avoid messing with cross-origin beacons)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Background refresh (stale-while-revalidate feel)
        fetch(req).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
          }
        }).catch(() => { /* offline — keep cached */ });
        return cached;
      }
      return fetch(req).then((res) => {
        // Cache successful responses for next time
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        // Offline + not in cache: return a tiny fallback so the page doesn't crash
        if (req.destination === 'document') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});

// Optional: allow page to trigger skipWaiting after new SW is ready
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});