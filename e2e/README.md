# Pruebas e2e de LavaRápido

Hay dos baterías, las dos con Node 22+ y `node:test`, sin paquetes que instalar:

- **`remote/`: contra un despliegue** (Azure o cualquier URL). Inicia sesión por la API con cuentas
  de prueba que llegan por variables de entorno, no toca la base y limpia por la API lo que crea.
  Es la que demuestra que el sistema desplegado funciona.
- **Las de esta carpeta: entorno local** (más abajo). Firman tokens con el `JWT_SECRET` del `.env`
  y borran por SQL: solo sirven en el computador de desarrollo.

## 1. Contra un despliegue (`remote/`)

```bash
# desde lavarapido-infra: solo lee y prueba rechazos (sirve contra producción)
BASE_URL=https://lavarapidovehicular.northcentralus.cloudapp.azure.com \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
E2E_CLIENT_EMAIL=... E2E_CLIENT_PASSWORD=... \
E2E_OPERATOR_EMAIL=... E2E_OPERATOR_PASSWORD=... \
node e2e/remote/run.js

# todo, con datos de prueba
E2E_ALLOW_WRITES=1 node e2e/remote/run.js
# solo algunos archivos
node e2e/remote/run.js access roles
```

`run.js` inicia sesión una vez por rol, corre los archivos en orden, cierra las sesiones y deja para
el final la prueba del límite de `/auth`. Un archivo también se corre solo, por ejemplo
`node --test e2e/remote/roles.test.js` (inicia y cierra sus propias sesiones).

En GitHub: **Actions → E2E contra un despliegue → Run workflow** (`.github/workflows/e2e.yml`), con
la URL y las banderas en el formulario. No corre sola en cada push.

### Variables

| Variable | Para qué |
|---|---|
| `BASE_URL` (o `E2E_BASE_URL`) | Dirección del sitio, sin `/api` (obligatoria). |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | Cuenta de prueba con rol ADMIN (obligatorias). |
| `E2E_CLIENT_EMAIL`, `E2E_CLIENT_PASSWORD` | Cuenta de prueba con rol CLIENT (obligatorias). |
| `E2E_OPERATOR_EMAIL`, `E2E_OPERATOR_PASSWORD` | Cuenta de prueba con rol OPERATOR (obligatorias). |
| `E2E_SIGNUP_EMAIL` | Un gmail **del equipo** (sin `+`); solo con `E2E_ALLOW_SIGNUP=1`. |
| `E2E_SECOND_OPERATOR_ID` | Opcional: id de operations de un segundo operario de prueba, para reasignar de verdad a otra persona y volver. |
| `E2E_VEHICLE_TYPE` | Tipo del vehículo de prueba (por defecto `CAR`). |
| `E2E_START_WAIT_MINUTES` | Cuánto espera a que la reserva de hoy se pueda iniciar (por defecto 20). |
| `E2E_ZONE` | Zona horaria del lavadero (por defecto `America/Bogota`). |
| `E2E_RATE_LIMIT_MAX` | Máximo de intentos de login para llegar al 429 (por defecto 120). |
| `E2E_TIMEOUT_MS` | Tiempo máximo de cada petición (por defecto 20000). |

Las credenciales solo salen de estas variables (en GitHub, de los secretos `E2E_*` del repositorio).
Nada las imprime. Usa cuentas **de prueba**, nunca la de una persona real.

### Banderas

Por defecto la batería solo lee y prueba rechazos: no queda nada creado y se puede correr contra
producción.

| Bandera | Qué habilita | Qué deja |
|---|---|---|
| `E2E_ALLOW_WRITES=1` | Vehículos, reservas, cupones temporales y pagos de prueba, siempre con las cuentas E2E. | Lo deshace todo (devuelve el pago, cancela, borra los cupones y retira el vehículo), menos la reserva de hoy, que queda completada y calificada. |
| `E2E_ALLOW_SIGNUP=1` | Abre cuentas nuevas con alias `+e2e…` de `E2E_SIGNUP_EMAIL`. | Las cuentas quedan inhabilitadas por el admin. |
| `E2E_RATE_LIMIT=1` | La ráfaga de logins que dispara el 429. | La IP que corre las pruebas sin poder iniciar sesión un rato. |

Con `E2E_ALLOW_SIGNUP` el servidor manda correos de bienvenida y de recuperación. Como el servidor
solo acepta `gmail.com`, las cuentas usan alias del buzón del equipo (`<buzón>+e2e…@gmail.com`
llega a `<buzón>@gmail.com`), así nunca le escriben a un tercero. Si no hay un buzón del equipo,
esa bandera solo se usa contra un entorno con `MAIL_ENABLED=false`.

### Qué valida cada archivo

| Archivo | Bandera | Qué valida |
|---|---|---|
| `access.test.js` | ninguna | API pública y encabezados de seguridad. **E-01**: `/api/v1/operator/bookings/**` da 404 o 401 por el gateway. `/internal/**` no llega a la API. **SEC-01**: después del logout el token da 401 en los 6 servicios con `bearer`, `Bearer` y `BEARER`, también si se usó en minúscula antes. **A-01**: registro y crear operario con otro dominio → `EMAIL_DOMAIN_NOT_ALLOWED`; login con otro dominio → `INVALID_CREDENTIALS`; recuperar → 202. |
| `roles.test.js` | ninguna | **F-04**: las 70 rutas de admin de los 6 servicios dan 401 sin token y 403 con CLIENT y con OPERATOR (salvo `GET /admin/vehicles`, que el operario usa a propósito); con ADMIN las lecturas existen. Las rutas solo del cliente dan 403 al operario y al admin, y las del operario al cliente y al admin. Las rutas que escriben van con un id que no existe y un cuerpo inválido: no cambian nada aunque la autorización fallara. |
| `full-flow.test.js` | `E2E_ALLOW_WRITES` | Flujo por rol. Cliente: vehículo, reserva con su operario, asignación automática y avisos. **E-01** con la reserva real. Operario: `SERVICE_TOO_EARLY` antes de 15 minutos. Admin: reasignar con notas que el operario ve (**B-01**). Cupón: el GET de `/loyalty/redemptions/{bookingId}` y el DELETE del contrato (**BIZ-02**, **E-08**), `PROMOTION_ONE_PER_BOOKING` (**E-09**) y el 100 % rechazado (**E-07**). **BIZ-01**: `BOOKING_SERVICES_LOCKED` y reprogramar solo fecha y hora. **BIZ-08**: `VEHICLE_HAS_ACTIVE_BOOKINGS`. Pago reportado con el monto del servidor, `AMOUNT_CHANGED` si el admin cambió los servicios y aprobación con aviso. En una reserva de hoy: iniciar, terminar, avisos y calificación (se salta si hoy no hay hora libre del operario a menos de `E2E_START_WAIT_MINUTES` + 15 minutos). |
| `booking-status.test.js` | `E2E_ALLOW_WRITES` | **A-11**: el cliente recibe el aviso cuando el admin marca "no asistió". **A-20**: el admin cancela con el motivo que elige; el cliente solo con los de su lado (`INVALID_CANCELLATION_REASON`). **E-16**: placa de 7 caracteres → `INVALID_PLATE`. **BIZ-04**: precio 0 → `INVALID_PRICE`. **BIZ-08**: sin reservas activas el vehículo sí se retira. |
| `signup.test.js` | `E2E_ALLOW_SIGNUP` | **SEC-07**: `CONSENT_REQUIRED`. **A-01**: gmail en mayúsculas se acepta al registrarse y al crear usuarios; cambiar el correo a otro dominio → `EMAIL_DOMAIN_NOT_ALLOWED`. **SEC-12** y **SEC-05**: contraseña actual o código de recuperación errados muchas veces → `TOO_MANY_ATTEMPTS`. |
| `rate-limit.test.js` | `E2E_RATE_LIMIT` | **SEC-04**: una ráfaga de logins con un correo inexistente recibe 429 `RATE_LIMITED`, y el resto de la API sigue respondiendo a esa IP. |

### Lo que necesita el despliegue

- Las tres cuentas de prueba activas. El operario de prueba con **turnos** que cubran varias horas
  de los días hábiles: las reservas se hacen a una hora en que él está libre, así ningún operario
  real recibe servicios de prueba.
- Al menos un **medio de pago con comprobante** activo (Nequi, Daviplata o transferencia), y dos
  servicios con precio para el tipo `E2E_VEHICLE_TYPE`. Si falta alguno, esos pasos se saltan con
  el motivo.
- RabbitMQ y notification-service funcionando: los avisos se esperan hasta 30 segundos.
- Para la reserva de hoy, correrla en horario de atención y con el operario de turno.

## 2. Entorno local (scripts de esta carpeta)

Scripts de Node (22+) que prueban el sistema completo por el api-gateway, con los servicios
corriendo en local y la base de Docker. Leen `../.env` (nunca lo imprimen) y usan las cuentas
reales del equipo: cliente `10002`, administrador `60002` y operario `50002`. Se cambian con
`E2E_CLIENT_ID`, `E2E_ADMIN_ID` y `E2E_OPERATOR_ID` cuando la base local tiene otros números. No
registran cuentas nuevas y borran por SQL lo que crean.

| Script | Qué verifica | Comando |
|---|---|---|
| `booking-flow.test.js` | El cliente ve los operarios libres (RF-010), reserva eligiendo uno, operations lo asigna solo (RF-008, por RabbitMQ), notification avisa al cliente, el inicio del admin cuenta la reserva y las rutas internas no salen por el gateway. | `node --test "e2e/*.test.js"` |
| `full-flow.test.js` | Flujo de los tres roles: reserva → asignación automática → pago reportado → aprobación con puntos → el operario inicia y termina → el cliente califica, revisando cada aviso. Deja los puntos y cupones del cliente como estaban. | `node --test e2e/full-flow.test.js` |
| `inspection-flow.test.js` | Informe de inspección (RF-036 a RF-038): servicio temporal de 200 minutos, hallazgo con fotos (máximo 5), publicar, compartir, enlace público sin placa ni correos, foto pública y aviso al cliente. | `node --test e2e/inspection-flow.test.js` |
| `access-rules.test.js` | Permisos por rol, rutas internas, dirección del perfil, filtros de pagos, datos tributarios solo para el admin, validación de la ficha del operario, reserva fuera del horario (`reason: OUTSIDE_HOURS`) y que un token de una cuenta inexistente no cree operarios. | `node --test e2e/access-rules.test.js` |
| `performance.js` | RNF-001: p95 < 2 s en las lecturas más usadas (30 peticiones por endpoint). Solo lee. | `node e2e/performance.js` |
| `width-360.js` | RNF-008: ninguna pantalla de la web se sale de 360 px de ancho (deja capturas en `e2e/shots/`). | `npm install --prefix e2e` (una vez) y `node e2e/width-360.js` |

### Antes de correrlas

- `docker compose up -d sqlserver rabbitmq mailpit`, los servicios Java y payment arrancados, y en
  el `.env` `MESSAGING_ENABLED=true`, `INTERNAL_API_KEY` y `PUSH_ENABLED=false` (así nadie recibe
  push de verdad).
- El operario de prueba necesita **turnos** que cubran las 9:00 de lunes a viernes (Operarios →
  Turnos en la web del admin). Sin turnos nadie sale libre y la asignación automática no tiene a
  quién escoger.
- El negocio necesita al menos un **medio de pago con comprobante** activo (Nequi, Daviplata o
  transferencia), además de la caja: el flujo completo reporta el pago con ese medio.
- El horario del negocio debe abrir antes de las 9:00 los días hábiles.
- Para `width-360.js`, la web con `ng serve` en el puerto 4200 y Microsoft Edge (o
  `E2E_BROWSER=chrome`).

Ejemplo con las cuentas de una base recién creada (admin 1, operario 2, cliente 10002):

```bash
E2E_ADMIN_ID=1 E2E_OPERATOR_ID=2 E2E_CLIENT_ID=10002 node --test "e2e/*.test.js"
```

Los tokens de prueba se firman aquí con `JWT_SECRET`: sirven solo en el entorno local, nunca en
uno compartido. Contra un despliegue se usa `remote/`.
