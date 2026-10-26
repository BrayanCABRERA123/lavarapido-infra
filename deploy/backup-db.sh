#!/usr/bin/env bash
# Respaldo completo de la base LavaRapido en el servidor.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/backup-db.sh               (respaldo normal)
#   bash ~/lavarapido/lavarapido-infra/deploy/backup-db.sh pre-update    (con etiqueta)
#
# Deja ~/lavarapido/backups/LavaRapido-AAAAMMDD-HHMMSS.bak.gz (comprimido, solo lo lee azureuser)
# y conserva los últimos BACKUP_KEEP (14 por defecto). Con etiqueta (update-server.sh usa pre-update)
# queda LavaRapido-<etiqueta>-AAAAMMDD-HHMMSS.bak.gz y se cuenta aparte: se guardan los últimos
# BACKUP_KEEP_LABELED (10) de esa etiqueta, así muchos despliegues seguidos no borran los diarios.
# Cada respaldo, bien o mal, queda anotado en
# ~/lavarapido/backups/backup.log (lo mismo hacen restore-db.sh y verify-backup.sh). Lo corren
# solos update-server.sh antes de actualizar, la tarea diaria y el arranque de la VM
# (setup-server.sh los programa).
#
# El respaldo queda en el mismo disco de la VM: protege de un error humano o de una migración
# mala, no de perder la VM. Para tener una copia afuera, bajarla al PC (ver DEPLOY.md).
# -E: la trampa ERR también salta si el error ocurre dentro de una función (sql)
set -Eeuo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/lavarapido/backups}"
KEEP="${BACKUP_KEEP:-14}"
DB="${DB_NAME:-LavaRapido}"
CONTAINER=lavarapido-sqlserver
INSIDE=/var/opt/mssql/backup
LABEL="${1:-}"
[[ "$LABEL" =~ ^[a-z][a-z-]*$ || -z "$LABEL" ]] || { echo "Etiqueta inválida: $LABEL (solo minúsculas y guiones)"; exit 1; }
if [ -n "$LABEL" ]; then KEEP="${BACKUP_KEEP_LABELED:-10}"; fi

mkdir -p "$DEST"
chmod 700 "$DEST"
# bitácora: fecha UTC | acción | resultado | detalle | quién
# en cron no existe USER (y con set -u el script se caería al anotar): se pregunta a id -un
log() { printf '%s | RESPALDO | %s | %s | %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$1" "$2" "${SUDO_USER:-${USER:-$(id -un)}}" >> "$DEST/backup.log"; }
trap 'log FALLÓ "error en la línea $LINENO"' ERR

PASSWORD="$(grep '^DB_PASSWORD=' "$INFRA/.env.production" | cut -d= -f2-)"
[ -n "$PASSWORD" ] || { log FALLÓ "falta DB_PASSWORD"; echo "error: falta DB_PASSWORD en .env.production"; exit 1; }

sql() {
  sudo docker exec -e SQLCMDPASSWORD="$PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -Q "$1" > /dev/null
}

stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$DB-${LABEL:+$LABEL-}$stamp.bak"

sudo docker exec "$CONTAINER" mkdir -p "$INSIDE"
# el archivo temporal dentro del contenedor se borra siempre, también si algo falla
trap 'sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file" > /dev/null 2>&1 || true' EXIT
# CHECKSUM detecta páginas dañadas al respaldar; VERIFYONLY comprueba que el archivo se puede restaurar
sql "BACKUP DATABASE [$DB] TO DISK = N'$INSIDE/$file' WITH INIT, CHECKSUM, NAME = N'$DB $stamp'"
sql "RESTORE VERIFYONLY FROM DISK = N'$INSIDE/$file' WITH CHECKSUM"

# se saca del contenedor y se comprime (SQL Server Express no comprime sus respaldos)
sudo docker cp "$CONTAINER:$INSIDE/$file" "$DEST/$file"
sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file"
sudo chown "$(id -u):$(id -g)" "$DEST/$file"
gzip -f "$DEST/$file"
chmod 600 "$DEST/$file.gz"

# solo los últimos KEEP de su mismo tipo: los normales empiezan por la fecha (LavaRapido-2026…), así
# no se cuentan ni se borran los que tienen etiqueta, y al revés
if [ -n "$LABEL" ]; then
  ls -1t "$DEST/$DB-$LABEL-"[0-9]*.bak.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
else
  ls -1t "$DEST/$DB-"[0-9]*.bak.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
fi

size="$(du -h "$DEST/$file.gz" | cut -f1)"
log OK "$file.gz ($size)"
echo "Respaldo listo: $DEST/$file.gz ($size); hay $(ls -1 "$DEST/$DB"-*.bak.gz | wc -l) guardados"
