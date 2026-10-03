// Merkheft Service Worker: Die App öffnet sich auch ohne Internet.
// Zuerst aus dem Netz (damit Updates sofort ankommen). Ohne Netz, oder wenn es länger als
// 4 Sekunden dauert, kommt die gespeicherte Version.
// Daten (/api) laufen nie hierüber, die speichert die App selbst auf dem Gerät.
const CACHE = 'merkheft-v2';
const CORE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : req;
  let saved = Promise.resolve();
  const fromNet = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      saved = caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  });
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
  e.waitUntil(fromNet.then(() => saved, () => {}).catch(() => {})); // auch wenn die gespeicherte Version schneller war: Speicher auffrischen
  e.respondWith(
    Promise.race([fromNet.catch(() => null), slow])
      .then((res) => res || caches.match(key, { ignoreSearch: true }))
      .then((res) => res || fromNet),
  );
});
