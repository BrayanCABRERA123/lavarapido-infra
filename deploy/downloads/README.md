# Descargas públicas (servidor)

Caddy sirve esta carpeta en `/app/` (ver `deploy/Caddyfile`):

- `LavaRapidoVehicular.apk`: la app Android más reciente (dirección fija: el botón de la web y el
  aviso de actualización de la app apuntan aquí).
- `version.json`: qué versión es (`versionCode`) y de dónde bajarla. La app lo compara con la suya.

Ninguno de los dos se sube al repositorio: los escribe `deploy/publish-apk.sh` en el servidor.
