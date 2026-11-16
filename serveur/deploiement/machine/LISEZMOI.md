# Déploiement sur une machine Linux (Google Cloud, offre gratuite)

Le serveur Terrariums tourne dans Docker, derrière Traefik, sur une machine
Ubuntu 24.04. La machine `e2-micro` de l'offre gratuite de Google Cloud suffit
(1 Go de mémoire), mais tout Linux avec Docker convient.

| Adresse | Sert à |
|---|---|
| `https://<domaine>` | API, console (`/console/`), MQTT sur WebSocket de l'application (`/mqtt`) |
| `<domaine>:8883` | MQTT chiffré des socles : `mqtt <domaine> 8883 <compte> <mot de passe>`, puis `mqtt tls on` |

Traefik obtient et renouvelle seul le certificat Let's Encrypt (défi HTTP sur
le port 80, qui redirige aussi vers https). Les ports 8080 et 1883 du serveur
ne sortent pas de la machine.

## La machine chez Google Cloud, à 0 €

L'offre gratuite de Google Cloud n'a pas de date de fin, et Google annonce ses
changements 30 jours à l'avance. Elle demande un compte de facturation
« complet », avec une carte, mais ne coûte rien tant qu'on reste dans ses
limites. Une alerte de budget à 1 € prévient par e-mail au moindre écart.

| Réglage | Gratuit | Facturé |
|---|---|---|
| Région | `us-east1`, `us-central1` ou `us-west1` | toute autre région |
| Gabarit | `e2-micro`, une seule machine à la fois | tout autre gabarit |
| Disque | **standard** (`pd-standard`), 30 Go au plus | « équilibré », proposé par défaut |
| IP externe | **éphémère** | IP réservée |
| Niveau réseau | **Standard** : 200 Go sortants par mois | Premium : 1 Go seulement |
| Sauvegardes | Cloud Storage, 5 Go dans les mêmes régions | au-delà |

Création, dans Cloud Shell, projet `<projet>` (la console fait la même chose) :

```sh
gcloud services enable compute.googleapis.com
gcloud compute firewall-rules create terrarium-entrees \
  --allow tcp:80,tcp:443,tcp:8883 --target-tags terrarium
gcloud iam service-accounts create terrarium-machine --display-name "Machine Terrariums"
gcloud compute instances create terrarium --zone us-east1-b --machine-type e2-micro \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-type pd-standard --boot-disk-size 30GB --network-tier STANDARD \
  --tags terrarium --deletion-protection \
  --service-account terrarium-machine@<projet>.iam.gserviceaccount.com --scopes cloud-platform \
  --metadata ssh-keys="ubuntu:$(cat <clé publique>)"
```

Le compte de service de la machine n'a aucun rôle, sauf celui d'écrire dans
le bucket des sauvegardes (plus bas). Si la machine était compromise, elle ne
donnerait accès à rien d'autre dans le projet.

L'IP externe s'inscrit sur [duckdns.org](https://www.duckdns.org), au nom
choisi (par exemple `exotic-world.duckdns.org`). Elle ne change que si la
machine est arrêtée puis relancée, pas à un simple redémarrage.
`regler-duckdns.sh` la tient à jour tout seul (voir plus bas).

## Avant de commencer

- Une machine Ubuntu 24.04 joignable sur les ports 80, 443 et 8883 (chez
  Google Cloud : la règle de pare-feu `terrarium-entrees` et le tag
  `terrarium`).
- Un nom qui pointe sur son IP publique, par exemple un sous-domaine DuckDNS
  gratuit (`exotic-world.duckdns.org`).
- L'adresse de l'application (`https://soclechauffant.netlify.app`) : seule
  origine autorisée de l'API, et domaine des clés d'accès (`RP_ID`).

## Installer

```sh
sudo git clone https://github.com/NoeMrct/terrarium_thermostat /opt/terrarium/depot
sudo bash /opt/terrarium/depot/serveur/deploiement/machine/installer.sh \
  --domaine exotic-world.duckdns.org \
  --site https://soclechauffant.netlify.app --email vous@exemple.fr \
  --nom "Exotic World"                                         # nom d'expéditeur des e-mails
sudo bash /opt/terrarium/regler-smtp.sh <identifiant SMTP>    # la clé est demandée sans écho
sudo bash /opt/terrarium/regler-duckdns.sh exotic-world        # facultatif, le jeton est demandé sans écho
sudo bash /opt/terrarium/essai-bout-en-bout.sh
```

`installer.sh` installe Docker, écrit `/opt/terrarium` (fichiers ci-dessous),
engendre le jeton d'administration, construit l'image, démarre le serveur et
Traefik, puis programme la sauvegarde nocturne. Relancé, il met tout à jour
sans toucher aux données ni aux secrets. Sur une `e2-micro`, la première
construction de l'image prend plusieurs minutes : le processeur n'est garanti
qu'au quart d'un cœur.

Enfin, dans Netlify : variable d'environnement `TERRARIUM_SERVEUR` =
`https://<domaine>`, puis un nouveau déploiement. `outils/preparer-publication.js`
écrit alors l'adresse dans la balise `<meta name="terrarium-serveur">` de
l'application publiée : « Se connecter » mène droit au compte.

## Sur la machine

| Chemin | Contenu |
|---|---|
| `/opt/terrarium/depot` | clone du dépôt |
| `/opt/terrarium/compose.yml`, `traefik/` | services et routes |
| `/opt/terrarium/.env` (root, 600) | variables du serveur, dont les secrets `ADMIN_JETON` et `SMTP_URL` |
| `/opt/terrarium/duckdns` (root, 600) | sous-domaine et jeton DuckDNS, si `regler-duckdns.sh` a servi |
| `/opt/terrarium/acme/acme.json` | certificats |
| volume Docker `terrarium_donnees` | données du serveur : comptes, historique, journal d'audit, support |
| `/opt/terrarium/sauvegardes` | archives de chaque nuit, 14 jours |
| `/opt/terrarium/parametres` | domaine, application, e-mail, nom d'expéditeur |

## Au quotidien

- Journaux : `cd /opt/terrarium && sudo docker compose logs -f --tail 100`
- Redémarrer : `cd /opt/terrarium && sudo docker compose restart`
- Mettre à jour depuis `main` : `sudo bash /opt/terrarium/mettre-a-jour.sh`
- Jeton d'administration (page Atelier) : `sudo grep '^ADMIN_JETON=' /opt/terrarium/.env`,
  à ranger dans un gestionnaire de mots de passe.
- Nommer un administrateur. La ligne de commande écrit le fichier des comptes,
  qu'un serveur en marche réécrirait : on l'arrête le temps de la commande.

  ```sh
  cd /opt/terrarium && sudo docker compose stop terrarium
  sudo docker compose run --rm terrarium node serveur/serveur.js utilisateur admin <e-mail> oui
  sudo docker compose start terrarium
  ```
- Sauvegarder à la main et restaurer : voir l'en-tête de `sauvegarder.sh`.

## Copie des sauvegardes hors de la machine

Un bucket Cloud Storage privé, dans la région de la machine. La machine
l'écrit avec son compte de service, grâce au jeton que lui donne le serveur de
métadonnées de Google Cloud : aucun identifiant n'est stocké sur la machine.

1. Un bucket `<projet>-sauvegardes` : région `us-east1`, classe Standard,
   accès uniforme, accès public empêché. Une règle de cycle de vie supprime
   les objets au bout de 30 jours.
2. Sur ce bucket seulement, le rôle « Créateur des objets Storage »
   (`roles/storage.objectCreator`) pour `terrarium-machine@<projet>.iam.gserviceaccount.com`.
   Ce rôle permet d'ajouter une archive, mais pas d'en lire, d'en remplacer ni
   d'en effacer.
3. Sur la machine :

   ```sh
   echo BUCKET=<projet>-sauvegardes | sudo tee /opt/terrarium/sauvegarde-distante
   sudo bash /opt/terrarium/sauvegarder.sh
   ```

## Offre gratuite de Google Cloud : à savoir

- Ne changer ni la région, ni le gabarit, ni le type de disque. Ne pas réserver
  l'IP, et ne pas passer le réseau en Premium : chacun de ces choix est facturé.
- L'`e2-micro` n'a qu'1 Go de mémoire. `installer.sh` ajoute 2 Go d'échange,
  et le serveur, Traefik et Docker tiennent dans cette mémoire.
- Le port 25 sortant est bloqué : les e-mails partent par Brevo, sur le
  port 587 (`regler-smtp.sh`).
- Arrêter la machine change son IP. Il faut alors corriger DuckDNS, sauf si
  `regler-duckdns.sh` a servi.
