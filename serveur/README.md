# Serveur Terrariums

Un seul processus Node, sans base de données, qui apporte ce qu'un broker seul
ne sait pas faire :

| Besoin | Sans serveur | Avec le serveur |
|---|---|---|
| Droits | un identifiant broker partagé commande tous les socles | comptes utilisateurs, chaque socle rattaché aux comptes qui ont prouvé son code d'appairage |
| Comptes | créés à la main sur le broker | en libre-service : un code par e-mail, puis une clé d'accès (passkey) ; export et effacement par le titulaire |
| Historique | seulement quand l'application est ouverte (IndexedDB) | continu, un point par minute, 400 jours, relu par l'application pour combler ses courbes |
| Notifications | navigateur ouvert, ou ntfy/healthchecks depuis le socle | push sur le téléphone, application fermée : défaut, rétabli, socle disparu, mise à jour en échec |
| Diagnostic | copier-coller | « Envoyer au serveur » |
| Exploitation | — | `/api/flotte` : qui est en ligne, version, signal, dernière mise à jour |

Les socles s'y connectent comme à n'importe quel broker (MQTT TCP ou TLS
derrière un reverse proxy), ou restent sur un broker amont (HiveMQ) que le
serveur **pont** : ce qu'ils y publient entre ici, ce que les applications
commandent ici repart là-bas.

## Démarrer

```sh
cd serveur && npm ci
ADMIN_JETON=$(openssl rand -hex 24) node serveur.js        # HTTP 8080 (API, /mqtt), MQTT 1883
node serveur.js utilisateur ajouter noe 'un mot de passe'   # un compte pour l'application
node serveur.js appareil ajouter terraA1B2C3                # un compte pour un socle : affiche la commande série à taper
```

Ou en conteneur : `docker compose -f serveur/docker-compose.yml up -d` depuis la
racine (voir le fichier pour les variables). Mettre un **reverse proxy TLS**
devant (Caddy fait tout seul le certificat) : l'application n'accepte que
`wss://` hors développement, et le push exige HTTPS.

Dans l'application : adresse du broker `wss://votre-serveur/mqtt`, identifiant
et mot de passe du compte utilisateur. Elle reconnaît le serveur à son annonce
MQTT retenue (`<prefixe>/serveur`, lisible par tout compte, écrite par lui
seul), confirme par `/api/infos`, ouvre une session et, à l'ajout d'un socle,
lui demande de le rattacher : le
serveur interroge le socle avec le code d'appairage et n'accorde les droits que
s'il répond. Un socle appartient à tous ceux qui ont prouvé son code.

## Configuration

Variables d'environnement, ou `serveur/.env` :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 8080 | HTTP : API, MQTT sur WebSocket (`/mqtt`), application si `SERVIR_APP=1` |
| `PORT_MQTT` | 1883 | MQTT TCP pour les socles (`off` pour désactiver) |
| `DONNEES` | `serveur/donnees` | comptes, historique, clés VAPID, rapports |
| `ADMIN_JETON` | — | API d'administration (`Authorization: Bearer`) et utilisateur MQTT `admin` |
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
`POST /api/socles/revendiquer {id, jeton}`, `DELETE /api/socles/:id`,
`GET /api/socles/:id/historique?depuis&jusqua&pas` (même format que le socle :
`[epoch, t1, consigne1, t2, consigne2]` en centièmes), `POST|DELETE
/api/push/abonnement`, `POST /api/push/essai`, `POST /api/rapports` (texte).
Administration : `GET /api/flotte`, `GET /api/admin/comptes`, `POST
/api/admin/utilisateurs`, `POST /api/admin/appareils` (renvoie le mot de passe
engendré), `DELETE /api/admin/appareils/:id`, `POST /api/admin/utilisateurs/:login/socles`.

Dix échecs de connexion par adresse et par quart d'heure bloquent `/api/session`,
`/api/compte/verifier` et `/api/cles/connexion`.
Les sessions durent 30 jours et se prolongent à l'usage (30 jours sans servir
les ferment) ; changer de mot de passe les ferme toutes. Sur le disque, une
session n'est qu'une empreinte SHA-256 de son jeton. Pour un compte ouvert par
e-mail, le jeton de session est aussi le mot de passe présenté au broker
(identifiant : l'adresse e-mail).

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
| `admin` (jeton) | tout | tout |

Une publication interdite déconnecte le client ; un abonnement interdit est
refusé dans le SUBACK (code 128) sans couper la connexion.

## Données

```
donnees/
  comptes.json                      utilisateurs (scrypt), clés d'accès (publiques), appareils, sessions (empreintes), abonnements push
  vapid.json                        paire de clés des notifications (engendrée)
  historique/<id>/AAAA-MM-JJ.ndjson un point par ligne
  rapports/<date>-<login>.txt       diagnostics envoyés par l'application
```

Sauvegarde : copier le dossier. Tout est du texte.

## Tests

`npm test` : comptes, droits, appairage, historique, push (service de push
simulé), API, pont vers un broker amont ; comptes en libre-service (code par
e-mail, clés d'accès signées par un authentificateur logiciel, sessions,
export, effacement) et client SMTP contre un faux serveur — sur des ports
éphémères. Et depuis
`outils/` : `node test-serveur.js` fait tourner la vraie application (jsdom,
son propre client MQTT) contre le vrai serveur.
