// Registro y reglas de la cuenta, solo con E2E_ALLOW_SIGNUP=1 porque abre cuentas nuevas:
//   SEC-07: sin aceptar los consentimientos (Ley 1581) → CONSENT_REQUIRED;
//   A-01: gmail.com sin importar mayúsculas al registrarse y al crear usuarios; otro dominio al
//         cambiar el correo → EMAIL_DOMAIN_NOT_ALLOWED;
//   SEC-12 y SEC-05: contraseña actual o código de recuperación equivocados muchas veces → TOO_MANY_ATTEMPTS.
// Las cuentas usan alias "+e2e..." de E2E_SIGNUP_EMAIL, un gmail del equipo: si el servidor manda
// correos (MAIL_ENABLED=true), llegan a ese buzón y no al de un tercero. Al final el admin las inhabilita.
//   E2E_ALLOW_SIGNUP=1 E2E_SIGNUP_EMAIL=<buzón-del-equipo>@gmail.com BASE_URL=https://... node --test e2e/remote/signup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const L = require('./lib');

const cleanup = L.createCleanup();
test.after(async () => { await cleanup.run(); await L.closeSessions(); });

const SIGNUP_EMAIL = (process.env.E2E_SIGNUP_EMAIL ?? '').trim().toLowerCase();

/** Alias del buzón del equipo: <buzón>+e2e<marca>@gmail.com (gmail entrega los alias "+" al mismo buzón). */
function alias(tag) {
  const [local, domain] = SIGNUP_EMAIL.split('@');
  return `${local}+e2e${tag}@${domain}`;
}

const registration = (email, consents) => ({
  documentNumber: `97${crypto.randomInt(10 ** 7, 10 ** 8)}`, firstName: 'Prueba', lastName: 'Registro E2E',
  email, password: L.strongPassword(), ...consents,
});

/** Inhabilita al final una cuenta que la prueba abrió (o que se abrió por una regresión). */
async function forget(res, label) {
  if (res.status !== 201 || !res.body?.id) return;
  const { token } = await L.session('admin');
  cleanup.add(`inhabilitar la cuenta ${label}`, async () => {
    const off = await L.api('PATCH', `/admin/users/${res.body.id}/status`, { token, body: { active: false } });
    if (off.status !== 200) throw new Error(L.describe(off));
  });
}

/** Repite la llamada hasta que responda 423 (máximo 10 veces); devuelve todas las respuestas. */
async function untilLocked(call) {
  const answers = [];
  for (let i = 0; i < 10; i++) {
    const res = await call();
    answers.push(res);
    if (res.status === 423) break;
  }
  return answers;
}

test('registro y reglas de la cuenta', { skip: L.NEEDS_SIGNUP }, async (t) => {
  assert.match(SIGNUP_EMAIL, /^[^@+\s]+@gmail\.com$/, 'E2E_SIGNUP_EMAIL debe ser un gmail del equipo (sin "+")');
  const tag = L.stamp();
  const account = { email: alias(tag) };

  await t.test('SEC-07: sin los consentimientos de la Ley 1581 → CONSENT_REQUIRED', async () => {
    const none = await L.authCall('POST', '/auth/register', { body: registration(alias(`${tag}n`), {}) });
    await forget(none, 'sin consentimientos');
    L.expectProblem(none, 400, 'CONSENT_REQUIRED', 'sin casillas');
    const half = await L.authCall('POST', '/auth/register', { body: registration(alias(`${tag}h`), { acceptsTerms: true, acceptsDataPolicy: false }) });
    await forget(half, 'con un solo consentimiento');
    L.expectProblem(half, 400, 'CONSENT_REQUIRED', 'solo términos');
  });

  await t.test('A-01: el registro acepta gmail.com escrito en mayúsculas y lo guarda en minúsculas', async () => {
    const body = registration(account.email.replace('@gmail.com', '@GMAIL.COM'), { acceptsTerms: true, acceptsDataPolicy: true });
    account.password = body.password;
    const res = await L.authCall('POST', '/auth/register', { body });
    await forget(res, account.email);
    assert.equal(res.status, 201, `registro → ${L.describe(res)}`);
    assert.equal(res.body.email, account.email);
    assert.ok(res.body.roles.includes('CLIENT'));
    const login = await L.authCall('POST', '/auth/login', { body: { email: account.email, password: account.password } });
    assert.equal(login.status, 200, `login de la cuenta nueva → ${L.describe(login)}`);
    account.token = login.body.accessToken;
    cleanup.add('cerrar la sesión de la cuenta nueva', () => L.authCall('POST', '/auth/logout', { token: account.token }));
  });

  await t.test('A-01: cambiar el correo a otro dominio → EMAIL_DOMAIN_NOT_ALLOWED', async () => {
    if (!account.token) return t.skip('no se abrió la cuenta');
    L.expectProblem(await L.api('PUT', '/users/me/email', { token: account.token,
      body: { newEmail: `e2e-${tag}@example.org`, currentPassword: account.password } }), 400, 'EMAIL_DOMAIN_NOT_ALLOWED', 'cambiar correo');
  });

  await t.test('A-01: el admin crea un usuario con gmail.com en mayúsculas', async () => {
    const { token } = await L.session('admin');
    const res = await L.api('POST', '/admin/users', { token, body: {
      ...registration(alias(`${tag}a`).replace('@gmail.com', '@GMAIL.COM'), {}), roles: ['CLIENT'] } });
    await forget(res, 'creada por el admin');
    assert.equal(res.status, 201, `crear usuario → ${L.describe(res)}`);
    assert.equal(res.body.email, alias(`${tag}a`));
  });

  await t.test('SEC-12: muchas contraseñas actuales equivocadas → TOO_MANY_ATTEMPTS', async () => {
    if (!account.token) return t.skip('no se abrió la cuenta');
    const answers = await untilLocked(() => L.api('PUT', '/users/me/password', { token: account.token,
      body: { currentPassword: `${account.password}x`, newPassword: L.strongPassword() } }));
    const last = answers.at(-1);
    L.expectProblem(last, 423, 'TOO_MANY_ATTEMPTS', `después de ${answers.length} intentos`);
    assert.ok(answers.slice(0, -1).every((r) => r.body?.code === 'INCORRECT_CURRENT_PASSWORD'),
      answers.map((r) => r.body?.code).join(', '));
  });

  await t.test('SEC-05: muchos códigos de recuperación equivocados → TOO_MANY_ATTEMPTS', async () => {
    if (!account.token) return t.skip('no se abrió la cuenta');
    // el código real llega al buzón del equipo (o al log si MAIL_ENABLED=false); aquí solo se prueban errados
    assert.equal((await L.authCall('POST', '/auth/password/forgot', { body: { email: account.email } })).status, 202);
    const answers = await untilLocked(() => L.authCall('POST', '/auth/password/verify', {
      body: { email: account.email, code: String(crypto.randomInt(0, 10 ** 6)).padStart(6, '0') } }));
    L.expectProblem(answers.at(-1), 423, 'TOO_MANY_ATTEMPTS', `después de ${answers.length} códigos`);
  });
});
