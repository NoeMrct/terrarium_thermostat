'use strict';
/* Tests du back-office support (V11) contre un socle factice qui applique les
   règles du firmware : commandes signées par le code ou, pendant un accès
   ouvert, par la clé de session ; « service » ouvrir (code seulement),
   prolonger, fermer, état. Parcours : demande du client, demande d'accès par
   l'équipe (notification), ouverture par le propriétaire (le serveur prouve la
   clé), copie des réglages, diagnostics signés par la clé, prolongation,
   « tout remettre », transfert vers un socle neuf, fermeture, échéance, rôle
   support, frise, alertes proactives, effacement du compte.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');

const ADMIN = 'jeton-admin-support';
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
function attendreQue(condition, delaiMs = 5000) {
  return new Promise((res, rej) => {
    const debut = Date.now();
    const t = setInterval(() => {
      if (condition()) { clearInterval(t); res(); } else if (Date.now() - debut > delaiMs) { clearInterval(t); rej(new Error('délai dépassé')); }
    }, 20);
  });
}

// Socle factice aux règles du firmware 3.5 (protocole 4 + accès support).
async function socleFactice(port, id, motDePasse, code) {
  const s = { id, code, service: null, journal: [], reglages: { zones: [{ nom: 'Chaud', jour: 31 }, { nom: 'Frais', jour: 26 }] }, recues: [] };
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username: id, password: motDePasse, clientId: 'factice-' + id });
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); });
  const actif = () => !!s.service && Date.now() / 1000 < s.service.jusqua;
  const repondre = (req, ok, corps = {}) => c.publish(`terrarium/${id}/reponse`, JSON.stringify({ req, ok, ...corps }));
  const hmac = (cle, t) => crypto.createHmac('sha256', cle).update(t, 'utf8').digest('hex');
  s.publierSante = () => c.publish(`terrarium/${id}/sante`, JSON.stringify({ proto: 4, version: '3.5.0', uptime: 1000, rssi: -60, heap: 170000, heapMin: 140000,
    ...(actif() ? { service: { actif: true, jusqua: s.service.jusqua } } : {}) }), { retain: true });
  c.subscribe(`terrarium/${id}/cmd`);
  c.publish(`terrarium/${id}/statut`, 'en ligne', { retain: true });
  s.publierSante();
  c.publish(`terrarium/${id}/zone1/etat`, JSON.stringify({ temp: 30.5, consigne: 31, defaut: '0' }));
  c.publish(`terrarium/${id}/zone2/etat`, JSON.stringify({ temp: 25.9, consigne: 26, defaut: '0' }));
  c.on('message', (sujet, charge) => {
    let env;
    try { env = JSON.parse(charge.toString()); } catch (e) { return; }
    if (typeof env.c !== 'string') return repondre(env.req || '', false, { erreur: 'jeton invalide' });
    let d;
    try { d = JSON.parse(env.c); } catch (e) { return repondre('', false, { erreur: 'JSON invalide' }); }
    let parSupport = false;
    if (env.sig !== hmac(s.code, env.c)) {
      if (actif() && env.sig === hmac(s.service.cle, env.c)) parSupport = true;
      else return repondre(d.req, false, { erreur: 'signature invalide' });
    }
    s.recues.push({ action: d.action, parSupport, d });
    if (parSupport && !['etat', 'version'].includes(d.action)) s.journal.push(`Support : ${d.action}`);
    const maintenant = Math.floor(Date.now() / 1000);
    switch (d.action) {
      case 'service': {
        const h = d.heures || 24;
        if (d.op === 'ouvrir') {
          if (parSupport) return repondre(d.req, false, { erreur: "seul le proprietaire ouvre l'acces support" });
          s.service = { cle: d.cle, ouvert: maintenant, jusqua: maintenant + h * 3600 };
        } else if (d.op === 'prolonger') {
          if (!actif()) return repondre(d.req, false, { erreur: 'aucun acces support ouvert' });
          s.service.jusqua = Math.min(Math.max(s.service.jusqua, maintenant + h * 3600), s.service.ouvert + 7 * 86400);
        } else if (d.op === 'fermer') s.service = null;
        s.publierSante();
        const a = actif();
        return repondre(d.req, true, { service: { actif: a, ouvert: a ? s.service.ouvert : 0, jusqua: a ? s.service.jusqua : 0, par: parSupport ? 'support' : 'proprietaire' } });
      }
      case 'globaux': return repondre(d.req, true, { amperes: 3 });
      case 'sauvegarde': return repondre(d.req, true, { sauvegarde: { format: 'terrarium-sauvegarde', appareil: id, date: new Date().toISOString(), zones: JSON.parse(JSON.stringify(s.reglages.zones)) } });
      case 'restaurer':
        if (!d.sauvegarde || d.sauvegarde.format !== 'terrarium-sauvegarde') return repondre(d.req, false, { erreur: 'sauvegarde attendue' });
        s.reglages.zones = JSON.parse(JSON.stringify(d.sauvegarde.zones));
        return repondre(d.req, true, { message: `Configuration de ${d.sauvegarde.appareil} restauree` });
      case 'zone': s.reglages.zones[d.z].jour = d.jour; return repondre(d.req, true);
      case 'sondes': return repondre(d.req, true, { sondes: { sondes: [{ rom: '28FF000011112222', temp: 30.4, zone: 0 }], liaisons: [] } });
      case 'journal': return repondre(d.req, true, { texte: s.journal.join('\n') });
      default: return repondre(d.req, false, { erreur: 'action inconnue' });
    }
  });
  s.client = c;
  return s;
}

test('support : demandes, accès ouvert par le propriétaire, diagnostics, transfert, échéance', async t => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-support-'));
  const pushes = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, journal: () => {},
    envoyerPush: async (abonnement, charge) => { pushes.push(JSON.parse(charge)); }, antiSpamMs: 1, echeancesMs: 200 });
  const P = s.port;
  const socles = [];
  t.after(async () => { for (const x of socles) x.client.end(true); await s.arreter(); });

  // Le décor : un propriétaire, deux socles (l'ancien et son remplaçant), un
  // compte « support », un autre client.
  const code1 = 'CODEDAPPAIRAGEANCIEN0001', code2 = 'CODEDAPPAIRAGENEUF000002';
  const a1 = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, ADMIN);
  const a2 = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraN3U4F5' }, ADMIN);
  socles.push(await socleFactice(s.portMqtt, 'terraA1B2C3', a1.donnees.motDePasse, code1));
  socles.push(await socleFactice(s.portMqtt, 'terraN3U4F5', a2.donnees.motDePasse, code2));
  const [vieux, neuf] = socles;
  await attendreQue(() => s.broker.flotte.terraA1B2C3 && s.broker.flotte.terraA1B2C3.sante && s.broker.flotte.terraN3U4F5 && s.broker.flotte.terraN3U4F5.sante);
  await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' }, ADMIN);
  await appel(P, 'POST', '/api/admin/socles/terraA1B2C3/proprietaires', { login: 'noe@exemple.fr' }, ADMIN);
  await appel(P, 'POST', '/api/admin/socles/terraN3U4F5/proprietaires', { login: 'noe@exemple.fr' }, ADMIN);
  await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'agent', motDePasse: 'mot-de-passe-agent' }, ADMIN);
  await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'autre@exemple.fr', motDePasse: 'mot-de-passe-autre' }, ADMIN);
  const J = (await appel(P, 'POST', '/api/session', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' })).donnees.jeton;
  const JAutre = (await appel(P, 'POST', '/api/session', { login: 'autre@exemple.fr', motDePasse: 'mot-de-passe-autre' })).donnees.jeton;
  await appel(P, 'POST', '/api/push/abonnement', { abonnement: { endpoint: 'https://push.exemple/abc', keys: { p256dh: 'x', auth: 'y' } } }, J);

  // Ce que fait l'application : tirer une clé, ouvrir sur le socle (signé avec le code), la remettre au serveur.
  const ouvrirDepuisAppli = async (socle, heures = 24) => {
    const cle = crypto.randomBytes(32).toString('hex');
    const ok = await new Promise(res => {
      const req = 'appli' + Math.random().toString(36).slice(2, 8);
      const cc = JSON.stringify({ req, action: 'service', op: 'ouvrir', cle, heures, ts: Math.floor(Date.now() / 1000) });
      const ecoute = mqtt.connect(`mqtt://127.0.0.1:${s.portMqtt}`, { username: 'admin', password: ADMIN });
      ecoute.on('connect', () => {
        ecoute.subscribe(`terrarium/${socle.id}/reponse`);
        ecoute.publish(`terrarium/${socle.id}/cmd`, JSON.stringify({ c: cc, sig: crypto.createHmac('sha256', socle.code).update(cc).digest('hex') }));
      });
      ecoute.on('message', (_, ch) => { const r = JSON.parse(ch.toString()); if (r.req === req) { ecoute.end(true); res(r.ok); } });
    });
    assert.equal(ok, true, 'le socle ouvre la session');
    return cle;
  };

  let numero;
  await t.test('le client écrit au support ; l\'équipe répond et demande l\'accès', async () => {
    const d = await appel(P, 'POST', '/api/support/demandes', { socle: 'terraA1B2C3', texte: 'La zone 2 reste froide depuis hier.' }, J);
    assert.equal(d.status, 201);
    numero = d.donnees.n;
    assert.equal(d.donnees.statut, 'nouvelle');
    assert.equal((await appel(P, 'POST', '/api/support/demandes', { socle: 'terraA1B2C3', texte: 'pirate' }, JAutre)).status, 403, 'pas le socle d\'un autre');
    assert.equal((await appel(P, 'POST', '/api/support/demandes', { socle: 'terraA1B2C3', texte: '   ' }, J)).status, 400, 'message vide');
    const file = (await appel(P, 'GET', '/api/admin/support/demandes', undefined, ADMIN)).donnees.demandes;
    assert.equal(file[0].n, numero);
    assert.equal(file[0].compte, 'noe@exemple.fr');
    assert.equal(file[0].dernier.de, 'client');
    // Réponse au client, note interne, statut, responsable.
    assert.equal((await appel(P, 'POST', `/api/admin/support/demandes/${numero}/messages`, { texte: 'Bonjour, nous regardons.' }, ADMIN)).status, 200);
    assert.equal((await appel(P, 'POST', `/api/admin/support/demandes/${numero}/notes`, { texte: 'Probablement la sonde 2 inversée.' }, ADMIN)).status, 200);
    assert.equal((await appel(P, 'POST', `/api/admin/support/demandes/${numero}`, { gravite: 'urgente', responsable: 'agent' }, ADMIN)).status, 400, 'responsable hors équipe');
    await appel(P, 'POST', '/api/admin/utilisateurs/agent/support', { support: true }, ADMIN);
    const maj = await appel(P, 'POST', `/api/admin/support/demandes/${numero}`, { gravite: 'urgente', responsable: 'agent' }, ADMIN);
    assert.equal(maj.status, 200);
    assert.equal(maj.donnees.statut, 'attente client', 'la réponse met la demande en attente du client');
    const cote = (await appel(P, 'GET', '/api/support/demandes', undefined, J)).donnees.demandes[0];
    assert.equal(cote.messages.length, 2);
    assert.equal(cote.messages[1].de, 'support');
    assert.equal('notes' in cote, false, 'le client ne voit jamais les notes');
    assert.equal(JSON.stringify(cote).includes('agent'), false, 'ni qui de l\'équipe a répondu');
    assert.equal((await appel(P, 'GET', '/api/support/demandes', undefined, JAutre)).donnees.demandes.length, 0, 'ni les demandes des autres');
    await appel(P, 'POST', `/api/support/demandes/${numero}/messages`, { texte: 'Merci !' }, J);
    assert.equal((await appel(P, 'GET', `/api/admin/support/demandes/${numero}`, undefined, ADMIN)).donnees.statut, 'en cours', 'le client répond : en cours');
    // Demande d'accès : notification, puis visible dans l'application.
    const avant = pushes.length;
    assert.equal((await appel(P, 'POST', `/api/admin/support/demandes/${numero}/demander-acces`, undefined, ADMIN)).status, 200);
    await attendreQue(() => pushes.length > avant);
    assert.match(pushes[pushes.length - 1].titre, /demande l'accès/);
    const acces = (await appel(P, 'GET', '/api/support/acces', undefined, J)).donnees.acces;
    assert.deepEqual(acces.find(x => x.id === 'terraA1B2C3').demandeAcces.n, numero);
  });

  let cle;
  await t.test('le propriétaire ouvre l\'accès : clé prouvée, copie des réglages', async () => {
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: 'sondes' }, ADMIN)).status, 409, 'rien sans accès ouvert');
    const fausse = crypto.randomBytes(32).toString('hex');
    assert.equal((await appel(P, 'POST', '/api/support/acces', { socle: 'terraA1B2C3', cle: fausse }, J)).status, 409, 'une clé que le socle ne connaît pas');
    cle = await ouvrirDepuisAppli(vieux);
    assert.equal((await appel(P, 'POST', '/api/support/acces', { socle: 'terraA1B2C3', cle }, JAutre)).status, 403, 'pas pour le socle d\'un autre');
    const r = await appel(P, 'POST', '/api/support/acces', { socle: 'terraA1B2C3', cle }, J);
    assert.equal(r.status, 201);
    assert.equal(r.donnees.actif, true);
    assert.equal(JSON.stringify(r.donnees).includes(cle), false, 'la clé ne revient jamais');
    await attendreQue(() => s.support.accesActif('terraA1B2C3') && s.support.accesActif('terraA1B2C3').copie);
    const vue = (await appel(P, 'GET', '/api/admin/support/acces/terraA1B2C3', undefined, ADMIN)).donnees;
    assert.equal(vue.actif, true);
    assert.equal(vue.copieSauvegarde.zones[0].jour, 31, 'copie des réglages à l\'ouverture');
    assert.equal(JSON.stringify(vue).includes(cle), false);
    const acces = (await appel(P, 'GET', '/api/support/acces', undefined, J)).donnees.acces.find(x => x.id === 'terraA1B2C3');
    assert.equal(acces.actif, true);
    assert.equal(acces.demandeAcces, null, 'la demande d\'accès est satisfaite');
    const brut = fs.readFileSync(path.join(donnees, 'support', 'acces.json'));
    assert.equal(fs.statSync(path.join(donnees, 'support', 'acces.json')).mode & 0o777, 0o600, 'clés : fichier 0600');
    assert.ok(brut.includes(cle));
  });

  await t.test('diagnostics et réglages, signés par la clé et notés au journal', async () => {
    const sondes = await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: 'sondes', relire: true }, ADMIN);
    assert.equal(sondes.status, 200);
    assert.equal(sondes.donnees.sondes.sondes[0].rom, '28FF000011112222');
    assert.equal(vieux.recues[vieux.recues.length - 1].parSupport, true, 'signée avec la clé de session, pas le code');
    const zone = await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: 'zone', z: 1, jour: 28 }, ADMIN);
    assert.equal(zone.donnees.ok, true);
    assert.equal(vieux.reglages.zones[1].jour, 28);
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: 'service', op: 'prolonger' }, ADMIN)).status, 400, 'l\'accès ne se gère pas par la route générique');
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: '../x' }, ADMIN)).status, 400);
    const journal = (await appel(P, 'GET', '/api/admin/audit?cible=terraA1B2C3', undefined, ADMIN)).donnees.entrees;
    const z = journal.find(e => e.action === 'support.commande' && e.details.action === 'zone');
    assert.deepEqual(z.details.valeurs, { z: 1, jour: 28 }, 'avec les valeurs');
    assert.equal(z.qui, 'jeton d\'administration');
    assert.ok(vieux.journal.includes('Support : zone'), 'et au journal du socle');
  });

  await t.test('« tout remettre » depuis la copie, prolongation notifiée', async () => {
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/remettre', { confirmation: 'non' }, ADMIN)).status, 400, 'référence à taper');
    const r = await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/remettre', { confirmation: 'terraA1B2C3' }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(vieux.reglages.zones[1].jour, 26, 'les réglages d\'avant reviennent');
    const avant = pushes.length;
    const p = await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/prolonger', { heures: 72 }, ADMIN);
    assert.equal(p.status, 200);
    assert.equal(p.donnees.prolonge, true);
    assert.ok(Date.parse(p.donnees.jusqua) > Date.now() + 70 * 3600000);
    await attendreQue(() => pushes.length > avant);
    assert.match(pushes[pushes.length - 1].titre, /prolongé/);
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/prolonger', { heures: 500 }, ADMIN)).status, 400);
  });

  await t.test('transfert vers le socle neuf : réglages et propriétaires', async () => {
    vieux.reglages.zones[0].jour = 33;
    assert.equal((await appel(P, 'POST', '/api/admin/support/transferer', { de: 'terraA1B2C3', vers: 'terraN3U4F5', confirmation: 'terraN3U4F5' }, ADMIN)).status, 409, 'accès ouvert sur le neuf exigé');
    const cleNeuf = await ouvrirDepuisAppli(neuf);
    await appel(P, 'POST', '/api/support/acces', { socle: 'terraN3U4F5', cle: cleNeuf }, J);
    assert.equal((await appel(P, 'POST', '/api/admin/support/transferer', { de: 'terraA1B2C3', vers: 'terraN3U4F5', confirmation: 'oui' }, ADMIN)).status, 400);
    const r = await appel(P, 'POST', '/api/admin/support/transferer', { de: 'terraA1B2C3', vers: 'terraN3U4F5', confirmation: 'terraN3U4F5' }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(neuf.reglages.zones[0].jour, 33, 'les réglages de l\'ancien (frais) passent sur le neuf');
    assert.ok(s.comptes.utilisateur('noe@exemple.fr').socles.includes('terraN3U4F5'));
  });

  await t.test('rôle support : demandes et accès oui, comptes non', async () => {
    const JA = (await appel(P, 'POST', '/api/session', { login: 'agent', motDePasse: 'mot-de-passe-agent' })).donnees.jeton;
    const moi = await appel(P, 'GET', '/api/admin/moi', undefined, JA);
    assert.equal(moi.donnees.role, 'support');
    assert.equal((await appel(P, 'GET', '/api/admin/support/demandes', undefined, JA)).status, 200);
    assert.equal((await appel(P, 'GET', '/api/admin/socles/terraA1B2C3/frise', undefined, JA)).status, 200);
    const refus = await appel(P, 'GET', '/api/admin/utilisateurs', undefined, JA);
    assert.equal(refus.status, 403);
    assert.equal(refus.donnees.droits, 'admin', 'refus de rôle, distinct d\'une session refusée');
    assert.equal((await appel(P, 'POST', '/api/admin/appareils', { id: 'terraZZZZZ9' }, JA)).status, 403);
    assert.equal((await appel(P, 'GET', '/api/admin/audit/export', undefined, JA)).status, 403);
    const equipe = (await appel(P, 'GET', '/api/admin/support/equipe', undefined, JA)).donnees.equipe;
    assert.deepEqual(equipe.map(x => x.login).sort(), ['agent']);
    const note = await appel(P, 'POST', `/api/admin/support/demandes/${numero}/notes`, { texte: 'vu' }, JA);
    assert.equal(note.status, 200);
    assert.equal((await appel(P, 'GET', `/api/admin/support/demandes/${numero}`, undefined, ADMIN)).donnees.notes.pop().qui, 'agent');
  });

  await t.test('frise et alertes proactives', async () => {
    // Un défaut en direct, puis un redémarrage : la frise les montre.
    vieux.client.publish('terrarium/terraA1B2C3/zone2/etat', JSON.stringify({ temp: 85, consigne: 26, defaut: '1', defaut_libelle: 'sonde absente' }));
    vieux.client.publish('terrarium/terraA1B2C3/sante', JSON.stringify({ proto: 4, version: '3.5.0', uptime: 5, rssi: -85, heap: 170000, heapMin: 20000 }), { retain: true });
    await attendreQue(() => s.evenements.lire('terraA1B2C3').some(e => e.type === 'redemarrage'));
    const f = (await appel(P, 'GET', '/api/admin/socles/terraA1B2C3/frise', undefined, ADMIN)).donnees;
    const types = f.frise.map(e => e.type);
    for (const x of ['defaut', 'redemarrage', 'support.acces.ouvrir', 'support.commande', 'message']) assert.ok(types.includes(x), `frise : ${x}`);
    assert.ok(f.frise.some(e => e.source === 'client') && f.frise.some(e => e.source === 'support') && f.frise.some(e => e.source === 'socle'));
    for (let i = 1; i < f.frise.length; i++) assert.ok(f.frise[i - 1].t >= f.frise[i].t, 'du plus récent au plus ancien');
    const tab = (await appel(P, 'GET', '/api/admin/tableau', undefined, ADMIN)).donnees;
    const alertes = tab.alertes.filter(a => a.socle === 'terraA1B2C3');
    assert.ok(alertes.some(a => a.type === 'defaut' && a.gravite === 'urgente' && a.demande === numero), 'défaut, avec la demande ouverte');
    assert.ok(alertes.some(a => a.type === 'signal') && alertes.some(a => a.type === 'memoire'));
    assert.equal(tab.alertes[0].gravite, 'urgente', 'les urgentes d\'abord');
    assert.equal(tab.support.acces, 2);
    // Une demande ouverte par l'équipe, sur alerte : le client la voit.
    const proactive = await appel(P, 'POST', '/api/admin/support/demandes', { socle: 'terraA1B2C3', texte: 'Votre socle signale une sonde absente.', gravite: 'urgente' }, ADMIN);
    assert.equal(proactive.status, 201);
    assert.equal(proactive.donnees.statut, 'attente client');
    assert.ok((await appel(P, 'GET', '/api/support/demandes', undefined, J)).donnees.demandes.some(d => d.n === proactive.donnees.n));
  });

  await t.test('fermeture par le propriétaire, échéance, refus', async () => {
    const r = await appel(P, 'DELETE', '/api/support/acces/terraA1B2C3', undefined, J);
    assert.equal(r.donnees.ferme, true);
    await attendreQue(() => vieux.service === null);
    assert.equal(s.support.acces.has('terraA1B2C3'), false, 'la clé quitte le disque');
    assert.equal((await appel(P, 'POST', '/api/admin/support/acces/terraA1B2C3/commande', { action: 'sondes' }, ADMIN)).status, 409);
    // Échéance : le serveur retire de lui-même un accès échu.
    s.support.accesActif('terraN3U4F5').jusqua = new Date(Date.now() - 1000).toISOString();
    await attendreQue(() => !s.support.acces.has('terraN3U4F5'), 3000);
    assert.ok(s.audit.lire({ filtre: e => e.action === 'support.acces.echu' && e.cible === 'terraN3U4F5' }).length === 1);
    // Refus d'une demande d'accès : la demande le dit.
    await appel(P, 'POST', `/api/admin/support/demandes/${numero}/demander-acces`, undefined, ADMIN);
    const refus = await appel(P, 'POST', '/api/support/acces/terraA1B2C3/refuser', undefined, J);
    assert.equal(refus.donnees.refuse, 1);
    const d = (await appel(P, 'GET', `/api/admin/support/demandes/${numero}`, undefined, ADMIN)).donnees;
    assert.equal(d.demandeAcces, null);
    assert.match(d.messages[d.messages.length - 1].texte, /refusé/);
  });

  await t.test('export et effacement du compte : les demandes suivent', async () => {
    const exp = (await appel(P, 'GET', '/api/moi/export', undefined, J)).donnees;
    assert.ok(exp.demandesSupport.length >= 2);
    assert.equal(JSON.stringify(exp.demandesSupport).includes('Probablement la sonde'), false, 'sans les notes internes');
    // Accès rouvert, puis compte effacé : l'accès des socles orphelins se ferme.
    cle = await ouvrirDepuisAppli(vieux);
    await appel(P, 'POST', '/api/support/acces', { socle: 'terraA1B2C3', cle }, J);
    const eff = await appel(P, 'DELETE', '/api/moi', { confirmation: 'noe@exemple.fr' }, J);
    assert.equal(eff.status, 200);
    assert.equal(s.support.acces.has('terraA1B2C3'), false);
    assert.equal([...s.support.demandes.values()].some(d => d.compte === 'noe@exemple.fr'), false, 'ses demandes sont effacées');
    assert.equal(s.evenements.lire('terraA1B2C3').length, 0, 'les événements du socle orphelin aussi');
    // Le journal garde la trace, sans l'adresse.
    const brut = fs.readdirSync(path.join(donnees, 'audit')).map(x => fs.readFileSync(path.join(donnees, 'audit', x), 'utf8')).join('');
    assert.equal(brut.includes('noe@exemple.fr'), false);
    assert.equal(brut.includes(cle), false, 'aucune clé de session au journal');
    await attendre(10);
  });
});
