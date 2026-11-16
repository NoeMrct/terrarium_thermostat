'use strict';
/* Atelier : rôle « atelier » (ce qu'il peut, ce qu'il ne peut pas), registre
   partagé (révisions, conflits, secrets refusés, migration d'un registre
   local), Wi-Fi du banc chiffré, accès MQTT aux seuls socles en montage,
   rodage surveillé par le serveur (incidents, verdict) et alertes groupées à
   l'équipe. Ports éphémères, données dans un dossier temporaire.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');
const { Atelier, AlertesAtelier } = require('../lib/atelier');

const ADMIN = 'jeton-admin-de-test';
const attendre = ms => new Promise(r => setTimeout(r, ms));
const dossierTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-atelier-'));

async function appel(port, methode, chemin, corps, jeton) {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps)
  });
  const texte = await r.text();
  let donnees = null;
  try { donnees = JSON.parse(texte); } catch (e) { /* vide */ }
  return { status: r.status, donnees };
}
async function jusqua(condition, delaiMs = 4000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) { if (await condition()) return true; await attendre(25); }
  return false;
}
// Un client MQTT : ce qu'il reçoit, et le verdict de ses abonnements.
function clientMqtt(port, username, password) {
  return new Promise((res, rej) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.recu = [];
    c.on('message', (sujet, charge) => c.recu.push({ sujet, charge: charge.toString() }));
    c.once('connect', () => res(c));
    c.once('error', rej);
  });
}
// Le code brut du SUBACK (128 = refusé) : mqtt.js ne le remonte pas fidèlement.
const abonner = (c, sujet) => new Promise(res => {
  const sur = p => { if (p.cmd === 'suback') { c.off('packetreceive', sur); res(p.granted[0]); } };
  c.on('packetreceive', sur);
  c.subscribe(sujet, { qos: 0 }, () => {});
});
// Vrai si le broker a laissé passer (un refus coupe la connexion).
function publier(c, sujet, charge, retain = false) {
  return new Promise(res => {
    let fini = false;
    const fin = v => { if (!fini) { fini = true; res(v); } };
    c.once('close', () => fin(false));
    c.publish(sujet, charge, { qos: 1, retain }, err => { if (err) fin(false); else setTimeout(() => fin(c.connected), 60); });
  });
}

test('atelier : rôle, registre partagé, Wi-Fi, broker, rodage surveillé, alertes', async t => {
  const donnees = dossierTemp();
  const courriels = [];
  const pushs = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, journal: () => {}, pushActif: true,
    envoyerPush: async (abonnement, charge) => { pushs.push({ endpoint: abonnement.endpoint, charge: JSON.parse(charge) }); },
    courriel: { envoyer: async m => { courriels.push(m); } }, delaiAlertesAtelierMs: 60000, delaiHorsLigneMs: 80,
    origines: ['https://app.exemple.fr'] });
  const P = s.port;
  t.after(() => s.arreter());

  // L'équipe : Noé administrateur, Jean au rôle atelier, Léa au support, un client.
  const ouvrir = email => { s.comptes.obtenirParEmail(email); return s.comptes.ouvrirSession(email); };
  const jNoe = ouvrir('noe@exemple.fr');
  s.comptes.definirAdmin('noe@exemple.fr', true);
  const jJean = ouvrir('jean@exemple.fr');
  const jLea = ouvrir('lea@exemple.fr');
  s.comptes.definirSupport('lea@exemple.fr', true);
  const jClient = ouvrir('client@exemple.fr');

  await t.test('rôle atelier : donné par la console, vu par le compte', async () => {
    let r = await appel(P, 'POST', '/api/admin/utilisateurs/jean%40exemple.fr/atelier', { atelier: true }, jNoe);
    assert.equal(r.status, 200);
    assert.equal(r.donnees.atelier, true);
    r = await appel(P, 'GET', '/api/moi', undefined, jJean);
    assert.deepEqual([r.donnees.admin, r.donnees.equipe, r.donnees.atelier], [false, false, true], 'ni administrateur ni équipe support : atelier');
    r = await appel(P, 'GET', '/api/moi', undefined, jNoe);
    assert.equal(r.donnees.atelier, true, 'un administrateur fait aussi l\'atelier');
    r = await appel(P, 'GET', '/api/admin/utilisateurs', undefined, jNoe);
    assert.equal(r.donnees.utilisateurs.find(u => u.login === 'jean@exemple.fr').atelier, true, 'la console voit le rôle');
    const j = s.audit.lire({ limite: 5 }).find(e => e.action === 'compte.atelier');
    assert.ok(j && j.details.atelier === true && j.qui === 'noe@exemple.fr', 'noté au journal d\'audit');
    r = await appel(P, 'POST', '/api/admin/utilisateurs/client%40exemple.fr/atelier', { atelier: true }, jJean);
    assert.equal(r.status, 403, 'le rôle atelier ne donne pas de rôle');
  });

  await t.test('rôle atelier : la console reste fermée, le compte d\'appareil d\'un socle sans client s\'ouvre', async () => {
    for (const [m, c] of [['GET', '/api/admin/moi'], ['GET', '/api/admin/tableau'], ['GET', '/api/admin/utilisateurs'], ['GET', '/api/admin/rapports'],
      ['GET', '/api/admin/audit'], ['GET', '/api/admin/support/demandes'], ['GET', '/api/admin/appareils']]) {
      const r = await appel(P, m, c, undefined, jJean);
      assert.equal(r.status, 403, `${m} ${c} refusé`);
      assert.equal(r.donnees.droits, 'admin');
    }
    let r = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, jJean);
    assert.equal(r.status, 201, 'compte d\'appareil créé par l\'atelier');
    assert.ok(r.donnees.motDePasse);
    s.comptes.attribuerSocle('client@exemple.fr', 'terraA1B2C3');
    r = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, jJean);
    assert.equal(r.status, 403, 'socle d\'un client : l\'atelier ne renouvelle pas son compte');
    assert.match(r.donnees.erreur, /client/);
    r = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, jNoe);
    assert.equal(r.status, 201, 'un administrateur, si');
    s.comptes.retirerSocle('client@exemple.fr', 'terraA1B2C3');
    r = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, jLea);
    assert.equal(r.status, 403, 'le support ne crée pas de compte d\'appareil');
  });

  await t.test('registre : accès, révisions, secrets refusés, conflits, migration', async () => {
    let r = await appel(P, 'GET', '/api/atelier/registre', undefined, jClient);
    assert.equal(r.status, 403, 'un client n\'a pas le registre');
    r = await appel(P, 'GET', '/api/atelier/registre', undefined, jLea);
    assert.equal(r.status, 403, 'le support non plus');
    r = await appel(P, 'GET', '/api/atelier/registre', undefined, 'jeton-inconnu');
    assert.equal(r.status, 403);
    r = await appel(P, 'GET', '/api/atelier/registre', undefined, jJean);
    assert.equal(r.status, 200);
    assert.deepEqual([r.donnees.rev, r.donnees.socles, r.donnees.lots, r.donnees.wifi], [0, [], [], null], 'registre vide');
    assert.deepEqual(r.donnees.moi, { login: 'jean@exemple.fr', role: 'atelier', alertes: { email: true } });

    r = await appel(P, 'PUT', '/api/atelier/lots/lot-a1', { nom: 'Lot du 16/11/2026', cree: 1763290000000 }, jJean);
    assert.equal(r.status, 200);
    assert.equal(r.donnees.lot.nom, 'Lot du 16/11/2026');
    const fiche = { id: 'terraA1B2C3', lot: 'lot-a1', cree: 1, maj: 10, etape: 2, etat: 'actif', liaison: 'serveur', code: 'K7M2QXABCDEFGH2345678JKL',
      web: { utilisateur: 'admin', motDePasse: 'secretpage12' }, sondes: [], journal: [{ t: 1, texte: 'Socle enregistré' }] };
    r = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { socle: fiche, base: 0 }, jJean);
    assert.equal(r.status, 200);
    const v1 = r.donnees.socle;
    assert.equal(v1.code, undefined, 'code d\'appairage refusé par le serveur');
    assert.equal(v1.web, undefined, 'mot de passe de la page locale aussi');
    assert.equal(v1.par, 'jean@exemple.fr');
    const brut = fs.readFileSync(path.join(donnees, 'atelier.json'), 'utf8');
    assert.ok(!brut.includes('K7M2QX') && !brut.includes('secretpage12'), 'aucun secret sur le disque');
    r = await appel(P, 'GET', '/api/atelier/registre?depuis=0', undefined, jNoe);
    assert.equal(r.donnees.socles.length, 1, 'l\'autre poste voit la fiche');
    r = await appel(P, 'GET', `/api/atelier/registre?depuis=${r.donnees.rev}`, undefined, jNoe);
    assert.deepEqual([r.donnees.socles.length, r.donnees.lots.length], [0, 0], 'rien de neuf depuis sa révision');

    r = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { socle: { ...fiche, etape: 3, maj: 11 }, base: v1.rev }, jNoe);
    assert.equal(r.status, 200, 'écrit depuis la dernière révision');
    r = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { socle: { ...fiche, etape: 2, maj: 12 }, base: v1.rev }, jJean);
    assert.equal(r.status, 409, 'fiche changée entre-temps : rendue, pas écrasée');
    assert.equal(r.donnees.socle.etape, 3);
    // Registre local d'avant le partage : la fiche la plus récente l'emporte.
    r = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { socle: { ...fiche, etape: 1, maj: 5 }, base: 0 }, jJean);
    assert.equal(r.status, 409, 'plus ancienne : refusée');
    r = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { socle: { ...fiche, etape: 4, maj: 50 }, base: 0 }, jJean);
    assert.equal(r.status, 200, 'plus récente : gardée');

    for (const [corps, motif] of [[{ socle: { ...fiche, etat: 'vendu' } }, /état/], [{ socle: { ...fiche, etape: 9 } }, /étape/],
      [{ socle: { ...fiche, journal: 'x'.repeat(60000) } }, /trop grande/], [{ socle: null }, /fiche attendue/]]) {
      const x = await appel(P, 'PUT', '/api/atelier/socles/terraA1B2C3', { ...corps, base: 0 }, jJean);
      assert.equal(x.status, 400);
      assert.match(x.donnees.erreur, motif);
    }
    r = await appel(P, 'PUT', '/api/atelier/socles/terraZZ', { socle: fiche, base: 0 }, jJean);
    assert.equal(r.status, 404, 'identifiant hors format : route inconnue');
  });

  await t.test('Wi-Fi du banc : chiffré sur le disque, rendu aux postes, illisible sans le jeton', async () => {
    let r = await appel(P, 'PUT', '/api/atelier/wifi', { ssid: 'Atelier Banc', motDePasse: 'motdepasse8' }, jJean);
    assert.equal(r.status, 400, 'pas d\'espace (la console du socle coupe aux espaces)');
    r = await appel(P, 'PUT', '/api/atelier/wifi', { ssid: 'AtelierBanc', motDePasse: 'court' }, jJean);
    assert.equal(r.status, 400, 'mot de passe Wi-Fi : 8 caractères au moins');
    r = await appel(P, 'PUT', '/api/atelier/wifi', { ssid: 'AtelierBanc', motDePasse: 'motdepasse8' }, jJean);
    assert.equal(r.status, 200);
    assert.equal(r.donnees.wifi.motDePasse, undefined, 'la réponse ne renvoie pas le mot de passe');
    assert.ok(!fs.readFileSync(path.join(donnees, 'atelier.json'), 'utf8').includes('motdepasse8'), 'chiffré sur le disque');
    r = await appel(P, 'GET', '/api/atelier/registre?depuis=0', undefined, jNoe);
    assert.deepEqual([r.donnees.wifi.ssid, r.donnees.wifi.motDePasse], ['AtelierBanc', 'motdepasse8'], 'rendu en clair aux postes de l\'atelier');
    const j = s.audit.lire({ limite: 5 }).find(e => e.action === 'atelier.wifi');
    assert.ok(j && !JSON.stringify(j).includes('motdepasse8'), 'au journal, sans le mot de passe');
    // Un autre jeton d'administration : la clé change, le mot de passe est à ressaisir.
    const autre = new Atelier(donnees, { cleSecrete: 'un-autre-jeton' });
    assert.deepEqual([autre.vueWifi().ssid, autre.vueWifi().motDePasse], ['AtelierBanc', null]);
    const meme = new Atelier(donnees, { cleSecrete: ADMIN });
    assert.equal(meme.vueWifi().motDePasse, 'motdepasse8', 'même jeton : relu après redémarrage');
    r = await appel(P, 'DELETE', '/api/atelier/wifi', undefined, jNoe);
    assert.equal(r.donnees.oublie, true);
    r = await appel(P, 'GET', '/api/atelier/registre?depuis=0', undefined, jJean);
    assert.equal(r.donnees.wifi.ssid, '', 'l\'oubli se propage aux postes');
    await appel(P, 'PUT', '/api/atelier/wifi', { ssid: 'AtelierBanc', motDePasse: 'motdepasse8' }, jJean);
  });

  await t.test('broker : l\'atelier pilote les socles en montage, et eux seuls', async () => {
    const mdp = (await appel(P, 'POST', '/api/admin/appareils', { id: 'terraB2C3D4' }, jJean)).donnees.motDePasse;
    const socle = await clientMqtt(s.portMqtt, 'terraB2C3D4', mdp);
    await abonner(socle, 'terrarium/terraB2C3D4/cmd');
    const jean = await clientMqtt(s.portMqtt, 'jean@exemple.fr', jJean);
    assert.equal(await abonner(jean, 'terrarium/terraB2C3D4/#'), 128, 'pas au registre : refusé');
    await appel(P, 'PUT', '/api/atelier/socles/terraB2C3D4', { socle: { id: 'terraB2C3D4', etape: 2, etat: 'actif', liaison: 'serveur', maj: 1 }, base: 0 }, jJean);
    assert.equal(await abonner(jean, 'terrarium/terraB2C3D4/#'), 0, 'au registre, en montage : accepté');
    assert.equal(await publier(jean, 'terrarium/terraB2C3D4/cmd', '{"req":"a1","action":"etat"}'), true);
    assert.ok(await jusqua(() => socle.recu.some(m => m.charge.includes('"a1"'))), 'sa commande arrive au socle');
    assert.equal(await abonner(jean, 'terrarium/terraA1B2C3/#'), 0, 'l\'autre socle du registre aussi');
    s.comptes.attribuerSocle('client@exemple.fr', 'terraB2C3D4');
    const avant = socle.recu.length;
    assert.equal(await publier(jean, 'terrarium/terraB2C3D4/cmd', '{"req":"a2","action":"etat"}'), false, 'rattaché à un client : commande refusée');
    await attendre(100);
    assert.equal(socle.recu.length, avant, 'elle n\'atteint pas le socle');
    s.comptes.retirerSocle('client@exemple.fr', 'terraB2C3D4');
    const lea = await clientMqtt(s.portMqtt, 'lea@exemple.fr', jLea);
    assert.equal(await abonner(lea, 'terrarium/terraB2C3D4/#'), 128, 'le support n\'a pas les socles de l\'atelier');
    const cur = s.atelier.socle('terraB2C3D4');
    await appel(P, 'PUT', '/api/atelier/socles/terraB2C3D4', { socle: { ...cur, etat: 'expedie', maj: 2 }, base: cur.rev }, jJean);
    const j2 = await clientMqtt(s.portMqtt, 'jean@exemple.fr', jJean);
    assert.equal(await abonner(j2, 'terrarium/terraB2C3D4/#'), 128, 'expédié : plus du ressort de l\'atelier');
    const ex = s.audit.lire({ limite: 10 }).find(e => e.action === 'atelier.expedier');
    assert.ok(ex && ex.cible === 'terraB2C3D4' && ex.qui === 'jean@exemple.fr', 'l\'expédition est au journal d\'audit');
    for (const c of [socle, jean, lea, j2]) c.end(true);
  });

  await t.test('rodage surveillé par le serveur : incidents, verdict, alertes groupées', async () => {
    const mdp = (await appel(P, 'POST', '/api/admin/appareils', { id: 'terraC3D4E5' }, jJean)).donnees.motDePasse;
    const socle = await clientMqtt(s.portMqtt, 'terraC3D4E5', mdp);
    const base = 'terrarium/terraC3D4E5';
    const zoneOk = JSON.stringify({ temp: 31.9, consigne: 32, defaut: '0', defaut_libelle: 'OK' });
    await publier(socle, `${base}/statut`, 'en ligne', true);
    await publier(socle, `${base}/sante`, JSON.stringify({ proto: 4, uptime: 4000, reset: 'mise sous tension' }), true);
    await publier(socle, `${base}/zone1/etat`, zoneOk, true);
    const debut = Date.now() - 3600000;
    let r = await appel(P, 'PUT', '/api/atelier/socles/terraC3D4E5', { base: 0, socle: { id: 'terraC3D4E5', etape: 4, etat: 'actif', liaison: 'serveur', maj: 1,
      rodage: { debut, fin: Date.now() + 3600000, incidents: [], verdict: null }, journal: [] } }, jJean);
    assert.equal(r.status, 200);
    const fiche = () => s.atelier.socle('terraC3D4E5');
    // Un défaut puis un redémarrage, vus en direct.
    await publier(socle, `${base}/zone1/etat`, JSON.stringify({ temp: 31.9, consigne: 32, defaut: '1', defaut_libelle: 'SONDE ABSENTE' }), true);
    assert.ok(await jusqua(() => fiche().rodage.incidents.some(i => i.grave && /zone 1 : SONDE ABSENTE/.test(i.texte))), 'défaut noté par le serveur');
    await publier(socle, `${base}/zone1/etat`, zoneOk, true);
    await publier(socle, `${base}/sante`, JSON.stringify({ proto: 4, uptime: 12, reset: 'chien de garde' }), true);
    assert.ok(await jusqua(() => fiche().rodage.incidents.some(i => /redémarrage \(chien de garde\)/.test(i.texte))), 'redémarrage noté');
    assert.ok(fiche().journal.some(j => j.par === 'serveur' && /Rodage : redémarrage/.test(j.texte)), 'au journal du socle');
    r = await appel(P, 'GET', '/api/atelier/registre?depuis=0', undefined, jNoe);
    assert.ok(r.donnees.socles.find(x => x.id === 'terraC3D4E5').rodage.incidents.length >= 2, 'les postes le voient');
    // Pas encore fini : pas de verdict.
    s.atelier.tourner();
    assert.equal(fiche().rodage.verdict, null);
    // Fin : redémarré pendant le rodage (sa durée de marche le dit), défaut et redémarrage cités.
    const f = fiche();
    s.atelier.d.socles.terraC3D4E5 = { ...f, rodage: { ...f.rodage, fin: Date.now() - 1000 } };
    s.atelier.tourner();
    const v = fiche().rodage.verdict;
    assert.ok(v && !v.ok && v.par === 'serveur', 'verdict du serveur : échec');
    assert.match(v.texte, /a redémarré pendant le rodage/);
    assert.match(v.texte, /SONDE ABSENTE/);
    assert.deepEqual([fiche().etat, fiche().echec.etape], ['actif', 4]);
    // Recommencé par un poste : réussi cette fois.
    const g = fiche();
    await publier(socle, `${base}/sante`, JSON.stringify({ proto: 4, uptime: 7300, reset: 'chien de garde' }), true);
    await attendre(80);
    r = await appel(P, 'PUT', '/api/atelier/socles/terraC3D4E5', { base: g.rev, socle: { ...g, echec: null,
      rodage: { debut: Date.now() - 7200000, fin: Date.now() - 1000, incidents: [], verdict: null } } }, jJean);
    assert.equal(r.status, 200);
    s.atelier.tourner();
    assert.ok(fiche().rodage.verdict.ok, fiche().rodage.verdict.texte);
    assert.deepEqual([fiche().etat, fiche().etape], ['pret', 5], 'prêt pour l\'étiquette');
    // Alertes : groupées, envoyées à l'administrateur et au rôle atelier (pas au support ni au client).
    await appel(P, 'POST', '/api/push/abonnement', { abonnement: { endpoint: 'https://push.exemple/jean', keys: { p256dh: 'x', auth: 'y' } } }, jJean);
    const n = await s.atelier.alertes.vider();
    assert.ok(n >= 3, `${n} alertes groupées`);
    const dest = courriels.map(c => c.a).sort();
    assert.deepEqual(dest, ['jean@exemple.fr', 'noe@exemple.fr'], 'un e-mail à chaque membre de l\'atelier');
    assert.match(courriels[0].sujet, /^Atelier : .*rodage.*réussi/);
    assert.match(courriels[0].texte, /terraC3D4E5 : rodage réussi, prêt pour l'étiquette/);
    assert.match(courriels[0].texte, /https:\/\/app\.exemple\.fr\/atelier\.html/);
    assert.equal(pushs.length, 1, 'une notification sur le navigateur abonné');
    assert.deepEqual([pushs[0].charge.titre, pushs[0].charge.page, pushs[0].charge.tag], ['Atelier', 'atelier', 'atelier']);
    // Jean coupe les e-mails : Noé seul les reçoit.
    r = await appel(P, 'POST', '/api/atelier/alertes', { email: false }, jJean);
    assert.deepEqual(r.donnees.alertes, { email: false });
    r = await appel(P, 'POST', '/api/atelier/alertes', { email: false }, ADMIN);
    assert.equal(r.status, 400, 'le jeton d\'administration n\'a pas de préférences');
    courriels.length = 0;
    s.atelier.alertes.signaler({ socle: 'terraC3D4E5', type: 'incident', grave: true, texte: 'essai' });
    await s.atelier.alertes.vider();
    assert.deepEqual(courriels.map(c => c.a), ['noe@exemple.fr']);
    socle.end(true);
  });

  await t.test('rodage : socle disparu, alerte après le délai, puis verdict', async () => {
    const mdp = (await appel(P, 'POST', '/api/admin/appareils', { id: 'terraD4E5F6' }, jJean)).donnees.motDePasse;
    const socle = await clientMqtt(s.portMqtt, 'terraD4E5F6', mdp);
    await publier(socle, 'terrarium/terraD4E5F6/statut', 'en ligne', true);
    await publier(socle, 'terrarium/terraD4E5F6/sante', JSON.stringify({ proto: 4, uptime: 100 }), true);
    await appel(P, 'PUT', '/api/atelier/socles/terraD4E5F6', { base: 0, socle: { id: 'terraD4E5F6', etape: 4, etat: 'actif', liaison: 'serveur', maj: 1,
      rodage: { debut: Date.now(), fin: Date.now() + 3600000, incidents: [], verdict: null }, journal: [] } }, jJean);
    await publier(socle, 'terrarium/terraD4E5F6/statut', 'hors ligne', true);
    const fiche = () => s.atelier.socle('terraD4E5F6');
    assert.ok(await jusqua(() => fiche().rodage.incidents.some(i => i.texte === 'hors ligne' && !i.grave)), 'coupure notée');
    assert.ok(await jusqua(() => s.atelier.alertes.file.some(e => e.socle === 'terraD4E5F6' && e.type === 'horsligne')), 'alerte après le délai');
    socle.end(true);
    // Hors ligne à la fin : le serveur attend une demi-heure, puis conclut.
    const f = fiche();
    s.atelier.d.socles.terraD4E5F6 = { ...f, rodage: { ...f.rodage, fin: Date.now() - 1000 } };
    s.broker.flotte.terraD4E5F6.santeRecue = Date.now() - 10 * 60000;
    s.atelier.tourner();
    assert.equal(fiche().rodage.verdict, null, 'il reviendra peut-être');
    s.atelier.d.socles.terraD4E5F6.rodage.fin = Date.now() - 31 * 60000;
    s.atelier.tourner();
    assert.ok(fiche().rodage.verdict && !fiche().rodage.verdict.ok && /hors ligne à la fin du rodage/.test(fiche().rodage.verdict.texte));
    await s.atelier.alertes.vider();
  });

  await t.test('un socle relié au broker de l\'atelier n\'est pas surveillé ici', () => {
    const a = new Atelier(dossierTemp(), { cleSecrete: 'x' });
    a.ecrireSocle('terraE5F6A7', { etape: 4, etat: 'actif', liaison: 'broker', rodage: { debut: 1, fin: 2, incidents: [], verdict: null } }, 0, 'jean');
    assert.equal(a.surveille(a.socle('terraE5F6A7')), false);
    a.tourner();
    assert.equal(a.socle('terraE5F6A7').rodage.verdict, null, 'la page qui le voit conclut elle-même');
    assert.equal(AlertesAtelier.resume([{ type: 'pret' }, { type: 'pret' }, { type: 'echec' }, { type: 'horsligne' }]), '2 rodages réussis, 1 rodage échoué, 1 incident');
  });
});
