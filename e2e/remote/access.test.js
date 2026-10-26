// Reglas de acceso que se prueban sin dejar nada creado: rutas que el gateway no publica (E-01 y
// /internal), sesiones cerradas (SEC-01) y dominio de correo (A-01). Se puede correr contra
// producción sin banderas.
//   BASE_URL=https://... node --test e2e/remote/access.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

const cleanup = L.createCleanup();
test.after(async () => { await cleanup.run(); await L.closeSessions(); });

// una ruta de cada servicio, para ver que el corte de la sesión cubre a todos (SEC-01)
const ONE_ROUTE_PER_SERVICE = [
  ['security', '/users/me'],
  ['customer', '/vehicles'],
  ['booking', '/bookings/me'],
  ['operations', '/operators/my-bookings'],
  ['payment', '/payments/me'],
  ['notification', '/notifications/unread-count'],
];

/** Si una prueba de rechazo llega a crear la cuenta (regresión), el admin la inhabilita. */
async function disableIfCreated(res, label) {
  if (res.status !== 201 || !res.body?.id) return;
  const { token } = await L.session('admin');
  cleanup.add(`inhabilitar la cuenta ${label} creada por error`, async () => {
    const off = await L.api('PATCH', `/admin/users/${res.body.id}/status`, { token, body: { active: false } });
    if (off.status !== 200) throw new Error(L.describe(off));
  });
}

test('la API pública responde y el sitio manda los encabezados de seguridad', async () => {
  const catalog = await L.api('GET', '/catalog/services');
  assert.equal(catalog.status, 200, `catálogo → ${L.describe(catalog)}`);
  if (!L.BASE_URL.startsWith('https://')) return;
  assert.match(catalog.headers.get('strict-transport-security') ?? '', /max-age=\d+/, 'HSTS');
  assert.equal(catalog.headers.get('x-content-type-options'), 'nosniff');
});

test('E-01: /api/v1/operator/bookings/** no sale por el gateway (404 o 401)', async () => {
  const { token: operator } = await L.session('operator');
  const { token: admin } = await L.session('admin');
  const routes = [
    ['GET', '/operator/bookings'],
    ['GET', `/operator/bookings/${L.MISSING_ID}`],
    ['PATCH', `/operator/bookings/${L.MISSING_ID}/status`, { status: 'IN_PROGRESS' }],
  ];
  for (const [method, path, body] of routes) {
    for (const [who, token] of [['operario', operator], ['admin', admin]]) {
      const res = await L.api(method, path, { token, body });
      assert.ok([401, 404].includes(res.status), `${who} ${method} ${path} → ${L.describe(res)}`);
    }
  }
  // la llave interna inventada tampoco abre la ruta
  const spoofed = await L.api('GET', '/operator/bookings', { token: operator, headers: { 'X-Internal-Key': 'e2e-inventada' } });
  assert.ok([401, 404].includes(spoofed.status), `con X-Internal-Key → ${L.describe(spoofed)}`);
});

test('las rutas /internal/** no llegan a la API desde afuera', async () => {
  for (const path of ['/internal/v1/users/admins', `/internal/v1/bookings/${L.MISSING_ID}`, '/api/v1/internal/v1/users/admins']) {
    const res = await L.api('GET', path);
    // en Azure Caddy manda a la web todo lo que no es /api: llega el index.html, no datos
    const html = (res.headers.get('content-type') ?? '').includes('text/html');
    assert.ok([401, 403, 404].includes(res.status) || html, `${path} → ${L.describe(res)}`);
    assert.ok(!Array.isArray(res.body), `${path} devolvió datos de la API`);
  }
});

test('SEC-01: después del logout el token no sirve en ningún servicio, tampoco con "bearer" en minúscula', async (t) => {
  const { email, password } = L.credentials('client');

  await t.test('token que nunca se usó en minúscula', async () => {
    const login = await L.authCall('POST', '/auth/login', { body: { email, password } });
    assert.equal(login.status, 200, `login → ${L.describe(login)}`);
    const token = login.body.accessToken;
    assert.equal((await L.api('GET', '/vehicles', { token })).status, 200, 'antes del logout sirve');
    const out = await L.authCall('POST', '/auth/logout', { token });
    assert.equal(out.status, 204, `logout → ${L.describe(out)}`);
    for (const [service, path] of ONE_ROUTE_PER_SERVICE) {
      for (const scheme of ['bearer', 'Bearer', 'BEARER']) {
        const res = await L.api('GET', path, { token, scheme });
        assert.equal(res.status, 401, `${service} ${path} con "${scheme}" → ${L.describe(res)}`);
      }
    }
  });

  await t.test('token usado en minúscula antes del logout (la respuesta guardada del gateway no lo deja pasar)', async () => {
    const login = await L.authCall('POST', '/auth/login', { body: { email, password } });
    assert.equal(login.status, 200, `login → ${L.describe(login)}`);
    const token = login.body.accessToken;
    assert.equal((await L.api('GET', '/vehicles', { token, scheme: 'bearer' })).status, 200, 'antes del logout sirve');
    assert.equal((await L.authCall('POST', '/auth/logout', { token })).status, 204);
    for (const [service, path] of ONE_ROUTE_PER_SERVICE) {
      const res = await L.api('GET', path, { token, scheme: 'bearer' });
      assert.equal(res.status, 401, `${service} ${path} con "bearer" → ${L.describe(res)}`);
    }
  });
});

test('A-01: solo gmail.com al abrir cuentas; el login y la recuperación no miran el dominio', async (t) => {
  const tag = L.stamp();
  const outsider = `e2e-${tag}@example.org`; // dominio reservado (RFC 2606): no llega a ningún buzón

  await t.test('registro con otro dominio → EMAIL_DOMAIN_NOT_ALLOWED', async () => {
    const res = await L.authCall('POST', '/auth/register', { body: {
      documentNumber: `99${String(Date.now()).slice(-8)}`, firstName: 'Prueba', lastName: 'Dominio',
      email: outsider, password: L.strongPassword(), acceptsTerms: true, acceptsDataPolicy: true } });
    await disableIfCreated(res, outsider);
    L.expectProblem(res, 400, 'EMAIL_DOMAIN_NOT_ALLOWED', 'registro');
  });

  await t.test('el admin crea un operario con otro dominio (mayúsculas) → EMAIL_DOMAIN_NOT_ALLOWED', async () => {
    const { token } = await L.session('admin');
    const res = await L.api('POST', '/admin/users', { token, body: {
      documentNumber: `98${String(Date.now()).slice(-8)}`, firstName: 'Prueba', lastName: 'Dominio',
      email: `E2E-${tag}@Example.ORG`, password: L.strongPassword(), roles: ['OPERATOR'] } });
    await disableIfCreated(res, 'de operario');
    L.expectProblem(res, 400, 'EMAIL_DOMAIN_NOT_ALLOWED', 'crear usuario');
  });

  await t.test('login con otro dominio → error normal de credenciales, no de dominio', async () => {
    const res = await L.authCall('POST', '/auth/login', { body: { email: `nadie-${tag}@example.org`, password: L.strongPassword() } });
    L.expectProblem(res, 401, 'INVALID_CREDENTIALS', 'login');
  });

  await t.test('recuperar contraseña con otro dominio → 202 (no revela ni restringe)', async () => {
    const res = await L.authCall('POST', '/auth/password/forgot', { body: { email: `nadie-${tag}@example.org` } });
    assert.equal(res.status, 202, `olvidé mi contraseña → ${L.describe(res)}`);
  });
});
