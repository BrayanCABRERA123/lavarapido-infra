// Informe de inspección de punta a punta (RF-036 a RF-038), por el gateway y con las cuentas del equipo:
//   el admin crea un servicio temporal de 200 minutos → el cliente lo reserva → el admin abre el
//   informe, agrega un hallazgo con fotos, lo publica y lo comparte → el enlace público se abre sin
//   sesión y sin datos personales → el cliente recibe el aviso.
// Al final borra el informe, la reserva y el servicio temporal.
//   node --test e2e/inspection-flow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNTS, GATEWAY, sign, api, sql, deleteBookings, waitFor, farWeekday } = require('./lib');

// imagen mínima válida (PNG de 1x1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const state = { serviceId: null, bookingId: null };

async function addFinding(admin, bookingId, photos) {
  const form = new FormData();
  form.append('phase', 'EXTERIOR');
  form.append('area', 'Puerta delantera');
  form.append('severity', 'MINOR');
  form.append('note', 'Rayón leve');
  for (let i = 0; i < photos; i++) form.append('photos', new Blob([PNG], { type: 'image/png' }), `foto-${i + 1}.png`);
  const response = await fetch(`${GATEWAY}/admin/inspections/${bookingId}/findings`,
    { method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form });
  return response.status;
}

test.after(() => {
  const id = state.bookingId;
  if (id) {
    sql(`DELETE p FROM execution.inspection_photo p JOIN execution.inspection_finding f ON f.inspection_finding_id = p.inspection_finding_id JOIN execution.inspection_report r ON r.inspection_report_id = f.inspection_report_id WHERE r.booking_id = ${id};
DELETE f FROM execution.inspection_finding f JOIN execution.inspection_report r ON r.inspection_report_id = f.inspection_report_id WHERE r.booking_id = ${id};
DELETE ph FROM execution.inspection_phase ph JOIN execution.inspection_report r ON r.inspection_report_id = ph.inspection_report_id WHERE r.booking_id = ${id};
DELETE FROM execution.inspection_report WHERE booking_id = ${id};`);
    deleteBookings([id]);
  }
  if (state.serviceId) {
    sql(`DELETE FROM catalog.service_price WHERE service_id = ${state.serviceId}; DELETE FROM catalog.service WHERE service_id = ${state.serviceId};`);
  }
});

test('informe de inspección: hallazgos con fotos, publicar, compartir y enlace público', async () => {
  const admin = sign(ACCOUNTS.admin, ['ADMIN']);
  const client = sign(ACCOUNTS.client, ['CLIENT']);

  const vehicles = await api('GET', '/vehicles', client);
  const vehicle = (Array.isArray(vehicles.body) ? vehicles.body : vehicles.body.items)[0];
  assert.ok(vehicle, 'el cliente necesita al menos un vehículo');
  const types = await api('GET', '/vehicle-types');
  const categories = await api('GET', '/catalog/categories');
  const service = await api('POST', '/admin/catalog/services', admin, {
    name: 'Detallado completo de prueba', description: 'Servicio temporal de la prueba e2e',
    categoryId: categories.body[0]?.id ?? 1, loyaltyPoints: 0,
    prices: types.body.map((type) => ({ vehicleTypeId: type.id, price: 150000, estimatedMinutes: 200 })),
  });
  assert.equal(service.status, 201, JSON.stringify(service.body).slice(0, 160));
  state.serviceId = service.body.id;

  // el informe solo se abre en reservas de 180 minutos o más
  const date = farWeekday(52);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const opens = sql(`SELECT CONVERT(varchar(5), opens_at, 108) FROM booking.business_hour WHERE day_of_week = ${day}`);
  const booking = await api('POST', '/bookings', client, { vehicleId: vehicle.id, serviceIds: [state.serviceId], date, time: opens });
  assert.equal(booking.status, 201, JSON.stringify(booking.body).slice(0, 160));
  state.bookingId = booking.body.id;

  const opened = await api('POST', `/admin/inspections/${state.bookingId}`, admin);
  assert.ok([200, 201].includes(opened.status), JSON.stringify(opened.body).slice(0, 160));
  assert.equal((await api('GET', `/admin/inspections/${state.bookingId}`, client)).status, 403, 'el cliente no entra al informe del admin');

  assert.ok([200, 201].includes(await addFinding(admin, state.bookingId, 2)), 'hallazgo con 2 fotos');
  assert.equal(await addFinding(admin, state.bookingId, 6), 400, 'más de 5 fotos por hallazgo');
  assert.equal((await api('PATCH', `/admin/inspections/${state.bookingId}/phases/EXTERIOR`, admin, { status: 'DONE' })).status, 200);

  assert.equal((await api('POST', `/admin/inspections/${state.bookingId}/share`, admin)).status, 409, 'no se comparte sin publicar');
  assert.equal((await api('POST', `/admin/inspections/${state.bookingId}/publish`, admin)).status, 200);
  const shared = await api('POST', `/admin/inspections/${state.bookingId}/share`, admin);
  assert.ok([200, 202, 204].includes(shared.status), `compartir: ${shared.status}`);

  const token = sql(`SELECT public_token FROM execution.inspection_report WHERE booking_id = ${state.bookingId}`);
  assert.ok(token.length >= 32, 'el enlace usa un token aleatorio largo');
  const view = await api('GET', `/public/inspections/${token}`);
  assert.equal(view.status, 200, 'el enlace público abre sin sesión');
  const text = JSON.stringify(view.body);
  assert.ok(!text.includes(vehicle.plate), 'la placa completa no sale en el enlace público');
  assert.ok(!text.includes('@'), 'el enlace público no trae correos');
  assert.equal((await api('GET', '/public/inspections/token-que-no-existe')).status, 404);

  const photoId = sql(`SELECT TOP 1 p.inspection_photo_id FROM execution.inspection_photo p JOIN execution.inspection_finding f ON f.inspection_finding_id = p.inspection_finding_id JOIN execution.inspection_report r ON r.inspection_report_id = f.inspection_report_id WHERE r.booking_id = ${state.bookingId}`);
  const photo = await fetch(`${GATEWAY}/public/inspections/${token}/photos/${photoId}`);
  assert.equal(photo.status, 200, 'la foto se ve desde el enlace');
  assert.match(photo.headers.get('content-type') ?? '', /image\//);

  const notice = await waitFor(async () => {
    const inbox = await api('GET', '/notifications?page=0&size=30', client);
    return (inbox.body.items ?? []).find((n) => n.type === 'INSPECTION_REPORT' && n.referenceId === state.bookingId);
  });
  assert.ok(notice, 'el cliente recibe el aviso del informe');
});
