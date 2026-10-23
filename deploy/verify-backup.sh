#!/usr/bin/env bash
# Prueba que el último respaldo se puede restaurar, sin tocar la base real.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/verify-backup.sh
#
# Restaura el respaldo más reciente como LavaRapido_verificacion (restore-db.sh --as), revisa que
# tenga las mismas tablas que la base real y que se puedan leer, y la borra. El resultado queda en
# ~/lavarapido/backups/backup.log. Corre solo después de cada respaldo programado (setup-server.sh).
# -E: la trampa ERR también salta si el error ocurre dentro de una función (sql)
set -Eeuo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/lavarapido/backups}"
DB="${DB_NAME:-LavaRapido}"
TEST_DB="${DB}_verificacion"
CONTAINER=lavarapido-sqlserver

log() { printf '%s | VERIFICACIÓN | %s | %s | %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$1" "$2" "${SUDO_USER:-$USER}" >> "$DEST/backup.log"; }

PASSWORD="$(grep '^DB_PASSWORD=' "$INFRA/.env.production" | cut -d= -f2-)"
value() {
  sudo docker exec -e SQLCMDPASSWORD="$PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -h -1 -W -Q "SET NOCOUNT ON; $1" | tr -d '\r'
}
drop_test_db() { value "IF DB_ID(N'$TEST_DB') IS NOT NULL DROP DATABASE [$TEST_DB]" > /dev/null || true; }

latest="$(ls -1t "$DEST/$DB"-*.bak.gz 2>/dev/null | head -1 || true)"
if [ -z "$latest" ]; then
  log FALLÓ "no hay respaldos en $DEST"
  echo "No hay respaldos para verificar en $DEST"
  exit 1
fi
name="$(basename "$latest")"

# la base de prueba se borra siempre, también si algo falla a la mitad
trap drop_test_db EXIT
drop_test_db

if ! bash "$INFRA/deploy/restore-db.sh" "$latest" --as "$TEST_DB" > /dev/null; then
  log FALLÓ "$name no se pudo restaurar"
  echo "El respaldo $name NO se pudo restaurar"
  exit 1
fi

real_tables="$(value "SELECT COUNT(*) FROM [$DB].sys.tables")"
test_tables="$(value "SELECT COUNT(*) FROM [$TEST_DB].sys.tables")"
users="$(value "SELECT COUNT(*) FROM [$TEST_DB].security.app_user")"
bookings="$(value "SELECT COUNT(*) FROM [$TEST_DB].booking.booking")"

# una migración nueva después del respaldo puede sumar tablas a la base real, nunca quitarlas
if [ "$test_tables" -gt 0 ] && [ "$test_tables" -le "$real_tables" ]; then
  log OK "$name: $test_tables tablas, $users usuarios, $bookings reservas"
  echo "Respaldo $name verificado: $test_tables tablas, $users usuarios, $bookings reservas"
else
  log FALLÓ "$name: $test_tables tablas (la base real tiene $real_tables)"
  echo "El respaldo $name no tiene las tablas esperadas ($test_tables de $real_tables)"
  exit 1
fi
