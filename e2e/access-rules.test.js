// Reglas que cruzan servicios y que el gateway debe respetar, con las cuentas del equipo:
// permisos por rol, rutas internas, dirección del perfil, filtros de pagos, datos del negocio,
// ficha del operario, reservas fuera del horario y operarios sin cuenta. Deja todo como estaba.
//   node --test e2e/access-rules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNTS, sign, api, sql, farWeekday } = require('./lib');

const admin = sign(ACCOUNTS.admin, ['ADMIN']);
const client = sign(ACCOUNTS.client, ['CLIENT']);
const before = { address: null, profiles: null };

test.after(async () => {
  if (before.address !== null) await api('PUT', '/users/me/address', client, { address: before.address });
  for (const profile of before.profiles ?? []) {
    await api('PUT', `/admin/operators/${profile.operatorId}/profile`, admin,
      { specialty: profile.specialty, skills: profile.skills });
  }
});

test('permisos por rol y rutas internas', async () => {
  assert.equal((await api('GET', '/admin/users')).status, 401, 'sin token');
  assert.equal((await api('GET', '/admin/users', client)).status, 403, 'cliente en ruta de admin');
  assert.equal((await api('GET', '/operator/services', client)).status, 403, 'cliente en ruta de operario');
  assert.equal((await api('GET', '/admin/bookings/day-summary', client)).status, 403);
  assert.equal((await api('GET', '/operators/my-bookings', admin)).status, 403, 'solo el cliente ve el operario de sus reservas');
  assert.equal((await api('GET', '/admin/users?page=0&size=5', admin)).status, 200);
  const internal = await api('GET', 'http://localhost:8080/internal/v1/users/admins');
  assert.ok([401, 404].includes(internal.status), `las rutas internas no salen por el gateway (${internal.status})`);
});

test('dirección del perfil: guarda sin espacios sobrantes y rechaza más de 200 caracteres', async () => {
  before.address = (await api('GET', '/users/me/address', client)).body.address ?? '';
  const saved = await api('PUT', '/users/me/address', client, { address: '  Calle 10 # 5-20, Neiva  ' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.address, 'Calle 10 # 5-20, Neiva');
  assert.equal((await api('PUT', '/users/me/address', client, { address: 'x'.repeat(201) })).status, 400);
});

test('historial de pagos con filtros y rango de fechas al revés', async () => {
  assert.equal((await api('GET', '/payments/me?from=2026-01-01&to=2026-12-31&service=a', client)).status, 200);
  const wrong = await api('GET', '/payments/me?from=2026-12-31&to=2026-01-01', client);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'INVALID_DATE_RANGE');
});

test('datos del negocio: el público no ve los datos tributarios, el admin sí', async () => {
  const open = await api('GET', '/establishment');
  assert.equal(open.status, 200);
  assert.ok(!('taxRegime' in open.body) && !('legalRepresentative' in open.body));
  const full = await api('GET', '/admin/establishment', admin);
  assert.equal(full.status, 200);
  assert.ok('taxRegime' in full.body);
});

test('ficha del operario: rechaza habilidades repetidas y más de 10', async () => {
  const profiles = await api('GET', '/admin/operators/profiles', admin);
  assert.equal(profiles.status, 200);
  before.profiles = profiles.body;
  const id = profiles.body[0]?.operatorId;
  assert.ok(id, 'hace falta al menos un operario');
  const repeated = await api('PUT', `/admin/operators/${id}/profile`, admin,
    { specialty: 'Detailing', skills: [{ name: 'Pulido', level: 'EXPERT' }, { name: 'pulido', level: 'ADVANCED' }] });
  assert.equal(repeated.status, 400, 'nombres repetidos sin importar mayúsculas');
  const tooMany = await api('PUT', `/admin/operators/${id}/profile`, admin,
    { specialty: 'Detailing', skills: Array.from({ length: 11 }, (_, i) => ({ name: `H${i}`, level: 'EXPERT' })) });
  assert.equal(tooMany.status, 400);
});

test('una hora antes de abrir responde que está fuera del horario, no que falta bahía', async () => {
  const vehicles = await api('GET', '/vehicles', client);
  const vehicle = (Array.isArray(vehicles.body) ? vehicles.body : vehicles.body.items)[0];
  const services = await api('GET', `/catalog/services?vehicleTypeId=${vehicle.vehicleTypeId}`);
  const answer = await api('POST', '/bookings', client,
    { vehicleId: vehicle.id, paymentMode: 'DIGITAL', serviceIds: [services.body[0].id], date: farWeekday(47), time: '05:00' });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'SLOT_UNAVAILABLE');
  assert.equal(answer.body.reason, 'OUTSIDE_HOURS');
  assert.ok(Array.isArray(answer.body.alternatives));
});

test('un token de operario de una cuenta que no existe no crea filas de operario', async () => {
  const ghost = 987654321;
  const answer = await api('GET', '/operator/services', sign(ghost, ['OPERATOR']));
  assert.equal(answer.status, 404);
  assert.equal(answer.body.code, 'OPERATOR_NOT_FOUND');
  assert.equal(sql(`SELECT COUNT(*) FROM execution.operator WHERE user_id = ${ghost}`), '0');
});
