#!/usr/bin/env sh
# Installe les bibliothèques du firmware aux versions exactes de bibliotheques.txt,
# sans tirer de dépendances « dernière version » derrière (--no-deps : la liste
# est complète). Même liste pour la CI, la release et un poste de développement :
#   sh outils/installer-bibliotheques.sh
set -eu
ici=$(dirname "$0")
grep -v '^#' "$ici/bibliotheques.txt" | grep -v '^$' | while IFS= read -r bib; do
  arduino-cli lib install --no-deps "$bib"
done
arduino-cli lib list
