// RNF-001: tiempo de respuesta p95 < 2 s en las lecturas más usadas, medido por el gateway con
// los servicios corriendo en local. Solo lee: no crea ni cambia datos.
//   node e2e/performance.js            (30 peticiones por endpoint)
//   E2E_PERF_SAMPLES=100 node e2e/performance.js
const { ACCOUNTS, sign, api } = require('./lib');

const SAMPLES = Number(process.env.E2E_PERF_SAMPLES ?? 30);
const LIMIT_MS = 2000;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

(async () => {
  const client = sign(ACCOUNTS.client, ['CLIENT']);
  const admin = sign(ACCOUNTS.admin, ['ADMIN']);
  const today = new Date().toISOString().slice(0, 10);
  const endpoints = [
    ['catálogo público', '/catalog/services', null],
    ['horario público', '/schedule/business-hours', null],
    ['mis reservas (cliente)', '/bookings/me', client],
    ['mis pagos (cliente)', '/payments/me', client],
    ['mis avisos (cliente)', '/notifications?page=0&size=20', client],
    ['reservas del día (admin)', `/admin/bookings?from=${today}&to=${today}`, admin],
    ['resumen del día (admin)', '/admin/bookings/day-summary', admin],
    ['operarios (admin)', '/admin/operators', admin],
  ];

  let failed = 0;
  console.log(`RNF-001 · ${SAMPLES} peticiones por endpoint · límite p95 ${LIMIT_MS} ms\n`);
  console.log('endpoint'.padEnd(28) + 'estado'.padEnd(8) + 'p50 ms'.padStart(8) + 'p95 ms'.padStart(9) + 'máx ms'.padStart(9));
  for (const [name, url, token] of endpoints) {
    for (let i = 0; i < 3; i++) await api('GET', url, token); // calentamiento (JIT, pools)
    const times = [];
    let status = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const response = await api('GET', url, token);
      status = response.status;
      times.push(response.ms);
    }
    const p95 = percentile(times, 95);
    const ok = status === 200 && p95 < LIMIT_MS;
    if (!ok) failed++;
    console.log(`${ok ? 'OK ' : 'XX '}${name}`.padEnd(28) + String(status).padEnd(8)
      + percentile(times, 50).toFixed(0).padStart(8) + p95.toFixed(0).padStart(9) + Math.max(...times).toFixed(0).padStart(9));
  }
  console.log(`\nRESULTADO: ${failed === 0 ? 'todo dentro del límite' : `${failed} endpoint(s) fuera del límite o con error`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
