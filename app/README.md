# Application de pilotage à distance

Une page web installable sur téléphone, qui parle **directement** au broker MQTT
en WebSocket. Pas de serveur intermédiaire, donc rien à héberger ni à payer pour
démarrer.

```
   socle ───┐                        ┌─── cette application
            ├──►  broker MQTT  ◄─────┤
   socle ───┘                        └─── Home Assistant, scripts…
```

En option, le **serveur Terrariums** du dépôt (`serveur/`) prend la place du
broker nu : comptes, droits par socle, historique conservé application fermée,
notifications push, dépôt des rapports de diagnostic. L'application le
reconnaît à son annonce MQTT retenue (`<prefixe>/serveur`) puis l'interroge
(`/api/infos`) et ajoute ce qu'il permet ; un broker ordinaire n'est jamais
sondé en HTTP. Sans serveur, rien ne manque de ce qui est décrit ici.

---

## 1. Mettre en place le broker (gratuit)

**HiveMQ Cloud** ou **EMQX Serverless** offrent une centaine d'appareils
connectés sans frais. Créer un cluster, région européenne, puis noter l'adresse
WebSocket sécurisée, de la forme :

```
wss://abcdef123.s1.eu.hivemq.cloud:8884/mqtt
```

### Créer un compte par appareil

Ne réutilise pas un seul compte pour tout. Sur le broker, crée :

- un compte par socle, avec le droit de publier et souscrire **uniquement** sur
  `terrarium/<son-id>/#` ;
- un compte pour l'application, avec accès aux sujets des socles qui
  t'appartiennent.

Sans ce cloisonnement, un socle compromis pourrait écouter et commander tous les
autres. Le code d'appairage limite les dégâts, mais ne remplace pas des droits
correctement posés.

---

## 2. Configurer un socle

Sur le port série du socle, ou depuis son interface web locale :

```
mqtt abcdef123.s1.eu.hivemq.cloud 8883 socle-salon MOT_DE_PASSE
mqtt tls on
redemarrer
```

Vérifier avec `reseau`, puis relever l'identifiant et le code d'appairage :

```
jeton
```

L'identifiant est de la forme `terraA1B2C3`, le code fait 24 caractères. Les
deux sont aussi affichés à l'écran du socle au tout premier démarrage.

---

## 3. Publier l'application

Les fichiers sont statiques : n'importe quel hébergement convient.

### Cloudflare Pages

```
npx wrangler pages deploy app --project-name terrariums
```

### Netlify

Le plus simple, sans rien installer : glisser le dossier `app/` sur
[app.netlify.com/drop](https://app.netlify.com/drop).

Pour un déploiement automatique à chaque `git push`, importer le dépôt depuis
GitHub (**Add new site → Import an existing project**). Le `netlify.toml` à la
racine du dépôt fixe déjà le dossier à publier :

```toml
[build]
  publish = "app"
```

Sans lui, Netlify publierait la racine du dépôt — qui ne contient aucun
`index.html` — et le site répondrait « Page not found ». Si le site a été
importé avant l'ajout de ce fichier, un nouveau déploiement suffit à le prendre
en compte. La commande de build (`npm ci --prefix outils --omit=dev && node
outils/preparer-publication.js`) écrit `version.json`, nomme le cache de
l'agent de service d'après le commit, minifie les scripts (terser, cartes de
sources à côté) et copie le firmware de la dernière release pour la page
« Flasher un socle » ; sur un autre hébergeur, l'exécuter avant de publier.

### GitHub Pages

Déposer le contenu de `app/` sur une branche `gh-pages`.

**HTTPS est obligatoire** : sans lui, ni l'installation sur l'écran d'accueil ni
l'accès à la caméra ne fonctionnent. Les trois hébergeurs ci-dessus le
fournissent d'office.

### Essai en local

```
cd app && python3 -m http.server 8080
```

Puis `http://localhost:8080`. L'agent de service ne s'installera pas en HTTP,
mais tout le reste fonctionne.

---

## 4. Première utilisation

1. Ouvrir l'application, saisir l'adresse du broker et les identifiants.
2. Ajouter un socle : identifiant, code d'appairage, et un nom pour t'y
   retrouver.
3. « Ajouter à l'écran d'accueil » depuis le menu du navigateur : l'application
   s'installe avec son icône, sans barre d'adresse. Les icônes PNG de
   `icones/` sont là pour ça — iOS ignore les icônes SVG, et sans elles
   l'écran d'accueil montrerait une capture floue de la page.
4. Onglet **Appareil** d'un socle → « Activer les notifications » pour être
   prévenu d'un défaut sans avoir à regarder l'écran.

La vue d'un socle a quatre onglets :

| Onglet | Ce qu'on y fait |
|---|---|
| **État** | Températures en direct, consignes jour/nuit, entretien, autotune, levée des défauts |
| **Réglages** | Tous les réglages d'une zone : nom, horaires, rampe, bande, coupure max, calibration |
| **Courbes** | 6 h à 7 jours d'historique, demandés au socle à l'ouverture |
| **Appareil** | Alimentation, cyclage saisonnier, statistiques 24 h, notifications, redémarrage |

Le journal, la configuration réseau et la mise à jour du firmware restent sur
l'interface locale du socle : ce sont des opérations qu'on fait chez soi.

L'interface suit le réglage clair ou sombre du téléphone et s'adapte à la
largeur de l'écran : une colonne et une barre d'onglets en bas sur téléphone,
plusieurs colonnes et des onglets en haut sur tablette ou ordinateur.

Le bouton « Scanner un QR » apparaît sur les navigateurs qui savent lire les
codes-barres, essentiellement Chrome sur Android. Format attendu :

```
terrarium:terraA1B2C3:K7M2QX4TBW9HRPFZ3NXCVJ8D
```

C'est ce qu'il faudra imprimer sous les socles pour un produit fini.

---

## 5. Choix de conception

**Le socle est la source de vérité.** L'application n'affiche que ce qu'il
publie et ne considère jamais une commande comme aboutie avant sa réponse. Les
messages d'erreur affichés viennent du socle lui-même, qui connaît ses propres
limites — la validation n'est pas réécrite ici, elle vit dans le firmware.

**Un socle hors ligne est visible immédiatement.** Le sujet `statut` est
persistant et doté d'un testament : si le socle disparaît, c'est le broker qui
publie `hors ligne`. L'application le sait en quelques secondes sans rien
interroger.

**Toute commande a un délai maximal de huit secondes.** Un socle injoignable ne
répond jamais ; l'interface doit le dire plutôt que de rester figée.

**L'historique n'est pas rapatrié en continu.** Le socle ne publie que son état
courant — dès qu'il change, et au moins toutes les 60 s. L'onglet Courbes en
demande un échantillonnage — 120 points au plus, compactés — uniquement quand on
l'ouvre, et l'historique complet reste sur la flash du socle. Le trafic tient
donc en quelques kilo-octets par jour et par appareil au lieu de plusieurs
méga-octets : c'est ce qui rend les paliers gratuits tenables jusqu'à une
centaine de socles. En plus, l'application note une mesure par minute dans
IndexedDB pendant qu'elle est ouverte : c'est ce qui nourrit les courbes sur 7
et 30 jours, le tableau des min/max quotidiens et l'export CSV, sans rien
demander de plus au socle ni au broker.

**L'agent de service ne met en cache que la coque.** Jamais les températures :
afficher une valeur de la veille donnerait une fausse impression de
surveillance, ce qui est pire que de ne rien afficher. La coque est servie
depuis le cache d'abord, puis rafraîchie en arrière-plan : l'ouverture est
instantanée même en réseau lent. Quand une nouvelle version est prête,
l'application le propose (« Recharger ») au lieu de l'imposer au milieu d'un
réglage. Le nom du cache est réécrit à chaque déploiement par
`outils/preparer-publication.js` (commande de build Netlify) : rien à incrémenter
à la main. Le même script écrit `version.json`, que l'application affiche en pied
de page et dans le diagnostic.

**Le client MQTT est écrit pour l'application.** `mqtt.js` fait quelques
kilo-octets là où MQTT.js en faisait 369 : connexion, abonnements, publication
en QoS 0 et 1 (avec réémission à la reconnexion), keepalive et reconnexion,
rien d'autre. Les commandes partent en QoS 1 ; le socle, lui, ignore un doublon
en renvoyant la réponse déjà donnée. Le client est éprouvé face à un vrai
broker par `outils/test-mqtt.js`, et c'est lui que `outils/test-application.js`
fait tourner. Toute l'application, client compris, tient sous 44 Ko compressés
une fois minifiée à la publication (58 Ko en source ; `outils/budget.js` y
veille), dictionnaire français/anglais compris.

**Les textes passent par `t()`.** Le français est la référence — les tests
lisent ces chaînes-là —, l'anglais vient du même dictionnaire, choisi d'après la
langue du navigateur ou le sélecteur en pied de page.

**Pas de `confirm()` du navigateur.** Les confirmations sont des `<dialog>` de
la page, et retirer un socle ne demande rien : le geste se défait pendant
quelques secondes (« Annuler »). Un socle annoncé en ligne mais muet depuis plus
de deux minutes est montré **silencieux** ; un socle dont le protocole est plus
récent que l'application le dit.

**Le diagnostic se copie.** Les erreurs imprévues sont capturées
(`error`, `unhandledrejection`, erreurs du broker) ; le bouton Diagnostic assemble
versions, navigateur, broker, état et santé de chaque socle (signal, mémoire,
dernier redémarrage) et erreurs récentes, sans mot de passe ni code d'appairage.

**Rien n'est en ligne dans le HTML.** Ni script, ni style, ni gestionnaire
d'événement : la politique de sécurité du contenu (CSP) déclarée dans la page,
et renforcée par les en-têtes de `netlify.toml`, interdit tout script injecté.
Un message du socle mal échappé ne pourrait donc rien exécuter. La CSP exige
aussi les **Trusted Types** : toute écriture de HTML passe par une seule
fonction (`html()`), adossée à la politique `terrarium` ; une affectation
directe à `innerHTML` ailleurs est refusée par le navigateur, pas seulement
par la revue de code.

**Les secrets peuvent être chiffrés sur l'appareil.** Avec un code de
verrouillage, le mot de passe du broker et les codes d'appairage sont chiffrés
(PBKDF2-SHA256, 300 000 tours, puis AES-GCM-256) et l'application se verrouille
après le délai choisi, ou dès le lancement. Le code n'est stocké nulle part :
oublié, il faut tout effacer et réappairer. Sans code, tout reste en clair
dans le stockage local, comme avant.

**Le firmware se met à jour depuis l'application.** `version.json` porte la
dernière version publiée (lue dans la release GitHub à la publication) ; la
carte « Mise à jour du firmware » de l'onglet Appareil la compare à celle du
socle, et l'action `maj` du protocole fait télécharger l'image par le socle
lui-même, qui publie sa progression sur le sujet `maj`. L'état de la dernière
mise à jour (validée, retour arrière, échec) vient de sa santé.

**Le rendu ne touche que ce qui change.** Chaque région de l'écran n'est
repeinte que si son contenu diffère du précédent, et les formulaires ne sont
construits qu'à l'ouverture d'un panneau : un champ en cours de saisie n'est
jamais effacé par la publication suivante du socle, et les messages reçus en
rafale ne déclenchent qu'une mise à jour par image. Aucun gestionnaire
d'événement n'est écrit dans le HTML — un seul écouteur par type d'événement
aiguille d'après les attributs `data-action` et `data-form`.

---

## 6. Vérification

L'application est exécutée automatiquement contre un socle simulé :

```
cd ../outils && node test-application.js --id terraSIM001 --jeton SIMULATIONTESTJETON00001
```

Une cinquantaine de vérifications, du premier lancement au retrait d'un
socle, en passant par les réglages complets d'une zone, les courbes, les
réglages de l'appareil, le code de verrouillage et la mise à jour du firmware.
Le client MQTT a sa propre suite (`node test-mqtt.js`) ; `node
test-navigateur.js` rejoue le parcours dans un vrai Chromium (CSP et Trusted
Types, agent de service, dialogues, export CSV, diagnostic, verrouillage) et,
en CI, dans WebKit et Firefox ; `node test-accessibilite.js` passe axe-core sur
chaque écran ; `node test-visuel.js` compare chaque écran pixel à pixel à une
référence versionnée ; `node test-charge.js` fait tourner 100 socles et 10
applications ; `node test-serveur.js` enchaîne application, serveur et socle
simulé ; la couverture est mesurée par c8 ; Lighthouse CI exige 90 à 95
partout ; ESLint et `tsc --checkJs` relisent le code ; `node captures.js`
photographie chaque écran en clair et en sombre, téléphone et ordinateur. Voir
`outils/README.md`.

## 7. Limites connues

**Le code d'appairage est stocké dans le navigateur.** Sans code de
verrouillage, quelqu'un ayant accès au téléphone déverrouillé peut le lire ;
avec, il est chiffré et l'application se verrouille. Un compte révocable n'existe
qu'avec le serveur Terrariums, où le code ne sert qu'une fois, à prouver qu'on
détient le socle.

**Les notifications ne marchent que l'application ouverte** — sans serveur. Un
défaut ou une dérive fait apparaître une notification du navigateur, y compris
onglet en arrière-plan, mais **pas** application fermée ni téléphone en
veille. Avec le serveur Terrariums, le push prend le relais ; sinon, les
alertes qui partent du socle lui-même vers l'URL configurée dans le firmware
(ntfy.sh, Discord…) restent le canal qui fonctionne appareil éteint. Elles se
complètent : l'une prévient pendant qu'on regarde, l'autre pendant qu'on dort.

**Une application par utilisateur, pas de partage** — sans serveur. Deux
personnes voulant suivre les mêmes socles doivent chacune saisir les codes
d'appairage ; avec le serveur, chacune prouve le code une fois et le socle
appartient aux deux comptes.

**Le client MQTT ne fait pas de QoS 2 ni de session persistante.** Les
commandes partent en QoS 1 et sont réémises jusqu'à l'acquittement du broker ;
une commande qui n'a pas de réponse sous huit secondes est signalée. Si un jour
il faut plus, c'est `mqtt.js` qu'il faudra étendre, pas une bibliothèque qu'il
faudra remettre.

**L'historique local vit dans le navigateur.** Sans serveur, les courbes sur 7
et 30 jours ne contiennent que les minutes pendant lesquelles l'application
était ouverte sur cet appareil (plus ce que le socle garde, une dizaine de
jours). Changer de téléphone repart de zéro ; l'export CSV est là pour garder
une trace. Avec le serveur, l'application comble ses trous depuis l'historique
qu'il garde en continu.

**WebKit et Firefox sont testés en CI sans bloquer.** Le parcours complet y est
rejoué, mais un échec n'arrête pas la fusion tant qu'un passage au vert n'a
pas été constaté sur GitHub : le développement se fait sur Chromium.

---

## 8. Et si le broker tombe ?

**Le socle continue de réguler à l'identique.** Consignes, cycle jour/nuit,
diagnostics, coupures de sécurité et historique fonctionnent en local, sans
réseau. Son écran affiche tout, sa console série pilote tout, et son interface
web reste accessible sur le réseau domestique.

Le réseau n'ajoute que la commodité. Il ne conditionne jamais la sécurité de
l'animal, et aucune évolution ne doit changer cela.

Pour être prévenu d'une panne totale malgré tout, configure une URL de heartbeat
dans le socle (`url heartbeat …`, par exemple vers healthchecks.io) : elle est
indépendante de cette application et du broker.
