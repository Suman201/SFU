import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { startLocalUiStack } from './helpers/local-ui-stack';
import { startAdminTestServer } from './helpers/admin-test-server';

test('real backend: currency preferences, original prices, decimal invoices, legacy migration and responsive UI', async ({ browser, request }, info) => {
  test.setTimeout(180000);
  const originalMongo = process.env.MONGODB_URI;
  const originalRedis = process.env.REDIS_URL;
  const originalCapacity = process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER;
  process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER = '50';
  const uri = new URL(originalMongo ?? 'mongodb://127.0.0.1:27018/unused');
  if (!['127.0.0.1', 'localhost'].includes(uri.hostname)) throw new Error('Use a local MongoDB for currency acceptance.');
  uri.pathname = `/sfu_currency_acceptance_${Date.now()}`;
  process.env.MONGODB_URI = uri.toString();
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6394';
  if (new URL(redisUrl).port !== '6394') throw new Error('Use isolated Redis port 6394 for currency acceptance.');
  process.env.REDIS_URL = redisUrl;
  const redis = new Redis(redisUrl);
  const connection = await mongoose.createConnection(uri.toString()).asPromise();
  let stack: Awaited<ReturnType<typeof startLocalUiStack>> | undefined;
  let admin: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const folder = process.env.CURRENCY_UI_OUTPUT || info.outputPath('ui');
  try {
    const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
    await redis.set('money:reference-rates:v1', JSON.stringify({ base: 'EUR', provider: 'Frankfurter', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), rates: {
      EUR: { rate: '1', date }, INR: { rate: '90', date }, USD: { rate: '1.1', date }, JPY: { rate: '160.5', date }, KWD: { rate: '0.35', date },
    } }), 'EX', 3600);
    stack = await startLocalUiStack({ frontendPort: 4484, nodePorts: [3384], workerMode: 'in-process', frontendDir: 'apps/frontend/dist/frontend/browser' });
    const apiUrl = stack.nodeAUrl + '/api/v1';
    async function login(email: string) {
      const response = await request.post(apiUrl + '/auth/login', { data: { email, password: 'Password@12345' } });
      expect(response.ok()).toBeTruthy();
      const body = await response.json(); return body.data ?? body;
    }
    const teacher = await login('teacher.one@example.com');
    const student = await login('student.one@example.com');
    const operator = await login('admin@example.com');
    const studentHeaders = { Authorization: 'Bearer ' + student.accessToken };
    const operatorHeaders = { Authorization: 'Bearer ' + operator.accessToken };
    expect((await request.patch(apiUrl + '/currencies/preference', { data: { currency: 'INR' } })).status()).toBe(401);
    const quote = await request.get(apiUrl + '/currencies/quote?amountMinor=1500&currency=EUR&target=JPY');
    const quoteBody = await quote.json();
    expect((quoteBody.data ?? quoteBody).converted).toEqual({ amountMinor: 2408, currency: 'JPY' });

    const guest = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(guest);
    const page = await guest.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(stack.frontendBaseUrl + '/booking');
    const selector = page.getByRole('combobox', { name: 'Display currency' });
    await selector.selectOption('INR');
    const summary = page.getByRole('complementary', { name: 'Lesson summary' });
    await expect(summary).toContainText('2,520.00');
    await expect(summary).toContainText('€28.00 EUR');
    await mkdir(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, `${info.project.name}-currency-desktop.png`), fullPage: true });
    await page.reload(); await expect(selector).toHaveValue('INR');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(selector).toBeVisible(); await selector.selectOption('KWD');
    await expect(summary).toContainText('9.800');
    await page.screenshot({ path: path.join(folder, `${info.project.name}-currency-mobile.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await selector.selectOption('CAD'); await expect(summary).not.toContainText('≈'); await expect(summary).toContainText('€28.00 EUR');

    const learner = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(learner);
    await learner.addInitScript(({ token }) => sessionStorage.setItem('native-sfu.auth.accessToken', token), { token: student.accessToken });
    const accountPage = await learner.newPage(); await accountPage.goto(stack.frontendBaseUrl + '/booking');
    const accountChoice = accountPage.getByRole('combobox', { name: 'Display currency' });
    await expect(accountPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await accountChoice.selectOption('JPY');
    await expect.poll(async () => { const r = await request.get(apiUrl + '/currencies/preference', { headers: studentHeaders }); const b = await r.json(); return (b.data ?? b).currency; }).toBe('JPY');
    const other = await request.get(apiUrl + '/currencies/preference', { headers: { Authorization: 'Bearer ' + teacher.accessToken } });
    const otherBody = await other.json(); expect((otherBody.data ?? otherBody).currency).toBeNull();
    await accountPage.reload(); await expect(accountChoice).toHaveValue('JPY');

    const fresh = await browser.newContext(); contexts.push(fresh);
    await fresh.addInitScript(({ token }) => sessionStorage.setItem('native-sfu.auth.accessToken', token), { token: student.accessToken });
    const freshPage = await fresh.newPage(); await freshPage.goto(stack.frontendBaseUrl + '/booking');
    await expect(freshPage.getByRole('combobox', { name: 'Display currency' })).toHaveValue('JPY');

    const newPrice = { name: 'Kuwaiti accounting price', year: new Date().getUTCFullYear(), maxCapacity: 10, feeMinor: 1234, feeCurrency: 'KWD', schedule: [{ dayOfWeek: 'MONDAY', startTime: '10:00' }] };
    const created = await request.post(apiUrl + '/teacher/batches', { headers: { Authorization: 'Bearer ' + teacher.accessToken }, data: newPrice });
    expect(created.ok()).toBeTruthy(); const createdBody = await created.json();
    expect(createdBody.data ?? createdBody).toMatchObject({ feeMinor: 1234, feeAmount: 1.234, feeCurrency: 'KWD' });
    const invalidPrice = await request.post(apiUrl + '/teacher/batches', { headers: { Authorization: 'Bearer ' + teacher.accessToken }, data: { ...newPrice, name: 'Invalid fractional yen', feeMinor: undefined, feeAmount: 1.23, feeCurrency: 'JPY' } });
    expect(invalidPrice.status()).toBe(400);

    // Legacy data is changed only after its original currency is explicitly identified.
    const legacyId = 'legacy-currency-check';
    await connection.db!.collection('batches').insertOne({ _id: legacyId, name: 'Legacy currency check', teacherId: teacher.user.id, year: new Date().getUTCFullYear(), startDate: new Date(), endDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)), maxCapacity: 20, feeAmount: 1200, status: 'ACTIVE' });
    const migration = await request.patch(apiUrl + '/admin/batches/' + legacyId, { headers: operatorHeaders, data: { feeCurrency: 'INR' } });
    expect(migration.ok()).toBeTruthy();
    const migrated = await connection.db!.collection('batches').findOne({ _id: legacyId } as never);
    expect(migrated).toMatchObject({ feeAmount: 1200, feeMinor: 120000, feeCurrency: 'INR' });

    for (const [currency, unitPriceMinor] of [['JPY', 1200], ['KWD', 1234]] as const) {
      const invoice = await request.post(apiUrl + '/admin/invoices', { headers: operatorHeaders, data: {
        customer: { name: 'Currency acceptance', email: 'currency@example.com', address: '123 Example Street', countryCode: 'IE', vatNumber: '' },
        invoiceDate: date, dueDate: date, supplyDate: date, currency,
        lines: [{ description: 'Accounting units', quantityMilli: 1000, unitPriceMinor, taxRateBps: 0 }],
        taxNote: 'No VAT charged.', notes: '', reference: '',
      } });
      expect(invoice.ok()).toBeTruthy(); const body = await invoice.json(), record = body.data ?? body;
      expect(record.totals.totalMinor).toBe(unitPriceMinor);
      const pdf = await request.get(apiUrl + '/admin/invoices/' + record.id + '/pdf', { headers: operatorHeaders });
      expect(pdf.ok()).toBeTruthy(); expect(pdf.headers()['content-type']).toContain('application/pdf'); expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
    }
    admin = await startAdminTestServer(stack.nodeAUrl);
    const adminContext = await browser.newContext(); contexts.push(adminContext);
    await adminContext.addInitScript(({ token }) => sessionStorage.setItem('native-sfu.admin.auth.accessToken', token), { token: operator.accessToken });
    const adminPage = await adminContext.newPage();
    await adminPage.goto(admin.origin + '/invoices');
    await adminPage.getByRole('button', { name: /New invoice/ }).click();
    const invoiceCurrency = adminPage.locator('select[name="currency"]');
    await invoiceCurrency.selectOption('KWD');
    const price = adminPage.getByRole('spinbutton', { name: 'Unit price 1', exact: true });
    await expect(price).toHaveAttribute('step', '0.001'); await price.fill('1.234');
    await expect(adminPage.locator('.summary-panel')).toContainText('1.234');
    await invoiceCurrency.selectOption('JPY'); await expect(price).toHaveAttribute('step', '1'); await price.fill('1200');
    await expect(adminPage.locator('.summary-panel')).toContainText('1,200');
    await adminPage.screenshot({ path: path.join(folder, `${info.project.name}-invoice-jpy.png`), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await admin?.stop(); await stack?.stop();
    await connection.dropDatabase(); await connection.close(); await redis.quit();
    if (originalRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalRedis;
    if (originalCapacity === undefined) delete process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER; else process.env.MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER = originalCapacity;
    if (originalMongo === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = originalMongo;
  }
});
