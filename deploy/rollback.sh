#!/usr/bin/env bash
# Vuelve los servicios a la versión anterior sin compilar nada: usa las imágenes :prev que guarda
# update-server.sh antes de reconstruir. Sirve cuando una actualización deja algo roto.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/rollback.sh            (todos los servicios)
#   bash ~/lavarapido/lavarapido-infra/deploy/rollback.sh web        (solo algunos)
#
# No toca la base de datos ni los repos: si la versión mala aplicó una migración que la anterior no
# soporta, además hay que restaurar el respaldo de antes de actualizar (restore-db.sh, ver DEPLOY.md).
# Pide escribir VOLVER para confirmar y deja una línea en ~/lavarapido/backups/deploy.log.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$INFRA")"
# las mismas imágenes que guarda update-server.sh
IMAGES=(web security-service customer-service booking-service operations-service
  notification-service payment-service api-gateway)
COMPOSE=(sudo docker compose -f "$INFRA/docker-compose.yml" -f "$INFRA/docker-compose.prod.yml"
  --env-file "$INFRA/.env.production" --profile app)

services=("$@")
[ "${#services[@]}" -gt 0 ] || services=("${IMAGES[@]}")
for service in "${services[@]}"; do
  if [[ ! " ${IMAGES[*]} " == *" $service "* ]]; then
    echo "Servicio no válido: $service (válidos: ${IMAGES[*]})"
    exit 2
  fi
done

# mismo candado que ci-deploy.sh y boot-update.sh: no se vuelve atrás en medio de una actualización
exec 9> /tmp/lavarapido-deploy.lock
if ! flock -n 9; then
  echo "Hay una actualización en curso en el servidor; esperando a que termine (hasta 20 minutos)..."
  if ! flock -w 1200 9; then
    echo "La otra actualización sigue después de 20 minutos: no se cambió nada. Revisa ~/lavarapido/backups/deploy.log."
    exit 3
  fi
fi

# solo se vuelven atrás los que tienen una versión anterior guardada
with_prev=()
for service in "${services[@]}"; do
  if sudo docker image inspect "lavarapido/$service:prev" > /dev/null 2>&1; then
    with_prev+=("$service")
  else
    echo "  $service: no tiene versión anterior guardada (:prev), se deja como está"
  fi
done
if [ "${#with_prev[@]}" -eq 0 ]; then
  echo "No hay ninguna versión anterior guardada: no se cambió nada."
  exit 1
fi

echo "Esto vuelve a la versión anterior estos servicios (fecha de esa versión, UTC):"
for service in "${with_prev[@]}"; do
  created="$(sudo docker image inspect -f '{{.Created}}' "lavarapido/$service:prev" | cut -c1-16 | tr T ' ')"
  printf '  %-22s %s\n' "$service" "$created"
done
echo "La base de datos no cambia. Esos servicios se reinician y tardan 1-2 minutos en responder."
# la confirmación la da siempre una persona: sin terminal (cron, ssh sin -t) no se sigue
if [ ! -t 0 ]; then
  echo "Hay que correrlo en una terminal para poder confirmar: no se cambió nada."
  exit 1
fi
read -r -p "Escribe VOLVER para continuar: " answer
if [ "$answer" != "VOLVER" ]; then
  echo "Cancelado: no se cambió nada."
  exit 1
fi

for service in "${with_prev[@]}"; do
  sudo docker tag "lavarapido/$service:prev" "lavarapido/$service:local"
done
# --no-build: se usa la imagen recién etiquetada; --no-deps: los demás servicios no se tocan
"${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate "${with_prev[@]}"

echo "== Esperando a que queden sanos (hasta 8 minutos)"
pending=""
for _ in $(seq 1 48); do
  pending=""
  for service in "${with_prev[@]}"; do
    state="$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "lavarapido-$service" 2>/dev/null || echo no-existe)"
    case "$state" in
      healthy | running) ;;
      *) pending="$pending $service ($state)" ;;
    esac
  done
  [ -z "$pending" ] && break
  sleep 10
done

mkdir -p "$ROOT/backups"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# quién lo hizo, para la bitácora (USER puede no existir, p. ej. sin sesión de terminal)
who="${SUDO_USER:-${USER:-$(id -un)}}"
if [ -n "$pending" ]; then
  echo "$stamp vuelta a la versión anterior: no quedaron sanos:$pending (por $who)" >> "$ROOT/backups/deploy.log"
  echo "Error: estos servicios no quedaron sanos con la versión anterior:$pending"
  echo "Revisa su log con: sudo docker logs --tail 100 lavarapido-<servicio>"
  exit 1
fi

# lo que corre ahora funcionó: la próxima actualización lo guarda como :prev
rm -f "$ROOT/backups/update-pending"
# si se volvió todo atrás, lo que hay en los repos se da por desplegado: así, al encender la VM,
# boot-update.sh no vuelve a construir la versión mala. Lo nuevo que entre a main sí se despliega.
if [ "$#" -eq 0 ]; then
  bash "$INFRA/deploy/repo-heads.sh" "$ROOT" > "$ROOT/backups/deployed-heads"
fi
echo "$stamp vuelta a la versión anterior: ${with_prev[*]} (por $who)" >> "$ROOT/backups/deploy.log"
echo "Listo: ${with_prev[*]} volvieron a la versión anterior. Arregla o revierte el cambio en main:"
echo "el siguiente despliegue vuelve a construir lo último de main."
