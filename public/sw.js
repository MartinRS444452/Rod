// Service worker: оболочка приложения работает офлайн, данные и API — всегда из сети.
const V = 'rod-shell-v3', THUMBS = 'rod-thumbs-v1';
const SHELL = ['/', '/app.css', '/js/app.js', '/js/util.js', '/js/layout.js', '/js/family.js', '/js/stats.js', '/js/svg.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== THUMBS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/healthz' || url.pathname.startsWith('/media/')) return;
  if (url.pathname.startsWith('/thumb/')) { // миниатюры: сначала кэш (имена файлов неизменны)
    e.respondWith(caches.open(THUMBS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
    return;
  }
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
