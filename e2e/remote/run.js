// Corre la batería e2e contra un despliegue: inicia sesión una sola vez por rol (así no se gasta el
// límite de /auth de la IP), corre cada archivo con node --test en orden, cierra las sesiones y, si
// E2E_RATE_LIMIT=1, deja para el final la prueba que bloquea la IP.
//   BASE_URL=https://... E2E_ADMIN_EMAIL=... (ver README) node e2e/remote/run.js
//   node e2e/remote/run.js access roles      (solo esos archivos)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE_URL, ROLES, flags, requireBaseUrl, credentials, authCall } = require('./lib');

// orden fijo: primero lo que solo lee, luego lo que escribe; rate-limit siempre al final
const FILES = ['access', 'roles', 'full-flow', 'booking-status', 'signup']
  .filter((name) => fs.existsSync(path.join(__dirname, `${name}.test.js`)));

(async () => {
  requireBaseUrl();
  const wanted = process.argv.slice(2);
  const files = wanted.length ? FILES.filter((f) => wanted.includes(f)) : FILES;
  for (const role of ROLES) credentials(role); // falla temprano si falta una variable

  console.log(`Batería e2e contra ${new URL(BASE_URL).host}`);
  console.log(`  escrituras (E2E_ALLOW_WRITES): ${flags.writes ? 'sí' : 'no'} · registro (E2E_ALLOW_SIGNUP): ${flags.signup ? 'sí' : 'no'}`
    + ` · límite de /auth (E2E_RATE_LIMIT): ${flags.rateLimit ? 'sí' : 'no'}\n`);

  // una sesión por rol para todos los archivos (van a los hijos por variables de entorno)
  const env = { ...process.env };
  const tokens = {};
  for (const role of ROLES) {
    const { email, password } = credentials(role);
    const res = await authCall('POST', '/auth/login', { body: { email, password } });
    if (res.status !== 200 || !res.body?.accessToken) {
      throw new Error(`No se pudo iniciar sesión como ${role} (${res.status} ${res.body?.code ?? ''}): revisa E2E_${role.toUpperCase()}_EMAIL/PASSWORD`);
    }
    const roles = res.body.user?.roles ?? [];
    if (!roles.includes(role.toUpperCase())) throw new Error(`La cuenta de E2E_${role.toUpperCase()}_EMAIL no tiene el rol ${role.toUpperCase()}`);
    tokens[role] = res.body.accessToken;
    env[`E2E_TOKEN_${role.toUpperCase()}`] = res.body.accessToken;
    env[`E2E_USER_${role.toUpperCase()}`] = JSON.stringify({ id: res.body.user.id, roles });
  }

  const runFile = (name) => {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(__dirname, `${name}.test.js`)],
      { stdio: 'inherit', env });
    return result.status === 0;
  };

  const failed = [];
  try {
    for (const name of files) if (!runFile(name)) failed.push(name);
  } finally {
    for (const role of ROLES) await authCall('POST', '/auth/logout', { token: tokens[role] }).catch(() => {});
  }
  // después de cerrar las sesiones: deja la IP bloqueada en /auth por un rato
  const rateLimitFile = fs.existsSync(path.join(__dirname, 'rate-limit.test.js'));
  if (flags.rateLimit && rateLimitFile && (!wanted.length || wanted.includes('rate-limit')) && !runFile('rate-limit')) failed.push('rate-limit');

  console.log(`\nRESULTADO: ${failed.length ? `fallaron ${failed.join(', ')}` : 'todo pasó'}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
