import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAdminTestServer } from './helpers/admin-test-server';
const { startBookingStack } = require('./helpers/booking-stack.cjs');
const bcrypt = require('bcrypt');

test('admin recovery, access, renewal, bookings and currency reporting use the real backend', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240000);
  const stack = await startBookingStack();
  const ui = await startAdminTestServer(stack.origin);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const folder = process.env.ADMIN_COMPLETION_OUTPUT || info.outputPath('ui');
  await mkdir(folder, { recursive: true });
  const tokens: Record<string, any> = {};
  async function api(
    name: string,
    method: string,
    endpoint: string,
    data?: any,
    status?: number,
  ) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, {
      method,
      headers: tokens[name]
        ? { authorization: 'Bearer ' + tokens[name].accessToken }
        : {},
      data,
    });
    expect(response.status(), endpoint + ': ' + (await response.text())).toBe(
      status ?? (method === 'POST' ? 201 : 200),
    );
    const body = await response.json();
    return body.data ?? body;
  }
  const snapshot = (title: string) => ({
    schemaVersion: 1,
    activePageId: 'page-1',
    pages: [
      {
        id: 'page-1',
        title,
        tags: ['algebra'],
        order: 0,
        template: 'grid',
        view: { zoom: 1, panX: 0, panY: 0 },
        elements: [
          {
            id: 'text-1',
            type: 'text',
            position: { x: 100, y: 100 },
            width: 700,
            height: 100,
            text: title,
            fontSize: 28,
            color: '#21362d',
            rotation: 0,
          },
        ],
      },
    ],
  });
  try {
    for (const name of ['admin', 'teacher', 'student'])
      tokens[name] = await api(
        name,
        'POST',
        'auth/login',
        { email: stack.users[name].email, password: stack.password },
        200,
      );
    const reviewer = await stack.bookings.users.create({
      name: 'Board Reviewer',
      displayName: 'Board Reviewer',
      email: 'reviewer@booking.test',
      passwordHash: await bcrypt.hash(stack.password, 4),
      roles: ['ADMIN'],
      permissions: [],
      status: 'active',
      disabled: false,
    });
    tokens.reviewer = await api(
      'reviewer',
      'POST',
      'auth/login',
      { email: reviewer.email, password: stack.password },
      200,
    );
    let offset = 0;
    const epoch = Math.ceil((Date.now() + 72 * 3600000) / 300000) * 300000;
    async function paid(currency: string, amountMinor: number, title: string) {
      const offer = await api('teacher', 'POST', 'bookings/teacher/offers', {
        title,
        description: 'Synthetic teaching acceptance record.',
        durationMinutes: 30,
        amountMinor,
        currency,
        active: true,
      });
      const slot = await api('teacher', 'POST', 'bookings/teacher/slots', {
        offerId: offer.id,
        startsAt: new Date(epoch + offset++ * 3600000).toISOString(),
      });
      const order = await api(
        'student',
        'POST',
        'bookings/slots/' + slot.id + '/reserve',
        {
          requestId: randomUUID(),
          expectedTotalMinor: offer.price.amountMinor,
          expectedOfferVersion: offer.version,
          billing: {
            name: 'Jordan Learner',
            email: stack.users.student.email,
            address: '123 Synthetic Street',
            countryCode: 'GB',
            vatNumber: '',
          },
        },
      );
      await api('student', 'POST', 'bookings/orders/' + order.id + '/checkout');
      stack.gateway.pay(order.id);
      return api('admin', 'POST', 'admin/bookings/' + order.id + '/reconcile', {
        reason: 'Verify synthetic provider payment.',
      });
    }
    const order = await paid('EUR', 5000, 'Algebra foundations');
    await paid('JPY', 1000, 'Japanese conversation');
    const first = await api(
      'teacher',
      'PUT',
      'class-sessions/' + order.sessionId + '/whiteboard',
      {
        batchId: order.batchId,
        snapshot: snapshot('Algebra · original explanation'),
        expectedSnapshotVersion: 0,
        expectedLastOperationSeq: 0,
        createVersion: true,
        reason: 'manual-save',
      },
    );
    await api(
      'teacher',
      'PUT',
      'class-sessions/' + order.sessionId + '/whiteboard',
      {
        batchId: order.batchId,
        snapshot: snapshot('Algebra · revised explanation'),
        expectedSnapshotVersion: first.snapshotVersion,
        expectedLastOperationSeq: 0,
        createVersion: true,
        reason: 'manual-save',
      },
    );
    await stack.bookings.classes.updateOne(
      { _id: order.sessionId },
      { $set: { status: 'completed' } },
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    contexts.push(context);
    await context.addInitScript(
      ({ refreshToken }) => {
        sessionStorage.setItem(
          'native-sfu.admin.auth.accessToken',
          'x.' + btoa(JSON.stringify({ exp: 1 })) + '.x',
        );
        sessionStorage.setItem(
          'native-sfu.admin.auth.refreshToken',
          refreshToken,
        );
        localStorage.setItem('native-sfu-theme', 'light');
      },
      { refreshToken: tokens.admin.refreshToken },
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let refreshes = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/auth/refresh'))
        refreshes++;
    });
    await page.goto(ui.origin + '/whiteboards', {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      page.getByRole('heading', { name: 'Whiteboards', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    expect(refreshes).toBe(1);
    tokens.admin.accessToken = await page.evaluate(() =>
      sessionStorage.getItem('native-sfu.admin.auth.accessToken'),
    );
    await page
      .getByRole('searchbox', { name: 'Search whiteboards' })
      .fill('algebra');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: 'Review board' }).click();
    await expect(
      page.getByRole('heading', { name: 'Whiteboard review', exact: true }),
    ).toBeVisible();
    await expect(page.locator('sfu-whiteboard canvas').first()).toBeVisible();
    await page
      .getByRole('button', { name: 'Preview version 1', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Checkpoint preview' }),
    ).toBeVisible();
    expect(
      (await api('admin', 'GET', 'admin/whiteboards/' + order.sessionId)).board
        .snapshotVersion,
    ).toBe(2);
    for (const format of ['JSON', 'PNG', 'PDF']) {
      const downloading = page.waitForEvent('download');
      await page
        .getByRole('button', { name: 'Export ' + format, exact: true })
        .click();
      const download = await downloading;
      const filename = await download.path();
      expect(filename).toBeTruthy();
      const bytes = await readFile(filename!);
      if (format === 'PDF')
        expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      if (format === 'JSON')
        expect(JSON.parse(bytes.toString()).pages[0].title).toContain(
          'original',
        );
      if (format === 'PNG') expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    }
    await page
      .getByRole('textbox', { name: 'Recovery reason' })
      .fill('Recover the original explanation after review.');
    await page
      .getByRole('button', { name: 'Restore selected version' })
      .click();
    await page
      .getByRole('button', { name: 'Back up and restore', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Whiteboard restored.',
    );
    expect(
      (await api('admin', 'GET', 'admin/whiteboards/' + order.sessionId))
        .versions,
    ).toHaveLength(4);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-whiteboard-recovery.png'),
      fullPage: true,
      animations: 'disabled',
    });

    await page
      .getByRole('link', { name: 'Staff permissions', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Create access role', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Role name', exact: true })
      .fill('Whiteboard reviewers');
    await page
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Read-only teaching review, with no financial access.');
    await page
      .getByRole('checkbox', { name: 'Dashboard · View', exact: true })
      .uncheck();
    await page
      .getByRole('checkbox', { name: 'Whiteboards · View', exact: true })
      .check();
    await page.getByRole('button', { name: 'Review and save role' }).click();
    await page.getByRole('button', { name: 'Save role', exact: true }).click();
    await expect(page.locator('table').first()).toContainText(
      'Whiteboard reviewers',
    );
    const member = page.getByRole('row').filter({ hasText: reviewer.email });
    await member.getByRole('button', { name: 'Assign access' }).click();
    await page
      .getByRole('combobox', { name: 'Access role', exact: true })
      .selectOption({ label: 'Whiteboard reviewers' });
    await page
      .getByRole('textbox', { name: 'Reason for access change' })
      .fill('Assign teaching review duties with bounded access.');
    await page.getByRole('button', { name: 'Review access change' }).click();
    await page
      .getByRole('button', { name: 'Change access', exact: true })
      .click();
    await expect(member).toContainText('Whiteboard reviewers');
    await api('reviewer', 'GET', 'admin/bookings/finance', undefined, 403);
    await page.screenshot({
      path: path.join(folder, info.project.name + '-staff-permissions.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const restricted = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    contexts.push(restricted);
    await restricted.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      tokens.reviewer.accessToken,
    );
    const staffPage = await restricted.newPage();
    staffPage.on('pageerror', (e) => errors.push(e.message));
    await staffPage.goto(ui.origin + '/dashboard');
    await expect(staffPage).toHaveURL(/\/whiteboards$/);
    await expect(
      staffPage.getByRole('link', { name: 'Financial overview', exact: true }),
    ).toHaveCount(0);
    await staffPage.goto(ui.origin + '/whiteboards/' + order.sessionId);
    await staffPage
      .getByRole('button', { name: 'Preview version 1', exact: true })
      .click();
    await expect(
      staffPage.getByRole('textbox', { name: 'Recovery reason' }),
    ).toHaveCount(0);
    expect(
      await staffPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await staffPage.screenshot({
      path: path.join(
        folder,
        info.project.name + '-whiteboard-mobile-readonly.png',
      ),
      fullPage: true,
      animations: 'disabled',
    });
    await staffPage.goto(ui.origin + '/finance');
    await expect(staffPage).toHaveURL(/\/forbidden$/);

    const base = (await stack.bookings.orders.findById(order.id)).toObject();
    await stack.bookings.orders.insertMany(
      Array.from({ length: 32 }, (_, index) => {
        const id = randomUUID();
        return {
          ...base,
          _id: id,
          requestId: randomUUID(),
          title: 'Archived lesson ' + index,
          status: 'expired',
          paidAt: undefined,
          paymentIntentId: undefined,
          stripeSessionId: undefined,
          invoiceId: undefined,
          checkoutUrl: undefined,
          slotId: undefined,
          batchId: 'historical-batch',
          kind: 'batch',
          capacityReleased: true,
          nextReconcileAt: undefined,
          refundedMinor: 0,
          refundPendingMinor: 0,
          invoiceSource: {
            ...base.invoiceSource,
            orderId: id,
            paidAt: new Date(0),
            paymentReference: '',
          },
        };
      }),
    );
    await api('admin', 'POST', 'admin/bookings/' + order.id + '/refunds', {
      requestId: randomUUID(),
      amountMinor: 2000,
      reason: 'Synthetic rejection to verify recovery.',
    });
    const Stripe = require('stripe'),
      originalRefund = stack.gateway.refund;
    try {
      stack.gateway.refund = async () => {
        throw new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: 'Synthetic rejection',
        });
      };
      await stack.worker.tick();
    } finally {
      stack.gateway.refund = originalRefund;
    }
    await page
      .getByRole('link', { name: 'Bookings and refunds', exact: true })
      .click();
    await page
      .getByRole('searchbox', { name: 'Search bookings' })
      .fill('Archived');
    await page
      .getByRole('combobox', { name: 'Page size' })
      .selectOption({ label: '10' });
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.locator('.data-table-footer')).toContainText(
      '32 matching bookings',
    );
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.data-table-footer')).toContainText('Page 2');
    const exporting = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    expect((await exporting).suggestedFilename()).toContain('bookings');
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page
      .getByRole('searchbox', { name: 'Search bookings' })
      .fill(order.id);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      page.getByRole('button', { name: 'Manage', exact: true }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Action reason' })
      .fill('Retry after resolving synthetic provider rejection.');
    await page.getByRole('button', { name: 'Retry failed refund' }).click();
    await page
      .getByRole('button', { name: 'Retry refund', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Refund retry queued.',
    );
    await stack.worker.tick();
    await page
      .getByRole('button', { name: 'Refresh status', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Download credit note' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry failed refund' }),
    ).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(
        folder,
        info.project.name + '-booking-refund-recovery.png',
      ),
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('link', { name: 'Financial report', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Financial overview', exact: true }),
    ).toBeVisible();
    const cash = page.locator('table').first();
    for (const amount of ['€60.00 EUR', '€20.00 EUR', '€40.00 EUR'])
      await expect(
        cash.getByRole('row').filter({ hasText: 'EUR' }),
      ).toContainText(amount);
    await expect(
      cash.getByRole('row').filter({ hasText: 'JPY' }),
    ).toContainText('1,200 JPY');
    const financeExport = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export daily CSV' }).click();
    expect((await financeExport).suggestedFilename()).toContain(
      'booking-finance',
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-finance-currencies.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    for (const width of [820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: path.join(
          folder,
          info.project.name + '-finance-dark-' + width + '.png',
        ),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.getByLabel('From (UTC)', { exact: true }).fill('2020-01-01');
    await page
      .getByRole('button', { name: 'Update report', exact: true })
      .click();
    await expect(page.locator('.notice.error')).toContainText(
      'at most 366 days',
    );
    await expect(
      page.getByRole('button', { name: 'Export daily CSV' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('heading', { name: 'Cash activity by currency' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (error) {
    for (const context of contexts)
      for (const page of context.pages())
        console.error(
          'Acceptance page:',
          page.url(),
          (
            await page
              .locator('body')
              .innerText()
              .catch(() => '')
          ).slice(0, 4000),
        );
    throw error;
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await ui.stop();
    await stack.stop();
  }
});
