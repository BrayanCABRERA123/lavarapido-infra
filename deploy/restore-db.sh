#!/usr/bin/env bash
# Restaura un respaldo hecho con backup-db.sh.
#
#   bash restore-db.sh ~/lavarapido/backups/LavaRapido-20261021-150000.bak.gz
#       reemplaza la base LavaRapido: detiene los servicios, restaura y los vuelve a levantar.
#       Pide escribir RESTAURAR para confirmar. Antes guarda un respaldo de cómo estaba.
#
#   bash restore-db.sh <archivo> --as LavaRapido_prueba
#       la restaura con otro nombre, sin tocar la base real (para revisar o probar un respaldo).
#       Se borra con: DROP DATABASE [LavaRapido_prueba]
#
# Cada restauración (o su cancelación o falla) queda anotada en ~/lavarapido/backups/backup.log.
# -E: la trampa ERR también salta si el error ocurre dentro de una función (sql)
set -Eeuo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB_NAME:-LavaRapido}"
CONTAINER=lavarapido-sqlserver
INSIDE=/var/opt/mssql/backup

archive="${1:-}"
[ -f "$archive" ] || { echo "Uso: restore-db.sh <respaldo .bak.gz> [--as NOMBRE]"; exit 1; }
target="$DB"
if [ "${2:-}" = "--as" ]; then
  target="${3:?Falta el nombre después de --as}"
  [[ "$target" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Nombre inválido: solo letras, números y _"; exit 1; }
  [ "$target" != "$DB" ] || { echo "Para reemplazar $DB no uses --as"; exit 1; }
fi

LOG="${BACKUP_DIR:-$HOME/lavarapido/backups}/backup.log"
# bitácora: fecha UTC | acción | resultado | detalle | quién
log() { printf '%s | RESTAURACIÓN | %s | %s | %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$1" "$2" "${SUDO_USER:-$USER}" >> "$LOG"; }
what="$(basename "$archive") -> $target"
trap 'log FALLÓ "$what (error en la línea $LINENO)"' ERR

PASSWORD="$(grep '^DB_PASSWORD=' "$INFRA/.env.production" | cut -d= -f2-)"
sql() {
  sudo docker exec -e SQLCMDPASSWORD="$PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -Q "$1"
}
COMPOSE=(sudo docker compose -f "$INFRA/docker-compose.yml" -f "$INFRA/docker-compose.prod.yml"
  --env-file "$INFRA/.env.production" --profile app)
SERVICES=(security-service customer-service booking-service operations-service
  notification-service payment-service api-gateway)

if [ "$target" = "$DB" ]; then
  echo "Esto REEMPLAZA la base $DB con $(basename "$archive"). Lo que se haya hecho después de ese respaldo se pierde."
  read -r -p "Escribe RESTAURAR para continuar: " answer
  [ "$answer" = "RESTAURAR" ] || { log CANCELADA "$what"; echo "Cancelado."; exit 1; }
  echo "== Respaldo de cómo está ahora (por si hay que volver)"
  bash "$INFRA/deploy/backup-db.sh"
fi

file="restore-$(date -u +%Y%m%d%H%M%S).bak"
gunzip -c "$archive" > "/tmp/$file"
sudo docker exec "$CONTAINER" mkdir -p "$INSIDE"
sudo docker cp "/tmp/$file" "$CONTAINER:$INSIDE/$file"
rm -f "/tmp/$file"
sudo docker exec -u 0 "$CONTAINER" chown mssql "$INSIDE/$file"
# el archivo temporal dentro del contenedor se borra siempre, también si algo falla
trap 'sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file" > /dev/null 2>&1 || true' EXIT

if [ "$target" = "$DB" ]; then
  echo "== Deteniendo los servicios"
  "${COMPOSE[@]}" stop "${SERVICES[@]}"
  # nadie más conectado mientras se restaura; si falla, la base vuelve a quedar abierta como estaba
  sql "ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE"
  if ! sql "RESTORE DATABASE [$DB] FROM DISK = N'$INSIDE/$file' WITH REPLACE, CHECKSUM"; then
    sql "ALTER DATABASE [$DB] SET MULTI_USER" || true
    sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file"
    "${COMPOSE[@]}" start "${SERVICES[@]}"
    log FALLÓ "$what (la base sigue como estaba)"
    echo "error: no se pudo restaurar; la base sigue como estaba"
    exit 1
  fi
  sql "ALTER DATABASE [$DB] SET MULTI_USER"
else
  # otro nombre: los archivos de datos y log van con ese nombre para no pisar los de la base real
  sql "RESTORE DATABASE [$target] FROM DISK = N'$INSIDE/$file' WITH CHECKSUM,
       MOVE N'$DB' TO N'/var/opt/mssql/data/$target.mdf',
       MOVE N'${DB}_log' TO N'/var/opt/mssql/data/${target}_log.ldf'"
fi
sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file"

log OK "$what"

if [ "$target" = "$DB" ]; then
  echo "== Levantando los servicios"
  "${COMPOSE[@]}" start "${SERVICES[@]}"
  echo "Listo. Los servicios Java tardan 1-2 minutos en responder."
else
  echo "Listo: restaurada como $target (la base $DB no se tocó)."
fi
