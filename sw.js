/* GymVerse – service worker: aplikacja działa offline po pierwszym wejściu. */
const CACHE = 'gymverse-v6';
const SHELL = ['./', 'index.html', 'src/gv-base-b.js', 'src/gv-data.js', 'src/vendor/zip.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u))))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('gymverse-') && k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'GYMVERSE_COUNT_APP_CLIENTS' || !event.ports || !event.ports[0]) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const scopePath = new URL(self.registration.scope).pathname;
    const appClients = clients.filter(client => {
      try { return new URL(client.url).pathname.startsWith(scopePath); } catch (_) { return false; }
    });
    event.ports[0].postMessage({ type: 'GYMVERSE_APP_CLIENT_COUNT', count: appClients.length });
  }).catch(() => event.ports[0].postMessage({ type: 'GYMVERSE_APP_CLIENT_COUNT', error: true })));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Strona: najpierw sieć (świeża wersja), w razie braku internetu – kopia z cache.
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.open(CACHE).then(c => c.match('index.html').then(r => r || c.match('./'))))
    );
    return;
  }

  // Obrazki i reszta: z cache, a w tle odświeżenie.
  e.respondWith(
    caches.open(CACHE).then(cache => cache.match(req).then(cached => {
      const net = fetch(req)
        .then(res => {
          if (res && res.ok) { const copy = res.clone(); cache.put(req, copy); }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }))
  );
});
