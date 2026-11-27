import { expect, test, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startAdminTestServer, startBuiltUiTestServer } from './helpers/admin-test-server';
const { startBookingStack } = require('./helpers/booking-stack.cjs');
const bcrypt = require('bcrypt');

test('booking earnings, currency payouts and reviewed historical policies use real financial state', async ({ browser, request }, info) => {
  const stack = await startBookingStack({ paymentsEnabled: true });
  const web = await startBuiltUiTestServer(stack.origin, path.resolve('apps/frontend/dist/frontend/browser'));
  const admin = await startAdminTestServer(stack.origin);
  stack.app.get(require('@nestjs/config').ConfigService).set('payments.webUrl', web.origin);
  const { BookingFinanceService } = require('../../apps/backend/dist/payments/booking-finance.service.js');
  const finance = stack.app.get(BookingFinanceService);
  const contexts: BrowserContext[] = [], errors: string[] = [], forbiddenReads: string[] = [];
  const folder = path.resolve('reports/finance', info.project.name); await mkdir(folder, { recursive: true });
  const tokens: Record<string, string> = {};
  async function api(name: string, method: string, endpoint: string, data?: unknown, expected = method === 'POST' ? 201 : 200) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, { method, headers: tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}, data });
    const body = await response.json(); expect(response.status(), endpoint + ': ' + JSON.stringify(body)).toBe(expected); return body.data ?? body;
  }
  async function ui(name: string, isAdmin = false) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 950 } }); contexts.push(context);
    await context.addInitScript(({ token, admin }) => { sessionStorage.setItem(admin ? 'native-sfu.admin.auth.accessToken' : 'native-sfu.auth.accessToken', token); localStorage.setItem('native-sfu-theme', 'light'); }, { token: tokens[name], admin: isAdmin });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return page;
  }
  let offset = 0;
  async function booking(title: string, currency: string, netMinor: number) {
    const offer = await api('teacher', 'POST', 'bookings/teacher/offers', { title, description: 'Synthetic finance browser acceptance.', amountMinor: netMinor, currency, durationMinutes: 30, active: true });
    const slot = await api('teacher', 'POST', 'bookings/teacher/slots', { offerId: offer.id, startsAt: new Date(Math.ceil((Date.now() + (96 + offset++) * 3600000) / 300000) * 300000).toISOString() });
    const order = await api('student', 'POST', 'bookings/slots/' + slot.id + '/reserve', { requestId: randomUUID(), expectedTotalMinor: offer.price.amountMinor, expectedOfferVersion: offer.version, billing: { name: 'Synthetic finance learner', email: stack.users.student.email, address: '123 Browser Test Street', countryCode: 'GB', vatNumber: '' } });
    await api('student', 'POST', 'bookings/orders/' + order.id + '/checkout');
    await stack.bookings.verifyPayment(stack.gateway.pay(order.id));
    return stack.bookings.orders.findById(order.id).lean();
  }
  try {
    for (const name of ['teacher', 'student', 'admin']) tokens[name] = (await api(name, 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
    const settings = await api('admin', 'GET', 'admin/finance/settings');
    await api('admin', 'PATCH', 'admin/finance/settings', { version: settings.version, commissionBps: 1500, holdDays: 0, minimumPayoutMinor: 100, enabledCurrencies: ['USD'], teacherOverrides: [], payoutMinimums: [{ currency: 'EUR', minimumMinor: 100 }, { currency: 'JPY', minimumMinor: 1 }] });
    const euro = await booking('Booked algebra lesson', 'EUR', 10000), yen = await booking('Booked yen lesson', 'JPY', 101);
    for (const order of [euro, yen]) {
      await stack.bookings.orders.updateOne({ _id: order._id }, { $set: { endsAt: new Date(Date.now() - 60000), earningsAvailableAt: new Date(0), earningsNextCheckAt: new Date(0) } });
      await stack.bookings.classes.updateMany({ batchId: order.batchId }, { $set: { status: 'completed', completedAt: new Date() } });
    }
    await finance.releaseDue();
    const historical = await booking('Historical paid geometry lesson', 'EUR', 5000);
    await stack.connection.db.collection('ledger_entries').deleteMany({ bookingOrderId: historical._id });
    await stack.bookings.orders.updateOne({ _id: historical._id }, { $unset: { earningsPolicy: '', earningsCreditedAt: '', earningsAvailableAt: '', earningsNextCheckAt: '', gatewayFeeMinor: '', gatewayFeeCurrency: '', gatewayFeeRecordedAt: '' } });
    const reader = await stack.bookings.users.create({ name: 'Finance browser reader', displayName: 'Finance browser reader', email: 'finance-browser-reader@booking.test', passwordHash: await bcrypt.hash(stack.password, 4), roles: ['ADMIN'], permissions: [], status: 'active', disabled: false });
    const role = await api('admin', 'POST', 'admin/staff/roles', { name: 'Finance browser read only', description: 'Synthetic finance acceptance', status: 'active', permissions: ['admin:finance:read'] });
    await api('admin', 'POST', 'admin/staff/members/' + reader.id + '/role', { roleId: role.id, expectedRoleId: null, reason: 'Verify finance reader controls.' });
    tokens.reader = (await api('reader', 'POST', 'auth/login', { email: reader.email, password: stack.password }, 200)).accessToken;
    const teacher = await ui('teacher'); await teacher.goto(web.origin + '/teacher/earnings');
    await teacher.getByLabel('Earnings currency', { exact: true }).selectOption('EUR');
    await expect(teacher.getByRole('region', { name: 'Balances' }).getByText('€85.00', { exact: true })).toBeVisible();
    await expect(teacher.getByRole('link', { name: 'Booked algebra lesson', exact: true })).toHaveCount(2);
    await teacher.getByLabel('Earnings currency', { exact: true }).selectOption('JPY');
    await expect(teacher.getByRole('region', { name: 'Balances' }).getByText('¥86', { exact: true })).toBeVisible();
    await teacher.getByLabel('Earnings currency', { exact: true }).selectOption('EUR');
    await teacher.getByRole('button', { name: 'Set up payouts', exact: true }).click();
    await expect(teacher.getByRole('textbox', { name: 'Amount (EUR)', exact: true })).toBeVisible();
    await teacher.getByRole('textbox', { name: 'Amount (EUR)', exact: true }).fill('20.001');
    await teacher.getByRole('button', { name: 'Request payout', exact: true }).click();
    await expect(teacher.getByRole('alert')).toContainText('2 decimal');
    await teacher.getByRole('textbox', { name: 'Amount (EUR)', exact: true }).fill('20.00');
    await teacher.getByRole('button', { name: 'Request payout', exact: true }).click();
    await expect(teacher.getByRole('status')).toContainText('requested');
    const staff = await ui('admin', true);
    await staff.goto(admin.origin + '/finance/settings');
    await staff.getByRole('textbox', { name: 'Minimum payout (USD)', exact: false }).fill('20.001');
    await staff.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(staff.getByRole('alert')).toContainText('2 decimal');
    await staff.goto(admin.origin + '/finance/payouts');
    const payoutRow = staff.getByRole('row').filter({ hasText: 'Avery Morgan' });
    await payoutRow.getByRole('button', { name: 'Approve & send', exact: true }).click();
    await staff.getByRole('button', { name: 'Send payout', exact: true }).click();
    await expect(staff.getByRole('status')).toContainText('Sent');
    await teacher.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(teacher.getByRole('region', { name: 'Balances' }).getByText('€20.00', { exact: true })).toBeVisible();
    await teacher.screenshot({ path: path.join(folder, 'teacher-earnings-desktop.png'), fullPage: true });
    const readonly = await ui('reader', true);
    readonly.on('response', response => { if (response.url().includes('/api/v1/') && response.status() === 403) forbiddenReads.push(response.url()); });
    await readonly.goto(admin.origin + '/finance/ledger');
    await expect(readonly.getByRole('heading', { name: 'Historical paid bookings', exact: true })).toBeVisible();
    await expect(readonly.getByRole('button', { name: 'Review earnings', exact: true })).toHaveCount(0);
    await expect(readonly.getByRole('link', { name: 'Booking', exact: true })).toHaveCount(0);
    await api('reader', 'POST', 'admin/finance/booking-earnings/' + historical._id + '/adopt', { commissionBps: 2000, holdDays: 0, reason: 'Unauthorized historical change must be rejected.', expectedUpdatedAt: historical.updatedAt.toISOString() }, 403);
    await readonly.screenshot({ path: path.join(folder, 'finance-reader.png'), fullPage: true });
    await staff.goto(admin.origin + '/finance/ledger');
    await staff.getByRole('row').filter({ hasText: historical.title }).getByRole('button', { name: 'Review earnings', exact: true }).click();
    await staff.getByLabel('Historical commission (%)', { exact: true }).fill('20');
    await staff.getByLabel('Historical holding period (days)', { exact: true }).fill('0');
    await staff.getByLabel('Review reason', { exact: true }).fill('Reviewed the original teacher commission agreement.');
    await staff.screenshot({ path: path.join(folder, 'historical-policy-review.png'), fullPage: true });
    await staff.getByRole('button', { name: 'Approve reviewed earnings', exact: true }).click();
    await staff.getByRole('button', { name: 'Approve earnings policy', exact: true }).click();
    await expect(staff.getByRole('status')).toContainText('reviewed booking');
    await teacher.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(teacher.getByRole('region', { name: 'Balances' }).getByText('€40.00', { exact: true })).toBeVisible();
    for (const width of [768, 390]) {
      await teacher.setViewportSize({ width, height: 1000 });
      await expect.poll(() => teacher.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page: teacher }).include('.pay-shell').withRules(['button-name', 'label', 'aria-valid-attr-value', 'color-contrast']).analyze()).violations).toEqual([]);
      await teacher.screenshot({ path: path.join(folder, 'teacher-earnings-' + width + '.png'), fullPage: true });
    }
    const header = teacher.locator('sfu-header'), menu = header.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible()) await menu.click();
    await header.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    if (await header.getByRole('button', { name: 'Close', exact: true }).isVisible()) await header.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(teacher.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await new AxeBuilder({ page: teacher }).include('.pay-shell').withRules(['button-name', 'label', 'color-contrast']).analyze()).violations).toEqual([]);
    await teacher.screenshot({ path: path.join(folder, 'teacher-earnings-dark.png'), fullPage: true });
    await staff.setViewportSize({ width: 390, height: 1000 });
    await expect.poll(() => staff.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await staff.screenshot({ path: path.join(folder, 'finance-ledger-mobile.png'), fullPage: true });
    const summary = await api('teacher', 'GET', 'teacher/earnings');
    expect(summary.balances.find((item: any) => item.currency === 'EUR')).toMatchObject({ availableMinor: 6500, pendingMinor: 4000, paidOutMinor: 2000 });
    expect(summary.balances.find((item: any) => item.currency === 'JPY').availableMinor).toBe(86);
    expect(errors).toEqual([]); expect(forbiddenReads).toEqual([]);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await web.stop(); await admin.stop(); await stack.stop();
  }
});
