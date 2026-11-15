'use strict';
/* Carnet du mois par e-mail : le mois couvert (fuseau du serveur), le résumé
   tiré de l'historique et des événements, le texte, l'envoi du 1er (heure,
   une fois par mois, essais limités), les routes du titulaire (activation
   avec un premier carnet, noms des socles, compte sans e-mail, serveur sans
   SMTP) et l'export du compte.
     npm test  (node --test test/) */

process.env.TZ = 'Europe/Paris';      // les jours et les mois du carnet suivent le fuseau du serveur

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demarrerServeur } = require('../serveur');
const { Comptes } = require('../lib/comptes');
const { Historique } = require('../lib/historique');
const { Evenements } = require('../lib/evenements');
const { Carnets, moisCouvert, prochainEnvoi, deMois } = require('../lib/carnets');

const dossierTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-carnets-'));
const local = (a, m, j, h = 0, min = 0) => new Date(a, m - 1, j, h, min).getTime();
const NBSP = ' ';

// Des points d'historique écrits comme le serveur les écrit (un fichier par jour UTC).
function ecrirePoints(donnees, id, points) {
  const d = path.join(donnees, 'historique', id);
  fs.mkdirSync(d, { recursive: true });
  for (const p of points) fs.appendFileSync(path.join(d, new Date(p[0] * 1000).toISOString().slice(0, 10) + '.ndjson'), JSON.stringify(p) + '\n');
}
function ecrireEvenement(donnees, id, quand, type) {
  const d = path.join(donnees, 'evenements', id);
  fs.mkdirSync(d, { recursive: true });
  const t = new Date(quand).toISOString();
  fs.appendFileSync(path.join(d, `${t.slice(0, 7)}.ndjson`), JSON.stringify({ t, type }) + '\n');
}

async function appel(port, methode, chemin, corps, jeton) {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, { method: methode,
    headers: { ...(corps !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  let donnees = null;
  try { donnees = await r.json(); } catch (e) { /* vide */ }
  return { status: r.status, donnees };
}

test('mois couvert, prochain envoi, élision', () => {
  const m = moisCouvert(local(2026, 11, 1, 9));
  assert.equal(m.cle, '2026-10');
  assert.equal(m.jours, 31);
  assert.equal(m.debut, local(2026, 10, 1));
  assert.equal(m.fin, local(2026, 11, 1));
  assert.equal(moisCouvert(local(2026, 1, 15)).cle, '2025-12', 'janvier couvre décembre de l\'année d\'avant');
  assert.equal(moisCouvert(local(2028, 3, 2)).jours, 29, 'février bissextile');
  assert.equal(prochainEnvoi(local(2026, 11, 15)), '2026-12-01');
  assert.equal(prochainEnvoi(local(2026, 12, 31, 23)), '2027-01-01');
  assert.deepEqual([deMois(9), deMois(7), deMois(3), deMois(10)], ['d’octobre', 'd’août', 'd’avril', 'de novembre']);
});

test('résumé et texte du carnet', () => {
  const donnees = dossierTemp();
  try {
    const comptes = new Comptes(donnees);
    const historique = new Historique(donnees);
    const evenements = new Evenements(donnees);
    // Trois jours d'octobre, un point toutes les 10 minutes ; zone 2 absente
    // (socle à une zone). Le 1er à minuit (heure de Paris) est le 30 septembre en UTC.
    const points = [];
    for (let j = 1; j <= 3; j++) {
      for (let k = 0; k < 144; k++) {
        const e = Math.floor(local(2026, 10, j) / 1000) + k * 600;
        const t = j === 2 && k === 36 ? 2400 : j === 3 && k === 90 ? 3150 : 2800 + (k % 2 ? 50 : -50);
        points.push([e, t, k < 72 ? 2800 : 3000, null, null]);
      }
    }
    // Hors du mois : ni le 30 septembre (Paris), ni le 1er novembre.
    points.unshift([Math.floor(local(2026, 9, 30, 23, 50) / 1000), 1000, 2800, null, null]);
    points.push([Math.floor(local(2026, 11, 1, 0, 10) / 1000), 4000, 2800, null, null]);
    ecrirePoints(donnees, 'terraAAA111', points);
    ecrireEvenement(donnees, 'terraAAA111', local(2026, 10, 2, 12), 'defaut');
    ecrireEvenement(donnees, 'terraAAA111', local(2026, 10, 2, 13), 'retabli');
    ecrireEvenement(donnees, 'terraAAA111', local(2026, 10, 5), 'derive');
    ecrireEvenement(donnees, 'terraAAA111', local(2026, 10, 9), 'derive');
    ecrireEvenement(donnees, 'terraAAA111', local(2026, 11, 1, 3), 'derive');       // novembre : pas compté
    comptes.obtenirParEmail('noe@exemple.fr');
    comptes.attribuerSocle('noe@exemple.fr', 'terraAAA111');
    comptes.attribuerSocle('noe@exemple.fr', 'terraBBB222');
    comptes.definirCarnet('noe@exemple.fr', { actif: true, noms: { terraAAA111: 'Terrarium du salon', terraZZZ999: 'Pas à moi' } });
    const carnets = new Carnets({ comptes, historique, evenements, nomZone: (id, z) => (z === 0 ? 'Point chaud' : `Zone ${z + 1}`) });
    const m = moisCouvert(local(2026, 11, 1, 9));

    const r = carnets.resumeSocle('terraAAA111', m);
    assert.equal(r.jours, 3, 'trois jours avec des mesures, hors des bornes exclus');
    assert.equal(r.zones[0].n, 432);
    assert.equal(r.zones[1].n, 0, 'zone absente');
    assert.equal(r.zones[0].min.v, 2400);
    assert.equal(r.zones[0].max.v, 3150);
    assert.deepEqual(r.alertes, { defaut: 1, retabli: 1, derive: 2 });

    const u = comptes.utilisateur('noe@exemple.fr');
    assert.deepEqual(u.carnet.noms, { terraAAA111: 'Terrarium du salon' }, 'seuls les socles du compte gardent un nom');
    const { sujet, texte } = carnets.rediger(u, m, [r, carnets.resumeSocle('terraBBB222', m)]);
    assert.equal(sujet, 'Carnet d’octobre 2026 · Terrariums');
    assert.match(texte, /^Bonjour,\n\nVoici le carnet d’octobre 2026 de vos socles\./);
    assert.ok(texte.includes('\nTerrarium du salon\n'), 'le nom donné dans l\'application');
    assert.ok(texte.includes(`· Point chaud : moyenne 28,0${NBSP}°C, de 24,0${NBSP}°C (le 2 à 6${NBSP}h${NBSP}00) à 31,5${NBSP}°C (le 3 à 15${NBSP}h${NBSP}00)`), texte);
    assert.ok(texte.includes(`; à ±1${NBSP}°C de la consigne 50${NBSP}% du temps.`), 'temps près de la consigne');
    assert.ok(texte.includes(`· Mesures reçues 3${NBSP}jours sur 31.`));
    assert.ok(texte.includes(`· Alertes vues par le serveur : 1${NBSP}défaut, 2${NBSP}dérives.`));
    assert.ok(!texte.includes('Zone 2 :'), 'zone sans mesure : pas de ligne');
    assert.ok(texte.includes('\nterraBBB222\n· Aucune mesure reçue en octobre'), 'socle sans nom ni mesure');
    assert.equal(texte.split('Aucune alerte').length, 1, 'rien vu du tout : pas de ligne d\'alertes');
    assert.ok(texte.includes('Réglages, puis Exports'), 'comment arrêter');
    assert.ok(!/https?:\/\//.test(texte), 'aucun lien');
  } finally { fs.rmSync(donnees, { recursive: true, force: true }); }
});

test('envoi du 1er : heure, une fois par mois, essais limités', async () => {
  const donnees = dossierTemp();
  try {
    const comptes = new Comptes(donnees);
    const historique = new Historique(donnees);
    const boite = [], journal = [];
    let panne = false;
    const courriel = { envoyer: async msg => { if (panne) throw new Error('relais injoignable'); boite.push(msg); } };
    const carnets = new Carnets({ comptes, historique, courriel, journal: l => journal.push(l) });
    for (const e of ['noe@exemple.fr', 'emma@exemple.fr', 'vide@exemple.fr', 'non@exemple.fr']) comptes.obtenirParEmail(e);
    comptes.attribuerSocle('noe@exemple.fr', 'terraAAA111');
    comptes.attribuerSocle('emma@exemple.fr', 'terraBBB222');
    comptes.attribuerSocle('non@exemple.fr', 'terraCCC333');
    comptes.ajouterUtilisateur('atelier', 'motdepasse-solide');
    comptes.attribuerSocle('atelier', 'terraDDD444');
    // « atelier » (identifiant sans e-mail) : actif dans le fichier, mais pas abonné.
    for (const l of ['noe@exemple.fr', 'emma@exemple.fr', 'vide@exemple.fr', 'atelier']) comptes.definirCarnet(l, { actif: true, dernier: '2026-09' });
    assert.deepEqual(comptes.abonnesCarnet().map(u => u.login).sort(), ['emma@exemple.fr', 'noe@exemple.fr', 'vide@exemple.fr']);

    assert.equal(await carnets.tourner(local(2026, 10, 31, 22)), 0, 'octobre en cours : septembre est déjà couvert');
    assert.equal(await carnets.tourner(local(2026, 11, 1, 7, 59)), 0, 'le 1er, pas avant 8 h');
    assert.equal(await carnets.tourner(local(2026, 11, 1, 8, 5)), 2, 'deux abonnés avec des socles');
    assert.deepEqual(boite.map(b => b.a).sort(), ['emma@exemple.fr', 'noe@exemple.fr']);
    assert.ok(boite.every(b => b.sujet === 'Carnet d’octobre 2026 · Terrariums'));
    assert.equal(comptes.utilisateur('noe@exemple.fr').carnet.dernier, '2026-10');
    assert.equal(comptes.utilisateur('vide@exemple.fr').carnet.dernier, '2026-09', 'sans socle : rien envoyé');
    assert.ok(journal.some(l => /carnet 2026-10 envoyé à 2 compte/.test(l)));
    assert.equal(await carnets.tourner(local(2026, 11, 1, 9, 5)), 0, 'une fois par mois');
    assert.equal(await carnets.tourner(local(2026, 11, 12, 9)), 0);

    // Un relais en panne : trois essais dans le mois, puis plus rien.
    panne = true;
    for (let h = 8; h < 14; h++) await carnets.tourner(local(2026, 12, 1, h, 5));
    assert.equal(journal.filter(l => /carnet 2026-11 non envoyé à no…@exemple\.fr : relais injoignable/.test(l)).length, 3);
    assert.ok(!journal.some(l => l.includes('noe@exemple.fr')), 'l\'adresse entière ne va jamais au journal');
    panne = false;
    assert.equal(await carnets.tourner(local(2026, 12, 2, 9)), 0, 'novembre abandonné après trois échecs');
    assert.equal(await carnets.tourner(local(2027, 1, 1, 10)), 2, 'le mois suivant repart');
    assert.equal(comptes.utilisateur('emma@exemple.fr').carnet.dernier, '2026-12');

    // Serveur arrêté le 1er : le carnet part au redémarrage, même plus tard.
    comptes.definirCarnet('emma@exemple.fr', { actif: false });
    assert.equal(await carnets.tourner(local(2027, 2, 3, 15)), 1, 'parti le 3 février');
    assert.equal(boite[boite.length - 1].a, 'noe@exemple.fr', 'désactivé : plus rien pour emma');
    assert.equal(await new Carnets({ comptes, historique, courriel: null }).tourner(local(2027, 3, 1, 9)), 0, 'sans SMTP : rien');
  } finally { fs.rmSync(donnees, { recursive: true, force: true }); }
});

test('routes du titulaire : activation, noms, sans e-mail, export, sans SMTP', async t => {
  const donnees = dossierTemp();
  const boite = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: 'admin-de-test', journal: () => {}, pushActif: false,
    courriel: { envoyer: async m => { boite.push(m); } } });
  t.after(async () => { await s.arreter(); fs.rmSync(donnees, { recursive: true, force: true }); });
  const m = moisCouvert();
  const jour = Math.floor((m.debut + 3 * 86400000 + 12 * 3600000) / 1000);
  ecrirePoints(donnees, 'terraAAA111', [[jour, 2810, 2800, 2405, 2400], [jour + 60, 2830, 2800, 2410, 2400]]);
  s.comptes.obtenirParEmail('noe@exemple.fr');
  s.comptes.attribuerSocle('noe@exemple.fr', 'terraAAA111');
  const jeton = s.comptes.ouvrirSession('noe@exemple.fr');

  await t.test('infos et état initial', async () => {
    assert.equal((await appel(s.port, 'GET', '/api/infos')).donnees.comptes.carnet, true);
    assert.equal((await appel(s.port, 'GET', '/api/moi/carnet')).status, 401, 'session requise');
    const r = await appel(s.port, 'GET', '/api/moi/carnet', undefined, jeton);
    assert.deepEqual([r.donnees.disponible, r.donnees.actif, r.donnees.email, r.donnees.socles, r.donnees.prochain], [true, false, 'noe@exemple.fr', ['terraAAA111'], prochainEnvoi()]);
  });

  await t.test('activation : le carnet du mois écoulé part tout de suite', async () => {
    assert.equal((await appel(s.port, 'POST', '/api/moi/carnet', { actif: 'oui' }, jeton)).status, 400);
    const r = await appel(s.port, 'POST', '/api/moi/carnet', { actif: true, noms: { terraAAA111: ' Salon\n', terraZZZ999: 'Intrus' } }, jeton);
    assert.equal(r.status, 200);
    assert.deepEqual([r.donnees.actif, r.donnees.envoye, r.donnees.dernier], [true, m.cle, m.cle]);
    assert.deepEqual(r.donnees.noms, { terraAAA111: 'Salon' }, 'nom nettoyé, socle d\'un autre ignoré');
    assert.equal(boite.length, 1);
    assert.equal(boite[0].a, 'noe@exemple.fr');
    assert.equal(boite[0].sujet, `Carnet ${deMois(m.index)} ${m.annee} · Terrariums`);
    assert.ok(boite[0].texte.includes('\nSalon\n· Zone 1 : moyenne 28,2') && boite[0].texte.includes('· Zone 2 : moyenne 24,1'), boite[0].texte);
    assert.ok(s.audit.lire({ limite: 20 }).some(e => e.action === 'compte.carnet' && e.details && e.details.actif === true), 'au journal d\'audit');
  });

  await t.test('noms mis à jour sans nouvel envoi ; arrêt puis reprise dans le mois', async () => {
    const r = await appel(s.port, 'POST', '/api/moi/carnet', { noms: { terraAAA111: 'Vivarium' } }, jeton);
    assert.deepEqual([r.donnees.actif, r.donnees.noms.terraAAA111, r.donnees.envoye], [true, 'Vivarium', undefined]);
    assert.equal((await appel(s.port, 'POST', '/api/moi/carnet', { actif: false }, jeton)).donnees.actif, false);
    const repris = await appel(s.port, 'POST', '/api/moi/carnet', { actif: true }, jeton);
    assert.deepEqual([repris.donnees.actif, repris.donnees.envoye], [true, undefined], 'le mois écoulé est déjà couvert');
    assert.equal(boite.length, 1);
    const exp = (await appel(s.port, 'GET', '/api/moi/export', undefined, jeton)).donnees;
    assert.deepEqual([exp.carnetMensuel.actif, exp.carnetMensuel.dernierMoisCouvert, exp.carnetMensuel.nomsDesSocles], [true, m.cle, { terraAAA111: 'Vivarium' }]);
    s.comptes.retirerSocle('noe@exemple.fr', 'terraAAA111');
    assert.deepEqual(s.comptes.utilisateur('noe@exemple.fr').carnet.noms, {}, 'socle détaché : son nom part aussi');
  });

  await t.test('compte sans adresse e-mail : refusé', async () => {
    s.comptes.ajouterUtilisateur('atelier', 'motdepasse-solide');
    const j = s.comptes.ouvrirSession('atelier');
    assert.equal((await appel(s.port, 'GET', '/api/moi/carnet', undefined, j)).donnees.email, null);
    const r = await appel(s.port, 'POST', '/api/moi/carnet', { actif: true }, j);
    assert.equal(r.status, 400);
    assert.match(r.donnees.erreur, /adresse e-mail/);
  });

  await t.test('serveur sans SMTP : annoncé, et refusé', async () => {
    const d2 = dossierTemp();
    const s2 = await demarrerServeur({ port: 0, portMqtt: 0, donnees: d2, journal: () => {}, pushActif: false, courriel: null });
    try {
      assert.equal((await appel(s2.port, 'GET', '/api/infos')).donnees.comptes.carnet, false);
      s2.comptes.ajouterUtilisateur('emma@exemple.fr', 'motdepasse-solide');
      const j = s2.comptes.ouvrirSession('emma@exemple.fr');
      assert.equal((await appel(s2.port, 'GET', '/api/moi/carnet', undefined, j)).donnees.disponible, false);
      assert.equal((await appel(s2.port, 'POST', '/api/moi/carnet', { actif: true }, j)).status, 503);
    } finally { await s2.arreter(); fs.rmSync(d2, { recursive: true, force: true }); }
  });
});
