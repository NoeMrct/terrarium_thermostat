#!/usr/bin/env bash
# =============================================================================
# Installe ou met à jour le serveur Terrariums sur une machine Ubuntu 24.04,
# derrière Traefik : https://<domaine> (API, console /console/, MQTT sur
# WebSocket /mqtt) et MQTT chiffré pour les socles sur <domaine>:8883.
#
# Première installation, en root, depuis un clone du dépôt dans /opt/terrarium :
#
#   sudo git clone https://github.com/NoeMrct/terrarium_thermostat /opt/terrarium/depot
#   sudo bash /opt/terrarium/depot/serveur/deploiement/oracle/installer.sh \
#        --domaine socle-chauffant.duckdns.org \
#        --site https://soclechauffant.netlify.app --email vous@exemple.fr
#
# --site est l'origine de l'application (Netlify) : origine autorisée de l'API
# et domaine des clés d'accès. Relancé sans paramètre, le script reprend ceux
# de /opt/terrarium/parametres (c'est ce que fait mettre-a-jour.sh).
#
# Il ne touche jamais à un secret existant : ADMIN_JETON est engendré une seule
# fois, SMTP_URL ne s'écrit que par regler-smtp.sh, et rien n'est affiché.
# =============================================================================
set -euo pipefail

DOSSIER=/opt/terrarium
ICI=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "À lancer en root (sudo)." >&2; exit 1; }

DOMAINE='' SITE='' EMAIL=''
# shellcheck source=/dev/null
[ -f "$DOSSIER/parametres" ] && . "$DOSSIER/parametres"
while [ $# -gt 0 ]; do
  case "$1" in
    --domaine) DOMAINE=${2:-}; shift 2 ;;
    --site) SITE=${2%/}; shift 2 ;;
    --email) EMAIL=${2:-}; shift 2 ;;
    *) echo "Paramètre inconnu : $1" >&2; exit 2 ;;
  esac
done
[[ $DOMAINE =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "--domaine : nom d'hôte attendu (socle-chauffant.duckdns.org)" >&2; exit 2; }
[[ $SITE =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ ]] || { echo "--site : origine https:// de l'application attendue" >&2; exit 2; }
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]+$ ]] || { echo "--email : adresse e-mail attendue" >&2; exit 2; }
HOTE_APP=${SITE#https://}; HOTE_APP=${HOTE_APP%%:*}

echo "== Paquets (Docker, Git, mises à jour de sécurité automatiques)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 docker-buildx git python3 ca-certificates curl openssl unattended-upgrades >/dev/null
systemctl enable --now docker >/dev/null 2>&1
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# Petite machine (1 Go, gabarit AMD de secours) : 2 Go d'échange pour la
# construction de l'image.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  echo "== Fichier d'échange de 2 Go"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Fichiers dans $DOSSIER"
umask 022
install -d -m 755 "$DOSSIER" "$DOSSIER/traefik"
install -d -m 700 "$DOSSIER/acme" "$DOSSIER/sauvegardes"
printf 'DOMAINE=%s\nSITE=%s\nEMAIL=%s\n' "$DOMAINE" "$SITE" "$EMAIL" > "$DOSSIER/parametres"
install -m 644 "$ICI/compose.yml" "$DOSSIER/compose.yml"
sed "s|__EMAIL__|$EMAIL|g" "$ICI/traefik/traefik.yml.modele" > "$DOSSIER/traefik/traefik.yml"
sed "s|__DOMAINE__|$DOMAINE|g" "$ICI/traefik/dynamique.yml.modele" > "$DOSSIER/traefik/dynamique.yml"
for s in sauvegarder.sh regler-smtp.sh essai-bout-en-bout.sh mettre-a-jour.sh; do
  install -m 700 "$ICI/$s" "$DOSSIER/$s"
done

echo "== Variables du serveur ($DOSSIER/.env, root, 600)"
umask 077
touch "$DOSSIER/.env"
chmod 600 "$DOSSIER/.env"
regler() { # regler NOM VALEUR : remplace ou ajoute la ligne, sans rien afficher
  local tmp
  tmp=$(mktemp "$DOSSIER/.env.XXXXXX")
  grep -v "^$1=" "$DOSSIER/.env" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$DOSSIER/.env"
}
grep -q '^ADMIN_JETON=' "$DOSSIER/.env" || regler ADMIN_JETON "$(openssl rand -hex 24)"
regler ORIGINES "$SITE"
regler RP_ID "$HOTE_APP"
regler CONTACT_VAPID "mailto:$EMAIL"
regler COURRIEL_DE "Terrariums <$EMAIL>"
regler TZ "Europe/Paris"
umask 022

echo "== Démarrage (construction de l'image, puis certificats Let's Encrypt)"
cd "$DOSSIER"
docker compose up -d --build --remove-orphans

echo "== Sauvegarde chaque nuit"
cat > /etc/systemd/system/terrarium-sauvegarde.service <<EOF
[Unit]
Description=Sauvegarde des données du serveur Terrariums
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash $DOSSIER/sauvegarder.sh
EOF
cat > /etc/systemd/system/terrarium-sauvegarde.timer <<'EOF'
[Unit]
Description=Sauvegarde nocturne du serveur Terrariums

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now terrarium-sauvegarde.timer >/dev/null 2>&1

grep -q '^SMTP_URL=' "$DOSSIER/.env" && SMTP="réglé" || SMTP="à régler : sudo bash $DOSSIER/regler-smtp.sh <identifiant SMTP>"
cat <<EOF

Serveur : https://$DOMAINE        console : https://$DOMAINE/console/
Socles  : $DOMAINE, port 8883, TLS (« mqtt $DOMAINE 8883 <compte> <mot de passe> » puis « mqtt tls on »)
E-mails : $SMTP
Essai   : sudo bash $DOSSIER/essai-bout-en-bout.sh
EOF
