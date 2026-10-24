// SEC-04: demasiadas peticiones a /api/v1/auth/** desde la misma IP → 429 RATE_LIMITED en el
// gateway. Solo con E2E_RATE_LIMIT=1: deja la IP que corre las pruebas sin poder iniciar sesión un
// rato, por eso run.js la corre al final, ya con las sesiones cerradas. Usa un correo que no existe
// (dominio reservado), así no bloquea ninguna cuenta real.
//   E2E_RATE_LIMIT=1 BASE_URL=https://... node --test e2e/remote/rate-limit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib');

const MAX_REQUESTS = Number(process.env.E2E_RATE_LIMIT_MAX ?? 120);

test('SEC-04: el gateway corta las ráfagas a /auth con 429 RATE_LIMITED', { skip: L.NEEDS_RATE_LIMIT }, async () => {
  const body = { email: `nadie-${L.stamp()}@example.org`, password: L.strongPassword() };
  let limited = null;
  let sent = 0;
  while (sent < MAX_REQUESTS && !limited) {
    // de a cinco en paralelo, como lo haría un script que prueba contraseñas
    const batch = await Promise.all(Array.from({ length: 5 }, () => L.api('POST', '/auth/login', { body })));
    sent += batch.length;
    limited = batch.find((res) => res.status === 429) ?? null;
    const unexpected = batch.find((res) => ![401, 429].includes(res.status));
    assert.equal(unexpected, undefined, unexpected && `respuesta inesperada → ${L.describe(unexpected)}`);
  }
  assert.ok(limited, `${sent} intentos de login seguidos y ninguno respondió 429`);
  assert.equal(limited.body?.code, 'RATE_LIMITED', L.describe(limited));
  console.log(`  límite alcanzado tras ${sent} peticiones; Retry-After: ${limited.headers.get('retry-after') ?? 'sin encabezado'}`);

  // el límite es solo de /auth: el resto de la API sigue respondiendo a esa IP
  const catalog = await L.api('GET', '/catalog/services');
  assert.equal(catalog.status, 200, `catálogo con la IP limitada → ${L.describe(catalog)}`);
});
