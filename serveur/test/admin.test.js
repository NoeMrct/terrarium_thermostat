'use strict';
/* Tests de l'administration : journal d'audit chaîné (écriture, vérification,
   ligne modifiée ou retirée, fin coupée, écrivain concurrent, purge par mois),
   identité de l'administrateur (jeton, compte marqué, refus, limitation des
   jetons inconnus), routes de la console (tableau, socles, comptes, comptes
   d'appareil, rapports, journal), garde-fous (confirmation tapée, pas
   d'effacement ni de rétrogradation de soi-même) et fichiers de la console
   servis sous une politique de sécurité stricte. Aucun secret au journal.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');
const { Audit, refCompte, ZERO } = require('../lib/audit');

const ADMIN = 'jeton-admin-de-test';
const attendre = ms => new Promise(r => setTimeout(r, ms));
const dossierTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-admin-'));

async function appel(port, methode, chemin, corps, jeton, entetes = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}), ...entetes },
    body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps))
  });
  const texte = await r.text();
  let donnees = null;
  try { donnees = JSON.parse(texte); } catch (e) { /* texte brut */ }
  return { status: r.status, donnees, texte, entetes: r.headers };
}

function attendreQue(condition, delaiMs = 4000) {
  return new Promise((res, rej) => {
    const debut = Date.now();
    const t = setInterval(() => {
      if (condition()) { clearInterval(t); res(); } else if (Date.now() - debut > delaiMs) { clearInterval(t); rej(new Error('délai dépassé')); }
    }, 25);
  });
}

test('journal d\'audit : chaîne, ruptures détectées, écrivain concurrent, purge par mois', () => {
  const d = dossierTemp();
  let maintenant = Date.parse('2026-01-15T10:00:00Z');
  const a = new Audit(d, { maintenant: () => maintenant });
  assert.deepEqual(a.verifier().ok, true, 'journal vide : intègre');
  a.noter({ qui: 'jeton d\'administration', action: 'compte.creer', cible: refCompte('Noe@Exemple.fr'), details: { admin: false } });
  maintenant += 86400000;
  a.noter({ qui: 'titulaire', action: 'socle.rattacher', cible: 'terraA1B2C3', details: { compte: refCompte('noe@exemple.fr') } });
  maintenant = Date.parse('2026-02-03T08:00:00Z');
  a.noter({ qui: 'noe@exemple.fr', action: 'rapport.lire', cible: 'x.txt' });
  let v = a.verifier();
  assert.equal(v.ok, true);
  assert.equal(v.n, 3);
  assert.equal(v.ancre, ZERO);
  assert.equal(v.depuisOrigine, true);
  assert.deepEqual(a.fichiers(), ['2026-01.ndjson', '2026-02.ndjson'], 'un fichier par mois');
  assert.match(refCompte('NOE@exemple.fr'), /^no…@exemple\.fr #[0-9a-f]{10}$/, 'référence pseudonyme, insensible à la casse');
  assert.equal(refCompte('NOE@exemple.fr'), refCompte('noe@exemple.fr'));
  assert.deepEqual(a.lire().map(e => e.action), ['rapport.lire', 'socle.rattacher', 'compte.creer'], 'du plus récent au plus ancien');
  assert.deepEqual(a.lire({ filtre: e => e.cible === 'terraA1B2C3' }).map(e => e.n), [2]);

  // Écrivain concurrent (la ligne de commande, serveur en marche) : la chaîne continue.
  new Audit(d, { maintenant: () => maintenant }).noter({ qui: 'ligne de commande', action: 'compte.admin', cible: refCompte('x@y.fr') });
  a.noter({ qui: 'serveur', action: 'test.apres' });
  v = a.verifier();
  assert.equal(v.ok, true, 'écriture concurrente reprise');
  assert.deepEqual(a.lire({ limite: 2 }).map(e => e.action), ['test.apres', 'compte.admin']);

  // Ligne modifiée.
  const fJanvier = path.join(d, 'audit', '2026-01.ndjson');
  const original = fs.readFileSync(fJanvier, 'utf8');
  fs.writeFileSync(fJanvier, original.replace('"admin":false', '"admin":true'));
  v = new Audit(d).verifier();
  assert.equal(v.ok, false);
  assert.equal(v.rupture.raison, 'ligne modifiée');
  assert.deepEqual([v.rupture.fichier, v.rupture.ligne], ['2026-01.ndjson', 1]);
  // Ligne retirée.
  fs.writeFileSync(fJanvier, original.split('\n').filter(Boolean).slice(1).join('\n') + '\n');
  v = new Audit(d).verifier();
  assert.equal(v.ok, true, 'la plus ancienne ligne retirée : la suivante devient l\'ancre (purge)');
  assert.notEqual(v.ancre, ZERO);
  fs.writeFileSync(fJanvier, original.split('\n').filter(Boolean)[0] + '\n');
  v = new Audit(d).verifier();
  assert.equal(v.ok, false, 'une ligne du milieu retirée se voit');
  assert.match(v.rupture.raison, /retirée ou insérée/);
  fs.writeFileSync(fJanvier, original);
  assert.equal(new Audit(d).verifier().ok, true, 'rétabli');

  // Fin coupée serveur en marche : vue, puis notée au journal à l'écriture suivante.
  const fFevrier = path.join(d, 'audit', '2026-02.ndjson');
  const lignes = fs.readFileSync(fFevrier, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(fFevrier, lignes.slice(0, 1).join('\n') + '\n');
  v = a.verifier();
  assert.equal(v.ok, false);
  assert.equal(v.rupture.raison, 'fin du journal coupée');
  a.noter({ qui: 'serveur', action: 'test.suite' });
  assert.equal(a.verifier().ok, true);
  assert.deepEqual(a.lire({ limite: 2 }).map(e => e.action), ['test.suite', 'audit.rupture'], 'la coupure est écrite dans le journal');

  // Purge : douze mois conservés, le treizième part.
  maintenant = Date.parse('2027-02-20T00:00:00Z');
  assert.equal(a.purger(), 1, 'janvier 2026 purgé en février 2027');
  assert.deepEqual(a.fichiers(), ['2026-02.ndjson']);
  v = a.verifier();
  assert.equal(v.ok, true);
  assert.equal(v.depuisOrigine, false, 'l\'ancre n\'est plus l\'origine');
});

test('console d\'administration : identité, routes, garde-fous, journal sans secret', async t => {
  const donnees = dossierTemp();
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, journal: () => {}, pushActif: false,
    courriel: { envoyer: async () => {} } });
  const P = s.port;
  t.after(() => s.arreter());

  await t.test('identité : jeton, compte administrateur, refus et limitation', async () => {
    assert.equal((await appel(P, 'GET', '/api/admin/tableau')).status, 403, 'sans jeton');
    assert.equal((await appel(P, 'GET', '/api/admin/tableau', undefined, 'faux')).status, 403, 'jeton faux');
    const moi = await appel(P, 'GET', '/api/admin/moi', undefined, ADMIN);
    assert.equal(moi.status, 200);
    assert.equal(moi.donnees.qui, 'jeton d\'administration');
    // Un compte ordinaire : refusé ; marqué administrateur : accepté.
    await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'chef', motDePasse: 'mot-de-passe-chef' }, ADMIN);
    const sess = await appel(P, 'POST', '/api/session', { login: 'chef', motDePasse: 'mot-de-passe-chef' });
    assert.equal(sess.donnees.admin, false);
    assert.equal((await appel(P, 'GET', '/api/admin/moi', undefined, sess.donnees.jeton)).status, 403, 'compte ordinaire');
    assert.equal((await appel(P, 'POST', '/api/admin/utilisateurs/chef/admin', { admin: true }, ADMIN)).status, 200);
    const moi2 = await appel(P, 'GET', '/api/admin/moi', undefined, sess.donnees.jeton);
    assert.equal(moi2.status, 200, 'même session, droits donnés');
    assert.equal(moi2.donnees.compte, 'chef');
    // Jetons inconnus : vingt par quart d'heure et par adresse, puis 429.
    s.api.tentativesAdmin.clear();
    for (let i = 0; i < 20; i++) await appel(P, 'GET', '/api/admin/moi', undefined, 'devine-' + i);
    assert.equal((await appel(P, 'GET', '/api/admin/moi', undefined, ADMIN)).status, 429, 'même le bon jeton attend');
    s.api.tentativesAdmin.clear();
    assert.equal((await appel(P, 'GET', '/api/admin/moi', undefined, ADMIN)).status, 200);
  });

  await t.test('socles : flotte vue du serveur, fiche, historique, rattachement', async () => {
    const r = await appel(P, 'POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, ADMIN);
    assert.equal(r.status, 201);
    assert.equal(r.donnees.motDePasse.length >= 8, true);
    // Le socle publie : statut, santé, état de deux zones (la seconde en défaut).
    const c = mqtt.connect(`mqtt://127.0.0.1:${s.portMqtt}`, { username: 'terraA1B2C3', password: r.donnees.motDePasse, clientId: 'socle-a1' });
    await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); });
    c.publish('terrarium/terraA1B2C3/statut', 'en ligne', { retain: true });
    c.publish('terrarium/terraA1B2C3/sante', JSON.stringify({ proto: 4, version: '3.5.0', uptime: 3600, rssi: -61, heap: 170000, heapMin: 140000, reset: 'mise sous tension', ip: '192.168.1.42', plantage: { tache: 'loop' } }), { retain: true });
    c.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30.6, consigne: 31, defaut: '0', defaut_libelle: 'OK', demande: 40, chauffe: '1' }));
    c.publish('terrarium/terraA1B2C3/zone2/etat', JSON.stringify({ temp: 85, consigne: 26, defaut: '1', defaut_libelle: 'sonde absente', demande: 0, chauffe: '0' }));
    await attendreQue(() => s.broker.flotte.terraA1B2C3 && Object.keys(s.broker.flotte.terraA1B2C3.zones).length === 2);

    const tab = (await appel(P, 'GET', '/api/admin/tableau', undefined, ADMIN)).donnees;
    assert.equal(tab.socles.total, 1);
    assert.equal(tab.socles.enLigne, 1);
    assert.equal(tab.socles.enDefaut, 1);
    assert.equal(tab.socles.plantages, 1);
    assert.equal(tab.socles.sansProprietaire, 1);
    assert.deepEqual(tab.socles.versions, { '3.5.0': 1 });
    assert.equal(tab.serveur.mqtt.clients >= 1, true);
    assert.equal(tab.audit.ok, true);

    const liste = (await appel(P, 'GET', '/api/admin/socles', undefined, ADMIN)).donnees.socles;
    assert.equal(liste.length, 1);
    assert.equal(liste[0].version, '3.5.0');
    assert.equal(liste[0].proto, 4);
    assert.equal(liste[0].zones[1].defaut, 'sonde absente');
    assert.equal(liste[0].appareil !== null, true);

    assert.equal((await appel(P, 'POST', '/api/admin/socles/terraA1B2C3/proprietaires', { login: 'personne' }, ADMIN)).status, 404);
    await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' }, ADMIN);
    const rat = await appel(P, 'POST', '/api/admin/socles/terraA1B2C3/proprietaires', { login: 'noe@exemple.fr' }, ADMIN);
    assert.deepEqual(rat.donnees.proprietaires, ['noe@exemple.fr']);
    const fiche = (await appel(P, 'GET', '/api/admin/socles/terraA1B2C3', undefined, ADMIN)).donnees;
    assert.equal(fiche.sante.ip, '192.168.1.42');
    assert.equal(fiche.etatsZones.length, 2);
    assert.equal(fiche.etatsZones[1].defaut_libelle, 'sonde absente');
    assert.equal(fiche.proprietairesDetail[0].login, 'noe@exemple.fr');
    assert.equal(fiche.journal[0].action, 'socle.rattacher');
    assert.equal((await appel(P, 'GET', '/api/admin/socles/terraZZZZZZ', undefined, ADMIN)).status, 404, 'socle inconnu');
    const hist = await appel(P, 'GET', '/api/admin/socles/terraA1B2C3/historique', undefined, ADMIN);
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.donnees.format, ['epoch', 't1', 'consigne1', 't2', 'consigne2']);
    const det = await appel(P, 'DELETE', `/api/admin/socles/terraA1B2C3/proprietaires/${encodeURIComponent('noe@exemple.fr')}`, undefined, ADMIN);
    assert.deepEqual(det.donnees.proprietaires, []);
    // Ancienne route des scripts : toujours là.
    assert.equal((await appel(P, 'POST', `/api/admin/utilisateurs/${encodeURIComponent('noe@exemple.fr')}/socles`, { id: 'terraA1B2C3' }, ADMIN)).status, 200);
    assert.deepEqual(s.comptes.utilisateur('noe@exemple.fr').socles, ['terraA1B2C3']);
    c.end(true);
  });

  await t.test('comptes d\'appareil : renouveler (l\'ancien tombe), retirer avec confirmation tapée', async () => {
    const avant = s.comptes.appareil('terraA1B2C3').cree;
    const r = await appel(P, 'POST', '/api/admin/appareils/terraA1B2C3/renouveler', undefined, ADMIN);
    assert.equal(r.status, 200);
    assert.ok(s.comptes.authentifierAppareil('terraA1B2C3', r.donnees.motDePasse), 'le nouveau vaut');
    assert.equal(s.comptes.appareil('terraA1B2C3').cree, avant, 'la date de création reste');
    assert.ok(s.comptes.appareil('terraA1B2C3').renouvele);
    const liste = (await appel(P, 'GET', '/api/admin/appareils', undefined, ADMIN)).donnees.appareils;
    assert.equal(liste[0].id, 'terraA1B2C3');
    assert.deepEqual(liste[0].proprietaires, ['noe@exemple.fr']);
    await appel(P, 'POST', '/api/admin/appareils', { id: 'terraD4E5F6' }, ADMIN);
    assert.equal((await appel(P, 'DELETE', '/api/admin/appareils/terraD4E5F6', {}, ADMIN)).status, 400, 'sans confirmation');
    assert.equal((await appel(P, 'DELETE', '/api/admin/appareils/terraD4E5F6', { confirmation: 'terraA1B2C3' }, ADMIN)).status, 400, 'mauvaise référence');
    assert.equal((await appel(P, 'DELETE', '/api/admin/appareils/terraD4E5F6', { confirmation: 'terraD4E5F6' }, ADMIN)).status, 200);
    assert.equal(s.comptes.appareil('terraD4E5F6'), null);
    assert.equal((await appel(P, 'POST', '/api/admin/appareils/terraD4E5F6/renouveler', undefined, ADMIN)).status, 404);
  });

  await t.test('comptes : création, sessions, mot de passe, export, clés, effacement', async () => {
    const cree = await appel(P, 'POST', '/api/admin/utilisateurs', { login: 'client@exemple.fr' }, ADMIN);
    assert.equal(cree.status, 201);
    assert.equal(cree.donnees.motDePasse.length, 16, 'mot de passe tiré, rendu une fois');
    const mdp1 = cree.donnees.motDePasse;
    const sess = await appel(P, 'POST', '/api/session', { login: 'client@exemple.fr', motDePasse: mdp1 });
    assert.equal(sess.status, 200);
    const liste = (await appel(P, 'GET', '/api/admin/utilisateurs', undefined, ADMIN)).donnees.utilisateurs;
    const ligne = liste.find(u => u.login === 'client@exemple.fr');
    assert.equal(ligne.type, 'motdepasse');
    assert.equal(ligne.sessions, 1);
    assert.ok(ligne.derniereConnexion);
    const fiche = (await appel(P, 'GET', `/api/admin/utilisateurs/${encodeURIComponent('client@exemple.fr')}`, undefined, ADMIN)).donnees;
    assert.equal(fiche.sessionsOuvertes.length, 1);
    assert.equal(fiche.reference, refCompte('client@exemple.fr'));
    assert.equal(fiche.journal[0].action, 'compte.creer');
    assert.equal(JSON.stringify(fiche).includes('empreinte'), false, 'rien de secret dans la fiche');

    const fermees = await appel(P, 'POST', `/api/admin/utilisateurs/${encodeURIComponent('client@exemple.fr')}/sessions/fermer`, undefined, ADMIN);
    assert.equal(fermees.donnees.fermees, 1);
    assert.equal((await appel(P, 'GET', '/api/moi', undefined, sess.donnees.jeton)).status, 401, 'session tombée');

    const reinit = await appel(P, 'POST', `/api/admin/utilisateurs/${encodeURIComponent('client@exemple.fr')}/mot-de-passe`, undefined, ADMIN);
    assert.equal(reinit.status, 200);
    assert.equal((await appel(P, 'POST', '/api/session', { login: 'client@exemple.fr', motDePasse: mdp1 })).status, 401, 'l\'ancien ne vaut plus');
    assert.equal((await appel(P, 'POST', '/api/session', { login: 'client@exemple.fr', motDePasse: reinit.donnees.motDePasse })).status, 200);

    // Compte par e-mail : pas de mot de passe à réinitialiser.
    s.comptes.obtenirParEmail('mail@exemple.fr');
    assert.equal((await appel(P, 'POST', `/api/admin/utilisateurs/${encodeURIComponent('mail@exemple.fr')}/mot-de-passe`, undefined, ADMIN)).status, 400);

    // Clé d'accès retirée (téléphone perdu).
    s.comptes.ajouterCle('mail@exemple.fr', { id: 'Q2xlZGVUZXN0MDAwMDAwMDA', jwk: {}, alg: -7, nom: 'Téléphone de test' });
    assert.equal((await appel(P, 'DELETE', `/api/admin/utilisateurs/${encodeURIComponent('mail@exemple.fr')}/cles/Q2xlZGVUZXN0MDAwMDAwMDA`, undefined, ADMIN)).status, 200);
    assert.equal(s.comptes.utilisateur('mail@exemple.fr').cles.length, 0);

    // Export (droit d'accès) : le compte et ce que le journal dit de lui, sans nommer l'équipe.
    const exp = await appel(P, 'GET', `/api/admin/utilisateurs/${encodeURIComponent('noe@exemple.fr')}/export`, undefined, ADMIN);
    assert.equal(exp.status, 200);
    assert.equal(exp.donnees.compte.identifiant, 'noe@exemple.fr');
    assert.ok(exp.donnees.journal.length >= 3);
    assert.equal(exp.donnees.journal.every(e => ['exploitant', 'titulaire'].includes(e.par)), true);

    // Garde-fous : confirmation tapée.
    assert.equal((await appel(P, 'DELETE', `/api/admin/utilisateurs/${encodeURIComponent('noe@exemple.fr')}`, { confirmation: 'noe' }, ADMIN)).status, 400);
    const eff = await appel(P, 'DELETE', `/api/admin/utilisateurs/${encodeURIComponent('noe@exemple.fr')}`, { confirmation: 'NOE@exemple.fr' }, ADMIN);
    assert.equal(eff.status, 200);
    assert.equal(eff.donnees.historiquesEffaces, 1, 'le socle n\'a plus de propriétaire : son historique part');
    assert.equal(s.comptes.utilisateur('noe@exemple.fr'), null);
    assert.equal((await appel(P, 'GET', `/api/admin/utilisateurs/${encodeURIComponent('noe@exemple.fr')}`, undefined, ADMIN)).status, 404);
  });

  await t.test('un administrateur ne se retire ni ses droits ni son compte', async () => {
    const sess = await appel(P, 'POST', '/api/session', { login: 'chef', motDePasse: 'mot-de-passe-chef' });
    const J = sess.donnees.jeton;
    assert.equal((await appel(P, 'POST', '/api/admin/utilisateurs/chef/admin', { admin: false }, J)).status, 400);
    assert.equal((await appel(P, 'DELETE', '/api/admin/utilisateurs/chef', { confirmation: 'chef' }, J)).status, 400);
    assert.equal(s.comptes.utilisateur('chef').admin, true);
    // Ce qu'il fait est noté sous son nom.
    assert.equal((await appel(P, 'POST', '/api/admin/appareils/terraA1B2C3/renouveler', undefined, J)).status, 200);
    const j = (await appel(P, 'GET', '/api/admin/audit?limite=5', undefined, J)).donnees;
    assert.equal(j.entrees[0].qui, 'chef');
    assert.equal(j.entrees[0].action, 'appareil.renouveler');
  });

  await t.test('rapports : liste, lecture notée au journal, nom contrôlé, suppression', async () => {
    const client = await appel(P, 'POST', '/api/session', { login: 'chef', motDePasse: 'mot-de-passe-chef' });
    const envoi = await appel(P, 'POST', '/api/rapports', 'Rapport de test\nSocle terraA1B2C3\n', client.donnees.jeton);
    assert.equal(envoi.status, 201);
    const liste = (await appel(P, 'GET', '/api/admin/rapports', undefined, ADMIN)).donnees.rapports;
    assert.equal(liste.length, 1);
    assert.equal(liste[0].compte, 'chef');
    assert.equal(liste[0].octets > 10, true);
    const lu = await appel(P, 'GET', `/api/admin/rapports/${encodeURIComponent(liste[0].nom)}`, undefined, ADMIN);
    assert.equal(lu.status, 200);
    assert.match(lu.entetes.get('content-type'), /^text\/plain/);
    assert.match(lu.entetes.get('content-security-policy'), /sandbox/);
    assert.match(lu.texte, /Rapport de test/);
    for (const mauvais of ['..%2Fcomptes.json', '%2E%2E%2F%2E%2E%2Fserveur.js', 'comptes.json', '2026-01-01T00-00-00-000Z-x.txt%00']) {
      const r = await appel(P, 'GET', `/api/admin/rapports/${mauvais}`, undefined, ADMIN);
      assert.equal([400, 404].includes(r.status), true, mauvais);
    }
    assert.equal((await appel(P, 'DELETE', `/api/admin/rapports/${encodeURIComponent(liste[0].nom)}`, undefined, ADMIN)).status, 200);
    assert.equal((await appel(P, 'GET', '/api/admin/rapports', undefined, ADMIN)).donnees.rapports.length, 0);
  });

  await t.test('journal : chaque geste, filtres, export, vérification, aucun secret', async () => {
    const j = (await appel(P, 'GET', '/api/admin/audit?limite=500', undefined, ADMIN)).donnees;
    assert.equal(j.verification.ok, true);
    const actions = new Set(j.entrees.map(e => e.action));
    for (const a of ['compte.creer', 'compte.admin', 'socle.rattacher', 'socle.detacher', 'appareil.creer', 'appareil.renouveler', 'appareil.retirer',
      'compte.sessions.fermer', 'compte.motdepasse', 'compte.cle.retirer', 'compte.export', 'compte.supprimer', 'rapport.envoyer', 'rapport.lire', 'rapport.supprimer']) {
      assert.ok(actions.has(a), `au journal : ${a}`);
    }
    assert.ok(j.entrees.some(e => e.qui === 'chef'), 'le compte administrateur est nommé');
    assert.ok(j.entrees.some(e => e.qui === 'titulaire' && e.action === 'rapport.envoyer'));
    // Filtre par compte : retrouvé par sa référence, même effacé.
    const parCompte = (await appel(P, 'GET', `/api/admin/audit?compte=${encodeURIComponent('NOE@exemple.fr')}`, undefined, ADMIN)).donnees.entrees;
    assert.ok(parCompte.some(e => e.action === 'compte.supprimer'));
    assert.equal(parCompte.every(e => (e.cible || '').endsWith(refCompte('noe@exemple.fr').split(' ')[1]) || (e.details && e.details.compte === refCompte('noe@exemple.fr'))), true);
    const parSocle = (await appel(P, 'GET', '/api/admin/audit?cible=terraA1B2C3', undefined, ADMIN)).donnees.entrees;
    assert.equal(parSocle.every(e => e.cible === 'terraA1B2C3'), true);
    const exp = await appel(P, 'GET', '/api/admin/audit/export?cible=terraA1B2C3', undefined, ADMIN);
    assert.equal(exp.status, 200);
    assert.match(exp.entetes.get('content-disposition'), /terrariums-audit\.ndjson/);
    assert.equal(exp.texte.trim().split('\n').length, parSocle.length);
    // Aucun mot de passe, jeton ni adresse complète d'un client sur le disque du journal.
    const brut = fs.readdirSync(path.join(donnees, 'audit')).map(f => fs.readFileSync(path.join(donnees, 'audit', f), 'utf8')).join('');
    for (const secret of [ADMIN, 'mot-de-passe-noe', 'noe@exemple.fr', 'client@exemple.fr', 'mail@exemple.fr']) assert.equal(brut.includes(secret), false, `absent du journal : ${secret}`);
    assert.equal(/"motDePasse":"(?!fourni"|tiré par la console")/.test(brut), false, 'seulement « fourni » ou « tiré par la console »');
  });

  await t.test('fichiers de la console : servis seuls, sous une politique stricte', async () => {
    const r = await fetch(`http://127.0.0.1:${P}/console`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/console/');
    for (const [chemin, type] of [['/console/', 'text/html'], ['/console/console.js', 'text/javascript'], ['/console/console.css', 'text/css'],
      ['/console/style.css', 'text/css'], ['/console/polices/inter-latin-wght.woff2', 'font/woff2']]) {
      const f = await fetch(`http://127.0.0.1:${P}${chemin}`);
      assert.equal(f.status, 200, chemin);
      assert.match(f.headers.get('content-type'), new RegExp('^' + type.replace('/', '\\/')), chemin);
      const csp = f.headers.get('content-security-policy');
      for (const d of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), `${chemin} : ${d}`);
      assert.equal(f.headers.get('x-frame-options'), 'DENY');
      assert.equal(f.headers.get('referrer-policy'), 'no-referrer');
    }
    for (const chemin of ['/console/../serveur.js', '/console/%2e%2e/serveur.js', '/console/lib/api.js', '/console/polices/../../serveur/serveur.js', '/console/app.js']) {
      assert.equal((await fetch(`http://127.0.0.1:${P}${chemin}`)).status, 404, chemin);
    }
    const html = await (await fetch(`http://127.0.0.1:${P}/console/`)).text();
    assert.equal(/<script>|<style>|\son[a-z]+=/i.test(html), false, 'aucun script, style ni gestionnaire en ligne');
  });

  await attendre(10);
});
