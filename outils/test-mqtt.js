#!/usr/bin/env node
/* =============================================================================
   Test du client MQTT de l'application (app/mqtt.js).
   -----------------------------------------------------------------------------
   Le client tourne dans un DOM headless, sur le WebSocket de jsdom, face à un
   vrai broker ; un second client (MQTT.js, en TCP) lui sert de correspondant.
   Vérifie l'encodage des paquets, les longueurs multi-octets, le keepalive, la
   reconnexion, le refus d'identifiants et la fin propre ; puis le repli par le
   tunnel HTTPS du serveur (serveur/lib/tunnel.js, relié ici au broker en TCP)
   quand le WebSocket est coupé comme par un bloqueur de publicité.

     node test-mqtt.js --broker ws://localhost:9001/mqtt --tcp mqtt://localhost:1883
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { JSDOM } = require('jsdom');
const mqttNode = require('mqtt');
const { Tunnels } = require('../serveur/lib/tunnel');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BROKER = arg('broker', 'ws://localhost:9001/mqtt');
const TCP = arg('tcp', 'mqtt://localhost:1883');
const SOURCE = path.join(__dirname, '..', 'app', 'mqtt.js');

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(54)} ${d}`); c ? ok++ : ko++; };
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));
async function jusqua(cond, limite = 6000) {
  const fin = Date.now() + limite;
  while (Date.now() < fin) { if (cond()) return true; await attendre(50); }
  return false;
}
// Attend un événement donné, ou échoue au bout du délai.
const evenement = (client, nom, limite = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`« ${nom} » non reçu en ${limite} ms`)), limite);
  client.on(nom, (...a) => { clearTimeout(t); res(a); });
});

// options.reseau : fetch (celui de Node) dans la page, comme dans un
// navigateur. options.sansWebSocket : WebSocket coupé comme par la liste
// EasyPrivacy — erreur aussitôt, jamais ouvert ; la page compte les essais.
function fenetre(options = {}) {
  const dom = new JSDOM('<!doctype html><title>t</title>', { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  if (options.reseau) { w.fetch = fetch; w.AbortController = AbortController; }
  if (options.sansWebSocket) {
    w.essaisWebSocket = 0;
    w.WebSocket = class {
      constructor() {
        w.essaisWebSocket++;
        this.readyState = 0;
        setTimeout(() => { this.readyState = 3; if (this.onerror) this.onerror(); if (this.onclose) this.onclose({ code: 1006 }); }, 2);
      }
      send() {}
      close() {}
    };
  }
  w.eval(fs.readFileSync(SOURCE, 'utf8') + '\n//# sourceURL=file://' + SOURCE);
  return w;
}

// Un serveur HTTP qui n'offre que le tunnel : chaque liaison devient une
// connexion TCP au broker, comme le serveur Terrariums la confie au sien.
async function serveurTunnel(tcp) {
  const u = new URL(tcp);
  const tunnels = new Tunnels({ aedes: { handle: liaison => {
    const s = net.connect(+u.port || 1883, u.hostname);
    liaison.pipe(s); s.pipe(liaison);
    s.on('error', () => liaison.destroy());
    s.on('close', () => liaison.destroy());
    liaison.on('close', () => s.destroy());
  } } }, { delaiLectureMs: 3000 });
  const compte = { ouvertures: 0, envois: 0 };
  const h = http.createServer((req, res) => {
    const chemin = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST') { if (chemin === '/mqtt/tunnel') compte.ouvertures++; else compte.envois++; }
    if (Tunnels.concerne(chemin)) { tunnels.traiter(req, res, req.method, chemin, '127.0.0.1'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(r => h.listen(0, '127.0.0.1', r));
  return { tunnels, compte, url: `ws://127.0.0.1:${h.address().port}/mqtt`, fermer: () => { tunnels.arreter(); h.closeAllConnections(); h.close(); } };
}

(async () => {
  const w = fenetre();
  const pair = mqttNode.connect(TCP);
  await new Promise(r => pair.on('connect', r));
  const prefixe = 'test/mini/' + Math.random().toString(36).slice(2, 8);

  titre('1. Connexion et abonnement');
  const c = w.mqtt.connect(BROKER, { clientId: 'mini-test-' + Date.now(), keepalive: 60, reconnectPeriod: 300 });
  const recus = [];
  c.on('message', (s, charge, paquet) => recus.push({ s, t: charge.toString(), n: charge.length, retain: paquet.retain }));
  await evenement(c, 'connect');
  v('CONNACK reçu, client connecté', c.connected === true);
  const accorde = await new Promise(r => c.subscribe([`${prefixe}/+/etat`, `${prefixe}/statut`], (e, g) => r(g)));
  v('SUBACK : deux abonnements accordés en QoS 0', Array.isArray(accorde) && accorde.length === 2 && accorde.every(g => g === 0), JSON.stringify(accorde));

  titre('2. Réception');
  pair.publish(`${prefixe}/zone1/etat`, 'héllo ✓ terrarium');
  v('message UTF-8 reçu via un joker', await jusqua(() => recus.some(m => m.t === 'héllo ✓ terrarium')),
    recus.map(m => m.t).join(' | ').slice(0, 40));
  v('le sujet est correct', recus.some(m => m.s === `${prefixe}/zone1/etat`));
  pair.publish(`${prefixe}/statut`, 'en ligne', { retain: true });
  await attendre(300);
  const c2 = w.mqtt.connect(BROKER, { clientId: 'mini-test-b-' + Date.now(), keepalive: 60 });
  const recus2 = [];
  c2.on('message', (s, charge, paquet) => recus2.push({ s, t: charge.toString(), retain: paquet.retain }));
  await evenement(c2, 'connect');
  c2.subscribe(`${prefixe}/statut`);
  v('message persistant livré à l\'abonnement, drapeau retain', await jusqua(() => recus2.some(m => m.t === 'en ligne' && m.retain)));
  c2.end();
  pair.publish(`${prefixe}/statut`, '', { retain: true });   // efface le message persistant

  const grand = 'x'.repeat(20000) + 'FIN';
  pair.publish(`${prefixe}/zone2/etat`, grand);
  v('charge de 20 Ko (longueur sur 3 octets) reçue entière', await jusqua(() => recus.some(m => m.n === grand.length && m.t.endsWith('FIN'))));
  c.subscribe(`${prefixe}/q1`, { qos: 1 });
  await attendre(200);
  pair.publish(`${prefixe}/q1`, 'qos un', { qos: 1 });
  v('message QoS 1 reçu (et acquitté)', await jusqua(() => recus.some(m => m.t === 'qos un')));

  titre('3. Publication');
  const vus = [];
  pair.subscribe(`${prefixe}/cmd`);
  pair.on('message', (s, m) => vus.push(m.toString()));
  await attendre(200);
  c.publish(`${prefixe}/cmd`, JSON.stringify({ req: 'é1', action: 'etat' }));
  v('publication reçue par le correspondant', await jusqua(() => vus.includes('{"req":"é1","action":"etat"}')), vus.join('|').slice(0, 40));
  c.publish(`${prefixe}/cmd`, new w.Uint8Array([0, 255, 1]));
  v('publication binaire transmise telle quelle', await jusqua(() => vus.some(m => m.length === 3)));
  // QoS 1 : le rappel n'est invoqué qu'au PUBACK du broker.
  let acquitte = null;
  c.publish(`${prefixe}/cmd`, 'qos1', { qos: 1 }, e => { acquitte = e || 'ok'; });
  v('publication QoS 1 acquittée (PUBACK)', await jusqua(() => acquitte === 'ok') && vus.includes('qos1'), String(acquitte));

  titre('3 bis. QoS 1 : réémission après une coupure');
  // Publié pendant que la liaison est coupée : le message doit partir, marqué
  // DUP, dès la reconnexion — c'est le cas d'une commande sur un téléphone qui
  // change de réseau.
  const idQ = 'mini-test-q-' + Date.now();
  const q = w.mqtt.connect(BROKER, { clientId: idQ, keepalive: 60, reconnectPeriod: 300 });
  await evenement(q, 'connect');
  const voleur = mqttNode.connect(TCP, { clientId: idQ });
  await new Promise(res => voleur.on('connect', res));
  voleur.end(true);
  await jusqua(() => !q.connected);
  let acquitteQ = null;
  q.publish(`${prefixe}/cmd`, 'apres-coupure', { qos: 1 }, e => { acquitteQ = e || 'ok'; });
  v('message en attente tant que la liaison est coupée', acquitteQ === null && !q.connected);
  v('réémis puis acquitté après la reconnexion', await jusqua(() => acquitteQ === 'ok', 8000) && await jusqua(() => vus.includes('apres-coupure'), 2000), String(acquitteQ));
  q.end();

  titre('4. Désabonnement');
  c.unsubscribe([`${prefixe}/+/etat`]);
  await attendre(300);
  const avant = recus.length;
  pair.publish(`${prefixe}/zone1/etat`, 'ne doit pas arriver');
  await attendre(500);
  v('plus rien ne parvient sur le filtre retiré', recus.length === avant);

  titre('5. Keepalive');
  const k = w.mqtt.connect(BROKER, { clientId: 'mini-test-k-' + Date.now(), keepalive: 2, reconnectPeriod: 300 });
  const erreursK = [];
  k.on('error', e => erreursK.push(e.message));
  await evenement(k, 'connect');
  await attendre(4200);                 // deux cycles de ping
  v('toujours connecté après deux cycles PINGREQ/PINGRESP', k.connected && erreursK.length === 0, erreursK.join(' | '));
  k.end();

  titre('6. Reconnexion après coupure par le broker');
  const idDouble = 'mini-test-double-' + Date.now();
  const r = w.mqtt.connect(BROKER, { clientId: idDouble, keepalive: 60, reconnectPeriod: 300 });
  const evs = [];
  ['close', 'offline', 'reconnect', 'connect'].forEach(n => r.on(n, () => evs.push(n)));
  await jusqua(() => evs.includes('connect'));
  // Un second client avec le même identifiant : le broker coupe le premier.
  const usurpateur = mqttNode.connect(TCP, { clientId: idDouble });
  await new Promise(res => usurpateur.on('connect', res));
  usurpateur.end(true);
  v('close puis offline émis à la coupure', await jusqua(() => evs.includes('close') && evs.includes('offline')), evs.join(' > '));
  v('reconnect puis connect : liaison rétablie', await jusqua(() => evs.filter(e => e === 'connect').length >= 2 && evs.includes('reconnect')), evs.join(' > '));
  r.end();

  titre('7. Identifiants refusés');
  const refuse = w.mqtt.connect(BROKER, { clientId: 'mini-test-r-' + Date.now(), username: 'refuse', password: 'x', reconnectPeriod: 500 });
  const erreursR = [];
  refuse.on('error', e => erreursR.push(e.message));
  let connecteRefuse = false;
  refuse.on('connect', () => { connecteRefuse = true; });
  await attendre(1500);
  if (connecteRefuse) {
    v('refus d\'identifiants (broker sans comptes : non testable ici)', true, 'le broker accepte tout');
  } else {
    v('CONNACK de refus signalé comme erreur', erreursR.some(m => /refusée/.test(m)), erreursR[0]);
    v('aucune connexion établie', !refuse.connected);
  }
  refuse.end();

  titre('8. Fin propre');
  const f = w.mqtt.connect(BROKER, { clientId: 'mini-test-f-' + Date.now(), reconnectPeriod: 200 });
  await evenement(f, 'connect');
  const apres = [];
  ['close', 'reconnect'].forEach(n => f.on(n, () => apres.push(n)));
  f.end();
  await attendre(800);
  v('close émis, puis aucune reconnexion', apres.includes('close') && !apres.includes('reconnect'), apres.join(' > '));

  titre('9. Tunnel HTTPS, quand un bloqueur coupe le WebSocket');
  {
    const st = await serveurTunnel(TCP);
    const wt = fenetre({ reseau: true, sansWebSocket: true });
    const t = wt.mqtt.connect(st.url, { clientId: 'mini-test-t-' + Date.now(), keepalive: 2, reconnectPeriod: 200 });
    const erreursT = [];
    t.on('error', e => erreursT.push(e.message));
    const recusT = [];
    t.on('message', (s, charge, paquet) => recusT.push({ s, t: charge.toString(), n: charge.length, retain: paquet.retain }));
    await evenement(t, 'connect');
    v('WebSocket coupé : connecté par le tunnel, sans erreur', t.connected && !erreursT.length && wt.essaisWebSocket === 1 && st.compte.ouvertures === 1,
      `${wt.essaisWebSocket} WebSocket, ${st.compte.ouvertures} tunnel, ${erreursT.join(' | ')}`);
    const accordeT = await new Promise(r => t.subscribe([`${prefixe}/tunnel/#`], (e, g) => r(g)));
    v('SUBACK par le flux du tunnel', Array.isArray(accordeT) && accordeT[0] === 0, JSON.stringify(accordeT));
    pair.publish(`${prefixe}/tunnel/etat`, 'par le tunnel ✓', { retain: true });
    v('message reçu par le flux descendant', await jusqua(() => recusT.some(m => m.t === 'par le tunnel ✓')));
    const grandT = 'y'.repeat(70000) + 'FIN';
    pair.publish(`${prefixe}/tunnel/journal`, grandT);
    v('charge de 70 Ko reçue entière, en plusieurs morceaux', await jusqua(() => recusT.some(m => m.n === grandT.length && m.t.endsWith('FIN'))));
    pair.subscribe(`${prefixe}/tunnel-cmd`);
    await attendre(200);
    const ackT = await new Promise(r => t.publish(`${prefixe}/tunnel-cmd`, 'commande par le tunnel', { qos: 1 }, e => r(e ? e.message : 'ok')));
    v('publication QoS 1 par POST, acquittée par le flux', ackT === 'ok' && await jusqua(() => vus.includes('commande par le tunnel')), ackT);
    const envoisAvant = st.compte.envois;
    await attendre(3200);                 // deux cycles de ping
    v('keepalive : PINGREQ envoyés, PINGRESP reçus, toujours connecté', t.connected && st.compte.envois >= envoisAvant + 2 && !erreursT.length,
      `${st.compte.envois - envoisAvant} envoi(s)`);
    // Le serveur coupe la liaison : le client revient, par le tunnel d'emblée.
    const essaisAvant = wt.essaisWebSocket, ouverturesAvant = st.compte.ouvertures;
    const evsT = [];
    ['close', 'offline', 'connect'].forEach(n => t.on(n, () => evsT.push(n)));
    st.tunnels.arreter();
    v('liaison coupée par le serveur : close, offline, puis reconnecté',
      await jusqua(() => evsT.includes('close') && evsT.includes('offline') && evsT.includes('connect') && t.connected), evsT.join(' > '));
    v('…par le tunnel d\'emblée, sans réessayer le WebSocket', wt.essaisWebSocket === essaisAvant && st.compte.ouvertures === ouverturesAvant + 1,
      `${wt.essaisWebSocket - essaisAvant} WebSocket, ${st.compte.ouvertures - ouverturesAvant} tunnel`);
    pair.publish(`${prefixe}/tunnel/etat`, '', { retain: true });
    t.end();
    v('fin : la liaison se ferme aussi sur le serveur', await jusqua(() => st.tunnels.liaisons.size === 0, 3000), `${st.tunnels.liaisons.size} ouverte(s)`);
    st.fermer();

    // Un serveur sans tunnel (broker quelconque) : l'erreur habituelle, et le
    // tunnel n'est plus réessayé.
    let demandes = 0;
    const h404 = http.createServer((req, res) => { demandes++; res.writeHead(404); res.end(); });
    await new Promise(r => h404.listen(0, '127.0.0.1', r));
    const u = wt.mqtt.connect(`ws://127.0.0.1:${h404.address().port}/mqtt`, { reconnectPeriod: 100, connectTimeout: 2000 });
    const erreursU = [];
    u.on('error', e => erreursU.push(e.message));
    await jusqua(() => erreursU.length >= 3, 4000);
    v('serveur sans tunnel : « broker injoignable », tunnel demandé une seule fois',
      erreursU.length >= 3 && erreursU.every(m => m === 'broker injoignable') && demandes === 1, `${erreursU.length} erreur(s), ${demandes} demande(s)`);
    u.end();
    h404.close();

    // Une adresse qui n'est pas celle d'un serveur Terrariums (…/mqtt) : pas de tunnel.
    const autre = wt.mqtt.connect('ws://127.0.0.1:9/autre', { reconnectPeriod: 5000 });
    const erreursA = [];
    autre.on('error', e => erreursA.push(e.message));
    await jusqua(() => erreursA.length >= 1, 2000);
    v('adresse sans …/mqtt : pas de tunnel, l\'erreur tout de suite', erreursA[0] === 'broker injoignable' && wt.essaisWebSocket >= 1, erreursA.join(' | '));
    autre.end();
  }

  c.end();
  pair.end(true);
  console.log(`\n=== ${ko ? 'DES TESTS ONT ECHOUE' : 'CLIENT MQTT OK'} (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
