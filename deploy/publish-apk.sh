#!/usr/bin/env bash
# Publica un APK en el servidor: lo baja (ej. el enlace del build de EAS), lo deja en
# deploy/downloads/LavaRapidoVehicular.apk y escribe version.json. Con eso el botón de la web baja
# la versión nueva y la app avisa a quien tenga una más vieja.
#
#   bash deploy/publish-apk.sh <url-del-apk> <versionCode> ["qué cambió"]
#
# Lo normal es no correrlo a mano: scripts/publish-apk.mjs del repo de la móvil lo llama por SSH.
set -euo pipefail

URL="${1:?Falta la URL del APK}"
VERSION_CODE="${2:?Falta el versionCode}"
NOTES="${3:-}"
DIR="$(cd "$(dirname "$0")" && pwd)/downloads"

[[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || { echo "versionCode debe ser un número"; exit 1; }
mkdir -p "$DIR"

# se baja aparte y se cambia de un golpe: nadie descarga un APK a medias
curl -fsSL "$URL" -o "$DIR/.download.apk"
SIZE=$(stat -c %s "$DIR/.download.apk")
[ "$SIZE" -gt 1000000 ] || { rm -f "$DIR/.download.apk"; echo "El archivo bajado no parece un APK ($SIZE bytes)"; exit 1; }
mv "$DIR/.download.apk" "$DIR/LavaRapidoVehicular.apk"

# JSON sin herramientas extra: las notas se escapan a mano (comillas y barras)
ESCAPED_NOTES=$(printf '%s' "$NOTES" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
cat > "$DIR/.version.json" <<EOF
{
  "versionCode": $VERSION_CODE,
  "url": "/app/LavaRapidoVehicular.apk",
  "sizeBytes": $SIZE,
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "notes": "$ESCAPED_NOTES"
}
EOF
mv "$DIR/.version.json" "$DIR/version.json"
chmod 644 "$DIR/LavaRapidoVehicular.apk" "$DIR/version.json"

echo "Publicado versionCode $VERSION_CODE ($((SIZE / 1024 / 1024)) MB) en /app/LavaRapidoVehicular.apk"

# aviso por bandeja y push a quienes tienen la app (notification-service anuncia cada versión una
# sola vez). NOTIFY=0 publica sin avisar. La ruta /internal no sale por el gateway: se llama desde
# la red interna de Docker con la llave entre servicios, que nunca se muestra.
if [ "${NOTIFY:-1}" != "0" ]; then
  ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.production"
  KEY=$(grep -E "^INTERNAL_API_KEY=" "$ENV_FILE" | cut -d= -f2-)
  if [ -z "$KEY" ]; then
    echo "Sin INTERNAL_API_KEY en .env.production: no se avisó a los usuarios"
  else
    # la llave va en un archivo dentro de una carpeta privada (700): el archivo debe ser legible (644)
    # porque curl corre en el contenedor con otro usuario, pero nadie más del servidor llega a él
    PRIVATE=$(mktemp -d)
    chmod 700 "$PRIVATE"
    printf 'X-Internal-Key: %s\n' "$KEY" > "$PRIVATE/header"
    chmod 644 "$PRIVATE/header"
    RESULT=$(sudo docker run --rm --network lavarapido_default -v "$PRIVATE/header:/tmp/h:ro" \
      curlimages/curl:8.10.1 -s -X POST -H @/tmp/h -H "Content-Type: application/json" \
      -d "{\"versionCode\": $VERSION_CODE}" http://notification-service:3006/internal/v1/notifications/app-update \
      || echo "error")
    rm -rf "$PRIVATE"
    echo "Aviso a los usuarios: $RESULT"
  fi
fi
