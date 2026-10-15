// RNF-008: a 360 px de ancho (el teléfono Android más angosto que se soporta) ninguna pantalla de
// la web se sale de lado (sin desplazamiento horizontal). Abre la web con Edge sin ventana; el
// inicio de sesión se responde con un token de prueba de las cuentas del equipo.
//   npm install --prefix e2e        (una vez: instala playwright-core)
//   node e2e/width-360.js           (la web en http://localhost:4200 con ng serve)
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { ACCOUNTS, sign, api } = require('./lib');

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:4200';
const SHOTS = path.join(__dirname, 'shots');
const SCREENS = {
  publico: ['/', '/auth'],
  client: ['/client', '/client/reserve', '/client/vehicles', '/client/history', '/client/notifications'],
  admin: ['/admin', '/admin/reservations', '/admin/operators', '/admin/payments', '/admin/settings'],
};

async function loginAs(page, role) {
  const userId = role === 'admin' ? ACCOUNTS.admin : ACCOUNTS.client;
  const token = sign(userId, [role === 'admin' ? 'ADMIN' : 'CLIENT']);
  const user = (await api('GET', '/users/me', token)).body;
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: token, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 9e5).toISOString(), user }),
  }));
  await page.goto(`${WEB}/auth`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('input[type=email]', { timeout: 90000 });
  await page.fill('input[type=email]', user.email);
  await page.fill('input[type=password]', 'no-se-usa-1A!');
  await page.click('button[type=submit]');
  await page.waitForURL((url) => !url.toString().includes('/auth'), { timeout: 30000 });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'msedge', headless: true });
  let failed = 0;
  try {
    for (const [role, urls] of Object.entries(SCREENS)) {
      const page = await (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
      if (role !== 'publico') await loginAs(page, role);
      for (const url of urls) {
        await page.goto(WEB + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3500);
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        const ok = width <= 361;
        if (!ok) failed++;
        await page.screenshot({ path: path.join(SHOTS, `360-${role}${url.replace(/\//g, '-') || '-inicio'}.png`) });
        console.log(`${ok ? 'OK ' : 'XX '} ${role.padEnd(8)} ${url.padEnd(24)} ancho del contenido ${width}px`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nRESULTADO: ${failed === 0 ? 'ninguna pantalla se sale de 360 px' : `${failed} pantalla(s) con desplazamiento horizontal (ver e2e/shots)`}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
