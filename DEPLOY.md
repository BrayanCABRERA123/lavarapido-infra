# Despliegue en un servidor (VPS)

Todo el sistema (base de datos, RabbitMQ, los 7 servicios, el gateway y la web) corre con Docker en
un solo servidor Linux. Solo **Caddy** queda expuesto a internet (puertos 80 y 443): reparte `/api`
al gateway y lo demás a la web, y da HTTPS automático si hay dominio.

```
Internet ──► Caddy :80/:443 ──► /api/*  ──► api-gateway:8080 ──► servicios
                             └► resto   ──► web (nginx + Angular)
```

## 1. El servidor

- **Hosting compartido no sirve** (no corre Docker, Java ni SQL Server). Hace falta un **VPS**.
- Memoria: **8 GB** (ej. Hostinger KVM 2). SQL Server pide 2 GB y cada servicio ~300–500 MB.
- Sistema: **Ubuntu 24.04 o 26.04 LTS**. Si no trae Docker, `setup-server.sh` lo instala.
- Opcional: un **dominio** apuntando a la IP del VPS (registro `A`), para tener HTTPS.

## 2. Bajar el proyecto

Entrar por SSH (`ssh root@IP-DEL-VPS`) y ejecutar:

```bash
curl -fsSL https://raw.githubusercontent.com/BrayanCABRERA123/lavarapido-infra/develop/deploy/setup-server.sh -o setup-server.sh
bash setup-server.sh
```

Instala Docker si falta, crea 4 GB de swap si no hay y clona los 9 repos en `~/lavarapido` (rama `develop`). Volver a
ejecutarlo actualiza todos los repos. Si algún repo es privado, git pedirá usuario y un token de GitHub.

## 3. Configurar

```bash
cd ~/lavarapido/lavarapido-infra
cp .env.production.example .env.production
nano .env.production
```

- `SITE_ADDRESS` y `PUBLIC_URL`: el dominio (`vehiclecarwash.com` / `https://vehiclecarwash.com`) o,
  sin dominio, `:80` / `http://IP-DEL-VPS`.
- Contraseñas y llaves **nuevas** (no las del computador de desarrollo). Para cada llave:
  `openssl rand -base64 48`.
- Correo: Gmail con contraseña de aplicación (`MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM`).
- **Primer administrador**: `ADMIN_EMAIL` y `ADMIN_PASSWORD`. La base empieza vacía (las cuentas demo
  como `admin@gmail.com` solo existen en desarrollo) y el registro público solo crea clientes. Al
  arrancar, security-service crea este administrador si no hay ninguno; en el log sale
  `First administrator created`. Con él se entra a `/admin` y se crean los operarios.

## 4. Levantar

```bash
cd ~/lavarapido/lavarapido-infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production --profile app up -d --build
```

La primera vez compila todas las imágenes (10–20 min). Revisar:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production --profile app ps
docker logs -f lavarapido-security-service      # cualquier servicio
```

Abrir `PUBLIC_URL` en el navegador: debe salir la página de inicio. `PUBLIC_URL/api/v1/catalog/services`
debe responder JSON.

## 5. La app móvil

En `LavadoVehicular-Movil/eas.json`, perfil `preview`: `EXPO_PUBLIC_API_URL` = `PUBLIC_URL/api/v1`.
Luego `eas build -p android --profile preview` y se instala el APK nuevo.

## 6. Actualizar después de cambios

Primero se suben los cambios a GitHub (rama `develop`). Luego, en el servidor:

```bash
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh          # todo
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh web      # solo la web
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh notification-service security-service
```

Baja los repos y reconstruye; lo que no cambió se reutiliza. Los datos se conservan. Desde un
computador con la llave SSH se puede hacer en un paso:

```bash
ssh -i ~/.ssh/lavarapido_azure azureuser@IP-DEL-VPS 'bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh'
```

## 7. Publicar una versión nueva de la app

Desde la carpeta de la app móvil, después de `eas build -p android --profile preview`:

```bash
npm run publish:apk -- "qué cambió"
```

Deja el APK en `/app/LavaRapidoVehicular.apk` (botón de la web) y avisa por bandeja y push a quienes
tienen la app instalada. Para cambios solo de pantallas o lógica no hace falta APK:
`npm run publish:update -- "qué cambió"` (EAS Update).

## Qué cambia frente al entorno local (`docker-compose.prod.yml`)

| Local | Producción |
|---|---|
| Puertos de base, RabbitMQ y servicios abiertos | Solo 80/443 (Caddy) |
| Perfil `dev` (Swagger) | `prod` (sin Swagger) |
| SQL Server Developer | SQL Server Express |
| Mailpit | Gmail / SMTP real |
| `INTERNAL_API_KEY`, usuario de RabbitMQ opcionales | Obligatorios (no arranca sin ellos) |
| Sin límite de memoria | 512 MB por servicio Java, reinicio automático |

## Pendiente para un despliegue más robusto

- Usuario propio de base de datos en vez de `sa`.
- Copias de seguridad del volumen `sqlserver-data`.
- CI que pruebe y construya las imágenes antes de desplegar.
