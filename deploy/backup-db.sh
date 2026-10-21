#!/usr/bin/env bash
# Respaldo completo de la base LavaRapido en el servidor.
#
#   bash ~/lavarapido/lavarapido-infra/deploy/backup-db.sh
#
# Deja ~/lavarapido/backups/LavaRapido-AAAAMMDD-HHMMSS.bak.gz (comprimido, solo lo lee azureuser)
# y conserva los últimos BACKUP_KEEP (14 por defecto). Lo corren solos update-server.sh antes de
# actualizar, la tarea diaria y el arranque de la VM (setup-server.sh los programa).
#
# El respaldo queda en el mismo disco de la VM: protege de un error humano o de una migración
# mala, no de perder la VM. Para tener una copia afuera, bajarla al PC (ver DEPLOY.md).
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/lavarapido/backups}"
KEEP="${BACKUP_KEEP:-14}"
DB="${DB_NAME:-LavaRapido}"
CONTAINER=lavarapido-sqlserver
INSIDE=/var/opt/mssql/backup

PASSWORD="$(grep '^DB_PASSWORD=' "$INFRA/.env.production" | cut -d= -f2-)"
[ -n "$PASSWORD" ] || { echo "error: falta DB_PASSWORD en .env.production"; exit 1; }

sql() {
  sudo docker exec -e SQLCMDPASSWORD="$PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -Q "$1" > /dev/null
}

stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$DB-$stamp.bak"
mkdir -p "$DEST"
chmod 700 "$DEST"

sudo docker exec "$CONTAINER" mkdir -p "$INSIDE"
# CHECKSUM detecta páginas dañadas al respaldar; VERIFYONLY comprueba que el archivo se puede restaurar
sql "BACKUP DATABASE [$DB] TO DISK = N'$INSIDE/$file' WITH INIT, CHECKSUM, NAME = N'$DB $stamp'"
sql "RESTORE VERIFYONLY FROM DISK = N'$INSIDE/$file' WITH CHECKSUM"

# se saca del contenedor y se comprime (SQL Server Express no comprime sus respaldos)
sudo docker cp "$CONTAINER:$INSIDE/$file" "$DEST/$file"
sudo docker exec "$CONTAINER" rm -f "$INSIDE/$file"
sudo chown "$(id -u):$(id -g)" "$DEST/$file"
gzip -f "$DEST/$file"
chmod 600 "$DEST/$file.gz"

# solo los últimos KEEP
ls -1t "$DEST/$DB"-*.bak.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "Respaldo listo: $DEST/$file.gz ($(du -h "$DEST/$file.gz" | cut -f1)); hay $(ls -1 "$DEST/$DB"-*.bak.gz | wc -l) guardados"
