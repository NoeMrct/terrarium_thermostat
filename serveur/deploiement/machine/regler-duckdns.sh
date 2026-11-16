#!/usr/bin/env bash
# =============================================================================
# Garde le nom DuckDNS du serveur pointé sur l'IP publique de la machine :
# demande le jeton DuckDNS sans écho, le range dans /opt/terrarium/duckdns
# (root, 600), puis programme duckdns.sh toutes les 5 minutes
# (terrarium-duckdns.timer).
#
#   sudo bash /opt/terrarium/regler-duckdns.sh <sous-domaine>     # ex. exotic-world
#
# Facultatif : l'IP éphémère d'une machine Google Cloud ne change que si la
# machine est arrêtée puis relancée, pas à un redémarrage. Ce réglage évite
# alors d'avoir à corriger l'IP à la main sur duckdns.org.
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo." >&2; exit 1; }
SOUS_DOMAINE=${1:?"usage : sudo bash $0 <sous-domaine DuckDNS, sans .duckdns.org>"}
SOUS_DOMAINE=${SOUS_DOMAINE%.duckdns.org}
[[ $SOUS_DOMAINE =~ ^[a-z0-9-]+$ ]] || { echo "Sous-domaine attendu : lettres, chiffres et tirets." >&2; exit 2; }
DOSSIER=/opt/terrarium

read -rsp "Jeton DuckDNS (rien ne s'affiche : colle-le puis appuie sur Entrée) : " JETON
echo
[[ $JETON =~ ^[0-9a-f-]{36}$ ]] || { echo "Ce n'est pas un jeton DuckDNS (36 caractères, en haut de duckdns.org) : rien n'a changé." >&2; exit 1; }
umask 077
printf 'SOUS_DOMAINE=%s\nJETON=%s\n' "$SOUS_DOMAINE" "$JETON" > "$DOSSIER/duckdns"
JETON=''
chmod 600 "$DOSSIER/duckdns"

cat > /etc/systemd/system/terrarium-duckdns.service <<EOF
[Unit]
Description=Met à jour l'IP du nom DuckDNS du serveur Terrariums
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $DOSSIER/duckdns.sh
EOF
cat > /etc/systemd/system/terrarium-duckdns.timer <<'EOF'
[Unit]
Description=Mise à jour DuckDNS du serveur Terrariums, toutes les 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now terrarium-duckdns.timer >/dev/null 2>&1
bash "$DOSSIER/duckdns.sh"
echo "DuckDNS réglé : $SOUS_DOMAINE.duckdns.org suit l'IP de la machine."
