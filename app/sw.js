/* Agent de service : met en cache la coque de l'application pour qu'elle
   s'ouvre sans réseau. Les données, elles, viennent toujours du broker en
   direct — un socle affiché à partir d'un cache donnerait une fausse
   impression de surveillance. */
const CACHE = 'terrariums-v2';
const COQUE = ['./', './index.html', './app.js', './style.css', './icone.svg',
               './manifest.json', './vendor/mqtt.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(COQUE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(c => c !== CACHE).map(c => caches.delete(c))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Seuls les fichiers de la coque sont servis depuis le cache.
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copie = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copie)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
