# Journal des versions

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
numéro de version suit [SemVer](https://semver.org/lang/fr/). Le numéro est
celui du firmware (`FW_VERSION`) ; l'application est publiée en continu et
affiche le commit dont elle est issue.

## [Non publié]

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
