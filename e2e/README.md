# Pruebas entre servicios y RNF (entorno local)

Scripts de Node (22+) que prueban el sistema completo por el api-gateway, con los servicios
corriendo en local y la base de Docker. Leen `../.env` (nunca lo imprimen) y usan las cuentas
reales del equipo: cliente `10002` y administrador `60002` (se cambian con `E2E_CLIENT_ID` y
`E2E_ADMIN_ID`). No registran cuentas nuevas.

| Script | Qué verifica | Comando |
|---|---|---|
| `booking-flow.test.js` | El cliente ve los operarios libres (RF-010), reserva eligiendo uno, operations lo asigna solo (RF-008, por RabbitMQ), notification avisa al cliente, el inicio del admin cuenta la reserva y las rutas internas no salen por el gateway. Borra por SQL lo que crea. | `node --test "e2e/*.test.js"` |
| `performance.js` | RNF-001: p95 < 2 s en las lecturas más usadas (30 peticiones por endpoint). Solo lee. | `node e2e/performance.js` |
| `width-360.js` | RNF-008: ninguna pantalla de la web se sale de 360 px de ancho (deja capturas en `e2e/shots/`). | `npm install --prefix e2e` (una vez) y `node e2e/width-360.js` |

Requisitos: `docker compose up -d sqlserver rabbitmq mailpit`, los servicios Java y payment
arrancados, `MESSAGING_ENABLED=true` e `INTERNAL_API_KEY` en el `.env`; para `width-360.js`, la web
con `ng serve` en el puerto 4200 y Microsoft Edge (o `E2E_BROWSER=chrome`).

Los tokens de prueba se firman aquí con `JWT_SECRET`: sirven solo en el entorno local, nunca en
uno compartido.
