#!/usr/bin/env node
/* =============================================================================
   Test de charge : un parc de socles et plusieurs applications sur un broker.
   -----------------------------------------------------------------------------
   Deux volets :

   1. Broker — N socles légers (même protocole que socle-simule.js : états des
      zones sur changement, santé, réponses aux commandes) et M applications
      abonnées à tout le parc qui interrogent les socles à tour de rôle. On
      mesure la latence aller-retour des commandes (médiane, 95e centile, pire),
      les réponses manquantes, les déconnexions. Échoue au-delà des seuils.

   2. Interface — demo.html avec 20 socles simulés dans un vrai Chromium :
      temps de rendu de la liste et du détail, mémoire, aucune erreur console.
      Sans Playwright, ce volet est sauté.

     node test-charge.js --broker mqtt://localhost:1883 --ws ws://localhost:9001/mqtt
         [--socles 100] [--applications 10] [--duree 20] [--interface 20]

   Le broker local de la CI (mosquitto) suffit ; contre HiveMQ Serverless, le
   plafond gratuit est de 100 connexions : --socles 80 --applications 10.
   ============================================================================= */

/* global App, document, performance, requestAnimationFrame */
const mqtt = require('mqtt');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BROKER = arg('broker', 'mqtt://localhost:1883');
const WS = arg('ws', 'ws://localhost:9001/mqtt');
const NB_SOCLES = +arg('socles', 100);
const NB_APPS = +arg('applications', 10);
const DUREE_S = +arg('duree', 20);
const NB_INTERFACE = +arg('interface', 20);
const PREFIXE = 'charge';
const JETON = 'CHARGE00000000000000000X';

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(58)} ${d}`); c ? ok++ : ko++; };
const attendre = ms => new Promise(r => setTimeout(r, ms));
const centile = (tab, p) => { if (!tab.length) return 0; const t = [...tab].sort((a, b) => a - b); return t[Math.min(t.length - 1, Math.floor(p * t.length))]; };

// --- un socle léger ---------------------------------------------------------
function creerSocle(i) {
  const id = `terraCH${String(i).padStart(4, '0')}`;
  const base = `${PREFIXE}/${id}`;
  const zones = [{ temp: 30 + (i % 5), consigne: 32 }, { temp: 25 + (i % 3), consigne: 27 }];
  const client = mqtt.connect(BROKER, { clientId: 'socle-' + id, clean: true, keepalive: 30,
    will: { topic: `${base}/statut`, payload: 'hors ligne', retain: true } });
  const s = { id, client, commandes: 0, deconnexions: 0 };
  client.on('connect', () => {
    client.publish(`${base}/statut`, 'en ligne', { retain: true });
    client.subscribe(`${base}/cmd`);
  });
  client.on('close', () => { s.deconnexions++; });
  client.on('message', (sujet, charge) => {
    let d; try { d = JSON.parse(charge.toString()); } catch (e) { return; }
    s.commandes++;
    const rep = (okR, corps) => client.publish(`${base}/reponse`, JSON.stringify({ req: d.req, ok: okR, ...corps }));
    if (d.action === 'etat') {
      rep(true, { zones: zones.map((z, k) => ({ nom: 'Zone ' + (k + 1), temp: +z.temp.toFixed(2), consigne: z.consigne, demande: 40, charge: 33,
        chauffe: k === 0, autotune: false, derive: false, jour: z.consigne, nuit: z.consigne - 5, bande: 2, max: 40, offset: 0, rampe: 45, debutJour: 480, debutNuit: 1200, defaut: null })),
        uptime: 1000, entretienS: 0, heure: '', zonesSimultanees: 1, saison: 0, alertesEnAttente: 0, proto: 3,
        sante: { proto: 3, version: '3.4.0-charge', uptime: 1000, rssi: -60, heap: 170000, heapMin: 140000, blocMax: 98000, reset: 'mise sous tension', hote: id + '.local', ip: '' } });
      return;
    }
    if (d.jeton !== JETON) { rep(false, { erreur: 'jeton invalide' }); return; }
    if (d.action === 'zone') { if (typeof d.jour === 'number') zones[d.z || 0].consigne = d.jour; rep(true, {}); return; }
    rep(false, { erreur: 'action inconnue' });
  });
  s.publier = () => {
    zones.forEach((z, k) => {
      z.temp += (z.consigne - z.temp) * 0.02 + (Math.random() - 0.5) * 0.05;
      client.publish(`${base}/zone${k + 1}/etat`, JSON.stringify({ temp: +z.temp.toFixed(2), consigne: z.consigne, demande: 40, charge: 33,
        chauffe: k === 0 ? '1' : '0', defaut: '0', defaut_libelle: 'aucun', jour: z.consigne, nuit: z.consigne - 5 }), { retain: true });
    });
  };
  return s;
}

// --- une application légère ---------------------------------------------------
function creerApp(j, socles) {
  const client = mqtt.connect(WS, { clientId: 'app-' + j, clean: true, keepalive: 30 });
  const a = { recus: 0, attentes: new Map(), latences: [], perdus: 0, deconnexions: 0, client };
  client.on('connect', () => {
    client.subscribe(socles.map(s => [`${PREFIXE}/${s.id}/+/etat`, `${PREFIXE}/${s.id}/reponse`, `${PREFIXE}/${s.id}/statut`]).flat());
  });
  client.on('close', () => { a.deconnexions++; });
  client.on('message', (sujet, charge) => {
    a.recus++;
    if (!sujet.endsWith('/reponse')) return;
    let r; try { r = JSON.parse(charge.toString()); } catch (e) { return; }
    const t0 = a.attentes.get(r.req);
    if (t0 !== undefined) { a.attentes.delete(r.req); a.latences.push(performance.now() - t0); }
  });
  a.commander = (s, action, params) => {
    const req = `a${j}-${Math.random().toString(36).slice(2, 9)}`;
    a.attentes.set(req, performance.now());
    client.publish(`${PREFIXE}/${s.id}/cmd`, JSON.stringify({ req, action, jeton: JETON, ...params }), { qos: 1 });
    setTimeout(() => { if (a.attentes.has(req)) { a.attentes.delete(req); a.perdus++; } }, 8000);
  };
  return a;
}

(async () => {
  console.log(`\n== Broker : ${NB_SOCLES} socles, ${NB_APPS} applications, ${DUREE_S} s`);
  const socles = Array.from({ length: NB_SOCLES }, (_, i) => creerSocle(i));
  const apps = Array.from({ length: NB_APPS }, (_, j) => creerApp(j, socles));
  await attendre(3000);
  const connectesS = socles.filter(s => s.client.connected).length, connectesA = apps.filter(a => a.client.connected).length;
  v(`tous connectés (${connectesS} socles, ${connectesA} applications)`, connectesS === NB_SOCLES && connectesA === NB_APPS);

  const debut = Date.now();
  let publies = 0, envoyees = 0;
  const minuteurEtats = setInterval(() => { socles.forEach(s => { s.publier(); publies += 2; }); }, 2000);
  const minuteurCmd = setInterval(() => {
    apps.forEach((a, j) => { const s = socles[(envoyees + j) % socles.length]; a.commander(s, 'etat', {}); envoyees++; });
  }, 500);
  await attendre(DUREE_S * 1000);
  clearInterval(minuteurEtats); clearInterval(minuteurCmd);
  await attendre(2500);
  const duree = (Date.now() - debut) / 1000;

  const latences = apps.flatMap(a => a.latences);
  const perdus = apps.reduce((n, a) => n + a.perdus + a.attentes.size, 0);
  const recus = apps.reduce((n, a) => n + a.recus, 0);
  const deconnexions = socles.reduce((n, s) => n + s.deconnexions, 0) + apps.reduce((n, a) => n + a.deconnexions, 0);
  const p50 = centile(latences, 0.5), p95 = centile(latences, 0.95), pire = centile(latences, 1);
  console.log(`   ${publies} états publiés (${(publies / duree).toFixed(0)}/s), ${envoyees} commandes, ${recus} messages reçus par les applications (${(recus / duree).toFixed(0)}/s)`);
  v('aucune déconnexion pendant la charge', deconnexions === 0, `${deconnexions}`);
  v('aucune commande sans réponse', perdus === 0, `${perdus} perdue(s) sur ${envoyees}`);
  v('latence médiane des commandes < 100 ms', p50 < 100, `${p50.toFixed(1)} ms`);
  v('95e centile < 500 ms', p95 < 500, `${p95.toFixed(1)} ms (pire ${pire.toFixed(0)} ms)`);
  v('chaque application a reçu les états de tout le parc', apps.every(a => a.recus >= publies * 0.9), `min ${Math.min(...apps.map(a => a.recus))}`);

  await Promise.all([...socles.map(s => new Promise(r => s.client.end(false, {}, r))), ...apps.map(a => new Promise(r => a.client.end(false, {}, r)))]);

  // --- interface --------------------------------------------------------------
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (e) { /* volet sauté */ }
  if (chromium && NB_INTERFACE > 0) {
    console.log(`\n== Interface : demo.html avec ${NB_INTERFACE} socles dans Chromium`);
    const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const page = await navigateur.newPage({ viewport: { width: 390, height: 844 } });
    const erreurs = [];
    page.on('pageerror', e => erreurs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
    const t0 = Date.now();
    await page.goto('file://' + path.resolve(__dirname, '..', 'app', 'demo.html') + `?socles=${NB_INTERFACE}`);
    await page.waitForFunction(n => document.querySelectorAll('#socles .socle').length >= n, NB_INTERFACE, { timeout: 15000 }).catch(() => {});
    const chargement = Date.now() - t0;
    const nb = await page.evaluate(() => document.querySelectorAll('#socles .socle').length);
    v(`${NB_INTERFACE} socles affichés dans la liste`, nb >= NB_INTERFACE, `${nb} en ${chargement} ms`);
    v('liste rendue en moins de 5 s', chargement < 5000, `${chargement} ms`);
    // Dix secondes de publications (2 zones × N socles toutes les 2 s) : le
    // rendu mémoïsé ne doit pas faire exploser le temps de calcul.
    const mesure = await page.evaluate(async () => {
      const debut = performance.now();
      let images = 0;
      const compter = () => { images++; if (performance.now() - debut < 10000) requestAnimationFrame(compter); };
      requestAnimationFrame(compter);
      await new Promise(r => setTimeout(r, 10000));
      const m = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
      return { images, memoireMo: m };
    });
    v('la page reste fluide sous les publications (≥ 30 images/s)', mesure.images >= 300, `${(mesure.images / 10).toFixed(0)} images/s`);
    const t1 = Date.now();
    await page.evaluate(() => App.ouvrir('terraDEMO010'));
    await page.waitForFunction(() => /Terrarium 10/.test(document.querySelector('#detail').textContent), null, { timeout: 5000 }).catch(() => {});
    v('ouverture d\'un socle du milieu du parc < 1 s', Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
    await page.evaluate(() => App.panneau('courbes'));
    await page.waitForTimeout(1500);
    v('aucune erreur console avec un grand parc', erreurs.length === 0, erreurs[0] || (mesure.memoireMo >= 0 ? `tas JS ${mesure.memoireMo} Mo` : ''));
    await navigateur.close();
  } else {
    console.log('\n== Interface : volet sauté (Playwright absent)');
  }

  console.log(`\n=== ${ko ? 'CHARGE : SEUILS DEPASSES' : 'CHARGE OK'} (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
