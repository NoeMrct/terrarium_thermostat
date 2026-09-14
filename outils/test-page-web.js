#!/usr/bin/env node
/* =============================================================================
   Test de l'interface web embarquée (page_web.h).
   -----------------------------------------------------------------------------
   La page servie par l'ESP32 est du JavaScript comme un autre, et rien ne la
   testait : une faute de frappe n'apparaissait qu'une fois le firmware flashé,
   avec pour seul symptôme une page muette. Ce test extrait la page de
   page_web.h, la charge dans un DOM sans navigateur, et lui répond à la place
   du socle. Il vérifie ce qui casse en silence : le rendu, les formulaires,
   les requêtes réellement émises, et le graphique.

     npm install jsdom
     node test-page-web.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SOURCE = path.join(__dirname, '..', 'page_web.h');
let ok = 0, ko = 0;
const v = (q, c, d = '') => {
  console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(58)} ${d}`);
  c ? ok++ : ko++;
};
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));

// --------------------------------------------------------------- faux socle
function creerSocle(options = {}) {
  const maintenant = Math.floor(Date.now() / 1000);
  const zone = (i) => ({
    // Un nom volontairement piégeux : guillemet, antislash, chevrons. C'est le
    // cas qui casse un JSON mal échappé et une page vulnérable à l'injection.
    nom: i === 0 ? 'Point "chaud" <b>\\x' : 'Zone fraîche',
    temp: 30.25 + i, consigne: 32 - i, demande: 40, duty: 33,
    chauffe: i === 0, derive: false, autotune: options.autotune === i,
    defaut: options.defaut === i ? 'SONDE' : null,
    jour: 32 - i, nuit: 26 - i, bande: 2, ki: 0.0006, max: 40, offset: 0,
    debutJour: '08:00', debutNuit: '20:00', rampe: 45,
    inefficaceMin: 20, inefficaceDelta: 0.3, deriveSeuil: 3, deriveMin: 15,
    chuteSeuil: 2, chuteSecondes: 300
  });
  return {
    envois: [],
    globaux: {
      courantAlimA: 3, puissanceTapisW: 20, tensionV: 12, zonesSimultanees: 1,
      maintenanceMin: 10, ecranVeilleMin: 10, saisonActive: false, saisonDelta: 5,
      saisonDescenteJ: 21, saisonPlateauJ: 60, saisonRemonteeJ: 21,
      saisonDebutEpoch: 0, decalageActuel: 0, heureFiable: true
    },
    status: {
      uptime: 7200, tapisActif: 0, alertesEnAttente: 0, histHeures: options.histHeures || 336,
      version: '3.2.0', otaProtegee: options.otaProtegee !== false, maintenanceS: 0,
      heure: '2026-09-10 19:00:00', zones: [zone(0), zone(1)]
    },
    reseau: {
      ssid: 'maison', webUtilisateur: 'admin', urlAlertes: 'https://exemple.fr/alerte',
      urlHeartbeat: '', heartbeatMinutes: 5, mqttHote: 'broker.exemple.fr', mqttPort: 8883,
      mqttPrefixe: 'terrarium', mqttUtilisateur: 'socle', decouverteHA: true,
      mqttTls: true, verifierTls: true, jeton: 'K7M2QX4TBW9HRPFZ3NXCVJ8D',
      alerteJetonDefini: false, otaProtegee: options.otaProtegee !== false,
      otaActive: options.otaProtegee !== false,
      fuseau: 'CET-1CEST,M3.5.0,M10.5.0/3', ntp: 'fr.pool.ntp.org'
    },
    stats: {
      version: '3.2.0', compile: 'Sep 10 2026', zonesSimultanees: 1, saison: 0,
      maintenanceRestanteS: 0,
      zones: [0, 1].map(i => ({
        nom: 'Zone ' + (i + 1), min: 29.1, max: 33.2, moyenne: 31.4, horsPlagePct: 4,
        points: 1440, heuresChauffe: 12.5, kWh: 0.25,
        defauts: { sonde: 0, surchauffe: 0, figee: 0 }
      }))
    },
    sondes: {
      sondes: [{ rom: '28FF641F8B2C0155', temp: 30.2, zone: 0 },
               { rom: '28FF9A2C7C1A0033', temp: 26.5, zone: 1 }],
      parasite: false
    },
    points: Array.from({ length: 200 }, (_, i) => ({
      e: maintenant - (200 - i) * 60,
      t0: 30 + Math.sin(i / 9), t1: 26 + Math.cos(i / 7), c0: 32, c1: 28
    }))
  };
}

function creerPage(socle) {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const html = src.split('R"HTML(')[1].split(')HTML"')[0];
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://terrarium.local/', pretendToBeVisual: true });
  const w = dom.window;

  w.alert = m => socle.envois.push({ alerte: String(m) });
  w.confirm = () => true;
  w.fetch = (u, opts = {}) => {
    const chemin = String(u).split('?')[0];
    const requete = String(u).split('?')[1] || '';
    socle.envois.push({ url: String(u), chemin, requete, methode: opts.method || 'GET',
                        entetes: opts.headers || {}, corps: opts.body || '' });
    const rendre = d => Promise.resolve({ ok: true, status: 200,
      json: async () => d, text: async () => (typeof d === 'string' ? d : JSON.stringify(d)) });
    if (chemin === '/api/status')  return rendre(socle.status);
    if (chemin === '/api/reseau')  return opts.method === 'POST' ? rendre('Enregistre.') : rendre(socle.reseau);
    if (chemin === '/api/globaux') return opts.method === 'POST' ? rendre('Enregistre : 2 zone(s) simultanee(s).') : rendre(socle.globaux);
    if (chemin === '/api/stats')   return rendre(socle.stats);
    if (chemin === '/api/sondes')  return opts.method === 'POST' ? rendre('Sonde liee.') : rendre(socle.sondes);
    if (chemin === '/api/history') return opts.method === 'DELETE' ? rendre('Historique efface') : rendre({ points: socle.points });
    if (chemin === '/api/journal') return rendre('2026-09-10 18:00:00 | Demarrage\n');
    return rendre('OK');
  };
  // jsdom ne dessine pas : un contexte 2D inerte suffit, on teste la logique.
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (_, p) => (p === 'canvas' ? {} : () => {}) });

  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  // `let PTS = …` au sommet d'un script cree une liaison lexicale que window ne
  // montre pas : on recupere des accesseurs vivants depuis la meme evaluation.
  const vue = w.eval(js + '\n;(function(){return{get PTS(){return PTS},get GX(){return GX},get S(){return S}}})()');
  return { w, vue, socle, $: s => w.document.querySelector(s),
           texte: s => (w.document.querySelector(s) || {}).textContent || '',
           html: s => (w.document.querySelector(s) || {}).innerHTML || '' };
}

const dernier = (socle, chemin, methode) =>
  [...socle.envois].reverse().find(e => e.chemin === chemin && (!methode || e.methode === methode));

(async () => {
  titre('1. Rendu de la vue');
  const s1 = creerSocle();
  const p = creerPage(s1);
  await attendre(900);

  v('l\'entête affiche l\'heure et la version', p.html('#entete').includes('3.2.0'), p.texte('#entete').slice(0, 46));
  v('les deux zones sont affichées', (p.html('#zones').match(/class="card"/g) || []).length === 2);
  v('la température apparaît', p.html('#zones').includes('30.25'));
  v('la zone qui chauffe est signalée', p.html('#zones').includes('CHAUFFE'));
  v('un nom piégeux est échappé, pas injecté',
    !p.html('#zones').includes('<b>') && p.html('#zones').includes('&lt;b&gt;'),
    p.html('#zones').match(/Point[^<]*/)?.[0] || '');

  titre('2. Graphique');
  v('les points sont mémorisés pour le survol', Array.isArray(p.vue.PTS) && p.vue.PTS.length === 200,
    p.vue.PTS ? p.vue.PTS.length + ' point(s)' : 'null');
  const sel = p.$('#duree');
  v('le sélecteur de durée a une valeur valide',
    Array.from(sel.options).map(o => o.value).includes(sel.value), `"${sel.value}"`);
  {
    const c = p.$('#g');
    c.getBoundingClientRect = () => ({ left: 0, width: c.width });
    const cible = s1.points[100];
    c.dispatchEvent(new p.w.MouseEvent('mousemove', { clientX: p.vue.GX(cible.e), bubbles: true }));
    const t = Array.from(c.parentNode.querySelectorAll('div')).map(d => d.textContent).join(' ');
    v('le survol lit la valeur sous le curseur', t.includes(cible.t0.toFixed(2)), t.slice(-46));
  }

  titre('3. Formulaires de zone');
  v('le champ « seuil de chute » existe et est pré-rempli', p.$('#C0') && p.$('#C0').value === '2', p.$('#C0') && p.$('#C0').value);
  v('le champ « fenêtre de chute » aussi', p.$('#F0') && p.$('#F0').value === '300');
  p.$('#C0').value = '3.5'; p.$('#F0').value = '600';
  p.w.eval('envoyer(0)');
  await attendre(300);
  {
    const e = dernier(s1, '/api/config', 'POST');
    v('l\'enregistrement part bien en POST', !!e);
    v('il porte l\'en-tête anti-requête-forgée', e && e.entetes['X-Terrarium'] === '1');
    v('les seuils de chute sont transmis', e && /chuteSeuil=3\.5/.test(e.corps) && /chuteSecondes=600/.test(e.corps),
      e ? (e.corps.match(/chute[^&]*&?[^&]*/) || [''])[0] : '');
    v('tous les réglages de zone sont transmis',
      e && ['nom', 'jour', 'nuit', 'bande', 'ki', 'max', 'offset', 'debutJour', 'debutNuit',
            'rampe', 'inefficaceMin', 'inefficaceDelta', 'deriveSeuil', 'deriveMin',
            'chuteSeuil', 'chuteSecondes'].every(c => e.corps.includes(c + '=')));
  }

  titre('4. Réglages généraux (jusque-là réservés à la console série)');
  v('l\'alimentation est pré-remplie', p.$('#gA') && p.$('#gA').value === '3', p.$('#gA') && p.$('#gA').value);
  v('le nombre de zones simultanées est expliqué', p.texte('#gZones').includes('1 zone'));
  v('l\'état du cyclage saisonnier est affiché', p.texte('#gEtatSaison').length > 5, p.texte('#gEtatSaison'));
  p.$('#gA').value = '5'; p.$('#gSA').value = '1'; p.$('#gSD').value = '4';
  await p.w.eval('envoyerGlobaux()');
  await attendre(300);
  {
    const e = dernier(s1, '/api/globaux', 'POST');
    v('l\'enregistrement part en POST authentifié', !!e && e.entetes['X-Terrarium'] === '1');
    v('l\'ampérage et la saison sont transmis',
      e && /courantAlimA=5/.test(e.corps) && /saisonActive=1/.test(e.corps) && /saisonDelta=4/.test(e.corps));
    v('« repartir du jour 1 » ne part que si on le demande', e && !e.corps.includes('saisonRedemarrer'));
  }
  await p.w.eval('envoyerGlobaux(1)');
  await attendre(300);
  v('…et il part quand on le demande',
    (dernier(s1, '/api/globaux', 'POST') || {}).corps.includes('saisonRedemarrer=1'));

  titre('5. Actions');
  await p.w.eval('effacerHistorique()'); await attendre(200);
  v('effacer l\'historique envoie un DELETE', !!dernier(s1, '/api/history', 'DELETE'));
  await p.w.eval('redemarrer()'); await attendre(200);
  v('redémarrer envoie un POST', !!dernier(s1, '/api/redemarrer', 'POST'));
  await p.w.eval('effacerJetonAlerte()'); await attendre(200);
  v('retirer le jeton d\'alerte est un geste explicite',
    (dernier(s1, '/api/reseau', 'POST') || {}).corps === 'alerteJetonVide=1');

  titre('6. Autotune : lancer et arrêter');
  {
    const s2 = creerSocle({ autotune: 0 });
    const q = creerPage(s2);
    await attendre(900);
    v('le bouton « Arrêter » apparaît quand un autotune tourne',
      q.$('#sat0') && !q.$('#sat0').hidden && q.$('#at0').hidden);
    v('l\'autre zone garde son bouton « Lancer »',
      q.$('#at1') && !q.$('#at1').hidden && q.$('#sat1').hidden);
    // Un autotune démarré ailleurs (console série, application) doit se voir
    // ici sans recharger la page : les formulaires ne sont construits qu'une
    // fois, mais l'état des boutons est rafraîchi à chaque relevé.
    s2.status.zones[0].autotune = false;
    s2.status.zones[1].autotune = true;
    await q.w.eval('maj()');
    await attendre(300);
    v('un autotune démarré ailleurs se reflète sans recharger la page',
      q.$('#at0') && !q.$('#at0').hidden && q.$('#sat1') && !q.$('#sat1').hidden);
    await q.w.eval("supprimer('/api/autotune?z=0')"); await attendre(200);
    const e = dernier(s2, '/api/autotune', 'DELETE');
    v('l\'arrêt part en DELETE', !!e && e.requete === 'z=0');
  }

  titre('7. Avertissement quand l\'OTA n\'est pas protégée');
  {
    const s3 = creerSocle({ otaProtegee: false });
    const q = creerPage(s3);
    await attendre(900);
    v('l\'avertissement est visible', q.html('#avertissements').includes('Mise à jour sans fil désactivée'));
    v('il explique quoi faire', q.html('#avertissements').includes('mot de passe OTA'));
    const s4 = creerSocle();
    const r = creerPage(s4);
    await attendre(900);
    v('rien ne s\'affiche quand elle est protégée', r.html('#avertissements').trim() === '');
  }

  titre('8. Petite partition : le sélecteur de durée reste cohérent');
  {
    const s5 = creerSocle({ histHeures: 12 });
    const q = creerPage(s5);
    await attendre(900);
    const sel2 = q.$('#duree');
    v('la valeur choisie fait partie des options proposées',
      Array.from(sel2.options).map(o => o.value).includes(sel2.value),
      `options ${Array.from(sel2.options).map(o => o.value).join('/')} valeur "${sel2.value}"`);
  }

  titre('9. Statistiques, sondes et journal');
  {
    await p.w.eval("onglet('sta',document.querySelector('.tabs button'))"); await attendre(300);
    v('les statistiques 24 h s\'affichent', p.html('#stxt').includes('moyenne'));
    v('l\'énergie est affichée', p.html('#stxt').includes('kWh'));
    await p.w.eval('scan()'); await attendre(300);
    v('les sondes détectées sont listées', p.html('#sondes').includes('28FF641F8B2C0155'));
    await p.w.eval('charge()'); await attendre(300);
    v('le journal se charge', p.texte('#jtxt').includes('Demarrage'));
  }

  console.log(`\n=== ${ko ? 'DES TESTS ONT ECHOUE' : 'INTERFACE WEB EMBARQUEE OK'}` +
              ` (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
