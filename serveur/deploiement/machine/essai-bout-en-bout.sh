#!/usr/bin/env bash
# =============================================================================
# Essai de bout en bout, sur la machine : HTTPS (certificat vérifié), puis MQTT
# chiffré sur 8883 et MQTT sur WebSocket (wss://…/mqtt), avec un compte
# d'appareil d'essai (terraESSAI1) créé pour l'occasion et retiré à la fin.
# Tout passe par Traefik en local, sous le vrai nom du serveur.
#
#   sudo bash /opt/terrarium/essai-bout-en-bout.sh
#
# Aucun secret n'est affiché ni passé en argument : le jeton d'administration
# va à curl par son entrée standard, le mot de passe d'essai au conteneur par
# une variable d'environnement.
# =============================================================================
set -euo pipefail
DOSSIER=/opt/terrarium
# shellcheck source=/dev/null
. "$DOSSIER/parametres"
ID=terraESSAI1
JETON=$(sed -n 's/^ADMIN_JETON=//p' "$DOSSIER/.env")
[ -n "$JETON" ] || { echo "ADMIN_JETON absent de $DOSSIER/.env" >&2; exit 1; }
RESOUDRE=(--resolve "$DOMAINE:443:127.0.0.1")
ECHECS=0
ok() { echo "  OK      $1"; }
ko() { echo "  ÉCHEC   $1"; ECHECS=$((ECHECS + 1)); }
api() { # api MÉTHODE CHEMIN [CORPS JSON]
  printf 'header = "Authorization: Bearer %s"\n' "$JETON" |
    curl -fsS "${RESOUDRE[@]}" -K - -X "$1" -H 'Content-Type: application/json' ${3:+--data "$3"} "https://$DOMAINE$2"
}
retirer() { api DELETE "/api/admin/appareils/$ID" "{\"confirmation\":\"$ID\"}" >/dev/null 2>&1 || true; }

echo "Essai de bout en bout de https://$DOMAINE"
if curl -fsS "${RESOUDRE[@]}" -o /dev/null "https://$DOMAINE/api/infos"; then ok "API publique en HTTPS, certificat valide"; else ko "API publique en HTTPS"; fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAINE:80:127.0.0.1" "http://$DOMAINE/api/infos")" = 301 ] ||
   [ "$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAINE:80:127.0.0.1" "http://$DOMAINE/api/infos")" = 308 ]; then
  ok "http:// redirige vers https://"
else ko "redirection de http:// vers https://"; fi

trap retirer EXIT
if REPONSE=$(api POST /api/admin/appareils "{\"id\":\"$ID\"}"); then
  ok "compte d'appareil d'essai créé par l'API d'administration"
  ESSAI_MDP=$(printf '%s' "$REPONSE" | python3 -c 'import sys, json; sys.stdout.write(json.load(sys.stdin)["motDePasse"])')
  REPONSE=''
  export DOMAINE ESSAI_ID=$ID ESSAI_MDP
  docker run --rm --network host -e DOMAINE -e ESSAI_ID -e ESSAI_MDP terrarium-serveur:local \
    node serveur/deploiement/machine/essai-mqtt.js || ECHECS=$((ECHECS + 1))
  unset ESSAI_MDP
else
  ko "création du compte d'essai (jeton d'administration refusé ?)"
fi
retirer
trap - EXIT
if api GET /api/admin/appareils | grep -q "\"$ID\""; then ko "compte d'essai toujours présent"; else ok "compte d'essai retiré"; fi

if [ "$ECHECS" = 0 ]; then echo "=== TOUT FONCTIONNE ==="; else echo "=== $ECHECS ÉCHEC(S) ==="; exit 1; fi
