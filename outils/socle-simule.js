#!/usr/bin/env node
/* =============================================================================
   Socle chauffant simulé.
   -----------------------------------------------------------------------------
   Se connecte à un broker MQTT et se comporte comme un vrai socle : mêmes
   sujets, mêmes messages, mêmes règles de validation, même testament. Permet de
   développer et de démontrer l'application sans matériel, et de tester le
   protocole avant de flasher quoi que ce soit.

   Ce n'est PAS le firmware : c'est une imitation de son interface réseau. Le
   comportement thermique est grossier, volontairement — le vrai banc d'essai
   du régulateur est dans sim/, et il compile le code embarqué lui-même.

     node socle-simule.js --broker mqtt://localhost:1883 --id terraTEST01
   ============================================================================= */

const mqtt = require('mqtt');

const arg = (nom, defaut) => {
  const i = process.argv.indexOf('--' + nom);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const BROKER  = arg('broker', 'mqtt://localhost:1883');
const ID      = arg('id', 'terraSIM001');
const JETON   = arg('jeton', 'SIMULATIONTESTJETON00001');
const PREFIXE = arg('prefixe', 'terrarium');
const base    = `${PREFIXE}/${ID}`;

// ----------------------------------------------------------------- l'appareil
const socle = {
  demarre: Date.now(),
  entretienFin: 0,
  globaux: {
    courantAlimA: 3, puissanceTapisW: 20, tensionV: 12,
    maintenanceMin: 10, ecranVeilleMin: 10,
    saisonActive: false, saisonDelta: 5,
    saisonDescenteJ: 21, saisonPlateauJ: 60, saisonRemonteeJ: 21, saisonDebutEpoch: 0
  },
  // Historique en anneau, comme le socle réel : un point par minute, gardé en
  // mémoire ici puisqu'il n'y a pas de flash.
  historique: [],
  zones: [
    { nom: 'Zone 1', consigneJour: 32, consigneNuit: 26, bande: 2, tempMax: 40,
      offset: 0, debutJour: 480, debutNuit: 1200, rampe: 45,
      ki: 0.0006, deriveSeuil: 3, deriveMinutes: 15,
      inefficaceMinutes: 20, inefficaceDelta: 0.3, chuteSeuil: 2, chuteSecondes: 300,
      temp: 24, defaut: null, demande: 0, chauffe: false, autotune: false },
    { nom: 'Zone 2', consigneJour: 28, consigneNuit: 24, bande: 2, tempMax: 40,
      offset: 0, debutJour: 480, debutNuit: 1200, rampe: 45,
      ki: 0.0006, deriveSeuil: 3, deriveMinutes: 15,
      inefficaceMinutes: 20, inefficaceDelta: 0.3, chuteSeuil: 2, chuteSecondes: 300,
      temp: 22, defaut: null, demande: 0, chauffe: false, autotune: false }
  ]
};

const zonesSimultanees = () => {
  const parTapis = socle.globaux.puissanceTapisW / socle.globaux.tensionV;
  return Math.max(1, Math.min(2, Math.floor((socle.globaux.courantAlimA * 0.8) / parTapis)));
};

// Mêmes bornes que globauxValides() dans stockage.cpp. Si l'un des deux change,
// le test du protocole doit le faire remarquer.
function validerGlobaux(g) {
  const e = m => { throw new Error(m); };
  if (!(g.courantAlimA >= 0.5 && g.courantAlimA <= 40))       e("Amperage de l'alimentation hors 0.5-40 A");
  if (!(g.puissanceTapisW >= 1 && g.puissanceTapisW <= 200))  e("Puissance d'un tapis hors 1-200 W");
  if (!(g.tensionV >= 3 && g.tensionV <= 60))                 e('Tension hors 3-60 V');
  if (!(g.maintenanceMin >= 1 && g.maintenanceMin <= 240))    e("Duree d'entretien hors 1-240 min");
  if (!(g.ecranVeilleMin >= 0 && g.ecranVeilleMin <= 1440))   e("Veille de l'ecran hors 0-1440 min");
  if (!(g.saisonDelta >= 0 && g.saisonDelta <= 15))           e('Abaissement saisonnier hors 0-15 C');
  if ([g.saisonDescenteJ, g.saisonPlateauJ, g.saisonRemonteeJ].some(v => v < 0 || v > 365))
    e('Duree de phase saisonniere hors 0-365 jours');
  if (g.saisonActive && g.saisonDescenteJ + g.saisonPlateauJ + g.saisonRemonteeJ === 0)
    e('Un cycle saisonnier doit durer au moins un jour');
}

// Les mêmes bornes que reglagesValides() dans le firmware. Si l'un des deux
// change, le test du protocole doit le faire remarquer.
function valider(z) {
  const e = m => { throw new Error(m); };
  if (!(z.consigneJour >= 10 && z.consigneJour <= 45)) e('Consigne de jour hors 10-45 C');
  if (!(z.ki >= 0 && z.ki <= 0.01))                    e('Gain integral hors 0-0.01');
  if (!(z.chuteSeuil >= 0.5 && z.chuteSeuil <= 20))    e('Seuil de chute hors 0.5-20 C');
  if (!(z.chuteSecondes >= 30 && z.chuteSecondes <= 3600)) e('Fenetre de chute hors 30-3600 s');
  if (!(z.deriveSeuil >= 0.5 && z.deriveSeuil <= 15))  e('Seuil de derive hors 0.5-15 C');
  if (!(z.deriveMinutes >= 5 && z.deriveMinutes <= 600)) e('Delai de derive hors 5-600 min');
  if (!(z.inefficaceMinutes >= 5 && z.inefficaceMinutes <= 240)) e("Delai d'inefficacite hors 5-240 min");
  if (!(z.inefficaceDelta >= 0.1 && z.inefficaceDelta <= 5)) e('Hausse attendue hors 0.1-5 C');
  if (!(z.rampe >= 0 && z.rampe <= 240))               e('Rampe hors 0-240 min');
  if (!(z.consigneNuit >= 10 && z.consigneNuit <= 45)) e('Consigne de nuit hors 10-45 C');
  if (!(z.bande >= 0.2 && z.bande <= 10))              e('Bande hors 0.2-10 C');
  if (!(z.tempMax >= 20 && z.tempMax <= 55))           e('Seuil max hors 20-55 C');
  if (z.tempMax <= z.consigneJour || z.tempMax <= z.consigneNuit)
    e('Le seuil max doit rester au-dessus des consignes');
  if (!(Math.abs(z.offset) <= 5))                      e('Offset de calibration hors +/-5 C');
  if (z.debutJour > 1439 || z.debutNuit > 1439)        e('Heure invalide');
  if (z.debutJour === z.debutNuit)                     e('Jour et nuit ne peuvent commencer a la meme heure');
}

function consigne(z) {
  const m = new Date().getHours() * 60 + new Date().getMinutes();
  const depuisJour = (m - z.debutJour + 1440) % 1440;
  const depuisNuit = (m - z.debutNuit + 1440) % 1440;
  const jour = depuisJour < ((z.debutNuit - z.debutJour + 1440) % 1440);
  return jour ? z.consigneJour : z.consigneNuit;
}

// Modèle thermique volontairement sommaire : il ne sert qu'à faire bouger les
// chiffres pour que l'interface ait quelque chose à afficher.
function pas(dt) {
  const entretien = socle.entretienFin > Date.now();
  const candidates = socle.zones
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => !z.defaut && !entretien && z.demande > 0.01)
    .sort((a, b) => b.z.demande - a.z.demande)
    .slice(0, zonesSimultanees());

  socle.zones.forEach(z => { z.chauffe = false; });
  candidates.forEach(({ z }) => { z.chauffe = true; });

  socle.zones.forEach(z => {
    const c = consigne(z);
    z.demande = z.defaut || entretien ? 0 : Math.max(0, Math.min(1, (c - z.temp) / z.bande));
    const apport = z.chauffe ? 0.022 : 0;
    z.temp += (apport - 0.0006 * (z.temp - 20)) * dt;
    if (z.temp >= z.tempMax) { z.defaut = 'SURCHAUFFE'; z.demande = 0; z.chauffe = false; }
  });
}

// ---------------------------------------------------------------------- MQTT
const client = mqtt.connect(BROKER, {
  clientId: ID,
  username: arg('user', undefined),
  password: arg('pass', undefined),
  will: { topic: `${base}/statut`, payload: 'hors ligne', retain: true, qos: 0 }
});

client.on('connect', () => {
  console.log(`Socle ${ID} connecté à ${BROKER}`);
  console.log(`Code d'appairage : ${JETON}`);
  client.publish(`${base}/statut`, 'en ligne', { retain: true });
  client.subscribe(`${base}/cmd`);
  socle.zones.forEach((_, i) => {
    client.subscribe(`${base}/zone${i + 1}/consigne_jour/set`);
    client.subscribe(`${base}/zone${i + 1}/consigne_nuit/set`);
  });
  publier();
});

client.on('error', e => { console.error('Erreur MQTT :', e.message); process.exit(1); });

function publier() {
  socle.zones.forEach((z, i) => {
    client.publish(`${base}/zone${i + 1}/etat`, JSON.stringify({
      temp: +z.temp.toFixed(2),
      consigne: +consigne(z).toFixed(2),
      demande: Math.round(z.demande * 100),
      charge: Math.round(z.demande * 100),
      chauffe: z.chauffe ? '1' : '0',
      defaut: z.defaut ? '1' : '0',
      defaut_libelle: z.defaut || 'OK',
      jour: z.consigneJour,
      nuit: z.consigneNuit
    }), { retain: true });
  });
}

function repondre(req, ok, corps) {
  client.publish(`${base}/reponse`, JSON.stringify({ req: req || '', ok, ...corps }));
}

client.on('message', (sujet, charge) => {
  const texte = charge.toString();

  if (sujet !== `${base}/cmd`) {                 // sujets simples Home Assistant
    const m = /zone(\d)\/consigne_(jour|nuit)\/set$/.exec(sujet);
    if (!m) return;
    const z = socle.zones[+m[1] - 1];
    const copie = { ...z };
    copie[m[2] === 'jour' ? 'consigneJour' : 'consigneNuit'] = parseFloat(texte);
    try { valider(copie); Object.assign(z, copie); publier(); }
    catch (e) { console.log('Refusé :', e.message); }
    return;
  }

  let d;
  try { d = JSON.parse(texte); }
  catch (e) { repondre('', false, { erreur: 'JSON invalide' }); return; }

  const lecture = ['etat', 'stats', 'version', 'historique'].includes(d.action);
  if (!lecture && d.jeton !== JETON) {
    repondre(d.req, false, { erreur: 'jeton invalide' });
    console.log(`Commande refusée (jeton) : ${d.action}`);
    return;
  }

  switch (d.action) {
    case 'version':
      return repondre(d.req, true, { version: '3.2.0-simule', compile: new Date().toISOString() });

    case 'etat':
      return repondre(d.req, true, {
        zones: socle.zones.map(z => ({
          nom: z.nom, temp: +z.temp.toFixed(2), consigne: +consigne(z).toFixed(2),
          demande: Math.round(z.demande * 100), charge: Math.round(z.demande * 100),
          chauffe: z.chauffe, autotune: z.autotune, derive: false, defaut: z.defaut,
          jour: z.consigneJour, nuit: z.consigneNuit, bande: z.bande, max: z.tempMax,
          offset: z.offset, rampe: z.rampe, debutJour: z.debutJour, debutNuit: z.debutNuit
        })),
        uptime: Math.floor((Date.now() - socle.demarre) / 1000),
        entretienS: Math.max(0, Math.floor((socle.entretienFin - Date.now()) / 1000)),
        heure: new Date().toISOString().slice(0, 19).replace('T', ' '),
        zonesSimultanees: zonesSimultanees(), saison: 0, alertesEnAttente: 0
      });

    case 'zone': {
      const i = d.z;
      if (!(i >= 0 && i < socle.zones.length)) return repondre(d.req, false, { erreur: 'zone invalide' });
      const copie = { ...socle.zones[i] };
      const champs = { nom: 'nom', jour: 'consigneJour', nuit: 'consigneNuit', bande: 'bande',
                       ki: 'ki', max: 'tempMax', offset: 'offset', rampe: 'rampe',
                       debutJour: 'debutJour', debutNuit: 'debutNuit',
                       deriveSeuil: 'deriveSeuil', deriveMin: 'deriveMinutes',
                       inefficaceMin: 'inefficaceMinutes', inefficaceDelta: 'inefficaceDelta',
                       chuteSeuil: 'chuteSeuil', chuteSecondes: 'chuteSecondes' };
      for (const [k, v] of Object.entries(champs)) if (d[k] !== undefined) copie[v] = d[k];
      try { valider(copie); } catch (e) { return repondre(d.req, false, { erreur: e.message }); }
      Object.assign(socle.zones[i], copie);
      publier();
      return repondre(d.req, true, {});
    }

    case 'stats': {
      const t = socle.zones.map(z => z.temp);
      return repondre(d.req, true, {
        version: '3.2.0-simule', compile: new Date().toISOString(),
        zonesSimultanees: zonesSimultanees(), saison: 0, maintenanceRestanteS: 0,
        zones: socle.zones.map((z, i) => ({
          nom: z.nom, min: +(t[i] - 0.5).toFixed(2), max: +(t[i] + 0.5).toFixed(2),
          moyenne: +t[i].toFixed(2), horsPlagePct: 3, points: socle.historique.length,
          heuresChauffe: 12.5, kWh: 0.25,
          defauts: { sonde: 0, surchauffe: z.defaut === 'SURCHAUFFE' ? 1 : 0, figee: 0 }
        }))
      });
    }

    case 'historique': {
      const heures = (d.heures >= 1 && d.heures <= 400) ? d.heures : 24;
      const maxi   = (d.max >= 1 && d.max <= 200) ? d.max : 120;
      const depuis = Math.floor(Date.now() / 1000) - heures * 3600;
      const dans   = socle.historique.filter(p => p[0] >= depuis);
      const pasEch = dans.length > maxi ? Math.ceil(dans.length / maxi) : 1;
      const points = dans.filter((_, i) => i % pasEch === 0).slice(0, maxi);
      return repondre(d.req, true, {
        format: ['epoch', 't1', 'consigne1', 't2', 'consigne2'],
        unite: 'centiemes de degre', pas: pasEch, heures, n: points.length, points
      });
    }

    case 'globaux': {
      const g = { ...socle.globaux };
      const champs = { amperes: 'courantAlimA', watts: 'puissanceTapisW', volts: 'tensionV',
                       entretienMin: 'maintenanceMin', ecranVeilleMin: 'ecranVeilleMin',
                       saisonDelta: 'saisonDelta', saisonDescenteJ: 'saisonDescenteJ',
                       saisonPlateauJ: 'saisonPlateauJ', saisonRemonteeJ: 'saisonRemonteeJ' };
      let ecriture = false;
      for (const [k, v] of Object.entries(champs))
        if (d[k] !== undefined) { g[v] = d[k]; ecriture = true; }
      if (d.saisonActive !== undefined) {
        if (d.saisonActive && !g.saisonActive) g.saisonDebutEpoch = Math.floor(Date.now() / 1000);
        g.saisonActive = !!d.saisonActive;
        ecriture = true;
      }
      if (ecriture) {
        try { validerGlobaux(g); } catch (e) { return repondre(d.req, false, { erreur: e.message }); }
        Object.assign(socle.globaux, g);
      }
      const c = socle.globaux;
      return repondre(d.req, true, {
        amperes: c.courantAlimA, watts: c.puissanceTapisW, volts: c.tensionV,
        zonesSimultanees: zonesSimultanees(), entretienMin: c.maintenanceMin,
        ecranVeilleMin: c.ecranVeilleMin, saisonActive: c.saisonActive,
        saisonDelta: c.saisonDelta, saisonDescenteJ: c.saisonDescenteJ,
        saisonPlateauJ: c.saisonPlateauJ, saisonRemonteeJ: c.saisonRemonteeJ,
        decalageActuel: c.saisonActive ? -c.saisonDelta : 0
      });
    }

    case 'stop-autotune': {
      const i = d.z;
      if (!(i >= 0 && i < socle.zones.length)) return repondre(d.req, false, { erreur: 'zone invalide' });
      socle.zones[i].autotune = false;
      return repondre(d.req, true, {});
    }

    case 'effacer-historique':
      socle.historique.length = 0;
      return repondre(d.req, true, {});

    case 'reset':
      socle.zones.forEach(z => { z.defaut = null; });
      publier();
      return repondre(d.req, true, {});

    case 'entretien': {
      const min = d.minutes === undefined ? 10 : d.minutes;
      if (min < 0 || min > 240) return repondre(d.req, false, { erreur: 'duree hors 0-240 min' });
      socle.entretienFin = min ? Date.now() + min * 60000 : 0;
      // Le firmware coupe dès la commande, sans attendre le créneau suivant :
      // le simulateur doit faire de même, sinon il masque un écart réel.
      if (socle.entretienFin) socle.zones.forEach(z => { z.chauffe = false; z.demande = 0; });
      publier();
      return repondre(d.req, true, {});
    }

    case 'autotune': {
      const i = d.z;
      if (!(i >= 0 && i < socle.zones.length)) return repondre(d.req, false, { erreur: 'zone invalide' });
      if (socle.zones[i].defaut) return repondre(d.req, false, { erreur: 'Zone en defaut' });
      socle.zones[i].autotune = true;
      setTimeout(() => { socle.zones[i].autotune = false; }, 30000);
      return repondre(d.req, true, {});
    }

    case 'alim': {
      const a = d.amperes;
      if (!(a >= 0.5 && a <= 40)) return repondre(d.req, false, { erreur: 'amperage hors 0.5-40 A' });
      socle.globaux.courantAlimA = a;
      if (d.watts !== undefined) socle.globaux.puissanceTapisW = d.watts;
      return repondre(d.req, true, { zonesSimultanees: zonesSimultanees() });
    }

    case 'redemarrer':
      repondre(d.req, true, {});
      setTimeout(() => { socle.demarre = Date.now(); console.log('Redémarrage simulé'); }, 200);
      return;

    default:
      return repondre(d.req, false, { erreur: 'action inconnue' });
  }
});

// Un point d'historique toutes les 10 s au lieu d'une minute : la démonstration
// et les tests n'attendent pas une heure pour avoir une courbe à afficher.
function enregistrerPoint() {
  socle.historique.push([
    Math.floor(Date.now() / 1000),
    ...socle.zones.flatMap(z => [Math.round(z.temp * 100), Math.round(consigne(z) * 100)])
  ]);
  if (socle.historique.length > 20160) socle.historique.shift();
}

setInterval(() => pas(2), 2000);        // évolution thermique
setInterval(publier, 5000);             // le vrai socle publie toutes les 20 s
setInterval(enregistrerPoint, 10000);
enregistrerPoint();

process.on('SIGINT', () => {
  client.publish(`${base}/statut`, 'hors ligne', { retain: true }, () => {
    client.end(); process.exit(0);
  });
});
