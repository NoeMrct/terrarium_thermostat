#!/usr/bin/env bash
# =============================================================================
# Met le serveur à jour depuis la branche main : récupère le dépôt, puis relance
# installer.sh avec les mêmes paramètres (reconstruction de l'image). Les
# données (volume) et les secrets (.env) restent.
#   sudo bash /opt/terrarium/mettre-a-jour.sh
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo." >&2; exit 1; }
git -C /opt/terrarium/depot pull --ff-only
exec bash /opt/terrarium/depot/serveur/deploiement/oracle/installer.sh
