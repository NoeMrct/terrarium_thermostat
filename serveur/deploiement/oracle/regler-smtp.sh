#!/usr/bin/env bash
# =============================================================================
# Règle l'envoi des e-mails du serveur (codes de connexion, carnet du mois) :
# écrit SMTP_URL dans /opt/terrarium/.env puis redémarre le serveur.
#
#   sudo bash /opt/terrarium/regler-smtp.sh <identifiant SMTP> [hôte:port]
#
# L'identifiant (Brevo : xxxxxx@smtp-brevo.com) n'est pas secret ; la clé SMTP
# est demandée sans écho, ne passe ni en argument ni dans l'historique, et
# n'est jamais affichée. Port 587 avec STARTTLS par défaut : le port 25 sortant
# est bloqué chez Oracle, et le serveur exige STARTTLS sur smtp://.
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo." >&2; exit 1; }
IDENTIFIANT=${1:?"usage : sudo bash $0 <identifiant SMTP> [hôte:port]"}
HOTE=${2:-smtp-relay.brevo.com:587}
ENV=/opt/terrarium/.env

read -rsp "Clé SMTP (rien ne s'affiche : colle-la puis appuie sur Entrée) : " CLE
echo
[ -n "$CLE" ] || { echo "Clé vide : rien n'a changé." >&2; exit 1; }

encoder() { python3 -c 'import sys, urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))'; }
U=$(printf '%s' "$IDENTIFIANT" | encoder)
K=$(printf '%s' "$CLE" | encoder)
CLE=''

umask 077
TMP=$(mktemp "$ENV.XXXXXX")
grep -v '^SMTP_URL=' "$ENV" > "$TMP" || true
printf 'SMTP_URL=smtp://%s:%s@%s\n' "$U" "$K" "$HOTE" >> "$TMP"
K=''
chmod 600 "$TMP"
mv "$TMP" "$ENV"

cd /opt/terrarium
docker compose up -d --force-recreate terrarium >/dev/null 2>&1
echo "SMTP réglé, serveur redémarré."
