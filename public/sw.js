const CACHE_NAME = 'pdfrealm-v3';
const STATIC_ASSETS = ['/'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { return r; }).catch(() => caches.match(e.request)));
});
