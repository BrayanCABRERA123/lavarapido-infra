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

### Desde GitHub (sin SSH)

Con la VM encendida: en este repo, **Actions → Desplegar en Azure → Run workflow**. En
*Servicios* se deja vacío para actualizar todo o se escriben los nombres (`web payment-service`).
Al final comprueba que la web y la API respondan 200.

Usa una llave propia de GitHub, distinta a la de las personas, que en el servidor solo puede
ejecutar `deploy/ci-deploy.sh` (valida los nombres y no deja correr dos actualizaciones a la vez).
Se configura una vez:

1. En un computador: `ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ~/.ssh/lavarapido_github_deploy`.
2. En el servidor, una línea nueva en `~/.ssh/authorized_keys` con la parte pública:
   `restrict,command="bash /home/azureuser/lavarapido/lavarapido-infra/deploy/ci-deploy.sh" ssh-ed25519 AAAA… github-actions-deploy`
3. En GitHub (este repo): **Settings → Secrets and variables → Actions → New repository secret**,
   nombre `AZURE_SSH_KEY`, valor: el contenido completo de `~/.ssh/lavarapido_github_deploy` (la
   parte privada, sin `.pub`).

Para revocarla basta con borrar esa línea de `authorized_keys`. Si la VM cambia (otra IP u otro
servidor), hay que actualizar `HOST` y `KNOWN_HOST` en `.github/workflows/deploy.yml`.

## Integración continua (GitHub Actions)

Cada repo tiene `.github/workflows/ci.yml`, que corre en cada push o pull request a `develop` y
`main` (y a mano con *Run workflow*):

| Repo | Qué revisa |
|---|---|
| security, customer, booking, operations, notification, api-gateway | `./mvnw verify` (compila y corre las pruebas, Java 21) |
| payment-service | `dotnet build` y `dotnet test` (.NET 8; las de integración se omiten sin SQL Server) |
| Front-end-proyecto-web | Compilación de producción y `ng test` |
| LavadoVehicular-Movil | `tsc --noEmit` (el APK se sigue generando con EAS) |
| lavarapido-infra | Sintaxis y `shellcheck` de `deploy/*.sh`, `docker compose config` y sintaxis de `e2e/` |

El resultado aparece como ✓ o ✗ junto a cada commit en GitHub.

### Respaldos de la base

`deploy/backup-db.sh` hace un respaldo completo de `LavaRapido`, lo verifica y lo deja comprimido
en `~/lavarapido/backups/` (se guardan los últimos 14). Corre solo en tres momentos:

- antes de cada `update-server.sh` (si falla, no se actualiza);
- 5 minutos después de encender la VM;
- todos los días a las 23:00 UTC (6 p. m. en Colombia), si la VM está encendida.

`setup-server.sh` programa los dos últimos en el `crontab` de `azureuser`; el historial queda en
`~/lavarapido/backups/backup.log`. La base usa el modelo de recuperación `SIMPLE` (lo pone
`db-init`): con respaldos completos no hacen falta respaldos del registro de transacciones.

```bash
bash ~/lavarapido/lavarapido-infra/deploy/backup-db.sh                       # respaldar ya
bash ~/lavarapido/lavarapido-infra/deploy/restore-db.sh <archivo.bak.gz> --as LavaRapido_prueba   # revisar un respaldo sin tocar la base
bash ~/lavarapido/lavarapido-infra/deploy/restore-db.sh <archivo.bak.gz>     # volver la base a ese respaldo (pide escribir RESTAURAR)
```

Los respaldos viven en el mismo disco de la VM: sirven ante un error o una migración mala, no si
se pierde la VM. Para guardar una copia afuera, desde el PC:

```bash
scp -i ~/.ssh/lavarapido_azure "azureuser@IP-DEL-VPS:~/lavarapido/backups/*.bak.gz" .
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
| Logs sin tope | Hasta 3 archivos de 10 MB por contenedor |
| Sin chequeo de salud en los servicios | Cada servicio, la web y Caddy con *healthcheck* (`docker compose ps` muestra `healthy` o `unhealthy`; Docker no reinicia solo un `unhealthy`) |
| Sin encabezados de seguridad | Caddy agrega HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` y un CSP para la web |

**Si la web cambia lo que carga de afuera** (otra fuente, un CDN, un script), hay que agregar ese
dominio al `Content-Security-Policy` de `deploy/Caddyfile`; si no, el navegador lo bloquea. La
huella `sha256-…` del CSP autoriza solo el `onload="this.media='all'"` que Angular pone al
compilar; si Angular lo cambia, la página queda sin estilos y la consola del navegador muestra la
huella nueva que hay que poner.

## Pendiente para un despliegue más robusto

- Usuario propio de base de datos en vez de `sa`.
- Copias de seguridad del volumen `sqlserver-data`.
- Construir las imágenes en CI y publicarlas en un registro, para no compilar en el servidor.
