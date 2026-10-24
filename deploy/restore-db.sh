#!/usr/bin/env bash
# Restaura un respaldo hecho con backup-db.sh.
#
#   bash restore-db.sh ~/lavarapido/backups/LavaRapido-20261021-150000.bak.gz
#       reemplaza la base LavaRapido: detiene los servicios, restaura, vuelve a correr las
#       migraciones de payment y levanta los servicios. Pide escribir RESTAURAR para confirmar
#       (en una terminal) y antes guarda un respaldo de cómo estaba. Toma el mismo candado que las
#       actualizaciones: si hay una corriendo, espera a que termine.
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
# en cron no existe USER (y con set -u el script se caería al anotar): se pregunta a id -un
log() { printf '%s | RESTAURACIÓN | %s | %s | %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$1" "$2" "${SUDO_USER:-${USER:-$(id -un)}}" >> "$LOG"; }
what="$(basename "$archive") -> $target"
trap 'log FALLÓ "$what (error en la línea $LINENO)"' ERR

PASSWORD="$(grep '^DB_PASSWORD=' "$INFRA/.env.production" | cut -d= -f2-)"
[ -n "$PASSWORD" ] || { log FALLÓ "$what (falta DB_PASSWORD)"; echo "error: falta DB_PASSWORD en .env.production"; exit 1; }
sql() {
  sudo docker exec -e SQLCMDPASSWORD="$PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -Q "$1"
}
COMPOSE=(sudo docker compose -f "$INFRA/docker-compose.yml" -f "$INFRA/docker-compose.prod.yml"
  --env-file "$INFRA/.env.production" --profile app)
SERVICES=(security-service customer-service booking-service operations-service
  notification-service payment-service api-gateway)

if [ "$target" = "$DB" ]; then
  # mismo candado que ci-deploy.sh, boot-update.sh y rollback.sh: no se restaura en medio de una
  # actualización (que también detiene y recrea los servicios)
  exec 9> /tmp/lavarapido-deploy.lock
  if ! flock -n 9; then
    echo "Hay una actualización en curso en el servidor; esperando a que termine (hasta 20 minutos)..."
    if ! flock -w 1200 9; then
      log CANCELADA "$what (otra actualización seguía en curso)"
      echo "La otra actualización sigue después de 20 minutos: no se cambió nada."
      exit 3
    fi
  fi

  echo "Vas a REEMPLAZAR la base $DB con $(basename "$archive")"
  echo "(respaldo del $(date -u -r "$archive" '+%Y-%m-%d %H:%M UTC'))."
  echo "Todo lo que se hizo después de ese respaldo (reservas, pagos, usuarios, cambios) se pierde."
  echo "Pasos: 1) respaldo de cómo está ahora; 2) se detienen los servicios: la web y la app dejan de"
  echo "responder unos minutos; 3) se restaura; 4) migraciones de payment; 5) se levantan los servicios."
  # la confirmación la da siempre una persona: sin terminal (cron, ssh sin -t) no se sigue
  if [ ! -t 0 ]; then
    log CANCELADA "$what (sin terminal para confirmar)"
    echo "Hay que correrlo en una terminal (ssh -t) para poder confirmar: no se cambió nada."
    exit 1
  fi
  read -r -p "Escribe RESTAURAR para continuar (cualquier otra cosa cancela): " answer
  [ "$answer" = "RESTAURAR" ] || { log CANCELADA "$what"; echo "Cancelado: no se cambió nada."; exit 1; }
  echo "== Respaldo de cómo está ahora (por si hay que volver)"
  bash "$INFRA/deploy/backup-db.sh"
fi

file="restore-$(date -u +%Y%m%d%H%M%S).bak"
stopped=false
# al salir, pase lo que pase: se borra el archivo temporal del contenedor y, si los servicios
# quedaron detenidos por un error a mitad de camino, se vuelven a levantar
cleanup() {
  sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file" > /dev/null 2>&1 || true
  if [ "$stopped" = true ]; then
    echo "== Levantando los servicios otra vez"
    "${COMPOSE[@]}" start "${SERVICES[@]}" || true
  fi
}
trap cleanup EXIT

gunzip -c "$archive" > "/tmp/$file"
sudo docker exec "$CONTAINER" mkdir -p "$INSIDE"
sudo docker cp "/tmp/$file" "$CONTAINER:$INSIDE/$file"
rm -f "/tmp/$file"
sudo docker exec -u 0 "$CONTAINER" chown mssql "$INSIDE/$file"

migrated=true
if [ "$target" = "$DB" ]; then
  echo "== Deteniendo los servicios"
  stopped=true
  "${COMPOSE[@]}" stop "${SERVICES[@]}"
  # nadie más conectado mientras se restaura; si falla, la base vuelve a quedar abierta como estaba
  sql "ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE"
  if ! sql "RESTORE DATABASE [$DB] FROM DISK = N'$INSIDE/$file' WITH REPLACE, CHECKSUM"; then
    sql "ALTER DATABASE [$DB] SET MULTI_USER" || true
    log FALLÓ "$what (la base sigue como estaba)"
    echo "error: no se pudo restaurar; la base sigue como estaba"
    exit 1
  fi
  sql "ALTER DATABASE [$DB] SET MULTI_USER"
  # payment (.NET) no aplica sus migraciones al arrancar como los servicios Java: si el respaldo es
  # de antes de una migración de payment, sin esto payment-service arranca con tablas viejas. Se
  # vuelve a correr el contenedor de un solo uso que dejó la última actualización (start -a espera
  # a que termine y devuelve su resultado)
  echo "== Migraciones de payment (payment-migrate)"
  if ! sudo docker start -a lavarapido-payment-migrate; then
    migrated=false
  fi
else
  # otro nombre: los archivos de datos y log van con ese nombre para no pisar los de la base real
  sql "RESTORE DATABASE [$target] FROM DISK = N'$INSIDE/$file' WITH CHECKSUM,
       MOVE N'$DB' TO N'/var/opt/mssql/data/$target.mdf',
       MOVE N'${DB}_log' TO N'/var/opt/mssql/data/${target}_log.ldf'"
fi
sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file"

if [ "$target" = "$DB" ]; then
  echo "== Levantando los servicios"
  "${COMPOSE[@]}" start "${SERVICES[@]}"
  stopped=false
  if [ "$migrated" = false ]; then
    log FALLÓ "$what (la base se restauró, pero payment-migrate falló)"
    echo "error: la base se restauró, pero las migraciones de payment fallaron (revisa el error de arriba)."
    echo "Vuelve a intentarlas con: sudo docker start -a lavarapido-payment-migrate"
    exit 1
  fi
  log OK "$what"
  echo "Listo. Los servicios Java tardan 1-2 minutos en responder."
else
  log OK "$what"
  echo "Listo: restaurada como $target (la base $DB no se tocó)."
fi
