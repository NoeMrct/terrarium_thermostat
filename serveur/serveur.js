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
     - carnet du mois par e-mail, le 1er, pour les comptes qui le demandent ;
     - rattachement d'un socle à un compte par preuve du code d'appairage ;
     - comptes en libre-service : code par e-mail, puis clés d'accès (passkeys),
       export et effacement du compte par son titulaire ;
     - console d'administration sur /console/ : flotte, comptes, comptes
       d'appareil, rapports de diagnostic, journal d'audit chaîné (12 mois) ;
     - back-office support : demandes des clients, accès ouverts par les
       propriétaires (clé de session, le code d'appairage ne quitte pas leur
       téléphone), diagnostics à distance, frise de chaque socle.

   Configuration par variables d'environnement (ou serveur/.env chargé ici) :
     PORT=8080                 HTTP, API et MQTT sur WebSocket (/mqtt)
     PORT_MQTT=1883            MQTT TCP pour les socles (off = désactivé)
     DONNEES=./donnees         comptes, historique, clés, rapports
     PREFIXE=terrarium         racine des sujets
     ADMIN_JETON=…             jeton d'administration (console /console/, API /api/admin, utilisateur MQTT « admin »)
     AMONT_URL=mqtts://…       broker amont, avec AMONT_UTILISATEUR / AMONT_MOT_DE_PASSE
     SERVIR_APP=1              sert aussi l'application (dossier ../app)
     ORIGINES=https://…,…      origines autorisées pour l'API (défaut : toutes)
     CONTACT_VAPID=mailto:…    contact déclaré aux services de push
     RETENTION_JOURS=400       durée de conservation de l'historique
     SMTP_URL=smtps://u:m@h    envoi des codes de connexion (smtps:// 465, ou smtp:// avec STARTTLS)
     COURRIEL_DE="Terrariums <ne-pas-repondre@domaine>"   expéditeur des e-mails
     COURRIEL_JOURNAL=1        sans SMTP, écrit les e-mails dans le journal (développement)
     RP_ID=exemple.fr          domaine des clés d'accès (défaut : celui de la première origine)
     RP_NOM=Terrariums         nom montré par le téléphone à l'inscription d'une clé
     TZ=Europe/Paris           fuseau des jours et des mois (carnet mensuel par e-mail)

   Ligne de commande :
     node serveur.js                         démarre
     node serveur.js utilisateur ajouter <login> <mot de passe> [--admin]
     node serveur.js utilisateur mot-de-passe <login> <nouveau>
     node serveur.js utilisateur admin <login> oui|non     droits sur la console
     node serveur.js utilisateur support <login> oui|non   rôle support (demandes, accès ouverts)
     node serveur.js audit verifier          vérifie la chaîne du journal d'audit
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
const { Courriel } = require('./lib/courriel');
const { Audit, refCompte } = require('./lib/audit');
const { Support } = require('./lib/support');
const { Evenements } = require('./lib/evenements');
const { Carnets } = require('./lib/carnets');

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
    // Un socle qui quitte le broker n'est annoncé qu'après ce délai : un
    // redémarrage ou une box qui se reconnecte ne réveille personne (U34).
    delaiHorsLigneMin: env.DELAI_HORS_LIGNE_MIN !== undefined ? Math.max(0, +env.DELAI_HORS_LIGNE_MIN) : 5,
    // Clés d'accès : le domaine (RP ID) est celui où tourne l'application.
    rpId: env.RP_ID || (env.ORIGINES ? (() => { try { return new URL(env.ORIGINES.split(',')[0].trim()).hostname; } catch (e) { return null; } })() : null),
    rpNom: env.RP_NOM || 'Terrariums',
    courriel: env.SMTP_URL ? new Courriel(env.SMTP_URL, { de: env.COURRIEL_DE }) : (env.COURRIEL_JOURNAL === '1' ? 'journal' : null),
    journal: msg => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} | ${msg}`),
    version: VERSION,
    ...surcharge
  };
  return o;
}

// Texte des notifications : court, lisible sur un écran verrouillé.
function nomZone(etat, zone) { return (etat && etat.nom) || `Zone ${zone + 1}`; }
// Les défauts du firmware, en mots (U35) : « Zone fraîche sans mesure ».
const DEFAUTS_LISIBLES = { 'SONDE': 'sans mesure', 'SURCHAUFFE': 'au-dessus de sa coupure', 'SONDE FIGEE': 'sonde figée', 'CHAUFFE SANS EFFET': 'chauffe sans effet' };
function defautLisible(etat) {
  const d = String((etat && (etat.defaut_libelle || etat.defaut)) || '').trim();
  return DEFAUTS_LISIBLES[d.toUpperCase()] || (d && d !== '1' ? `en défaut (${d})` : 'en défaut');
}

async function demarrerServeur(surcharge = {}) {
  const o = configuration(surcharge);
  fs.mkdirSync(o.donnees, { recursive: true });
  // Développement sans SMTP : l'e-mail (et son code) va au journal du serveur.
  if (o.courriel === 'journal') o.courriel = { envoyer: async m => o.journal(`e-mail (COURRIEL_JOURNAL=1) à ${m.a} : ${m.sujet}`) };
  const comptes = new Comptes(o.donnees);
  const historique = new Historique(o.donnees, { retentionJours: o.retentionJours, pasMs: o.pasHistoriqueMs });
  const notifications = o.pushActif ? new Notifications(o.donnees, { contact: o.contactVapid, envoyer: o.envoyerPush, antiSpamMs: o.antiSpamMs }) : null;
  const broker = new Broker(comptes, { prefixe: o.prefixe, adminJeton: o.adminJeton, amont: o.amont, journal: o.journal });
  const audit = new Audit(o.donnees, { retentionMois: o.auditMois || 12 });
  const support = new Support(o.donnees);
  const evenements = new Evenements(o.donnees, { retentionJours: o.retentionJours });
  // Le carnet nomme les zones comme le socle (dernier état reçu).
  const nomZoneCarnet = (id, z) => {
    const e = ((broker.flotte[id] || {}).zones || {})[z];
    return (e && typeof e.nom === 'string' && e.nom.replace(/\p{Cc}/gu, ' ').trim().slice(0, 40)) || `Zone ${z + 1}`;
  };
  const carnets = new Carnets({ comptes, historique, evenements, courriel: o.courriel, journal: o.journal, nomZone: nomZoneCarnet });
  const api = new Api({ comptes, broker, historique, notifications, audit, support, evenements, carnets, options: o });

  const serveurHttp = http.createServer((req, res) => api.traiter(req, res));
  await broker.demarrer({ portTcp: o.portMqtt, serveurHttp, cheminWs: '/mqtt' });
  await broker.annoncer({ version: o.version, push: !!notifications });
  await new Promise((res, rej) => serveurHttp.listen(o.port, err => (err ? rej(err) : res())));
  const port = serveurHttp.address().port;
  const portMqtt = broker.tcp ? broker.tcp.address().port : 0;
  o.portMqttEcoute = broker.tcp ? portMqtt : null;       // le port réellement ouvert (0 = éphémère en test)

  // --- ce que le trafic déclenche ---------------------------------------------------
  broker.on('etat', (id, zone, etat, avant) => {
    historique.noterZone(id, zone, etat);
    if (!notifications) return;
    const defaut = x => !!x && x.defaut !== undefined && x.defaut !== '0' && x.defaut !== 0 && x.defaut !== null && x.defaut !== false;
    const drapeau = v => v === '1' || v === 1 || v === true;
    // Du plus grave au plus doux, comme dans l'application : le défaut coupe la
    // chauffe ; « trop chaud » (soleil, canicule, lampe) demande d'agir, la
    // chauffe ne refroidit pas ; la dérive prévient avant le défaut. Les deux
    // derniers drapeaux sont publiés depuis le firmware 3.5.
    const alerte = x => !x ? null : defaut(x) ? 'defaut' : drapeau(x.trop_chaud) ? 'trop_chaud' : drapeau(x.derive) ? 'derive' : null;
    const a = alerte(etat), b = alerte(avant);
    if (a === b) return;
    // Pour la frise : chaque changement vu en direct (pas l'état retenu rejoué).
    if (avant !== undefined) {
      evenements.noter(id, a || 'retabli', { zone: zone + 1, ...(a === 'defaut' ? { libelle: String(etat.defaut_libelle || etat.defaut) } : {}) });
    }
    const envoyer = (n, cle) => notifications.notifierProprietaires(comptes, id, { ...n, socle: id }, `${cle}:${id}:${zone}`).catch(() => {});
    // Le titre : le nom du socle chez chaque titulaire ; le corps : une phrase (U35).
    if (a === 'defaut') {
      envoyer({ titre: '{nom}', corps: `${nomZone(etat, zone)} ${defautLisible(etat)} : chauffe coupée par sécurité. Touche pour dépanner.`, urgent: true, genre: 'defaut' }, 'defaut');
    } else if (a && avant === undefined) {
      // Premier état vu depuis le démarrage du serveur (état retenu rejoué) :
      // une dérive en cours depuis des heures n'est pas une nouvelle.
    } else if (a === 'trop_chaud') {
      envoyer({ titre: '{nom}', corps: `${nomZone(etat, zone)} trop chaude, sans chauffer : aère ou ombre le terrarium.`, urgent: true, genre: 'trop chaud' }, 'tropchaud');
    } else if (a === 'derive') {
      envoyer({ titre: '{nom}', corps: `${nomZone(etat, zone)} s'éloigne de sa consigne.`, genre: 'dérive' }, 'derive');
    } else if (!a && avant) {
      envoyer({ titre: '{nom}', corps: `${nomZone(etat, zone)} est revenue à la normale.`, genre: 'rétabli' }, 'retabli');
    }
  });
  // Hors ligne (U34) : annoncé après un délai de grâce, puis le retour en ligne
  // aussi ; un socle revenu avant la fin du délai ne fait rien sonner.
  const absences = new Map();          // id -> { minuteur, annonce, depuis }
  const delaiHorsLigneMs = o.delaiHorsLigneMs !== undefined ? o.delaiHorsLigneMs : o.delaiHorsLigneMin * 60000;
  broker.on('enLigne', id => {
    evenements.noter(id, 'en ligne');
    const a = absences.get(id);
    if (!a) return;
    clearTimeout(a.minuteur);
    absences.delete(id);
    if (a.annonce && notifications) {
      notifications.notifierProprietaires(comptes, id, { titre: '{nom}', corps: 'De nouveau en ligne. Les valeurs sont à jour.', socle: id, genre: 'en ligne' }).catch(() => {});
    }
  });
  broker.on('redemarrage', (id, sante) => evenements.noter(id, 'redemarrage', { reset: sante.reset || null, version: sante.version || null }));
  broker.on('horsLigne', id => {
    evenements.noter(id, 'hors ligne');
    if (!notifications || absences.has(id)) return;
    const a = { annonce: false, depuis: Date.now(), minuteur: null };
    a.minuteur = setTimeout(() => {
      a.annonce = true;
      const min = Math.max(1, Math.round((Date.now() - a.depuis) / 60000));
      notifications.notifierProprietaires(comptes, id, { titre: '{nom}', corps: `Hors ligne depuis ${min} min : coupure de réseau ou de courant. Sans réseau, il continue de chauffer selon sa programmation.`, socle: id, urgent: true, genre: 'hors ligne' }, `horsligne:${id}`).catch(() => {});
    }, delaiHorsLigneMs);
    if (a.minuteur.unref) a.minuteur.unref();
    absences.set(id, a);
  });
  broker.on('maj', (id, maj) => {
    if (maj) evenements.noter(id, 'maj', { etape: maj.etape, version: maj.version || null, detail: maj.detail || null });
    if (!notifications || !maj) return;
    if (maj.etape === 'echec' || maj.etape === 'retour arriere') {
      notifications.notifierProprietaires(comptes, id, { titre: '{nom}', corps: `Mise à jour ${maj.version || ''} ${maj.etape === 'echec' ? 'en échec' : 'annulée, retour à la version d\'avant'}${maj.detail ? ` : ${maj.detail}` : ''}.`, socle: id, urgent: true, genre: `mise à jour ${maj.etape}` }, `maj:${id}:${maj.etape}:${maj.version}`).catch(() => {});
    }
  });
  // Mises à jour automatiques (F15) : le propriétaire est prévenu une fois par
  // version, avec ce qui va se passer (la nuit, ou à lancer depuis l'application).
  broker.on('majDisponible', (id, majAuto) => {
    evenements.noter(id, 'maj disponible', { version: majAuto.disponible, attente: majAuto.attente || null });
    if (!notifications) return;
    const auto = majAuto.actif && !['desactivee', 'non-signee', 'echecs', 'refusee'].includes(majAuto.attente);
    notifications.notifierProprietaires(comptes, id, {
      titre: '{nom}',
      corps: `Mise à jour ${majAuto.disponible}${majAuto.securite ? ' (sécurité)' : ''} disponible : ` + (auto ? 'le socle l\'installera seul cette nuit. Reporter ou couper depuis l\'application.'
                  : 'à installer depuis l\'application (rubrique Mises à jour).'),
      socle: id, urgent: !!majAuto.securite, genre: 'mise à jour'
    }, `majdispo:${id}:${majAuto.disponible}`).catch(() => {});
  });
  const purge = setInterval(() => {
    const n = historique.purger(); if (n) o.journal(`historique : ${n} fichier(s) purgé(s)`);
    const m = audit.purger(); if (m) o.journal(`journal d'audit : ${m} mois purgé(s)`);
    evenements.purger();
    comptes.purgerSessions();
    comptes.purgerInvitations();
    const r = api.purgerRapports(); if (r) o.journal(`rapports de diagnostic : ${r} de plus d'un an effacé(s)`);
  }, 6 * 3600000);
  purge.unref();
  // Accès support échus : la clé quitte le disque (le socle, lui, la refuse déjà).
  const echeances = setInterval(() => {
    for (const id of support.purgerAcces()) audit.noter({ qui: 'serveur', action: 'support.acces.echu', cible: id });
    api.routesSupport.traiterRelances();
  }, o.echeancesMs || 60000);
  echeances.unref();
  // Carnet du mois : vérifié toutes les heures, envoyé le 1er à partir de 8 h.
  const tourCarnets = setInterval(() => { carnets.tourner().catch(e => o.journal(`carnets : ${e.message}`)); }, o.carnetsMs || 3600000);
  tourCarnets.unref();

  o.journal(`Serveur Terrariums ${VERSION} — HTTP ${port} (API /api, console /console/, MQTT /mqtt)${portMqtt ? `, MQTT TCP ${portMqtt}` : ''}, données ${o.donnees}${o.amont ? `, pont vers ${o.amont.url}` : ''}${o.app ? ', application servie' : ''}`);
  if (!o.adminJeton) o.journal('ADMIN_JETON absent : console ouverte aux seuls comptes administrateurs (node serveur.js utilisateur admin <login> oui)');
  if (!o.courriel) o.journal('SMTP_URL absent : pas de comptes en libre-service par e-mail (identifiant et mot de passe seulement)');
  if (!o.rpId) o.journal('RP_ID et ORIGINES absents : chaque clé d\'accès se lie au domaine de la page qui la crée');

  return {
    port, portMqtt, comptes, broker, historique, notifications, api, audit, support, evenements, carnets,
    async arreter() {
      clearInterval(purge); clearInterval(echeances); clearInterval(tourCarnets);
      for (const a of absences.values()) clearTimeout(a.minuteur);
      await broker.arreter(); await new Promise(r => serveurHttp.close(r));
    }
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
    if (cmd === 'utilisateur' && sous === 'admin') {
      if (!['oui', 'non'].includes(b)) { console.error('utilisateur admin <login> oui|non'); return 2; }
      comptes.definirAdmin(a, b === 'oui');
      new Audit(o.donnees).noter({ qui: 'ligne de commande', action: 'compte.admin', cible: refCompte(a), details: { admin: b === 'oui' } });
      console.log(`${a} : ${b === 'oui' ? 'administrateur' : 'plus administrateur'}.`);
      return 0;
    }
    if (cmd === 'utilisateur' && sous === 'support') {
      if (!['oui', 'non'].includes(b)) { console.error('utilisateur support <login> oui|non'); return 2; }
      comptes.definirSupport(a, b === 'oui');
      new Audit(o.donnees).noter({ qui: 'ligne de commande', action: 'compte.support', cible: refCompte(a), details: { support: b === 'oui' } });
      console.log(`${a} : ${b === 'oui' ? 'rôle support' : 'plus de rôle support'}.`);
      return 0;
    }
    if (cmd === 'audit' && sous === 'verifier') {
      const v = new Audit(o.donnees).verifier();
      console.log(v.ok ? `Journal d'audit intègre : ${v.n} ligne(s)${v.premier ? `, du ${v.premier} au ${v.dernier}` : ''}. Tête : ${v.tete}`
        : `RUPTURE : ${v.rupture.raison}${v.rupture.fichier ? ` (${v.rupture.fichier}, ligne ${v.rupture.ligne})` : ''}`);
      return v.ok ? 0 : 1;
    }
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
