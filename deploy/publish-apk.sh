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
