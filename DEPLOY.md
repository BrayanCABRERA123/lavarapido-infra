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
curl -fsSL https://raw.githubusercontent.com/BrayanCABRERA123/lavarapido-infra/main/deploy/setup-server.sh -o setup-server.sh
bash setup-server.sh
```

Instala Docker si falta, crea 4 GB de swap si no hay y clona los 9 repos en `~/lavarapido` (rama `main`, la de las versiones aprobadas; payment
sigue en `develop` hasta que su `main` tenga la v1.0.0, ver `DEVELOP_ONLY` en el script). Volver a
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

### Despliegue continuo (automático)

Lo normal es no hacer nada a mano: cuando un PR aprobado entra a `main`, se despliega solo.

1. En el repo que cambió, `ci.yml` corre el CI; si pasa y el push fue a `main`, su job **Pedir
   despliegue** lanza el workflow **Desplegar en Azure** de este repo (con `automatic=true`).
2. Ese workflow entra por SSH, hace respaldo, baja `main` de todos los repos y reconstruye solo lo
   que cambió. Si ya hay otra actualización corriendo (p. ej. la del arranque de la VM), espera a
   que termine (hasta 20 min) y después actualiza igual. Luego espera a que **todos** los
   contenedores queden sanos (hasta 8 min): si alguno no arranca, el workflow sale en rojo y dice
   cuál. Al final comprueba que la web y la API respondan 200; si no, muestra lo que respondió la API.
3. Si la VM está **apagada** (no responden ni el SSH ni el sitio por HTTPS), el workflow deja un
   aviso y **no falla**. Si el sitio responde pero el SSH no, la VM está encendida y el workflow sale
   en rojo (hay que revisar `sshd` o la regla del puerto 22 en Azure). Al encender la VM,
   `deploy/boot-update.sh` (tarea `@reboot` que instala `setup-server.sh`) baja lo nuevo de `main` y
   actualiza si hay algo sin desplegar: lo que entró mientras estaba apagada, o lo que quedó a medias
   porque la última actualización falló (compara contra `~/lavarapido/backups/deployed-heads`, que se
   escribe solo cuando una actualización completa termina bien). Si todo está desplegado, no
   reconstruye. El resultado queda en `~/lavarapido/backups/deploy.log`.
4. Un cambio en `main` de este repo (compose o `deploy/`) también despliega solo. Si cambia el
   `Caddyfile`, Caddy se reinicia para leerlo.

El ✓ de **Pedir despliegue** en el repo que cambió solo dice que el pedido llegó. Si el despliegue
falla, el ✗ sale en **Actions → Desplegar en Azure** de este repo, y el correo de GitHub le llega a
quien es dueño del `DEPLOY_DISPATCH_TOKEN` (hoy Brayan): hay que mirar ahí.

Secretos que hacen falta (una vez):

| Repo | Secreto | Qué es |
|---|---|---|
| lavarapido-infra | `AZURE_SSH_KEY` | La llave de GitHub para entrar al servidor (ver "Desde GitHub" abajo) |
| Cada repo que tiene el job **Pedir despliegue** (hoy: web, gateway, security, operations, notification) | `DEPLOY_DISPATCH_TOKEN` | Token *fine-grained* de GitHub con acceso **solo** a `lavarapido-infra` y permiso **Actions: Read and write** (sirve solo para lanzar el despliegue) |

Si falta `DEPLOY_DISPATCH_TOKEN`, el job **Pedir despliegue** de ese repo sale en rojo y no se despliega.
customer, booking y payment todavía no tienen ese job: sus cambios llegan a producción con el
siguiente despliegue de cualquier repo (siempre se baja lo último de todos) o a mano. Para
agregarlo, su dueño copia el job `deploy` del `ci.yml` de la web y crea el secreto en su repo.

**La primera vez** después de fusionar este cambio a `main`, correr el workflow a mano **dos veces**
con la VM encendida: la primera corre los scripts viejos que tiene el servidor (bajan `develop`); la
segunda ya usa los nuevos, pasa el servidor a `main` e instala la tarea de arranque. Para revisarlo:
`crontab -l | grep boot-update` y `git -C ~/lavarapido/Front-end-proyecto-web branch --show-current` → `main`.

### A mano

En el servidor:

```bash
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh          # todo
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh web      # solo la web
bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh notification-service security-service
```

Baja los repos y reconstruye; lo que no cambió se reutiliza. Los datos se conservan. Si todo queda
sano, borra las imágenes viejas que ya no usa nadie (se conservan la actual y `:prev`) y la caché de
compilación sin usar hace más de 7 días, para que el disco no se llene. Desde un
computador con la llave SSH se puede hacer en un paso:

```bash
ssh -i ~/.ssh/lavarapido_azure azureuser@IP-DEL-VPS 'bash ~/lavarapido/lavarapido-infra/deploy/update-server.sh'
```

### Volver a la versión anterior

Antes de reconstruir, `update-server.sh` guarda las imágenes que están corriendo con la etiqueta
`:prev`. Si una actualización deja algo roto, en el servidor (con `ssh -t`, porque pide confirmar):

```bash
bash ~/lavarapido/lavarapido-infra/deploy/rollback.sh              # todos los servicios
bash ~/lavarapido/lavarapido-infra/deploy/rollback.sh web          # solo la web
```

Muestra de qué fecha es la versión anterior de cada servicio, pide escribir `VOLVER`, espera si hay
otra actualización corriendo (usa el mismo candado) y recrea esos contenedores sin compilar nada;
luego espera hasta 8 minutos a que queden sanos. Queda anotado en `~/lavarapido/backups/deploy.log`.
Si la última actualización falló, el siguiente intento no pisa `:prev`: sigue siendo la última
versión que funcionó.

- **No toca la base.** Si la versión mala aplicó una migración que la anterior no soporta, además
  hay que restaurar el respaldo que `update-server.sh` hizo justo antes de actualizar
  (`LavaRapido-pre-update-…`, ver *Respaldos de la base*).
- **Después hay que arreglar `main`** (revertir el PR o subir la corrección): el siguiente despliegue
  vuelve a construir lo último de `main`. Mientras tanto, al encender la VM no se reconstruye la
  versión mala (al volver todo atrás, `deployed-heads` queda con lo que hay en los repos).

### Desde GitHub (sin SSH)

Con la VM encendida: en este repo, **Actions → Desplegar en Azure → Run workflow**. En
*Servicios* se deja vacío para actualizar todo o se escriben los nombres (`web payment-service`).
Al final comprueba que la web y la API respondan 200. A mano, si la VM está apagada, el workflow falla
(para que se sepa que hay que prenderla); en los automáticos solo deja el aviso.

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

#### Recomendado: que solo `main` pueda usar la llave (Environment `produccion`)

Hoy `AZURE_SSH_KEY` es un secreto **del repo**: un workflow de cualquier rama de este repo podría
usarlo y entrar al servidor. Con un *Environment* limitado a `main`, GitHub solo entrega la llave
a los despliegues que corren desde `main`. **Todavía no está creado.** Lo hace un admin del repo,
en este orden (así el despliegue no queda sin llave en ningún momento):

1. **Settings → Environments → New environment**, nombre `produccion`.
2. En **Deployment branches and tags**: *Selected branches and tags* → **Add deployment branch or
   tag rule** → `main`. (Opcional: *Required reviewers*; entonces cada despliegue, también los
   automáticos, espera a que alguien lo apruebe en Actions.)
3. En ese environment: **Environment secrets → Add environment secret**, nombre `AZURE_SSH_KEY`, con
   la misma llave privada. Por ahora no se borra el secreto del repo.
4. En `.github/workflows/deploy.yml`, en el job `deploy`, una línea debajo de `runs-on`:
   `environment: produccion`. Se fusiona a `main` con un PR como cualquier cambio.
5. Correr **Desplegar en Azure** a mano desde `main` y revisar que pase *Preparar la llave*. Desde
   otra rama debe fallar con *Branch "…" is not allowed to deploy to produccion*.
6. Recién entonces borrar el secreto `AZURE_SSH_KEY` del repo (**Secrets and variables → Actions**).

## Integración continua (GitHub Actions)

Cada repo tiene `.github/workflows/ci.yml`, que corre en cada push o pull request a `develop` y
`main` (y a mano con *Run workflow*):

| Repo | Qué revisa |
|---|---|
| security, customer, booking, operations, notification, api-gateway | `./mvnw verify` (compila y corre las pruebas, Java 21) |
| payment-service | `dotnet build` y `dotnet test` (.NET 8; las de integración se omiten sin SQL Server) |
| Front-end-proyecto-web | Compilación de producción y `ng test` |
| LavadoVehicular-Movil | `tsc --noEmit` (el APK se sigue generando con EAS) |
| lavarapido-infra | Sintaxis y `shellcheck` de `deploy/*.sh`, `actionlint` de `.github/workflows`, `docker compose config` y sintaxis de `e2e/` |

El resultado aparece como ✓ o ✗ junto a cada commit en GitHub.

### Respaldos de la base

`deploy/backup-db.sh` hace un respaldo completo de `LavaRapido`, lo verifica y lo deja comprimido
en `~/lavarapido/backups/`. Corre solo en tres momentos:

- antes de cada `update-server.sh` (si falla, no se actualiza). Estos se llaman
  `LavaRapido-pre-update-AAAAMMDD-HHMMSS.bak.gz` y se cuentan aparte: se guardan los últimos 10, así
  un día con muchos despliegues no borra los respaldos diarios;
- 5 minutos después de encender la VM;
- todos los días a las 23:00 UTC (6 p. m. en Colombia), si la VM está encendida.

De los normales (`LavaRapido-AAAAMMDD-HHMMSS.bak.gz`: estos dos, los que se hacen a mano y el de antes
de restaurar) se guardan los últimos 14.

`setup-server.sh` programa los dos últimos en el `crontab` de `azureuser` y, después de cada uno,
`deploy/verify-backup.sh`: restaura el último respaldo como `LavaRapido_verificacion`, revisa que
tenga las tablas y se pueda leer, y la borra. Así se sabe cada día que los respaldos sirven, sin
tocar la base real. La base usa el modelo de recuperación `SIMPLE` (lo pone `db-init`): con
respaldos completos no hacen falta respaldos del registro de transacciones.

Las restauraciones nunca son automáticas: volver a un respaldo borra lo que pasó después, así
que siempre lo decide una persona. Para reemplazar la base, `restore-db.sh` muestra de qué fecha es
el respaldo y pide escribir `RESTAURAR` (hay que estar en una terminal: `ssh -t`). Espera si hay una
actualización en curso (mismo candado que el despliegue), guarda un respaldo de cómo estaba la base,
detiene los servicios, restaura, vuelve a correr las migraciones de payment (`payment-migrate`, que
no se aplican solas al arrancar) y levanta los servicios. Si algo falla a mitad, igual los vuelve a
levantar.

```bash
bash ~/lavarapido/lavarapido-infra/deploy/backup-db.sh                       # respaldar ya
bash ~/lavarapido/lavarapido-infra/deploy/verify-backup.sh                   # probar que el último se puede restaurar
bash ~/lavarapido/lavarapido-infra/deploy/restore-db.sh <archivo.bak.gz> --as LavaRapido_prueba   # revisar un respaldo sin tocar la base
bash ~/lavarapido/lavarapido-infra/deploy/restore-db.sh <archivo.bak.gz>     # volver la base a ese respaldo (pide escribir RESTAURAR)
```

**Bitácora:** `~/lavarapido/backups/backup.log` anota cada respaldo, verificación y restauración,
también las canceladas o fallidas, con la fecha (UTC), el resultado y quién la hizo:

```
2026-10-21 06:12:05 UTC | RESPALDO | OK | LavaRapido-20261021-061204.bak.gz (1.4M) | azureuser
2026-10-21 06:12:08 UTC | VERIFICACIÓN | OK | LavaRapido-20261021-061204.bak.gz: 69 tablas, 4 usuarios, 2 reservas | azureuser
2026-10-21 06:11:16 UTC | RESTAURACIÓN | CANCELADA | LavaRapido-20261021-061111.bak.gz -> LavaRapido | azureuser
```

Se lee con `tail -20 ~/lavarapido/backups/backup.log`; para ver solo los problemas,
`grep FALLÓ ~/lavarapido/backups/backup.log`.

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

- Usuario propio de base de datos en vez de `sa` (ver el riesgo aceptado abajo).
- Copias de seguridad del volumen `sqlserver-data`.
- Construir las imágenes en CI y publicarlas en un registro, para no compilar en el servidor.

### Riesgo aceptado: todos los servicios entran a la base con `sa` (H-10)

**Qué pasa.** Los 7 servicios, `payment-migrate` y los scripts de respaldo usan el mismo usuario
`sa`, que es administrador de todo SQL Server. Si un servicio tuviera una falla que dejara ejecutar
SQL (p. ej. una inyección), desde ahí se podrían leer o borrar los esquemas de los demás servicios,
o la base completa. La separación por esquemas (ADR-009) hoy la respeta el código, no la base.

**Por qué se acepta para la entrega.** SQL Server no queda expuesto: en producción no publica el
1433, solo se llega por la red interna de Docker. La contraseña de `sa` está solo en
`.env.production` del servidor (no en Git). Y hay respaldo diario verificado, más uno antes de
cada actualización. Cambiar los permisos de 7 servicios a días de la exposición es más riesgoso
que dejarlo así.

**Cambio propuesto (no aplicado; no antes de la exposición).** Un usuario por servicio, dueño solo
de su esquema:

1. Un script SQL que corre una vez con `sa`: por cada servicio, `CREATE LOGIN` y `CREATE USER` con
   `DEFAULT_SCHEMA` = su esquema, `ALTER AUTHORIZATION ON SCHEMA::<esquema>` a ese usuario y
   `GRANT CREATE TABLE, CREATE VIEW, CREATE PROCEDURE` (Liquibase crea y cambia sus tablas).
2. Las tablas de control de Liquibase (`DATABASECHANGELOG_<SERVICIO>`, hoy en `dbo`) pasan al
   esquema de cada servicio (`spring.liquibase.liquibase-schema`; en payment-migrate,
   `--liquibase-schema-name`), o se le da a cada usuario permiso solo sobre las suyas en `dbo`.
3. En `docker-compose.prod.yml`, `DB_USERNAME`/`DB_PASSWORD` distintos por servicio
   (`DB_PASSWORD_BOOKING`, …) en `.env.production`. `sa` queda solo para `db-init` y los scripts
   de respaldo y restauración, que necesitan permisos de administrador.
4. Probarlo antes sobre una copia (`restore-db.sh <respaldo> --as LavaRapido_prueba`).
