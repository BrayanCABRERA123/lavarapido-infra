#!/usr/bin/env bash
# Imprime el commit actual de cada repo de LavaRápido, uno por línea ("repo commit").
# update-server.sh lo guarda cuando una actualización completa termina bien, y boot-update.sh lo
# compara al encender la VM para saber si quedó algo sin desplegar.
#
#   bash repo-heads.sh ~/lavarapido
set -euo pipefail

ROOT="${1:?Uso: repo-heads.sh <carpeta con los repos>}"

for repo in "$ROOT"/*/; do
  if [ -d "${repo}.git" ]; then echo "$(basename "$repo") $(git -C "$repo" rev-parse --short HEAD)"; fi
done
