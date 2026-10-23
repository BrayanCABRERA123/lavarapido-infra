#!/usr/bin/env bash
# Al encender la VM: si mientras estuvo apagada entraron versiones nuevas a main (PR aprobados),
# actualiza el servidor; si no hay nada nuevo, no reconstruye nada. Es lo que cubre los despliegues
# automáticos que GitHub Actions no pudo hacer porque la VM estaba apagada.
#
# Lo instala setup-server.sh como tarea @reboot; el resultado queda en ~/lavarapido/backups/deploy.log.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$INFRA")"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# commit actual de cada repo (para saber si bajó algo nuevo)
heads() {
  local repo
  for repo in "$ROOT"/*/; do
    if [ -d "${repo}.git" ]; then echo "$(basename "$repo") $(git -C "$repo" rev-parse --short HEAD)"; fi
  done
}

# una actualización a la vez: si GitHub Actions está desplegando, se espera a que termine
exec 9> /tmp/lavarapido-deploy.lock
flock 9

before="$(heads)"
# baja lo nuevo de GitHub sin reconstruir; si falla, se queda la versión que está corriendo
if ! bash "$INFRA/deploy/setup-server.sh" > /dev/null; then
  echo "$(stamp) no se pudieron bajar los repos: el servidor sigue con la versión que tenía"
  exit 1
fi
after="$(heads)"

if [ "$before" = "$after" ]; then
  echo "$(stamp) al día: no hay versiones nuevas en GitHub"
  exit 0
fi

echo "$(stamp) hay versiones nuevas, actualizando:"
diff <(echo "$before") <(echo "$after") | sed -n 's/^> /  /p' || true
bash "$INFRA/deploy/update-server.sh"
echo "$(stamp) actualización terminada"
