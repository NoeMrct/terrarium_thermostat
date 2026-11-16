# Serveur Terrariums

Un seul processus Node, sans base de données, qui apporte ce qu'un broker seul
ne sait pas faire :

| Besoin | Sans serveur | Avec le serveur |
|---|---|---|
| Droits | un identifiant broker partagé commande tous les socles | comptes utilisateurs, chaque socle rattaché aux comptes qui ont prouvé son code d'appairage |
| Comptes | créés à la main sur le broker | en libre-service : un code par e-mail, puis une clé d'accès (passkey) ; export et effacement par le titulaire |
| Historique | seulement quand l'application est ouverte (IndexedDB) | continu, un point par minute, 400 jours, relu par l'application pour combler ses courbes |
| Notifications | navigateur ouvert, ou ntfy/healthchecks depuis le socle | push sur le téléphone, application fermée : défaut, rétabli, socle disparu, mise à jour disponible (une fois par version, avec ce qui va se passer : la nuit ou à la main) ou en échec |
| Diagnostic | copier-coller | « Envoyer au serveur » |
| Carnet du mois | PDF créé à la demande dans l'application | aussi par e-mail, le 1er de chaque mois, pour les comptes qui le demandent |
| Exploitation | — | console web sur `/console/` : flotte, comptes, comptes d'appareil, rapports, journal d'audit chaîné |
| Assistance | — | demandes des clients depuis l'application, accès au socle ouvert par le propriétaire (24 h, sans son code), diagnostics à distance, frise, alertes proactives |

Les socles s'y connectent comme à n'importe quel broker (MQTT TCP ou TLS
derrière un reverse proxy), ou restent sur un broker amont (HiveMQ) que le
serveur **pont** : ce qu'ils y publient entre ici, ce que les applications
commandent ici repart là-bas.

## Démarrer

```sh
cd serveur && npm ci
ADMIN_JETON=$(openssl rand -hex 24) node serveur.js        # HTTP 8080 (API, /mqtt, /console/), MQTT 1883
node serveur.js utilisateur ajouter noe 'un mot de passe'   # un compte pour l'application
node serveur.js appareil ajouter terraA1B2C3                # un compte pour un socle : affiche la commande série à taper
node serveur.js utilisateur admin noe oui                   # donne à ce compte l'accès à la console
node serveur.js utilisateur support agent oui               # rôle support : demandes et accès ouverts seulement
node serveur.js utilisateur atelier jean@exemple.fr oui     # rôle atelier : page Atelier (montage des socles) seulement
node serveur.js audit verifier                              # vérifie la chaîne du journal d'audit
```

Ou en conteneur : `docker compose -f serveur/docker-compose.yml up -d` depuis la
racine (voir le fichier pour les variables). Mettre un **reverse proxy TLS**
devant (Caddy fait tout seul le certificat) : l'application n'accepte que
`wss://` hors développement, et le push exige HTTPS. Sur une machine Ubuntu,
par exemple la machine gratuite de Google Cloud, `deploiement/machine/` installe
le tout en une commande : Traefik et ses certificats, MQTT chiffré des socles sur
le port 8883, sauvegarde nocturne et essai de bout en bout (voir son
`LISEZMOI.md`).

Dans l'application : « Se connecter » mène droit au compte (e-mail et code,
clé d'accès, ou identifiant et mot de passe) quand l'application connaît son
serveur — balise `<meta name="terrarium-serveur" content="https://…">` de
`app/index.html`, vide dans le dépôt et remplie au déploiement depuis la
variable `TERRARIUM_SERVEUR` de l'hébergeur (`outils/preparer-publication.js`),
ou serveur qui sert l'application
(`SERVIR_APP=1`, reconnu à son `/api/infos`). Sinon, elle demande l'adresse
`https://` du serveur. Le formulaire complet du broker (`wss://…/mqtt`,
préfixe) reste à l'adresse `#/technique` de l'application, pour le support et
le développement. Un compte de l'équipe (`utilisateur support|admin … oui`)
voit en plus, dans l'application, les blocs techniques réservés au support
(santé du socle, alimentation, outils de l'onglet Service, alerte de test) :
`/api/moi` et les réponses de session portent `equipe: true`.

Quand le WebSocket ne s'ouvre pas — la liste EasyPrivacy, qu'uBlock Origin,
Brave et AdGuard appliquent d'office, coupe tout WebSocket tiers vers
`duckdns.org` —, l'application passe par le **tunnel HTTPS** du serveur : le
même MQTT, par des requêtes ordinaires (`serveur/lib/tunnel.js`). `POST
/mqtt/tunnel` ouvre une liaison (`201 { id }`), `GET /mqtt/tunnel/<id>` en
reçoit les octets au fil de l'eau, chaque `POST /mqtt/tunnel/<id>` y envoie des
paquets, `DELETE` ou la fin du GET la ferme. Le broker y voit une connexion
comme une autre (identifiants dans le CONNECT, droits, retenus, keepalive).
Plafonds : 500 liaisons, 30 par adresse, 20 s pour venir lire, 256 Ko par
envoi. `/api/infos` l'annonce (`mqtt.tunnel`). Un proxy devant le serveur doit
laisser passer le flux sans le retenir (Traefik le fait ; nginx :
`proxy_buffering off`, que l'en-tête `X-Accel-Buffering: no` demande aussi).

Connectée au broker, l'application reconnaît le serveur à son annonce MQTT
retenue (`<prefixe>/serveur`, lisible par tout compte, écrite par lui
seul), confirme par `/api/infos`, ouvre une session et, à l'ajout d'un socle,
lui demande de le rattacher : le
serveur interroge le socle avec le code d'appairage et n'accorde les droits que
s'il répond. Un socle appartient à tous ceux qui ont prouvé son code.

## Configuration

Variables d'environnement, ou `serveur/.env` :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 8080 | HTTP : API, MQTT sur WebSocket (`/mqtt`) et par HTTPS (`/mqtt/tunnel`), application si `SERVIR_APP=1` |
| `PORT_MQTT` | 1883 | MQTT TCP pour les socles (`off` pour désactiver) |
| `DONNEES` | `serveur/donnees` | comptes, historique, clés VAPID, rapports |
| `ADMIN_JETON` | — | console (`/console/`), API d'administration (`Authorization: Bearer`) et utilisateur MQTT `admin`. Sans lui, la console reste ouverte aux comptes administrateurs |
| `AMONT_URL`, `AMONT_UTILISATEUR`, `AMONT_MOT_DE_PASSE` | — | pont vers un broker amont |
| `SERVIR_APP` | 0 | sert `../app` sur `/` |
| `ORIGINES` | toutes | origines autorisées pour l'API (CORS), séparées par des virgules |
| `CONTACT_VAPID` | — | contact déclaré aux services de push |
| `RETENTION_JOURS` | 400 | historique conservé |
| `PREFIXE` | terrarium | racine des sujets |
| `SMTP_URL` | — | envoi des codes de connexion : `smtps://utilisateur:motdepasse@smtp.fournisseur:465`, ou `smtp://…:587` (STARTTLS exigé). Sans lui, pas de comptes en libre-service |
| `COURRIEL_DE` | `Terrariums <ne-pas-repondre@hôte SMTP>` | expéditeur des e-mails |
| `COURRIEL_JOURNAL` | 0 | `1` : sans SMTP, l'e-mail (et son code) est écrit dans le journal — développement seulement |
| `RP_ID` | domaine de la première origine de `ORIGINES` | domaine des clés d'accès : celui où tourne l'application (`app.exemple.fr`, ou `exemple.fr` pour tous ses sous-domaines). Le changer rend inutilisables les clés déjà créées |
| `RP_NOM` | Terrariums | nom affiché par le téléphone à la création d'une clé |
| `DELAI_HORS_LIGNE_MIN` | 5 | un socle qui quitte le broker n'est notifié qu'au bout de ce délai (0 : tout de suite) ; s'il revient avant, rien ne part ; après une notification, son retour en ligne est notifié aussi |
| `TZ` | celui du système (UTC en conteneur) | fuseau des jours et des mois du carnet envoyé par e-mail : `Europe/Paris` |

## API

Publique : `GET /api/infos`, `POST /api/session {login, motDePasse}` → `{jeton}`,
`GET /api/push/cle`.
Comptes en libre-service : `POST /api/compte/code {email}` (un code à six
chiffres par e-mail, valable 10 minutes ; même réponse que l'adresse ait un
compte ou non ; trois demandes par adresse et dix par adresse IP et par quart
d'heure), `POST /api/compte/verifier {email, code}` → `{jeton, nouveau}` (cinq
essais par code ; le compte s'ouvre au premier code juste),
`POST /api/cles/options-connexion` puis `POST /api/cles/connexion` (clé
d'accès : clés découvrables, aucune liste de clés renvoyée).
Session (`Authorization: Bearer <jeton>`) : `GET /api/moi`, `GET /api/moi/export`
(tout le compte en JSON, sans aucun secret), `DELETE /api/moi {confirmation:
<identifiant>}` (compte, sessions, clés et abonnements effacés ; l'historique
d'un socle qui n'a plus aucun propriétaire aussi), `POST /api/cles/options-creation`
puis `POST /api/cles` (inscrire une clé d'accès), `GET /api/cles`,
`DELETE /api/cles/:id`,
`GET /api/moi/carnet`, `POST /api/moi/carnet {actif, noms}` (carnet du mois par
e-mail, voir plus bas), `POST /api/moi/noms {noms: {<socle>: <nom>}}` (les noms
donnés aux socles dans l'application, 40 caractères, ses socles seuls : titres
des notifications et du carnet ; l'application les envoie d'elle-même),
`POST /api/socles/revendiquer {id, jeton}`, `DELETE /api/socles/:id` (le dernier titulaire
parti, les invités perdent l'accès),
partage d'un socle par son titulaire : `GET /api/socles/:id/partages` (qui a accès, invitations
en attente, jamais leur code), `POST /api/socles/:id/invitations {droit: lecture|reglage, jours:
0-366, 0 = sans fin}` → `{code}` (usage unique, valable 48 h), `DELETE
/api/socles/:id/invitations/:id`, `DELETE /api/socles/:id/partages/:login` ; pour l'invité,
`POST /api/invitations/accepter {code}`. Un invité en lecture seule ne publie sur le broker que des
lectures non signées (`etat`, `stats`, `version`, `historique`) ; `GET /api/moi` donne ses
`partages`,
`GET /api/socles/:id/historique?depuis&jusqua&pas` (même format que le socle :
`[epoch, t1, consigne1, t2, consigne2]` en centièmes), `POST|DELETE
/api/push/abonnement`, `POST /api/push/essai`, `POST /api/rapports` (texte).
Administration (jeton d'administration, ou session d'un compte administrateur) :
voir « Console d'administration ». Les scripts d'avant la console gardent
`GET /api/flotte`, `GET /api/admin/comptes`, `POST /api/admin/utilisateurs`,
`POST /api/admin/appareils` (renvoie le mot de passe engendré) et
`POST /api/admin/utilisateurs/:login/socles`.

Dix échecs de connexion par adresse et par quart d'heure bloquent `/api/session`,
`/api/compte/verifier` et `/api/cles/connexion`.
Les sessions durent 30 jours et se prolongent à l'usage (30 jours sans servir
les ferment) ; changer de mot de passe les ferme toutes. Sur le disque, une
session n'est qu'une empreinte SHA-256 de son jeton. Pour un compte ouvert par
e-mail, le jeton de session est aussi le mot de passe présenté au broker
(identifiant : l'adresse e-mail).

## Console d'administration

`https://votre-serveur/console/` : une page servie par le serveur lui-même
(même origine que l'API), pour l'exploitant.

- **Connexion** : compte administrateur (mot de passe, code par e-mail ou clé
  d'accès) ou `ADMIN_JETON`. Un compte devient administrateur par
  `node serveur.js utilisateur admin <login> oui`, ou depuis la console. La
  session vit dans l'onglet (`sessionStorage`) ; un compte qui n'est pas
  administrateur est refusé et sa session refermée.
- **Tableau de bord** : socles en ligne, hors ligne, en défaut, sans
  propriétaire ; comptes ; rapports de la semaine ; état du journal ; ce qui
  demande à être regardé (défaut, mise à jour en échec, plantage, socle
  disparu depuis plus d'une heure) ; serveur (clients MQTT, pont, e-mail,
  clés d'accès, origines) ; versions de firmware de la flotte.
- **Socles** : filtres, recherche par identifiant ou propriétaire, fiche
  (santé publiée, zones, **schéma du câblage en direct** — bloc 12 V et
  courant mesuré, convertisseur, ESP32 et son signal, bilames, tapis qui
  chauffent, MOSFET D16/D17, sondes sur le bus D4 avec leur température ; les
  organes à vérifier d'abord en rouge selon le défaut, la même chose en texte
  dessous —, courbe des 24 heures, propriétaires à rattacher ou détacher,
  compte d'appareil, journal). Le serveur ne voit que ce que le
  socle publie : sans son code d'appairage, il ne peut rien lui commander.
- **Comptes** : création (mot de passe tiré et montré une fois si laissé
  vide), droits d'administration, « déconnecter partout », réinitialisation du
  mot de passe, retrait d'une clé d'accès, export des données (droit d'accès,
  avec ce que le journal dit du compte, sans nommer l'équipe), effacement.
- **Comptes d'appareil** : création et changement du mot de passe MQTT d'un
  socle (montré une fois, avec la commande à taper sur sa console série),
  retrait.
- **Rapports** de diagnostic : lecture (notée au journal), téléchargement,
  suppression.
- **Journal d'audit** : vérification de la chaîne, filtre par socle ou par
  compte, export NDJSON.

Garde-fous : données personnelles masquées par défaut (« no…@exemple.fr »,
un bouton les montre jusqu'au prochain chargement) ; référence à taper pour
effacer un compte ou retirer un compte d'appareil ; un administrateur ne peut
ni effacer son propre compte ni se retirer ses droits ; vingt jetons inconnus
par adresse et par quart d'heure, puis refus. La page est servie avec une
politique de sécurité stricte (même origine seulement, aucun script ni style
en ligne, Trusted Types exigés, pas d'intégration dans un cadre) ; elle reprend
la feuille de style et la police de l'application.

Routes (`/api/admin/…`) : `GET moi`, `GET tableau` ; `GET socles`,
`GET socles/:id`, `GET socles/:id/historique`, `POST socles/:id/proprietaires
{login}`, `DELETE socles/:id/proprietaires/:login` ; `GET|POST appareils`,
`POST appareils/:id/renouveler`, `DELETE appareils/:id {confirmation: id}` ;
`GET|POST utilisateurs`, `GET utilisateurs/:login`, `POST
utilisateurs/:login/admin {admin}`, `POST utilisateurs/:login/sessions/fermer`,
`POST utilisateurs/:login/mot-de-passe`, `GET utilisateurs/:login/export`,
`POST|DELETE utilisateurs/:login/socles[/:id]`, `DELETE
utilisateurs/:login/cles/:id`, `DELETE utilisateurs/:login {confirmation:
login}` ; `GET rapports`, `GET|DELETE rapports/:nom` ; `GET
audit?limite&cible&compte`, `GET audit/export?cible&compte`.

## Support (V11)

Le propriétaire écrit au support depuis l'application (onglet Service, carte
Assistance) ; l'équipe répond depuis la console (onglet **Support**). Une
demande relie le client, le socle, les messages et l'accès, avec un statut
(nouvelle, en cours, attente client, résolue), une gravité (urgente si le socle
est en défaut à l'ouverture) et un responsable ; la file met les urgentes et
les plus anciennes en tête. Les **notes internes** ne sont jamais montrées au
client, ni le nom de qui a répondu.

**Réponses types** (console : « Réponses types » dans l'onglet Support, et
« Insérer une réponse type » dans la fiche d'une demande) : textes partagés par
l'équipe, classés par usage, avec des variables remplies par la demande
ouverte — `{terrarium}` (le nom que le propriétaire a donné au socle),
`{référence}`, `{zone}` et `{défaut}` (zone en défaut), `{heure_défaut}` (tirée
de la frise), `{fin_accès}`, `{version}`, `{signal}`. Une variable que le
serveur ne connaît pas reste entre accolades, à compléter avant l'envoi. Six
réponses de départ (accès, sonde muette, Wi-Fi faible, mise à jour, fin
d'intervention…), modifiables (`donnees/support/reponses.json`).

**Relances** : une par demande, à une date choisie (raccourcis « dans 2 h »,
« demain 10:00 », « dans 48 h »), 90 jours au plus. Un rappel pour l'équipe
s'affiche « à faire » à l'échéance (fiche, file, tuile du tableau de bord)
jusqu'à ce qu'on le retire ; un message au client part à l'échéance (et le
client est notifié), sauf s'il a répondu entre-temps — la relance redevient
alors un rappel pour l'équipe — ou si la demande est close.

**L'accès au socle**, ouvert par le propriétaire seul : l'application tire une
clé de session (32 octets), l'envoie au socle (`service ouvrir`, signée avec le
code d'appairage, que le serveur ne voit jamais), puis la remet au serveur, qui
vérifie qu'elle signe (`service etat`) et la garde le temps de l'accès
(`donnees/support/acces.json`, 0600). 24 h, prolongeables par l'équipe jusqu'à
7 jours après l'ouverture (borne tenue par le socle), fermables à tout moment
par le propriétaire (application ou page locale). Pendant l'accès :

- diagnostics et réglages signés avec la clé (relire le bus, état, journal du
  socle, rapport, résumés, essai de chauffe, lever les défauts, redémarrer…),
  chacun au journal d'audit avec ses valeurs, et au journal du socle ;
- **copie des réglages** prise à l'ouverture, et « tout remettre » (référence
  tapée) ;
- **transfert** des réglages vers un socle de remplacement (accès ouvert sur le
  neuf), avec rattachement des propriétaires ;
- l'écran du socle affiche « Support connecté ».

À l'échéance, la clé quitte le disque (le socle la refuse déjà) ; l'effacement
d'un compte ferme l'accès de ses socles et efface ses demandes.

**Rôles** : `admin` (tout) et `support` (tableau de bord, socles, rapports,
journal en lecture, demandes et accès ; ni comptes, ni comptes d'appareil, ni
export du journal). **Frise** d'un socle : ce que le serveur a vu (en ligne,
hors ligne, redémarrage, défaut, rétabli, mise à jour —
`donnees/evenements/<id>/AAAA-MM.ndjson`, aussi longtemps que l'historique), ce
qu'ont fait le propriétaire et l'équipe, et les messages. **Alertes
proactives** au tableau de bord, sans ouvrir d'accès : défaut, mise à jour en
échec, hors ligne depuis plus d'une heure, trois redémarrages en 24 h,
plantage, signal faible, mémoire basse — chacune avec sa demande, ou de quoi en
ouvrir une.

Routes du propriétaire (session) : `GET|POST /api/support/acces`,
`DELETE /api/support/acces/:id`, `POST /api/support/acces/:id/refuser`,
`GET|POST /api/support/demandes`, `POST /api/support/demandes/:n/messages`.
De l'équipe (`/api/admin/support/…`) : `GET|POST demandes`, `GET|POST
demandes/:n`, `POST demandes/:n/messages {texte, modele?}|notes|demander-acces`,
`GET demandes/:n/variables`, `POST|DELETE demandes/:n/relance {quand, texte,
message}`, `GET|POST reponses`, `POST|DELETE reponses/:id`, `GET equipe`,
`GET acces`, `GET acces/:id`, `POST acces/:id/commande|prolonger|fermer|copie`,
`POST acces/:id/remettre {confirmation}`, `POST transferer {de, vers,
confirmation}` ; et `GET /api/admin/socles/:id/frise`.

## Atelier

La page Atelier de l'application (`app/atelier.html`) monte les socles en série.
Connectée à ce serveur avec un compte de l'équipe — administrateur, ou **rôle
atelier** (`POST /api/admin/utilisateurs/:login/atelier {atelier}`, bouton de la
console, ou `utilisateur atelier <login> oui`) —, elle partage son registre ici
(`donnees/atelier.json`) :

- `GET /api/atelier/registre?depuis=<rev>` : fiches, lots et Wi-Fi du banc
  changés depuis cette révision, et les préférences d'alerte du compte ;
- `PUT /api/atelier/socles/:id {socle, base}` : écrit une fiche en disant de
  quelle révision elle part ; changée entre-temps, la fiche du serveur est
  rendue (409) au lieu d'être écrasée (une fiche jamais vue, `base` 0, ne
  l'emporte que si elle est plus récente : registre local d'avant le partage) ;
  le code d'appairage et le mot de passe de la page locale sont refusés, ils
  ne quittent pas le poste qui a monté le socle ;
- `PUT /api/atelier/lots/:id {nom, cree}`, `PUT|DELETE /api/atelier/wifi
  {ssid, motDePasse}` (chiffré AES-256-GCM par une clé tirée de
  `ADMIN_JETON`, hors des données sauvegardées ; un autre jeton le rend
  illisible : il est alors à ressaisir), `POST /api/atelier/alertes {email}`.

Le **rôle atelier** n'ouvre que cela, plus la création du compte d'appareil
d'un socle sans propriétaire (`POST /api/admin/appareils`) et, sur le broker,
les socles en cours de montage : au registre, pas encore expédiés, sans
propriétaire. Ni la console, ni les comptes, ni les clients.

**Rodage surveillé ici** pour les socles reliés à ce serveur : redémarrage
(durée de marche qui recule), défaut de zone, coupure et retour, notés à la
fiche en direct ; chaque minute, les rodages arrivés à terme sont conclus
(durée de marche comparée à celle du rodage, défauts présents, incidents
graves ; un socle hors ligne est attendu une demi-heure). L'équipe de
l'atelier (administrateurs et rôle atelier) reçoit les **alertes** — rodage
réussi ou échoué, incident, socle disparu plus de `DELAI_HORS_LIGNE_MIN` —
groupées sur deux minutes : un e-mail par membre (sauf s'il les a coupées) et
une notification sur ses navigateurs abonnés (`page: 'atelier'`, l'appui ouvre
l'atelier sur le socle). L'expédition d'un socle et le Wi-Fi du banc entrent au
journal d'audit (`atelier.expedier`, `atelier.wifi`).

## Journal d'audit

Chaque geste de l'administration, et ce que font les titulaires eux-mêmes
(compte ouvert ou effacé, socle rattaché ou retiré, clé d'accès ajoutée ou
retirée, rapport envoyé), entre dans `donnees/audit/AAAA-MM.ndjson` : qui,
quand, quoi, sur quel socle ou quel compte, avec les valeurs utiles — jamais
un mot de passe, un jeton ni un code. Un compte y figure sous une référence
pseudonyme (`no…@exemple.fr #3f9a0c21b4`, empreinte de l'adresse) : l'adresse
effacée avec le compte ne reste pas au journal, et une demande d'accès se
retrouve en recalculant la référence (filtre « compte » de la console).

Chaque ligne porte l'empreinte SHA-256 de la précédente : une ligne modifiée,
retirée ou insérée se voit à la vérification (console, ou
`node serveur.js audit verifier`), qui repart de la plus ancienne ligne
conservée. Une fin coupée pendant que le serveur tourne se voit aussi, et une
ligne « audit.rupture » le note. Les mois au-delà de douze partent en entier.
Contre quelqu'un qui réécrirait tout le disque, noter de temps en temps la
tête de chaîne (affichée par la console) ailleurs.

## Clés d'accès

Le serveur vérifie lui-même les cérémonies WebAuthn (`lib/webauthn.js`, sans
dépendance) : défi à usage unique de cinq minutes, origine acceptée (celles de
`ORIGINES`, ou à défaut celle qui a demandé le défi), empreinte du `RP_ID`,
présence de l'utilisateur, signature (ES256, EdDSA ou RS256) et compteur de
signatures. Aucune attestation n'est exigée : toute clé d'accès du marché
convient. L'identifiant WebAuthn d'un compte est aléatoire (jamais l'e-mail),
dix clés au plus par compte.

## Droits sur le broker

| Compte | Publie | Lit |
|---|---|---|
| socle `terraXXXXXX` | `terrarium/terraXXXXXX/#`, `homeassistant/#` | `terrarium/terraXXXXXX/cmd`, `…/set` |
| utilisateur | `terrarium/<id>/cmd` de ses socles | `terrarium/<id>/…` de ses socles, jamais de joker sur le parc |
| rôle atelier | en plus, `terrarium/<id>/cmd` des socles en montage | en plus, `terrarium/<id>/…` des socles en montage (au registre, pas expédiés, sans propriétaire) |
| `admin` (jeton) | tout | tout |

Une publication interdite déconnecte le client ; un abonnement interdit est
refusé dans le SUBACK (code 128) sans couper la connexion.

## Carnet du mois par e-mail

Avec `SMTP_URL`, `/api/infos` annonce `comptes.carnet` et l'application
propose, dans Réglages → Exports, « Carnet par e-mail — Le 1er de chaque
mois ». Le serveur vérifie toutes les heures ; le 1er à partir de 8 h (fuseau
`TZ`), chaque compte abonné qui a une adresse e-mail et au moins un socle
reçoit le résumé du mois écoulé : pour chaque socle, la moyenne et les
extrêmes datés de chaque zone, le temps passé à ±1 °C de la consigne, les
jours avec des mesures et les alertes vues par le serveur (défauts, excès de
chaleur, dérives, passages hors ligne). Du texte seul, sans image ni lien de
suivi ; le carnet complet (courbes, consommation, journal du socle) reste le
PDF créé par l'application. Un serveur arrêté le 1er envoie le carnet à son
redémarrage ; un envoi refusé est retenté à l'heure suivante, trois fois par
mois au plus. À l'activation, le carnet du mois écoulé part tout de suite (une
fois par mois au plus) : le titulaire voit ce qu'il recevra. Les noms des
socles viennent de l'application (`noms`, limités aux socles du compte) ;
ceux des zones, du dernier état publié par le socle. La préférence figure dans
l'export du compte et disparaît avec lui.

## Données

```
donnees/
  comptes.json                      utilisateurs (scrypt), clés d'accès (publiques), appareils, sessions (empreintes), abonnements push, carnet par e-mail
  vapid.json                        paire de clés des notifications (engendrée)
  historique/<id>/AAAA-MM-JJ.ndjson un point par ligne
  rapports/<date>-<login>.txt       diagnostics envoyés par l'application, un an (effacés avec le compte)
  audit/AAAA-MM.ndjson              journal d'audit chaîné, 12 mois
  support/acces.json                accès ouverts (clés de session, 0600, effacées à l'échéance)
  support/demandes.json             demandes, messages, notes internes et relances
  support/reponses.json             réponses types de l'équipe
  evenements/<id>/AAAA-MM.ndjson    ce que chaque socle a vécu (frise, alertes)
  atelier.json                      registre de l'atelier (fiches de montage, lots, Wi-Fi du banc chiffré) ; aucun secret de socle
```

Sauvegarde : copier le dossier. Tout est du texte.

## Tests

`npm test` : comptes, droits, appairage, historique, push (service de push
simulé), API, pont vers un broker amont ; comptes en libre-service (code par
e-mail, clés d'accès signées par un authentificateur logiciel, sessions,
export, effacement), client SMTP contre un faux serveur, journal d'audit
(chaîne, ruptures, purge), routes de la console et support (demandes, accès
par clé de session contre un socle factice aux règles du firmware, transfert,
échéance, rôles, frise), carnet du mois par e-mail (mois couvert, résumé,
texte, envoi du 1er, routes du titulaire), atelier (rôle, registre partagé,
conflits, Wi-Fi chiffré, broker, rodage surveillé, alertes groupées) — sur des
ports éphémères. Et depuis
`outils/` : `node test-serveur.js` fait tourner la vraie application (jsdom,
son propre client MQTT) contre le vrai serveur ; `node test-compte.js`,
`node test-console.js` et `node test-support.js` (application, console et socle
simulé ensemble) ouvrent l'application et la console dans Chromium.
