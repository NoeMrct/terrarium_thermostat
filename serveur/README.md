# Serveur Terrariums

Un seul processus Node, sans base de données, qui apporte ce qu'un broker seul
ne sait pas faire :

| Besoin | Sans serveur | Avec le serveur |
|---|---|---|
| Droits | un identifiant broker partagé commande tous les socles | comptes utilisateurs, chaque socle rattaché aux comptes qui ont prouvé son code d'appairage |
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

## API

Publique : `GET /api/infos`, `POST /api/session {login, motDePasse}` → `{jeton}`,
`GET /api/push/cle`.
Session (`Authorization: Bearer <jeton>`) : `GET /api/moi`,
`POST /api/socles/revendiquer {id, jeton}`, `DELETE /api/socles/:id`,
`GET /api/socles/:id/historique?depuis&jusqua&pas` (même format que le socle :
`[epoch, t1, consigne1, t2, consigne2]` en centièmes), `POST|DELETE
/api/push/abonnement`, `POST /api/push/essai`, `POST /api/rapports` (texte).
Administration : `GET /api/flotte`, `GET /api/admin/comptes`, `POST
/api/admin/utilisateurs`, `POST /api/admin/appareils` (renvoie le mot de passe
engendré), `DELETE /api/admin/appareils/:id`, `POST /api/admin/utilisateurs/:login/socles`.

Dix échecs de connexion par adresse et par quart d'heure bloquent `/api/session`.
Les sessions durent 30 jours ; changer de mot de passe les ferme toutes.

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
  comptes.json                      utilisateurs (scrypt), appareils, sessions, abonnements push
  vapid.json                        paire de clés des notifications (engendrée)
  historique/<id>/AAAA-MM-JJ.ndjson un point par ligne
  rapports/<date>-<login>.txt       diagnostics envoyés par l'application
```

Sauvegarde : copier le dossier. Tout est du texte.

## Tests

`npm test` : comptes, droits, appairage, historique, push (service de push
simulé), API, pont vers un broker amont — sur des ports éphémères. Et depuis
`outils/` : `node test-serveur.js` fait tourner la vraie application (jsdom,
son propre client MQTT) contre le vrai serveur.
