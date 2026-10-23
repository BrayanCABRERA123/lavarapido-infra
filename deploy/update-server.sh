#!/usr/bin/env bash
# Actualiza el servidor con lo último de GitHub: baja los repos y reconstruye solo lo que cambió.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh            (todo)
#   bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh web        (solo algunos servicios)
#
# Docker reutiliza las capas que no cambiaron, así que los servicios sin cambios no se recompilan.
# Los datos (base de datos, RabbitMQ, certificados) se conservan.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$INFRA")"

# la rama de cada repo la decide setup-server.sh (main, salvo los que aún no tienen versión);
# BRANCH=develop bash update-server.sh la cambia para todos
echo "== Bajando los repos"
# si algún repo no se pudo bajar no se construye nada: sería desplegar una mezcla de versiones
if ! bash "$INFRA/deploy/setup-server.sh" | grep -E "Actualizando|Clonando|fatal|error"; then
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

# el Caddyfile se monta como archivo suelto: cuando git lo reemplaza, el contenedor sigue viendo el
# viejo y "up" no lo recrea. Si lo que ve Caddy no es lo del repo, se reinicia para que lo lea.
if ! sudo docker exec lavarapido-caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$INFRA/deploy/Caddyfile"; then
  echo "== El Caddyfile cambió: reiniciando Caddy"
  "${COMPOSE[@]}" restart caddy
fi

# up -d no espera a que los servicios arranquen: si alguno no queda sano (p. ej. una migración que
# falla y lo deja reiniciándose), la actualización termina con error en vez de darse por buena.
# Los Java tardan 1-2 minutos (start_period 150 s y chequeo cada 30 s), así que se espera hasta 8.
CONTAINERS=(sqlserver rabbitmq security-service customer-service booking-service operations-service
  notification-service payment-service api-gateway web caddy)
not_healthy() {
  local name status health
  for name in "${CONTAINERS[@]}"; do
    read -r status health < <(sudo docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "lavarapido-$name" 2>/dev/null || echo "no-existe")
    if [ "$status" != running ] || { [ -n "$health" ] && [ "$health" != healthy ]; }; then
      echo "$name (${health:-$status})"
    fi
  done
}
echo "== Esperando a que los servicios queden sanos"
pending=""
for _ in $(seq 1 48); do
  pending="$(not_healthy)"
  [ -z "$pending" ] && break
  sleep 10
done

echo "== Estado"
"${COMPOSE[@]}" ps --format "table {{.Name}}\t{{.Status}}"
if [ -n "$pending" ]; then
  echo "Error: estos servicios no quedaron sanos en 8 minutos:"
  echo "$pending" | sed 's/^/  /'
  echo "Revisa su log con: sudo docker logs --tail 100 lavarapido-<servicio>"
  exit 1
fi

# se anota qué quedó desplegado, solo si se actualizó todo: boot-update.sh compara contra esto,
# así una actualización que falló a mitad (o una parcial) se completa al encender la VM
if [ "$#" -eq 0 ]; then
  mkdir -p "$ROOT/backups"
  bash "$INFRA/deploy/repo-heads.sh" "$ROOT" > "$ROOT/backups/deployed-heads"
fi
echo "Listo: todos los servicios están sanos."
