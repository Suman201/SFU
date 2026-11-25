import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBuiltUiTestServer, startAdminTestServer } from './helpers/admin-test-server';
const { startBookingStack } = require('./helpers/booking-stack.cjs');
const bcrypt = require('bcrypt');

test('merged payment screens use real settlement, earnings and Finance permissions', async ({ browser, request }, info) => {
  test.setTimeout(240000);
  const stack = await startBookingStack({ paymentsEnabled: true });
  const web = await startBuiltUiTestServer(stack.origin, path.resolve('apps/frontend/dist/frontend/browser'));
  const admin = await startAdminTestServer(stack.origin);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const output = process.env.PAYMENT_MERGE_OUTPUT || info.outputPath('ui');
  await mkdir(output, { recursive: true });
  const tokens: Record<string, string> = {};
  const errors: string[] = [];
  async function api(name: string, method: string, endpoint: string, data?: any, status = method === 'POST' ? 201 : 200) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, { method, headers: tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}, data });
    expect(response.status(), endpoint + ': ' + await response.text()).toBe(status);
    const json = await response.json();
    return json.data ?? json;
  }
  async function page(name: string, isAdmin = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    await context.addInitScript(({ token, key }) => {
      sessionStorage.setItem(key, token);
      localStorage.setItem('native-sfu-theme', 'light');
    }, { token: tokens[name], key: isAdmin ? 'native-sfu.admin.auth.accessToken' : 'native-sfu.auth.accessToken' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return page;
  }
  try {
    for (const name of ['student', 'teacher', 'admin']) tokens[name] = (await api(name, 'POST', 'auth/login', { email: stack.users[name].email, password: stack.password }, 200)).accessToken;
    const batchId = randomUUID();
    const startsAt = new Date(Date.now() + 7 * 86400000);
    await stack.bookings.batches.create({ _id: batchId, name: 'Merged payment lesson', teacherId: stack.users.teacher.id, year: startsAt.getUTCFullYear(), startDate: startsAt, endDate: new Date(startsAt.getTime() + 3600000), maxCapacity: 5, feeAmount: 100, feeMinor: 10000, feeCurrency: 'USD', status: 'ACTIVE' });
    const checkout = await api('student', 'POST', 'payments/checkout', { batchId });
    const student = await page('student');
    await student.goto(web.origin + '/payments/test-checkout/' + checkout.paymentId);
    await expect(student.getByRole('heading', { name: 'Pay $100.00' })).toBeVisible();
    await student.getByRole('button', { name: 'Pay with test card', exact: true }).click();
    await expect(student.getByRole('heading', { name: 'Payment received', exact: true })).toBeVisible();
    await expect(student.getByText('You are enrolled in', { exact: false })).toBeVisible();
    await student.goto(web.origin + '/student/payments');
    await expect(student.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    await expect(student.getByRole('cell', { name: 'Merged payment lesson', exact: false })).toBeVisible();
    await student.screenshot({ path: path.join(output, info.project.name + '-student-payments.png'), fullPage: true });
    const teacher = await page('teacher');
    await teacher.goto(web.origin + '/teacher/earnings');
    await expect(teacher.getByRole('heading', { name: 'Earnings', exact: true })).toBeVisible();
    await expect(teacher.getByText('$85.00', { exact: true }).first()).toBeVisible();
    await teacher.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await expect(teacher.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => teacher.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(10, 25, 48)');
    await teacher.setViewportSize({ width: 390, height: 844 });
    await teacher.screenshot({ path: path.join(output, info.project.name + '-teacher-earnings-mobile.png'), fullPage: true });
    const staff = await stack.bookings.users.create({ name: 'Finance UI reader', displayName: 'Finance UI reader', email: 'finance-ui-reader@booking.test', passwordHash: await bcrypt.hash(stack.password, 4), roles: ['ADMIN'], permissions: [], status: 'active', disabled: false });
    const role = await api('admin', 'POST', 'admin/staff/roles', { name: 'Payment UI reader', description: 'Synthetic Finance read access', status: 'active', permissions: ['admin:finance:read'] });
    await api('admin', 'POST', 'admin/staff/members/' + staff.id + '/role', { roleId: role.id, expectedRoleId: null, reason: 'Verify merged UI controls.' });
    tokens.reader = (await api('reader', 'POST', 'auth/login', { email: staff.email, password: stack.password }, 200)).accessToken;
    const reader = await page('reader', true);
    await reader.goto(admin.origin + '/finance/payments/' + checkout.paymentId);
    await expect(reader.getByRole('heading', { name: /^RCPT-/ })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
    await reader.screenshot({ path: path.join(output, info.project.name + '-finance-reader.png'), fullPage: true });
    for (const route of ['overview', 'payments', 'payouts', 'refunds', 'teachers', 'ledger', 'settings']) {
      await reader.goto(admin.origin + '/finance/' + route);
      await expect(reader.locator('h1')).toBeVisible();
      await expect(reader.locator('.table-error')).toHaveCount(0);
    }
    const operator = await page('admin', true);
    await operator.goto(admin.origin + '/finance/payments/' + checkout.paymentId);
    await expect(operator.getByRole('button', { name: 'Refund', exact: true })).toBeVisible();
    await operator.goto(admin.origin + '/finance/overview');
    await expect(operator.getByRole('heading', { name: 'Revenue overview', exact: true })).toBeVisible();
    await expect(operator.getByText('$100.00', { exact: true }).first()).toBeVisible();
    await operator.screenshot({ path: path.join(output, info.project.name + '-finance-overview.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await web.stop();
    await admin.stop();
    await stack.stop();
  }
});
