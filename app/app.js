/* =============================================================================
   Application de pilotage des socles chauffants.
   -----------------------------------------------------------------------------
   Elle parle directement au broker MQTT en WebSocket : pas de serveur
   intermédiaire, donc rien à héberger ni à payer au démarrage.

   Trois principes structurent le fichier :

   1. Le socle est la source de vérité. L'application n'affiche que ce qu'il
      publie, et ne suppose jamais qu'une commande a abouti tant que la réponse
      n'est pas arrivée.
   2. Un socle hors ligne doit être visible comme tel, immédiatement. Le sujet
      « statut » est persistant et pourvu d'un testament : le broker publie
      lui-même « hors ligne » si le socle disparaît. Un socle en ligne mais
      muet depuis trop longtemps est signalé « silencieux ».
   3. Le rendu ne touche au DOM que ce qui a changé. Chaque région de l'écran
      est repeinte seulement si son contenu diffère du précédent, les
      formulaires ne sont construits qu'à l'ouverture d'un panneau, et les
      messages du socle ne déclenchent qu'une mise à jour par image. Un champ
      en cours de saisie n'est donc jamais effacé.

   Aucun gestionnaire d'événement n'est écrit dans le HTML : un seul écouteur
   par type d'événement, sur le document, aiguille d'après les attributs
   data-action et data-form. Tous les textes passent par t() : le français est
   la langue de référence, l'anglais vient du même dictionnaire.
   ============================================================================= */

// @ts-check

const App = (() => {
  'use strict';

  const CLE_CONFIG = 'terrarium.config.v1';
  const CLE_LANGUE = 'terrarium.langue';
  const PROTO_APP = 3;              // version du protocole que cette application comprend
  const CLE_VERROU_MIN = 'terrarium.verrou.min';   // minutes d'inactivité avant verrouillage (0 = au lancement seulement)
  const PBKDF2_ITERATIONS = 300000; // dérivation du code de verrouillage (≈ 0,3 s sur un téléphone)
  const DELAI_COMMANDE = 8000;      // au-delà, on considère le socle injoignable
  const SILENCE_MS = 150000;        // en ligne mais muet depuis plus longtemps : « silencieux »
  const DUREES = [6, 24, 168, 720]; // heures proposées pour les courbes
  const ONGLETS = [
    ['etat', 'ongletEtat', 'i-etat'], ['reglages', 'ongletReglages', 'i-reglages'],
    ['courbes', 'ongletCourbes', 'i-courbes'], ['general', 'ongletAppareil', 'i-appareil']
  ];

  // ------------------------------------------------------------------ textes
  // Le français est la référence : les tests lisent ces chaînes exactes. L'anglais
  // est servi quand le navigateur le demande, ou sur choix explicite.
  const TEXTES = {
    fr: {
      connexion: 'connexion…', connecte: 'connecté', reconnexion: 'reconnexion…', horsLigne: 'hors ligne',
      nonConnecte: 'non connecté', erreurLien: 'erreur : {m}', enLigne: 'en ligne', silencieux: 'silencieux depuis {m} min',
      brokerAffiche: 'Broker : {h}', sauverImpossible: 'Impossible d\'enregistrer la configuration sur cet appareil.',
      pasDeConnexion: 'pas de connexion au broker', socleInconnu: 'socle inconnu', pasDeReponse: 'le socle n\'a pas répondu',
      refuse: 'refusé par le socle',
      notifDerive: '{nom} — dérive', notifDeriveCorps: '{zone} s\'éloigne de sa consigne.',
      notifDefaut: '{nom} — DÉFAUT', notifDefautCorps: '{zone} : {d}. Chauffage coupé.',
      notifRetabli: '{nom} — rétabli', notifRetabliCorps: '{zone} est revenue à la normale.',
      attenteDonnees: 'en attente de données…', zoneN: 'Zone {n}', defautLib: 'DÉFAUT : {d}', cible: 'cible {v} °C',
      demande: 'demande {v} %', chauffe: 'chauffe', derive: 'dérive', autotune: 'autotune',
      aucunSocle: 'Aucun socle pour l\'instant', aucunSocleAide: 'Ajoute ton premier socle ci-dessous, ou scanne le QR code collé dessous.',
      heuresService: '{h} h de service', horlogeSocle: 'horloge du socle {h}', entretienMin: 'entretien : {m} min',
      alertesAttente: '{n} alerte(s) en attente', majAppli: 'mets à jour l\'application', majSocle: 'firmware à mettre à jour',
      socleNeRepondPas: 'Ce socle ne répond pas. Il continue de réguler tout seul : seule la commande à distance est indisponible.',
      socleSilencieux: 'Ce socle est annoncé en ligne mais n\'a rien publié depuis {m} min. Vérifie son réseau.',
      ongletEtat: 'État', ongletReglages: 'Réglages', ongletCourbes: 'Courbes', ongletAppareil: 'Appareil', sectionsSocle: 'Sections du socle',
      consigneJour: 'Consigne jour (°C)', consigneNuit: 'Consigne nuit (°C)', inchange: 'inchangé', enregistrer: 'Enregistrer',
      attentePremieresMesures: 'En attente des premières mesures du socle…', arreterAutotune: 'Arrêter l\'autotune', autotuneBtn: 'Autotune',
      actions: 'Actions', entretienEnCours: 'Entretien en cours : chauffage coupé, reprise automatique dans {m} min.',
      entretienAide: 'L\'entretien coupe le chauffage le temps de nettoyer, puis la régulation reprend toute seule.',
      reprendre: 'Reprendre maintenant', entretien10: 'Entretien 10 min', leverDefauts: 'Lever les défauts',
      nomZone: 'Nom de la zone', debutJour: 'Début du jour', debutNuit: 'Début de la nuit', rampe: 'Rampe (min)', bande: 'Bande (°C)',
      coupureMax: 'Coupure max (°C)', calibration: 'Calibration (°C)',
      aideCoupure: 'La coupure max est une sécurité absolue : au-dessus, la zone se verrouille en défaut. Elle doit rester au-dessus des deux consignes. Un champ vide reste inchangé.',
      attenteReglages: 'En attente des réglages du socle…', etatZoneCourt: '{t} °C · cible {c} °C',
      dureeH: '{h} h', dureeJ: '{j} j', ariaCourbes: 'Courbes de température des deux zones', chargement: 'Chargement…',
      nbPoints: '{n} point(s) · trait plein : température, pointillés : consigne', aucunPoint: 'Aucun point sur cette période.',
      aideHistorique: 'L\'historique reste sur le socle : il n\'est jamais recopié sur le broker. Au-delà de 24 h, les points que cette application a enregistrés en passant complètent les siens.',
      aideHistoriqueCourt: 'L\'historique reste sur le socle : il n\'est jamais recopié sur le broker.',
      exporterCsv: 'Exporter en CSV', vueEntiere: 'Vue entière', zoomAide: 'Molette ou pincement pour zoomer, glisser pour déplacer, double-clic pour revenir.',
      minMaxJour: 'Min / max par jour', date: 'Date',
      chargementReglages: 'Chargement des réglages de l\'appareil…', alimentation: 'Alimentation',
      aideAlim: 'Ce que le socle a le droit de tirer : il n\'allume jamais plus de tapis que l\'alimentation n\'en supporte.',
      courantDispo: 'Courant disponible (A)', puissanceTapis: 'Puissance d\'un tapis (W)', tension: 'Tension (V)',
      zonesSimultanees: '{n} zone(s) peuvent chauffer en même temps.', cyclage: 'Cyclage saisonnier',
      aideCyclage: 'Abaisse progressivement les consignes puis les remonte, pour simuler une saison fraîche.',
      cycleActif: 'Cycle saisonnier actif', abaissement: 'Abaissement (°C)', descente: 'Descente (jours)', plateau: 'Plateau (jours)', remontee: 'Remontée (jours)',
      decalageApplique: 'Décalage appliqué en ce moment : {v} °C.', aucunDecalage: 'Aucun décalage appliqué.',
      entretienAppareil: 'Entretien de l\'appareil',
      aideEntretienAppareil: 'Les réglages réseau, le journal et la mise à jour du firmware restent sur l\'interface locale du socle, sur ton réseau domestique.',
      redemarrerSocle: 'Redémarrer le socle', effacerHistorique: 'Effacer l\'historique', retirerSocle: 'Retirer ce socle de l\'application',
      sauvegarde: 'Sauvegarde des réglages', aideSauvegarde: 'Un fichier avec les consignes, horaires et réglages de l\'appareil : pour un socle de rechange, ou avant une expérimentation.',
      exporterReglages: 'Exporter les réglages', importerReglages: 'Importer des réglages',
      sur24h: 'Sur 24 heures', chargementStats: 'Chargement des statistiques…', minC: 'min °C', maxC: 'max °C', moyenneC: 'moyenne °C',
      horsPlage: 'du temps hors plage', deChauffe: 'de chauffe', consommes: 'consommés',
      pasAssezHist: 'Pas encore assez d\'historique. Chauffe cumulée {h} h · {k} kWh.',
      defautsCompte: 'Défauts : sonde {s} · surchauffe {c} · sonde figée {f}', firmware: 'Firmware {v}',
      sante: 'Santé du socle', signalWifi: 'Signal Wi-Fi', memoireLibre: 'Mémoire libre', plusGrandBloc: 'plus grand bloc {b} Ko',
      dernierRedemarrage: 'Dernier redémarrage', enService: 'En service depuis', majValidation: 'Mise à jour en cours de validation',
      protocole: 'Protocole', sigExcellent: 'excellent', sigBon: 'bon', sigFaible: 'faible', sigTresFaible: 'très faible', inconnu: 'inconnu',
      santeInconnue: 'Ce socle ne publie pas encore son état de santé : mets son firmware à jour pour voir le signal Wi-Fi, la mémoire et les redémarrages.',
      notifications: 'Notifications',
      notifGranted: 'Activées : un défaut ou une dérive fait apparaître une notification, même onglet en arrière-plan. Elles ne partent que pendant que l\'application est ouverte — pour être prévenu appareil éteint, configure l\'URL d\'alerte du socle.',
      notifDenied: 'Refusées pour ce site. C\'est un réglage du navigateur, à rouvrir depuis lui.',
      notifIndispo: 'Indisponibles ici : le navigateur ne les propose qu\'en HTTPS.',
      notifDefault: 'Un défaut ou une dérive peut faire apparaître une notification pendant que l\'application est ouverte.',
      activerNotifs: 'Activer les notifications', notifsIndispoPage: 'Notifications indisponibles sur cette page.',
      notifsActivees: 'Notifications activées.', notifsRefusees: 'Notifications refusées.', notifsIndispo2: 'Notifications indisponibles : {m}',
      wssRequis: 'L\'adresse doit commencer par wss:// — sans chiffrement, tes codes d\'appairage circuleraient en clair.',
      testEnCours: 'Test de connexion…', testOk: 'Connexion réussie en {ms} ms.', testKo: 'Connexion impossible : {m}',
      oublierBrokerQ: 'Oublier ce broker ?', oublierBrokerTexte: 'Les socles enregistrés seront conservés.', oublier: 'Oublier',
      idManquant: 'Identifiant manquant.', jeton24: 'Le code d\'appairage fait 24 caractères.', dejaEnregistre: 'Ce socle est déjà enregistré.',
      socleAjoute: 'Socle ajouté.', socleRetire: 'Socle retiré.', annuler: 'Annuler', cancel: 'Annuler', confirmer: 'Confirmer',
      redemarrerQ: 'Redémarrer le socle ?', redemarrerTexte: 'La régulation reprend toute seule au démarrage.', redemarrer: 'Redémarrer',
      effacerHistQ: 'Effacer l\'historique de ce socle ?', effacerHistTexte: 'Les courbes repartent de zéro, y compris les points enregistrés par cette application.',
      effacer: 'Effacer', histEfface: 'Historique effacé.', reglagesEnregistres: 'Réglages enregistrés.',
      horaireInvalide: 'Horaire invalide : « {v} », attendu HH:MM.', enregistreZones: 'Enregistré : {n} zone(s) simultanée(s).',
      commandeAcceptee: 'Commande acceptée.',
      qrIndispo: 'Lecture de QR indisponible sur ce navigateur.', viserQr: 'Vise le QR code collé sous le socle, ou celui affiché sur son écran.',
      aucunQr: 'Aucun QR détecté.', qrNonReconnu: 'QR non reconnu.', codeLu: 'Code lu, complète le nom puis valide.', cameraIndispo: 'Caméra indisponible : {m}',
      nouvelleVersion: 'Nouvelle version de l\'application disponible.', recharger: 'Recharger',
      installer: 'Installer l\'application', installIos: 'Sur iPhone et iPad : bouton Partager, puis « Sur l\'écran d\'accueil ».', installee: 'Application installée.',
      exportConfigQ: 'Exporter la configuration ?', exportConfigTexte: 'Le fichier contient les codes d\'appairage de tes socles : garde-le pour toi.',
      exporter: 'Exporter', importOk: '{n} socle(s) importé(s).', importRien: 'Rien de nouveau dans ce fichier.', importInvalide: 'Fichier non reconnu.',
      telechargementIndispo: 'Téléchargement indisponible ici.', importReglagesOk: 'Réglages envoyés au socle.', importReglagesKo: 'Import interrompu : {m}',
      diagnostic: 'Diagnostic', copierRapport: 'Copier le rapport', rapportCopie: 'Rapport copié.', copieImpossible: 'Copie impossible — sélectionne le texte.',
      fermer: 'Fermer', application: 'Application', navigateur: 'Navigateur', aucuneErreur: 'Aucune erreur enregistrée.', erreursRecentes: 'Erreurs récentes',
      versionDev: 'version de développement', socles: 'Socles', aucun: 'aucun', installeeOui: 'installée', installeeNon: 'dans le navigateur',
      cacheSw: 'cache hors ligne', derniereMesure: 'dernière mesure il y a {s} s', jamais: 'jamais',
      aideDiag: 'Ce rapport ne contient ni mot de passe ni code d\'appairage. Joins-le à une demande d\'aide.',
      // verrouillage
      verrouillee: 'verrouillée', cryptoIndispo: 'Chiffrement indisponible dans ce navigateur (il faut HTTPS).',
      codeFaux: 'Code incorrect.', codeFauxAttente: 'Code incorrect — nouvel essai dans {s} s.',
      definirCode: 'Code de verrouillage', aideCode: 'Au moins 4 caractères. Il chiffre le mot de passe du broker et les codes d\'appairage sur cet appareil ; il ne peut pas être retrouvé.',
      nouveauCode: 'Nouveau code', confirmerCode: 'Confirme le code', codeTropCourt: '4 caractères au minimum.', codesDifferents: 'Les deux codes ne sont pas identiques.',
      codeDefini: 'Code défini : la configuration est chiffrée.', codeImpossible: 'Impossible de chiffrer : {m}', codeRetire: 'Code retiré : la configuration est de nouveau en clair.',
      retirerCodeQ: 'Retirer le code de verrouillage ?', retirerCodeTexte: 'Les codes d\'appairage et le mot de passe du broker seront stockés en clair sur cet appareil.', retirer: 'Retirer',
      effacerToutQ: 'Tout effacer ?', effacerToutTexte: 'Broker, socles et historique local disparaissent de cet appareil. Les socles continuent de chauffer ; leurs codes d\'appairage sont sur leur écran (commande jeton).', effacerTout: 'Tout effacer',
      // mise à jour du firmware
      majTitre: 'Mise à jour du firmware', majInconnue: 'Firmware {v}. La version publiée n\'est pas connue ici (application hors ligne ou de développement).',
      majAJour: 'Firmware {v} : à jour.', majDisponible: 'Version {v} disponible (installée : {a}). Le socle la télécharge lui-même, signature vérifiée, et revient en arrière seul si elle plante avant validation.',
      majInstaller: 'Mettre à jour vers {v}', majQ: 'Mettre à jour vers {v} ?', majTexte: 'Le chauffage est coupé le temps de l\'écriture (moins d\'une minute), puis le socle redémarre. Ne coupe pas son alimentation.', majOk: 'Mettre à jour',
      majLancee: 'Téléchargement lancé sur le socle.', majRefusee: 'Mise à jour refusée : {m}', majTelechargement: 'Téléchargement en cours : {p} %', majRedemarre: 'Image écrite, le socle redémarre.',
      majErreur: 'Mise à jour en échec : {m}', interfaceLocale: 'interface locale (sur le même réseau)',
      majEtape_en_validation: 'en validation', majEtape_validee: 'validée', majEtape_retour_arriere: 'retour arrière', majEtape_echec: 'échec',
      // serveur
      serveur: 'Serveur', serveurAbsent: 'aucun serveur Terrariums derrière ce broker', socleRattache: 'Socle rattaché à ton compte sur le serveur.',
      rattachementRefuse: 'Rattachement refusé par le serveur : {m}', reessayer: 'Réessayer',
      pushTexte: 'Le serveur peut prévenir ce téléphone même application fermée : défaut, retour à la normale, socle disparu, mise à jour en échec.',
      activerPush: 'Activer les notifications du serveur', pushActif: 'notifications du serveur actives', pushActifTexte: 'Ce téléphone est prévenu même application fermée.',
      pushActive: 'Notifications du serveur activées sur cet appareil.', pushRefuse: 'Impossible d\'activer : {m}', pushIndispo: 'notifications push indisponibles ici',
      envoyerRapport: 'Envoyer au serveur', rapportEnvoye: 'Rapport envoyé au serveur ({f}).', rapportNonEnvoye: 'Rapport non envoyé : {m}'
    },
    en: {
      connexion: 'connecting…', connecte: 'connected', reconnexion: 'reconnecting…', horsLigne: 'offline',
      nonConnecte: 'not connected', erreurLien: 'error: {m}', enLigne: 'online', silencieux: 'silent for {m} min',
      brokerAffiche: 'Broker: {h}', sauverImpossible: 'Unable to save the configuration on this device.',
      pasDeConnexion: 'no connection to the broker', socleInconnu: 'unknown base', pasDeReponse: 'the base did not answer',
      refuse: 'refused by the base',
      notifDerive: '{nom} — drift', notifDeriveCorps: '{zone} is drifting away from its setpoint.',
      notifDefaut: '{nom} — FAULT', notifDefautCorps: '{zone}: {d}. Heating cut off.',
      notifRetabli: '{nom} — recovered', notifRetabliCorps: '{zone} is back to normal.',
      attenteDonnees: 'waiting for data…', zoneN: 'Zone {n}', defautLib: 'FAULT: {d}', cible: 'target {v} °C',
      demande: 'demand {v} %', chauffe: 'heating', derive: 'drift', autotune: 'autotune',
      aucunSocle: 'No base yet', aucunSocleAide: 'Add your first base below, or scan the QR code stuck underneath it.',
      heuresService: '{h} h uptime', horlogeSocle: 'base clock {h}', entretienMin: 'maintenance: {m} min',
      alertesAttente: '{n} pending alert(s)', majAppli: 'update the app', majSocle: 'firmware update advised',
      socleNeRepondPas: 'This base is not answering. It keeps regulating on its own: only remote control is unavailable.',
      socleSilencieux: 'This base is announced online but has published nothing for {m} min. Check its network.',
      ongletEtat: 'Status', ongletReglages: 'Settings', ongletCourbes: 'Charts', ongletAppareil: 'Device', sectionsSocle: 'Base sections',
      consigneJour: 'Day setpoint (°C)', consigneNuit: 'Night setpoint (°C)', inchange: 'unchanged', enregistrer: 'Save',
      attentePremieresMesures: 'Waiting for the first readings from the base…', arreterAutotune: 'Stop autotune', autotuneBtn: 'Autotune',
      actions: 'Actions', entretienEnCours: 'Maintenance in progress: heating off, resumes automatically in {m} min.',
      entretienAide: 'Maintenance cuts the heating while you clean, then regulation resumes by itself.',
      reprendre: 'Resume now', entretien10: 'Maintenance 10 min', leverDefauts: 'Clear faults',
      nomZone: 'Zone name', debutJour: 'Day starts at', debutNuit: 'Night starts at', rampe: 'Ramp (min)', bande: 'Band (°C)',
      coupureMax: 'Max cut-off (°C)', calibration: 'Calibration (°C)',
      aideCoupure: 'The max cut-off is an absolute safety: above it, the zone locks into a fault. It must stay above both setpoints. An empty field stays unchanged.',
      attenteReglages: 'Waiting for the base settings…', etatZoneCourt: '{t} °C · target {c} °C',
      dureeH: '{h} h', dureeJ: '{j} d', ariaCourbes: 'Temperature charts of both zones', chargement: 'Loading…',
      nbPoints: '{n} point(s) · solid line: temperature, dashed: setpoint', aucunPoint: 'No point over this period.',
      aideHistorique: 'History stays on the base: it is never copied to the broker. Beyond 24 h, the points this app recorded in passing complete its own.',
      aideHistoriqueCourt: 'History stays on the base: it is never copied to the broker.',
      exporterCsv: 'Export as CSV', vueEntiere: 'Full view', zoomAide: 'Wheel or pinch to zoom, drag to pan, double-click to reset.',
      minMaxJour: 'Daily min / max', date: 'Date',
      chargementReglages: 'Loading device settings…', alimentation: 'Power supply',
      aideAlim: 'What the base may draw: it never switches on more mats than the supply can feed.',
      courantDispo: 'Available current (A)', puissanceTapis: 'Mat power (W)', tension: 'Voltage (V)',
      zonesSimultanees: '{n} zone(s) can heat at the same time.', cyclage: 'Seasonal cycling',
      aideCyclage: 'Gradually lowers the setpoints then raises them back, to simulate a cool season.',
      cycleActif: 'Seasonal cycle active', abaissement: 'Drop (°C)', descente: 'Descent (days)', plateau: 'Plateau (days)', remontee: 'Rise (days)',
      decalageApplique: 'Offset applied right now: {v} °C.', aucunDecalage: 'No offset applied.',
      entretienAppareil: 'Device maintenance',
      aideEntretienAppareil: 'Network settings, the log and firmware updates stay on the base\'s local interface, on your home network.',
      redemarrerSocle: 'Restart the base', effacerHistorique: 'Clear history', retirerSocle: 'Remove this base from the app',
      sauvegarde: 'Settings backup', aideSauvegarde: 'A file with the setpoints, schedules and device settings: for a spare base, or before an experiment.',
      exporterReglages: 'Export settings', importerReglages: 'Import settings',
      sur24h: 'Over 24 hours', chargementStats: 'Loading statistics…', minC: 'min °C', maxC: 'max °C', moyenneC: 'average °C',
      horsPlage: 'of the time out of range', deChauffe: 'of heating', consommes: 'used',
      pasAssezHist: 'Not enough history yet. Total heating {h} h · {k} kWh.',
      defautsCompte: 'Faults: probe {s} · overheat {c} · frozen probe {f}', firmware: 'Firmware {v}',
      sante: 'Base health', signalWifi: 'Wi-Fi signal', memoireLibre: 'Free memory', plusGrandBloc: 'largest block {b} KB',
      dernierRedemarrage: 'Last restart', enService: 'Up for', majValidation: 'Update being validated',
      protocole: 'Protocol', sigExcellent: 'excellent', sigBon: 'good', sigFaible: 'weak', sigTresFaible: 'very weak', inconnu: 'unknown',
      santeInconnue: 'This base does not publish its health yet: update its firmware to see Wi-Fi signal, memory and restarts.',
      notifications: 'Notifications',
      notifGranted: 'Enabled: a fault or a drift shows a notification, even with the tab in the background. They only go out while the app is open — to be warned with the device off, configure the base\'s alert URL.',
      notifDenied: 'Refused for this site. That is a browser setting, to reopen from the browser.',
      notifIndispo: 'Unavailable here: the browser only offers them over HTTPS.',
      notifDefault: 'A fault or a drift can show a notification while the app is open.',
      activerNotifs: 'Enable notifications', notifsIndispoPage: 'Notifications unavailable on this page.',
      notifsActivees: 'Notifications enabled.', notifsRefusees: 'Notifications refused.', notifsIndispo2: 'Notifications unavailable: {m}',
      wssRequis: 'The address must start with wss:// — without encryption, your pairing codes would travel in clear text.',
      testEnCours: 'Testing the connection…', testOk: 'Connected in {ms} ms.', testKo: 'Connection failed: {m}',
      oublierBrokerQ: 'Forget this broker?', oublierBrokerTexte: 'The registered bases will be kept.', oublier: 'Forget',
      idManquant: 'Identifier missing.', jeton24: 'The pairing code is 24 characters long.', dejaEnregistre: 'This base is already registered.',
      socleAjoute: 'Base added.', socleRetire: 'Base removed.', annuler: 'Undo', cancel: 'Cancel', confirmer: 'Confirm',
      redemarrerQ: 'Restart the base?', redemarrerTexte: 'Regulation resumes by itself at boot.', redemarrer: 'Restart',
      effacerHistQ: 'Clear this base\'s history?', effacerHistTexte: 'The charts start again from zero, including the points recorded by this app.',
      effacer: 'Clear', histEfface: 'History cleared.', reglagesEnregistres: 'Settings saved.',
      horaireInvalide: 'Invalid time: “{v}”, expected HH:MM.', enregistreZones: 'Saved: {n} simultaneous zone(s).',
      commandeAcceptee: 'Command accepted.',
      qrIndispo: 'QR reading is unavailable in this browser.', viserQr: 'Aim at the QR code under the base, or the one on its screen.',
      aucunQr: 'No QR detected.', qrNonReconnu: 'QR not recognised.', codeLu: 'Code read, fill in the name then confirm.', cameraIndispo: 'Camera unavailable: {m}',
      nouvelleVersion: 'A new version of the app is available.', recharger: 'Reload',
      installer: 'Install the app', installIos: 'On iPhone and iPad: Share button, then “Add to Home Screen”.', installee: 'App installed.',
      exportConfigQ: 'Export the configuration?', exportConfigTexte: 'The file contains the pairing codes of your bases: keep it to yourself.',
      exporter: 'Export', importOk: '{n} base(s) imported.', importRien: 'Nothing new in this file.', importInvalide: 'File not recognised.',
      telechargementIndispo: 'Download unavailable here.', importReglagesOk: 'Settings sent to the base.', importReglagesKo: 'Import interrupted: {m}',
      diagnostic: 'Diagnostics', copierRapport: 'Copy report', rapportCopie: 'Report copied.', copieImpossible: 'Copy failed — select the text.',
      fermer: 'Close', application: 'Application', navigateur: 'Browser', aucuneErreur: 'No error recorded.', erreursRecentes: 'Recent errors',
      versionDev: 'development version', socles: 'Bases', aucun: 'none', installeeOui: 'installed', installeeNon: 'in the browser',
      cacheSw: 'offline cache', derniereMesure: 'last reading {s} s ago', jamais: 'never',
      aideDiag: 'This report contains no password and no pairing code. Attach it to a support request.',
      verrouillee: 'locked', cryptoIndispo: 'Encryption unavailable in this browser (HTTPS required).',
      codeFaux: 'Wrong code.', codeFauxAttente: 'Wrong code — try again in {s} s.',
      definirCode: 'Lock code', aideCode: 'At least 4 characters. It encrypts the broker password and the pairing codes on this device; it cannot be recovered.',
      nouveauCode: 'New code', confirmerCode: 'Confirm the code', codeTropCourt: '4 characters minimum.', codesDifferents: 'The two codes differ.',
      codeDefini: 'Code set: the configuration is encrypted.', codeImpossible: 'Cannot encrypt: {m}', codeRetire: 'Code removed: the configuration is stored in clear again.',
      retirerCodeQ: 'Remove the lock code?', retirerCodeTexte: 'Pairing codes and the broker password will be stored in clear on this device.', retirer: 'Remove',
      effacerToutQ: 'Erase everything?', effacerToutTexte: 'Broker, bases and local history disappear from this device. The bases keep heating; their pairing codes are on their screen (jeton command).', effacerTout: 'Erase everything',
      majTitre: 'Firmware update', majInconnue: 'Firmware {v}. The published version is not known here (offline or development build).',
      majAJour: 'Firmware {v}: up to date.', majDisponible: 'Version {v} available (installed: {a}). The base downloads it itself, verifies the signature, and rolls back on its own if it crashes before validation.',
      majInstaller: 'Update to {v}', majQ: 'Update to {v}?', majTexte: 'Heating is off while the image is written (under a minute), then the base restarts. Do not cut its power.', majOk: 'Update',
      majLancee: 'Download started on the base.', majRefusee: 'Update refused: {m}', majTelechargement: 'Downloading: {p} %', majRedemarre: 'Image written, the base is restarting.',
      majErreur: 'Update failed: {m}', interfaceLocale: 'local interface (same network)',
      majEtape_en_validation: 'being validated', majEtape_validee: 'validated', majEtape_retour_arriere: 'rolled back', majEtape_echec: 'failed',
      serveur: 'Server', serveurAbsent: 'no Terrariums server behind this broker', socleRattache: 'Base attached to your account on the server.',
      rattachementRefuse: 'Attachment refused by the server: {m}', reessayer: 'Retry',
      pushTexte: 'The server can alert this phone even with the app closed: fault, back to normal, base gone, failed update.',
      activerPush: 'Enable server notifications', pushActif: 'server notifications on', pushActifTexte: 'This phone is alerted even with the app closed.',
      pushActive: 'Server notifications enabled on this device.', pushRefuse: 'Cannot enable: {m}', pushIndispo: 'push notifications unavailable here',
      envoyerRapport: 'Send to the server', rapportEnvoye: 'Report sent to the server ({f}).', rapportNonEnvoye: 'Report not sent: {m}'
    }
  };

  let langue = 'fr';
  function choisirLangue() {
    let choix = null;
    try { choix = localStorage.getItem(CLE_LANGUE); } catch (e) { /* stockage indisponible */ }
    if (choix !== 'fr' && choix !== 'en') {
      const nav = (typeof navigator !== 'undefined' && (navigator.language || '')) || 'fr';
      choix = /^en\b/i.test(nav) ? 'en' : 'fr';
    }
    langue = choix;
    document.documentElement.lang = langue;
  }
  /** @param {string} cle @param {Record<string, string|number>=} p */
  function t(cle, p) {
    const d = TEXTES[langue] || TEXTES.fr;
    let s = d[cle] !== undefined ? d[cle] : (TEXTES.fr[cle] !== undefined ? TEXTES.fr[cle] : cle);
    if (p) Object.keys(p).forEach(k => { s = s.split('{' + k + '}').join(String(p[k])); });
    return s;
  }
  // Les textes statiques de la page portent data-i18n : on les traduit une fois.
  function traduirePage() {
    if (langue === 'fr') return;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const cle = el.getAttribute('data-i18n') || '';
      const v = (TEXTES.en.page || {})[cle];
      if (v !== undefined) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const v = (TEXTES.en.page || {})[el.getAttribute('data-i18n-ph') || ''];
      if (v !== undefined) el.setAttribute('placeholder', v);
    });
    // Les pages statiques existent en deux langues : aide.html / aide.en.html, etc.
    document.querySelectorAll('a[href]').forEach(a => {
      const m = /^(aide|mentions-legales|confidentialite)\.html(#.*)?$/.exec(a.getAttribute('href') || '');
      if (m) a.setAttribute('href', m[1] + '.en.html' + (m[2] || ''));
    });
  }
  TEXTES.en.page = {
    'connexion-titre': 'Connection',
    'connexion-aide': 'These details come from your MQTT provider. They stay on this device and are sent to nobody but the broker.',
    'b-url': 'Broker address (secure WebSocket)', 'b-user': 'Username', 'b-pass': 'Password', 'b-prefixe': 'Topic prefix',
    'se-connecter': 'Connect', 'tester': 'Test the connection',
    'ajouter-titre': 'Add a base',
    'ajouter-aide': 'The identifier and the pairing code are shown on the base\'s screen at first boot, and with the jeton command.',
    'a-id': 'Identifier', 'a-jeton': 'Pairing code', 'a-jeton-ph': '24 characters', 'a-nom': 'Name (to find it again)', 'a-nom-ph': 'Living room terrarium',
    'ajouter': 'Add', 'scanner': 'Scan a QR', 'changer-broker': 'Change broker', 'tous-les-socles': 'All bases',
    'aide': 'Help', 'diagnostic': 'Diagnostics', 'exporter-config': 'Export configuration', 'importer-config': 'Import configuration',
    'installer': 'Install the app', 'langue': 'Language', 'mentions': 'Legal notice', 'confidentialite': 'Privacy',
    'installateur': 'Flash a base',
    'verrou-titre': 'App locked', 'verrou-aide': 'Pairing codes and the broker password are encrypted on this device. Enter your code to continue.',
    'verrou-code': 'Code', 'deverrouiller': 'Unlock', 'code-oublie': 'Forgot the code? Erase everything and start over',
    'definir-code': 'Lock code', 'verrouiller': 'Lock', 'retirer-code': 'Remove the code', 'verrou-auto': 'Lock after', 'verrou-jamais': 'never (at launch only)'
  };

  let config = { broker: null, socles: [] };
  let client = null;
  let vueCourante = 'broker';
  let socleOuvert = null;
  let panneauActif = 'etat';        // etat | reglages | courbes | general
  const etats = {};                 // id -> { enLigne, zones, uptime, entretienS, sante, … }
  const attentes = {};              // req -> { resoudre, rejeter, minuteur }
  const courbes = {};               // id -> { heures, points, chargement, erreur }
  const zooms = {};                 // id -> { debut, fin } ou null (vue entière)
  const stats = {};                 // id -> réponse de l'action « stats »
  const generaux = {};              // id -> réponse de l'action « globaux »
  const alertesVues = {};           // id -> [libellé|null, …] : dernier défaut notifié
  let versionApp = null;            // contenu de version.json, écrit à la publication
  const erreurs = [];               // journal des erreurs, pour le diagnostic
  let evenementInstall = null;      // beforeinstallprompt, gardé pour le bouton Installer

  const doc = document;
  /** @returns {any} */
  const $ = s => doc.querySelector(s);
  /** Client MQTT (app/mqtt.js, ou l'imitation embarquée de la démonstration). @type {any} */
  const mqtt = /** @type {any} */ (window).mqtt;

  // ---------------------------------------------------------------- stockage
  // Le code d'appairage est un secret : il vit dans le stockage local du
  // navigateur, jamais sur un serveur. Quelqu'un ayant accès au téléphone
  // déverrouillé y accède — c'est dit à l'utilisateur plutôt que caché.
  // ---- verrouillage par code -------------------------------------------------
  // Avec un code, la configuration (adresse et mot de passe du broker, codes
  // d'appairage) est chiffrée au repos : AES-GCM, clé dérivée du code par
  // PBKDF2. Sans le code, le stockage du navigateur ne contient rien
  // d'exploitable, et qui prend le téléphone déverrouillé ne peut pas chauffer
  // un animal. Nécessite WebCrypto (toujours là en HTTPS, et en local).
  let enveloppe = null;             // { chiffre: true, sel, iv, donnees } tant que la configuration est verrouillée
  let cleVerrou = null;             // CryptoKey dérivée du code, en mémoire seulement
  let verrouille = false;
  let echecsCode = 0;
  let cacheDepuis = 0;
  const cryptoDispo = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof TextEncoder !== 'undefined';
  const b64 = o => btoa(String.fromCharCode(...new Uint8Array(o)));
  const deB64 = x => Uint8Array.from(atob(x), c => c.charCodeAt(0));
  const aleatoire = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };

  async function deriverCle(code, sel) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sel, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
                                   base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function chiffrerConfig() {
    const iv = aleatoire(12);
    const donnees = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cleVerrou, new TextEncoder().encode(JSON.stringify(config)));
    return { chiffre: true, sel: enveloppe.sel, iv: b64(iv), donnees: b64(donnees), iterations: PBKDF2_ITERATIONS };
  }
  async function dechiffrerConfig(cle, env) {
    const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(env.iv) }, cle, deB64(env.donnees));
    return JSON.parse(new TextDecoder().decode(clair));
  }
  const codeVerrouActif = () => !!enveloppe;
  function verrouMinutes() {
    try { const v = parseInt(localStorage.getItem(CLE_VERROU_MIN) || '5', 10); return isNaN(v) ? 5 : v; } catch (e) { return 5; }
  }
  function verrouiller() {
    if (!codeVerrouActif() || verrouille) return;
    verrouille = true;
    cleVerrou = null;                 // la clé repart de zéro : il faudra le code
    montrer('verrou');
  }

  function charger() {
    let brut = null;
    try { brut = localStorage.getItem(CLE_CONFIG); } catch (e) { /* stockage indisponible */ }
    try {
      const lu = brut ? JSON.parse(brut) : null;
      if (lu && lu.chiffre === true && lu.sel && lu.iv && lu.donnees) {
        enveloppe = lu;
        verrouille = true;
        config = { broker: null, socles: [] };
        return;
      }
      if (lu) config = lu;
    } catch (e) {
      console.warn('Configuration illisible, on repart de zéro', e);
    }
    if (!config || typeof config !== 'object') config = { broker: null, socles: [] };
    if (!Array.isArray(config.socles)) config.socles = [];
  }

  function sauver() {
    if (enveloppe && cleVerrou) {
      chiffrerConfig().then(env => { enveloppe = env; localStorage.setItem(CLE_CONFIG, JSON.stringify(env)); })
        .catch(() => message(t('sauverImpossible'), true));
      return;
    }
    try { localStorage.setItem(CLE_CONFIG, JSON.stringify(config)); }
    catch (e) { message(t('sauverImpossible'), true); }
  }

  const socle = id => config.socles.find(s => s.id === id);

  // --------------------------------------------------------- journal d'erreurs
  function noterErreur(texte) {
    erreurs.push({ quand: new Date().toISOString().slice(0, 19).replace('T', ' '), texte: String(texte).slice(0, 300) });
    if (erreurs.length > 30) erreurs.shift();
  }

  // -------------------------------------------------------------------- MQTT
  const base = id => `${config.broker.prefixe}/${id}`;
  const sujets = id => [`${base(id)}/statut`, `${base(id)}/+/etat`, `${base(id)}/reponse`, `${base(id)}/sante`, `${base(id)}/maj`];

  // ------------------------------------------------------------- serveur
  // Facultatif : quand le broker est le serveur Terrariums (serveur/), son API
  // ajoute ce qu'un broker seul ne sait pas faire — rattacher un socle à un
  // compte (preuve par le code d'appairage), garder l'historique application
  // fermée, pousser des notifications sur le téléphone, recevoir un rapport de
  // diagnostic. Détecté par son annonce MQTT retenue (<prefixe>/serveur) : un
  // broker ordinaire n'est jamais sondé en HTTP, ce qui lui vaudrait une
  // erreur CORS à chaque connexion. /api/infos confirme ensuite.
  const serveur = {
    origine() {
      const b = config.broker;
      if (!b || !b.url) return null;
      try { const u = new URL(b.url); if (!/^wss?:$/.test(u.protocol) || u.pathname !== '/mqtt') return null; return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host; }
      catch (e) { return null; }
    },
    actif() { return !!(config.serveur && config.serveur.jeton && serveur.origine()); },
    async appel(methode, chemin, corps) {
      const o = serveur.origine();
      if (!o || !config.serveur || !config.serveur.jeton) throw new Error(t('serveurAbsent'));
      const r = await fetch(o + chemin, { method: methode, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.serveur.jeton },
                                          body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
      let d = null; try { d = await r.json(); } catch (e) { /* vide */ }
      if (r.status === 401 && await serveur.ouvrirSession()) return serveur.appel(methode, chemin, corps);
      if (!r.ok) throw new Error((d && d.erreur) || ('HTTP ' + r.status));
      return d;
    },
    // Détecte le serveur et ouvre une session avec les identifiants du broker.
    async detecter() {
      const o = serveur.origine();
      if (!o || typeof fetch !== 'function') { config.serveur = null; return false; }
      try {
        const r = await fetch(o + '/api/infos');
        const i = r.ok ? await r.json() : null;
        if (!i || i.serveur !== 'terrariums') { config.serveur = null; return false; }
        config.serveur = { push: !!i.push, jeton: config.serveur && config.serveur.jeton || null };
        return serveur.ouvrirSession();
      } catch (e) { config.serveur = null; return false; }
    },
    async ouvrirSession() {
      const o = serveur.origine(), b = config.broker;
      if (!o || !b || !b.user) return false;
      try {
        const r = await fetch(o + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: b.user, motDePasse: b.pass }) });
        if (!r.ok) return false;
        const d = await r.json();
        config.serveur = Object.assign(config.serveur || {}, { jeton: d.jeton, login: d.login, socles: d.socles || [] });
        sauver();
        return true;
      } catch (e) { return false; }
    },
    // Rattache un socle au compte : le serveur vérifie le code auprès du socle.
    async revendiquer(id, jeton) {
      const d = await serveur.appel('POST', '/api/socles/revendiquer', { id, jeton });
      if (config.serveur) config.serveur.socles = d.socles || [];
      return d;
    },
    async historique(id, depuis, jusqua, pas) {
      const d = await serveur.appel('GET', `/api/socles/${encodeURIComponent(id)}/historique?depuis=${depuis}&jusqua=${jusqua}&pas=${pas}`);
      return (d && d.points) || [];
    },
    async activerPush() {
      if (!config.serveur || !config.serveur.push) throw new Error(t('pushIndispo'));
      if (!navigator.serviceWorker || !('PushManager' in window)) throw new Error(t('pushIndispo'));
      const reg = await navigator.serviceWorker.ready;
      const cle = (await serveur.appel('GET', '/api/push/cle')).cle;
      const brut = atob(cle.replace(/-/g, '+').replace(/_/g, '/').padEnd(cle.length + (4 - cle.length % 4) % 4, '='));
      const abonnement = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(brut, c => c.charCodeAt(0)) });
      await serveur.appel('POST', '/api/push/abonnement', { abonnement: abonnement.toJSON ? abonnement.toJSON() : abonnement });
      config.serveur.pushActif = true;
      sauver();
      // Une notification d'essai tout de suite : l'utilisateur voit que la
      // chaîne complète (serveur → service de push → téléphone) fonctionne.
      try { await serveur.appel('POST', '/api/push/essai', {}); } catch (e) { noterErreur('push essai : ' + (e && e.message)); }
    }
  };

  function optionsClient(b) {
    // Un champ vide veut dire « anonyme » : on n'envoie alors pas le drapeau,
    // sinon un broker à liste de comptes refuserait un nom d'utilisateur vide.
    return {
      username: b.user || undefined,
      password: b.pass || undefined,
      clean: true,
      reconnectPeriod: 4000,
      connectTimeout: 8000,
      // Identifiant unique : deux onglets ouverts ne doivent pas se déconnecter
      // mutuellement, ce que fait un broker quand deux clients partagent un id.
      clientId: 'app-' + Math.random().toString(16).slice(2, 10)
    };
  }

  const sujetServeur = () => `${config.broker.prefixe}/serveur`;

  function connecter() {
    if (!config.broker || !config.broker.url) { montrer('broker'); return; }
    // Serveur déjà connu de cette configuration : session rouverte tout de
    // suite ; sinon, c'est son annonce MQTT qui déclenchera la détection.
    if (config.serveur) serveur.detecter().then(() => invalider());
    if (client) { try { client.end(true); } catch (e) { /* déjà fermé */ } }

    lien(t('connexion'), 'attente');
    client = mqtt.connect(config.broker.url, optionsClient(config.broker));

    client.on('connect', () => {
      lien(t('connecte'), 'ok');
      client.subscribe([sujetServeur()]);
      config.socles.forEach(abonner);
      // Un socle déjà en ligne ne republiera son état que plus tard : on le
      // demande tout de suite pour ne pas afficher une page vide.
      config.socles.forEach(s => commander(s.id, 'etat').catch(() => {}));
    });
    client.on('reconnect', () => lien(t('reconnexion'), 'attente'));
    client.on('offline',   () => lien(t('horsLigne'), 'ko'));
    client.on('close',     () => lien(t('horsLigne'), 'ko'));
    client.on('error', e => { lien(t('erreurLien', { m: e.message }), 'ko'); noterErreur('broker : ' + e.message); });
    client.on('message', recevoir);
  }

  function abonner(s) {
    // Le joker MQTT occupe un niveau entier : « zone+/etat » est un filtre
    // invalide que le broker rejette, et le rejet emporte tout l'abonnement.
    if (client && client.connected) client.subscribe(sujets(s.id));
  }

  // Le socle décrit son état sous deux formes : les sujets « /etat », taillés
  // pour Home Assistant, où « defaut » vaut la chaîne "0" ou "1" ; et la réponse
  // à la commande « etat », où il vaut null ou le libellé du défaut. Sans cette
  // normalisation, une zone saine s'afficherait en panne, puisque la chaîne "0"
  // est vraie en JavaScript. Les deux sources ne portent pas les mêmes champs :
  // on complète l'état précédent plutôt que de le remplacer.
  function normaliser(z, precedent) {
    if (!z) return z;
    const n = { ...(precedent || {}), ...z };
    const d = z.defaut;
    const enPanne = d === true || d === 1 || d === '1' ||
                    (typeof d === 'string' && d !== '' && d !== '0' && d.toUpperCase() !== 'OK');
    if (!enPanne) n.defaut = null;
    else if (z.defaut_libelle && z.defaut_libelle !== 'OK') n.defaut = z.defaut_libelle;
    else if (typeof d === 'string' && d !== '1') n.defaut = d;
    else n.defaut = 'DÉFAUT';
    const vrai = v => v === true || v === 1 || v === '1';
    n.chauffe = vrai(z.chauffe);
    n.autotune = vrai(z.autotune);
    n.derive = vrai(z.derive);
    return n;
  }

  function recevoir(sujet, charge) {
    const texte = charge.toString();
    if (sujet === sujetServeur()) {
      let a; try { a = JSON.parse(texte); } catch (err) { return; }
      if (a && a.serveur === 'terrariums' && !config.serveur) serveur.detecter().then(() => invalider());
      return;
    }
    const parts = sujet.split('/');
    const id = parts[1];
    if (!etats[id]) etats[id] = { enLigne: false, zones: [] };
    const e = etats[id];

    if (sujet.endsWith('/statut')) {
      e.enLigne = (texte === 'en ligne');
    } else if (sujet.endsWith('/sante')) {
      try { noterSante(e, JSON.parse(texte)); } catch (err) { return; }
    } else if (sujet.endsWith('/maj')) {
      // Progression d'une mise à jour tirée : téléchargement en %, redémarrage, erreur.
      let m; try { m = JSON.parse(texte); } catch (err) { return; }
      e.majEnCours = m;
      if (m.etat === 'redemarrage') { message(t('majRedemarre')); setTimeout(() => { e.majEnCours = null; invalider(); }, 90000); }
      else if (m.etat === 'erreur') { message(t('majErreur', { m: m.detail || '?' }), true); e.majEnCours = null; }
    } else if (sujet.endsWith('/etat')) {
      const n = parseInt(parts[2].replace('zone', ''), 10) - 1;
      if (!(n >= 0)) return;
      try { e.zones[n] = normaliser(JSON.parse(texte), e.zones[n]); } catch (err) { return; }
      e.enLigne = true;
      e.derniereMaj = Date.now();
      hist.noter(id, e);
    } else if (sujet.endsWith('/reponse')) {
      let r; try { r = JSON.parse(texte); } catch (err) { return; }
      const a = attentes[r.req];
      if (a) {
        clearTimeout(a.minuteur);
        delete attentes[r.req];
        r.ok ? a.resoudre(r) : a.rejeter(new Error(r.erreur || t('refuse')));
      }
      // Une réponse « etat » porte les mêmes données qu'une publication.
      if (r.ok && r.zones) {
        e.zones = r.zones.map((z, i) => normaliser(z, e.zones[i]));
        e.uptime = r.uptime; e.entretienS = r.entretienS; e.enLigne = true;
        e.derniereMaj = Date.now();
        ['heure', 'zonesSimultanees', 'saison', 'alertesEnAttente']
          .forEach(k => { if (r[k] !== undefined) e[k] = r[k]; });
        if (r.sante) noterSante(e, r.sante);
        else if (r.proto !== undefined) e.proto = r.proto;
        hist.noter(id, e);
      }
    }
    surveillerAlertes(id);
    invalider();
  }

  function noterSante(e, s) {
    if (!s || typeof s !== 'object') return;
    e.sante = s;
    if (s.proto !== undefined) e.proto = s.proto;
    if (s.version !== undefined) e.version = s.version;
    if (s.uptime !== undefined) e.uptime = s.uptime;
  }

  // Envoie une commande et attend sa réponse. Le délai n'est pas facultatif :
  // un socle hors ligne ne répond jamais, et l'interface doit le dire plutôt
  // que de rester figée sur un bouton qui tourne. La commande part en QoS 1 :
  // sur une liaison mobile hachée, elle est réémise par le client jusqu'à ce
  // que le broker l'ait acquittée.
  function commander(id, action, params = {}) {
    return new Promise((resoudre, rejeter) => {
      if (!client || !client.connected) { rejeter(new Error(t('pasDeConnexion'))); return; }
      const s = socle(id);
      if (!s) { rejeter(new Error(t('socleInconnu'))); return; }
      const req = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      attentes[req] = {
        resoudre, rejeter,
        minuteur: setTimeout(() => {
          delete attentes[req];
          rejeter(new Error(t('pasDeReponse')));
        }, DELAI_COMMANDE)
      };
      client.publish(base(id) + '/cmd', JSON.stringify({ req, action, jeton: s.jeton, ...params }), { qos: 1 });
    });
  }

  // ----------------------------------------------------------- notifications
  // Les notifications du navigateur sont le seul canal disponible sans serveur :
  // elles ne partent que pendant que l'application est ouverte, même en
  // arrière-plan. Le webhook du socle reste le moyen sûr d'être prévenu
  // appareil éteint — c'est dit à l'utilisateur plutôt que promis à tort.
  const notificationsPossibles = () =>
    typeof Notification !== 'undefined' && window.isSecureContext !== false;

  function etatNotifications() {
    if (!notificationsPossibles()) return 'indisponible';
    return Notification.permission;             // 'granted' | 'denied' | 'default'
  }

  function notifier(titre, corps) {
    if (etatNotifications() !== 'granted') return;
    try { new Notification(titre, { body: corps, tag: titre, icon: 'icone.svg' }); }
    catch (e) { /* certains navigateurs mobiles exigent un agent de service */ }
  }

  // Pastille sur l'icône de l'application : le nombre de zones en défaut.
  function majBadge() {
    const nav = /** @type {any} */ (navigator);
    if (typeof nav.setAppBadge !== 'function') return;
    let n = 0;
    config.socles.forEach(s => { const e = etats[s.id]; if (e) e.zones.forEach(z => { if (z && z.defaut) n++; }); });
    try { (n ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => {}); } catch (e) { /* non pris en charge */ }
  }

  // Ne notifie qu'aux transitions : sans cela, chaque publication du socle
  // rejouerait l'alerte.
  function surveillerAlertes(id) {
    const e = etats[id];
    if (!e || !e.zones) return;
    const s = socle(id);
    const nom = (s && s.nom) || id;
    if (!alertesVues[id]) alertesVues[id] = [];
    let nouveauDefaut = false;
    e.zones.forEach((z, i) => {
      if (!z) return;
      const courant = z.defaut || (z.derive ? 'derive' : null);
      const precedent = alertesVues[id][i];
      if (courant === precedent) return;
      alertesVues[id][i] = courant;
      if (precedent === undefined) return;      // premier état connu : rien à signaler
      const zone = z.nom || t('zoneN', { n: i + 1 });
      if (courant === 'derive')  notifier(t('notifDerive', { nom }), t('notifDeriveCorps', { zone }));
      else if (courant)        { notifier(t('notifDefaut', { nom }), t('notifDefautCorps', { zone, d: courant })); nouveauDefaut = true; }
      else                       notifier(t('notifRetabli', { nom }), t('notifRetabliCorps', { zone }));
    });
    // Une vibration brève sur un nouveau défaut : la régulation vient de couper
    // le chauffage d'un animal, ce n'est pas un message comme les autres.
    if (nouveauDefaut && typeof navigator.vibrate === 'function') { try { navigator.vibrate([90, 60, 90]); } catch (e) { /* refusé */ } }
    majBadge();
  }

  // ------------------------------------------------------------------- outils
  const esc = s => String(s == null ? '' : s)
    .replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&#39;' }[c] || c));
  const attr = v => (v === undefined || v === null) ? '' : esc(v);
  const fixe1 = v => (v === undefined || v === null || isNaN(v)) ? '—' : Number(v).toFixed(1);
  const icone = nom => `<svg class="ico" aria-hidden="true"><use href="#${nom}"/></svg>`;

  // Les claviers français écrivent « 33,5 » : une virgule est un point.
  function nombre(texte) {
    if (texte === undefined || texte === null) return NaN;
    const t_ = String(texte).trim().replace(',', '.');
    return t_ === '' ? NaN : Number(t_);
  }
  // Lit un champ numérique ; vide veut dire « inchangé », jamais zéro.
  function champNombre(id) {
    const el = /** @type {HTMLInputElement|null} */ (doc.getElementById(id));
    if (!el || el.value.trim() === '') return undefined;
    const v = nombre(el.value);
    return isNaN(v) ? undefined : v;
  }

  // Minutes depuis minuit <-> HH:MM. Le socle raisonne en minutes, l'utilisateur
  // en heures : la conversion vit ici, comme dans le firmware.
  const enHHMM = m => (m === undefined || m === null || m === '') ? ''
    : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  function depuisHHMM(t_) {
    const m = /^\s*(\d{1,2})[:hH](\d{1,2})\s*$/.exec(t_ || '');
    if (!m) return null;
    const h = +m[1], mn = +m[2];
    return (h > 23 || mn > 59) ? null : h * 60 + mn;
  }

  // Téléchargement d'un fichier produit dans la page (export CSV, sauvegardes).
  function telecharger(nom, contenu, type) {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') {
      message(t('telechargementIndispo'), true); return false;
    }
    const url = URL.createObjectURL(new Blob([contenu], { type }));
    const a = doc.createElement('a');
    a.href = url; a.download = nom; a.hidden = true;
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  const lireFichier = fichier => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ''));
    r.onerror = () => rej(new Error('lecture impossible'));
    r.readAsText(fichier);
  });

  // -------------------------------------------------------------------- rendu
  // peindre() ne touche au DOM que si le contenu a changé : c'est ce qui permet
  // de redessiner à chaque message du socle sans rien casser ni rien coûter.
  // Trusted Types : la CSP exige que tout HTML injecté passe par une politique
  // nommée. Il n'y a pas de nettoyeur (tout ce qui vient du socle est échappé
  // par esc()/attr()), mais un seul point d'entrée vers innerHTML : toute autre
  // écriture dans le DOM est refusée par le navigateur, et se voit à la revue.
  const tt = /** @type {any} */ (window).trustedTypes;
  const politiqueHtml = tt && typeof tt.createPolicy === 'function'
    ? (() => { try { return tt.createPolicy('terrarium', { createHTML: x => x, createScriptURL: x => x }); } catch (e) { return null; } })() : null;
  function html(el, h) { el.innerHTML = politiqueHtml ? politiqueHtml.createHTML(h) : h; }
  // Seule URL de script que l'application charge : son agent de service.
  const urlScript = u => (politiqueHtml ? politiqueHtml.createScriptURL(u) : u);
  const memo = new WeakMap();
  function peindre(el, h) {
    if (!el || memo.get(el) === h) return false;
    memo.set(el, h);
    html(el, h);
    return true;
  }
  function texte(el, t_) { if (el && el.textContent !== t_) el.textContent = t_; }

  // Une seule mise à jour par image, quel que soit le nombre de messages reçus.
  let prevu = false;
  const planifier = typeof requestAnimationFrame === 'function'
    ? cb => requestAnimationFrame(cb) : cb => setTimeout(cb, 16);
  function invalider() {
    if (prevu) return;
    prevu = true;
    planifier(() => { prevu = false; dessiner(); });
  }

  function lien(t_, classe) {
    const el = $('#lien');
    texte(el, t_);
    el.className = 'etat ' + classe;
  }

  // Un message passager en bas de l'écran. Avec une action (bouton), il reste
  // affiché jusqu'à ce qu'on clique — ou jusqu'à `duree` si elle est donnée,
  // ce qui sert à proposer d'annuler un geste pendant quelques secondes.
  function message(t_, erreur = false, action, duree) {
    const el = $('#message');
    el.textContent = t_;
    el.className = 'visible' + (erreur ? ' erreur' : '');
    clearTimeout(message.minuteur);
    if (action) {
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'btn btn-petit'; b.textContent = action.libelle;
      b.addEventListener('click', () => { el.className = ''; action.faire(); });
      el.appendChild(b);
      if (duree) message.minuteur = setTimeout(() => { el.className = ''; }, duree);
      return;
    }
    message.minuteur = setTimeout(() => { el.className = ''; }, duree || (erreur ? 6000 : 4000));
  }
  message.minuteur = /** @type {any} */ (null);

  // ---- dialogues ------------------------------------------------------------
  // Une boîte native <dialog>, stylée comme le reste : plus de confirm() du
  // navigateur, dont l'apparence dépend de l'appareil et qui bloque la page.
  function ouvrirDialogue(dlg) {
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }
  function fermerDialogue(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  let resolutionConfirmation = null;
  function confirmer(o) {
    return new Promise(res => {
      let dlg = $('#dlg-confirm');
      if (!dlg) {
        dlg = doc.createElement('dialog');
        dlg.id = 'dlg-confirm'; dlg.className = 'feuille';
        html(dlg, `<h2 id="dlg-titre"></h2><p class="aide" id="dlg-texte"></p>
          <div class="boutons fin"><button type="button" class="btn btn-secondaire" data-dlg="non"></button>
          <button type="button" class="btn" data-dlg="oui"></button></div>`);
        dlg.addEventListener('close', () => { if (resolutionConfirmation) { const r = resolutionConfirmation; resolutionConfirmation = null; r(false); } });
        doc.body.appendChild(dlg);
      }
      texte($('#dlg-titre'), o.titre);
      texte($('#dlg-texte'), o.texte || '');
      const non = dlg.querySelector('[data-dlg="non"]'), oui = dlg.querySelector('[data-dlg="oui"]');
      texte(non, t('cancel'));
      texte(oui, o.ok || t('confirmer'));
      oui.className = 'btn' + (o.danger ? ' btn-danger' : '');
      resolutionConfirmation = res;
      ouvrirDialogue(dlg);
      try { oui.focus(); } catch (e) { /* hors écran */ }
    });
  }
  // Saisie d'un nouveau code (deux fois) ; null si annulé.
  function demanderCode() {
    return new Promise(res => {
      let dlg = $('#dlg-code');
      if (!dlg) {
        dlg = doc.createElement('dialog');
        dlg.id = 'dlg-code'; dlg.className = 'feuille';
        html(dlg, `<form method="dialog"><h2>${t('definirCode')}</h2><p class="aide">${t('aideCode')}</p>
          <label for="code-1">${t('nouveauCode')}</label><input id="code-1" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" required>
          <label for="code-2">${t('confirmerCode')}</label><input id="code-2" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" required>
          <p class="aide erreur-code" id="code-erreur"></p>
          <div class="boutons fin"><button type="button" class="btn btn-secondaire" data-code="non">${t('cancel')}</button>
          <button type="submit" class="btn" data-code="oui">${t('enregistrer')}</button></div></form>`);
        doc.body.appendChild(dlg);
        dlg.addEventListener('close', () => { if (dlg._res) { const r = dlg._res; dlg._res = null; r(null); } });
        dlg.querySelector('[data-code="non"]').addEventListener('click', () => { const r = dlg._res; dlg._res = null; fermerDialogue(dlg); if (r) r(null); });
        dlg.querySelector('form').addEventListener('submit', ev => {
          ev.preventDefault();
          const a = $('#code-1').value, b = $('#code-2').value;
          if (a.length < 4) { texte($('#code-erreur'), t('codeTropCourt')); return; }
          if (a !== b) { texte($('#code-erreur'), t('codesDifferents')); return; }
          const r = dlg._res; dlg._res = null;
          $('#code-1').value = ''; $('#code-2').value = '';
          fermerDialogue(dlg);
          if (r) r(a);
        });
      }
      texte($('#code-erreur'), '');
      dlg._res = res;
      ouvrirDialogue(dlg);
      try { $('#code-1').focus(); } catch (e) { /* hors écran */ }
    });
  }

  function repondreConfirmation(valeur) {
    const dlg = $('#dlg-confirm');
    const r = resolutionConfirmation;
    resolutionConfirmation = null;
    fermerDialogue(dlg);
    if (r) r(valeur);
  }

  function montrer(vue) {
    if (verrouille) vue = 'verrou';    // rien d'autre ne s'affiche tant que le code n'est pas donné
    vueCourante = vue;
    ['broker', 'liste', 'socle', 'verrou'].forEach(v => {
      const el = $('#vue-' + v);
      if (el) el.style.display = (v === vue) ? 'block' : 'none';
    });
    doc.body.dataset.vue = vue;
    doc.documentElement.scrollTop = 0;
    dessiner();
  }

  function peindreVerrou() {
    const actif = codeVerrouActif(), dispo = cryptoDispo();
    const d = $('#btn-definir-code'), r = $('#btn-retirer-code'), v = $('#btn-verrouiller'), m = $('#verrou-min');
    if (d) d.hidden = actif || !dispo;
    if (r) r.hidden = !actif;
    if (v) v.hidden = !actif;
    if (m) { m.hidden = !actif; const lab = m.closest('label'); if (lab) lab.hidden = !actif; if (m.value !== String(verrouMinutes())) m.value = String(verrouMinutes()); }
  }

  function dessiner() {
    peindreVerrou();
    if (vueCourante === 'liste') dessinerListe();
    else if (vueCourante === 'socle') dessinerSocle();
    peindreVersion();
  }

  function peindreVersion() {
    if (versionApp && versionApp.firmware) invalider();   // la carte « Mise à jour » dépend de la version publiée
    const el = $('#version-app');
    if (!el) return;
    const v = versionApp ? `v${versionApp.version}` + (versionApp.commit ? ` · ${String(versionApp.commit).slice(0, 7)}` : '') : t('versionDev');
    texte(el, 'Terrariums ' + v);
  }

  // ------------------------------------------------------------ composants
  function tuileZone(z, i) {
    if (!z) {
      return `<div class="zone squelette" data-zone="${i}" aria-busy="true"><span class="sr-only">${t('attenteDonnees')}</span>
        <div class="titre"><span class="os os-1"></span></div><div class="temp"><span class="os os-2"></span></div>
        <div class="meta"><span class="os os-3"></span></div></div>`;
    }
    const panne = !!z.defaut;
    const temp = (panne || z.temp === undefined || z.temp === null)
      ? '—' : `${Number(z.temp).toFixed(1)}<small> °C</small>`;
    return `<div class="zone" data-zone="${i}">
      <div class="titre">${esc(z.nom || t('zoneN', { n: i + 1 }))}</div>
      <div class="temp${panne ? ' panne' : ''}">${temp}</div>
      ${panne ? `<div class="defaut">${t('defautLib', { d: esc(z.defaut) })}</div>` : ''}
      <div class="meta">
        <span>${t('cible', { v: fixe1(z.consigne) })}</span><span>${t('demande', { v: z.demande === undefined ? '—' : z.demande })}</span>
        ${z.chauffe ? `<span class="chauffe">${icone('i-flamme')}${t('chauffe')}</span>` : ''}
        ${z.derive ? `<span class="derive">${t('derive')}</span>` : ''}
        ${z.autotune ? `<span class="badge neutre">${t('autotune')}</span>` : ''}
      </div>
    </div>`;
  }

  const minutesSilence = e => (e.enLigne && e.derniereMaj) ? Math.floor((Date.now() - e.derniereMaj) / 60000) : 0;
  const silencieux = e => !!(e.enLigne && e.derniereMaj && Date.now() - e.derniereMaj > SILENCE_MS);

  function badgeLigne(e) {
    if (!e.enLigne) return `<span class="badge ko">${t('horsLigne')}</span>`;
    if (silencieux(e)) return `<span class="badge warn">${t('silencieux', { m: minutesSilence(e) })}</span>`;
    return `<span class="badge ok">${t('enLigne')}</span>`;
  }

  // Compatibilité de protocole : un socle plus récent que l'application, ou
  // l'inverse, est signalé sans bloquer ce qui marche encore.
  function badgeProto(e) {
    if (e.proto !== undefined && e.proto > PROTO_APP) return `<span class="badge warn">${t('majAppli')}</span>`;
    if (e.version && e.proto === undefined) return `<span class="badge neutre">${t('majSocle')}</span>`;
    return '';
  }

  // ------------------------------------------------------------------- liste
  const cartes = new Map();         // id -> <article>, pour ne reconstruire que ce qui change

  function dessinerListe() {
    const conteneur = $('#socles');
    const hote = $('#broker-hote');
    if (hote && config.broker) {
      let h = config.broker.url;
      try { h = new URL(config.broker.url).host; } catch (e) { /* adresse brute */ }
      texte(hote, t('brokerAffiche', { h }));
    }

    if (!config.socles.length) {
      cartes.forEach(c => c.remove()); cartes.clear();
      peindre(conteneur, `<div class="carte etat-vide">
        <svg viewBox="0 0 120 80" aria-hidden="true"><rect x="10" y="14" width="100" height="56" rx="12" fill="var(--creux)"/>
        <rect x="22" y="26" width="34" height="32" rx="8" fill="var(--zone-1)" opacity=".85"/>
        <rect x="64" y="26" width="34" height="32" rx="8" fill="var(--zone-2)" opacity=".85"/>
        <circle cx="39" cy="42" r="7" fill="var(--carte)"/><circle cx="81" cy="42" r="7" fill="var(--carte)"/></svg>
        <h2>${t('aucunSocle')}</h2><p class="aide">${t('aucunSocleAide')}</p></div>`);
      return;
    }
    if (!cartes.size) { html(conteneur, ''); memo.delete(conteneur); }

    const vus = new Set();
    config.socles.forEach((s, i) => {
      vus.add(s.id);
      let carte = cartes.get(s.id);
      if (!carte) {
        carte = doc.createElement('div');
        carte.className = 'carte socle';
        carte.tabIndex = 0;
        carte.setAttribute('role', 'button');
        carte.dataset.action = 'ouvrir';
        carte.dataset.id = s.id;
        cartes.set(s.id, carte);
      }
      const e = etats[s.id] || { enLigne: false, zones: [] };
      const zones = e.zones || [];
      carte.classList.toggle('alerte', zones.some(z => z && z.defaut));
      peindre(carte, `<div class="carte-tete"><h2>${esc(s.nom || s.id)}</h2>${badgeLigne(e)}</div>
        <div class="zones">${[0, 1].map(k => tuileZone(zones[k], k)).join('')}</div>`);
      if (conteneur.children[i] !== carte) conteneur.insertBefore(carte, conteneur.children[i] || null);
    });
    cartes.forEach((carte, id) => { if (!vus.has(id)) { carte.remove(); cartes.delete(id); } });
  }

  // ------------------------------------------------------------------ détail
  function enteteSocle(s, e) {
    const heures = e.uptime ? Math.floor(e.uptime / 3600) : 0;
    return `<div class="carte-tete"><h2 tabindex="-1">${esc(s.nom || s.id)}</h2>${badgeLigne(e)}</div>
      <div class="separe">
        <span class="discret">${esc(s.id)}</span>
        ${e.version ? `<span class="discret">· ${t('firmware', { v: esc(e.version) })}</span>` : ''}
        ${heures ? `<span class="discret">· ${t('heuresService', { h: heures })}</span>` : ''}
        ${e.heure ? `<span class="discret">· ${t('horlogeSocle', { h: esc(String(e.heure).slice(11, 16)) })}</span>` : ''}
        ${e.entretienS ? `<span class="badge warn">${icone('i-pause')}${t('entretienMin', { m: Math.ceil(e.entretienS / 60) })}</span>` : ''}
        ${e.alertesEnAttente ? `<span class="badge warn">${t('alertesAttente', { n: e.alertesEnAttente })}</span>` : ''}
        ${badgeProto(e)}
      </div>`;
  }

  function dessinerSocle() {
    const s = socle(socleOuvert);
    if (!s) { montrer('liste'); return; }
    const e = etats[s.id] || { enLigne: false, zones: [] };
    const detail = $('#detail');

    // L'ossature (en-tête, avertissement, onglets, conteneur de panneau) n'est
    // posée qu'une fois par socle ouvert.
    if (detail.dataset.socle !== s.id) {
      detail.dataset.socle = s.id;
      html(detail, `<section class="carte entete-socle" data-r="entete"></section>
        <section class="carte hors-ligne" data-r="horsligne" hidden></section>
        <nav class="onglets" aria-label="${t('sectionsSocle')}">${ONGLETS.map(([k, cle, i]) =>
          `<button type="button" data-action="panneau" data-nom="${k}">${icone(i)}${t(cle)}</button>`).join('')}</nav>
        <div class="pile" data-r="panneau"></div>`);
    }

    peindre(detail.querySelector('[data-r="entete"]'), enteteSocle(s, e));

    const hl = detail.querySelector('[data-r="horsligne"]');
    const muet = silencieux(e);
    hl.hidden = !!e.enLigne && !muet;
    peindre(hl, e.enLigne
      ? (muet ? `<div class="aide">${t('socleSilencieux', { m: minutesSilence(e) })}</div>` : '')
      : `<div class="aide">${t('socleNeRepondPas')}</div>`);

    detail.querySelectorAll('.onglets button').forEach(b => {
      const actif = b.dataset.nom === panneauActif;
      b.classList.toggle('actif', actif);
      if (actif) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });

    // Le panneau n'est reconstruit (et ses champs réinitialisés) que si sa
    // structure change : autre panneau, zones qui arrivent, réglages chargés.
    const conteneur = detail.querySelector('[data-r="panneau"]');
    const zonesConnues = (e.zones || []).filter(Boolean).length;
    let cle = `${panneauActif}|${zonesConnues}`;
    if (panneauActif === 'general') cle += `|${generaux[s.id] ? 1 : 0}|${stats[s.id] ? 1 : 0}`;
    if (conteneur.dataset.cle !== cle) {
      conteneur.dataset.cle = cle;
      html(conteneur, construirePanneau(s, e));
    }
    patcherPanneau(s, e);
  }

  function construirePanneau(s, e) {
    const zones = e.zones || [];
    switch (panneauActif) {
      case 'etat': return structureEtat(zones);
      case 'reglages': return structureReglages(zones);
      case 'courbes': return structureCourbes(zones);
      default: return structureGeneral(s);
    }
  }

  function patcherPanneau(s, e) {
    const zones = e.zones || [];
    const conteneur = $('#detail [data-r="panneau"]');
    if (!conteneur) return;
    switch (panneauActif) {
      case 'etat':
        zones.forEach((z, i) => {
          if (!z) return;
          peindre(conteneur.querySelector(`[data-r="zl${i}"]`), vivantEtat(z, i));
          peindre(conteneur.querySelector(`[data-r="zo${i}"]`), vivantOutils(z, i));
        });
        peindre(conteneur.querySelector('[data-r="actions"]'), vivantActions(e));
        break;
      case 'reglages':
        zones.forEach((z, i) => z && texte(conteneur.querySelector(`[data-r="zr${i}"]`),
          z.defaut ? t('defautLib', { d: z.defaut }) : t('etatZoneCourt', { t: fixe1(z.temp), c: fixe1(z.consigne) })));
        break;
      case 'courbes': patcherCourbes(s.id); break;
      default:
        peindre(conteneur.querySelector('[data-r="sante"]'), vivantSante(e));
        peindre(conteneur.querySelector('[data-r="maj"]'), vivantMaj(e));
        peindre(conteneur.querySelector('[data-r="stats"]'), vivantStats(stats[s.id]));
        peindre(conteneur.querySelector('[data-r="notifs"]'), vivantNotifications());
    }
  }

  // --- État : températures en direct, consignes du jour, autotune, entretien.
  function structureEtat(zones) {
    let h = '';
    zones.forEach((z, i) => {
      if (!z) return;
      h += `<section class="carte zone-carte">
        <div data-r="zl${i}"></div>
        <form data-form="zone" data-z="${i}">
          <div class="rangee">
            <div><label for="j${i}">${t('consigneJour')}</label>
              <input id="j${i}" inputmode="decimal" value="${attr(z.jour)}" placeholder="${t('inchange')}"></div>
            <div><label for="n${i}">${t('consigneNuit')}</label>
              <input id="n${i}" inputmode="decimal" value="${attr(z.nuit)}" placeholder="${t('inchange')}"></div>
          </div>
          <div class="boutons"><button class="btn" type="submit">${t('enregistrer')}</button><span data-r="zo${i}"></span></div>
        </form>
      </section>`;
    });
    if (!h) h = `<section class="carte"><div class="squelette-bloc" aria-busy="true"><span class="sr-only">${t('attentePremieresMesures')}</span>
      <span class="os os-1"></span><span class="os os-2"></span><span class="os os-3"></span></div></section>`;
    else h = `<div class="deux">${h}</div>`;
    return h + '<section class="carte" data-r="actions"></section>';
  }

  const vivantEtat = (z, i) => tuileZone(z, i);

  // Le bouton d'autotune change avec l'état de la zone : il vit dans sa propre
  // région, à côté d'Enregistrer, pour ne pas reconstruire le formulaire.
  const vivantOutils = (z, i) => z.autotune
    ? `<button type="button" class="btn btn-danger" data-action="cmd" data-cmd="stop-autotune" data-params='{"z":${i}}'>${t('arreterAutotune')}</button>`
    : `<button type="button" class="btn btn-secondaire" data-action="cmd" data-cmd="autotune" data-params='{"z":${i}}'>${icone('i-cible')}${t('autotuneBtn')}</button>`;

  function vivantActions(e) {
    const enCours = e.entretienS > 0;
    return `<h2>${t('actions')}</h2>
      <p class="aide">${enCours ? t('entretienEnCours', { m: Math.ceil(e.entretienS / 60) }) : t('entretienAide')}</p>
      <div class="boutons">
        ${enCours
          ? `<button type="button" class="btn" data-action="cmd" data-cmd="entretien" data-params='{"minutes":0}'>${icone('i-ok')}${t('reprendre')}</button>`
          : `<button type="button" class="btn btn-secondaire" data-action="cmd" data-cmd="entretien" data-params='{"minutes":10}'>${icone('i-pause')}${t('entretien10')}</button>`}
        <button type="button" class="btn btn-secondaire" data-action="cmd" data-cmd="reset">${t('leverDefauts')}</button>
      </div>`;
  }

  // --- Réglages : tous les paramètres d'une zone, pas seulement les consignes.
  function structureReglages(zones) {
    const champ = (i, id, etiquette, valeur, mode = 'decimal') =>
      `<div><label for="${id}${i}">${etiquette}</label>
        <input id="${id}${i}" inputmode="${mode}" value="${attr(valeur)}" placeholder="${t('inchange')}"></div>`;
    let h = '';
    zones.forEach((z, i) => {
      if (!z) return;
      h += `<form class="carte" data-form="zone-complet" data-z="${i}">
        <div class="carte-tete"><h2 class="titre-zone" data-zone="${i}">${esc(z.nom || t('zoneN', { n: i + 1 }))}</h2><span class="discret" data-r="zr${i}"></span></div>
        <label for="N${i}">${t('nomZone')}</label>
        <input id="N${i}" value="${attr(z.nom)}" maxlength="24">
        <div class="rangee mt">
          ${champ(i, 'j', t('consigneJour'), z.jour)}
          ${champ(i, 'n', t('consigneNuit'), z.nuit)}
          ${champ(i, 'H', t('debutJour'), enHHMM(z.debutJour), 'numeric')}
          ${champ(i, 'K', t('debutNuit'), enHHMM(z.debutNuit), 'numeric')}
          ${champ(i, 'R', t('rampe'), z.rampe, 'numeric')}
          ${champ(i, 'b', t('bande'), z.bande)}
          ${champ(i, 'm', t('coupureMax'), z.max)}
          ${champ(i, 'o', t('calibration'), z.offset)}
        </div>
        <p class="aide">${t('aideCoupure')}</p>
        <button class="btn" type="submit">${t('enregistrer')}</button>
      </form>`;
    });
    return h ? `<div class="deux">${h}</div>` : `<section class="carte aide">${t('attenteReglages')}</section>`;
  }

  // --- Courbes : demandées au socle à l'ouverture, jamais en continu.
  function structureCourbes(zones) {
    return `<section class="carte">
      <div class="durees">${DUREES.map(d =>
        `<button type="button" class="btn btn-secondaire" data-action="courbes" data-heures="${d}">${d < 48 ? t('dureeH', { h: d }) : t('dureeJ', { j: d / 24 })}</button>`).join('')}
        <button type="button" class="btn btn-fantome" data-action="zoomReinit" hidden>${t('vueEntiere')}</button></div>
      <canvas id="courbe" height="260" role="img" aria-label="${t('ariaCourbes')}"></canvas>
      <div class="legende">${[0, 1].map(i =>
        `<span><i data-zone="${i}"></i>${esc((zones[i] && zones[i].nom) || t('zoneN', { n: i + 1 }))}</span>`).join('')}</div>
      <div class="aide" id="legendeCourbe"></div>
      <div data-r="minmax"></div>
      <div class="boutons"><button type="button" class="btn btn-secondaire btn-petit" data-action="exporterCsv">${t('exporterCsv')}</button></div>
      <p class="aide">${hist.disponible() ? t('aideHistorique') : t('aideHistoriqueCourt')} ${t('zoomAide')}</p>
    </section>`;
  }

  function patcherCourbes(id) {
    const c = courbes[id] || {};
    const heures = c.heures || 24;
    doc.querySelectorAll('#detail .durees [data-heures]').forEach((/** @type {any} */ b) => {
      const actif = +b.dataset.heures === heures;
      b.classList.toggle('btn-secondaire', !actif);
      b.setAttribute('aria-pressed', actif ? 'true' : 'false');
    });
    const reinit = $('#detail [data-action="zoomReinit"]');
    if (reinit) reinit.hidden = !zooms[id];
    texte($('#legendeCourbe'),
      c.chargement ? t('chargement')
      : c.erreur ? c.erreur
      : (c.points && c.points.length) ? t('nbPoints', { n: c.points.length }) : t('aucunPoint'));
    peindre($('#detail [data-r="minmax"]'), (heures >= 168 && c.points && c.points.length) ? tableauMinMax(c.points) : '');
    brancherGestes($('#courbe'), id);
    tracerCourbes(id);
  }

  // Min et max par jour civil, pour les périodes longues : c'est ce qu'on
  // regarde pour juger une semaine, pas le détail minute par minute.
  function tableauMinMax(points) {
    const jours = new Map();
    points.forEach(q => {
      const d = new Date(q[0] * 1000);
      const cle = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      let j = jours.get(cle);
      if (!j) { j = { mini: [Infinity, Infinity], maxi: [-Infinity, -Infinity] }; jours.set(cle, j); }
      [0, 1].forEach(z => {
        const v = q[1 + z * 2];
        if (v === null || v === undefined) return;
        j.mini[z] = Math.min(j.mini[z], v / 100); j.maxi[z] = Math.max(j.maxi[z], v / 100);
      });
    });
    const f = v => isFinite(v) ? v.toFixed(1) : '—';
    const lignes = Array.from(jours.entries()).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 31);
    return `<h3 class="mt">${t('minMaxJour')}</h3><table class="minmax"><thead><tr><th>${t('date')}</th>
      <th class="z1">1 ${t('minC')}</th><th class="z1">1 ${t('maxC')}</th><th class="z2">2 ${t('minC')}</th><th class="z2">2 ${t('maxC')}</th></tr></thead><tbody>${
      lignes.map(([cle, j]) => `<tr><td>${cle.slice(8)}/${cle.slice(5, 7)}</td><td>${f(j.mini[0])}</td><td>${f(j.maxi[0])}</td><td>${f(j.mini[1])}</td><td>${f(j.maxi[1])}</td></tr>`).join('')}</tbody></table>`;
  }

  // --- Appareil : alimentation, saison, santé, statistiques, notifications, entretien.
  function structureGeneral(s) {
    const g = generaux[s.id];
    let h = '';
    if (!g) {
      h += `<section class="carte"><div class="squelette-bloc" aria-busy="true"><span class="sr-only">${t('chargementReglages')}</span>
        <span class="os os-1"></span><span class="os os-3"></span><span class="os os-3"></span></div></section>`;
    } else {
      const champ = (id, etiquette, valeur, mode = 'decimal') =>
        `<div><label for="${id}">${etiquette}</label><input id="${id}" inputmode="${mode}" value="${attr(valeur)}"></div>`;
      h += `<form class="pile" data-form="generaux">
        <section class="carte">
          <h2>${t('alimentation')}</h2>
          <p class="aide">${t('aideAlim')}</p>
          <div class="rangee">
            ${champ('gA', t('courantDispo'), g.amperes)}
            ${champ('gW', t('puissanceTapis'), g.watts)}
            ${champ('gV', t('tension'), g.volts)}
          </div>
          <p class="aide">${t('zonesSimultanees', { n: g.zonesSimultanees })}</p>
        </section>
        <section class="carte">
          <h2>${t('cyclage')}</h2>
          <p class="aide">${t('aideCyclage')}</p>
          <label class="interrupteur mt" for="gSA">${t('cycleActif')}
            <input type="checkbox" id="gSA" role="switch"${g.saisonActive ? ' checked' : ''}></label>
          <div class="rangee">
            ${champ('gSD', t('abaissement'), g.saisonDelta)}
            ${champ('gS1', t('descente'), g.saisonDescenteJ, 'numeric')}
            ${champ('gS2', t('plateau'), g.saisonPlateauJ, 'numeric')}
            ${champ('gS3', t('remontee'), g.saisonRemonteeJ, 'numeric')}
          </div>
          <p class="aide">${g.saisonActive ? t('decalageApplique', { v: Number(g.decalageActuel).toFixed(2) }) : t('aucunDecalage')}</p>
          <button class="btn" type="submit">${t('enregistrer')}</button>
        </section>
      </form>`;
    }
    h += `<section class="carte" data-r="sante"></section>
      <section class="carte" data-r="maj"></section>
      <section class="carte" data-r="stats"></section>
      <section class="carte" data-r="notifs"></section>
      <section class="carte">
        <h2>${t('sauvegarde')}</h2>
        <p class="aide">${t('aideSauvegarde')}</p>
        <div class="boutons">
          <button type="button" class="btn btn-secondaire" data-action="exporterReglages">${t('exporterReglages')}</button>
          <button type="button" class="btn btn-secondaire" data-action="importerReglages">${t('importerReglages')}</button>
          <input type="file" id="fichier-reglages" accept="application/json,.json" hidden>
        </div>
      </section>
      <section class="carte">
        <h2>${t('entretienAppareil')}</h2>
        <p class="aide">${t('aideEntretienAppareil')}</p>
        <div class="boutons">
          <button type="button" class="btn btn-secondaire" data-action="redemarrer">${icone('i-power')}${t('redemarrerSocle')}</button>
          <button type="button" class="btn btn-danger" data-action="effacerHistorique">${icone('i-corbeille')}${t('effacerHistorique')}</button>
        </div>
        <button type="button" class="btn btn-danger btn-plein mt" data-action="retirerSocle">${t('retirerSocle')}</button>
      </section>`;
    return h;
  }

  const qualiteSignal = dbm => dbm >= -60 ? 'sigExcellent' : dbm >= -70 ? 'sigBon' : dbm >= -80 ? 'sigFaible' : 'sigTresFaible';
  const dureeLisible = s => {
    s = Math.max(0, Math.floor(s || 0));
    const j = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return j ? `${j} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  };

  function vivantSante(e) {
    const s = e.sante;
    const h = `<h2>${t('sante')}</h2>`;
    if (!s) return h + `<p class="aide">${t('santeInconnue')}</p>`;
    const rssi = typeof s.rssi === 'number' ? s.rssi : null;
    const barres = rssi === null ? 0 : rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
    return h + `<div class="stat">
      <div><b><span class="signal" aria-hidden="true">${[1, 2, 3, 4].map(n => `<i class="${n <= barres ? 'on' : ''}"></i>`).join('')}</span>${rssi === null ? t('inconnu') : t(qualiteSignal(rssi))}</b><span>${t('signalWifi')}${rssi === null ? '' : ` · ${rssi} dBm`}</span></div>
      <div><b>${s.heap !== undefined ? Math.round(s.heap / 1024) + ' Ko' : '—'}</b><span>${t('memoireLibre')}${s.blocMax ? ' · ' + t('plusGrandBloc', { b: Math.round(s.blocMax / 1024) }) : ''}</span></div>
      <div><b>${dureeLisible(s.uptime !== undefined ? s.uptime : e.uptime)}</b><span>${t('enService')}</span></div>
      <div><b>${esc(s.reset || '—')}</b><span>${t('dernierRedemarrage')}</span></div>
      ${s.version ? `<div><b>${esc(s.version)}</b><span>Firmware · ${t('protocole')} ${s.proto !== undefined ? esc(s.proto) : '?'}</span></div>` : ''}
      ${s.hote ? `<div><b class="mono">${esc(s.hote)}</b><span>${t('interfaceLocale')}${s.ip ? ` · ${esc(s.ip)}` : ''}</span></div>` : ''}
    </div>${s.otaEnAttente ? `<p class="aide mt"><span class="badge warn">${t('majValidation')}</span></p>` : ''}${s.maj && s.maj.etape && s.maj.etape !== 'aucune' ? `<p class="aide mt"><span class="badge ${s.maj.etape === 'validee' ? 'ok' : (s.maj.etape === 'echec' || s.maj.etape === 'retour arriere') ? 'ko' : 'warn'}">${t('majEtape_' + s.maj.etape.replace(/ /g, '_'))}</span> ${esc(s.maj.version || '')} — ${esc(s.maj.detail || '')}</p>` : ''}`;
  }

  // Mise à jour du firmware depuis l'application : la version publiée est celle
  // de la dernière release (version.json, écrit au déploiement) ; le socle la
  // télécharge lui-même, signature vérifiée, et revient en arrière tout seul si
  // elle plante avant validation.
  function vivantMaj(e) {
    const h = `<h2>${icone('i-maj')}${t('majTitre')}</h2>`;
    const dispo = versionApp && versionApp.firmware && versionApp.firmware.version;
    const actuelle = e.version || (e.sante && e.sante.version) || '';
    const enCours = e.majEnCours && e.majEnCours.etat === 'telechargement';
    if (enCours) {
      return h + `<p class="aide">${t('majTelechargement', { p: e.majEnCours.pct !== undefined ? e.majEnCours.pct : 0 })}</p>
        <progress class="progression" max="100" value="${+e.majEnCours.pct || 0}"></progress>`;
    }
    if (e.majEnCours && e.majEnCours.etat === 'redemarrage') return h + `<p class="aide">${t('majRedemarre')}</p>`;
    if (!dispo) return h + `<p class="aide">${t('majInconnue', { v: esc(actuelle || '?') })}</p>`;
    const plusRecente = compareVersions(dispo, actuelle) > 0;
    if (!plusRecente) return h + `<p class="aide">${t('majAJour', { v: esc(actuelle || '?') })}</p>`;
    return h + `<p class="aide">${t('majDisponible', { v: esc(dispo), a: esc(actuelle || '?') })}</p>
      <button type="button" class="btn mt" data-action="mettreAJour" data-version="${attr(dispo)}" ${e.enLigne ? '' : 'disabled'}>${icone('i-maj')}${t('majInstaller', { v: esc(dispo) })}</button>`;
  }
  function compareVersions(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  }

  function vivantStats(st) {
    let h = `<h2>${t('sur24h')}</h2>`;
    if (!st) return h + `<div class="squelette-bloc" aria-busy="true"><span class="sr-only">${t('chargementStats')}</span><span class="os os-3"></span><span class="os os-3"></span></div>`;
    (st.zones || []).forEach((z, i) => {
      const d = z.defauts || {};
      h += `<h3 class="titre-zone mt" data-zone="${i}">${esc(z.nom)}</h3>
        ${z.points ? `<div class="stat">
          <div><b>${fixe1(z.min)}</b><span>${t('minC')}</span></div>
          <div><b>${fixe1(z.max)}</b><span>${t('maxC')}</span></div>
          <div><b>${fixe1(z.moyenne)}</b><span>${t('moyenneC')}</span></div>
          <div><b>${z.horsPlagePct} %</b><span>${t('horsPlage')}</span></div>
          <div><b>${fixe1(z.heuresChauffe)} h</b><span>${t('deChauffe')}</span></div>
          <div><b>${Number(z.kWh).toFixed(2)} kWh</b><span>${t('consommes')}</span></div>
        </div>` : `<p class="aide">${t('pasAssezHist', { h: fixe1(z.heuresChauffe), k: Number(z.kWh).toFixed(2) })}</p>`}
        <p class="aide">${t('defautsCompte', { s: d.sonde || 0, c: d.surchauffe || 0, f: d.figee || 0 })}</p>`;
    });
    return h + `<p class="discret mt">${t('firmware', { v: esc(st.version) })}</p>`;
  }

  function vivantNotifications() {
    const n = etatNotifications();
    const cle = { granted: 'notifGranted', denied: 'notifDenied', indisponible: 'notifIndispo' }[n] || 'notifDefault';
    let h = `<h2>${t('notifications')}</h2><p class="aide">${t(cle)}</p>
      ${n === 'default' ? `<button type="button" class="btn btn-secondaire mt" data-action="notifications">${icone('i-cloche')}${t('activerNotifs')}</button>` : ''}`;
    if (serveur.actif() && config.serveur.push) {
      h += config.serveur.pushActif
        ? `<p class="aide mt"><span class="badge ok">${t('pushActif')}</span> ${t('pushActifTexte')}</p>`
        : `<p class="aide mt">${t('pushTexte')}</p><button type="button" class="btn btn-secondaire mt" data-action="activerPush">${icone('i-cloche')}${t('activerPush')}</button>`;
    }
    return h;
  }

  // ----------------------------------------------------------------- courbes
  // Les points arrivent en centièmes de degré, dans un tableau compact
  // [epoch, t1, consigne1, t2, consigne2] : une clé par valeur aurait triplé la
  // taille du message MQTT, dont le tampon n'est pas extensible.
  const couleurs = () => {
    const cs = getComputedStyle(doc.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return { zones: [v('--zone-1', '#d95f0a'), v('--zone-2', '#0b7fb9')],
             ligne: v('--ligne', '#e4e8ed'), texte: v('--texte-3', '#8a94a0') };
  };
  let traceCle = '';

  function pointsVisibles(id) {
    const c = courbes[id];
    const points = (c && c.points) || [];
    const z = zooms[id];
    return z ? points.filter(q => q[0] >= z.debut && q[0] <= z.fin) : points;
  }

  function tracerCourbes(id, force) {
    const c = courbes[id];
    const el = $('#courbe');
    if (!el) return;
    const points = pointsVisibles(id);
    const largeur = el.clientWidth || 720;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const z = zooms[id];
    const cle = `${id}|${c && c.heures}|${points.length}|${points.length ? points[points.length - 1][0] : 0}|${largeur}|${dpr}|${z ? z.debut + '-' + z.fin : ''}`;
    if (!force && cle === traceCle) return;
    traceCle = cle;

    const hauteur = largeur >= 700 ? 320 : 260;
    el.width = Math.round(largeur * dpr);
    el.height = Math.round(hauteur * dpr);
    const x = el.getContext('2d');
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, largeur, hauteur);
    if (!points.length) return;

    let lo = Infinity, hi = -Infinity;
    points.forEach(q => { for (let k = 1; k < q.length; k++) { const v = q[k]; if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } });
    if (!isFinite(lo) || !isFinite(hi)) return;
    lo /= 100; hi /= 100;
    // Graduations rondes (1, 2, 5 × 10ⁿ) avec un peu d'air au-dessus et en dessous.
    const brut = Math.max(0.1, (hi - lo) / 4.5);
    const mag = Math.pow(10, Math.floor(Math.log10(brut)));
    const pas = [1, 2, 5, 10].map(m => m * mag).find(p => p >= brut) || mag;
    lo = Math.floor((lo - pas * 0.3) / pas) * pas;
    hi = Math.ceil((hi + pas * 0.3) / pas) * pas;
    const decimales = pas < 1 ? 1 : 0;

    const col = couleurs();
    const G = { g: 36, d: 10, h: 12, b: 24 };
    const t0 = z ? z.debut : points[0][0], t1 = z ? z.fin : (points[points.length - 1][0] || t0 + 1);
    const X = t_ => G.g + (t_ - t0) / Math.max(1, t1 - t0) * (largeur - G.g - G.d);
    const Y = v => hauteur - G.b - (v - lo) / Math.max(0.1, hi - lo) * (hauteur - G.h - G.b);

    // Grille et axes
    x.font = '11px system-ui, -apple-system, sans-serif';
    x.textBaseline = 'middle';
    x.lineWidth = 1;
    for (let v = lo; v <= hi + pas / 1000; v += pas) {
      const y = Y(v);
      x.strokeStyle = col.ligne; x.beginPath(); x.moveTo(G.g, y); x.lineTo(largeur - G.d, y); x.stroke();
      x.fillStyle = col.texte; x.textAlign = 'right'; x.fillText(v.toFixed(decimales), G.g - 6, y);
    }
    const long = (t1 - t0) > 48 * 3600;
    x.textAlign = 'center';
    for (let k = 0; k <= 4; k++) {
      const t_ = t0 + (t1 - t0) * k / 4, d = new Date(t_ * 1000);
      const lib = long
        ? String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
        : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      x.fillStyle = col.texte;
      x.fillText(lib, Math.min(largeur - 22, Math.max(G.g + 16, X(t_))), hauteur - 10);
    }

    // Une courbe par zone : trait plein pour la mesure, pointillés pour la consigne.
    for (let zz = 0; zz < 2; zz++) {
      [[1 + zz * 2, false], [2 + zz * 2, true]].forEach((/** @type {[number, boolean]} */ [colonne, pointille]) => {
        x.strokeStyle = col.zones[zz];
        x.lineWidth = pointille ? 1.2 : 2.2;
        x.lineJoin = 'round'; x.lineCap = 'round';
        x.setLineDash(pointille ? [4, 5] : []);
        x.beginPath();
        let n = 0, dernier = null;
        points.forEach(q => {
          const v = q[colonne];
          if (v === null || v === undefined) { n = 0; return; }
          const px = X(q[0]), py = Y(v / 100);
          n++ ? x.lineTo(px, py) : x.moveTo(px, py);
          dernier = [px, py];
        });
        x.stroke();
        x.setLineDash([]);
        if (!pointille && dernier) {
          x.fillStyle = col.zones[zz];
          x.beginPath(); x.arc(dernier[0], dernier[1], 3.5, 0, Math.PI * 2); x.fill();
        }
      });
    }
  }

  // Zoom et déplacement : molette, glisser, pincement à deux doigts, double-clic
  // pour revenir à la vue entière. L'état est une fenêtre temporelle par socle.
  function brancherGestes(el, id) {
    if (!el || el.dataset.gestes === '1' || typeof window.PointerEvent !== 'function') return;
    el.dataset.gestes = '1';
    const G = 36, D = 10;
    const etendue = () => { const p = (courbes[id] && courbes[id].points) || []; return p.length ? [p[0][0], p[p.length - 1][0] || p[0][0] + 1] : null; };
    const fenetre = () => zooms[id] || (etendue() ? { debut: etendue()[0], fin: etendue()[1] } : null);
    const epochDe = px => { const f = fenetre(); if (!f) return 0; return f.debut + (px - G) / Math.max(1, el.clientWidth - G - D) * (f.fin - f.debut); };
    const appliquer = (debut, fin) => {
      const tout = etendue(); if (!tout) return;
      const largeurMin = 600;                                     // dix minutes au plus serré
      if (fin - debut < largeurMin) { const m = (debut + fin) / 2; debut = m - largeurMin / 2; fin = m + largeurMin / 2; }
      debut = Math.max(tout[0], debut); fin = Math.min(tout[1], fin);
      zooms[id] = (debut <= tout[0] && fin >= tout[1]) ? null : { debut: Math.round(debut), fin: Math.round(fin) };
      patcherCourbes(id);
    };
    const zoomer = (facteur, px) => {
      const f = fenetre(); if (!f) return;
      const pivot = epochDe(px);
      appliquer(pivot - (pivot - f.debut) * facteur, pivot + (f.fin - pivot) * facteur);
    };
    el.addEventListener('wheel', ev => { ev.preventDefault(); zoomer(ev.deltaY > 0 ? 1.25 : 0.8, ev.offsetX); }, { passive: false });
    el.addEventListener('dblclick', () => { zooms[id] = null; patcherCourbes(id); });
    const doigts = new Map();                                   // pointerId -> abscisse
    const ecartDoigts = () => { const v = [...doigts.values()]; return v.length === 2 ? Math.abs(v[0] - v[1]) : 0; };
    let glisse = null;
    el.addEventListener('pointerdown', ev => {
      doigts.set(ev.pointerId, ev.offsetX);
      if (doigts.size === 1) { glisse = { x: ev.offsetX, f: fenetre() }; try { el.setPointerCapture(ev.pointerId); } catch (e) { /* non supporté */ } }
      else glisse = null;
    });
    el.addEventListener('pointermove', ev => {
      if (!doigts.has(ev.pointerId)) return;
      const avant = ecartDoigts();
      doigts.set(ev.pointerId, ev.offsetX);
      if (doigts.size === 2) {
        const [a, b] = [...doigts.values()];
        const apres = Math.abs(a - b);
        if (avant > 10 && apres > 10) zoomer(avant / apres, (a + b) / 2);
      } else if (glisse && glisse.f) {
        const f = glisse.f;
        const decalage = (glisse.x - ev.offsetX) / Math.max(1, el.clientWidth - G - D) * (f.fin - f.debut);
        if (decalage !== 0) appliquer(f.debut + decalage, f.fin + decalage);
      }
    });
    const lever = ev => { doigts.delete(ev.pointerId); if (!doigts.size) glisse = null; };
    el.addEventListener('pointerup', lever); el.addEventListener('pointercancel', lever);
    el.style.touchAction = 'none';
  }

  // Le tracé suit la largeur réelle du canevas et le thème clair/sombre.
  function suivreRedimensionnement() {
    const redessiner = () => { if (vueCourante === 'socle' && panneauActif === 'courbes') tracerCourbes(socleOuvert, true); };
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(redessiner).observe(doc.body);
    } else {
      window.addEventListener('resize', redessiner);
    }
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) mq.addEventListener('change', redessiner);
    }
  }

  // ----------------------------------------------------- historique local
  // L'application note, au passage, une mesure par minute et par socle dans
  // IndexedDB : c'est ce qui permet des courbes sur 7 ou 30 jours, au-delà de
  // ce que la mémoire du socle conserve. Rien ne quitte l'appareil.
  const hist = (() => {
    const dispo = typeof indexedDB !== 'undefined';
    let promesse = null;
    const derniers = {};
    function ouvrir() {
      if (!dispo) return Promise.resolve(null);
      if (promesse) return promesse;
      promesse = new Promise(res => {
        let r;
        try { r = indexedDB.open('terrariums', 1); } catch (e) { res(null); return; }
        r.onupgradeneeded = () => {
          const st = r.result.createObjectStore('points', { keyPath: ['id', 'e'] });
          st.createIndex('id', 'id');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      });
      return promesse;
    }
    const centiemes = v => (v === undefined || v === null || isNaN(v)) ? null : Math.round(Number(v) * 100);
    function noter(id, e) {
      if (!dispo || !e.zones || !e.zones[0] || !e.zones[1]) return;
      const maintenant = Math.floor(Date.now() / 1000);
      if (derniers[id] && maintenant - derniers[id] < 60) return;
      derniers[id] = maintenant;
      const z = e.zones;
      const p = { id, e: maintenant,
        t1: z[0] && !z[0].defaut ? centiemes(z[0].temp) : null, c1: z[0] ? centiemes(z[0].consigne) : null,
        t2: z[1] && !z[1].defaut ? centiemes(z[1].temp) : null, c2: z[1] ? centiemes(z[1].consigne) : null };
      ouvrir().then(db => { if (!db) return; try { db.transaction('points', 'readwrite').objectStore('points').put(p); } catch (err) { /* quota */ } });
    }
    function lire(id, depuis) {
      return ouvrir().then(db => new Promise(res => {
        if (!db) { res([]); return; }
        const sortie = [];
        try {
          const req = db.transaction('points').objectStore('points').openCursor(IDBKeyRange.bound([id, depuis], [id, Infinity]));
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) { res(sortie); return; }
            const v = cur.value; sortie.push([v.e, v.t1, v.c1, v.t2, v.c2]); cur.continue();
          };
          req.onerror = () => res(sortie);
        } catch (err) { res(sortie); }
      }));
    }
    function effacer(id) {
      return ouvrir().then(db => { if (!db) return; try {
        db.transaction('points', 'readwrite').objectStore('points').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      } catch (err) { /* rien */ } });
    }
    function purger() {
      const limite = Math.floor(Date.now() / 1000) - 35 * 86400;
      ouvrir().then(db => { if (!db) return; try {
        const req = db.transaction('points', 'readwrite').objectStore('points').openCursor();
        req.onsuccess = () => { const cur = req.result; if (!cur) return; if (cur.value.e < limite) cur.delete(); cur.continue(); };
      } catch (err) { /* rien */ } });
    }
    return { disponible: () => dispo, noter, lire, effacer, purger };
  })();

  // Fusion des points du socle et des points locaux : le socle fait foi quand
  // les deux ont la même minute ; le reste comble les trous.
  function fusionner(socleP, localP, maxi) {
    const parMinute = new Map();
    localP.forEach(q => parMinute.set(Math.round(q[0] / 60), q));
    socleP.forEach(q => parMinute.set(Math.round(q[0] / 60), q));
    const tous = Array.from(parMinute.values()).sort((a, b) => a[0] - b[0]);
    if (tous.length <= maxi) return tous;
    const pas = tous.length / maxi;
    const sortie = [];
    for (let i = 0; i < maxi; i++) sortie.push(tous[Math.floor(i * pas)]);
    sortie[maxi - 1] = tous[tous.length - 1];
    return sortie;
  }

  // -------------------------------------------------------------- événements
  function brancher() {
    doc.addEventListener('click', ev => {
      const cible = /** @type {any} */ (ev.target);
      const el = cible && cible.closest ? cible.closest('[data-action],[data-dlg]') : null;
      if (!el) return;
      const d = el.dataset;
      if (d.dlg) { repondreConfirmation(d.dlg === 'oui'); return; }
      switch (d.action) {
        case 'ouvrir':            api.ouvrir(d.id); break;
        case 'montrer':           montrer(d.vue); break;
        case 'panneau':           api.panneau(d.nom); break;
        case 'courbes':           api.courbes(+d.heures); break;
        case 'zoomReinit':        zooms[socleOuvert] = null; patcherCourbes(socleOuvert); break;
        case 'exporterCsv':       api.exporterCsv(); break;
        case 'cmd':               api.action(d.cmd, d.params ? JSON.parse(d.params) : undefined); break;
        case 'mettreAJour':       api.mettreAJour(d.version); break;
        case 'scanner':           api.scanner(); break;
        case 'fermerScan':        fermerScanner(); break;
        case 'testerBroker':      api.testerBroker(); break;
        case 'oublierBroker':     api.oublierBroker(); break;
        case 'definirCode':       api.definirCode(); break;
        case 'activerPush':       api.activerPush(); break;
        case 'envoyerRapport':    api.envoyerRapport(); break;
        case 'retirerCode':       api.retirerCode(); break;
        case 'verrouiller':       api.verrouillerMaintenant(); break;
        case 'effacerTout':       api.effacerTout(); break;
        case 'retirerSocle':      api.retirerSocle(); break;
        case 'effacerHistorique': api.effacerHistorique(); break;
        case 'notifications':     api.activerNotifications(); break;
        case 'redemarrer':        api.redemarrer(); break;
        case 'exporterConfig':    api.exporterConfig(); break;
        case 'importerConfig':    { const f = $('#fichier-config'); if (f) f.click(); break; }
        case 'exporterReglages':  api.exporterReglages(); break;
        case 'importerReglages':  { const f = $('#fichier-reglages'); if (f) f.click(); break; }
        case 'installer':         api.installer(); break;
        case 'diagnostic':        api.diagnostic(); break;
        case 'fermerDiag':        fermerDialogue($('#diag')); break;
        case 'copierRapport':     api.copierRapport(); break;
      }
    });
    // Les cartes de socle sont des boutons : clavier compris.
    doc.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = /** @type {any} */ (ev.target);
      if (el && el.getAttribute && el.getAttribute('role') === 'button' && el.dataset.action) {
        ev.preventDefault(); el.click();
      }
    });
    doc.addEventListener('submit', ev => {
      const f = /** @type {any} */ (ev.target);
      if (!f || !f.dataset || !f.dataset.form) return;
      ev.preventDefault();
      switch (f.dataset.form) {
        case 'broker':       api.enregistrerBroker(); break;
        case 'socle':        api.ajouterSocle(); break;
        case 'zone':         api.reglerZone(+f.dataset.z); break;
        case 'zone-complet': api.reglerZoneComplet(+f.dataset.z); break;
        case 'generaux':     api.reglerGeneraux(); break;
        case 'verrou':       api.deverrouiller(); break;
      }
    });
    doc.addEventListener('change', ev => {
      const el = /** @type {any} */ (ev.target);
      if (!el || !el.id) return;
      if (el.id === 'fichier-config' && el.files && el.files[0]) { api.importerConfig(el.files[0]); el.value = ''; }
      if (el.id === 'verrou-min') api.changerVerrouMin(el.value);
      if (el.id === 'fichier-reglages' && el.files && el.files[0]) { api.importerReglages(el.files[0]); el.value = ''; }
      if (el.id === 'langue' || el.id === 'langue-liste') api.changerLangue(el.value);
    });
    // Au retour sur l'application, l'état affiché peut dater : on le redemande.
    doc.addEventListener('visibilitychange', () => {
      if (doc.hidden) { cacheDepuis = Date.now(); return; }
      // Verrouillage automatique : l'application est restée cachée plus longtemps
      // que le délai choisi. La liaison au broker reste ouverte : les alertes
      // continuent d'arriver derrière l'écran de code.
      const minutes = verrouMinutes();
      if (codeVerrouActif() && !verrouille && minutes > 0 && cacheDepuis && Date.now() - cacheDepuis > minutes * 60000) verrouiller();
      if (client && client.connected)
        config.socles.forEach(s => commander(s.id, 'etat').catch(() => {}));
    });
    // Les erreurs imprévues sont notées pour le rapport de diagnostic : un bug
    // qu'on ne voit pas ne se corrige pas.
    window.addEventListener('error', ev => noterErreur((ev.message || 'erreur') + (ev.filename ? ` (${String(ev.filename).split('/').pop()}:${ev.lineno})` : '')));
    window.addEventListener('unhandledrejection', ev => {
      const r = /** @type {any} */ (ev).reason;
      noterErreur('promesse : ' + (r && r.message ? r.message : String(r)));
    });
    // Installation : le navigateur ne propose la bannière qu'à ses conditions ;
    // on garde l'événement pour l'offrir derrière un bouton, au bon moment.
    window.addEventListener('beforeinstallprompt', ev => {
      ev.preventDefault();
      evenementInstall = ev;
      doc.querySelectorAll('[data-action="installer"]').forEach((/** @type {any} */ b) => { b.hidden = false; });
    });
    window.addEventListener('appinstalled', () => {
      evenementInstall = null;
      doc.querySelectorAll('[data-action="installer"]').forEach((/** @type {any} */ b) => { b.hidden = true; });
      message(t('installee'));
    });
    // Les durées relatives (« silencieux depuis 3 min ») vieillissent sans message.
    setInterval(invalider, 30000);
  }

  // -------------------------------------------------------- agent de service
  // La coque est servie depuis le cache, donc l'application s'ouvre instantanément ;
  // quand une nouvelle version est prête, on la propose au lieu de l'imposer au
  // milieu d'un réglage. Le rechargement n'a lieu qu'après le clic.
  function enregistrerAgent() {
    if (!navigator.serviceWorker || window.isSecureContext === false) return;
    const proposer = reg => message(t('nouvelleVersion'), false, {
      libelle: t('recharger'),
      faire: () => { if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING'); else location.reload(); }
    });
    navigator.serviceWorker.register(/** @type {any} */ (urlScript('sw.js'))).then(reg => {
      const suivre = w => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) proposer(reg);
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) proposer(reg);
      suivre(reg.installing);
      reg.addEventListener('updatefound', () => suivre(reg.installing));
    }).catch(() => {});
    let recharge = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!recharge) { recharge = true; location.reload(); }
    });
  }

  function chargerVersion() {
    if (typeof fetch !== 'function' || location.protocol === 'file:') return;
    try {
      fetch('version.json', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(v => { if (v && v.version) { versionApp = v; peindreVersion(); } })
        .catch(() => {});
    } catch (e) { /* file:// ou hors ligne */ }
  }

  // ----------------------------------------------------------------- scanner
  let fluxCamera = null;
  function fermerScanner() {
    if (fluxCamera) { fluxCamera.getTracks().forEach(t_ => t_.stop()); fluxCamera = null; }
    const dlg = $('#scan');
    if (dlg && dlg.open) dlg.close();
  }

  // -------------------------------------------------------------- diagnostic
  function rapportDiagnostic() {
    const nav = /** @type {any} */ (navigator);
    const standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
    const l = [];
    l.push(`Terrariums — ${t('diagnostic')} — ${new Date().toISOString()}`);
    l.push(`${t('application')} : ${versionApp ? `v${versionApp.version} (${versionApp.commit || '?'}, ${versionApp.date || '?'})` : t('versionDev')} · ${t('protocole')} ${PROTO_APP} · ${standalone ? t('installeeOui') : t('installeeNon')} · ${langue}`);
    l.push(`${t('navigateur')} : ${nav.userAgent} · ${nav.onLine === false ? t('horsLigne') : t('enLigne')} · ${window.innerWidth}×${window.innerHeight}`);
    l.push(`${t('cacheSw')} : ${nav.serviceWorker && nav.serviceWorker.controller ? 'actif' : 'absent'}`);
    l.push(`${t('serveur')} : ${serveur.actif() ? `${serveur.origine()} (${config.serveur.login || '?'}${config.serveur.pushActif ? ', push' : ''})` : t('aucun')}`);
    let hote = t('aucun');
    if (config.broker && config.broker.url) { try { hote = new URL(config.broker.url).host; } catch (e) { hote = '?'; } }
    l.push(`Broker : ${hote} · ${($('#lien') || {}).textContent || ''}`);
    l.push(`${t('socles')} : ${config.socles.length || t('aucun')}`);
    config.socles.forEach(s => {
      const e = etats[s.id] || {};
      const h = e.sante || {};
      const age = e.derniereMaj ? Math.round((Date.now() - e.derniereMaj) / 1000) : null;
      l.push(`  - ${s.id} (${s.nom || ''}) : ${e.enLigne ? t('enLigne') : t('horsLigne')} · ${age === null ? t('jamais') : t('derniereMesure', { s: age })}` +
        ` · firmware ${e.version || h.version || '?'} · proto ${e.proto !== undefined ? e.proto : '?'} · rssi ${h.rssi !== undefined ? h.rssi + ' dBm' : '?'}` +
        ` · heap ${h.heap !== undefined ? Math.round(h.heap / 1024) + ' Ko' : '?'}${h.heapMin !== undefined ? ' (min ' + Math.round(h.heapMin / 1024) + ' Ko)' : ''}` +
        ` · uptime ${dureeLisible(h.uptime !== undefined ? h.uptime : e.uptime)} · reset ${h.reset || '?'}` +
        ` · zones ${(e.zones || []).map(z => z ? (z.defaut ? 'DEFAUT:' + z.defaut : (z.temp !== undefined ? Number(z.temp).toFixed(1) + '°C' : '?')) : '?').join(' / ')}`);
    });
    l.push(`${t('erreursRecentes')} : ${erreurs.length ? '' : t('aucuneErreur')}`);
    erreurs.slice(-15).forEach(e => l.push(`  ${e.quand}  ${e.texte}`));
    return l.join('\n');
  }

  // ----------------------------------------------------------------- actions
  const api = {
    demarrer() {
      choisirLangue();
      traduirePage();
      charger();
      brancher();
      suivreRedimensionnement();
      hist.purger();
      doc.querySelectorAll('#langue, #langue-liste').forEach(s => { /** @type {any} */ (s).value = langue; });
      enregistrerAgent();
      chargerVersion();
      if (!('BarcodeDetector' in window)) $('#btn-scan').hidden = true;
      if (verrouille) {
        // Configuration chiffrée : rien ne démarre avant le code.
        lien(t('verrouillee'), 'ko');
        montrer('verrou');
        setTimeout(() => { try { $('#code-verrou').focus(); } catch (e) { /* hors écran */ } }, 50);
        return;
      }
      api.lancerSession();
    },

    // Ce qui suit le chargement (ou le déverrouillage) de la configuration.
    lancerSession() {
      if (config.broker && config.broker.url) {
        // Le formulaire reste pré-rempli pour « Changer de broker ».
        $('#b-url').value = config.broker.url;
        $('#b-user').value = config.broker.user || '';
        $('#b-prefixe').value = config.broker.prefixe || 'terrarium';
        if (!client) connecter();
        montrer('liste');
      } else {
        lien(t('nonConnecte'), 'ko');
        montrer('broker');
      }
      // Raccourcis du manifeste : ouvrir directement le scanner ou le diagnostic.
      const h = location.hash;
      if (h === '#scanner' || h === '#diagnostic') {
        try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// */ }
        setTimeout(() => (h === '#scanner' ? api.scanner() : api.diagnostic()), 300);
      }
    },

    montrer,

    // Pour les bancs d'essai : injecte un version.json (version publiée du
    // firmware) sans passer par le réseau.
    _versionPubliee(v) { versionApp = v; peindreVersion(); },

    changerLangue(l) {
      if (l !== 'fr' && l !== 'en') return;
      try { localStorage.setItem(CLE_LANGUE, l); } catch (e) { /* stockage indisponible */ }
      location.reload();
    },

    enregistrerBroker() {
      const url = $('#b-url').value.trim();
      // ws:// n'est toléré qu'en développement local : sur un vrai réseau, une
      // liaison non chiffrée exposerait les codes d'appairage en clair.
      const local = ['localhost', '127.0.0.1'].includes(location.hostname);
      if (!/^wss:\/\//.test(url) && !(local && /^ws:\/\//.test(url))) {
        message(t('wssRequis'), true);
        return;
      }
      config.broker = {
        url,
        user: $('#b-user').value.trim(),
        pass: $('#b-pass').value,
        prefixe: ($('#b-prefixe').value.trim() || 'terrarium')
      };
      config.serveur = null;          // un autre broker : le serveur est à redétecter
      sauver();
      connecter();
      montrer('liste');
    },

    // Essai de connexion sans rien enregistrer : on sait tout de suite si
    // l'adresse et les identifiants sont bons, au lieu de le découvrir à la liste.
    testerBroker() {
      const url = $('#b-url').value.trim();
      const local = ['localhost', '127.0.0.1'].includes(location.hostname);
      if (!/^wss:\/\//.test(url) && !(local && /^ws:\/\//.test(url))) { message(t('wssRequis'), true); return; }
      message(t('testEnCours'), false, undefined, 10000);
      const debut = Date.now();
      let fini = false;
      const essai = mqtt.connect(url, optionsClient({ user: $('#b-user').value.trim(), pass: $('#b-pass').value }));
      const terminer = (ok, m) => {
        if (fini) return;
        fini = true;
        try { essai.end(); } catch (e) { /* déjà fermé */ }
        message(ok ? t('testOk', { ms: Date.now() - debut }) : t('testKo', { m }), !ok);
      };
      essai.on('connect', () => terminer(true));
      essai.on('error', e => terminer(false, e.message));
      setTimeout(() => terminer(false, t('pasDeReponse')), 9000);
    },

    // ---- code de verrouillage --------------------------------------------------
    async deverrouiller() {
      const champ = $('#code-verrou'), err = $('#verrou-erreur');
      const code = (champ.value || '').trim();
      if (!code) return;
      if (!cryptoDispo()) { texte(err, t('cryptoIndispo')); return; }
      champ.disabled = true;
      try {
        const cle = await deriverCle(code, deB64(enveloppe.sel));
        const cfg = await dechiffrerConfig(cle, enveloppe);
        cleVerrou = cle;
        config = cfg;
        if (!Array.isArray(config.socles)) config.socles = [];
        verrouille = false;
        echecsCode = 0;
        champ.value = '';
        texte(err, '');
        if (client && client.connected) montrer(socleOuvert ? 'socle' : 'liste');
        else api.lancerSession();
      } catch (e) {
        echecsCode++;
        // Après trois erreurs, chaque essai attend un peu plus : 2, 4, 8… s,
        // plafonné — PBKDF2 ralentit déjà, ceci décourage la force brute.
        const attente = echecsCode > 3 ? Math.min(30, 2 ** (echecsCode - 3)) : 0;
        texte(err, attente ? t('codeFauxAttente', { s: attente }) : t('codeFaux'));
        champ.value = '';
        await new Promise(r => setTimeout(r, attente * 1000));
      }
      champ.disabled = false;
      try { champ.focus(); } catch (e) { /* hors écran */ }
    },

    async definirCode() {
      if (!cryptoDispo()) { message(t('cryptoIndispo'), true); return; }
      const code = await demanderCode();
      if (code === null) return;
      try {
        const sel = aleatoire(16);
        cleVerrou = await deriverCle(code, sel);
        enveloppe = { chiffre: true, sel: b64(sel), iv: '', donnees: '', iterations: PBKDF2_ITERATIONS };
        enveloppe = await chiffrerConfig();
        localStorage.setItem(CLE_CONFIG, JSON.stringify(enveloppe));
        message(t('codeDefini'));
      } catch (e) { enveloppe = null; cleVerrou = null; message(t('codeImpossible', { m: e.message }), true); }
      dessiner();
    },

    async retirerCode() {
      if (!await confirmer({ titre: t('retirerCodeQ'), texte: t('retirerCodeTexte'), ok: t('retirer'), danger: true })) return;
      enveloppe = null; cleVerrou = null;
      sauver();
      message(t('codeRetire'));
      dessiner();
    },

    verrouillerMaintenant() { verrouiller(); },

    changerVerrouMin(v) {
      try { localStorage.setItem(CLE_VERROU_MIN, String(parseInt(v, 10) || 0)); } catch (e) { /* stockage indisponible */ }
    },

    // Code oublié : il n'existe aucun moyen de le retrouver, c'est le principe.
    // On repart de zéro ; les codes d'appairage sont sur les socles.
    async effacerTout() {
      if (!await confirmer({ titre: t('effacerToutQ'), texte: t('effacerToutTexte'), ok: t('effacerTout'), danger: true })) return;
      try { localStorage.removeItem(CLE_CONFIG); } catch (e) { /* stockage indisponible */ }
      hist.toutEffacer && hist.toutEffacer();
      location.reload();
    },

    async activerPush() {
      try { await serveur.activerPush(); message(t('pushActive')); dessiner(); }
      catch (e) { message(t('pushRefuse', { m: e.message }), true); }
    },

    async revendiquer(id) {
      const s = socle(id);
      if (!s || !serveur.actif()) return;
      try { await serveur.revendiquer(id, s.jeton); abonner(s); commander(id, 'etat').catch(() => {}); message(t('socleRattache')); }
      catch (e) { message(t('rattachementRefuse', { m: e.message }), true); }
    },

    async envoyerRapport() {
      try { const d = await serveur.appel('POST', '/api/rapports', rapportDiagnostic()); message(t('rapportEnvoye', { f: d.fichier || '' })); }
      catch (e) { message(t('rapportNonEnvoye', { m: e.message }), true); }
    },

    async oublierBroker() {
      if (!await confirmer({ titre: t('oublierBrokerQ'), texte: t('oublierBrokerTexte'), ok: t('oublier'), danger: true })) return;
      config.broker = null;
      config.serveur = null;
      sauver();
      if (client) { client.end(true); client = null; }
      lien(t('nonConnecte'), 'ko');
      montrer('broker');
    },

    ajouterSocle() {
      const id = $('#a-id').value.trim();
      const jeton = $('#a-jeton').value.trim().replace(/[\s-]/g, '').toUpperCase();
      const nom = $('#a-nom').value.trim();
      if (!id) { message(t('idManquant'), true); return; }
      if (jeton.length !== 24) { message(t('jeton24'), true); return; }
      if (socle(id)) { message(t('dejaEnregistre'), true); return; }

      const s = { id, jeton, nom: nom || id };
      config.socles.push(s);
      sauver();
      if (serveur.actif()) {
        // Le broker n'accepte l'abonnement qu'une fois le socle rattaché au compte.
        serveur.revendiquer(id, jeton).then(() => { abonner(s); commander(id, 'etat').catch(() => {}); message(t('socleRattache')); })
          .catch(e => message(t('rattachementRefuse', { m: e.message }), true, { libelle: t('reessayer'), faire: () => api.revendiquer(id) }));
      }
      abonner(s);
      commander(id, 'etat').catch(() => {});
      ['#a-id', '#a-jeton', '#a-nom'].forEach(sel => { $(sel).value = ''; });
      message(t('socleAjoute'));
      dessiner();
    },

    // Retrait immédiat, annulable pendant quelques secondes : pas de question
    // préalable, le geste se défait au lieu de se confirmer.
    retirerSocle() {
      const id = socleOuvert;
      const s = socle(id);
      if (!id || !s) return;
      const index = config.socles.indexOf(s);
      // Se désabonner aussi : sans cela, le broker continuait d'envoyer l'état
      // d'un socle retiré, qui réapparaissait dans les notifications.
      if (client && client.connected && config.broker) {
        try { client.unsubscribe(sujets(id)); } catch (e) { /* déjà parti */ }
      }
      const sauvegarde = { etat: etats[id], courbes: courbes[id], stats: stats[id], generaux: generaux[id], alertes: alertesVues[id] };
      [etats, courbes, stats, generaux, alertesVues].forEach(o => { delete o[id]; });
      config.socles = config.socles.filter(x => x.id !== id);
      sauver();
      socleOuvert = null;
      montrer('liste');
      majBadge();
      message(t('socleRetire'), false, { libelle: t('annuler'), faire: () => {
        if (socle(id)) return;
        config.socles.splice(Math.min(index, config.socles.length), 0, s);
        sauver();
        if (sauvegarde.etat) etats[id] = sauvegarde.etat;
        if (sauvegarde.alertes) alertesVues[id] = sauvegarde.alertes;
        abonner(s);
        commander(id, 'etat').catch(() => {});
        dessiner();
      } }, 7000);
    },

    ouvrir(id) {
      socleOuvert = id;
      panneauActif = 'etat';
      $('#detail').dataset.socle = '';          // ossature reconstruite à chaque ouverture
      montrer('socle');
      const titre = $('#detail h2');
      if (titre) titre.focus();
      commander(id, 'etat').catch(() => {});
    },

    // Change de panneau et charge ce qui lui manque. Rien n'est demandé au socle
    // avant d'en avoir besoin : chaque requête traverse le broker, et un socle
    // hors ligne ne répondra de toute façon pas.
    panneau(nom) {
      panneauActif = nom;
      dessiner();
      const id = socleOuvert;
      if (!id) return;
      if (nom === 'courbes' && !courbes[id]) api.courbes(24);
      if (nom === 'general') {
        if (!generaux[id]) commander(id, 'globaux').then(r => { generaux[id] = r; dessiner(); }).catch(() => {});
        if (!stats[id])    commander(id, 'stats').then(r => { stats[id] = r; dessiner(); }).catch(() => {});
      }
    },

    async courbes(heures) {
      const id = socleOuvert;
      if (!id) return;
      zooms[id] = null;
      courbes[id] = { heures, chargement: true, points: (courbes[id] || {}).points };
      dessiner();
      // Jusqu'à 24 h : le socle seul, précis. Au-delà : ses points plus ceux que
      // l'application a enregistrés, fusionnés par minute.
      const socleSeul = heures <= 24 || !hist.disponible();
      let points = [], erreur = null;
      try {
        const r = await commander(id, 'historique', { heures: Math.min(heures, 400), max: socleSeul ? 120 : 200 });
        points = r.points || [];
      } catch (e) {
        erreur = e.message;
      }
      if (!socleSeul) {
        const locaux = await hist.lire(id, Math.floor(Date.now() / 1000) - heures * 3600).catch(() => []);
        points = fusionner(points, locaux, 600);
        if (points.length) erreur = null;
      }
      // Le serveur a tout vu, application fermée comprise : ses points
      // comblent les trous, au pas adapté à la fenêtre.
      if (serveur.actif() && heures > 6) {
        const maintenant = Math.floor(Date.now() / 1000);
        const distants = await serveur.historique(id, maintenant - heures * 3600, maintenant, Math.max(60, Math.round(heures * 3600 / 600))).catch(() => []);
        if (distants.length) { points = fusionner(points, distants, 600); erreur = null; }
      }
      if (socleOuvert !== id || !courbes[id] || courbes[id].heures !== heures) return;   // l'utilisateur a changé d'avis
      courbes[id] = erreur ? { heures, points: [], erreur } : { heures, points };
      dessiner();
    },

    exporterCsv() {
      const id = socleOuvert;
      const points = pointsVisibles(id);
      if (!id || !points.length) return;
      const s = socle(id) || { nom: id };
      const f = v => (v === null || v === undefined) ? '' : (v / 100).toFixed(2);
      const lignes = ['epoch,date,zone1_temp,zone1_consigne,zone2_temp,zone2_consigne'];
      points.forEach(q => {
        const d = new Date(q[0] * 1000);
        const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
          ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        lignes.push([q[0], date, f(q[1]), f(q[2]), f(q[3]), f(q[4])].join(','));
      });
      telecharger(`courbes-${String(s.nom || id).replace(/[^\w-]+/g, '_')}-${(courbes[id] || {}).heures || 24}h.csv`,
                  lignes.join('\n') + '\n', 'text/csv;charset=utf-8');
    },

    async activerNotifications() {
      if (!notificationsPossibles()) { message(t('notifsIndispoPage'), true); return; }
      try {
        const r = await Notification.requestPermission();
        message(r === 'granted' ? t('notifsActivees') : t('notifsRefusees'), r !== 'granted');
      } catch (e) { message(t('notifsIndispo2', { m: e.message }), true); }
      dessiner();
    },

    async effacerHistorique() {
      if (!await confirmer({ titre: t('effacerHistQ'), texte: t('effacerHistTexte'), ok: t('effacer'), danger: true })) return;
      try {
        await commander(socleOuvert, 'effacer-historique');
        hist.effacer(socleOuvert);
        delete courbes[socleOuvert];
        zooms[socleOuvert] = null;
        message(t('histEfface'));
        dessiner();
      } catch (e) { message(e.message, true); }
    },

    // Mise à jour tirée par le socle (release GitHub). La réponse arrive tout de
    // suite ; la progression suit sur le sujet « maj », puis le socle redémarre
    // et sa santé dit si l'image a été validée.
    async mettreAJour(version) {
      if (!version) return;
      if (!await confirmer({ titre: t('majQ', { v: version }), texte: t('majTexte'), ok: t('majOk') })) return;
      const e = etats[socleOuvert] || (etats[socleOuvert] = { enLigne: false, zones: [] });
      try {
        await commander(socleOuvert, 'maj', { version });
        e.majEnCours = { etat: 'telechargement', pct: 0 };
        message(t('majLancee'));
        dessiner();
      } catch (err) { message(t('majRefusee', { m: err.message }), true); }
    },

    async redemarrer() {
      if (!await confirmer({ titre: t('redemarrerQ'), texte: t('redemarrerTexte'), ok: t('redemarrer') })) return;
      api.action('redemarrer');
    },

    // Enregistre TOUS les réglages d'une zone d'un coup. Les champs laissés
    // vides ne sont pas envoyés : « vide » veut dire « inchangé », jamais zéro.
    async reglerZoneComplet(i) {
      const params = { z: i };
      const nom = /** @type {HTMLInputElement|null} */ (doc.getElementById('N' + i));
      if (nom && nom.value.trim()) params.nom = nom.value.trim();
      const champs = { j: 'jour', n: 'nuit', R: 'rampe', b: 'bande', m: 'max', o: 'offset' };
      for (const [id, cle] of Object.entries(champs)) {
        const v = champNombre(id + i);
        if (v !== undefined) params[cle] = cle === 'rampe' ? Math.round(v) : v;
      }
      for (const [id, cle] of [['H', 'debutJour'], ['K', 'debutNuit']]) {
        const el = /** @type {HTMLInputElement|null} */ (doc.getElementById(id + i));
        if (!el || el.value.trim() === '') continue;
        const m = depuisHHMM(el.value);
        if (m === null) { message(t('horaireInvalide', { v: el.value }), true); return; }
        params[cle] = m;
      }
      try {
        await commander(socleOuvert, 'zone', params);
        message(t('reglagesEnregistres'));
        commander(socleOuvert, 'etat').catch(() => {});
      } catch (e) { message(e.message, true); }
    },

    async reglerGeneraux() {
      const params = {};
      for (const [id, cle] of [['gA', 'amperes'], ['gW', 'watts'], ['gV', 'volts'], ['gSD', 'saisonDelta']]) {
        const v = champNombre(id);
        if (v !== undefined) params[cle] = v;
      }
      for (const [id, cle] of [['gS1', 'saisonDescenteJ'], ['gS2', 'saisonPlateauJ'], ['gS3', 'saisonRemonteeJ']]) {
        const v = champNombre(id);
        if (v !== undefined) params[cle] = Math.round(v);
      }
      const sa = /** @type {HTMLInputElement|null} */ (doc.getElementById('gSA'));
      if (sa) params.saisonActive = !!sa.checked;
      try {
        const r = await commander(socleOuvert, 'globaux', params);
        generaux[socleOuvert] = r;
        message(t('enregistreZones', { n: r.zonesSimultanees }));
        dessiner();
      } catch (e) { message(e.message, true); }
    },

    async reglerZone(i) {
      const params = { z: i };
      const jour = champNombre('j' + i), nuit = champNombre('n' + i);
      if (jour !== undefined) params.jour = jour;
      if (nuit !== undefined) params.nuit = nuit;
      try {
        await commander(socleOuvert, 'zone', params);
        message(t('reglagesEnregistres'));
      } catch (e) {
        // Le message vient du socle lui-même : il connaît ses propres limites.
        message(e.message, true);
      }
    },

    async action(nom, params) {
      try {
        const r = await commander(socleOuvert, nom, params);
        message(r.zonesSimultanees ? t('enregistreZones', { n: r.zonesSimultanees }) : t('commandeAcceptee'));
        setTimeout(() => commander(socleOuvert, 'etat').catch(() => {}), 800);
      } catch (e) {
        message(e.message, true);
      }
    },

    // ---- sauvegardes ---------------------------------------------------------
    async exporterConfig() {
      if (!await confirmer({ titre: t('exportConfigQ'), texte: t('exportConfigTexte'), ok: t('exporter') })) return;
      telecharger('terrariums-configuration.json',
        JSON.stringify({ format: 'terrariums-config', version: 1, broker: config.broker, socles: config.socles }, null, 2) + '\n',
        'application/json');
    },

    async importerConfig(fichier) {
      let d;
      try { d = JSON.parse(await lireFichier(fichier)); } catch (e) { message(t('importInvalide'), true); return; }
      if (!d || d.format !== 'terrariums-config' || !Array.isArray(d.socles)) { message(t('importInvalide'), true); return; }
      let n = 0;
      d.socles.forEach(s => {
        if (!s || typeof s.id !== 'string' || typeof s.jeton !== 'string' || s.jeton.length !== 24 || socle(s.id)) return;
        const nouveau = { id: s.id, jeton: s.jeton.toUpperCase(), nom: String(s.nom || s.id) };
        config.socles.push(nouveau); abonner(nouveau); n++;
      });
      if (d.broker && d.broker.url && !config.broker) config.broker = { url: d.broker.url, user: d.broker.user || '', pass: d.broker.pass || '', prefixe: d.broker.prefixe || 'terrarium' };
      sauver();
      message(n ? t('importOk', { n }) : t('importRien'), !n);
      if (config.broker && !client) { connecter(); montrer('liste'); }
      config.socles.forEach(s => commander(s.id, 'etat').catch(() => {}));
      dessiner();
    },

    exporterReglages() {
      const id = socleOuvert;
      const e = etats[id];
      if (!id || !e || !e.zones) return;
      const zones = e.zones.map(z => z ? { nom: z.nom, jour: z.jour, nuit: z.nuit, bande: z.bande, max: z.max, offset: z.offset,
        rampe: z.rampe, debutJour: z.debutJour, debutNuit: z.debutNuit } : null);
      const g = generaux[id];
      const generauxExport = g ? { amperes: g.amperes, watts: g.watts, volts: g.volts, entretienMin: g.entretienMin, ecranVeilleMin: g.ecranVeilleMin,
        saisonActive: g.saisonActive, saisonDelta: g.saisonDelta, saisonDescenteJ: g.saisonDescenteJ, saisonPlateauJ: g.saisonPlateauJ, saisonRemonteeJ: g.saisonRemonteeJ } : undefined;
      telecharger(`reglages-${id}.json`,
        JSON.stringify({ format: 'terrariums-reglages', version: 1, socle: id, date: new Date().toISOString(), zones, generaux: generauxExport }, null, 2) + '\n',
        'application/json');
    },

    async importerReglages(fichier) {
      const id = socleOuvert;
      let d;
      try { d = JSON.parse(await lireFichier(fichier)); } catch (e) { message(t('importInvalide'), true); return; }
      if (!id || !d || d.format !== 'terrariums-reglages' || !Array.isArray(d.zones)) { message(t('importInvalide'), true); return; }
      try {
        for (let i = 0; i < d.zones.length && i < 2; i++) {
          const z = d.zones[i];
          if (!z) continue;
          const params = { z: i };
          ['nom', 'jour', 'nuit', 'bande', 'max', 'offset', 'rampe', 'debutJour', 'debutNuit'].forEach(k => { if (z[k] !== undefined && z[k] !== null) params[k] = z[k]; });
          await commander(id, 'zone', params);
        }
        if (d.generaux && typeof d.generaux === 'object') {
          const r = await commander(id, 'globaux', d.generaux);
          generaux[id] = r;
        }
        message(t('importReglagesOk'));
        commander(id, 'etat').catch(() => {});
        dessiner();
      } catch (e) { message(t('importReglagesKo', { m: e.message }), true); }
    },

    // ---- installation et diagnostic ----------------------------------------
    async installer() {
      if (!evenementInstall) { message(t('installIos')); return; }
      try { evenementInstall.prompt(); await evenementInstall.userChoice; } catch (e) { /* refusé */ }
      evenementInstall = null;
      doc.querySelectorAll('[data-action="installer"]').forEach((/** @type {any} */ b) => { b.hidden = true; });
    },

    diagnostic() {
      let dlg = $('#diag');
      if (!dlg) {
        dlg = doc.createElement('dialog');
        dlg.id = 'diag'; dlg.className = 'feuille large';
        html(dlg, `<h2>${t('diagnostic')}</h2><p class="aide">${t('aideDiag')}</p>
          <pre id="diag-texte" class="rapport" tabindex="0"></pre>
          <div class="boutons fin"><button type="button" class="btn btn-secondaire" data-action="fermerDiag">${t('fermer')}</button>
          <button type="button" class="btn btn-secondaire" data-action="envoyerRapport" id="btn-envoyer-rapport">${t('envoyerRapport')}</button>
          <button type="button" class="btn" data-action="copierRapport">${t('copierRapport')}</button></div>`);
        doc.body.appendChild(dlg);
      }
      texte($('#diag-texte'), rapportDiagnostic());
      const envoyer = $('#btn-envoyer-rapport'); if (envoyer) envoyer.hidden = !serveur.actif();
      ouvrirDialogue(dlg);
    },

    async copierRapport() {
      const texteRapport = ($('#diag-texte') || {}).textContent || rapportDiagnostic();
      const nav = /** @type {any} */ (navigator);
      try {
        if (nav.clipboard && nav.clipboard.writeText) { await nav.clipboard.writeText(texteRapport); message(t('rapportCopie')); return; }
      } catch (e) { /* refus : on tente l'ancienne méthode */ }
      try {
        const ta = doc.createElement('textarea');
        ta.value = texteRapport; doc.body.appendChild(ta); ta.select();
        const ok = doc.execCommand && doc.execCommand('copy');
        ta.remove();
        message(ok ? t('rapportCopie') : t('copieImpossible'), !ok);
      } catch (e) { message(t('copieImpossible'), true); }
    },

    rapport: rapportDiagnostic,

    // Lecture du QR code collé sous le socle (ou affiché sur son écran), quand
    // le navigateur sait le faire.
    async scanner() {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
        message(t('qrIndispo'), true); return;
      }
      let dlg = $('#scan');
      if (!dlg) {
        dlg = doc.createElement('dialog');
        dlg.id = 'scan'; dlg.className = 'scan';
        html(dlg, `<video playsinline muted autoplay></video>
          <p class="aide mt">${t('viserQr')}</p>
          <button type="button" class="btn btn-secondaire btn-plein mt" data-action="fermerScan">${t('cancel')}</button>`);
        dlg.addEventListener('close', fermerScanner);
        doc.body.appendChild(dlg);
      }
      try {
        fluxCamera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = dlg.querySelector('video');
        video.srcObject = fluxCamera;
        dlg.showModal();
        await video.play();
        const Detecteur = /** @type {any} */ (window).BarcodeDetector;
        const detecteur = new Detecteur({ formats: ['qr_code'] });
        const fin = Date.now() + 30000;
        const boucle = async () => {
          if (!fluxCamera) return;
          if (Date.now() > fin) { fermerScanner(); message(t('aucunQr'), true); return; }
          const codes = await detecteur.detect(video).catch(() => []);
          if (codes.length) {
            fermerScanner();
            // Format : terrarium:<id>:<jeton>. L'écran du socle l'affiche en
            // majuscules (QR alphanumérique, plus petit) : l'identifiant retrouve
            // sa casse « terraXXXXXX ».
            const m = /^terrarium:([^:]+):([A-Z0-9]{24})$/i.exec(codes[0].rawValue || '');
            if (!m) { message(t('qrNonReconnu'), true); return; }
            let id = m[1];
            if (/^TERRA[0-9A-F]{6}$/.test(id)) id = 'terra' + id.slice(5);
            $('#a-id').value = id; $('#a-jeton').value = m[2].toUpperCase();
            $('#a-nom').focus();
            message(t('codeLu'));
            return;
          }
          requestAnimationFrame(boucle);
        };
        boucle();
      } catch (e) {
        fermerScanner();
        message(t('cameraIndispo', { m: e.message }), true);
      }
    }
  };

  return api;
})();

window.addEventListener('load', () => App.demarrer());
