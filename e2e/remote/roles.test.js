// F-04: cada endpoint de admin responde 401 sin token y 403 con CLIENT y con OPERATOR, en los seis
// servicios y por el gateway. También las rutas que son solo del cliente o solo del operario.
// No cambia nada aunque la autorización fallara: las rutas que escriben van con un id que no
// existe y con un cuerpo que ningún servicio acepta (un texto en vez de un objeto JSON).
//   BASE_URL=https://... node --test e2e/remote/roles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

const M = L.MISSING_ID;
const SMALL = 32000; // ids de tipo short (bahías y cuentas de pago)
const NOT_AN_OBJECT = JSON.stringify('e2e: este cuerpo no es válido');

// [método, ruta, ¿lleva cuerpo?, roles que sí entran además de ADMIN]
const ADMIN_ROUTES = [
  // security
  ['GET', '/admin/users'], ['POST', '/admin/users', true], ['PATCH', `/admin/users/${M}/status`, true],
  ['GET', '/admin/roles-permissions'], ['PUT', '/admin/roles-permissions/E2E', true],
  // customer (el operario busca vehículos por placa: es la única ruta de admin que comparte)
  ['GET', `/admin/vehicles?ids=${M}`, false, ['OPERATOR']],
  // booking
  ['GET', '/admin/bookings'], ['GET', '/admin/bookings/day-summary'], ['GET', `/admin/bookings/${M}`],
  ['POST', '/admin/bookings', true], ['PUT', `/admin/bookings/${M}`, true], ['PATCH', `/admin/bookings/${M}/status`, true],
  ['GET', '/admin/catalog/services'], ['POST', '/admin/catalog/services', true], ['PUT', `/admin/catalog/services/${M}`, true],
  ['PATCH', `/admin/catalog/services/${M}/status`, true], ['DELETE', `/admin/catalog/services/${M}`],
  ['GET', '/admin/establishment'], ['PUT', '/admin/establishment', true],
  ['PUT', '/admin/schedule/business-hours', true], ['POST', '/admin/schedule/exceptions', true],
  ['PUT', `/admin/schedule/exceptions/${M}`, true], ['DELETE', `/admin/schedule/exceptions/${M}`], ['GET', '/admin/schedule/history'],
  ['GET', '/admin/bays'], ['POST', '/admin/bays', true], ['PUT', `/admin/bays/${SMALL}`, true], ['DELETE', `/admin/bays/${SMALL}`],
  // operations
  ['GET', '/admin/operators'], ['GET', '/admin/operators/summary'], ['GET', '/admin/operators/profiles'],
  ['GET', `/admin/operators/${M}/metrics`], ['PATCH', `/admin/operators/${M}/status`, true],
  ['PUT', `/admin/operators/${M}/availability`, true], ['PUT', `/admin/operators/${M}/profile`, true],
  ['GET', `/admin/operators/${M}/absences`], ['POST', `/admin/operators/${M}/absences`, true],
  ['DELETE', `/admin/operators/${M}/absences/${M}`],
  ['GET', '/admin/assignments'], ['GET', '/admin/assignments/unassigned'], ['GET', '/admin/assignments/to-close'],
  ['PUT', `/admin/assignments/${M}`, true], ['GET', `/admin/assignments/${M}/candidates`], ['POST', `/admin/assignments/${M}/attended`],
  ['GET', `/admin/inspections/${M}`], ['POST', `/admin/inspections/${M}`, true], ['PATCH', `/admin/inspections/${M}/phases/RECEPTION`, true],
  ['POST', `/admin/inspections/${M}/findings`, true], ['DELETE', `/admin/inspections/${M}/findings/${M}`],
  ['POST', `/admin/inspections/${M}/publish`], ['POST', `/admin/inspections/${M}/share`], ['GET', `/admin/inspections/${M}/photos/${M}`],
  // payment
  ['GET', '/admin/payments'], ['GET', `/admin/payments/${M}`], ['GET', `/admin/payments/amount-due?bookingId=${M}`],
  ['POST', '/admin/payments', true], ['POST', `/admin/payments/${M}/approve`], ['POST', `/admin/payments/${M}/reject`, true],
  ['POST', `/admin/payments/${M}/refund`],
  ['GET', '/admin/payment-accounts'], ['POST', '/admin/payment-accounts', true], ['PUT', `/admin/payment-accounts/${SMALL}`, true],
  ['GET', '/admin/payment-methods'],
  ['GET', '/admin/promotions'], ['GET', '/admin/promotions/metrics'], ['POST', '/admin/promotions', true],
  ['PUT', `/admin/promotions/${M}`, true], ['PATCH', `/admin/promotions/${M}/active`, true], ['DELETE', `/admin/promotions/${M}`],
  // notification
  ['POST', '/admin/notifications', true],
];

// rutas de un solo rol: [método, ruta, ¿lleva cuerpo?]
const CLIENT_ONLY = [
  ['GET', '/ratings/me'], ['POST', `/ratings/${M}`, true], ['GET', '/operators/my-bookings'],
  ['POST', '/payments', true], ['GET', '/payments/me'], ['GET', '/payments/me/bookings'], ['GET', `/payments/${M}`],
  ['GET', '/loyalty/balance'], ['GET', '/loyalty/promotions'], ['POST', '/loyalty/redeem', true],
  ['GET', `/loyalty/redemptions/${M}`], ['DELETE', `/loyalty/redemptions/${M}/1`],
];
const OPERATOR_ONLY = [
  ['GET', '/operator/services'], ['POST', `/operator/services/${M}/start`], ['POST', `/operator/services/${M}/finish`],
  ['GET', '/operator/ratings'],
];

const call = (method, path, withBody, token) => L.api(method, path, { token, raw: withBody ? NOT_AN_OBJECT : undefined });

/** Corre las llamadas de a pocas en paralelo (son muchas y todas son de solo lectura en la práctica). */
async function inBatches(items, fn, size = 6) {
  const failures = [];
  for (let i = 0; i < items.length; i += size) {
    for (const message of await Promise.all(items.slice(i, i + size).map(fn))) if (message) failures.push(message);
  }
  return failures;
}

test('F-04: sin token, cada ruta de admin responde 401', async () => {
  const failures = await inBatches(ADMIN_ROUTES, async ([method, path, withBody]) => {
    const res = await call(method, path, withBody);
    return res.status === 401 ? null : `${method} ${path} → ${res.status}`;
  });
  assert.deepEqual(failures, [], 'rutas de admin que no piden token');
});

for (const role of ['client', 'operator']) {
  test(`F-04: con ${role.toUpperCase()}, cada ruta de admin responde 403`, async () => {
    const { token } = await L.session(role);
    const failures = await inBatches(ADMIN_ROUTES, async ([method, path, withBody, alsoAllowed = []]) => {
      const res = await call(method, path, withBody, token);
      if (alsoAllowed.includes(role.toUpperCase())) {
        // compartida a propósito: el rol entra (200 o 400 por el filtro), pero no se le niega
        return [401, 403].includes(res.status) ? `${method} ${path} → ${res.status} (debería entrar)` : null;
      }
      return res.status === 403 ? null : `${method} ${path} → ${L.describe(res)}`;
    });
    assert.deepEqual(failures, [], `rutas de admin abiertas para ${role.toUpperCase()}`);
  });
}

test('con ADMIN las rutas de lectura existen (el 403 de arriba no es una ruta inexistente)', async () => {
  const { token } = await L.session('admin');
  const reads = ADMIN_ROUTES.filter(([method]) => method === 'GET');
  const failures = await inBatches(reads, async ([method, path]) => {
    const res = await call(method, path, false, token);
    // 404 vale solo si lo responde el servicio (trae code), no el gateway por falta de ruta
    const ok = res.status === 200 || res.status === 400 || (res.status === 404 && res.body?.code);
    return ok ? null : `${method} ${path} → ${L.describe(res)}`;
  });
  assert.deepEqual(failures, [], 'rutas de admin que no responden al admin');
});

test('rutas solo del cliente: 403 con OPERATOR y con ADMIN', async () => {
  for (const role of ['operator', 'admin']) {
    const { token } = await L.session(role);
    const failures = await inBatches(CLIENT_ONLY, async ([method, path, withBody]) => {
      const res = await call(method, path, withBody, token);
      return res.status === 403 ? null : `${method} ${path} → ${L.describe(res)}`;
    });
    assert.deepEqual(failures, [], `rutas del cliente abiertas para ${role.toUpperCase()}`);
  }
});

test('rutas solo del operario: 403 con CLIENT y con ADMIN', async () => {
  for (const role of ['client', 'admin']) {
    const { token } = await L.session(role);
    const failures = await inBatches(OPERATOR_ONLY, async ([method, path, withBody]) => {
      const res = await call(method, path, withBody, token);
      return res.status === 403 ? null : `${method} ${path} → ${L.describe(res)}`;
    });
    assert.deepEqual(failures, [], `rutas del operario abiertas para ${role.toUpperCase()}`);
  }
});

test.after(() => L.closeSessions());
