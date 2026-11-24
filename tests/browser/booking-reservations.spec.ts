import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  startBuiltUiTestServer,
  startAdminTestServer,
} from './helpers/admin-test-server';
const { startBookingStack } = require('./helpers/booking-stack.cjs');

test('real reservations, hosted checkout handoff, invoices and verified refunds', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(180000);
  const stack = await startBookingStack();
  const ui = await startBuiltUiTestServer(
    stack.origin,
    path.resolve('apps/frontend/dist/frontend/browser'),
  );
  const admin = await startAdminTestServer(stack.origin);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const folder = process.env.BOOKING_UI_OUTPUT || info.outputPath('ui');
  try {
    const api = stack.origin + '/api/v1/';
    const login = async (name: string) => {
      const r = await request.post(api + 'auth/login', {
        data: { email: stack.users[name].email, password: stack.password },
      });
      expect(r.ok()).toBeTruthy();
      const b = await r.json();
      return b.data ?? b;
    };
    const teacher = await login('teacher'),
      student = await login('student'),
      operator = await login('admin');
    const headers = { Authorization: 'Bearer ' + teacher.accessToken };
    const r = await request.post(api + 'bookings/teacher/offers', {
      headers,
      data: {
        title: 'Mathematics confidence',
        description: 'A focused lesson with your own teacher.',
        durationMinutes: 30,
        amountMinor: 5000,
        currency: 'EUR',
        active: true,
      },
    });
    expect(r.ok()).toBeTruthy();
    const offer = (await r.json()).data;
    const startsAt = new Date(
      Math.ceil((Date.now() + 72 * 3600000) / 300000) * 300000,
    ).toISOString();
    expect(
      (
        await request.post(api + 'bookings/teacher/slots', {
          headers,
          data: { offerId: offer.id, startsAt },
        })
      ).ok(),
    ).toBeTruthy();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    contexts.push(context);
    await context.addInitScript(
      (token: string) =>
        sessionStorage.setItem('native-sfu.auth.accessToken', token),
      student.accessToken,
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(ui.origin + '/teachers/' + teacher.user.id + '/book');
    await expect(
      page.getByRole('heading', { name: 'A lesson that fits your goals.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Booking summary' }),
    ).toContainText('€60.00 EUR');
    await page
      .getByRole('combobox', { name: 'Your timezone' })
      .selectOption('Asia/Kolkata');
    await page.locator('.slot-grid button').first().click();
    await page
      .getByRole('textbox', { name: 'Billing name', exact: true })
      .fill('Jordan Acceptance');
    await page
      .getByRole('textbox', { name: 'Billing address', exact: true })
      .fill('123 Synthetic Street\nLondon');
    await page
      .getByRole('textbox', { name: 'Country code', exact: true })
      .fill('GB');
    await mkdir(folder, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-reservation-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-reservation-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Reserve and review' }).click();
    await expect(page).toHaveURL(/\/bookings\/[a-f0-9-]+$/);
    const orderId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Reserved — awaiting payment',
    );
    expect(
      await stack.bookings.enrollments.countDocuments({
        paymentOrderId: orderId,
      }),
    ).toBe(0);
    await page.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>Hosted payment handoff verified</h1>',
      }),
    );
    await page.getByRole('button', { name: /Pay .* securely/ }).click();
    await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
    stack.gateway.pay(orderId);
    // Return URL alone is insufficient; server retrieves provider truth here.
    await page.goto(ui.origin + '/bookings/' + orderId + '?checkout=returned');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Booking confirmed',
    );
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download paid invoice' }).click();
    expect((await download).suggestedFilename()).toContain('invoice');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-confirmed-invoice.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('textbox', { name: 'Reason', exact: true })
      .fill('I need to rearrange my lesson.');
    await page
      .getByRole('button', { name: 'Cancel and request refund' })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Refund in progress',
    );
    await stack.worker.tick();
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Payment refunded',
    );
    await expect(
      page.getByRole('button', { name: 'Download credit note' }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-verified-refund.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await stack.bookings.enrollments.countDocuments({
        paymentOrderId: orderId,
        status: 'active',
      }),
    ).toBe(0);
    const teacherContext = await browser.newContext();
    contexts.push(teacherContext);
    await teacherContext.addInitScript(
      (token: string) =>
        sessionStorage.setItem('native-sfu.auth.accessToken', token),
      teacher.accessToken,
    );
    const teacherPage = await teacherContext.newPage();
    await teacherPage.goto(ui.origin + '/teacher/bookings/availability');
    await expect(
      teacherPage.getByRole('heading', { name: 'Lessons and availability.' }),
    ).toBeVisible();
    await expect(teacherPage.locator('table')).toContainText(
      'Mathematics confidence',
    );
    await teacherPage
      .getByRole('textbox', { name: 'Lesson title', exact: true })
      .fill('Algebra foundations');
    await teacherPage
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('A real teacher-published offer.');
    await teacherPage
      .getByRole('spinbutton', { name: 'Price before tax' })
      .fill('25');
    await teacherPage
      .getByRole('button', { name: 'Publish lesson offer' })
      .click();
    await expect(teacherPage.getByRole('complementary')).toContainText(
      'Algebra foundations',
    );
    await teacherPage.evaluate(() => window.scrollTo(0, 0));
    await teacherPage.screenshot({
      path: path.join(folder, info.project.name + '-teacher-availability.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const adminContext = await browser.newContext();
    contexts.push(adminContext);
    await adminContext.addInitScript(
      (token: string) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      operator.accessToken,
    );
    const adminPage = await adminContext.newPage();
    await adminPage.goto(admin.origin + '/bookings');
    await expect(
      adminPage.getByRole('heading', { name: 'Bookings and refunds' }),
    ).toBeVisible();
    await expect(adminPage.locator('table')).toContainText('refunded');
    await adminPage
      .getByRole('button', { name: 'Manage', exact: true })
      .first()
      .click();
    await expect(adminPage.locator('.refund-editor')).toContainText(
      'no unrefunded verified balance',
    );
    await adminPage.screenshot({
      path: path.join(folder, info.project.name + '-admin-refunds.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(
      page.getByRole('button', { name: 'Download paid invoice' }),
    ).toHaveCSS('color', 'rgb(248, 250, 252)');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(folder, info.project.name + '-refund-mobile-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await admin.stop();
    await ui.stop();
    await stack.stop();
  }
});
