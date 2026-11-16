#!/usr/bin/env bash
# =============================================================================
# Règle l'envoi des e-mails du serveur (codes de connexion, carnet du mois) :
# écrit SMTP_URL dans /opt/terrarium/.env puis redémarre le serveur.
#
#   sudo bash /opt/terrarium/regler-smtp.sh <identifiant SMTP> [hôte:port]
#
# L'identifiant (Brevo : xxxxxx@smtp-brevo.com) n'est pas secret ; la clé SMTP
# est demandée sans écho, ne passe ni en argument ni dans l'historique, et
# n'est jamais affichée. Elle peut aussi arriver par l'entrée standard, par
# exemple depuis le presse-papiers d'un PC Windows, quand la console ne sait pas
# coller dans une session SSH :
#   (Get-Clipboard).Trim() | ssh <machine> "sudo bash /opt/terrarium/regler-smtp.sh <identifiant>"
# Les retours chariot et espaces autour sont retirés ; une valeur qui n'a pas
# l'allure d'une clé (moins de 12 caractères, espace, caractère de contrôle)
# est refusée sans rien changer. Port 587 avec STARTTLS par défaut : le port 25 sortant
# est bloqué chez Google Cloud, et le serveur exige STARTTLS sur smtp://.
# =============================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo." >&2; exit 1; }
IDENTIFIANT=${1:?"usage : sudo bash $0 <identifiant SMTP> [hôte:port]"}
HOTE=${2:-smtp-relay.brevo.com:587}
ENV=/opt/terrarium/.env

CLE=''
read -rsp "Clé SMTP (rien ne s'affiche : colle-la puis appuie sur Entrée) : " CLE || true
echo
CLE=${CLE//$'\r'/}
CLE=${CLE#"${CLE%%[![:space:]]*}"}
CLE=${CLE%"${CLE##*[![:space:]]}"}
[[ $CLE =~ ^[[:graph:]]{12,256}$ ]] || { CLE=''; echo "Ce n'est pas une clé SMTP (12 caractères au moins, sans espace) : rien n'a changé." >&2; exit 1; }

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
