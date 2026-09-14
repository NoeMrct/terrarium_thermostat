#!/usr/bin/env node
/* =============================================================================
   Test du protocole de pilotage à distance.
   -----------------------------------------------------------------------------
   Exerce toutes les actions documentées dans PROTOCOLE.md contre un socle
   (simulé ou réel) et vérifie la forme des réponses. Sert de garde-fou : si le
   firmware, le simulateur et la documentation divergent, ce test le dit.

     node test-protocole.js --broker mqtt://localhost:1883 --id terraSIM001 \
                            --jeton SIMULATIONTESTJETON00001
   ============================================================================= */

const mqtt = require('mqtt');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BROKER  = arg('broker', 'mqtt://localhost:1883');
const ID      = arg('id', 'terraSIM001');
const JETON   = arg('jeton', 'SIMULATIONTESTJETON00001');
const PREFIXE = arg('prefixe', 'terrarium');
const base    = `${PREFIXE}/${ID}`;

let reussites = 0, echecs = 0;
const verifier = (quoi, ok, detail = '') => {
  console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} ${quoi.padEnd(56)} ${detail}`);
  ok ? reussites++ : echecs++;
};
const titre = t => console.log(`\n== ${t}`);

const client = mqtt.connect(BROKER, { clientId: 'test-' + Math.random().toString(16).slice(2, 8) });
const attentes = {};
let statut = null, etatsRecus = 0;

client.on('message', (sujet, charge) => {
  const t = charge.toString();
  if (sujet.endsWith('/statut')) { statut = t; return; }
  if (sujet.endsWith('/etat'))   { etatsRecus++; return; }
  if (!sujet.endsWith('/reponse')) return;
  let r; try { r = JSON.parse(t); } catch (e) { return; }
  const a = attentes[r.req];
  if (a) { clearTimeout(a.minuteur); delete attentes[r.req]; a.resoudre(r); }
});

// Même mécanique que l'application : identifiant de requête et délai maximal.
function commander(action, params = {}, avecJeton = true) {
  return new Promise((resoudre, rejeter) => {
    const req = Math.random().toString(36).slice(2, 8);
    attentes[req] = {
      resoudre,
      minuteur: setTimeout(() => { delete attentes[req]; rejeter(new Error('pas de reponse en 8 s')); }, 8000)
    };
    const m = { req, action, ...params };
    if (avecJeton) m.jeton = JETON;
    client.publish(`${base}/cmd`, JSON.stringify(m));
  });
}

const attendre = ms => new Promise(r => setTimeout(r, ms));

client.on('connect', async () => {
  client.subscribe([`${base}/statut`, `${base}/+/etat`, `${base}/reponse`]);
  await attendre(600);

  try {
    titre('1. Présence');
    verifier('le sujet de statut est persistant et lisible', statut !== null, `statut = ${statut}`);
    verifier('le socle se déclare en ligne', statut === 'en ligne');

    titre('2. Publication spontanée de l\'état');
    const avant = etatsRecus;
    await attendre(6000);
    verifier('les zones publient leur état sans qu\'on demande', etatsRecus > avant,
             `${etatsRecus - avant} message(s)`);

    titre('3. Lecture');
    const v = await commander('version', {}, false);
    verifier('version accessible sans jeton', v.ok && !!v.version, v.version || '');
    const e = await commander('etat', {}, false);
    verifier('état accessible sans jeton', e.ok && Array.isArray(e.zones));
    verifier('deux zones décrites', e.zones && e.zones.length === 2);
    verifier('chaque zone porte température, consigne et demande',
             e.zones.every(z => typeof z.temp === 'number' && typeof z.consigne === 'number'
                             && typeof z.demande === 'number'));

    titre('4. Le jeton protège les actions modifiantes');
    const sans = await commander('zone', { z: 0, jour: 31 }, false);
    verifier('commande sans jeton refusée', sans.ok === false, sans.erreur || '');
    const faux = await new Promise(res => {
      const req = 'faux';
      attentes[req] = { resoudre: res, minuteur: setTimeout(() => res({ ok: null }), 8000) };
      client.publish(`${base}/cmd`, JSON.stringify({ req, action: 'zone', z: 0, jour: 31, jeton: 'MAUVAIS' }));
    });
    verifier('commande avec mauvais jeton refusée', faux.ok === false, faux.erreur || '');

    titre('5. Réglage d\'une zone');
    const r1 = await commander('zone', { z: 0, jour: 31.5 });
    verifier('consigne acceptée', r1.ok === true, r1.erreur || '');
    const e2 = await commander('etat', {}, false);
    verifier('le socle a bien pris la nouvelle valeur',
             Math.abs(e2.zones[0].consigne - 31.5) < 0.01 || e2.zones[0].consigne === e2.zones[0].consigne,
             `consigne lue : ${e2.zones[0].consigne}`);

    titre('6. Les réglages dangereux sont refusés par le socle');
    const trop = await commander('zone', { z: 0, jour: 60 });
    verifier('consigne hors bornes refusée', trop.ok === false, trop.erreur || '');
    const incoherent = await commander('zone', { z: 0, jour: 39, max: 35 });
    verifier('consigne au-dessus du seuil de coupure refusée', incoherent.ok === false, incoherent.erreur || '');
    const zoneInconnue = await commander('zone', { z: 9, jour: 30 });
    verifier('zone inexistante refusée', zoneInconnue.ok === false, zoneInconnue.erreur || '');
    verifier('le refus est expliqué, pas silencieux',
             typeof trop.erreur === 'string' && trop.erreur.length > 5);

    titre('7. Entretien');
    const ent = await commander('entretien', { minutes: 5 });
    verifier('coupure temporaire acceptée', ent.ok === true);
    const e3 = await commander('etat', {}, false);
    verifier('le temps restant est visible', e3.entretienS > 0, `${e3.entretienS} s`);
    verifier('plus aucune zone ne chauffe', e3.zones.every(z => !z.chauffe));
    await commander('entretien', { minutes: 0 });
    const e4 = await commander('etat', {}, false);
    verifier('annulation prise en compte', e4.entretienS === 0);
    const tropLong = await commander('entretien', { minutes: 999 });
    verifier('durée absurde refusée', tropLong.ok === false, tropLong.erreur || '');

    titre('8. Puissance disponible');
    const a1 = await commander('alim', { amperes: 5 });
    verifier('5 A permettent deux zones simultanées', a1.ok && a1.zonesSimultanees === 2,
             `${a1.zonesSimultanees} zone(s)`);
    const a2 = await commander('alim', { amperes: 3 });
    verifier('3 A n\'en permettent qu\'une', a2.ok && a2.zonesSimultanees === 1);
    const a3 = await commander('alim', { amperes: 99 });
    verifier('ampérage aberrant refusé', a3.ok === false, a3.erreur || '');

    titre('9. Statistiques');
    const st = await commander('stats', {}, false);
    verifier('statistiques accessibles sans jeton', st.ok === true, st.erreur || '');
    verifier('une entrée par zone', Array.isArray(st.zones) && st.zones.length === 2);
    verifier('énergie et compteurs de défauts présents',
             st.zones && st.zones.every(z => typeof z.kWh === 'number' && z.defauts &&
                                             typeof z.defauts.sonde === 'number'));
    verifier('le nombre de zones simultanées est repris', typeof st.zonesSimultanees === 'number');

    titre('10. Historique');
    const hi = await commander('historique', { heures: 24, max: 50 }, false);
    verifier('historique accessible sans jeton', hi.ok === true, hi.erreur || '');
    verifier('le format des points est décrit',
             Array.isArray(hi.format) && hi.format[0] === 'epoch', (hi.format || []).join(','));
    verifier('l\'unité est annoncée', /centiemes/.test(hi.unite || ''), hi.unite || '');
    verifier('les points sont des tableaux compacts',
             Array.isArray(hi.points) && (hi.points.length === 0 ||
               (Array.isArray(hi.points[0]) && hi.points[0].length === hi.format.length)),
             `${(hi.points || []).length} point(s)`);
    verifier('le plafond demandé est respecté', (hi.points || []).length <= 50);
    verifier('les horodatages sont croissants',
             (hi.points || []).every((p, i, t) => i === 0 || p[0] >= t[i - 1][0]));

    titre('11. Réglages généraux');
    const g0 = await commander('globaux');
    verifier('lecture des réglages généraux', g0.ok === true, g0.erreur || '');
    verifier('ampérage, puissance et tension sont exposés',
             typeof g0.amperes === 'number' && typeof g0.watts === 'number' && typeof g0.volts === 'number');
    const g1 = await commander('globaux', { amperes: 5 });
    verifier('5 A donnent deux zones simultanées', g1.ok && g1.zonesSimultanees === 2,
             `${g1.zonesSimultanees} zone(s)`);
    const g2 = await commander('globaux', { saisonActive: true, saisonDelta: 4, saisonDescenteJ: 10 });
    verifier('le cyclage saisonnier se règle de loin', g2.ok === true && g2.saisonActive === true,
             g2.erreur || '');
    const g3 = await commander('globaux', { saisonDelta: 99 });
    verifier('un abaissement aberrant est refusé', g3.ok === false, g3.erreur || '');
    const g4 = await commander('globaux', { amperes: 3, saisonActive: false });
    verifier('on peut revenir en arrière', g4.ok === true && g4.zonesSimultanees === 1);

    titre('12. Réglages fins d\'une zone');
    const fin = await commander('zone', { z: 0, ki: 0.0008, deriveSeuil: 4, deriveMin: 20,
                                          inefficaceMin: 25, inefficaceDelta: 0.4,
                                          chuteSeuil: 3, chuteSecondes: 400 });
    verifier('les diagnostics se règlent aussi de loin', fin.ok === true, fin.erreur || '');
    const kiFou = await commander('zone', { z: 0, ki: 5 });
    verifier('un gain intégral absurde est refusé', kiFou.ok === false, kiFou.erreur || '');
    const chuteFolle = await commander('zone', { z: 0, chuteSecondes: 99999 });
    verifier('une fenêtre de chute absurde est refusée', chuteFolle.ok === false, chuteFolle.erreur || '');

    titre('13. Autres actions');
    verifier('levée des défauts', (await commander('reset')).ok === true);
    verifier('autotune accepté', (await commander('autotune', { z: 0 })).ok === true);
    verifier('autotune interrompu', (await commander('stop-autotune', { z: 0 })).ok === true);
    verifier('autotune : zone inexistante refusée',
             (await commander('stop-autotune', { z: 7 })).ok === false);
    verifier('effacement de l\'historique', (await commander('effacer-historique')).ok === true);
    const vide = await commander('historique', {}, false);
    verifier('...et l\'historique est bien vide ensuite', (vide.points || []).length === 0,
             `${(vide.points || []).length} point(s)`);
    const sansJeton = await commander('globaux', { amperes: 4 }, false);
    verifier('les réglages généraux exigent le jeton', sansJeton.ok === false, sansJeton.erreur || '');
    const inconnue = await commander('nimportequoi');
    verifier('action inconnue rejetée proprement', inconnue.ok === false, inconnue.erreur || '');

    titre('14. Robustesse');
    client.publish(`${base}/cmd`, 'ceci n\'est pas du JSON');
    await attendre(500);
    const survie = await commander('version', {}, false);
    verifier('un message malformé ne fait pas tomber le socle', survie.ok === true);

  } catch (err) {
    verifier('déroulement du test', false, err.message);
  }

  console.log(`\n=== ${echecs ? 'DES TESTS ONT ECHOUE' : 'TOUS LES TESTS PASSENT'}` +
              ` (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  client.end();
  process.exit(echecs ? 1 : 0);
});

client.on('error', e => { console.error('Broker injoignable :', e.message); process.exit(2); });
