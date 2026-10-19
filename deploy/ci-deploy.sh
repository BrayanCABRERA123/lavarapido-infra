#!/usr/bin/env bash
# Único comando que puede ejecutar la llave SSH de GitHub Actions. En ~/.ssh/authorized_keys esa
# llave va con restrict,command="bash …/ci-deploy.sh", así que no abre una terminal ni corre otra cosa:
# lo que pida el workflow llega en SSH_ORIGINAL_COMMAND y aquí se valida.
#
#   deploy                        actualiza todo (update-server.sh)
#   deploy web payment-service    solo esos servicios
set -euo pipefail

ALLOWED=(web security-service customer-service booking-service operations-service
  notification-service payment-service api-gateway)

read -r -a args <<< "${SSH_ORIGINAL_COMMAND:-}"
if [ "${args[0]:-}" != "deploy" ]; then
  echo "Comando no permitido: solo 'deploy [servicio ...]'"
  exit 2
fi

services=("${args[@]:1}")
for service in "${services[@]}"; do
  if [[ ! " ${ALLOWED[*]} " == *" $service "* ]]; then
    echo "Servicio no permitido: $service (válidos: ${ALLOWED[*]})"
    exit 2
  fi
done

# una actualización a la vez, aunque la pidan dos personas al mismo tiempo
exec 9> /tmp/lavarapido-deploy.lock
if ! flock -n 9; then
  echo "Ya hay una actualización en curso en el servidor; inténtalo cuando termine."
  exit 3
fi

bash "$(dirname "$0")/update-server.sh" "${services[@]}"
