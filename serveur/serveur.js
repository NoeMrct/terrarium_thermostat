#!/usr/bin/env node
'use strict';
/* =============================================================================
   Serveur Terrariums — auto-hébergeable, un seul processus Node.
   -----------------------------------------------------------------------------
   Ce que l'application ne peut pas faire sans serveur, et que ce serveur fait :
     - broker MQTT (TCP et WebSocket) avec comptes et droits par socle ;
     - pont facultatif vers un broker amont (HiveMQ…) : les socles y restent,
       les applications parlent ici ;
     - historique continu des mesures, même application fermée ;
     - notifications push sur le téléphone (défaut, retour à la normale, socle
       disparu, mise à jour en échec) ;
     - rattachement d'un socle à un compte par preuve du code d'appairage ;
     - état de la flotte pour l'exploitant, rapports de diagnostic.

   Configuration par variables d'environnement (ou serveur/.env chargé ici) :
     PORT=8080                 HTTP, API et MQTT sur WebSocket (/mqtt)
     PORT_MQTT=1883            MQTT TCP pour les socles (off = désactivé)
     DONNEES=./donnees         comptes, historique, clés, rapports
     PREFIXE=terrarium         racine des sujets
     ADMIN_JETON=…             jeton d'administration (API /api/admin, utilisateur MQTT « admin »)
     AMONT_URL=mqtts://…       broker amont, avec AMONT_UTILISATEUR / AMONT_MOT_DE_PASSE
     SERVIR_APP=1              sert aussi l'application (dossier ../app)
     ORIGINES=https://…,…      origines autorisées pour l'API (défaut : toutes)
     CONTACT_VAPID=mailto:…    contact déclaré aux services de push
     RETENTION_JOURS=400       durée de conservation de l'historique

   Ligne de commande :
     node serveur.js                         démarre
     node serveur.js utilisateur ajouter <login> <mot de passe> [--admin]
     node serveur.js utilisateur mot-de-passe <login> <nouveau>
     node serveur.js appareil ajouter <terraXXXXXX> [mot de passe]
     node serveur.js appareil retirer <terraXXXXXX>
     node serveur.js attribuer <login> <terraXXXXXX>
     node serveur.js comptes                 liste
     node serveur.js cle-vapid               clé publique des notifications
   ============================================================================= */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { Comptes } = require('./lib/comptes');
const { Broker } = require('./lib/broker');
const { Historique } = require('./lib/historique');
const { Notifications } = require('./lib/notifications');
const { Api } = require('./lib/api');

const VERSION = require('./package.json').version;

function chargerEnv(dossier) {
  const f = path.join(dossier, '.env');
  if (!fs.existsSync(f)) return;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function configuration(surcharge = {}) {
  const env = process.env;
  const o = {
    port: +env.PORT || 8080,
    portMqtt: env.PORT_MQTT === 'off' ? null : (env.PORT_MQTT !== undefined ? +env.PORT_MQTT : 1883),
    donnees: path.resolve(env.DONNEES || path.join(__dirname, 'donnees')),
    prefixe: env.PREFIXE || 'terrarium',
    adminJeton: env.ADMIN_JETON || null,
    amont: env.AMONT_URL ? { url: env.AMONT_URL, utilisateur: env.AMONT_UTILISATEUR, motDePasse: env.AMONT_MOT_DE_PASSE } : null,
    app: env.SERVIR_APP === '1' ? path.resolve(__dirname, '..', 'app') : null,
    origines: env.ORIGINES ? env.ORIGINES.split(',').map(s => s.trim()).filter(Boolean) : '*',
    contactVapid: env.CONTACT_VAPID || 'mailto:admin@example.invalid',
    retentionJours: +env.RETENTION_JOURS || 400,
    pushActif: env.PUSH !== '0',
    journal: msg => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} | ${msg}`),
    version: VERSION,
    ...surcharge
  };
  return o;
}

// Texte des notifications : court, lisible sur un écran verrouillé.
function nomZone(etat, zone) { return (etat && etat.nom) || `Zone ${zone + 1}`; }

async function demarrerServeur(surcharge = {}) {
  const o = configuration(surcharge);
  fs.mkdirSync(o.donnees, { recursive: true });
  const comptes = new Comptes(o.donnees);
  const historique = new Historique(o.donnees, { retentionJours: o.retentionJours, pasMs: o.pasHistoriqueMs });
  const notifications = o.pushActif ? new Notifications(o.donnees, { contact: o.contactVapid, envoyer: o.envoyerPush, antiSpamMs: o.antiSpamMs }) : null;
  const broker = new Broker(comptes, { prefixe: o.prefixe, adminJeton: o.adminJeton, amont: o.amont, journal: o.journal });
  const api = new Api({ comptes, broker, historique, notifications, options: o });

  const serveurHttp = http.createServer((req, res) => api.traiter(req, res));
  await broker.demarrer({ portTcp: o.portMqtt, serveurHttp, cheminWs: '/mqtt' });
  await broker.annoncer({ version: o.version, push: !!notifications });
  await new Promise((res, rej) => serveurHttp.listen(o.port, err => (err ? rej(err) : res())));
  const port = serveurHttp.address().port;
  const portMqtt = broker.tcp ? broker.tcp.address().port : 0;

  // --- ce que le trafic déclenche ---------------------------------------------------
  broker.on('etat', (id, zone, etat, avant) => {
    historique.noterZone(id, zone, etat);
    if (!notifications) return;
    const defaut = x => !!x && x.defaut !== undefined && x.defaut !== '0' && x.defaut !== 0 && x.defaut !== null && x.defaut !== false;
    if (defaut(etat) && !defaut(avant)) {
      notifications.notifierProprietaires(comptes, id, { titre: `${id} — DÉFAUT`, corps: `${nomZone(etat, zone)} : ${etat.defaut_libelle || etat.defaut}. Chauffage coupé.`, socle: id, urgent: true }, `defaut:${id}:${zone}`).catch(() => {});
    } else if (!defaut(etat) && avant && defaut(avant)) {
      notifications.notifierProprietaires(comptes, id, { titre: `${id} — rétabli`, corps: `${nomZone(etat, zone)} est revenue à la normale.`, socle: id }, `retabli:${id}:${zone}`).catch(() => {});
    }
  });
  broker.on('horsLigne', id => {
    if (notifications) notifications.notifierProprietaires(comptes, id, { titre: `${id} — hors ligne`, corps: 'Le socle a quitté le broker (coupure de courant ou de réseau).', socle: id, urgent: true }, `horsligne:${id}`).catch(() => {});
  });
  broker.on('maj', (id, maj) => {
    if (!notifications || !maj) return;
    if (maj.etape === 'echec' || maj.etape === 'retour arriere') {
      notifications.notifierProprietaires(comptes, id, { titre: `${id} — mise à jour ${maj.etape}`, corps: `${maj.version || ''} : ${maj.detail || ''}`, socle: id, urgent: true }, `maj:${id}:${maj.etape}:${maj.version}`).catch(() => {});
    }
  });
  const purge = setInterval(() => { const n = historique.purger(); if (n) o.journal(`historique : ${n} fichier(s) purgé(s)`); comptes.purgerSessions(); }, 6 * 3600000);
  purge.unref();

  o.journal(`Serveur Terrariums ${VERSION} — HTTP ${port} (API /api, MQTT /mqtt)${portMqtt ? `, MQTT TCP ${portMqtt}` : ''}, données ${o.donnees}${o.amont ? `, pont vers ${o.amont.url}` : ''}${o.app ? ', application servie' : ''}`);
  if (!o.adminJeton) o.journal('ADMIN_JETON absent : administration par la ligne de commande seulement');

  return {
    port, portMqtt, comptes, broker, historique, notifications, api,
    async arreter() { clearInterval(purge); await broker.arreter(); await new Promise(r => serveurHttp.close(r)); }
  };
}

// --- ligne de commande ----------------------------------------------------------------
async function cli(args) {
  chargerEnv(__dirname);
  const o = configuration();
  const comptes = new Comptes(o.donnees);
  const [cmd, sous, a, b] = args;
  try {
    if (cmd === 'utilisateur' && sous === 'ajouter') { comptes.ajouterUtilisateur(a, b, { admin: args.includes('--admin') }); console.log(`Utilisateur ${a} créé${args.includes('--admin') ? ' (administrateur)' : ''}.`); return 0; }
    if (cmd === 'utilisateur' && sous === 'mot-de-passe') { comptes.changerMotDePasse(a, b); console.log('Mot de passe changé, sessions fermées.'); return 0; }
    if (cmd === 'appareil' && sous === 'ajouter') {
      const r = comptes.ajouterAppareil(a, b);
      console.log(`Appareil ${r.id} créé. Sur la console série du socle :\n  mqtt <hôte de ce serveur> ${o.portMqtt || 1883} ${r.id} ${r.motDePasse}\n(mot de passe : ${r.motDePasse})`);
      return 0;
    }
    if (cmd === 'appareil' && sous === 'retirer') { console.log(comptes.retirerAppareil(a) ? 'Appareil retiré.' : 'Appareil inconnu.'); return 0; }
    if (cmd === 'attribuer') { comptes.attribuerSocle(sous, a); console.log(`${a} rattaché à ${sous}.`); return 0; }
    if (cmd === 'comptes') { console.log(JSON.stringify(comptes.resume(), null, 1)); return 0; }
    if (cmd === 'cle-vapid') { console.log(new Notifications(o.donnees, { contact: o.contactVapid }).clePublique()); return 0; }
    if (cmd === 'aide' || cmd === '--help' || cmd === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('=====')[2]); return 0; }
    if (cmd) { console.error(`Commande inconnue : ${cmd} (node serveur.js aide)`); return 2; }
  } catch (e) { console.error('Erreur :', e.message); return 1; }
  const s = await demarrerServeur();
  const fin = () => s.arreter().then(() => process.exit(0));
  process.on('SIGINT', fin); process.on('SIGTERM', fin);
  return null;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(code => { if (code !== null) process.exit(code); });
}

module.exports = { demarrerServeur, configuration };
