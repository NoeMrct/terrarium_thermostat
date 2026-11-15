# Journal des versions

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
numéro de version suit [SemVer](https://semver.org/lang/fr/). Le numéro est
celui du firmware (`FW_VERSION`) ; l'application est publiée en continu et
affiche le commit dont elle est issue.

## [Non publié]

Firmware 3.5.0 (`FW_VERSION`). Le binaire ne tient plus dans les emplacements
de 1,5 Mo des socles flashés avant la 3.4.0 : ceux-là se reflashent une fois
par câble (la mise à jour à distance refuse le binaire sans rien casser). Les
réglages persistés s'enrichissent par la fin : rien n'est perdu à la mise à
jour.

### Ajouté
- **Chaque écran a son adresse** (U8, B10) : `#/<socle>`, `#/<socle>/<rubrique>`
  ou `#/<socle>/zone/<n>`. Le retour du téléphone ferme la feuille ouverte au
  lieu de quitter l'application, un rechargement rouvre le même écran, et une
  notification touchée ouvre son socle (application ouverte ou non ;
  verrouillée, l'écran attend le code). Remonter avec le bouton de
  l'application revient dans l'historique au lieu d'y empiler un écran.
- **Réglages de l'application** (`#/reglages`), sous la liste des socles : le
  compte, la langue, le **thème** (clair, sombre ou celui du téléphone), la
  configuration de l'appli, la connexion, le code de verrouillage, l'aide, le
  diagnostic et « Tout effacer ». Le pied de la liste, où tout s'empilait,
  disparaît.
- **Organiser mes socles** (U9) : ordre (flèches, le focus suit le socle),
  noms modifiables sur place, **groupes** nommés (un socle monté ou descendu
  au bord d'un groupe passe dans le voisin ; un groupe vide se supprime),
  **vue compacte** de la liste (une ligne par socle : état, nom, deux
  températures) et **actions groupées** (entretien 30 min, lever les défauts)
  sur les socles cochés, avec le compte de ceux qui ont confirmé.
- **Exports** (F16, F17, `#/reglages/exports`, aussi depuis les Courbes) :
  le **carnet du mois** en PDF (en cours ou le précédent) — résumé par zone
  (températures, consignes, chauffe, coût, jours en défaut), courbes jour par
  jour (min-max, moyenne, consignes), consommation, alertes du journal et
  tableau jour par jour —, écrit dans la page par un générateur PDF sans
  bibliothèque ; et **toutes les mesures** en CSV : 30 jours à 5 minutes, ou
  un an (à 5 minutes avec le serveur Terrariums, sinon un résumé par jour).
  Partage par la feuille du téléphone quand le navigateur sait passer un
  fichier, sinon enregistrement.
- **Carnet par e-mail** (F16, serveur Terrariums avec SMTP) : le 1er de chaque
  mois à partir de 8 h (fuseau `TZ`), un résumé du mois écoulé pour tous les
  socles du compte — moyenne et extrêmes datés de chaque zone, temps à ±1 °C
  de la consigne, jours avec des mesures, alertes vues par le serveur. Du
  texte seul, sans lien de suivi. L'interrupteur est dans Exports ; à
  l'activation, le carnet du mois écoulé part tout de suite. Un envoi refusé
  est retenté trois fois dans le mois ; un serveur arrêté le 1er envoie à son
  redémarrage. Routes `GET|POST /api/moi/carnet`, préférence dans l'export du
  compte et au journal d'audit.
- **Plages horaires** (F5) : jusqu'à quatre plages par jour (début, nom, une
  consigne par zone) à la place du jour et de la nuit, les mêmes tous les
  jours ou un jeu pour le week-end ; la plus fraîche compte comme la nuit
  (écran atténué, journal, hiver). Nouvelle action `programme` (lecture ou
  écriture du programme entier, validé : débuts à 15 min d'écart, consignes
  sous la coupure), gardé en mémoire non volatile ; l'état de chaque zone dit
  la consigne suivante, son heure, la période et la plage en cours
  (`suivante`, `suivanteA`, `periode`, `plage`). Dans l'application,
  **Programmation** s'ouvre sur la journée en cours et sa frise des 24 h, et
  la feuille **Plages et saisons** (`#/<socle>/plages`) liste les plages,
  chacune modifiable dans sa boîte ; l'écran d'une zone montre la consigne de
  la plage en cours et renvoie vers les plages.
- **Mode vacances** (F6) : dates de départ et de retour, consignes habituelles
  ou abaissées, dérive annoncée dès 2 °C d'écart ; le socle bascule seul et
  revient seul (`globaux` : `vacancesDebut`, `vacancesFin`,
  `vacancesDecalage`, `vacancesAlertes`). Feuille **Mode vacances**
  (`#/<socle>/vacances`), bandeau sur l'accueil du socle, et « Vacances… »
  dans Organiser pour plusieurs socles à la fois.
- **Préchauffage** (F7) : chaque zone apprend sa vitesse de montée ; une
  consigne plus haute est prise assez tôt pour être atteinte à l'heure dite
  (3 h d'avance au plus), la dérive restant mesurée à la consigne de l'heure.
- **Saisons du calendrier** (F9) : de `hiverDebut` à `hiverFin`, consignes
  abaissées et journée raccourcie (moitié le matin, moitié le soir), avec un
  passage progressif ; un exemple dans l'application dit ce que devient la
  journée au milieu de l'hiver. S'ajoute au cyclage saisonnier existant.
- Journal : changements de plage, plages modifiées, début et fin des
  vacances, lus en phrases par l'application.
- **Notifications lisibles** (U35) : le titre d'une notification du serveur
  est le nom que chacun donne au socle dans son application (envoyé au
  serveur par l'application, `POST /api/moi/noms`), le corps une phrase :
  « Zone fraîche sans mesure : chauffe coupée par sécurité. Touche pour
  dépanner. » Le carnet par e-mail reprend ces noms.
- **Délai de grâce hors ligne** (U34) : un socle qui quitte le broker n'est
  notifié qu'au bout de 5 minutes (`DELAI_HORS_LIGNE_MIN`) ; revenu avant,
  rien ne part ; notifié, son retour en ligne l'est aussi.
- **Aide dans l'application** : « Aide et notice » cherche dans la notice,
  même hors ligne (index `app/aide-index.json` construit avec elle, mis en
  cache), et mène au diagnostic, au dépannage, aux questions fréquentes et,
  avec le serveur, au support.
- **Partager un socle** (F12, U4, serveur Terrariums) : dans les réglages de
  l'application, un lien d'invitation à usage unique (48 h), en « Lecture
  seule » (voir, être prévenu) ou « Peut régler » (consignes et horaires, le
  code du socle voyageant dans la partie `#` du lien, jamais vers le
  serveur), jusqu'à une date ou sans fin ; qui a accès, invitations en
  attente, retrait d'un geste. L'invité ouvre le lien, se connecte ou crée
  son compte, et le socle apparaît chez lui ; en lecture seule, les
  rubriques de réglage sont grisées et le broker ne laisse passer que des
  lectures. Le dernier titulaire parti, les invités perdent l'accès.
- **Alertes du socle en un geste** (U31) et **alerte de test** (F18) : dans
  la rubrique Alertes, « Alerte envoyée par le socle » tire au sort un sujet
  ntfy privé, le donne au socle (format texte) et montre comment y abonner
  le téléphone ; le sujet n'est gardé que sur ce téléphone. « Envoyer une
  alerte de test » la fait partir du socle par son adresse d'alerte
  (`reseau` `essai`, nouvelle alerte de type `ESSAI`), et une notification
  d'essai du serveur s'il y en a un. La rubrique dit aussi les alertes en
  cours.
- **Alimentation verrouillée** (U20) : la rubrique Sécurité montre le bloc
  (« Bloc 12 V · 3 A ») et dit si deux tapis peuvent chauffer ensemble ou à
  tour de rôle ; elle ne se modifie plus que dans Service, après
  confirmation de ce que cela permet.
- Firmware : `jours` se lit par pages (`depuis`, la réponse donne `total`) et
  `historique` par fenêtres plus anciennes (`decalage`, en heures) : un mois
  de résumés ou quatorze jours de mesures fines passent le broker message par
  message.
- **Copier des réglages** (U18, U19, `#/reglages/transfert`) : d'un socle à
  l'autre, ou depuis un fichier, par familles (consignes et coupure,
  horaires et rampe, alertes et rapport). Un aperçu avant/après ne montre que
  ce qui change (une même modification des deux zones en une ligne) ; une
  zone de la cible en défaut reste telle quelle ; « Annuler » remet les
  valeurs d'avant. L'**export** est un fichier chiffré par un mot de passe
  (AES-GCM, clé dérivée par PBKDF2) ; l'**import** accepte aussi les anciens
  exports en clair et la sauvegarde de la page locale du socle. La carte
  Sauvegarde de la rubrique Appareil y mène, ce socle en source.
- **Socle hors ligne, sans écran vide** (U26) : l'application garde sur
  l'appareil le dernier état connu de chaque socle, daté (« relevé à 14:12 »,
  « hors ligne depuis hier 22:05 ») ; il s'affiche dès l'ouverture, avant même
  la connexion au broker. Jamais quand la configuration est verrouillée par un
  code. L'accueil d'un socle muet le dit en clair : il continue de réguler seul
  (coupure de sécurité comprise), trois vérifications à faire, « Réessayer »
  qui dit ce qu'il en est, la page locale du socle ; ses rubriques et
  commandes qui exigent une réponse sont grisées (« Réglable au retour du
  socle ») et un message signale son retour.
- **Retours d'envoi** (U10, U40, U11) : « Envoi au socle… » dès l'appui,
  formulaire grisé pendant l'envoi (pas de double envoi), confirmation quand
  le socle a répondu — pas avant. Sans réponse : « Réessayer », la saisie est
  gardée ; refusé pour cause d'entretien : « Quitter l'entretien ». Sans
  réseau, l'envoi attend le retour de la connexion, annulable.
- **Journal du socle** (F4), nouvelle rubrique : ce qui s'est passé, jour par
  jour, en phrases — alertes et retours à la normale, réglages modifiés
  (depuis l'application ou la page locale), passages en jour et en nuit (les
  deux zones à la même minute en une entrée), coupures de courant, accès du
  support, mises à jour ; filtres Alertes, Réglages, Socle. Le firmware
  étiquette désormais ses lignes d'alerte (`[TROP_CHAUD z1] …`) et note les
  passages en jour et en nuit (`[PERIODE z1] Passage en nuit, consigne 26.0
  C`) ; une ligne non reconnue s'affiche telle quelle.
- **Consommation et coût** (F3, F2), nouvelle rubrique : dépense depuis le 1er
  du mois en euros et en kWh, projection sur le mois et l'année, barres par
  jour (aujourd'hui en cours), moyenne par tapis, le socle lui-même (estimation
  fixe de 0,5 W), rapport d'hier tiré du dernier résumé, prix du kWh réglable
  sur place. L'action `jours` donne en plus la journée en cours
  (`aujourdhui`, zone par zone depuis minuit).
- **Sondes sûres.** Chaque zone suit l'adresse de sa sonde et une sonde n'est
  jamais liée à deux zones. Plus de repli sur « la n-ième sonde du bus » : une
  zone sans sonde liée reste en défaut SONDE, chauffe coupée. La liaison
  automatique n'a lieu que sans ambiguïté (premier démarrage, ou une seule zone
  libre, une seule sonde orpheline et toutes les autres présentes). `scan` et
  « Relire le bus » relisent vraiment le bus, et il est relu de lui-même toutes
  les 5 min tant qu'une zone n'a pas de mesure.
- **Assistant d'identification** (`identifier <z>`, bouton « Identifier ») :
  le chauffage est suspendu, on serre la sonde voulue dans la main et le socle
  la lie à la zone (2 min au plus).
- **Contrôle croisé « sondes inversées »** : après 6 min de chauffe effective,
  si la sonde de la zone ne bouge pas alors que celle d'une autre zone monte,
  les deux zones passent en défaut CHAUFFE SANS EFFET, avec la raison dans le
  journal et l'alerte. Une chauffe qui ne fait rien monter du tout reste une
  simple alerte.
- **Essai de chauffe guidé** (`essai <z>`, page locale) : la zone chauffe seule
  10 min au plus, sécurités actives, avec un verdict (sa sonde a pris 0,5 °C,
  une autre a monté à sa place, ou rien n'a bougé).
- **Calibration côte à côte** (`calibrer`) : sondes posées ensemble, les
  décalages des autres zones sont alignés sur la zone 1.
- **Valeurs aberrantes filtrées** : un saut de plus de 4 °C entre deux lectures
  n'est retenu qu'après trois confirmations.
- **Alerte « trop chaud »** : une zone au-dessus de sa consigne, au-delà du seuil
  de dérive et pendant sa durée, alors qu'elle ne chauffe pas (canicule, lampe)
  est signalée : alerte urgente, marqueur à l'écran, champ `tropChaud` dans
  l'état.
- **Diagnostic sans câble.** Bouton BOOT : appui court, page suivante de
  l'écran (zones, courbes des 6 dernières heures, réseau, sondes, système) ;
  3 s, QR d'appairage ; 10 s, point
  d'accès de configuration. LED bleue, de la plus importante à la plus banale :
  défaut, identification ou essai, point d'accès, Wi-Fi absent, MQTT refusé,
  tout va bien (`led off` l'éteint). Ligne d'état en bas de l'écran.
- **Écran** : flèches de tendance, atténué la nuit (`ecran nuit
  <attenue|normal|eteint>`), messages temporaires.
- **Rapport quotidien** (`rapport <HH:MM>`, page locale) : températures sur
  24 h, heures de chauffe, kWh, coût et défauts, vers l'URL d'alerte (priorité
  basse pour ntfy) et le sujet MQTT `rapport`.
- **Coût en euros** (`prix <€/kWh>`) dans `stats`, la page locale et le rapport.
- **Résumés journaliers sur un an** (`jours [n]`, `/api/jours`, tableau de
  l'onglet Appareil).
- **Jour et nuit calés sur le soleil** (`soleil <lat> <lon> [décalage]`) : lever
  et coucher recalculés chaque jour à la place des horaires fixes.
- **Zone prioritaire** (`priorite <z>`) : quand l'alimentation ne suffit pas aux
  deux tapis, elle reçoit la plus grande part du temps de chauffe.
- **Wi-Fi de secours** (`wifi2 <ssid> [mdp]`, onglet Réseau), essayé en
  alternance quand le premier ne répond pas.
- **Sauvegarde et restauration de la configuration** (`/api/sauvegarde`,
  onglet Appareil) : zones, réglages, sondes liées, alertes ; tout ou rien ;
  jamais de mot de passe dans le fichier.
- **Alertes de démarrage** : durée d'une coupure de courant (en fourchette) au
  retour de l'heure, trois redémarrages anormaux de suite, mémoire fragmentée.
- Santé : `mqtt` (état de la connexion au broker) et `webProtege` ; la page
  locale avertit quand elle n'a pas de mot de passe.
- Application : un conseil sous chaque défaut, marqueur « trop chaud ».
- **Installation guidée d'un socle** dans l'application, en trois étapes :
  l'étiquette (scan, ou saisie de la référence et du code), le Wi-Fi (nom du
  réseau du socle, puis suivi en direct : Wi-Fi rejoint avec son signal,
  serveur joint, heure réglée, code vérifié ou socle relié au compte), les
  réglages de départ (nom, consignes jour et nuit et noms des zones, horaires
  fixes ou soleil). « C'est prêt » montre les premières minutes et propose les
  alertes. Un mauvais code ramène à l'étiquette, un socle qui n'arrive pas
  donne les causes habituelles, une relance de l'application reprend l'étape
  en cours (sans jamais garder le code ailleurs que dans la configuration).
- **Écran d'accueil** de l'application au premier lancement : se connecter à
  son serveur, essayer la démo, ou « chez moi seulement » (la page locale).
- **Étiquette à lien** (`qr-appairage.js --url`, `provisionner.js --url`) :
  le QR porte `https://<application>/#a/<id>/<code>`, que l'appareil photo de
  n'importe quel téléphone ouvre ; l'installation démarre remplie, et le
  fragment (jamais envoyé à un serveur) est effacé de l'adresse aussitôt. Le
  scanner de l'application lit les deux formats.
- **Portail captif du socle** : en point d'accès, la page qui s'ouvre seule
  liste les réseaux que voit le socle ; il essaie celui choisi sans bloquer,
  dit pourquoi la box refuse (mot de passe, réseau introuvable ou en 5 GHz,
  pas de réponse) et redémarre dessus. L'interface complète passe à
  `/interface` (et reste `/` hors point d'accès).
- **Page locale aux couleurs de l'application** (I7) : fond blanc, cartes sans
  ombre, commandes noires, onglets segmentés, zones en orange et bleu,
  températures en grands chiffres fins à la française (« 30,6° »), bandeau
  « PAGE LOCALE · sans Internet ». Sombre automatique, comme l'application.
- **Atelier** (`atelier.html`, `docs/atelier.md`) : montage en série dans le
  navigateur, par lots. Console série (USB) : identité, `test usine`, mot de
  passe de la page locale tiré dans le navigateur, Wi-Fi du banc, compte
  d'appareil sur le serveur Terrariums ou broker de l'atelier. Banc (MQTT,
  commandes signées) : sondes identifiées à la main, essai de chauffe de
  chaque zone, rodage qui note coupures, défauts et redémarrages et conclut sur
  la durée de marche du socle. Étiquette : identité relue avant impression,
  Wi-Fi du banc oublié, historique vidé, QR à lien encodé dans le navigateur
  (`qr.js`), impression à 62 mm ; à l'expédition, code et mot de passe
  effacés de l'atelier. Mise de côté avec raison, registre CSV sans secret.
- **Comptes en libre-service** sur le serveur Terrariums (V2, V3) : un code à
  six chiffres par e-mail ouvre le compte (SMTP au choix : `SMTP_URL`), puis
  des **clés d'accès** (passkeys, WebAuthn vérifié par le serveur sans
  dépendance) ; plus de mot de passe à retenir. Export du compte en JSON sans
  secret (RGPD, art. 20) et effacement par son titulaire, historique des socles
  orphelins compris (art. 17). Sessions glissantes (30 jours sans usage), et
  plus aucun jeton de session en clair sur le disque (empreintes SHA-256,
  anciennes sessions migrées). Limites : trois codes par adresse et dix par IP
  et par quart d'heure, cinq essais par code.
- Application : **connexion par e-mail et clé d'accès**. L'adresse `https://`
  d'un serveur Terrariums suffit : e-mail, code à six chiffres, puis clé
  d'accès proposée ; « Mon compte » liste les clés, exporte les données et
  supprime le compte ; une session expirée ramène à l'écran de connexion,
  adresse remplie. Le jeton de session est le mot de passe du broker. Testé de
  bout en bout dans Chromium avec un authentificateur virtuel
  (`test-compte`).
- **Console d'administration** du serveur (V6), sur `/console/` : tableau de
  bord de la flotte (en ligne, en défaut, mises à jour en échec, plantages,
  versions), fiche de chaque socle (santé publiée, zones, courbe des 24 heures,
  propriétaires, compte d'appareil), comptes (création, droits, « déconnecter
  partout », mot de passe réinitialisé et montré une fois, retrait d'une clé
  d'accès, export RGPD, effacement), comptes d'appareil, rapports de
  diagnostic, journal. Connexion par compte administrateur (mot de passe, code
  par e-mail, clé d'accès) ou `ADMIN_JETON` ; données personnelles masquées par
  défaut ; référence à taper pour les gestes lourds ; politique de sécurité
  stricte (Trusted Types, même origine). `node serveur.js utilisateur admin
  <login> oui|non`.
- **Assistance à distance (V11)**. Firmware : action `service` (protocole 4) —
  le propriétaire ouvre au support une session de 24 h par une clé tirée dans
  l'application (le code d'appairage ne quitte pas le téléphone) ; tant
  qu'elle vaut, les commandes signées avec elle sont acceptées, notées
  « Support : … » au journal du socle, l'écran affiche « Support connecté » ;
  prolongation bornée à 7 jours, fermeture par le propriétaire (application ou
  page locale, `DELETE /api/service`) ou le support, retrait à l'échéance ;
  rien sans heure fiable. Serveur : demandes (messages, notes internes,
  statut, gravité, responsable), accès prouvé puis gardé le temps voulu,
  diagnostics signés par la clé et audités avec leurs valeurs, copie des
  réglages et « tout remettre », transfert vers un socle de remplacement, rôle
  `support`, frise de chaque socle (événements vus par le serveur, gestes,
  messages), alertes proactives. Console : onglet **Support**. Application :
  carte **Assistance** de l'onglet Service (écrire, lire les réponses,
  autoriser, refuser, fermer), notification d'une demande d'accès. Testé par
  `test-protocole.cpp` (98), `test/support.test.js` et `test-support.js`
  (application, console et socle simulé ensemble, axe-core).
- **Mises à jour automatiques (F15)**, activées d'origine : chaque jour le socle
  lit le manifeste de la dernière release (`terrarium-version.json`), annonce
  une fois la nouvelle version (alerte `MAJ`, notification du serveur), puis
  l'installe seul la nuit (03:00-05:00 par défaut, réglable), jamais pendant
  un défaut, un autotune, un essai, un entretien ou un accès support ; une
  tentative par nuit, trois au plus ; une version revenue en arrière n'est plus
  jamais installée seule ; installation réussie annoncée après sa validation.
  Seulement avec des images signées (clé compilée). Coupables, reportables
  (1 à 30 jours), vérifiables à la demande : réglages `majAuto`,
  `majPlageDebut`, `majPlageFin` de `globaux`, action `majauto` (protocole 4),
  carte de l'application, onglet Réseau de la page locale (`/api/majauto`),
  console `maj auto|plage|reporter|verifier`, résumé `majAuto` dans `sante`,
  fiche de la console d'administration.
- **Déploiement progressif (V9)** : chaque socle tire un rang stable de son
  identifiant ; le jour *d*, une version est ouverte à (*d* + 1) / (jours + 1)
  des socles (7 jours, 2 pour un correctif de sécurité). Workflow
  « Déploiement du firmware » : `pause`, `reprendre`, `tous`, `etaler`.
  `outils/manifeste-version.js` écrit le manifeste à la publication.
- **Anti-retour de version (S4)** : une version plus ancienne est refusée par
  les chemins distants, même avec `forcer` (qui ne sert plus qu'à réinstaller
  la même) — version visée ou étiquette de l'URL, puis en-tête de l'image lu
  avant le moindre octet écrit. Chaque image porte désormais sa version et son
  projet dans son descripteur d'application (`version_image.cpp`), lisibles
  aussi par esptool. La page locale admet un retour arrière sur une case
  cochée par le propriétaire.
- **Signature exigée, côté outillage (S5)** : `signer-firmware.js
  --generer-cles … --config config.h` écrit la clé publique dans `config.h`
  (format clang-format), refuse d'écrire la clé privée dans le dépôt et
  n'écrase jamais une clé ; `--etat` dit si une clé est compilée ; le
  workflow de publication s'arrête si la clé est compilée sans le secret et
  vérifie l'image signée contre `config.h`. Avec une clé compilée, ArduinoOTA
  (qui ne vérifie aucune signature) reste coupée. La paire reste à créer par
  le mainteneur (docs/publication.md).
- **Journal d'audit chaîné** du serveur (`donnees/audit/`, 12 mois) : gestes de
  l'administration et des titulaires, comptes sous référence pseudonyme, jamais
  un secret ; ligne modifiée, retirée ou insérée détectée, fin coupée notée
  (`node serveur.js audit verifier`). Testé par `test-console` (contrôles
  dans Chromium, axe-core en clair et en sombre) et `test/admin.test.js`.
- Console : `wifi off` oublie le réseau enregistré (point d'accès de
  configuration au démarrage suivant), pour qu'un socle rodé à l'atelier ne
  cherche pas le Wi-Fi du banc chez l'acheteur.
- Tests : `test-atelier` (console et banc simulés, signatures vérifiées, du
  nouveau socle à l'expédition, échecs compris), l'atelier dans `axe` à chaque
  étape ; le socle simulé termine désormais identification et essai de chauffe
  avec les textes du firmware.
- Tests : banc `test-majauto` (versions, en-tête d'image, remorque de
  signature, manifeste, déploiement, décision condition par condition, trois
  nuits minute par minute), fuzzing du manifeste et des en-têtes, migration
  des réglages (`ReglagesGlobaux` passe à 68 octets), protocole (PC et socle
  simulé), page locale, application et serveur.
- Tests : bancs `test-liaisons` et `test-soleil`, scénarios 21 à 28 du
  simulateur (sondes inversées, couplage légitime, pic isolé, canicule,
  priorité, essai de chauffe, soleil), fuzzing des liaisons et du soleil, tests
  de la page locale pour chaque nouveauté.
- **Console support — réponses types** : textes partagés par l'équipe, classés
  par usage, insérés depuis la fiche d'une demande avec leurs variables
  remplies (nom du terrarium, référence, zone et défaut, heure du défaut tirée
  de la frise, fin de l'accès, version, signal) ; une variable inconnue reste
  à compléter. Six réponses de départ, modifiables depuis l'onglet Support.
- **Console support — relances programmées** : un rappel pour l'équipe (« à
  faire » dans la fiche, la file et le tableau de bord), ou un message qui
  part au client à l'échéance s'il n'a pas répondu entre-temps. Journal
  d'audit pour chaque geste ; tests serveur et de bout en bout
  (`test-support.js`).
- **Console — schéma du câblage en direct** (fiche d'un socle) : bloc 12 V et
  courant mesuré (INA219), convertisseur, ESP32 et son signal, bilames, tapis
  qui chauffent, MOSFET D16/D17 et leurs commandes, sondes du bus D4 avec leur
  température. Selon le défaut publié, les organes à vérifier d'abord passent
  en rouge (sonde muette ou figée ; MOSFET resté passant ou sonde mal placée ;
  bilame ouvert, tapis coupé ou MOSFET mort) ; la même chose en texte dessous,
  pour les lecteurs d'écran. Rafraîchi avec la fiche.

### Modifié
- **Application : plus rien de technique pour un client.**
  - Accueil : « Se connecter » mène droit au compte (e-mail et code, clé
    d'accès) sur le serveur de l'application — fixé au déploiement par la
    balise `<meta name="terrarium-serveur">`, ou celui qui sert l'application
    (`SERVIR_APP=1`) ; sans lui, son adresse, l'identifiant et le mot de
    passe. Le formulaire du broker (adresse `wss://`, préfixe, « Tester la
    connexion ») n'existe plus qu'à l'adresse `#/technique`, pour le support
    et le développement. « Diagnostic » et « Flasher un socle » quittent
    l'accueil et l'aide.
  - Retirés : export et import de la configuration de l'application ;
    diagnostic de l'application (dialogue, envoi du rapport, raccourci du
    manifeste) ; section « Connexion » des réglages (gardée pour l'équipe) ;
    rubrique Consommation, prix du kWh dans Appareil, montants en euros du
    carnet PDF et du CSV (un prix fixe n'a pas de sens avec un contrat
    dynamique ; l'énergie en kWh reste).
  - Réservés à l'équipe (compte support ou administrateur du serveur, ou
    connexion directe au broker) : alerte de test, bloc Alimentation de la
    rubrique Sécurité, santé du socle dans Appareil, outils de l'onglet
    Service (sondes, essai, surveillance, alimentation, rapport, journal,
    résumés, sauvegarde). Un client n'y trouve que la demande d'aide — même
    socle hors ligne — et l'accès du support. Le serveur donne le rôle
    (`equipe` dans `/api/moi` et les réponses de session) ; la démonstration
    montre la vue d'un client.
  - Aide : un guide en dix sections pour les utilisateurs (`docs/guide.md`,
    en anglais `docs/guide.en.md`) remplace la notice technique dans
    l'application (8 Ko au lieu de 34) ; nouvelles questions fréquentes
    (« une zone affiche un défaut », « mon socle ne répond plus »). La notice
    (`docs/manuel.md`) reste dans le dépôt pour le support et l'atelier.
- **Le chauffage continue pendant une mise à jour** (W2). La boucle principale
  ne tourne plus pendant qu'une image s'écrit : chaque bloc reçu
  (téléchargement depuis les releases, envoi par l'interface locale,
  ArduinoOTA) fait désormais un tour de régulation — mesures, sécurités,
  tapis, courant —, au lieu de couper le chauffage pendant tout le flux (une
  minute environ, la nuit pour les mises à jour automatiques). Seules les
  étapes qui ne rendent pas la main le coupent encore : connexion au serveur,
  vérification de l'image entière, redémarrage — quelques secondes. Les textes
  de l'application, de l'interface locale et de la notice suivent ;
  l'application garde l'ancien avertissement pour un socle d'avant la 3.5.0.
- Console : `mqtt off` oublie aussi l'utilisateur, le mot de passe et le
  chiffrement du broker (ils restaient en mémoire).
- Application : l'anglais vit dans `textes.en.js`, importé au démarrage
  seulement quand il sert (et gardé hors ligne par l'agent de service). Tout le
  monde télécharge 4 Ko de moins : `app.js` passe de 30,0 à 26,0 Ko compressés.
  Le budget de poids sépare désormais le démarrage des modules à la demande.
- **Application redessinée** (I12, d'après les maquettes) : fond blanc, grands
  chiffres fins (police Inter, licence OFL, hébergée avec l'application),
  noir pour les commandes, orange et bleu réservés aux deux zones ; thème
  sombre automatique conservé. Chaque socle a un **accueil** : le terrarium
  dessiné de trois quarts, dont les zones s'éclairent quand elles chauffent
  (et se cerclent de rouge en défaut), une ligne d'état (« Tout va bien · jour
  jusqu'à 20:00 »), les deux zones en grand, quatre boutons ronds (Entretien,
  Lever les défauts, Alertes, Mises à jour) et huit **rubriques** qui
  s'ouvrent en feuilles : Températures, Programmation, Courbes, Alertes,
  Sécurité, Appareil, Service, Mises à jour. Un appui sur une zone ouvre son
  **écran façon climatisation** : la cible en grand, réglée par chevrons de
  0,5 °C et envoyée une seconde après le dernier appui, le choix jour ou nuit,
  le prochain basculement. La liste montre une vignette du terrarium par
  socle et un bandeau quand l'un d'eux demande l'attention ; l'ajout d'un
  socle passe derrière un bouton « + ». Échap referme une feuille, et le
  focus revient d'où l'on venait. Températures à la française (« 30,6° »).
- Le budget de poids de l'application ne fait plus échouer la CI :
  `outils/budget.js` affiche les tailles pour information, et Lighthouse
  (performance ≥ 90) reste le garde-fou du chargement.
- **Onglet Service dans l'application** (firmware 3.5) : sondes (inventaire,
  liaison, identification suivie en direct), essai de chauffe et calibration
  avec confirmation, rapport du jour, journal, résumés journaliers en tableau,
  alertes et surveillance (seul le serveur des adresses s'affiche ; une adresse
  enregistrée quitte aussitôt le champ), sauvegarde du socle à télécharger ou
  restaurer. C'est un module à part (`service.js`, 6 Ko compressés), importé à
  la première ouverture de l'onglet et gardé hors ligne par l'agent de
  service : le démarrage n'en paie rien. La démonstration le montre, avec un
  socle simulé en protocole 4.
- **Réglages 3.5 dans l'onglet Appareil** : prix du kWh, écran la nuit, zone
  prioritaire, LED, rapport quotidien et son heure, jour et nuit au soleil
  (position, décalage) ; affichés seulement si le socle les rend.
- **À distance (protocole 4).** L'application peut faire ce que seule la page
  locale savait faire : inventaire et liaison des sondes, assistant
  d'identification, essai de chauffe, calibration, rapport du jour (lu ou
  envoyé), journal, résumés journaliers, sauvegarde et restauration,
  surveillance (adresses d'alerte et de heartbeat), et les réglages 3.5 de
  `globaux` (prix du kWh, écran la nuit, LED, soleil, zone prioritaire,
  rapport). Rien de secret ne revient par le broker : le Wi-Fi reste réglable
  sur la page locale seulement, une adresse d'alerte s'écrit mais seul son
  hôte se relit, et la sauvegarde envoyée par le broker omet ces adresses
  (restaurée, elle garde celles du socle). Les résumés s'arrêtent à ce que
  tient un message. Le simulateur, le schéma et `test-protocole.js` suivent.
- Application : `PROTO_APP` passe à 4. Restée à 3 avec les commandes
  signées, elle affichait « mets à jour l'application » face à un socle 3.5.
- **Commandes signées (protocole 4).** Le code d'appairage ne circule plus sur
  le broker : l'application (et le serveur, pour la preuve de propriété)
  envoie `{"c": "<commande>", "sig": HMAC-SHA256(code, c)}`, horodatée ; le
  socle vérifie la signature et refuse une commande à plus de 5 min de son
  heure (rejeu). Les lectures ne portent plus aucun secret. Un socle d'avant le
  protocole 4 reçoit toujours le code en clair ; le firmware 3.5 l'accepte
  encore pour les applications pas encore à jour. SHA-256 et HMAC autonomes
  (`signature.cpp`), testés sur PC avec les vecteurs de la RFC 4231.
- **Interface locale : mot de passe obligatoire.** Plus d'accès libre par
  défaut : sans mot de passe, le socle ne sert que la page, qui demande d'en
  créer un (8 caractères au moins, empreinte calculée dans le navigateur,
  `POST /api/premier-acces`) ; toute autre requête reçoit 428, réglages et
  code d'appairage compris. Le formulaire Réseau ne vide plus l'utilisateur et
  ne le change qu'avec un nouveau mot de passe. `provisionner.js` tire le mot
  de passe à l'atelier, le donne au socle et l'imprime sur l'étiquette.
- **Point d'accès de secours : un mot de passe propre à chaque socle.** Fini le
  mot de passe commun `terrarium1234`, imprimé dans la documentation : le socle
  tire le sien (10 caractères, sans i, l, o, 0 ni 1) à la première ouverture du
  point d'accès, radio allumée, et le garde. Un socle mis à jour depuis le mot
  de passe commun en reçoit un nouveau à la prochaine ouverture. Il s'affiche
  sur l'écran (page Réseau, et en alternance avec « AP config » en bas de la
  page principale) et dans la commande série `etat`.
- Application : les statistiques séparent les 24 dernières heures (minimum,
  maximum, moyenne, temps hors plage) des cumuls depuis la mise en service
  (heures de chauffe, kWh) ; les défauts sont comptés depuis le dernier
  démarrage, et le disent.
- Application : à l'ajout d'un socle, l'identifiant est remis dans sa forme
  (`terraa1b2c3` ou `terrarium-config-A1B2C3` deviennent `terraA1B2C3`) et le
  code d'appairage est vérifié auprès du socle tout de suite : un code refusé
  rend le formulaire au lieu d'enregistrer un socle impilotable.
- Notifications « trop chaud » et « dérive » dans l'application et dans les
  notifications push du serveur, comme le défaut (le retour à la normale aussi).
- Réessais MQTT espacés : 15 s, puis doublés jusqu'à 5 min, au lieu d'un essai
  toutes les 5 s contre un broker qui refuse.
- Négociation TLS des alertes et de la mise à jour tirée bornée à 5-6 s.
- Le garde-fou de taille ne contrôle plus l'ancienne table de partitions
  (`--anciens-socles` le rétablit).
- `npm run lint` et `npm run types` fonctionnent aussi sous Windows.
- L'avertissement d'export de l'application mentionne le mot de passe du broker,
  que le fichier contient.
- Dependabot passe une fois par trimestre, en une seule proposition par
  écosystème (outils, serveur, actions GitHub) et sans rebasage automatique ;
  la vérification ne tourne plus deux fois sur une branche qui a une
  proposition de fusion ouverte.

### Corrigé

- Firmware : un envoi d'image par l'interface locale, refusé (version, format,
  signature) puis coupé par le navigateur avant la fin, laissait le chauffage
  coupé jusqu'au redémarrage suivant ; la mise à jour se rétablit désormais
  dès l'interruption. La connexion d'une mise à jour téléchargée (TLS,
  redirections) ne laisse plus non plus un tapis alimenté sans régulation le
  temps qu'elle s'établisse ; et ArduinoOTA, qui suspendait la régulation sans
  couper les sorties pendant tout le transfert, suit les mêmes régimes.
- Application : remonter par la flèche après être arrivé d'une autre branche
  (des réglages depuis un socle, par exemple) pouvait ramener à l'écran
  quitté au lieu du parent ; l'entrée réécrite garde désormais la vraie
  entrée précédente.
- Application : déverrouillée après « Verrouiller », elle revient sur l'écran
  d'où l'on avait verrouillé (rubrique ou réglages), plus seulement sur la
  liste ou l'accueil du socle.
- Application : sous WebKit (Safari, et tout navigateur sur iPhone), recharger
  la page après être remonté d'un écran pouvait la faire planter (bug WebKit
  300402 sur l'historique empilé). Là, l'adresse suit désormais l'écran sans
  empiler d'entrée : rechargement, liens et notifications ouvrent toujours le
  bon écran ; le bouton retour du téléphone (Android) garde son comportement.
- Application : l'agent de service ne mettait rien en cache après son
  installation. Il copiait chaque réponse trop tard, quand la page l'avait
  déjà lue, et l'erreur passait inaperçue : la coque n'était jamais
  rafraîchie en arrière-plan et aucune autre page n'était gardée hors ligne.
  La copie est prise aussitôt ; la démonstration, la page de flashage ou
  l'atelier restent maintenant ouverts sans réseau. Ne passent jamais par le
  cache : `version.json`, l'API et la console du serveur Terrariums quand il
  sert aussi l'application, le firmware de la page de flashage, et toute
  requête authentifiée.
- Site : la démonstration ouverte à l'adresse `/demo` (sans `.html`)
  s'affichait brute, sans mise en forme ni script. Netlify sert chaque page
  aussi sans son extension, mais choisit les en-têtes d'après l'adresse
  demandée : à `/demo`, seule la politique générale s'appliquait, et elle
  refuse le script et le style en ligne dont la démonstration est faite. Même
  défaut pour la page de flashage à `/installer`. Les règles propres à ces
  pages valent maintenant pour leurs deux adresses, et
  `outils/verifier-netlify.js` (CI, crochet de commit) le contrôle.
- Application : à la toute première visite, l'agent de service rechargeait la
  page en prenant la main ; ce qui venait d'être saisi était perdu. Il ne
  recharge plus qu'à l'arrivée d'une nouvelle version acceptée.
- Application : Firefox signalait la police préchargée comme inutilisée ; elle
  n'est plus préchargée (la feuille de style la découvre aussitôt).
- Application : un socle éteint passait pour « en ligne » à l'ouverture. Le
  broker rejoue l'état retenu à l'abonnement, et cet état suffisait à déclarer
  le socle présent. La présence ne vient plus que du sujet `statut` (et de son
  testament) ; un état rejoué n'entre pas non plus dans l'historique local.
- Application : sur Android, les notifications n'apparaissaient jamais —
  Chrome refuse `new Notification()` hors agent de service. Elles passent
  désormais par l'agent de service. Sur iPhone, l'application explique
  qu'elles demandent l'installation sur l'écran d'accueil au lieu d'accuser le
  HTTPS.
- Application : « Tout effacer » laissait l'historique local (IndexedDB) sur
  l'appareil ; la base est maintenant supprimée.
- Application : sur un téléphone étroit (320 à 390 px), la tuile du nom d'hôte
  débordait de l'écran dans la santé du socle.
- Application : ouvrir l'onglet Appareil effaçait de l'écran un défaut, la
  chauffe et le temps de service jusqu'à la publication suivante du socle
  (jusqu'à 60 s) : la réponse « stats », qui a aussi un tableau `zones`, était
  prise pour un état. Seule la réponse « etat » met désormais l'état à jour.
- Application : l'autotune et la dérive disparaissaient à chaque publication
  d'une zone. Un drapeau absent garde sa valeur, et le sujet `etat` de chaque
  zone porte désormais `autotune`, `derive` et `trop_chaud`. Ces deux défauts
  rendaient aussi la régression visuelle de la CI instable.
- L'identifiant du socle (`terraXXXXXX` : sujets MQTT, nom mDNS, point
  d'accès, appairage) était lu avant le démarrage du Wi-Fi. Avec le cœur
  ESP32 3.x, `WiFi.macAddress()` ne renvoie alors rien : l'identifiant venait
  de mémoire non initialisée et changeait d'une compilation à l'autre, si
  bien que l'application perdait le socle après une mise à jour. Il est
  désormais lu dans l'eFuse (`esp_read_mac`) : les trois derniers octets de
  l'adresse MAC Wi-Fi.
- Un échec de connexion MQTT n'apparaissait nulle part : le socle restait
  « hors ligne » dans l'application sans dire pourquoi. Le journal donne
  désormais la raison (identifiant ou mot de passe refusé, droits, erreur
  TLS, adresse introuvable), une fois par changement, ainsi que les
  coupures ; la commande `reseau` affiche l'état de la connexion.
- Avec le cœur ESP32 3.x, `setTimeout()` ne bornait plus la connexion MQTT
  chiffrée : un broker muet pouvait bloquer la boucle jusqu'à 120 s, bien
  au-delà du watchdog. Connexion et négociation TLS sont de nouveau
  limitées à 5 s chacune.

## [3.4.0] — 2026-10-14

Un socle en 3.3 passe en 3.4 par `/api/maj` ou depuis l'application ; il garde
alors son ancienne table de partitions (emplacements de 1,5 Mo), ce que le
garde-fou de taille continue de vérifier. Un reflashage par USB (page « Flasher
un socle », effacement complet accepté) installe la nouvelle table.

### Ajouté
- **Mise à jour tirée par le socle** (action MQTT `maj`, commande série `maj`,
  `/api/maj-distante`) : le socle télécharge lui-même le binaire d'une release
  GitHub en HTTPS (magasin de certificats du cœur, hôtes limités à
  `MAJ_HOTES_AUTORISES`), vérifie la signature si elle est exigée, coupe le
  chauffage le temps d'écrire, et publie sa progression sur le sujet `maj`.
  L'application affiche la carte **Mise à jour du firmware** (dernière version
  publiée lue dans `version.json`) avec un bouton pour lancer l'installation.
- **État de mise à jour persistant** (`EtatMaj`, NVS) : en validation, validée,
  retour arrière, échec — visible dans la santé (`maj`), l'interface locale et
  l'application, avec alerte en cas de retour arrière.
- **Nom d'hôte et réseau de configuration par socle** : `terraXXXXXX.local`
  (mDNS avec enregistrement TXT) et point d'accès `terrarium-config-XXXXXX`
  avec **portail captif** (DNS) : la page de configuration s'ouvre d'elle-même.
- **Improv Wi-Fi** sur la console série : la page « Flasher un socle » configure
  le Wi-Fi juste après le flashage, sans point d'accès ni saisie à l'écran.
  Commande série `wifi` qui essaie le réseau immédiatement (`Reseau::essayerWifi`).
- **Connexion par session** sur l'interface locale : défi/réponse SHA-256 (le
  mot de passe ne quitte pas le navigateur), cookie `HttpOnly` `SameSite=Strict`
  de 24 h, cinq échecs → pause d'une minute ; Basic conservé pour `curl` et les
  outils. La page est servie sans authentification, les API restent protégées.
- **Auto-test usine** (`test usine [oui]`) : écran, sondes, NVS, LittleFS,
  partitions, coredump, scan Wi-Fi, heure, INA219 et, sur demande, chaque
  MOSFET une fraction de seconde. Utilisé par `outils/provisionner.js` et le
  banc matériel.
- **Protocole 3** : action `maj`, sujet `maj`, champs `hote`, `ip` et `maj`
  dans la santé ; schéma JSON et simulateur à jour.
- **Serveur Terrariums** (`serveur/`, Node, Docker) : broker MQTT intégré avec
  comptes et droits par socle, rattachement d'un socle par la preuve de son code
  d'appairage, historique conservé application fermée, notifications **Web
  Push**, dépôt de rapports de diagnostic, pont vers un broker amont, API et
  outil d'administration. L'application le détecte à la connexion.
- Application : **code de verrouillage** (PBKDF2 300 000 tours → AES-GCM-256 sur
  le mot de passe du broker et les codes d'appairage, verrouillage automatique),
  **Trusted Types** (toute écriture HTML passe par une seule politique),
  minification à la publication avec cartes de sources, aide, mentions légales
  et confidentialité **en anglais**, fiche de **démarrage rapide imprimable**
  (`demarrage-rapide.html`, PDF joints à chaque release avec les deux manuels).
- Compilation **reproductible** (`SOURCE_DATE_EPOCH`, commit dans le binaire,
  `FW_BUILD` affiché) et **attestation de provenance** des binaires de release
  (`gh attestation verify`).
- Bancs sur PC : canal de commandes extrait dans `protocole.cpp` et testé sans
  Arduino (47 cas, fuzzé), **migration des réglages** testée (décalages figés
  par `static_assert`, relecture tolérante entre versions), couverture gcov par
  module (seuil 80 %), clang-tidy, sanitizers ; application : régression
  visuelle pixel à pixel, test de charge (100 socles, 10 applications),
  couverture c8, matrice WebKit/Firefox, CodeQL C++, banc matériel par port
  série (`test-materiel.js`, exécuteur auto-hébergé), hook de pré-commit.
- Documentation : `NOTICE.md` (licences embarquées), `docs/conformite.md`
  (CE, RED, CRA, DEEE, RGPD), `docs/produit.md`, `docs/securisation-serie.md`,
  décisions 0008 à 0010, `SECURITY.md` avec versions prises en charge.

### Modifié
- **Table de partitions** révisée : 2 × 1,69 Mo d'application (le binaire
  passe de 91 % à 81 % d'occupation) et 512 Ko de fichiers (≈ 11 jours
  d'historique). Les socles non reflashés par câble gardent l'ancienne table.
- Structures de réglages déplacées dans `reglages.h`, règle « ajout en fin de
  structure seulement » pour rester compatible d'une version à l'autre.
- Action `alim` validée par les mêmes bornes que les réglages globaux.
- Workflow de publication : bibliothèques épinglées, binaires reproductibles,
  PDF de documentation, notes de version mentionnant la mise à jour tirée.
- Outils de développement : ESLint 10 (avec `@eslint/js` et ses nouvelles
  règles), TypeScript 7, c8 12, mqtt.js 5.16 ; jsdom reste en 24 (la 30 casse
  le client WebSocket des bancs). Dependabot ne propose plus de montée de
  version majeure : chacune se fait à la main, suites de test à l'appui.

### Corrigé
- `strcat` sans borne dans la composition des libellés de défaut remplacé par un
  ajout borné (relevé par clang-tidy).
- Expression régulière de la démonstration qui laissait passer un identifiant
  mal formé (`\d` dans un gabarit de chaîne).
- Le schéma JSON et les tests n'admettaient que des identifiants hexadécimaux ;
  ils acceptent `terra` suivi de six caractères alphanumériques (celui du
  simulateur compris).

## [3.3.0] — 2026-10-13

### Ajouté
- **Retour arrière automatique** après une mise à jour : une image qui plante
  dans la minute et demie n'est jamais validée, le chargeur relance la précédente.
- **Rapport de plantage** : au redémarrage après une panique, résumé du coredump
  (tâche, compteur de programme, pile) dans le journal, les alertes et
  l'interface ; fichier complet sur `/api/coredump`.
- **Santé du socle** publiée (sujet MQTT `sante`, réponse `etat`, `/api/status`) :
  signal Wi-Fi, mémoire libre et plus grand bloc, uptime, cause du dernier
  redémarrage, mise à jour en attente de validation.
- **Alertes au format texte** (`formatAlertes`) avec titre et priorité : ntfy et
  consorts affichent directement une notification sur le téléphone.
- **Images de mise à jour signées** (ECDSA P-256) exigées par `/api/maj` quand
  `OTA_CLE_PUBLIQUE` est renseignée ; `outils/signer-firmware.js`.
- **QR code d'appairage sur l'écran** OLED, à côté du code en toutes lettres
  (encodeur `qr.cpp`, testé sur PC et relu par un décodeur indépendant).
- **Mesure de courant** facultative (INA219, `INA219_ACTIF`) : tapis coupé,
  MOSFET passant, kWh réels.
- **Commandes rejouées sans effet** : une requête déjà traitée reçoit à nouveau
  sa réponse, ce qui rend le QoS 1 sûr.
- Commandes série `sante`, `coredump [effacer]`, `appairage`.
- Application : français/anglais, dialogues de confirmation de la page et
  retrait de socle annulable, bouton d'installation, pastille sur l'icône,
  vibration sur un défaut, écrans d'attente, « tester la connexion »,
  diagnostic avec rapport copiable, export/import de la configuration et des
  réglages d'un socle, historique local sur 7 et 30 jours, zoom et export CSV
  des courbes, pages d'aide, de flashage, mentions légales et confidentialité.
- Outils : installateur web (ESP Web Tools), publication automatisée
  (`preparer-publication.js`, release par étiquette), ESLint, `tsc --checkJs`,
  Lighthouse CI, axe-core, test en Chromium réel, fuzzing libFuzzer, schéma
  JSON du protocole, garde-fou de taille du firmware, scénario d'endurance de
  7 jours avec passage de `millis()` à zéro.

### Modifié
- Publication MQTT **sur changement** (au plus toutes les 2 s, au moins toutes
  les 60 s) au lieu d'une cadence fixe de 20 s.
- Version de protocole **2** (`PROTO_VERSION`) : l'application signale un socle
  ou une application à mettre à jour.
- Interface web embarquée au même langage visuel que l'application, clair et sombre.
- Client MQTT de l'application : publication en QoS 1 avec réémission.

### Corrigé
- Charge (`duty`) qui pouvait dépasser 100 % d'une fraction de tour de boucle
  (trouvé par le fuzzing).
- Une valeur non finie glissée dans la régulation traversait les bornes.

## [3.2.0] — 2026-09

- Deux tapis, un seul alimenté à la fois ; partition sur mesure ; identifiant de
  l'appareil exposé ; page embarquée compressée ; application réécrite (clair
  façon PETKIT, sombre automatique) avec son propre client MQTT.
