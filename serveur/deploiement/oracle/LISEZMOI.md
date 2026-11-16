# Déploiement sur une machine Oracle Cloud (offre gratuite)

Le serveur Terrariums tourne dans Docker, derrière Traefik, sur une machine
Ubuntu 24.04. Une machine « Always Free » d'Oracle Cloud suffit (gabarit Arm
`VM.Standard.A1.Flex`, 1 OCPU et 2 Go), mais tout Linux avec Docker convient.

| Adresse | Sert à |
|---|---|
| `https://<domaine>` | API, console (`/console/`), MQTT sur WebSocket de l'application (`/mqtt`) |
| `<domaine>:8883` | MQTT chiffré des socles : `mqtt <domaine> 8883 <compte> <mot de passe>`, puis `mqtt tls on` |

Traefik obtient et renouvelle seul le certificat Let's Encrypt (défi HTTP sur
le port 80, qui redirige aussi vers https). Les ports 8080 et 1883 du serveur
ne sortent pas de la machine.

## Avant de commencer

- Une machine Ubuntu 24.04 joignable sur les ports 80, 443 et 8883 (chez
  Oracle : liste de sécurité du réseau virtuel).
- Un nom qui pointe sur son IP publique, par exemple un sous-domaine DuckDNS
  gratuit (`socle-chauffant.duckdns.org`).
- L'adresse de l'application (`https://soclechauffant.netlify.app`) : seule
  origine autorisée de l'API, et domaine des clés d'accès (`RP_ID`).

## Installer

```sh
sudo git clone https://github.com/NoeMrct/terrarium_thermostat /opt/terrarium/depot
sudo bash /opt/terrarium/depot/serveur/deploiement/oracle/installer.sh \
  --domaine socle-chauffant.duckdns.org \
  --site https://soclechauffant.netlify.app --email vous@exemple.fr
sudo bash /opt/terrarium/regler-smtp.sh <identifiant SMTP>    # la clé est demandée sans écho
sudo bash /opt/terrarium/essai-bout-en-bout.sh
```

`installer.sh` installe Docker, écrit `/opt/terrarium` (fichiers ci-dessous),
engendre le jeton d'administration, construit l'image, démarre le serveur et
Traefik, puis programme la sauvegarde nocturne. Relancé, il met tout à jour
sans toucher aux données ni aux secrets.

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
| `/opt/terrarium/acme/acme.json` | certificats |
| volume Docker `terrarium_donnees` | données du serveur : comptes, historique, journal d'audit, support |
| `/opt/terrarium/sauvegardes` | archives de chaque nuit, 14 jours |
| `/opt/terrarium/parametres` | domaine, application, e-mail |

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

Un bucket Object Storage privé (20 Go dans l'offre gratuite), écrit par la
machine elle-même grâce à son principal d'instance : aucun identifiant n'est
stocké.

1. Console Oracle : un bucket privé `terrarium-sauvegardes`, avec une règle de
   cycle de vie qui supprime les objets au bout de 30 jours.
2. Un groupe dynamique qui ne contient que cette instance
   (`instance.id = '<OCID de l'instance>'`), et une politique :
   `Allow dynamic-group '<domaine d'identité>'/'<groupe>' to manage objects in tenancy where target.bucket.name = 'terrarium-sauvegardes'`.
3. Sur la machine :

   ```sh
   sudo apt-get install -y python3-venv
   sudo python3 -m venv /opt/terrarium/oci
   sudo /opt/terrarium/oci/bin/pip install oci-cli
   echo BUCKET=terrarium-sauvegardes | sudo tee /opt/terrarium/sauvegarde-distante
   sudo bash /opt/terrarium/sauvegarder.sh
   ```

## Offre gratuite d'Oracle : à savoir

- Oracle peut récupérer une machine « Always Free » qui paraît inoccupée sept
  jours de suite : processeur (95e centile), réseau et, pour le gabarit Arm,
  mémoire, tous sous 20 %. Avec 2 Go, Docker, Traefik et le serveur restent
  au-dessus du seuil de mémoire : ne pas agrandir la machine sans raison.
- Un compte inactif 30 jours peut être suspendu : se connecter à la console
  Oracle au moins une fois par mois.
- Une alarme Monitoring (absence de mesures du processeur pendant 10 minutes)
  prévient par e-mail si la machine s'arrête.
