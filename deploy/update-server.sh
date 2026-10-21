#!/usr/bin/env bash
# Actualiza el servidor con lo último de GitHub: baja los repos y reconstruye solo lo que cambió.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh            (todo)
#   bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh web        (solo algunos servicios)
#
# Docker reutiliza las capas que no cambiaron, así que los servicios sin cambios no se recompilan.
# Los datos (base de datos, RabbitMQ, certificados) se conservan.
set -euo pipefail

BRANCH="${BRANCH:-develop}"
INFRA="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Bajando los repos ($BRANCH)"
# si algún repo no se pudo bajar no se construye nada: sería desplegar una mezcla de versiones
if ! BRANCH="$BRANCH" bash "$INFRA/deploy/setup-server.sh" | grep -E "Actualizando|Clonando|fatal|error"; then
  echo "No se actualizó el servidor: revisa el error de arriba y vuelve a correr este script."
  exit 1
fi

cd "$INFRA"
COMPOSE=(sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production --profile app)

# antes de cambiar nada se respalda la base: si una migración nueva sale mal, se puede volver
if sudo docker ps --format '{{.Names}}' | grep -qx lavarapido-sqlserver; then
  echo "== Respaldo de la base antes de actualizar"
  if ! bash "$INFRA/deploy/backup-db.sh"; then
    echo "No se actualizó el servidor: el respaldo falló (revisa el error de arriba)."
    exit 1
  fi
fi

echo "== Construyendo y levantando: ${*:-todos los servicios}"
"${COMPOSE[@]}" up -d --build "$@"

echo "== Estado"
"${COMPOSE[@]}" ps --format "table {{.Name}}\t{{.Status}}"
echo "Listo. Los servicios Java tardan 1-2 minutos en responder después de reiniciar."
