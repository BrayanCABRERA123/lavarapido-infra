// Flujo completo entre los tres roles, por el gateway y con las cuentas reales del equipo:
//   cliente reserva eligiendo operario → se asigna solo → el cliente reporta el pago → el admin lo
//   aprueba (y el cliente gana puntos) → el operario inicia y termina el servicio → el cliente califica.
// Cada paso revisa también el aviso que debe recibir el cliente. Al final se borra todo lo creado
// (reserva, pago, comprobante, puntos, avisos) y los puntos del cliente quedan como estaban.
//
// Para poder iniciar el servicio (se permite desde 15 minutos antes), la reserva de prueba se mueve a
// "dentro de 10 minutos" directamente en la base: solo esa reserva, que luego se borra.
//   node --test e2e/full-flow.test.js
// Usa notification-service con Mailpit y PUSH_ENABLED=false para no escribirle a nadie de verdad.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ACCOUNTS, sign, api, sql, deleteBookings, waitFor, farWeekday } = require('./lib');

const OPERATOR_USER = Number(process.env.E2E_OPERATOR_ID ?? 50002);
// comprobante mínimo válido (PNG de 1x1)
const RECEIPT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const state = { bookingId: null, paymentIds: [], pointsBefore: null, couponsBefore: null };

const clientInbox = async (client, bookingId) => {
  const inbox = await api('GET', '/notifications?page=0&size=50', client);
  return (inbox.body.items ?? []).filter((n) => n.referenceId === bookingId || state.paymentIds.includes(n.referenceId));
};
const waitForNotice = (client, type) => waitFor(async () => {
  const mine = await clientInbox(client, state.bookingId);
  return mine.find((n) => n.type === type) ?? null;
}, 20000);

test.before(() => {
  state.pointsBefore = sql(`SELECT CAST(loyalty_points AS varchar) FROM customer.customer WHERE user_id = ${ACCOUNTS.client}`);
  state.couponsBefore = sql(`SELECT ISNULL(MAX(promotion_customer_id), 0) FROM promotion.promotion_customer`);
});

test.after(() => {
  const id = state.bookingId;
  if (id) {
    const payments = state.paymentIds.length ? state.paymentIds.join(',') : '0';
    sql(`DELETE FROM notification.notification WHERE reference_entity = 'payment' AND reference_id IN (${payments});
DELETE FROM payment.payment_receipt WHERE payment_id IN (SELECT payment_id FROM payment.payment WHERE booking_id = ${id});
DELETE FROM payment.loyalty_transaction WHERE booking_id = ${id};
DELETE FROM promotion.booking_promotion WHERE booking_id = ${id};
DELETE FROM payment.payment WHERE booking_id = ${id};
DELETE FROM execution.inspection_report WHERE booking_id = ${id};`);
    deleteBookings([id]);
  }
  // puntos y cupones del cliente como estaban antes de la prueba
  if (state.pointsBefore !== null) sql(`UPDATE customer.customer SET loyalty_points = ${Number(state.pointsBefore)} WHERE user_id = ${ACCOUNTS.client}`);
  if (state.couponsBefore !== null) sql(`DELETE FROM promotion.promotion_customer WHERE promotion_customer_id > ${Number(state.couponsBefore)}`);
});

test('flujo completo: cliente → admin → operario → cliente', async (t) => {
  const client = sign(ACCOUNTS.client, ['CLIENT']);
  const admin = sign(ACCOUNTS.admin, ['ADMIN']);
  const operator = sign(OPERATOR_USER, ['OPERATOR']);
  const date = farWeekday(45);

  // ---------------------------------------------------------------- cliente reserva
  const vehicles = await api('GET', '/vehicles', client);
  const vehicle = (Array.isArray(vehicles.body) ? vehicles.body : vehicles.body.items)[0];
  assert.ok(vehicle, 'el cliente necesita al menos un vehículo');
  const services = await api('GET', `/catalog/services?vehicleTypeId=${vehicle.vehicleTypeId}`);
  const service = services.body[0];
  const minutes = service.prices[0].estimatedMinutes;

  const free = await api('GET', `/operators/available?date=${date}&time=09:00&minutes=${minutes}`, client);
  assert.equal(free.status, 200);
  const operatorView = (await api('GET', '/operator/services', operator));
  assert.equal(operatorView.status, 200, 'la cuenta del operario responde');
  // se elige al operario de la cuenta de prueba (E2E_OPERATOR_ID), no al primero libre: si hay más
  // operarios con turno, la reserva tiene que quedar con el que luego la inicia y la termina
  const roster = await api('GET', '/admin/operators', admin);
  const myOperatorId = roster.body.find?.((o) => o.userId === OPERATOR_USER)?.id;
  assert.ok(myOperatorId, `la cuenta ${OPERATOR_USER} no es operario: revisa E2E_OPERATOR_ID`);
  const mineAsOperator = free.body.find((o) => o.operatorId === myOperatorId);
  assert.ok(mineAsOperator, `el operario de prueba no está libre el ${date} a las 09:00: revisa sus turnos`);

  const booking = await api('POST', '/bookings', client,
    { vehicleId: vehicle.id, serviceIds: [service.id], date, time: '09:00', preferredOperatorId: mineAsOperator.operatorId });
  assert.equal(booking.status, 201, JSON.stringify(booking.body).slice(0, 160));
  state.bookingId = booking.body.id;
  const total = booking.body.total;

  await t.test('1. se asigna sola al operario elegido y el cliente recibe los avisos', async () => {
    const assignment = await waitFor(async () => {
      const list = await api('GET', `/admin/assignments?from=${date}&to=${date}`, admin);
      return list.body.find?.((a) => a.bookingId === state.bookingId);
    });
    assert.ok(assignment, 'sin asignación automática');
    assert.equal(assignment.operatorId, mineAsOperator.operatorId);
    assert.ok(await waitForNotice(client, 'BOOKING_CONFIRMED'), 'aviso de reserva confirmada');
    assert.ok(await waitForNotice(client, 'OPERATOR_ASSIGNED'), 'aviso de operario asignado');
  });

  // ---------------------------------------------------------------- cliente paga, admin aprueba
  await t.test('2. el cliente reporta el pago y queda en revisión', async () => {
    const accounts = await api('GET', '/payment-accounts', client);
    const account = accounts.body.find((a) => a.methodCode !== 'EFECTIVO') ?? accounts.body[0];
    const reference = crypto.randomBytes(5).toString('hex').toUpperCase();
    const report = await api('POST', '/payments', client,
      { bookingId: state.bookingId, paymentAccountId: account.id, transactionReference: reference, receiptImage: RECEIPT, reportedAmount: total });
    assert.equal(report.status, 201, JSON.stringify(report.body).slice(0, 200));
    state.paymentIds.push(report.body.id);
    const mine = await api('GET', '/payments/me/bookings', client);
    const row = mine.body.find((p) => p.bookingId === state.bookingId);
    assert.ok(['PENDING', 'IN_REVIEW'].includes(row?.paymentStatus), `estado: ${row?.paymentStatus}`);
  });

  await t.test('3. el admin ve el pago en la cola y lo aprueba; el cliente lo ve aprobado y gana puntos', async () => {
    const queue = await api('GET', '/admin/payments', admin);
    assert.ok(queue.body.some?.((p) => p.id === state.paymentIds[0]) ?? JSON.stringify(queue.body).includes(String(state.paymentIds[0])), 'el pago no está en la cola del admin');
    const approved = await api('POST', `/admin/payments/${state.paymentIds[0]}/approve`, admin);
    assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 200));
    assert.equal(approved.body.status, 'APPROVED');
    const mine = await api('GET', '/payments/me', client);
    assert.equal(mine.body.find((p) => p.id === state.paymentIds[0])?.status, 'APPROVED');
    assert.ok(await waitForNotice(client, 'PAYMENT_CONFIRMED'), 'aviso de pago aprobado');
    const points = await waitFor(async () => {
      const balance = await api('GET', '/loyalty/balance', client);
      return balance.body.points > Number(state.pointsBefore) ? balance.body.points : null;
    }, 15000);
    assert.ok(points, 'el cliente no ganó puntos con el pago aprobado');
  });

  // ---------------------------------------------------------------- operario trabaja
  await t.test('4. el operario inicia y termina el servicio; el cliente recibe los avisos', async () => {
    // la reserva pasa a empezar en 10 minutos (UTC) para poder iniciarla hoy
    sql(`UPDATE booking.booking SET scheduled_start = DATEADD(minute, 10, SYSUTCDATETIME()),
         scheduled_end = DATEADD(minute, ${10 + minutes}, SYSUTCDATETIME()) WHERE booking_id = ${state.bookingId}`);
    const assigned = await api('GET', '/operator/services', operator);
    assert.ok(assigned.body.some((s) => s.bookingId === state.bookingId), 'el operario no ve el servicio asignado');
    const start = await api('POST', `/operator/services/${state.bookingId}/start`, operator);
    assert.equal(start.status, 200, JSON.stringify(start.body).slice(0, 200));
    assert.ok(await waitForNotice(client, 'SERVICE_STARTED'), 'aviso de servicio iniciado');
    const finish = await api('POST', `/operator/services/${state.bookingId}/finish`, operator);
    assert.equal(finish.status, 200, JSON.stringify(finish.body).slice(0, 200));
    assert.ok(await waitForNotice(client, 'SERVICE_COMPLETED'), 'aviso de servicio terminado');
    const history = await api('GET', '/bookings/me', client);
    assert.equal(history.body.find((b) => b.id === state.bookingId)?.status, 'COMPLETED');
  });

  // ---------------------------------------------------------------- cliente califica
  await t.test('5. el cliente califica el servicio y el operario ve la calificación', async () => {
    const rate = await api('POST', `/ratings/${state.bookingId}`, client, { rating: 5, comment: 'Prueba del flujo completo' });
    assert.ok([200, 201].includes(rate.status), JSON.stringify(rate.body).slice(0, 200));
    const ratings = await api('GET', '/operator/ratings', operator);
    assert.ok(ratings.body.some((r) => r.bookingId === state.bookingId), 'el operario no ve la calificación');
  });
});
