# Guía del equipo — LavaRapido (backend + frontend)

Todo lo que necesitas para levantar el proyecto, entrar a cada pantalla y crear un microservicio
nuevo siguiendo las mismas reglas. Léela completa la primera vez.

---

## 1. Cómo está organizado

Cada pieza vive en **su propio repositorio**:

| Repositorio | Qué tiene | Estado |
|---|---|---|
| `Front-end-proyecto-web` | App Angular (cliente, operario, admin) | Activo |
| `lavarapido-infra` | SQL Server, RabbitMQ y Mailpit en Docker, `docker-compose.yml`, plantilla `.env`, esta guía | Activo |
| `lavarapido-security-service` | Cuentas, login con JWT, recuperación de contraseña, perfil, usuarios | Activo |
| `lavarapido-customer-service` | Clientes, vehículos, puntos (copia) | Activo |
| `lavarapido-booking-service` | Catálogo, precios, horarios, bahías, reservas | Por hacer |
| `lavarapido-operations-service` | Operarios, disponibilidad, ejecución, calificaciones | Por hacer |
| `lavarapido-payment-service` | Promociones, pagos, comprobantes, puntos (libro contable) | Por hacer |
| `lavarapido-notification-service` | Notificaciones: bandeja, push al celular, mensajes del admin; escucha eventos de RabbitMQ | Activo |

Todos los servicios usan **la misma base de datos** (`LavaRapido` en SQL Server), pero cada uno
es dueño de **sus propios esquemas** y nadie toca las tablas de otro (ADR-003, ADR-009). Por eso
la base de datos está en `lavarapido-infra` y no dentro de un servicio.

### Carpetas: clona todo uno al lado del otro

Los servicios buscan el `.env` en `../lavarapido-infra/.env`, así que los nombres de carpeta
importan. **No cambies el nombre al clonar.**

```
Proyecto/
├── Front-end-proyecto-web/          (o como lo tengas)
└── Backend/
    ├── lavarapido-infra/
    ├── lavarapido-security-service/
    └── lavarapido-<nombre>-service/  ← los que vengan
```

---

## 2. Lo que necesitas instalar (una sola vez)

| Programa | Versión | Para qué | Verificar |
|---|---|---|---|
| Git | cualquiera reciente | Clonar | `git --version` |
| Docker Desktop | 24+ | Correr SQL Server | `docker --version` |
| JDK | 21 o superior | Correr los servicios Java | `java --version` |
| Node.js | 20+ | Correr el front | `node --version` |

No necesitas instalar Maven: cada servicio trae `mvnw` (Maven Wrapper).

---

## 3. Primera vez (paso a paso)

### 3.1 Clonar

```powershell
mkdir Backend; cd Backend
git clone https://github.com/BrayanCABRERA123/lavarapido-infra.git
git clone https://github.com/BrayanCABRERA123/lavarapido-security-service.git
```

Y el front, si no lo tienes:

```powershell
git clone https://github.com/BrayanCABRERA123/Front-end-proyecto-web.git
```

Trabajen siempre sobre la rama **`develop`** (`git checkout develop`).

### 3.2 Crear tu `.env` (secretos locales)

```powershell
cd lavarapido-infra
copy .env.example .env
```

Abre `.env` y llena:

- **`DB_PASSWORD`**: la contraseña que quieras para SQL Server. Debe tener mínimo 8 caracteres
  con mayúscula, minúscula, número y símbolo (ej. `Lavado_Local2026!`). Si es débil, SQL Server
  no arranca.
- **`JWT_SECRET`**: una llave larga (mínimo 32 caracteres). Puedes generarla con:
  ```powershell
  [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
  ```
  Todos los servicios de **tu** PC usan la misma, porque la leen del mismo `.env`.

> ⚠️ El `.env` **nunca se sube** a GitHub (ya está en `.gitignore`). Cada quien tiene el suyo.

### 3.3 Instalar dependencias del front

```powershell
cd Front-end-proyecto-web
npm install
```

---

## 4. Día a día: qué ejecutar en cada repo

Abre **una terminal por cada cosa** y déjalas abiertas.

| # | Dónde | Comando | Cuándo está listo |
|---|---|---|---|
| 1 | — | Abrir **Docker Desktop** | Dice *Engine running* |
| 2 | `lavarapido-infra` | `docker compose up -d` | `docker compose ps` muestra `lavarapido-sqlserver` **healthy** y `lavarapido-mailpit` arriba |
| 3 | `lavarapido-security-service` | `.\mvnw.cmd spring-boot:run` | Sale `Started SecurityServiceApplication` |
| 4 | `Front-end-proyecto-web` | `npx ng serve` | Abre http://localhost:4200 |

La primera vez el paso 3 tarda unos minutos porque descarga dependencias y crea las tablas.

**Para apagar:** `Ctrl + C` en las terminales 3 y 4, y en `lavarapido-infra`:
`docker compose down` (los datos se conservan). Para **borrar** la base y empezar de cero:
`docker compose down -v`.

**Alternativa (todo en Docker, sin Java instalado):** en `lavarapido-infra`:
`docker compose --profile app up -d --build`.

### Pruebas automáticas de un servicio

```powershell
cd lavarapido-security-service
.\mvnw.cmd test
```

Deben pasar todas (`BUILD SUCCESS`). No necesitan la base de datos.

---

## 5. Usuarios de prueba para entrar a cada pantalla

Se crean solos la primera vez que arranca `lavarapido-security-service` (perfil `dev`).

| Rol | Correo | Contraseña | Entra a |
|---|---|---|---|
| Administrador | `admin@gmail.com` | `Admin123!` | `/admin` |
| Operario | `operador@gmail.com` | `Operador123!` | `/operator` |
| Cliente | `cliente@gmail.com` | `Cliente123!` | `/client` |

- Cada rol **solo** puede entrar a su área; si intentas otra, te devuelve a la tuya.
- Sin iniciar sesión no se puede entrar a `/admin`, `/operator` ni `/client`.
- También puedes **registrarte** como cliente nuevo desde la pantalla de registro.

### Recuperar contraseña: ¿dónde llega el código?

Depende de lo que tengas en tu `lavarapido-infra/.env`:

| Configuración | Dónde ves el código |
|---|---|
| `MAIL_ENABLED=true` + Mailpit (**la que trae `.env.example`**) | En la bandeja de prueba **http://localhost:8025**. No le llega a nadie de verdad |
| `MAIL_ENABLED=true` + Gmail | En el **correo real** del usuario (revisa también spam) |
| `MAIL_ENABLED=false` | En la terminal del security-service: `[DEV] Password recovery code for ...: 123456` |

Mailpit se levanta solo con `docker compose up -d`. El correo trae el nombre del usuario, el
código de 6 dígitos y la hora en que vence.

**Para que llegue a Gmail de verdad** (solo quien tenga la cuenta del proyecto):
1. La cuenta necesita **verificación en dos pasos** activa.
2. Crear una **contraseña de aplicación** en https://myaccount.google.com/apppasswords
   (16 letras; se pega **sin espacios**).
3. En `.env`, comentar el bloque de Mailpit y llenar el de Gmail (`MAIL_HOST=smtp.gmail.com`,
   `MAIL_PORT=587`, usuario, contraseña de aplicación y `MAIL_FROM`).
4. Reiniciar el security-service.

> ⚠️ La contraseña de aplicación es secreta: solo va en tu `.env`, nunca en GitHub ni en el chat.

El código dura 15 minutos, sirve una sola vez y se bloquea después de 5 intentos fallidos.

### Reglas de contraseña

Mínimo 8 caracteres, una mayúscula, un número y un carácter especial (ej. `Lavado2026!`).

---

## 6. Qué está conectado al backend y qué no

| Conectado (datos reales) | Todavía con datos de prueba |
|---|---|
| Login, registro, recuperar contraseña | Reservas, vehículos, historial, pagos, notificaciones |
| Cambiar contraseña (modal del perfil) | Todo lo del operario |
| Cerrar sesión | Todo lo del admin (reservas, operarios, pagos, horarios, catálogo, promociones, reportes, usuarios) |
| Protección de rutas por rol | Editar perfil y preferencias (el backend ya tiene los endpoints) |

Las pantallas pendientes se conectan a medida que existan sus microservicios (tabla de la sección 1).

---

## 7. Swagger: ver y probar la API

Cada servicio tiene su documentación interactiva **solo en desarrollo**:

| Servicio | Swagger |
|---|---|
| security-service | http://localhost:3001/swagger-ui.html |
| notification-service | http://localhost:3006/swagger-ui.html |

**Cómo probar un endpoint protegido:**

1. Abre `POST /api/v1/auth/login` → **Try it out** → cuerpo:
   ```json
   { "email": "admin@gmail.com", "password": "Admin123!" }
   ```
   → **Execute**.
2. Copia el `accessToken` de la respuesta.
3. Botón **Authorize** (arriba a la derecha) → pega el token → **Authorize**.
4. Ya puedes ejecutar cualquier endpoint, por ejemplo `GET /api/v1/admin/users`.

> **Regla del equipo:** todo servicio nuevo **debe** traer Swagger (ver sección 8.4).

---

## 7.1 RabbitMQ: eventos entre servicios (ADR-004)

Los servicios se hablan de dos formas: **REST** cuando necesitan validar algo en el momento, y
**eventos por RabbitMQ** para avisar "pasó X" sin frenar al usuario (ej. notificaciones).

- `docker compose up -d` ya levanta RabbitMQ. Panel: http://localhost:15672 (`guest` / `guest`).
- En el `.env`: `MESSAGING_ENABLED=true` para que los servicios publiquen y escuchen. Con `false`
  todo funciona igual, pero los eventos solo quedan en el log.
- Exchange único: `carwash.events` (topic). Routing key: `<esquema>.<evento_en_snake_case>`,
  ej. `booking.confirmed` (tabla completa en `05-architecture/cross-cutting.md` §7).
- Todo mensaje lleva el mismo sobre (JSON):

```json
{ "eventId": "uuid", "eventType": "BookingConfirmed", "aggregateId": "145",
  "occurredAt": "2026-10-01T15:00:00Z", "version": 1, "payload": { } }
```

**Si tu servicio publica un evento que genera notificación** (booking, operations, payment), en el
`payload` va el `user_id` de quien la recibe: `customerUserId`, `operatorUserId`. La tabla de
campos por evento está en **ADR-011**. Publica **después** del commit de la base
(`TransactionSynchronization.afterCommit`), como hace `RabbitDomainEventPublisher` en el
security-service.

**Si tu servicio escucha eventos:** declara tu propia cola (`<tu-servicio>.events`) enlazada solo
a las routing keys que necesitas, y guarda el `eventId` procesado para ignorar repetidos (RabbitMQ
entrega "al menos una vez"). Ejemplo completo: `lavarapido-notification-service`.

Hoy publica: **security** (`security.user_registered`). Hoy escucha: **notification**. El
**customer-service** debe escuchar `security.user_registered` para crear el perfil de cliente
(su caso de uso `ConsumeUserRegisteredUseCase` ya existe; falta el listener).

## 8. Crear un microservicio nuevo (reglas para todos)

### 8.1 Nombres y puertos

| Servicio | Repositorio | Paquete Java | Puerto | Esquemas que le pertenecen |
|---|---|---|---|---|
| security | `lavarapido-security-service` | `com.lavarapido.security` | 3001 | `security`, `audit` |
| customer | `lavarapido-customer-service` | `com.lavarapido.customer` | 3002 | `customer` |
| booking | `lavarapido-booking-service` | `com.lavarapido.booking` | 3003 | `catalog`, `booking` |
| operations | `lavarapido-operations-service` | `com.lavarapido.operations` | 3004 | `execution` |
| payment | `lavarapido-payment-service` | `com.lavarapido.payment` | 3005 | `promotion`, `payment` |
| notification | `lavarapido-notification-service` | `com.lavarapido.notification` | 3006 | `notification` |

- Nombre del repo: siempre `lavarapido-<nombre>-service`, en minúsculas.
- `spring.application.name`: `<nombre>-service` (ej. `booking-service`).

### 8.2 Tecnología (igual para todos)

- Java 21, **Spring Boot 4.0.x**, Maven Wrapper.
- Crear el proyecto en https://start.spring.io con: Web MVC, Validation, Data JPA, Security,
  OAuth2 Resource Server, MS SQL Server Driver, Liquibase, Actuator.
- SQL Server + **Liquibase** (changelogs en SQL formateado, en `src/main/resources/db/changelog/`).
- En `application.yml`, cada servicio usa **su propia tabla de changelog**, porque todos migran la
  misma base:
  ```yaml
  spring:
    liquibase:
      database-change-log-table: DATABASECHANGELOG_BOOKING
      database-change-log-lock-table: DATABASECHANGELOGLOCK_BOOKING
    config:
      import:
        - optional:file:../lavarapido-infra/.env[.properties]
        - optional:file:.env[.properties]
  ```

### 8.3 Estructura interna (arquitectura hexagonal, ADR-007)

Copien la de `lavarapido-security-service`:

```
src/main/java/com/lavarapido/<nombre>/
├── domain/            reglas del negocio, SIN Spring ni JPA
│   ├── model/         entidades y value objects
│   ├── service/       políticas del dominio
│   ├── event/         eventos del dominio
│   ├── exception/     errores del negocio (con un "code")
│   └── port/in, port/out
├── application/usecase/   casos de uso (@Service + @Transactional)
└── infrastructure/
    ├── adapter/in/web/          controladores REST + DTOs
    ├── adapter/out/persistence/ entidades JPA + repositorios
    └── config/                  seguridad, Swagger, beans
```

### 8.4 Swagger (obligatorio)

1. En `pom.xml`:
   ```xml
   <properties>
     <springdoc.version>3.0.3</springdoc.version>
   </properties>
   ...
   <dependency>
     <groupId>org.springdoc</groupId>
     <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
     <version>${springdoc.version}</version>
   </dependency>
   ```
2. Copiar `OpenApiConfig.java` del security-service y cambiar el título.
3. En `SecurityConfig`, permitir sin token:
   `"/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html"`.
4. Apagado en `application.yml` y prendido solo en `application-dev.yml`
   (copiar ambos bloques `springdoc` del security-service).
5. Poner `@Tag(name = "...", description = "...")` en cada controlador.

### 8.5 Seguridad (JWT)

- **No** se hace login en cada servicio: el token lo emite el security-service.
- Cada servicio **verifica** el token con el mismo `JWT_SECRET`, `JWT_ISSUER` y `JWT_AUDIENCE`
  (copiar `JwtConfig.java`, `JwtProperties.java` y `SecurityConfig.java`, **sin** el `JwtEncoder`).
- El id del usuario sale del token (`sub`), **nunca** de la URL ni del cuerpo.
- Los roles vienen en el claim `roles` (`ADMIN`, `OPERATOR`, `CLIENT`).

### 8.6 Errores

Todos los errores salen en formato RFC 9457 (`application/problem+json`) con un campo `code`
estable, ej. `BOOKING_SLOT_TAKEN`. El front traduce ese `code` (en `assets/i18n`, sección
`API_ERRORS`). Copien `ApiExceptionHandler.java` y `ProblemDetailsSecurityHandler.java`.

### 8.7 Conectarlo al front

En `Front-end-proyecto-web/proxy.conf.json` agreguen la ruta del servicio nuevo, ej.:

```json
"/api/v1/bookings": { "target": "http://localhost:3003", "secure": false, "changeOrigin": true }
```

y reinicien `ng serve`. El front siempre llama rutas relativas (`/api/v1/...`).

### 8.8 Agregarlo a la infra

En `lavarapido-infra/docker-compose.yml` copien el bloque `security-service` y cambien nombre,
`build: ../lavarapido-<nombre>-service` y puerto.

---

## 9. Convenciones de código y Git

- **Nombres** de variables, métodos, clases, archivos: **en inglés**.
- **Comentarios** en el código: **en español**.
- Documentación de arquitectura (`vehicle-w-docs`): en inglés (ADR-001).
- Ramas: `main` (estable) ← `develop` (integración) ← `feature/<algo>` o `fix/<algo>`.
- Commits (Conventional Commits, en inglés):
  - `feat(booking): add booking creation endpoint`
  - `fix(auth): show error when server is offline`
  - `docs: update team guide`
  - `chore: bump springdoc version`
- Nunca subir: `.env`, contraseñas, la carpeta `target/`.

---

## 10. Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `Port 3001 was already in use` | Ya hay otra copia del servicio corriendo | `Get-NetTCPConnection -LocalPort 3001 -State Listen` y cerrar ese proceso (`Stop-Process -Id <id>`) si es un `java.exe` |
| `Connection refused ... port 1433` | SQL Server apagado | Abrir Docker Desktop y `docker compose up -d` en `lavarapido-infra` |
| `security.jwt.secret ... must be set` | Falta el `.env` o el `JWT_SECRET` es corto | Revisar `lavarapido-infra/.env` (sección 3.2) |
| El login dice "No hay conexión con el servidor" | El servicio no está corriendo, o `ng serve` se abrió antes de tener el proxy | Levantar el servicio y reiniciar `ng serve` |
| SQL Server no arranca en Docker | `DB_PASSWORD` muy débil | Poner una más fuerte en `.env` y `docker compose down -v` + `up -d` |
| `mvnw` no se reconoce | Estás en PowerShell | Usar `.\mvnw.cmd` |
| No llega el correo de recuperación | `MAIL_ENABLED=false`, Mailpit apagado, o la contraseña de aplicación de Gmail está mal | Revisar el `.env`; en la terminal del servicio buscar `Could not send the password recovery email` |
| Gmail responde `535 Username and Password not accepted` | Se usó la contraseña normal o se pegó con espacios | Usar la contraseña de aplicación de 16 letras, sin espacios |

---

## 11. Documentos de referencia

- Decisiones de arquitectura: `vehicle-w-docs/05-architecture/decisions/records/`
  - **ADR-009**: los 6 servicios y qué esquemas tiene cada uno.
  - **ADR-006**: JWT y permisos.
  - **ADR-007**: arquitectura hexagonal.
  - **ADR-010**: qué cambia en el modelo de datos y qué cambia en el front.
- Modelo de datos: `vehicle-w-docs/06-data/models.md`.
- API del security-service: su Swagger (sección 7) y su `README.md`.
