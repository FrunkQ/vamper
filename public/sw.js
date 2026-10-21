// Service worker: makes Vamper installable and lets it open offline. Pages are fetched fresh when
// online (so a deploy shows at once) and from the cache when not; the hashed build files never
// change, and nor does the voice model (public/models/), so they come from the cache first. Songs are never fetched, so nothing of yours is stored here.
const CACHE = 'vamper-v2';
const SHELL = ['./', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const put = res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? './' : req, copy)); } return res; };
  if (req.mode === 'navigate') e.respondWith(fetch(req).then(put).catch(() => caches.match('./')));
  else if (url.pathname.includes('/assets/') || url.pathname.includes('/models/')) e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(put)));
  else e.respondWith(fetch(req).then(put).catch(() => caches.match(req)));
});
