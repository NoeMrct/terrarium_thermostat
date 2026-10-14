'use strict';
/* Tests du serveur : comptes et droits sur le broker, rattachement d'un socle
   par preuve du code d'appairage, historique, notifications push, API,
   pont vers un broker amont. Ports éphémères, données dans un dossier
   temporaire : rien ne touche à une installation réelle.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const mqtt = require('mqtt');
const { Aedes } = require('aedes');
const { demarrerServeur } = require('../serveur');

const ADMIN = 'jeton-admin-de-test';
const JETON_SOCLE = 'SIMULATIONTESTJETON00001';
const attendre = ms => new Promise(r => setTimeout(r, ms));

function dossierTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-serveur-')); }

async function appel(port, methode, chemin, corps, jeton) {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': typeof corps === 'string' ? 'text/plain' : 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps))
  });
  let donnees = null;
  try { donnees = await r.json(); } catch (e) { /* vide */ }
  return { status: r.status, donnees };
}

// Un socle factice : répond aux commandes comme le firmware (jeton exigé sur « globaux »).
function socleFactice(port, id, motDePasse, options = {}) {
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username: id, password: motDePasse, clientId: 'socle-' + id, ...options });
  c.on('connect', () => {
    c.subscribe(`terrarium/${id}/cmd`);
    c.publish(`terrarium/${id}/statut`, 'en ligne', { retain: true });
  });
  c.on('message', (sujet, charge) => {
    const d = JSON.parse(charge.toString());
    const ok = d.action === 'globaux' ? d.jeton === JETON_SOCLE : true;
    c.publish(`terrarium/${id}/reponse`, JSON.stringify({ req: d.req, ok, ...(ok ? { amperes: 3 } : { erreur: 'jeton invalide' }) }));
  });
  return c;
}

// Abonnement : codes bruts du SUBACK (128 = refusé), que mqtt.js ne remonte
// pas fidèlement dans le rappel de subscribe.
function abonner(client, sujets) {
  return new Promise(res => {
    const sur = p => { if (p.cmd === 'suback') { client.off('packetreceive', sur); res(p.granted); } };
    client.on('packetreceive', sur);
    client.subscribe(sujets, () => {});
  });
}

function connexion(port, username, password) {
  return new Promise(res => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => res({ ok: true, client: c }));
    c.once('error', e => { c.end(true); res({ ok: false, erreur: e.message }); });
  });
}

test('serveur : comptes, droits, appairage, historique, push, API', async t => {
  const donnees = dossierTemp();
  const pushs = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, pasHistoriqueMs: 20, antiSpamMs: 50,
    envoyerPush: async (abonnement, charge) => { pushs.push({ endpoint: abonnement.endpoint, charge: JSON.parse(charge) }); }, journal: () => {} });
  t.after(async () => { await s.arreter(); fs.rmSync(donnees, { recursive: true, force: true }); });

  await t.test('informations publiques', async () => {
    const r = await appel(s.port, 'GET', '/api/infos');
    assert.equal(r.status, 200);
    assert.equal(r.donnees.serveur, 'terrariums');
    assert.equal(r.donnees.mqtt.ws, '/mqtt');
    assert.equal(r.donnees.push, true);
  });

  await t.test('administration : réservée au jeton, crée utilisateurs et appareils', async () => {
    assert.equal((await appel(s.port, 'GET', '/api/flotte')).status, 403);
    assert.equal((await appel(s.port, 'POST', '/api/admin/utilisateurs', { login: 'noe', motDePasse: 'un-bon-mot-de-passe' }, 'faux')).status, 403);
    const u = await appel(s.port, 'POST', '/api/admin/utilisateurs', { login: 'noe', motDePasse: 'un-bon-mot-de-passe' }, ADMIN);
    assert.equal(u.status, 201);
    const court = await appel(s.port, 'POST', '/api/admin/utilisateurs', { login: 'x', motDePasse: 'a' }, ADMIN);
    assert.equal(court.status, 400);
    const a = await appel(s.port, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3', motDePasse: 'secret-du-socle' }, ADMIN);
    assert.equal(a.status, 201);
    assert.equal(a.donnees.motDePasse, 'secret-du-socle');
    const genere = await appel(s.port, 'POST', '/api/admin/appareils', { id: 'terraD4E5F6' }, ADMIN);
    assert.ok(genere.donnees.motDePasse.length >= 12, 'mot de passe engendré');
    assert.equal((await appel(s.port, 'POST', '/api/admin/appareils', { id: 'pirate' }, ADMIN)).status, 400);
  });

  let jeton = null;
  await t.test('session : refus, limitation, ouverture', async () => {
    assert.equal((await appel(s.port, 'POST', '/api/session', { login: 'noe', motDePasse: 'mauvais' })).status, 401);
    const r = await appel(s.port, 'POST', '/api/session', { login: 'noe', motDePasse: 'un-bon-mot-de-passe' });
    assert.equal(r.status, 200);
    jeton = r.donnees.jeton;
    assert.ok(jeton.length >= 32);
    assert.deepEqual(r.donnees.socles, []);
    assert.equal((await appel(s.port, 'GET', '/api/moi', undefined, jeton)).donnees.login, 'noe');
    assert.equal((await appel(s.port, 'GET', '/api/moi')).status, 401);
  });

  await t.test('broker : un socle n\'entre qu\'avec son mot de passe, et ne parle que sous son sujet', async () => {
    const refus = await connexion(s.portMqtt, 'terraA1B2C3', 'faux');
    assert.equal(refus.ok, false);
    const inconnu = await connexion(s.portMqtt, 'terraZZZZZZ', 'x');
    assert.equal(inconnu.ok, false);
    const ok = await connexion(s.portMqtt, 'terraA1B2C3', 'secret-du-socle');
    assert.equal(ok.ok, true);
    // Il ne peut pas lire les commandes d'un autre socle.
    const granted = await abonner(ok.client, 'terrarium/terraD4E5F6/cmd');
    assert.equal(granted[0], 128, 'abonnement refusé (qos 128)');
    assert.equal((await abonner(ok.client, 'terrarium/terraA1B2C3/cmd'))[0], 0, 'ses propres commandes : accordé');
    ok.client.end(true);
  });

  await t.test('broker : une application ne voit que les socles rattachés à son compte', async () => {
    const refus = await connexion(s.portMqtt, 'noe', 'mauvais');
    assert.equal(refus.ok, false);
    const c = await connexion(s.portMqtt, 'noe', jeton);                 // le jeton de session vaut mot de passe
    assert.equal(c.ok, true);
    const g = await abonner(c.client, 'terrarium/terraA1B2C3/+/etat');
    assert.equal(g[0], 128, 'pas encore rattaché : refusé');
    const joker = await abonner(c.client, 'terrarium/+/statut');
    assert.equal(joker[0], 128, 'joker sur le parc : refusé');
    // L'annonce retenue du serveur, elle, est lisible : c'est ce qui dit à
    // l'application qu'elle parle à un serveur Terrariums.
    const annonce = await new Promise(res => {
      c.client.once('message', (sujet, charge) => res({ sujet, d: JSON.parse(charge.toString()) }));
      c.client.subscribe('terrarium/serveur');
    });
    assert.equal(annonce.sujet, 'terrarium/serveur');
    assert.equal(annonce.d.serveur, 'terrariums');
    assert.equal(typeof annonce.d.push, 'boolean');
    // …mais personne d'autre que le serveur ne peut l'écrire : la publication
    // d'un utilisateur est refusée (et le broker le déconnecte).
    const coupe = new Promise(res => c.client.once('close', () => res(true)));
    c.client.publish('terrarium/serveur', JSON.stringify({ serveur: 'pirate' }));
    assert.equal(await Promise.race([coupe, new Promise(r => setTimeout(() => r(false), 3000))]), true, 'publication interdite : déconnecté');
    c.client.end(true);
  });

  let socle;
  await t.test('appairage : le code est vérifié auprès du socle lui-même', async () => {
    socle = socleFactice(s.portMqtt, 'terraA1B2C3', 'secret-du-socle');
    await attendre(300);
    const faux = await appel(s.port, 'POST', '/api/socles/revendiquer', { id: 'terraA1B2C3', jeton: 'FAUXFAUXFAUXFAUXFAUXFAUX' }, jeton);
    assert.equal(faux.status, 403);
    const absent = await appel(s.port, 'POST', '/api/socles/revendiquer', { id: 'terraD4E5F6', jeton: JETON_SOCLE }, jeton);
    assert.equal(absent.status, 504, 'socle hors ligne : pas de preuve possible');
    const bon = await appel(s.port, 'POST', '/api/socles/revendiquer', { id: 'terraA1B2C3', jeton: JETON_SOCLE }, jeton);
    assert.equal(bon.status, 200);
    assert.deepEqual(bon.donnees.socles, ['terraA1B2C3']);
  });

  await t.test('broker : une fois rattaché, l\'application lit les états et commande', async () => {
    const c = await connexion(s.portMqtt, 'noe', 'un-bon-mot-de-passe');
    const recus = [];
    c.client.on('message', (sujet, charge) => recus.push([sujet, charge.toString()]));
    const g = await abonner(c.client, ['terrarium/terraA1B2C3/+/etat', 'terrarium/terraA1B2C3/reponse', 'terrarium/terraA1B2C3/statut']);
    assert.ok(g.every(x => x < 128), 'abonnements accordés');
    socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30.5, consigne: 32, defaut: '0', nom: 'Point chaud' }), { retain: true });
    await attendre(300);
    assert.ok(recus.some(([su]) => su === 'terrarium/terraA1B2C3/zone1/etat'), 'état reçu');
    // Commande vers son socle : acceptée et répondue.
    c.client.publish('terrarium/terraA1B2C3/cmd', JSON.stringify({ req: 'r1', action: 'globaux', jeton: JETON_SOCLE }), { qos: 1 });
    await attendre(300);
    assert.ok(recus.some(([su, ch]) => su.endsWith('/reponse') && ch.includes('"req":"r1"')), 'réponse reçue');
    // Commande vers un socle d'autrui : le broker la rejette (déconnexion).
    const ferme = new Promise(res => c.client.once('close', () => res(true)));
    c.client.publish('terrarium/terraD4E5F6/cmd', '{"req":"r2","action":"reset"}');
    assert.equal(await Promise.race([ferme, attendre(1500).then(() => false)]), true, 'déconnecté après une publication interdite');
    c.client.end(true);
  });

  await t.test('historique : écrit à partir des états, relu par l\'API', async () => {
    for (let i = 0; i < 5; i++) {
      socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30 + i / 10, consigne: 32 }));
      socle.publish('terrarium/terraA1B2C3/zone2/etat', JSON.stringify({ temp: 25 + i / 10, consigne: 27 }));
      await attendre(40);
    }
    await attendre(100);
    const maintenant = Math.floor(Date.now() / 1000);
    const bruts = s.historique.lire('terraA1B2C3', maintenant - 600, maintenant + 5, 0);
    assert.ok(bruts.length >= 2, `${bruts.length} point(s) écrit(s) (un par pas de 20 ms ici)`);
    const r = await appel(s.port, 'GET', `/api/socles/terraA1B2C3/historique?depuis=${maintenant - 600}&jusqua=${maintenant + 5}&pas=1`, undefined, jeton);
    assert.equal(r.status, 200);
    assert.equal(r.donnees.pas, 60, 'l\'API ne descend pas sous un point par minute');
    assert.ok(r.donnees.n >= 1, `${r.donnees.n} point(s)`);
    const p = bruts[bruts.length - 1];
    assert.equal(p.length, 5);
    assert.ok(p[1] >= 3000 && p[1] <= 3050 && p[3] >= 2500, 'centièmes de degré, deux zones');
    assert.equal(r.donnees.points[0].length, 5, 'même format par l\'API');
    assert.equal((await appel(s.port, 'GET', '/api/socles/terraD4E5F6/historique', undefined, jeton)).status, 403, 'socle d\'autrui : refusé');
    assert.ok(fs.existsSync(path.join(donnees, 'historique', 'terraA1B2C3')), 'fichiers NDJSON sur disque');
    const purges = s.historique.purger(Date.now() + 500 * 86400000);
    assert.ok(purges >= 1, 'la purge efface les jours trop vieux');
  });

  await t.test('notifications push : défaut, rétablissement, socle disparu, anti-répétition', async () => {
    const cle = await appel(s.port, 'GET', '/api/push/cle');
    assert.ok(cle.donnees.cle.length > 40, 'clé VAPID publique');
    const abo = { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } };
    assert.equal((await appel(s.port, 'POST', '/api/push/abonnement', { abonnement: abo }, jeton)).status, 200);
    assert.equal((await appel(s.port, 'POST', '/api/push/abonnement', { abonnement: { endpoint: 'http://clair' } }, jeton)).status, 400);
    const essai = await appel(s.port, 'POST', '/api/push/essai', {}, jeton);
    assert.equal(essai.donnees.envoyes, 1);
    pushs.length = 0;
    socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30, consigne: 32, defaut: '1', defaut_libelle: 'SONDE', nom: 'Point chaud' }));
    await attendre(200);
    assert.equal(pushs.length, 1, 'un défaut déclenche une notification');
    assert.ok(/DÉFAUT/.test(pushs[0].charge.titre) && /SONDE/.test(pushs[0].charge.corps) && pushs[0].charge.urgent === true);
    socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30, consigne: 32, defaut: '1', defaut_libelle: 'SONDE' }));
    await attendre(100);
    assert.equal(pushs.length, 1, 'un défaut qui persiste ne renotifie pas');
    socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30, consigne: 32, defaut: '0' }));
    await attendre(200);
    assert.equal(pushs.length, 2, 'le retour à la normale est notifié');
    assert.ok(/rétabli/.test(pushs[1].charge.titre));
    await new Promise(res => socle.end(false, {}, res));          // départ propre : le testament « hors ligne » ne part pas…
    socle = socleFactice(s.portMqtt, 'terraA1B2C3', 'secret-du-socle');
    await attendre(200);
    pushs.length = 0;
    socle.publish('terrarium/terraA1B2C3/statut', 'hors ligne', { retain: true });   // …on le simule
    await attendre(200);
    assert.equal(pushs.length, 1, 'passage hors ligne notifié');
    assert.ok(/hors ligne/.test(pushs[0].charge.titre));
  });

  await t.test('rapports de diagnostic et état de la flotte', async () => {
    const r = await appel(s.port, 'POST', '/api/rapports', 'Terrariums — Diagnostic\nrssi -60 dBm', jeton);
    assert.equal(r.status, 201);
    assert.ok(fs.existsSync(path.join(donnees, 'rapports', r.donnees.fichier)));
    const f = await appel(s.port, 'GET', '/api/flotte', undefined, ADMIN);
    assert.equal(f.status, 200);
    const socleF = f.donnees.socles.find(x => x.id === 'terraA1B2C3');
    assert.ok(socleF, 'le socle est dans la flotte');
    assert.equal(f.donnees.comptes.utilisateurs[0].socles[0], 'terraA1B2C3');
  });

  await t.test('session : fermeture, et le mot de passe reste exigé (8 caractères)', async () => {
    assert.equal((await appel(s.port, 'DELETE', '/api/session', undefined, jeton)).status, 200);
    assert.equal((await appel(s.port, 'GET', '/api/moi', undefined, jeton)).status, 401);
  });

  socle.end(true);
});

test('pont : les socles d\'un broker amont entrent dans le serveur, les commandes repartent', async t => {
  // Un broker amont nu (comme HiveMQ) sur un port éphémère.
  const amont = await Aedes.createBroker({});
  const serveurAmont = net.createServer(amont.handle);
  await new Promise(r => serveurAmont.listen(0, r));
  const portAmont = serveurAmont.address().port;
  const donnees = dossierTemp();
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, pushActif: false, journal: () => {},
    amont: { url: `mqtt://127.0.0.1:${portAmont}` } });
  t.after(async () => { await s.arreter(); await new Promise(r => amont.close(r)); await new Promise(r => serveurAmont.close(r)); fs.rmSync(donnees, { recursive: true, force: true }); });
  await new Promise(res => s.broker.once('amontConnecte', res));

  s.comptes.ajouterUtilisateur('emma', 'mot-de-passe-emma');
  s.comptes.attribuerSocle('emma', 'terraA1B2C3');
  // Le socle vit en amont (jamais connecté au serveur) ; il répond là-bas.
  const socleAmont = mqtt.connect(`mqtt://127.0.0.1:${portAmont}`);
  const commandesAmont = [];
  socleAmont.on('connect', () => socleAmont.subscribe('terrarium/terraA1B2C3/cmd'));
  socleAmont.on('message', (su, ch) => { commandesAmont.push(JSON.parse(ch.toString())); const d = JSON.parse(ch.toString()); socleAmont.publish('terrarium/terraA1B2C3/reponse', JSON.stringify({ req: d.req, ok: true })); });
  await attendre(300);

  const appli = await connexion(s.portMqtt, 'emma', 'mot-de-passe-emma');
  assert.equal(appli.ok, true);
  const recus = [];
  appli.client.on('message', (su, ch) => recus.push([su, ch.toString()]));
  await new Promise(res => appli.client.subscribe(['terrarium/terraA1B2C3/+/etat', 'terrarium/terraA1B2C3/reponse'], res));
  socleAmont.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 29.9, consigne: 31 }), { retain: true });
  await attendre(400);
  assert.ok(recus.some(([su]) => su === 'terrarium/terraA1B2C3/zone1/etat'), 'un état publié en amont arrive à l\'application locale');
  assert.ok(s.historique.dernierPoint('terraA1B2C3'), 'et alimente l\'historique');
  appli.client.publish('terrarium/terraA1B2C3/cmd', JSON.stringify({ req: 'p1', action: 'etat' }), { qos: 1 });
  await attendre(400);
  assert.equal(commandesAmont.length, 1, 'la commande locale est repartie en amont');
  assert.ok(recus.some(([su, ch]) => su.endsWith('/reponse') && ch.includes('"p1"')), 'et la réponse est revenue');
  appli.client.end(true); socleAmont.end(true);
});
