// Cambios de estado y cancelaciones contra un despliegue (con E2E_ALLOW_WRITES=1):
//   A-11: el cliente recibe el aviso cuando el admin cambia el estado de su reserva;
//   A-20: el admin cancela con el motivo que elige y el cliente solo con los motivos de su lado;
//   E-16: una placa de más de 6 caracteres se rechaza (no se corta); BIZ-04: precio 0 → INVALID_PRICE.
// Las reservas se hacen semanas adelante con el operario de prueba (así ningún operario real recibe
// el servicio) y quedan canceladas o en "no asistió"; el vehículo se retira al final.
//   E2E_ALLOW_WRITES=1 BASE_URL=https://... node --test e2e/remote/booking-status.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

const cleanup = L.createCleanup();
test.after(async () => { await cleanup.run(); await L.closeSessions(); });

const ctx = {};

/** Reserva nueva del cliente de prueba, a una hora en que el operario de prueba está libre. */
async function book(daysAhead) {
  const date = L.farWeekday(daysAhead);
  const slot = await L.findSlot({ token: ctx.client.token, date, vehicleTypeId: ctx.type.id, serviceIds: [ctx.service.id], operatorId: ctx.operatorId });
  assert.ok(slot, `el operario de prueba no tiene horas libres el ${date}: revisa sus turnos`);
  const res = await L.api('POST', '/bookings', { token: ctx.client.token, body: {
    vehicleId: ctx.vehicle.id, serviceIds: [ctx.service.id], date, time: slot.time, preferredOperatorId: ctx.operatorId } });
  assert.equal(res.status, 201, `reservar → ${L.describe(res)}`);
  cleanup.add(`cancelar la reserva ${res.body.id}`, () => L.cancelBooking(ctx.admin.token, res.body.id));
  return res.body;
}

test.before(async () => {
  if (!L.flags.writes) return;
  ctx.admin = await L.session('admin');
  ctx.client = await L.session('client');
  ctx.operatorId = await L.operatorIdOf(ctx.admin.token, (await L.session('operator')).user.id);
  const { type, services } = await L.vehicleTypeWithServices();
  ctx.type = type;
  ctx.service = services[0];
  ctx.vehicle = await L.createVehicle(ctx.client.token, type.code);
  cleanup.add(`retirar el vehículo ${ctx.vehicle.id}`, () => L.retireVehicle(ctx.client.token, ctx.vehicle.id));
});

test('A-11: el admin marca "no asistió" y el cliente recibe el aviso', { skip: L.NEEDS_WRITES }, async () => {
  const booking = await book(36);
  const res = await L.api('PATCH', `/admin/bookings/${booking.id}/status`, { token: ctx.admin.token, body: { status: 'NO_SHOW' } });
  assert.equal(res.status, 200, `cambiar el estado → ${L.describe(res)}`);
  assert.equal(res.body.status, 'NO_SHOW');
  assert.ok(await L.waitForNotice(ctx.client.token, booking.id, 'BOOKING_CANCELLED'), 'el cliente no recibió el aviso del cambio de estado');
  const seen = await L.api('GET', `/bookings/${booking.id}`, { token: ctx.client.token });
  assert.equal(seen.body.status, 'NO_SHOW');
});

test('A-20: el admin cancela con el motivo que elige; el cliente recibe el aviso', { skip: L.NEEDS_WRITES }, async () => {
  const reasons = L.list((await L.api('GET', '/bookings/cancellation-reasons', { token: ctx.client.token })).body).map((r) => r.code);
  assert.ok(!reasons.includes('EXPIRED'), 'el motivo del sistema no se ofrece');
  const reasonCode = reasons.includes('SHOP_ISSUE') ? 'SHOP_ISSUE' : 'SCHEDULE_CONFLICT';
  const booking = await book(39);
  const res = await L.api('PATCH', `/admin/bookings/${booking.id}/status`, { token: ctx.admin.token, body: { status: 'CANCELLED', reasonCode } });
  assert.equal(res.status, 200, `cancelar → ${L.describe(res)}`);
  assert.equal(res.body.status, 'CANCELLED');
  assert.equal(res.body.cancellationReason?.code, reasonCode, 'no quedó el motivo elegido');
  assert.ok(await L.waitForNotice(ctx.client.token, booking.id, 'BOOKING_CANCELLED'), 'aviso de reserva cancelada');
});

test('A-20: el cliente cancela con un motivo de su lado, no con uno del lavadero', { skip: L.NEEDS_WRITES }, async () => {
  const reasons = L.list((await L.api('GET', '/bookings/cancellation-reasons', { token: ctx.client.token })).body).map((r) => r.code);
  const booking = await book(42);
  if (reasons.includes('SHOP_ISSUE')) {
    L.expectProblem(await L.api('POST', `/bookings/${booking.id}/cancel`, { token: ctx.client.token, body: { reasonCode: 'SHOP_ISSUE' } }),
      400, 'INVALID_CANCELLATION_REASON', 'motivo del lavadero');
  }
  const res = await L.api('POST', `/bookings/${booking.id}/cancel`, { token: ctx.client.token, body: { reasonCode: 'SCHEDULE_CONFLICT' } });
  assert.equal(res.status, 200, `cancelar → ${L.describe(res)}`);
  assert.equal(res.body.cancellationReason?.code, 'SCHEDULE_CONFLICT');
});

test('E-16: una placa de 7 caracteres se rechaza en vez de cortarse', { skip: L.NEEDS_WRITES }, async () => {
  const res = await L.api('POST', '/vehicles', { token: ctx.client.token,
    body: { licensePlate: `${L.randomPlate()}7`, vehicleType: ctx.type.code, brand: 'E2E', model: 'Placa larga' } });
  if (res.status === 201) cleanup.add(`retirar el vehículo ${res.body.id} creado por error`, () => L.retireVehicle(ctx.client.token, res.body.id));
  L.expectProblem(res, 400, 'INVALID_PLATE', 'placa de 7');
});

test('BIZ-04: un servicio con precio 0 se rechaza (INVALID_PRICE)', { skip: L.NEEDS_WRITES }, async () => {
  const categories = L.list((await L.api('GET', '/catalog/categories', { token: ctx.client.token })).body);
  assert.ok(categories.length, 'el catálogo no tiene categorías');
  const res = await L.api('POST', '/admin/catalog/services', { token: ctx.admin.token, body: {
    name: `Prueba e2e precio cero ${L.stamp()}`, categoryId: categories[0].id, loyaltyPoints: 0,
    prices: [{ vehicleTypeId: ctx.type.id, price: 0, estimatedMinutes: 30 }] } });
  if (res.status === 201) {
    cleanup.add(`borrar el servicio ${res.body.id} creado por error`, () => L.api('DELETE', `/admin/catalog/services/${res.body.id}`, { token: ctx.admin.token }));
  }
  L.expectProblem(res, 400, 'INVALID_PRICE', 'precio 0');
});

test('BIZ-08: sin reservas activas el vehículo sí se retira', { skip: L.NEEDS_WRITES }, async () => {
  // las tres reservas de arriba quedaron canceladas o en "no asistió"
  const res = await L.api('DELETE', `/vehicles/${ctx.vehicle.id}`, { token: ctx.client.token });
  assert.equal(res.status, 204, `retirar → ${L.describe(res)}`);
  const vehicles = await L.api('GET', '/vehicles', { token: ctx.client.token });
  assert.ok(!L.list(vehicles.body).some((v) => v.id === ctx.vehicle.id), 'el vehículo sigue en la lista');
});
