// Prueba entre servicios: el cliente ve los operarios libres, reserva eligiendo uno, operations lo
// asigna solo (booking.confirmed por RabbitMQ), notification avisa y el inicio del admin la cuenta.
// Toca booking, operations, notification, security (contacto interno) y el gateway.
//   node --test "e2e/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNTS, sign, api, deleteBookings, waitFor, farWeekday } = require('./lib');

const created = [];

test.after(() => deleteBookings(created));

test('reserva → asignación automática → avisos → resumen del día', async (t) => {
  const client = sign(ACCOUNTS.client, ['CLIENT']);
  const admin = sign(ACCOUNTS.admin, ['ADMIN']);
  const date = farWeekday();

  const vehicles = await api('GET', '/vehicles', client);
  assert.equal(vehicles.status, 200, 'customer-service: vehículos del cliente');
  const vehicle = (Array.isArray(vehicles.body) ? vehicles.body : vehicles.body.items)[0];
  assert.ok(vehicle, 'el cliente de prueba necesita al menos un vehículo');

  const services = await api('GET', `/catalog/services?vehicleTypeId=${vehicle.vehicleTypeId}`);
  assert.equal(services.status, 200);
  const service = services.body[0];
  const minutes = service.prices[0].estimatedMinutes;

  const free = await api('GET', `/operators/available?date=${date}&time=09:00&minutes=${minutes}`, client);
  assert.equal(free.status, 200, 'operations: operarios libres (RF-010)');
  assert.ok(free.body.length > 0, `nadie libre el ${date} a las 09:00: revisa los turnos de los operarios`);
  const chosen = free.body[0].operatorId;

  const booking = await api('POST', '/bookings', client,
    { vehicleId: vehicle.id, paymentMode: 'DIGITAL', serviceIds: [service.id], date, time: '09:00', preferredOperatorId: chosen });
  assert.equal(booking.status, 201, `booking: crear la reserva (${JSON.stringify(booking.body).slice(0, 120)})`);
  created.push(booking.body.id);

  await t.test('operations la asigna sola al operario elegido (RF-008)', async () => {
    const assignment = await waitFor(async () => {
      const list = await api('GET', `/admin/assignments?from=${date}&to=${date}`, admin);
      return list.status === 200 && list.body.find((a) => a.bookingId === booking.body.id);
    });
    assert.ok(assignment, 'no llegó la asignación: ¿MESSAGING_ENABLED e INTERNAL_API_KEY están en el .env?');
    assert.equal(assignment.operatorId, chosen);
  });

  await t.test('notification avisa al cliente: reserva confirmada y operario asignado', async () => {
    const titles = await waitFor(async () => {
      const inbox = await api('GET', '/notifications?page=0&size=20', client);
      const items = Array.isArray(inbox.body) ? inbox.body : (inbox.body.items ?? inbox.body.content ?? []);
      const mine = items.filter((n) => n.referenceId === booking.body.id).map((n) => n.title);
      return mine.length >= 2 ? mine : null;
    });
    assert.ok(titles, 'no llegaron los avisos del cliente');
    assert.equal(titles.length >= 2, true);
  });

  await t.test('el inicio del admin cuenta la reserva del día', async () => {
    const summary = await api('GET', `/admin/bookings/day-summary?date=${date}`, admin);
    assert.equal(summary.status, 200);
    assert.ok(summary.body.bookings >= 1);
  });

  await t.test('las rutas internas de booking no salen por el gateway', async () => {
    const internal = await api('GET', `http://localhost:8080/internal/v1/bookings?from=${date}&to=${date}`);
    assert.ok([401, 404].includes(internal.status), String(internal.status));
  });
});
