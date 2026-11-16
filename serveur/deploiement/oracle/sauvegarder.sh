#!/usr/bin/env bash
# =============================================================================
# Archive les données du serveur (volume terrarium_donnees) dans
# /opt/terrarium/sauvegardes, 14 jours gardés. Si /opt/terrarium/sauvegarde-distante
# existe (BUCKET=…) et que la CLI OCI est installée dans /opt/terrarium/oci,
# l'archive est aussi copiée dans ce bucket Object Storage, authentifiée par le
# principal d'instance : aucun identifiant sur la machine.
#
# Lancé chaque nuit par terrarium-sauvegarde.timer ; à la main :
#   sudo bash /opt/terrarium/sauvegarder.sh
#
# Restaurer une archive (serveur arrêté le temps de l'opération) :
#   cd /opt/terrarium && sudo docker compose stop terrarium
#   sudo docker run --rm -v terrarium_donnees:/d -v /opt/terrarium/sauvegardes:/s:ro alpine:3.20 \
#     sh -c 'find /d -mindepth 1 -delete && tar xzf /s/<archive> -C /d'
#   sudo docker compose start terrarium
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

if [ -f "$DOSSIER/sauvegarde-distante" ] && [ -x "$DOSSIER/oci/bin/oci" ]; then
  # shellcheck source=/dev/null
  . "$DOSSIER/sauvegarde-distante"
  "$DOSSIER/oci/bin/oci" os object put --auth instance_principal --bucket-name "$BUCKET" \
    --file "$CIBLE/$NOM" --name "$NOM" --no-multipart >/dev/null
  echo "Sauvegarde : $NOM (et copie dans le bucket $BUCKET)"
else
  echo "Sauvegarde : $NOM (sur la machine seulement)"
fi
