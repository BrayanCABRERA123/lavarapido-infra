#!/usr/bin/env bash
# Prepara el servidor (Ubuntu con Docker) y baja o actualiza todos los repos de LavaRápido en
# ~/lavarapido, uno al lado del otro, como los espera docker-compose.yml (build: ../<repo>).
#
#   bash setup-server.sh               # rama main: las versiones aprobadas por PR
#   BRANCH=develop bash setup-server.sh
set -euo pipefail

BRANCH="${BRANCH:-main}"
ROOT="${ROOT:-$HOME/lavarapido}"
# repos que todavía se despliegan desde develop porque su main aún no tiene la primera versión
# (v1.0.0): con main bajarían una versión vieja. Se quitan de aquí cuando la tengan.
DEVELOP_ONLY="${DEVELOP_ONLY:-lavarapido-payment-service}"

branch_for() {
  local name="$1" repo
  for repo in $DEVELOP_ONLY; do
    if [ "$repo" = "$name" ]; then echo develop; return; fi
  done
  echo "$BRANCH"
}

REPOS=(
  "https://github.com/BrayanCABRERA123/lavarapido-infra.git"
  "https://github.com/BrayanCABRERA123/lavarapido-api-gateway.git"
  "https://github.com/BrayanCABRERA123/lavarapido-security-service.git"
  "https://github.com/camiloguilombo12/lavarapido-customer-service.git"
  "https://github.com/camiloguilombo12/lavarapido-booking-service.git"
  "https://github.com/BrayanCABRERA123/lavarapido-operation-service.git"
  "https://github.com/BrayanCABRERA123/lavarapido-notification-service.git"
  "https://github.com/merari0322/lavarapido-payment-service.git"
  "https://github.com/BrayanCABRERA123/Front-end-proyecto-web.git"
)

command -v git >/dev/null || { sudo apt-get update -y && sudo apt-get install -y git curl; }

# Docker con el script oficial (trae docker compose); en la plantilla "Ubuntu con Docker" ya viene
if ! command -v docker >/dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sudo sh /tmp/get-docker.sh
  sudo systemctl enable --now docker
fi
docker compose version >/dev/null || { echo "Falta el plugin docker compose"; exit 1; }

# memoria de intercambio: compilar 8 imágenes a la vez pide más RAM de la que usan corriendo
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  echo "Creando 4 GB de swap..."
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# respaldos automáticos de la base (deploy/backup-db.sh) y prueba de que se pueden restaurar
# (deploy/verify-backup.sh). La VM se enciende a demanda, así que además del diario (23:00 UTC =
# 6 p. m. en Colombia) se respalda 5 minutos después de cada arranque; update-server.sh también
# respalda antes de actualizar. Las líneas se reescriben en cada corrida para que un cambio aquí
# llegue al servidor. Los scripts anotan el resultado en backups/backup.log; los errores
# inesperados (stderr) también van ahí.
mkdir -p "$ROOT/backups" && chmod 700 "$ROOT/backups"
job="bash $ROOT/lavarapido-infra/deploy/backup-db.sh > /dev/null 2>> $ROOT/backups/backup.log && bash $ROOT/lavarapido-infra/deploy/verify-backup.sh > /dev/null 2>> $ROOT/backups/backup.log"
# al arrancar, la VM también se pone al día con lo que entró a main mientras estaba apagada
# (deploy/boot-update.sh); deja el resultado en backups/deploy.log
boot="bash $ROOT/lavarapido-infra/deploy/boot-update.sh >> $ROOT/backups/deploy.log 2>&1"
# crontab -l falla si todavía no hay ninguna tarea: no es un error
{ crontab -l 2>/dev/null | grep -vE 'lavarapido-backup|lavarapido-boot-update|deploy/backup-db\.sh' || true
  echo "# lavarapido-backup: respaldo y verificación de la base al arrancar la VM y cada día"
  echo "@reboot sleep 300 && $job # lavarapido-backup"
  echo "0 23 * * * $job # lavarapido-backup"
  echo "# lavarapido-boot-update: al arrancar, actualizar si hay versiones nuevas en main"
  echo "@reboot sleep 120 && $boot # lavarapido-boot-update"
} | crontab -

sync_repo() {
  local url="$1" name="$2" branch="$3"
  if [ -d "$name/.git" ]; then
    git -C "$name" fetch --quiet origin || return 1
    # nunca se baja de versión: si lo desplegado no está contenido en la rama pedida (p. ej. cambiar
    # de develop a un main que todavía no tiene el release) se detiene sin tocar nada.
    # ALLOW_DOWNGRADE=1 lo permite a propósito
    if ! git -C "$name" merge-base --is-ancestor HEAD "origin/$branch"; then
      echo "  $name: lo desplegado no está en origin/$branch; no se baja de versión (ALLOW_DOWNGRADE=1 para forzarlo)"
      [ "${ALLOW_DOWNGRADE:-0}" = 1 ] || return 1
    fi
    git -C "$name" checkout --quiet "$branch" &&
      git -C "$name" pull --quiet --ff-only origin "$branch"
  else
    git clone --quiet --branch "$branch" "$url" "$name"
  fi
}

mkdir -p "$ROOT"
cd "$ROOT"
# si un repo falla (p. ej. un corte de red con GitHub) se reintenta y se sigue con los demás;
# al final se listan los que fallaron y el script termina con error para que nadie despliegue a medias
FAILED=()
for url in "${REPOS[@]}"; do
  name="$(basename "$url" .git)"
  branch="$(branch_for "$name")"
  if [ -d "$name/.git" ]; then echo "Actualizando $name ($branch)"; else echo "Clonando $name ($branch)"; fi
  if ! sync_repo "$url" "$name" "$branch"; then
    echo "  error con $name, reintentando en 5 s..."
    sleep 5
    sync_repo "$url" "$name" "$branch" || { echo "  error: $name no se pudo actualizar"; FAILED+=("$name"); }
  fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "error: no se actualizaron: ${FAILED[*]}"
  exit 1
fi

echo
echo "Listo en $ROOT. Siguiente paso (ver lavarapido-infra/DEPLOY.md):"
echo "  cd $ROOT/lavarapido-infra && cp .env.production.example .env.production && nano .env.production"
