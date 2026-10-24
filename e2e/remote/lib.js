// Utilidades de la batería e2e contra un despliegue (Azure o cualquier BASE_URL). A diferencia de
// ../lib.js, no lee el .env, no firma tokens ni toca la base: inicia sesión por la API con las
// cuentas de prueba que llegan por variables de entorno y limpia por la API lo que crea.
// Nunca imprime contraseñas ni tokens.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const BASE_URL = (process.env.E2E_BASE_URL ?? process.env.BASE_URL ?? '').trim().replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;
const ZONE = process.env.E2E_ZONE ?? 'America/Bogota';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 20000);

// banderas: por defecto la batería solo lee y prueba rechazos (nada queda creado)
const flags = {
  writes: process.env.E2E_ALLOW_WRITES === '1',
  signup: process.env.E2E_ALLOW_SIGNUP === '1',
  rateLimit: process.env.E2E_RATE_LIMIT === '1',
};

// mensajes para { skip } de node:test cuando falta la bandera
const NEEDS_WRITES = flags.writes ? false : 'crea reservas, vehículos y pagos de prueba: corre con E2E_ALLOW_WRITES=1';
const NEEDS_SIGNUP = flags.signup ? false : 'registra cuentas nuevas: corre con E2E_ALLOW_SIGNUP=1 (ver README)';
const NEEDS_RATE_LIMIT = flags.rateLimit ? false : 'bloquea la IP de prueba en /auth: corre con E2E_RATE_LIMIT=1';

const ROLES = ['admin', 'client', 'operator'];
// id que no existe en ninguna tabla: las rutas que cambian algo se prueban sobre él
const MISSING_ID = 999999999;

function requireBaseUrl() {
  if (!/^https?:\/\/[^/]+/.test(BASE_URL)) {
    throw new Error('Falta BASE_URL (o E2E_BASE_URL), por ejemplo https://lavarapidovehicular.northcentralus.cloudapp.azure.com');
  }
}

/** Credenciales de un rol: solo de variables de entorno (E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD...). */
function credentials(role) {
  const prefix = `E2E_${role.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) throw new Error(`Faltan ${prefix}_EMAIL y ${prefix}_PASSWORD`);
  return { email, password };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Llamada a la API; devuelve { status, body, headers, ms }. opts: token, body, scheme (por defecto
 * "Bearer"; SEC-01 prueba "bearer") y raw (cuerpo ya serializado, para mandar algo que no es JSON).
 */
async function api(method, path, opts = {}) {
  requireBaseUrl();
  const { token, body, raw, scheme = 'Bearer', headers = {} } = opts;
  const url = path.startsWith('http') ? path : (path.startsWith('/api/') || path.startsWith('/internal/') ? BASE_URL + path : API + path);
  const started = performance.now();
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `${scheme} ${token}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers, ms: performance.now() - started };
}

/** Respuesta corta para los mensajes de error, sin tokens. */
function describe(res) {
  const body = res.body && typeof res.body === 'object'
    ? JSON.stringify(res.body, (key, value) => (/token/i.test(key) ? '***' : value))
    : String(res.body ?? '');
  return `${res.status} ${body.slice(0, 220)}`;
}

/** Afirma el estado HTTP y el code del ProblemDetail. */
function expectProblem(res, status, code, what = '') {
  assert.equal(res.status, status, `${what} → ${describe(res)}`);
  if (code) assert.equal(res.body?.code, code, `${what} → ${describe(res)}`);
}

/**
 * Llamada a /auth/**: si el límite por IP (SEC-04) responde 429, espera lo que dice Retry-After
 * (máximo 2 minutos) y reintenta, para que el resto de la batería no falle por el tope.
 */
async function authCall(method, path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await api(method, path, opts);
    const wait = Number(res.headers.get('retry-after') ?? 30);
    if (res.status !== 429 || attempt >= 2 || wait > 120) return res;
    await sleep((wait + 1) * 1000);
  }
}

const sessions = new Map();

/**
 * Sesión de un rol: { token, user }. run.js inicia sesión una vez y la pasa por E2E_TOKEN_<ROL> y
 * E2E_USER_<ROL>; si el archivo se corre solo, inicia sesión aquí y la cierra al terminar.
 */
function session(role) {
  if (!sessions.has(role)) {
    sessions.set(role, (async () => {
      const passed = process.env[`E2E_TOKEN_${role.toUpperCase()}`];
      if (passed) return { token: passed, user: JSON.parse(process.env[`E2E_USER_${role.toUpperCase()}`] ?? '{}'), owned: false };
      const { email, password } = credentials(role);
      const res = await authCall('POST', '/auth/login', { body: { email, password } });
      if (res.status !== 200 || !res.body?.accessToken) {
        throw new Error(`No se pudo iniciar sesión como ${role}: ${res.status} ${res.body?.code ?? ''}`);
      }
      return { token: res.body.accessToken, user: res.body.user, owned: true };
    })());
  }
  return sessions.get(role);
}

/** Cierra las sesiones que abrió este proceso (las de run.js las cierra run.js). */
async function closeSessions() {
  for (const [role, pending] of sessions) {
    try {
      const s = await pending;
      if (s.owned) await authCall('POST', '/auth/logout', { token: s.token });
    } catch { /* la sesión no llegó a abrirse */ }
    sessions.delete(role);
  }
}

/**
 * Lista de limpieza: cada prueba registra cómo deshacer lo que crea y test.after la corre al revés.
 * Un paso que falla no detiene los demás; se avisa por consola para limpiarlo a mano.
 */
function createCleanup() {
  const steps = [];
  return {
    add(label, fn) { steps.push({ label, fn }); },
    async run() {
      for (const { label, fn } of steps.reverse()) {
        try { await fn(); } catch (error) { console.warn(`[limpieza] no se pudo ${label}: ${error.message}`); }
      }
      steps.length = 0;
    },
  };
}

/** Repite check hasta que devuelva algo verdadero o se acabe el tiempo (los eventos son asíncronos). */
async function waitFor(check, timeoutMs = 30000, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ fechas en la hora del lavadero

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Hoy (aaaa-mm-dd) en la zona del lavadero, no en la del computador que corre las pruebas. */
const localToday = () => dateFormat.format(new Date());

/** Minutos desde la medianoche, ahora, en la zona del lavadero. */
function localNowMinutes() {
  const [h, m] = timeFormat.format(new Date()).split(':').map(Number);
  return h * 60 + m;
}

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Un día hábil a varias semanas (booking acepta hasta 60 días), para no chocar con reservas reales. */
function farWeekday(daysAhead = 40) {
  const [y, mo, d] = localToday().split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d + daysAhead));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function shiftDate(isoDate, days) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ datos de prueba

const list = (body) => (Array.isArray(body) ? body : (body?.items ?? body?.content ?? []));
const random = (n) => crypto.randomBytes(n).toString('hex');
const stamp = () => `${Date.now().toString(36)}${random(2)}`;

/** Placa de carro al azar (3 letras + 3 números), como exige LicensePlatePolicy. */
function randomPlate() {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const pick = () => letters[crypto.randomInt(letters.length)];
  return `${pick()}${pick()}${pick()}${String(crypto.randomInt(1000)).padStart(3, '0')}`;
}

/** Contraseña fuerte y distinta en cada corrida (las cuentas nuevas de E2E_ALLOW_SIGNUP). */
const strongPassword = () => `E2e!${random(8)}Zx9`;

/**
 * El tipo de vehículo de prueba (E2E_VEHICLE_TYPE, por defecto CAR) con sus servicios activos que
 * tienen precio para ese tipo, del más barato al más caro.
 */
async function vehicleTypeWithServices() {
  const wanted = (process.env.E2E_VEHICLE_TYPE ?? 'CAR').toUpperCase();
  const types = list((await api('GET', '/vehicle-types')).body);
  const type = types.find((t) => String(t.code).toUpperCase() === wanted);
  assert.ok(type, `no existe el tipo de vehículo ${wanted} (E2E_VEHICLE_TYPE)`);
  const catalog = await api('GET', `/catalog/services?vehicleTypeId=${type.id}`);
  assert.equal(catalog.status, 200, `catálogo → ${describe(catalog)}`);
  const priced = list(catalog.body)
    .map((s) => ({ ...s, price: s.prices?.find((p) => p.vehicleTypeId === type.id) ?? s.prices?.[0] }))
    .filter((s) => s.active !== false && s.price && Number(s.price.price) > 0)
    .sort((a, b) => Number(a.price.price) - Number(b.price.price));
  assert.ok(priced.length > 0, `no hay servicios con precio para ${wanted}`);
  return { type, services: priced };
}

/** Registra un vehículo nuevo del cliente con placa al azar (reintenta si la placa ya existe). */
async function createVehicle(clientToken, typeCode) {
  for (let i = 0; i < 5; i++) {
    const res = await api('POST', '/vehicles', { token: clientToken,
      body: { licensePlate: randomPlate(), vehicleType: typeCode, brand: 'E2E', model: 'Prueba', color: 'Gris' } });
    if (res.status === 201) return res.body;
    if (res.status !== 409) throw new Error(`no se pudo registrar el vehículo de prueba: ${describe(res)}`);
  }
  throw new Error('no se encontró una placa libre en 5 intentos');
}

/** Retira el vehículo; si ya no existe, no es error. */
async function retireVehicle(clientToken, vehicleId) {
  const res = await api('DELETE', `/vehicles/${vehicleId}`, { token: clientToken });
  if (![204, 404].includes(res.status)) throw new Error(`retirar el vehículo ${vehicleId}: ${describe(res)}`);
}

/**
 * Primera hora libre de ese día para esos servicios en la que el operario de prueba también está
 * libre (turno, ausencias y cruces). accept(slotTime) filtra las horas que sirven.
 */
async function findSlot({ token, date, vehicleTypeId, serviceIds, operatorId, accept = () => true }) {
  const availability = await api('GET',
    `/bookings/availability?date=${date}&vehicleTypeId=${vehicleTypeId}&serviceIds=${serviceIds.join(',')}`, { token });
  assert.equal(availability.status, 200, `disponibilidad ${date} → ${describe(availability)}`);
  if (!availability.body.open) return null;
  const minutes = availability.body.durationMinutes;
  for (const slot of availability.body.slots.filter((s) => s.available && accept(s.time))) {
    if (!operatorId) return { time: slot.time, minutes };
    const free = await api('GET', `/operators/available?date=${date}&time=${slot.time}&minutes=${minutes}`, { token });
    if (free.status === 200 && list(free.body).some((o) => o.operatorId === operatorId)) return { time: slot.time, minutes };
  }
  return null;
}

/** El operationsId (execution.operator) de la cuenta de operario de prueba. */
async function operatorIdOf(adminToken, operatorUserId) {
  const roster = await api('GET', '/admin/operators', { token: adminToken });
  assert.equal(roster.status, 200, `operarios → ${describe(roster)}`);
  const mine = list(roster.body).find((o) => Number(o.userId) === Number(operatorUserId));
  assert.ok(mine, `la cuenta E2E_OPERATOR_EMAIL no figura como operario en operations-service`);
  return mine.id;
}

/** Avisos de la bandeja de quien llama que apuntan a esa reserva o pago. */
async function notices(token, referenceIds) {
  const inbox = await api('GET', '/notifications?page=0&size=50', { token });
  const ids = new Set([].concat(referenceIds).map(Number));
  return list(inbox.body).filter((n) => ids.has(Number(n.referenceId)));
}

/** Espera un aviso de ese tipo para esa reserva o pago (llega por RabbitMQ, tarda unos segundos). */
const waitForNotice = (token, referenceIds, type, timeoutMs = 30000) =>
  waitFor(async () => (await notices(token, referenceIds)).find((n) => n.type === type) ?? null, timeoutMs);

/** Cancela una reserva como admin (motivo OTHER) si todavía se puede; si no, lo dice. */
async function cancelBooking(adminToken, bookingId) {
  const res = await api('PATCH', `/admin/bookings/${bookingId}/status`, { token: adminToken,
    body: { status: 'CANCELLED', reasonCode: 'OTHER' } });
  if (res.status === 200 || res.body?.code === 'BOOKING_NOT_CHANGEABLE' || res.status === 404) return res;
  throw new Error(`cancelar la reserva ${bookingId}: ${describe(res)}`);
}

/** Deshace un pago de prueba: devuelve el aprobado y rechaza el que sigue en revisión. */
async function undoPayment(adminToken, paymentId) {
  const payment = await api('GET', `/admin/payments/${paymentId}`, { token: adminToken });
  if (payment.body?.status === 'APPROVED') {
    const refund = await api('POST', `/admin/payments/${paymentId}/refund`, { token: adminToken });
    if (refund.status !== 204) throw new Error(`devolver el pago ${paymentId}: ${describe(refund)}`);
  } else if (['PENDING', 'IN_REVIEW'].includes(payment.body?.status)) {
    const reject = await api('POST', `/admin/payments/${paymentId}/reject`, { token: adminToken,
      body: { reason: 'Prueba e2e: se deshace al terminar' } });
    if (reject.status !== 200) throw new Error(`rechazar el pago ${paymentId}: ${describe(reject)}`);
  }
}

/** Cuerpo de una promoción temporal de prueba (porcentaje, vigente desde ayer por la zona horaria). */
function promotionBody(code, discountPercent, requiredPoints) {
  return {
    code, name: `Prueba e2e ${code}`, description: 'Cupón temporal de las pruebas e2e: se borra al terminar',
    featured: false, benefits: [], validFrom: shiftDate(localToday(), -1), validTo: shiftDate(localToday(), 2),
    discountPercent, requiredPoints,
  };
}

/** Borra una promoción de prueba; si ya no existe, no es error. */
async function deletePromotion(adminToken, promotionId) {
  const res = await api('DELETE', `/admin/promotions/${promotionId}`, { token: adminToken });
  if (![200, 204, 404].includes(res.status)) throw new Error(`borrar la promoción ${promotionId}: ${describe(res)}`);
}

module.exports = {
  BASE_URL, API, ZONE, flags, NEEDS_WRITES, NEEDS_SIGNUP, NEEDS_RATE_LIMIT, ROLES, MISSING_ID,
  requireBaseUrl, credentials, api, authCall, describe, expectProblem, session, closeSessions, createCleanup,
  waitFor, sleep, localToday, localNowMinutes, toMinutes, farWeekday, shiftDate, list, random, stamp,
  randomPlate, strongPassword, vehicleTypeWithServices, createVehicle, retireVehicle, findSlot, operatorIdOf,
  notices, waitForNotice, cancelBooking, undoPayment, promotionBody, deletePromotion,
};
