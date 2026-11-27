import { expect, test, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { io, type Socket } from 'socket.io-client';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SFU_PROTOCOL_VERSION } from '@native-sfu/contracts';
import { startBuiltUiTestServer } from './helpers/admin-test-server';
import { startLocalSmtpSink } from './helpers/tutor-launch-acceptance';
const { startBookingStack } = require('./helpers/booking-stack.cjs');
function emailText(raw: string): string {
  const split = raw.indexOf('\r\n\r\n'), headers = raw.slice(0, split), body = raw.slice(split + 4);
  return /Content-Transfer-Encoding: base64/i.test(headers) ? Buffer.from(body.replaceAll(/\s/g, ''), 'base64').toString('utf8') : body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

test('account settings change preferences and verified credentials, and revoke device classroom access', async ({ browser, request }, info) => {
  const smtp = await startLocalSmtpSink();
  const oauth = { enabled: () => true, authorizationUrl: (_provider: string, state: string) => 'https://accounts.google.com/auth?state=' + state, exchange: async () => ({ provider: 'google', subject: 'account-browser-google', email: 'different-provider-email@example.com', name: 'Must not replace account name' }) };
  const stack = await startBookingStack({ smtpPort: smtp.port, oauth });
  const web = await startBuiltUiTestServer(stack.origin, path.resolve('apps/frontend/dist/frontend/browser'));
  stack.app.get(require('@nestjs/config').ConfigService).set('passwordRecovery.webUrl', web.origin);
  stack.app.get(require('@nestjs/config').ConfigService).set('socialAuth.frontendUrl', web.origin);
  const contexts: BrowserContext[] = [], sockets: Socket[] = [], errors: string[] = [];
  const folder = path.resolve('reports/account', info.project.name); await mkdir(folder, { recursive: true });
  const tokens: Record<string, string> = {};
  async function api(name: string, method: string, endpoint: string, data?: unknown, expected = method === 'POST' ? 201 : 200) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, { method, data, headers: tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {} });
    const text = await response.text(); expect(response.status(), endpoint + ': ' + text).toBe(expected); const body = text ? JSON.parse(text) : undefined; return body?.data ?? body;
  }
  async function login(name: string, email = stack.users.student.email, password = stack.password) { const result = await api('', 'POST', 'auth/login', { email, password }, 200); tokens[name] = result.accessToken; return result; }
  try {
    await login('student'); const other = await login('otherDevice');
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.addInitScript(token => { if (!sessionStorage.getItem('native-sfu.auth.accessToken')) sessionStorage.setItem('native-sfu.auth.accessToken', token); localStorage.setItem('native-sfu-theme', 'light'); }, tokens.student);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(web.origin + '/account/settings');
    await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
    await page.getByLabel('Display name', { exact: true }).fill('Account learner');
    await page.getByLabel('Phone', { exact: true }).fill('+441234567890');
    await page.getByLabel('Time zone', { exact: true }).fill('Europe/Paris');
    await page.getByRole('button', { name: 'Save account details', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Account details saved');
    await page.getByLabel('Date and number locale', { exact: true }).fill('fr-FR');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Preferences saved');
    await page.getByLabel('Chat messages', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save notifications', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Notification preferences saved');
    await page.reload(); await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Account learner');
    await expect(page.getByLabel('Chat messages', { exact: true })).not.toBeChecked();
    const socket = io(stack.origin + '/sfu', { transports: ['websocket'], reconnection: false, auth: { token: other.accessToken, protocolVersion: SFU_PROTOCOL_VERSION } }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    await page.getByRole('button', { name: 'Sign out other devices', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out other devices', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Other devices signed out');
    await expect.poll(() => socket.connected, { timeout: 45000 }).toBe(false);
    await api('otherDevice', 'GET', 'auth/me', undefined, 401); await api('student', 'GET', 'auth/me');
    await page.route('https://accounts.google.com/**', async route => {
      const state = new URL(route.request().url()).searchParams.get('state')!;
      const callback = stack.origin + '/api/v1/auth/social/google/callback?' + new URLSearchParams({ state, code: 'browser-consent-code' });
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(callback) + ')</script>' });
    });
    await page.getByLabel('Current password for sign-in methods', { exact: true }).fill(stack.password);
    await page.getByRole('button', { name: 'Connect Google', exact: true }).click();
    await expect(page).toHaveURL(web.origin + '/account/link-provider');
    await page.getByRole('button', { name: 'Connect provider', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Sign-in method connected');
    await page.getByRole('link', { name: 'Return to account settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disconnect Google', exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'account-settings-desktop.png'), fullPage: true });
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).include('.account-shell').withRules(['button-name', 'label', 'color-contrast', 'aria-valid-attr-value']).analyze()).violations).toEqual([]);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'account-settings-' + width + '.png'), fullPage: true });
    }
    await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await new AxeBuilder({ page }).include('.account-shell').withRules(['button-name', 'label', 'color-contrast']).analyze()).violations).toEqual([]);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'account-settings-dark.png'), fullPage: true });
    const target = 'account-confirmed@example.com';
    await page.getByLabel('Email to verify', { exact: true }).fill(target);
    await page.getByLabel('Current password for email verification', { exact: true }).fill(stack.password);
    await page.getByRole('button', { name: 'Send verification email', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Verification email queued');
    let confirmation = '';
    await expect.poll(() => { for (const message of smtp.messages) { if (message.subject !== 'Confirm your Sapiovian email address') continue; const text = emailText(message.raw); const match = /https?:\/\/[^\s]+\/account\/confirm-email#token=[a-f0-9]{64}/.exec(text); if (match) confirmation = match[0]; } return Boolean(confirmation); }).toBe(true);
    await page.goto(confirmation); await expect(page).toHaveURL(web.origin + '/account/confirm-email');
    await expect(page.getByRole('button', { name: 'Confirm email address', exact: true })).toBeVisible();
    // Opening the emailed URL does not itself consume it.
    expect((await stack.bookings.users.findById(stack.users.student.id).lean()).email).toBe(stack.users.student.email);
    await page.getByRole('button', { name: 'Confirm email address', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('sign-in email is updated');
    await api('student', 'GET', 'auth/me', undefined, 401);
    await login('student', target);
    await page.evaluate(token => sessionStorage.setItem('native-sfu.auth.accessToken', token), tokens.student);
    await page.goto(web.origin + '/account/settings');
    await page.getByLabel('Current password', { exact: true }).fill(stack.password);
    await page.getByLabel('New password', { exact: true }).fill('AccountBrowserChanged@123');
    await page.getByLabel('Confirm new password', { exact: true }).fill('AccountBrowserChanged@123');
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Change password and sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/student\/login/);
    await api('student', 'GET', 'auth/me', undefined, 401); await login('student', target, 'AccountBrowserChanged@123');
    expect((await api('student', 'GET', 'account')).security.googleLinked).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const socket of sockets) socket.disconnect();
    for (const context of contexts) await context.close().catch(() => undefined);
    await web.stop(); await stack.stop(); await smtp.close();
  }
});

test('billing centre saves defaults, combines purchases and downloads owned invoices, receipts and credit notes', async ({ browser, request }, info) => {
  const { randomUUID } = require('node:crypto');
  const stack = await startBookingStack({ paymentsEnabled: true });
  const web = await startBuiltUiTestServer(stack.origin, path.resolve('apps/frontend/dist/frontend/browser'));
  const contexts: BrowserContext[] = [], errors: string[] = [];
  const folder = path.resolve('reports/account', info.project.name); await mkdir(folder, { recursive: true });
  const tokens: Record<string, string> = {};
  async function api(name: string, method: string, endpoint: string, data?: unknown, expected = method === 'POST' ? 201 : 200) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, { method, data, headers: tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {} });
    const text = await response.text(); expect(response.status(), endpoint + ': ' + text).toBe(expected); const value = text ? JSON.parse(text) : undefined; return value?.data ?? value;
  }
  let offset = 0;
  async function reserve(title: string, currency: string, amountMinor: number) {
    const offer = await api('teacher', 'POST', 'bookings/teacher/offers', { title, description: 'Synthetic billing browser acceptance.', amountMinor, currency, durationMinutes: 30, active: true });
    const slot = await api('teacher', 'POST', 'bookings/teacher/slots', { offerId: offer.id, startsAt: new Date(Math.ceil((Date.now() + (96 + offset++) * 3600000) / 300000) * 300000).toISOString() });
    const order = await api('student', 'POST', 'bookings/slots/' + slot.id + '/reserve', { requestId: randomUUID(), expectedTotalMinor: offer.price.amountMinor, expectedOfferVersion: offer.version, billing: { name: 'Original Invoice Name', email: stack.users.student.email, address: '123 Original Fiscal Street', countryCode: 'GB', vatNumber: '' } });
    await api('student', 'POST', 'bookings/orders/' + order.id + '/checkout'); await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
    return stack.bookings.orders.findById(order.id).lean();
  }
  try {
    for (const name of ['teacher', 'student', 'other', 'admin']) tokens[name] = (await api('', 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
    const euro = await reserve('Billing algebra lesson', 'EUR', 10000); await reserve('Billing yen lesson', 'JPY', 101);
    const batchId = randomUUID(), start = new Date(Date.now() + 300 * 3600000);
    await stack.bookings.batches.create({ _id: batchId, name: 'Billing receipt class', teacherId: stack.users.teacher.id, year: start.getUTCFullYear(), startDate: start, endDate: new Date(start.getTime() + 3600000), maxCapacity: 10, feeAmount: 25, feeMinor: 2500, feeCurrency: 'USD', status: 'ACTIVE' });
    await stack.bookings.classes.create({ _id: randomUUID(), batchId, teacherId: stack.users.teacher.id, title: 'Receipt class', sessionNumber: 1, scheduledAt: start, durationMinutes: 30, status: 'scheduled', roomId: 'room-' + batchId, chatChannelId: 'chat-' + batchId, whiteboardChannelId: 'board-' + batchId });
    const checkout = await api('student', 'POST', 'payments/checkout', { batchId });
    await api('student', 'POST', 'payments/test-gateway/' + checkout.paymentId + '/complete', { outcome: 'succeed' });
    await api('admin', 'POST', 'admin/bookings/' + euro._id + '/refunds', { requestId: randomUUID(), amountMinor: 2400, reason: 'Synthetic billing partial refund.' }); await stack.worker.tick();
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } }); contexts.push(context);
    await context.addInitScript(token => { sessionStorage.setItem('native-sfu.auth.accessToken', token); localStorage.setItem('native-sfu-theme', 'light'); }, tokens.student);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(web.origin + '/account/billing');
    await expect(page.getByRole('heading', { name: 'Billing centre', exact: true })).toBeVisible();
    await page.getByLabel('Billing name', { exact: true }).fill('Saved Billing Company');
    await page.getByLabel('Billing address', { exact: true }).fill('999 Saved Defaults Street');
    await page.getByLabel('Billing country (2-letter code)', { exact: true }).fill('GB');
    await page.getByRole('button', { name: 'Save billing details', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Billing details saved');
    await page.reload(); await expect(page.getByLabel('Billing name', { exact: true })).toHaveValue('Saved Billing Company');
    const euroRow = page.getByRole('row').filter({ hasText: 'Billing algebra lesson' });
    await expect(euroRow).toContainText('Partially refunded'); await expect(euroRow).toContainText('€24.00');
    const pdf = page.waitForEvent('download'); await euroRow.getByRole('button', { name: 'Invoice PDF', exact: true }).click();
    const invoice = await pdf; expect(invoice.suggestedFilename()).toMatch(/^invoice-.*\.pdf$/); expect(await invoice.failure()).toBeNull();
    await expect(page.getByRole('region', { name: 'All-time payment totals' })).toContainText('€120.00');
    await expect(page.getByRole('region', { name: 'All-time payment totals' })).toContainText('¥121');
    const receipt = page.waitForEvent('download'); await page.getByRole('row').filter({ hasText: 'Billing receipt class' }).getByRole('button', { name: 'Receipt PDF', exact: true }).click(); expect((await receipt).suggestedFilename()).toMatch(/^receipt-/);
    await euroRow.getByRole('button', { name: 'Refund details', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Refund history' })).toContainText('Confirmed');
    const credit = page.waitForEvent('download'); await page.getByRole('button', { name: /^Credit note PDF/ }).click(); expect((await credit).suggestedFilename()).toMatch(/^credit-note-/);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'billing-centre-desktop.png'), fullPage: true });
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).include('.account-shell').withRules(['button-name', 'label', 'color-contrast', 'aria-valid-attr-value']).analyze()).violations).toEqual([]);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'billing-centre-' + width + '.png'), fullPage: true });
    }
    await page.evaluate(async () => {
      localStorage.setItem('native-sfu-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark');
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
    });
    expect((await new AxeBuilder({ page }).include('.account-shell').withRules(['button-name', 'label', 'color-contrast']).analyze()).violations).toEqual([]);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.screenshot({ path: path.join(folder, 'billing-centre-dark.png'), fullPage: true });
    await page.getByRole('combobox', { name: 'Purchase currency', exact: true }).selectOption('JPY');
    await expect(page.getByRole('row').filter({ hasText: 'Billing algebra lesson' })).toHaveCount(0); await expect(page.getByRole('row').filter({ hasText: 'Billing yen lesson' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'All-time payment totals' })).toContainText('€120.00');
    await page.goto(web.origin + '/teachers/' + stack.users.teacher.id + '/book');
    await expect(page.getByLabel('Billing name', { exact: true })).toHaveValue('Saved Billing Company');
    await expect(page.getByLabel('Billing address', { exact: true })).toHaveValue('999 Saved Defaults Street');
    // A late defaults response must not overwrite details already entered for this booking.
    let release!: () => void; const delayed = new Promise<void>(resolve => release = resolve);
    await page.route('**/api/v1/billing/profile', async route => { const response = await route.fetch(); await delayed; await route.fulfill({ response }); });
    await page.reload(); await page.getByLabel('Billing name', { exact: true }).fill('Edited Before Defaults'); const defaultsResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/billing/profile')); release(); await defaultsResponse; await page.waitForLoadState('networkidle');
    await expect(page.getByLabel('Billing name', { exact: true })).toHaveValue('Edited Before Defaults'); await page.unroute('**/api/v1/billing/profile');
    await page.goto(web.origin + '/account/billing'); await page.getByRole('button', { name: 'Clear saved details', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear saved details', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Saved billing details cleared');
    await expect(page.getByRole('row').filter({ hasText: 'Billing algebra lesson' }).getByRole('button', { name: 'Invoice PDF', exact: true })).toBeVisible();
    await api('other', 'GET', 'billing/purchases/booking/' + euro._id + '/refunds', undefined, 404);
    expect((await stack.connection.db.collection('invoices').findOne({ _id: euro.invoiceId })).input.customer.name).toBe('Original Invoice Name');
    expect(errors).toEqual([]);
  } finally { for (const context of contexts) await context.close().catch(() => undefined); await web.stop(); await stack.stop(); }
});
