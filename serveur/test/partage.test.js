'use strict';
/* Partage d'un socle (F12) : invitation à usage unique, droits « lecture » et
   « reglage » appliqués par le broker, fin d'accès, retrait, et le dernier
   titulaire parti. Ports éphémères, données dans un dossier temporaire.
     node --test test/partage.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');

const ADMIN = 'jeton-admin-de-test';
const JETON_SOCLE = 'SIMULATIONTESTJETON00001';
const attendre = ms => new Promise(r => setTimeout(r, ms));

async function appel(port, methode, chemin, corps, jeton) {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps)
  });
  let donnees = null;
  try { donnees = await r.json(); } catch (e) { /* vide */ }
  return { status: r.status, donnees };
}

// Un socle qui répond à toute commande, et compte ce qu'il reçoit.
function socleFactice(port, id, motDePasse) {
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username: id, password: motDePasse, clientId: 'socle-' + id });
  c.recues = [];
  c.on('connect', () => {
    c.subscribe(`terrarium/${id}/cmd`);
    c.publish(`terrarium/${id}/statut`, 'en ligne', { retain: true });
  });
  c.on('message', (sujet, charge) => {
    let d = JSON.parse(charge.toString());
    if (typeof d.c === 'string') {
      const signee = d.sig === crypto.createHmac('sha256', JETON_SOCLE).update(d.c).digest('hex');
      d = JSON.parse(d.c);
      d.signee = signee;
    }
    c.recues.push(d.action);
    c.publish(`terrarium/${id}/reponse`, JSON.stringify({ req: d.req, ok: true }));
  });
  return c;
}

function connexion(port, username, password) {
  return new Promise(res => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => res(c));
    c.once('error', e => { c.end(true); res(null); });
  });
}

// Publie une commande ; vrai si le broker l'a laissée passer (un refus coupe la connexion).
function publier(client, sujet, charge) {
  return new Promise(res => {
    let fini = false;
    const fin = v => { if (!fini) { fini = true; res(v); } };
    client.once('close', () => fin(false));
    client.publish(sujet, charge, { qos: 1 }, err => { if (err) fin(false); else setTimeout(() => fin(client.connected), 150); });
  });
}

test('partage d\'un socle (F12)', async t => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-partage-'));
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, pushActif: false, journal: () => {} });
  let socle = null;
  t.after(async () => {
    if (socle) await new Promise(res => socle.end(true, {}, res));
    await s.arreter();
    fs.rmSync(donnees, { recursive: true, force: true });
  });

  for (const login of ['titulaire', 'lea', 'max']) {
    assert.equal((await appel(s.port, 'POST', '/api/admin/utilisateurs', { login, motDePasse: 'un-bon-mot-de-passe' }, ADMIN)).status, 201);
  }
  assert.equal((await appel(s.port, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3', motDePasse: 'secret-du-socle' }, ADMIN)).status, 201);
  const session = async login => (await appel(s.port, 'POST', '/api/session', { login, motDePasse: 'un-bon-mot-de-passe' })).donnees.jeton;
  const [jT, jL, jM] = [await session('titulaire'), await session('lea'), await session('max')];
  socle = socleFactice(s.portMqtt, 'terraA1B2C3', 'secret-du-socle');
  await attendre(300);
  const rev = await appel(s.port, 'POST', '/api/socles/revendiquer', { id: 'terraA1B2C3', jeton: JETON_SOCLE }, jT);
  assert.equal(rev.status, 200, 'le titulaire rattache son socle');

  await t.test('inviter : le titulaire seul, droits et durée vérifiés', async () => {
    assert.equal((await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture', jours: 14 }, jL)).status, 403, 'pas à Léa de partager');
    assert.equal((await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'tout', jours: 14 }, jT)).status, 400);
    assert.equal((await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture', jours: 999 }, jT)).status, 400);
    const p = await appel(s.port, 'GET', '/api/socles/terraA1B2C3/partages', undefined, jT);
    assert.equal(p.status, 200);
    assert.deepEqual(p.donnees.acces.map(a => [a.login, a.droit, a.moi]), [['titulaire', 'titulaire', true]]);
  });

  let codeLecture = null;
  await t.test('lecture seule : voit et lit, ne commande pas', async () => {
    const inv = await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture', jours: 14 }, jT);
    assert.equal(inv.status, 201);
    codeLecture = inv.donnees.code;
    assert.ok(/^[A-Za-z0-9_-]{24}$/.test(codeLecture), 'un code à usage unique');
    assert.ok(inv.donnees.expire - Date.now() > 47 * 3600000, 'valable 48 h');
    const attente = await appel(s.port, 'GET', '/api/socles/terraA1B2C3/partages', undefined, jT);
    assert.equal(attente.donnees.invitations.length, 1, 'l\'invitation en attente se voit');
    assert.ok(!JSON.stringify(attente.donnees).includes(codeLecture), 'jamais le code lui-même');
    const acc = await appel(s.port, 'POST', '/api/invitations/accepter', { code: codeLecture }, jL);
    assert.equal(acc.status, 200);
    assert.equal(acc.donnees.droit, 'lecture');
    assert.ok(acc.donnees.jusqua > Date.now() + 13 * 86400000, 'jusqu\'au terme choisi');
    assert.equal((await appel(s.port, 'POST', '/api/invitations/accepter', { code: codeLecture }, jM)).status, 400, 'usage unique');
    const moi = await appel(s.port, 'GET', '/api/moi', undefined, jL);
    assert.deepEqual(moi.donnees.socles, ['terraA1B2C3']);
    assert.equal(moi.donnees.partages.terraA1B2C3.droit, 'lecture');
    assert.equal((await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture' }, jL)).status, 403, 'un invité ne repartage pas');
    assert.equal((await appel(s.port, 'GET', '/api/socles/terraA1B2C3/historique', undefined, jL)).status, 200, 'il lit l\'historique du serveur');
    // Le broker : abonnement accordé, lectures non signées seulement.
    const c = await connexion(s.portMqtt, 'lea', jL);
    assert.ok(c);
    const recu = new Promise(res => { c.on('message', (sujet, charge) => res(charge.toString())); });
    c.subscribe('terrarium/terraA1B2C3/statut');
    assert.equal(await Promise.race([recu, attendre(1500).then(() => null)]), 'en ligne', 'elle voit l\'état du socle');
    assert.equal(await publier(c, 'terrarium/terraA1B2C3/cmd', JSON.stringify({ req: 'l1', action: 'historique', heures: 24 })), true, 'une lecture passe');
    await attendre(150);
    assert.ok(socle.recues.includes('historique'));
    const signee = JSON.stringify({ c: JSON.stringify({ req: 'l2', action: 'zone', z: 0, jour: 40, ts: 1 }), sig: 'x' });
    assert.equal(await publier(c, 'terrarium/terraA1B2C3/cmd', signee), false, 'une commande signée est refusée');
    assert.ok(!socle.recues.includes('zone'), 'elle n\'atteint pas le socle');
    c.end(true);
    const c2 = await connexion(s.portMqtt, 'lea', jL);
    assert.equal(await publier(c2, 'terrarium/terraA1B2C3/cmd', JSON.stringify({ req: 'l3', action: 'reset' })), false, 'une écriture non signée aussi');
    c2.end(true);
  });

  await t.test('peut régler : ses commandes passent ; le titulaire voit et retire', async () => {
    const inv = await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'reglage', jours: 0 }, jT);
    assert.equal(inv.donnees.jusqua, null, 'sans fin');
    assert.equal((await appel(s.port, 'POST', '/api/invitations/accepter', { code: inv.donnees.code }, jM)).status, 200);
    const c = await connexion(s.portMqtt, 'max', jM);
    const cmd = JSON.stringify({ c: JSON.stringify({ req: 'm1', action: 'zone', z: 0, jour: 30, ts: 1 }), sig: 'x' });
    assert.equal(await publier(c, 'terrarium/terraA1B2C3/cmd', cmd), true, 'Max commande (le socle vérifie la signature)');
    c.end(true);
    const p = await appel(s.port, 'GET', '/api/socles/terraA1B2C3/partages', undefined, jT);
    assert.deepEqual(p.donnees.acces.map(a => [a.login, a.droit]), [['titulaire', 'titulaire'], ['lea', 'lecture'], ['max', 'reglage']]);
    assert.equal((await appel(s.port, 'DELETE', '/api/socles/terraA1B2C3/partages/titulaire', undefined, jT)).donnees.retire, false, 'un titulaire ne se retire pas ainsi');
    const r = await appel(s.port, 'DELETE', '/api/socles/terraA1B2C3/partages/max', undefined, jT);
    assert.equal(r.donnees.retire, true);
    assert.deepEqual((await appel(s.port, 'GET', '/api/moi', undefined, jM)).donnees.socles, [], 'Max n\'a plus le socle');
    const c3 = await connexion(s.portMqtt, 'max', jM);
    assert.equal(await publier(c3, 'terrarium/terraA1B2C3/cmd', cmd), false, 'ni ses commandes');
    c3.end(true);
  });

  await t.test('fin d\'accès : échu, il ne voit plus rien', async () => {
    const u = s.comptes.utilisateur('lea');
    u.partages.terraA1B2C3.jusqua = Date.now() - 1000;
    assert.equal((await appel(s.port, 'GET', '/api/socles/terraA1B2C3/historique', undefined, jL)).status, 403);
    s.comptes.purgerInvitations();
    assert.deepEqual((await appel(s.port, 'GET', '/api/moi', undefined, jL)).donnees.socles, [], 'purgé du compte');
  });

  await t.test('le dernier titulaire parti, les invités perdent l\'accès', async () => {
    const inv = await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture', jours: 7 }, jT);
    await appel(s.port, 'POST', '/api/invitations/accepter', { code: inv.donnees.code }, jL);
    const annulable = await appel(s.port, 'POST', '/api/socles/terraA1B2C3/invitations', { droit: 'lecture', jours: 7 }, jT);
    const attente = await appel(s.port, 'GET', '/api/socles/terraA1B2C3/partages', undefined, jT);
    const idInv = attente.donnees.invitations[0].id;
    assert.equal((await appel(s.port, 'DELETE', `/api/socles/terraA1B2C3/invitations/${idInv}`, undefined, jT)).donnees.annulee, true);
    assert.equal((await appel(s.port, 'POST', '/api/invitations/accepter', { code: annulable.donnees.code }, jM)).status, 400, 'invitation annulée');
    assert.equal((await appel(s.port, 'DELETE', '/api/socles/terraA1B2C3', undefined, jT)).status, 200);
    assert.deepEqual((await appel(s.port, 'GET', '/api/moi', undefined, jL)).donnees.socles, []);
  });
});
