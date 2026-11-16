#!/usr/bin/env bash
# =============================================================================
# Archive les données du serveur (volume terrarium_donnees) dans
# /opt/terrarium/sauvegardes, 14 jours gardés. Si /opt/terrarium/sauvegarde-distante
# existe (BUCKET=…), l'archive est aussi copiée dans ce bucket Cloud Storage
# avec le compte de service de la machine Google Cloud : le jeton vient du
# serveur de métadonnées, aucun identifiant n'est stocké sur la machine.
#
# Lancé chaque nuit par terrarium-sauvegarde.timer ; à la main :
#   sudo bash /opt/terrarium/sauvegarder.sh
#
# Restaurer une archive (serveur arrêté le temps de l'opération) :
#   cd /opt/terrarium && sudo docker compose stop terrarium
#   sudo docker run --rm -v terrarium_donnees:/d -v /opt/terrarium/sauvegardes:/s:ro alpine:3.20 \
#     sh -c 'find /d -mindepth 1 -delete && tar xzf /s/<archive> -C /d'
#   sudo docker compose start terrarium
# Une archive du bucket se récupère d'abord dans /opt/terrarium/sauvegardes
# (console Google Cloud, Cloud Storage, ou « gcloud storage cp »).
# =============================================================================
set -euo pipefail
DOSSIER=/opt/terrarium
CIBLE=$DOSSIER/sauvegardes
install -d -m 700 "$CIBLE"
NOM=donnees-$(date -u +%Y%m%dT%H%M%SZ).tar.gz

docker run --rm -v terrarium_donnees:/donnees:ro -v "$CIBLE":/sauvegardes alpine:3.20 \
  tar czf "/sauvegardes/$NOM" -C /donnees .
chmod 600 "$CIBLE/$NOM"
find "$CIBLE" -name 'donnees-*.tar.gz' -mtime +14 -delete

if [ ! -f "$DOSSIER/sauvegarde-distante" ]; then
  echo "Sauvegarde : $NOM (sur la machine seulement)"
  exit 0
fi
BUCKET=''
# shellcheck source=/dev/null
. "$DOSSIER/sauvegarde-distante"
[[ $BUCKET =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || { echo "BUCKET invalide dans $DOSSIER/sauvegarde-distante" >&2; exit 1; }
JETON=$(curl -fsS -m 10 -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token |
  python3 -c 'import sys, json; sys.stdout.write(json.load(sys.stdin)["access_token"])')
# Le jeton passe à curl par son entrée standard : ni argument, ni journal.
printf 'header = "Authorization: Bearer %s"\n' "$JETON" |
  curl -fsS -m 300 -K - -X POST -H 'Content-Type: application/gzip' --data-binary "@$CIBLE/$NOM" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$NOM" >/dev/null
JETON=''
echo "Sauvegarde : $NOM (et copie dans le bucket $BUCKET)"
