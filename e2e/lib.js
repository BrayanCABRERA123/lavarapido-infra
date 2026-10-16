// Utilidades de las pruebas entre servicios (e2e). Solo para el entorno local de desarrollo:
// leen el .env de lavarapido-infra (nunca lo imprimen), firman tokens de prueba con JWT_SECRET para
// las cuentas reales del equipo y borran por SQL lo que crean.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Falta ${ENV_FILE}: copia .env.example y llénalo (ver GUIA-EQUIPO.md)`);
  }
  const values = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
  return values;
}

const env = loadEnv();
const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://localhost:8080/api/v1';

// cuentas reales del entorno del equipo (se pueden cambiar con variables de entorno)
const ACCOUNTS = {
  client: Number(process.env.E2E_CLIENT_ID ?? 10002),
  admin: Number(process.env.E2E_ADMIN_ID ?? 60002),
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Token de prueba firmado con el mismo secreto que usa security-service (HS256, 15 minutos). */
function sign(userId, roles) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET no está en el .env');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    iss: env.JWT_ISSUER || 'lavarapido-security-service',
    aud: env.JWT_AUDIENCE || 'lavarapido-api',
    sub: String(userId), roles, iat: now, exp: now + 900,
  });
  const signature = crypto.createHmac('sha256', env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Llamada al gateway; devuelve { status, body, ms }. */
async function api(method, url, token, body) {
  const started = performance.now();
  const response = await fetch(url.startsWith('http') ? url : GATEWAY + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, ms: performance.now() - started };
}

/** Consulta en el SQL Server de Docker; la contraseña viaja por variable de entorno, no en la línea de comandos. */
function sql(query) {
  return execFileSync('docker', ['exec', '-e', 'SQLCMDPASSWORD', 'lavarapido-sqlserver', '/opt/mssql-tools18/bin/sqlcmd',
    '-S', 'localhost', '-U', env.DB_USERNAME || 'sa', '-C', '-d', env.DB_NAME || 'LavaRapido', '-h', '-1', '-W',
    '-Q', `SET NOCOUNT ON; SET QUOTED_IDENTIFIER ON; ${query}`],
  { encoding: 'utf8', env: { ...process.env, SQLCMDPASSWORD: env.DB_PASSWORD } }).trim();
}

/** Borra reservas de prueba con todo lo que generaron (ejecuciones, recordatorios y avisos). */
function deleteBookings(ids) {
  const list = ids.filter((id) => Number.isInteger(id)).join(',');
  if (!list) return;
  sql(`DELETE e FROM execution.service_execution e JOIN booking.booking_service l ON l.booking_service_id = e.booking_service_id WHERE l.booking_id IN (${list});
DELETE FROM notification.booking_reminder WHERE booking_id IN (${list});
DELETE FROM notification.booking_tracking WHERE booking_id IN (${list});
DELETE FROM notification.notification WHERE reference_entity = 'booking' AND reference_id IN (${list});
DELETE FROM booking.booking_service WHERE booking_id IN (${list});
DELETE FROM booking.booking WHERE booking_id IN (${list});`);
}

/**
 * Lleva una reserva a "dentro de 10 minutos" (el operario solo inicia desde 15 minutos antes). Usa la
 * primera bahía activa sin cruce: con la misma bahía ocupada, tr_booking_bay_overlap rechaza el cambio.
 */
function moveBookingToSoon(id, minutes) {
  for (const bay of sql('SELECT service_bay_id FROM booking.service_bay WHERE deleted_at IS NULL ORDER BY service_bay_id').split(/\s+/).filter(Boolean)) {
    sql(`UPDATE booking.booking SET service_bay_id = ${bay}, scheduled_start = DATEADD(minute, 10, SYSUTCDATETIME()),
         scheduled_end = DATEADD(minute, ${10 + minutes}, SYSUTCDATETIME()) WHERE booking_id = ${id}`);
    const moved = sql(`SELECT CASE WHEN scheduled_start BETWEEN DATEADD(minute, 5, SYSUTCDATETIME()) AND DATEADD(minute, 15, SYSUTCDATETIME()) THEN 1 ELSE 0 END FROM booking.booking WHERE booking_id = ${id}`);
    if (moved === '1') return;
  }
  throw new Error(`no hay una bahía libre para mover la reserva ${id} a dentro de 10 minutos`);
}

/** Repite check hasta que devuelva algo verdadero o se acabe el tiempo (los eventos son asíncronos). */
async function waitFor(check, timeoutMs = 15000, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** Un día hábil (lunes a viernes) a varias semanas, para no chocar con reservas reales. */
function farWeekday(daysAhead = 40) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

module.exports = { env, GATEWAY, ACCOUNTS, sign, api, sql, deleteBookings, waitFor, farWeekday, moveBookingToSoon };
