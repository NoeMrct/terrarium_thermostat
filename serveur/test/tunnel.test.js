'use strict';
/* Tunnel MQTT par HTTPS (navigateurs dont un bloqueur coupe le WebSocket) :
   un vrai client MQTT passe par le tunnel — identifiants vérifiés par le
   broker, messages retenus et en direct, commande au socle, droits par sujet ;
   puis les garde-fous (liaison inconnue, second lecteur, envoi trop grand,
   liaison jamais lue, plafond par adresse, origine autorisée) et un arrêt du
   serveur que des flux ouverts ne retiennent pas.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Duplex } = require('stream');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');

const attendre = ms => new Promise(r => setTimeout(r, ms));
async function jusqua(condition, delaiMs = 4000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) { if (await condition()) return true; await attendre(20); }
  return false;
}

// Le côté navigateur du tunnel, pour MQTT.js : un flux duplex dont la lecture
// est le GET au fil de l'eau et chaque écriture un POST, dans l'ordre.
function fluxTunnel(port, liaisons) {
  const base = `http://127.0.0.1:${port}/mqtt/tunnel`;
  const arret = new AbortController();
  let url = null, file = Promise.resolve();
  const d = new Duplex({
    read() {},
    write(morceau, codage, suite) {
      file = file.then(() => pret)
        .then(() => fetch(url, { method: 'POST', body: morceau, headers: { 'Content-Type': 'application/octet-stream' } }))
        .then(r => { if (!r.ok) throw new Error(`POST ${r.status}`); })
        .then(() => suite(), e => suite(e));
    },
    destroy(err, suite) { arret.abort(); suite(err); }
  });
  const pret = (async () => {
    const r = await fetch(base, { method: 'POST' });
    const { id } = await r.json();
    url = `${base}/${id}`;
    if (liaisons) liaisons.push(id);
    const flux = await fetch(url, { signal: arret.signal });
    (async () => {
      try { for await (const m of flux.body) d.push(Buffer.from(m)); d.push(null); } catch (e) { d.destroy(); }
    })();
  })();
  pret.catch(e => d.destroy(e));
  return d;
}

function clientTunnel(port, username, password, liaisons) {
  return new Promise((res, rej) => {
    const c = new mqtt.MqttClient(() => fluxTunnel(port, liaisons), {
      username, password, clientId: 'tunnel-' + Math.random().toString(16).slice(2, 10),
      protocolVersion: 4, keepalive: 30, clean: true, reconnectPeriod: 0, connectTimeout: 4000
    });
    c.recu = [];
    c.on('message', (sujet, charge, paquet) => c.recu.push({ sujet, charge: charge.toString(), retain: paquet.retain }));
    c.once('connect', () => res(c));
    c.once('error', rej);
  });
}

function clientTcp(port, username, password) {
  return new Promise((res, rej) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.recu = [];
    c.on('message', (sujet, charge) => c.recu.push({ sujet, charge: charge.toString() }));
    c.once('connect', () => res(c));
    c.once('error', rej);
  });
}

// Le code brut du SUBACK (128 = refusé).
const abonner = (c, sujet) => new Promise(res => {
  const sur = p => { if (p.cmd === 'suback') { c.off('packetreceive', sur); res(p.granted[0]); } };
  c.on('packetreceive', sur);
  c.subscribe(sujet, { qos: 0 }, () => {});
});

test('tunnel HTTPS : le même MQTT que le WebSocket, avec ses garde-fous', async () => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-tunnel-'));
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: 'jeton-admin-de-test', journal: () => {}, pushActif: false,
    origines: ['https://app.exemple.fr'], tunnelsParIp: 6, tunnelDelaiLectureMs: 200 });
  const P = s.port;
  const base = `http://127.0.0.1:${P}/mqtt/tunnel`;
  const fermer = [];
  let arrete = false;
  try {
    s.comptes.obtenirParEmail('noe@exemple.fr');
    const jeton = s.comptes.ouvrirSession('noe@exemple.fr');
    s.comptes.attribuerSocle('noe@exemple.fr', 'terraTUN001');
    const { motDePasse } = s.comptes.ajouterAppareil('terraTUN001');
    const socle = await clientTcp(s.portMqtt, 'terraTUN001', motDePasse);
    fermer.push(socle);
    await socle.subscribeAsync('terrarium/terraTUN001/cmd');
    await socle.publishAsync('terrarium/terraTUN001/zone1/etat', '{"t":28.5}', { retain: true, qos: 1 });

    // Annoncé par /api/infos, ouvert pour l'origine autorisée.
    const infos = await (await fetch(`http://127.0.0.1:${P}/api/infos`)).json();
    assert.equal(infos.mqtt.tunnel, '/mqtt/tunnel');
    const r = await fetch(base, { method: 'POST', headers: { Origin: 'https://app.exemple.fr' } });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.exemple.fr');
    const { id } = await r.json();
    assert.match(id, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(s.tunnels.liaisons.size, 1);
    const autre = await fetch(base, { method: 'POST', headers: { Origin: 'https://ailleurs.exemple' } });
    assert.equal(autre.headers.get('access-control-allow-origin'), null, 'une origine inconnue ne lit pas la réponse');
    assert.equal((await fetch(`${base}/${(await autre.json()).id}`, { method: 'DELETE' })).status, 204);

    // Un lecteur par liaison ; DELETE ferme, puis la liaison est inconnue.
    const lecteur = new AbortController();
    const flux = await fetch(`${base}/${id}`, { signal: lecteur.signal });
    assert.equal(flux.status, 200);
    assert.match(flux.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(`${base}/${id}`)).status, 409, 'un second lecteur est refusé');
    assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE' })).status, 204);
    lecteur.abort();
    assert.ok(await jusqua(() => s.tunnels.liaisons.size === 0), 'liaison fermée');
    assert.equal((await fetch(`${base}/${id}`, { method: 'POST', body: Buffer.from([0xc0, 0]) })).status, 404);
    assert.equal((await fetch(base)).status, 405, 'GET sans identifiant : rien à lire');

    // Une liaison que personne ne lit ne garde pas sa place.
    const oubliee = (await (await fetch(base, { method: 'POST' })).json()).id;
    assert.ok(await jusqua(() => !s.tunnels.liaisons.has(oubliee), 2000), 'liaison jamais lue, fermée après le délai');

    // Un vrai client MQTT par le tunnel : le compte, son socle, ses droits.
    const ids = [];
    const c = await clientTunnel(P, 'noe@exemple.fr', jeton, ids);
    fermer.push(c);
    assert.equal(ids.length, 1);
    assert.equal(await abonner(c, 'terrarium/terraTUN001/#'), 0);
    assert.ok(await jusqua(() => c.recu.some(m => m.sujet === 'terrarium/terraTUN001/zone1/etat' && m.retain)), 'état retenu reçu par le tunnel');
    socle.publish('terrarium/terraTUN001/zone2/etat', '{"t":31}');
    assert.ok(await jusqua(() => c.recu.some(m => m.sujet === 'terrarium/terraTUN001/zone2/etat' && !m.retain)), 'état en direct reçu');
    await c.publishAsync('terrarium/terraTUN001/cmd', '{"action":"etat"}', { qos: 1 });
    assert.ok(await jusqua(() => socle.recu.some(m => m.charge === '{"action":"etat"}')), 'commande arrivée au socle');
    assert.equal(await abonner(c, 'terrarium/terraAUTRE1/#'), 128, 'le socle d\'un autre compte reste fermé');
    const grand = 'x'.repeat(100000);
    socle.publish('terrarium/terraTUN001/zone1/journal', grand);
    assert.ok(await jusqua(() => c.recu.some(m => m.charge.length === grand.length)), 'message de 100 Ko reçu entier');

    // De mauvais identifiants : le broker refuse, comme par le WebSocket.
    await assert.rejects(clientTunnel(P, 'noe@exemple.fr', 'pas-le-jeton'), /Bad username or password|Not authorized/);

    // Envoi trop grand, liaison inconnue.
    const t2 = (await (await fetch(base, { method: 'POST' })).json()).id;
    assert.equal((await fetch(`${base}/${t2}`, { method: 'POST', body: Buffer.alloc(300 * 1024) }).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await fetch(`${base}/AAAAAAAAAAAAAAAAAAAAAAAA`)).status, 404);

    // Plafond par adresse.
    const ouvertes = [];
    let code = 201;
    while (code === 201 && ouvertes.length < 10) {
      const x = await fetch(base, { method: 'POST' });
      code = x.status;
      if (code === 201) ouvertes.push((await x.json()).id);
    }
    assert.equal(code, 429, 'trop de liaisons depuis une même adresse');
    assert.ok(ouvertes.length <= 6);

    // L'arrêt du serveur n'attend pas la fin des flux ouverts : le client du
    // tunnel reste connecté (le socle TCP, lui, part avant, comme ailleurs).
    await socle.endAsync();
    assert.ok(c.connected);
    const arret = await Promise.race([s.arreter().then(() => 'arrêté'), attendre(4000).then(() => 'bloqué')]);
    arrete = arret === 'arrêté';
    assert.equal(arret, 'arrêté');
  } finally {
    for (const c of fermer) c.end(true);
    if (!arrete) await s.arreter().catch(() => {});
    fs.rmSync(donnees, { recursive: true, force: true });
  }
});
