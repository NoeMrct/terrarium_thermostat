#!/usr/bin/env bash
# =============================================================================
# Donne à DuckDNS l'IP publique de la machine (celle d'où part la requête).
# Lancé toutes les 5 minutes par terrarium-duckdns.timer, que regler-duckdns.sh
# met en place. Le jeton passe à curl par son entrée standard : il n'apparaît
# ni dans la liste des processus ni dans les journaux.
# =============================================================================
set -euo pipefail
SOUS_DOMAINE='' JETON=''
# shellcheck source=/dev/null
. /opt/terrarium/duckdns
REPONSE=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s"\n' "$SOUS_DOMAINE" "$JETON" |
  curl -fsS -m 30 -K -)
JETON=''
[ "$REPONSE" = OK ] || { echo "DuckDNS a refusé la mise à jour (réponse : $REPONSE)" >&2; exit 1; }
