#!/usr/bin/env bash
# Al encender la VM: si hay versiones de main que todavía no quedaron desplegadas (entraron mientras
# la VM estaba apagada, o la última actualización falló a mitad), actualiza el servidor; si todo
# está desplegado, no reconstruye nada. Es lo que cubre los despliegues automáticos que GitHub
# Actions no pudo hacer porque la VM estaba apagada.
#
# Lo instala setup-server.sh como tarea @reboot; el resultado queda en ~/lavarapido/backups/deploy.log.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$INFRA")"
# lo escribe update-server.sh cuando una actualización completa termina bien
DEPLOYED="$ROOT/backups/deployed-heads"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# una actualización a la vez: si GitHub Actions está desplegando, se espera a que termine
exec 9> /tmp/lavarapido-deploy.lock
flock 9

# baja lo nuevo de GitHub sin reconstruir; si falla, se queda la versión que está corriendo
if ! bash "$INFRA/deploy/setup-server.sh" > /dev/null; then
  echo "$(stamp) no se pudieron bajar los repos: el servidor sigue con la versión que tenía"
  exit 1
fi
current="$(bash "$INFRA/deploy/repo-heads.sh" "$ROOT")"
# sin el archivo (primera vez con este script) se actualiza una vez para tenerlo
deployed="$(cat "$DEPLOYED" 2>/dev/null || true)"

if [ "$current" = "$deployed" ]; then
  echo "$(stamp) al día: lo último de GitHub ya está desplegado"
  exit 0
fi

echo "$(stamp) hay versiones sin desplegar, actualizando:"
diff <(echo "$deployed") <(echo "$current") | sed -n 's/^> /  /p' || true
bash "$INFRA/deploy/update-server.sh"
echo "$(stamp) actualización terminada"
