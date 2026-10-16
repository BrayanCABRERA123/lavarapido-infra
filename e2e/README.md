# Pruebas entre servicios y RNF (entorno local)

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

## Antes de correrlas

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
uno compartido.
