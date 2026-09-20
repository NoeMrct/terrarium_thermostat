# Application de pilotage à distance

Une page web installable sur téléphone, qui parle **directement** au broker MQTT
en WebSocket. Pas de serveur intermédiaire, donc rien à héberger ni à payer pour
démarrer.

```
   socle ───┐                        ┌─── cette application
            ├──►  broker MQTT  ◄─────┤
   socle ───┘                        └─── Home Assistant, scripts…
```

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
en compte.

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
   s'installe avec son icône, sans barre d'adresse.
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
courant. L'onglet Courbes en demande un échantillonnage — 120 points au plus,
compactés — uniquement quand on l'ouvre, et l'historique complet reste sur la
flash du socle. Le trafic tient donc en quelques kilo-octets par jour et par
appareil au lieu de plusieurs méga-octets : c'est ce qui rend les paliers
gratuits tenables jusqu'à une centaine de socles.

**L'agent de service ne met en cache que la coque.** Jamais les températures :
afficher une valeur de la veille donnerait une fausse impression de
surveillance, ce qui est pire que de ne rien afficher.

---

## 6. Vérification

L'application est exécutée automatiquement contre un socle simulé :

```
cd ../outils && node test-application.js --id terraSIM001 --jeton SIMULATIONTESTJETON00001
```

40 vérifications, du premier lancement au retrait d'un socle, en passant par
les réglages complets d'une zone, les courbes et les réglages de l'appareil.
Voir `outils/README.md`.

## 7. Limites connues

**Le code d'appairage est stocké dans le navigateur.** Quelqu'un ayant accès au
téléphone déverrouillé peut le lire. C'est acceptable pour un usage personnel ;
pour un produit, il faudra un vrai compte utilisateur et un jeton de session
révocable — c'est l'objet de la phase 3, avec backend.

**Les notifications ne marchent que l'application ouverte.** Un défaut ou une
dérive fait apparaître une notification du navigateur, y compris onglet en
arrière-plan, mais **pas** application fermée ni téléphone en veille : cela
demanderait Web Push, donc un serveur pour conserver les abonnements. Les
alertes qui partent du socle lui-même vers l'URL configurée dans le firmware
(ntfy.sh, Discord…) restent le seul canal qui fonctionne appareil éteint.
Elles se complètent : l'une prévient pendant qu'on regarde, l'autre pendant
qu'on dort.

**Une application par utilisateur, pas de partage.** Deux personnes voulant
suivre les mêmes socles doivent chacune saisir les codes d'appairage.

**La bibliothèque MQTT est embarquée** (`vendor/mqtt.min.js`, version figée) et
non chargée d'un CDN : l'agent de service ne met en cache que les fichiers de la
même origine, et l'application doit pouvoir s'ouvrir hors ligne. Contrepartie
assumée : 360 Ko à charger la première fois, et une mise à jour manuelle de la
bibliothèque — la procédure est dans `vendor/LISEZMOI.md`, la CI vérifie que le
fichier correspond bien à la version déclarée dans `outils/package.json`.

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
