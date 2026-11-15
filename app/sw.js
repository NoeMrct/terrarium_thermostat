/* Agent de service : la coque de l'application est mise en cache à
   l'installation ; chaque fichier lu ensuite est servi depuis le cache et
   rafraîchi en arrière-plan (stale-while-revalidate). Le nom du cache est
   réécrit à chaque publication par outils/preparer-publication.js
   (terrariums-<commit>) : une nouvelle version installe son propre cache et
   efface les anciens à l'activation. */
/// <reference lib="webworker" />
/** @type {ServiceWorkerGlobalScope & typeof globalThis} */
const sw = /** @type {any} */ (self);
const CACHE = 'terrariums-dev';
const COQUE = ['./', './index.html', './app.js', './textes.en.js', './service.js', './mqtt.js', './style.css', './polices/inter-latin-wght.woff2', './icone.svg',
               './manifest.json', './aide.html', './mentions-legales.html', './confidentialite.html',
               './aide.en.html', './aide-index.json', './mentions-legales.en.html', './confidentialite.en.html', './demarrage-rapide.html',
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
// « Recharger » : pas de version qui attend indéfiniment un onglet fermé. Seule
// une page de la même origine peut le demander.
self.addEventListener('message', e => {
  if (e.origin === location.origin && e.data === 'SKIP_WAITING') sw.skipWaiting();
});

// Toujours le réseau, jamais le cache : la version publiée (version.json),
// et quand le serveur Terrariums sert aussi l'application, son API (données
// propres au compte) et sa console ; enfin le firmware de la page de
// flashage, qui doit être celui de la dernière release.
const HORS_CACHE = /\/(api|console|firmware)\/|\/version\.json$/;

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (HORS_CACHE.test(u.pathname) || e.request.headers.has('authorization')) return;
  // Le réseau est toujours interrogé : sa réponse rafraîchit le cache, et sert
  // quand le cache n'a rien. La copie est prise aussitôt : rendu à la page, le
  // corps ne se clone plus (cloné après caches.open(), il échouait en silence
  // et rien n'entrait dans le cache après l'installation).
  const reseau = fetch(e.request).then(r => {
    const copie = r.ok ? r.clone() : null;
    return { r, maj: copie ? caches.open(CACHE).then(c => c.put(e.request, copie)) : null };
  });
  e.waitUntil(reseau.then(x => x.maj).catch(() => {}));
  e.respondWith((async () => {
    const enCache = await caches.match(e.request);
    if (enCache) return enCache;
    try {
      return (await reseau).r;
    } catch (err) {
      const repli = e.request.mode === 'navigate' ? await caches.match('./index.html') : undefined;
      return repli || Response.error();
    }
  })());
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

// Un appui ouvre l'application sur le socle de la notification : la fenêtre
// déjà ouverte le reçoit par message, sinon l'adresse le désigne (#/<socle>).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const id = typeof d.socle === 'string' && d.socle ? d.socle : null;
  e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(fenetres => {
    const f = fenetres.find(w => 'focus' in w);
    if (f) {
      if (id) f.postMessage({ type: 'ouvrirSocle', socle: id });
      return f.focus();
    }
    return sw.clients.openWindow('./' + (id ? '#/' + encodeURIComponent(id) : ''));
  }));
});
