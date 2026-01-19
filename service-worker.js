const CACHE_NAME = 'ims-cache-v9';
const ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/verify.html',
  '/reset.html',
  '/invite.html',
  '/tenant-create.html',
  '/dashboard.html',
  '/employee-dashboard.html',
  '/ops-dashboard.html',
  '/inventory-list.html',
  '/inventory-operations.html',
  '/order-register.html',
  '/field-purchase.html',
  '/job-creator.html',
  '/fleet.html',
  '/item-master.html',
  '/analytics.html',
  '/settings.html',
  '/settings-employee.html',
  '/support.html',
  '/manifest.json',
  '/css/style.css',
  '/js/utils.js',
  '/js/login.js',
  '/js/register.js',
  '/js/verify.js',
  '/js/reset.js',
  '/js/invite.js',
  '/js/tenant-create.js',
  '/js/dashboard.js',
  '/js/inventory-list.js',
  '/js/operations.js',
  '/js/order-register.js',
  '/js/field-purchase.js',
  '/js/job-creator.js',
  '/js/fleet.js',
  '/js/item-master.js',
  '/js/analytics.js',
  '/js/settings.js',
  '/js/settings-employee.js',
  '/js/support.js',
  '/js/ops-dashboard.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => {}))))
      .catch(() => Promise.resolve())
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return resp;
      }).catch(() => caches.match(request))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return resp;
      }).catch(() => cached);
    })
  );
});
