// Flujo completo de los tres roles contra un despliegue, con las cuentas de prueba (E2E_*):
//   cliente: vehículo nuevo → reserva → cupón (GET y DELETE de /loyalty/redemptions) → paga
//   admin: reasigna con notas → AMOUNT_CHANGED si cambió el monto → aprueba
//   operario: no inicia antes de 15 minutos; en una reserva de hoy inicia, termina y recibe la calificación
// y de paso E-01, E-07, E-08, E-09, BIZ-01, BIZ-02 y BIZ-08. Cada paso revisa el aviso del cliente.
// Al final devuelve el pago, cancela la reserva, borra los cupones y retira el vehículo. Lo único
// que queda es la reserva de hoy (completada y calificada): un servicio terminado no se puede borrar.
//   E2E_ALLOW_WRITES=1 BASE_URL=https://... node --test e2e/remote/full-flow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

// comprobante mínimo válido (PNG de 1x1)
const RECEIPT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// cuánto se espera a que la reserva de hoy se pueda iniciar (15 minutos antes de su hora)
const START_WAIT_MINUTES = Number(process.env.E2E_START_WAIT_MINUTES ?? 20);
const SECOND_OPERATOR_ID = process.env.E2E_SECOND_OPERATOR_ID ? Number(process.env.E2E_SECOND_OPERATOR_ID) : null;

const cleanup = L.createCleanup();
test.after(async () => { await cleanup.run(); await L.closeSessions(); });

const money = (value) => Math.round(Number(value) * 100) / 100;

test('flujo completo: cliente → admin → operario → cliente', { skip: L.NEEDS_WRITES }, async (t) => {
  const admin = await L.session('admin');
  const client = await L.session('client');
  const operator = await L.session('operator');
  const operatorId = await L.operatorIdOf(admin.token, operator.user.id);
  const { type, services } = await L.vehicleTypeWithServices();
  const [main, extra] = services;
  const state = { notes: `Prueba e2e ${L.stamp()}: revisar los rines` };

  // ---------------------------------------------------------------- cliente: vehículo y reserva
  const vehicle = await L.createVehicle(client.token, type.code);
  cleanup.add(`retirar el vehículo ${vehicle.id}`, () => L.retireVehicle(client.token, vehicle.id));

  let slot;
  for (const days of [35, 38, 41, 44, 47]) {
    state.date = L.farWeekday(days);
    slot = await L.findSlot({ token: client.token, date: state.date, vehicleTypeId: type.id, serviceIds: [main.id], operatorId });
    if (slot) break;
  }
  assert.ok(slot, 'el operario de prueba no tiene horas libres en las próximas semanas: revisa sus turnos');
  state.time = slot.time;
  const created = await L.api('POST', '/bookings', { token: client.token,
    body: { vehicleId: vehicle.id, serviceIds: [main.id], date: state.date, time: state.time, preferredOperatorId: operatorId } });
  assert.equal(created.status, 201, `crear la reserva → ${L.describe(created)}`);
  const booking = created.body;
  cleanup.add(`cancelar la reserva ${booking.id}`, () => L.cancelBooking(admin.token, booking.id));
  const total = money(booking.total);

  await t.test('cliente: la reserva queda confirmada, se asigna sola al operario elegido y llegan los avisos', async () => {
    assert.equal(booking.status, 'CONFIRMED');
    const assignment = await L.waitFor(async () => {
      const list = await L.api('GET', `/admin/assignments?from=${state.date}&to=${state.date}`, { token: admin.token });
      return L.list(list.body).find((a) => a.bookingId === booking.id);
    });
    assert.ok(assignment, 'operations no asignó la reserva (¿llega booking.confirmed por RabbitMQ?)');
    assert.equal(assignment.operatorId, operatorId);
    assert.ok(await L.waitForNotice(client.token, booking.id, 'BOOKING_CONFIRMED'), 'aviso de reserva confirmada');
    assert.ok(await L.waitForNotice(client.token, booking.id, 'OPERATOR_ASSIGNED'), 'aviso de operario asignado');
  });

  await t.test('E-01: el operario no mueve la reserva por /operator/bookings (el gateway no la publica)', async () => {
    const res = await L.api('PATCH', `/operator/bookings/${booking.id}/status`, { token: operator.token, body: { status: 'IN_PROGRESS' } });
    assert.ok([401, 404].includes(res.status), L.describe(res));
    const after = await L.api('GET', `/bookings/${booking.id}`, { token: client.token });
    assert.equal(after.body.status, 'CONFIRMED', 'la reserva cambió de estado');
  });

  await t.test('operario: ve el servicio y no lo puede iniciar antes de 15 minutos (SERVICE_TOO_EARLY)', async () => {
    const mine = await L.api('GET', `/operator/services?from=${state.date}&to=${state.date}`, { token: operator.token });
    const row = L.list(mine.body).find((s) => s.bookingId === booking.id);
    assert.ok(row, 'el operario no ve el servicio asignado');
    assert.ok(new Date(row.startableAt) > new Date(), `startableAt debería ser futuro: ${row.startableAt}`);
    L.expectProblem(await L.api('POST', `/operator/services/${booking.id}/start`, { token: operator.token }),
      409, 'SERVICE_TOO_EARLY', 'iniciar semanas antes');
  });

  await t.test('admin: reasigna el operario con notas y el operario las ve (RF-009, B-01)', async () => {
    const assign = (id) => L.api('PUT', `/admin/assignments/${booking.id}`, { token: admin.token, body: { operatorId: id, notes: state.notes } });
    if (SECOND_OPERATOR_ID) {
      // con un segundo operario de prueba, la reasignación cambia de verdad de persona y vuelve
      const other = await assign(SECOND_OPERATOR_ID);
      assert.equal(other.status, 200, `reasignar al segundo operario → ${L.describe(other)}`);
      assert.equal(other.body.operatorId, SECOND_OPERATOR_ID);
      const gone = await L.api('GET', `/operator/services?from=${state.date}&to=${state.date}`, { token: operator.token });
      assert.ok(!L.list(gone.body).some((s) => s.bookingId === booking.id), 'el primer operario sigue viendo el servicio');
    }
    const back = await assign(operatorId);
    assert.equal(back.status, 200, `reasignar → ${L.describe(back)}`);
    assert.equal(back.body.operatorId, operatorId);
    assert.equal(back.body.notes, state.notes, 'la asignación no guardó las notas');
    const list = await L.api('GET', `/admin/assignments?from=${state.date}&to=${state.date}`, { token: admin.token });
    assert.equal(L.list(list.body).find((a) => a.bookingId === booking.id)?.notes, state.notes);
    const mine = await L.api('GET', `/operator/services?from=${state.date}&to=${state.date}`, { token: operator.token });
    assert.equal(L.list(mine.body).find((s) => s.bookingId === booking.id)?.notes, state.notes, 'el operario no ve las notas');
  });

  // ---------------------------------------------------------------- cliente: cupón
  await t.test('cliente: cupón con el GET y el DELETE de /loyalty/redemptions (BIZ-02, E-08, E-09, E-07)', async () => {
    const code = (suffix) => `E2E${L.stamp()}${suffix}`.toUpperCase().slice(0, 30);
    const points = (await L.api('GET', '/loyalty/balance', { token: client.token })).body?.points ?? 0;
    const createPromotion = async (body) => {
      const res = await L.api('POST', '/admin/promotions', { token: admin.token, body });
      if (res.status === 201) cleanup.add(`borrar la promoción ${res.body.id}`, () => L.deletePromotion(admin.token, res.body.id));
      return res;
    };
    // E-07: un cupón del 100 % dejaría la reserva impagable
    L.expectProblem(await createPromotion(L.promotionBody(code('F'), 100, points)), 400, 'INVALID_PROMOTION_DISCOUNT', 'cupón de 100 %');
    const first = await createPromotion(L.promotionBody(code('A'), 10, points));
    const second = await createPromotion(L.promotionBody(code('B'), 10, points));
    assert.equal(first.status, 201, `crear la promoción → ${L.describe(first)}`);
    assert.equal(second.status, 201, `crear la promoción → ${L.describe(second)}`);

    const amountDue = () => L.api('GET', `/loyalty/redemptions/${booking.id}`, { token: client.token });
    const before = await amountDue();
    assert.equal(before.status, 200, `GET del monto → ${L.describe(before)}`);
    assert.equal(before.body.bookingId, booking.id);
    assert.equal(before.body.redemption, null);
    assert.equal(money(before.body.bookingTotal), total);
    assert.equal(money(before.body.amountDue), total);

    const redeemed = await L.api('POST', '/loyalty/redeem', { token: client.token, body: { bookingId: booking.id, code: first.body.code } });
    assert.equal(redeemed.status, 200, `canjear → ${L.describe(redeemed)}`);
    cleanup.add('quitar el cupón de la reserva', () => L.api('DELETE', `/loyalty/redemptions/${booking.id}/${first.body.id}`, { token: client.token }));
    const discount = money(redeemed.body.discountAmount);
    assert.ok(discount > 0 && discount < total, `descuento ${discount} de ${total}`);

    // al volver a entrar a la pantalla de pago, el servidor dice qué cupón tiene y cuánto se debe
    const withCoupon = await amountDue();
    assert.equal(withCoupon.status, 200);
    assert.equal(withCoupon.body.redemption?.promotionId, first.body.id);
    assert.equal(withCoupon.body.redemption?.promotionCode, first.body.code);
    assert.equal(money(withCoupon.body.redemption?.discountAmount), discount);
    assert.equal(money(withCoupon.body.appliedDiscounts), discount);
    assert.equal(money(withCoupon.body.amountDue), money(total - discount));

    // E-09: un solo cupón por reserva
    L.expectProblem(await L.api('POST', '/loyalty/redeem', { token: client.token, body: { bookingId: booking.id, code: second.body.code } }),
      409, 'PROMOTION_ONE_PER_BOOKING', 'segundo cupón');

    // E-08: quitar el cupón lo quita también en el servidor
    const removed = await L.api('DELETE', `/loyalty/redemptions/${booking.id}/${first.body.id}`, { token: client.token });
    assert.equal(removed.status, 200, `quitar el cupón → ${L.describe(removed)}`);
    assert.equal(money(removed.body.amountDue), total);
    assert.equal(money(removed.body.appliedDiscounts), 0);
    const after = await amountDue();
    assert.equal(after.body.redemption, null);
    assert.equal(money(after.body.amountDue), total);
    L.expectProblem(await L.api('DELETE', `/loyalty/redemptions/${booking.id}/${first.body.id}`, { token: client.token }),
      404, 'PROMOTION_REDEMPTION_NOT_FOUND', 'quitar dos veces');
    // una reserva que no es suya (o no existe) responde 404
    assert.equal((await L.api('GET', `/loyalty/redemptions/${L.MISSING_ID}`, { token: client.token })).status, 404);

    // los cupones de prueba se borran ya, para que nadie más los vea
    await L.deletePromotion(admin.token, first.body.id);
    await L.deletePromotion(admin.token, second.body.id);
  });

  // ---------------------------------------------------------------- cliente: reprogramar y vehículo
  await t.test('BIZ-01: el cliente cambia la fecha y la hora, pero no los servicios', async () => {
    if (!extra) return t.skip('el catálogo tiene un solo servicio para este tipo de vehículo');
    L.expectProblem(await L.api('PUT', `/bookings/${booking.id}`, { token: client.token,
      body: { serviceIds: [main.id, extra.id], date: state.date, time: state.time } }), 409, 'BOOKING_SERVICES_LOCKED', 'cambiar servicios');
    const other = await L.findSlot({ token: client.token, date: state.date, vehicleTypeId: type.id, serviceIds: [main.id],
      operatorId, accept: (time) => time !== state.time });
    if (!other) return t.skip(`no hay otra hora libre del operario el ${state.date}`);
    const moved = await L.api('PUT', `/bookings/${booking.id}`, { token: client.token, body: { date: state.date, time: other.time } });
    assert.equal(moved.status, 200, `reprogramar → ${L.describe(moved)}`);
    assert.equal(moved.body.startTime, other.time);
    assert.deepEqual(moved.body.services.map((s) => s.serviceId), [main.id]);
    state.time = other.time;
  });

  await t.test('BIZ-08: no se retira un vehículo con reservas activas (VEHICLE_HAS_ACTIVE_BOOKINGS)', async () => {
    L.expectProblem(await L.api('DELETE', `/vehicles/${vehicle.id}`, { token: client.token }), 409, 'VEHICLE_HAS_ACTIVE_BOOKINGS', 'retirar');
    const vehicles = await L.api('GET', '/vehicles', { token: client.token });
    assert.ok(L.list(vehicles.body).some((v) => v.id === vehicle.id), 'el vehículo desapareció');
  });

  // ---------------------------------------------------------------- pago
  await t.test('cliente: reporta el pago con el monto que dice el servidor y queda en revisión', async () => {
    const accounts = await L.api('GET', '/payment-accounts', { token: client.token });
    const account = L.list(accounts.body).find((a) => a.methodCode !== 'EFECTIVO');
    if (!account) return t.skip('el negocio no tiene un medio de pago con comprobante activo');
    const due = money((await L.api('GET', `/loyalty/redemptions/${booking.id}`, { token: client.token })).body.amountDue);
    const report = await L.api('POST', '/payments', { token: client.token, body: {
      bookingId: booking.id, paymentAccountId: account.id, transactionReference: `E2E${L.random(5).toUpperCase()}`,
      receiptImage: RECEIPT, reportedAmount: due } });
    assert.equal(report.status, 201, `reportar → ${L.describe(report)}`);
    state.paymentId = report.body.id;
    state.paymentStatus = report.body.status;
    cleanup.add(`deshacer el pago ${state.paymentId}`, () => L.undoPayment(admin.token, state.paymentId));
    assert.ok(['PENDING', 'IN_REVIEW'].includes(report.body.status), report.body.status);
    assert.equal(money(report.body.amount), due);
    const mine = await L.api('GET', '/payments/me/bookings', { token: client.token });
    assert.ok(['PENDING', 'IN_REVIEW'].includes(L.list(mine.body).find((p) => p.bookingId === booking.id)?.paymentStatus));
  });

  await t.test('admin: AMOUNT_CHANGED si la reserva cambió de monto después del reporte (BIZ-01)', async () => {
    if (!state.paymentId) return t.skip('no hay pago reportado');
    if (!extra) return t.skip('el catálogo tiene un solo servicio para este tipo de vehículo');
    const reschedule = (serviceIds) => L.api('PUT', `/admin/bookings/${booking.id}`, { token: admin.token,
      body: { serviceIds, date: state.date, time: state.time } });
    const bigger = await reschedule([main.id, extra.id]);
    if (bigger.body?.code === 'SLOT_UNAVAILABLE') return t.skip('la bahía no tiene espacio para un servicio más a esa hora');
    assert.equal(bigger.status, 200, `el admin agrega un servicio → ${L.describe(bigger)}`);
    assert.ok(money(bigger.body.total) > total);
    L.expectProblem(await L.api('POST', `/admin/payments/${state.paymentId}/approve`, { token: admin.token }), 409, 'AMOUNT_CHANGED', 'aprobar');
    // vuelve a los servicios originales: el precio congelado deja el mismo total
    const restored = await reschedule([main.id]);
    assert.equal(restored.status, 200, `el admin quita el servicio → ${L.describe(restored)}`);
    assert.equal(money(restored.body.total), total);
  });

  await t.test('admin: aprueba el pago; el cliente lo ve aprobado y recibe el aviso', async () => {
    if (!state.paymentId) return t.skip('no hay pago reportado');
    const queue = await L.api('GET', `/admin/payments?status=${state.paymentStatus}`, { token: admin.token });
    assert.ok(L.list(queue.body).some((p) => p.id === state.paymentId), 'el pago no está en la cola del admin');
    const approved = await L.api('POST', `/admin/payments/${state.paymentId}/approve`, { token: admin.token });
    assert.equal(approved.status, 200, `aprobar → ${L.describe(approved)}`);
    assert.equal(approved.body.status, 'APPROVED');
    const mine = await L.api('GET', '/payments/me', { token: client.token });
    assert.equal(L.list(mine.body).find((p) => p.id === state.paymentId)?.status, 'APPROVED');
    assert.ok(await L.waitForNotice(client.token, state.paymentId, 'PAYMENT_CONFIRMED'), 'aviso de pago aprobado');
  });

  // ---------------------------------------------------------------- operario: reserva de hoy
  await t.test('operario: en una reserva de hoy inicia, termina y el cliente lo califica', async () => {
    const today = L.localToday();
    const soon = await L.findSlot({ token: client.token, date: today, vehicleTypeId: type.id, serviceIds: [main.id], operatorId,
      accept: (time) => { const until = L.toMinutes(time) - L.localNowMinutes(); return until > 1 && until - 15 <= START_WAIT_MINUTES; } });
    if (!soon) {
      return t.skip(`hoy no hay una hora libre del operario que se pueda iniciar en ${START_WAIT_MINUTES} minutos (horario, turno u ocupación)`);
    }
    const res = await L.api('POST', '/bookings', { token: client.token,
      body: { vehicleId: vehicle.id, serviceIds: [main.id], date: today, time: soon.time, preferredOperatorId: operatorId } });
    assert.equal(res.status, 201, `reservar hoy → ${L.describe(res)}`);
    const todayId = res.body.id;
    cleanup.add(`cancelar la reserva de hoy ${todayId} si no empezó`, () => L.cancelBooking(admin.token, todayId));

    const row = await L.waitFor(async () => {
      const mine = await L.api('GET', '/operator/services', { token: operator.token });
      return L.list(mine.body).find((s) => s.bookingId === todayId);
    });
    if (!row) {
      const manual = await L.api('PUT', `/admin/assignments/${todayId}`, { token: admin.token, body: { operatorId } });
      assert.equal(manual.status, 200, `asignar a mano → ${L.describe(manual)}`);
    }
    // espera a los 15 minutos antes de la hora (con margen por la diferencia de relojes)
    const startableAt = new Date(row?.startableAt ?? new Date(res.body.scheduledStart).getTime() - 15 * 60000);
    const wait = startableAt.getTime() - Date.now() + 5000;
    if (wait > 0) {
      console.log(`  esperando ${Math.ceil(wait / 60000)} min a que la reserva de hoy se pueda iniciar…`);
      await L.sleep(wait);
    }
    const started = await L.waitFor(async () => {
      const s = await L.api('POST', `/operator/services/${todayId}/start`, { token: operator.token });
      return s.body?.code === 'SERVICE_TOO_EARLY' ? null : s;
    }, 60000, 5000);
    assert.equal(started?.status, 200, `iniciar → ${started && L.describe(started)}`);
    assert.equal(started.body.status, 'IN_PROGRESS');
    assert.ok(await L.waitForNotice(client.token, todayId, 'SERVICE_STARTED'), 'aviso de servicio iniciado');

    const finished = await L.api('POST', `/operator/services/${todayId}/finish`, { token: operator.token });
    assert.equal(finished.status, 200, `terminar → ${L.describe(finished)}`);
    assert.equal(finished.body.status, 'COMPLETED');
    assert.ok(await L.waitForNotice(client.token, todayId, 'SERVICE_COMPLETED'), 'aviso de servicio terminado');
    assert.equal((await L.api('GET', `/bookings/${todayId}`, { token: client.token })).body.status, 'COMPLETED');

    const rate = await L.api('POST', `/ratings/${todayId}`, { token: client.token, body: { rating: 5, comment: 'Prueba e2e del flujo completo' } });
    assert.ok([200, 201].includes(rate.status), `calificar → ${L.describe(rate)}`);
    L.expectProblem(await L.api('POST', `/ratings/${todayId}`, { token: client.token, body: { rating: 4 } }), 409, 'ALREADY_RATED', 'calificar dos veces');
    const ratings = await L.api('GET', '/operator/ratings', { token: operator.token });
    assert.ok(L.list(ratings.body).some((r) => r.bookingId === todayId), 'el operario no ve la calificación');
    console.log(`  queda la reserva ${res.body.code} completada y calificada (no se puede borrar por la API)`);
  });

  // ---------------------------------------------------------------- deshacer, revisando cada paso
  await t.test('limpieza: se devuelve el pago, el admin cancela con motivo y el vehículo ya se puede retirar', async () => {
    if (state.paymentId) {
      await L.undoPayment(admin.token, state.paymentId);
      const refunded = await L.api('GET', `/admin/payments/${state.paymentId}`, { token: admin.token });
      assert.ok(['REFUNDED', 'REJECTED'].includes(refunded.body.status), refunded.body.status);
    }
    const cancelled = await L.cancelBooking(admin.token, booking.id);
    assert.equal(cancelled.status, 200, `cancelar → ${L.describe(cancelled)}`);
    assert.equal(cancelled.body.cancellationReason?.code, 'OTHER');
    assert.ok(await L.waitForNotice(client.token, booking.id, 'BOOKING_CANCELLED'), 'aviso de reserva cancelada');
    const retired = await L.api('DELETE', `/vehicles/${vehicle.id}`, { token: client.token });
    assert.equal(retired.status, 204, `retirar el vehículo sin reservas activas → ${L.describe(retired)}`);
  });
});
