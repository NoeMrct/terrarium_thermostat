/* Agent de service : la coque de l'application est mise en cache à
   l'installation, puis servie depuis le cache et rafraîchie en arrière-plan
   (stale-while-revalidate). Le nom du cache est réécrit à chaque publication
   par outils/preparer-publication.js (terrariums-<commit>) : une nouvelle
   version installe son propre cache et efface les anciens à l'activation. */
/// <reference lib="webworker" />
/** @type {ServiceWorkerGlobalScope & typeof globalThis} */
const sw = /** @type {any} */ (self);
const CACHE = 'terrariums-dev';
const COQUE = ['./', './index.html', './app.js', './mqtt.js', './style.css', './icone.svg',
               './manifest.json', './aide.html', './mentions-legales.html', './confidentialite.html',
               './aide.en.html', './mentions-legales.en.html', './confidentialite.en.html', './demarrage-rapide.html',
               './icones/icone-192.png', './icones/icone-512.png',
               './icones/icone-maskable-512.png', './icones/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(COQUE)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(c => c !== CACHE).map(c => caches.delete(c))))
    .then(() => sw.clients.claim()));
});

// L'application demande l'activation immédiate quand l'utilisateur a cliqué
// « Recharger » : pas de version qui attend indéfiniment un onglet fermé.
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') sw.skipWaiting(); });

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // version.json dit quelle version est publiée : toujours le réseau, jamais le cache.
  if (u.pathname.endsWith('/version.json')) return;
  e.respondWith(caches.match(e.request).then(enCache => {
    const reseau = fetch(e.request).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(() => {});
      return r;
    }).catch(() => enCache || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined));
    return enCache || reseau;
  }));
});

// Notifications poussées par le serveur Terrariums (serveur/) : affichées
// telles quelles, application fermée comprise ; un appui ouvre l'application.
self.addEventListener('push', e => {
  let d = { titre: 'Terrariums', corps: '' };
  try { d = Object.assign(d, e.data ? e.data.json() : {}); } catch (err) { d.corps = e.data ? e.data.text() : ''; }
  e.waitUntil(sw.registration.showNotification(d.titre, /** @type {any} */ ({
    body: d.corps, tag: d.tag || 'terrariums', renotify: !!d.urgent, requireInteraction: !!d.urgent,
    icon: './icones/icone-192.png', badge: './icones/icone-192.png', data: { socle: d.socle || null }
  })));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(fenetres => {
    const f = fenetres.find(w => 'focus' in w);
    if (f) return f.focus();
    return sw.clients.openWindow('./');
  }));
});
