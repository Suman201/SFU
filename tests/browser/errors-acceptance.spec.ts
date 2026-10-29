import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { io } from 'socket.io-client';
import { startAcceptanceStack, login } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';
import { startAdminTestServer } from './helpers/admin-test-server';

test('real backend: safe failures, offline recovery, client reports and admin triage', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240_000);
  const uri = new URL(process.env.MONGODB_URI!);
  if (
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.pathname !== '/whiteboard_acceptance'
  )
    throw Error('Use isolated local acceptance MongoDB.');
  const stack = await startAcceptanceStack({
    frontendPort: 4484,
    backendPort: 3384,
    secondBackendPort: 3386,
  });
  const connection = await mongoose
    .createConnection(process.env.MONGODB_URI!)
    .asPromise();
  const db = connection.db!;
  const contexts: BrowserContext[] = [];
  let adminServer: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  const screenshots = process.env.ERROR_UI_OUTPUT || info.outputPath('ui');
  await mkdir(screenshots, { recursive: true });
  let validatorInstalled = false;
  try {
    await db.collection('error_incidents').deleteMany({});
    const original = await db
      .collection('users')
      .findOne({ email: 'teacher.one@example.com' });
    if (!original) throw Error('Missing fixture teacher');
    const { _id, ...copy } = original;
    await db.collection('users').updateOne(
      { email: 'errors-admin@example.com' },
      {
        $set: {
          ...copy,
          email: 'errors-admin@example.com',
          name: 'Platform Administrator',
          displayName: 'Platform Administrator',
          roles: ['ADMIN'],
          permissions: ['*'],
        },
      },
      { upsert: true },
    );
    const admin = await login(
      stack.nodeAUrl,
      'errors-admin@example.com',
      'Password@12345',
    );
    const student = await login(
      stack.nodeAUrl,
      'student.one@example.com',
      'Password@12345',
    );
    const teacher = await login(
      stack.nodeAUrl,
      'teacher.one@example.com',
      'Password@12345',
    );
    // Exercise the actual Socket.IO gateway, preserving both legacy recovery and public codes.
    const socket = io(stack.nodeAUrl + '/sfu', {
      transports: ['websocket'],
      auth: { token: student.accessToken },
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const malformedWatch = await socket
        .timeout(10_000)
        .emitWithAck('session:watch', { sessionId: 'invalid session id' });
      expect(malformedWatch).toMatchObject({
        ok: false,
        error: { code: 'BadRequestException', publicCode: 'VALIDATION_FAILED' },
      });
      expect(malformedWatch.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
      const missingRoom = await socket
        .timeout(10_000)
        .emitWithAck('room:leave', { roomId: 'unjoined-room' });
      expect(missingRoom).toMatchObject({
        ok: false,
        error: { publicCode: 'CLASSROOM_ERROR' },
      });
      expect(missingRoom.error.requestId).not.toBe(
        malformedWatch.error.requestId,
      );
    } finally {
      socket.disconnect();
    }
    const api = (
      suffix: string,
      token = admin.accessToken,
      options: any = {},
    ) =>
      request.fetch(`${stack.nodeBUrl}/api/v1/${suffix}`, {
        ...options,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
    for (const token of ['', student.accessToken, teacher.accessToken]) {
      const result = await api('admin/errors', token);
      expect(result.status()).toBe(token ? 403 : 401);
    }
    const invalid = await api('calendar/preferences', student.accessToken, {
      method: 'PATCH',
      data: { timeZone: 'Europe/NotReal', extra: 'private-field-value' },
      headers: { 'x-request-id': 'validation-reference-123' },
    });
    expect(invalid.status()).toBe(400);
    const invalidBody = await invalid.json();
    expect(invalidBody.code).toBe('VALIDATION_FAILED');
    expect(invalidBody.requestId).toBe('validation-reference-123');
    expect(invalidBody.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(invalidBody)).not.toContain('private-field-value');
    expect(await db.collection('error_incidents').countDocuments({})).toBe(0);
    const malformed = await api('auth/login', '', {
      method: 'POST',
      data: '{invalid-secret-json',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(malformed.status()).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toContain(
      'invalid-secret-json',
    );

    const guest = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    contexts.push(guest);
    await db
      .collection('cms_pages')
      .deleteMany({ slug: { $in: ['home', 'teacher-marketplace'] } });
    const page = await guest.newPage();
    const missingHome = page.waitForResponse(
      (response) =>
        response.url().includes('/cms/pages/home') && response.status() === 404,
    );
    await page.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/'));
    await missingHome;
    await expect(
      page.getByRole('heading', {
        name: 'Find the right teacher. Learn from anywhere.',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Error information' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Recent error' }),
    ).toHaveCount(0);
    await page.goto(
      runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/teacher/login'),
    );
    await page
      .getByRole('textbox', { name: 'Email', exact: true })
      .fill('teacher.one@example.com');
    await page
      .getByLabel('Password', { exact: true })
      .fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Error information' });
    await expect(notice).toContainText('Check your sign-in details');
    await expect(notice).toContainText('The email or password is incorrect.');
    await expect(notice.locator('.notice-code')).toContainText(
      'INVALID_CREDENTIALS',
    );
    await page.screenshot({
      path: path.join(
        screenshots,
        `${info.project.name}-visible-error-code.png`,
      ),
      fullPage: true,
    });
    await notice.getByRole('button', { name: 'View details' }).click();
    const details = page.getByRole('dialog');
    await expect(details).toContainText('INVALID_CREDENTIALS');
    await expect(
      details.getByRole('button', { name: 'Report issue' }),
    ).toHaveCount(0);
    await page.screenshot({
      path: path.join(screenshots, `${info.project.name}-sign-in-error.png`),
      fullPage: true,
    });
    await details.getByRole('button', { name: 'Dismiss', exact: true }).click();

    // Induce a real MongoDB write failure only in this isolated fixture; no mocked HTTP or shipping failure route.
    await db.command({
      collMod: 'sessions',
      validator: { $jsonSchema: { required: ['__error_acceptance_only'] } },
      validationAction: 'error',
      validationLevel: 'strict',
    });
    validatorInstalled = true;
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    const failedLogin = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auth/login') && response.status() === 500,
    );
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const failure = await failedLogin;
    const failureBody = await failure.json();
    expect(failureBody.code).toBe('INTERNAL_ERROR');
    expect(failure.headers()['x-request-id']).toBe(failureBody.requestId);
    expect(JSON.stringify(failureBody)).not.toMatch(
      /Mongo|validator|Password@|__error_acceptance/,
    );
    await db.command({ collMod: 'sessions', validator: {} });
    validatorInstalled = false;
    await expect(notice).toContainText('Something went wrong on our side.');
    await notice.getByRole('button', { name: 'View details' }).click();
    await details.locator('summary').click();
    await expect(details.locator('pre')).toContainText(failureBody.requestId);
    await page.screenshot({
      path: path.join(screenshots, `${info.project.name}-server-error.png`),
      fullPage: true,
    });
    await expect
      .poll(() =>
        db.collection('error_incidents').countDocuments({
          requestId: failureBody.requestId,
          source: 'server',
        }),
      )
      .toBe(1);
    const stored = await db
      .collection('error_incidents')
      .findOne({ requestId: failureBody.requestId, source: 'server' });
    expect(JSON.stringify(stored)).not.toMatch(
      /Password@|__error_acceptance|teacher.one@example/,
    );
    expect(stored!.frames.length).toBeGreaterThan(0);
    expect(stored!.diagnosticKind).toBe('database_validation');

    adminServer = await startAdminTestServer(stack.nodeAUrl);
    const adminContext = await browser.newContext({
      viewport: { width: 1500, height: 1100 },
    });
    contexts.push(adminContext);
    await adminContext.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      admin.accessToken,
    );
    const adminPage = await adminContext.newPage();
    await adminPage.goto(adminServer.origin + '/errors');
    await expect(
      adminPage.getByRole('heading', { name: 'Error log', exact: true }),
    ).toBeVisible();
    await adminPage
      .getByRole('textbox', { name: 'Find a reference' })
      .fill(failureBody.requestId);
    await adminPage
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    await expect(adminPage.locator('tbody tr')).toHaveCount(1);
    await adminPage
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await expect(
      adminPage.getByRole('heading', {
        name: 'We could not complete this action',
        exact: true,
      }),
    ).toBeVisible();
    await adminPage.locator('.incident-detail summary').click();
    await adminPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-admin-error-log.png`),
      fullPage: true,
    });
    await adminPage
      .getByRole('button', { name: 'Mark resolved', exact: true })
      .click();
    await expect(adminPage.getByRole('status')).toContainText(
      'Error marked as resolved.',
    );
    const resolved = (await (await api(`admin/errors/${stored!._id}`)).json())
      .data;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBeTruthy();
    await adminPage
      .getByRole('button', { name: 'Reopen error', exact: true })
      .click();
    await expect(adminPage.getByRole('status')).toContainText(
      'Error reopened.',
    );

    const studentContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(studentContext);
    await studentContext.addInitScript(
      (token) => sessionStorage.setItem('native-sfu.auth.accessToken', token),
      student.accessToken,
    );
    const studentPage = await studentContext.newPage();
    await studentPage.goto(
      runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/calendar'),
    );
    await expect(
      studentPage.getByRole('heading', { name: 'Class calendar.' }),
    ).toBeVisible();
    await expect(
      studentPage.getByRole('button', { name: 'Refresh', exact: true }).first(),
    ).toBeEnabled();
    await studentContext.setOffline(true);
    await studentPage
      .getByRole('button', { name: 'Refresh', exact: true })
      .first()
      .click();
    await expect(
      studentPage.getByRole('region', { name: 'Error information' }),
    ).toContainText('Connection interrupted');
    await expect(
      studentPage.getByText(
        'You are offline. Check your connection before submitting changes.',
        { exact: true },
      ),
    ).toBeVisible();
    await studentPage
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await studentPage
      .getByRole('button', { name: 'Report issue', exact: true })
      .click();
    await expect(studentPage.getByRole('dialog')).toContainText(
      'The report could not be sent.',
    );
    await studentPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-offline-error.png`),
      fullPage: true,
    });
    await studentContext.setOffline(false);
    await studentPage
      .getByRole('button', { name: 'Report issue', exact: true })
      .click();
    await expect(studentPage.getByRole('dialog')).toContainText(
      'Technical details saved for your administrator.',
    );
    await studentPage
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
    await studentPage
      .getByRole('button', { name: 'Refresh', exact: true })
      .first()
      .click();
    await expect(
      studentPage.getByRole('button', { name: 'Refresh', exact: true }).first(),
    ).toBeEnabled();

    // Deliberate uncaught-error event exercises the real global handler and authenticated reporting pipeline.
    await studentPage.evaluate(() => {
      const error = new Error('private-runtime-message-password=secret');
      window.dispatchEvent(
        new ErrorEvent('error', { error, message: error.message }),
      );
    });
    await expect(
      studentPage.getByRole('region', { name: 'Error information' }),
    ).toContainText('Something went wrong on this page');
    await expect
      .poll(() =>
        db
          .collection('error_incidents')
          .countDocuments({ code: 'CLIENT_ERROR', source: 'web' }),
      )
      .toBe(1);
    const client = await db
      .collection('error_incidents')
      .findOne({ code: 'CLIENT_ERROR', source: 'web' });
    expect(client!.userId).toBeTruthy();
    expect(JSON.stringify(client)).not.toContain('private-runtime-message');
    const duplicateReport = await api('errors/reports', student.accessToken, {
      method: 'POST',
      data: {
        reference: client!.reference,
        code: 'CLIENT_ERROR',
        source: 'web',
        path: '/calendar?token=discard-me',
      },
    });
    expect(duplicateReport.status()).toBe(201);
    expect(
      await db
        .collection('error_incidents')
        .countDocuments({ reference: client!.reference, source: 'web' }),
    ).toBe(1);
    const forged = await api('errors/reports', student.accessToken, {
      method: 'POST',
      data: {
        reference: 'forged-reference-123',
        code: 'CLIENT_ERROR',
        source: 'server',
        path: '/calendar',
        userId: admin.user?.id,
        message: 'do not store this',
      },
    });
    expect(forged.status()).toBe(400);
    expect(
      (await api(`admin/errors/${stored!._id}`, student.accessToken)).status(),
    ).toBe(403);
    expect((await api('admin/errors?status=invalid')).status()).toBe(400);
    expect((await api('admin/errors/not-an-id')).status()).toBe(404);
    await studentPage
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await studentPage.setViewportSize({ width: 390, height: 844 });
    await expect(studentPage.getByRole('dialog')).toBeVisible();
    expect(
      await studentPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await studentPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-mobile-error.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();

    await adminPage
      .getByRole('button', { name: 'Close details', exact: true })
      .click();
    await adminPage.getByRole('textbox', { name: 'Find a reference' }).fill('');
    await adminPage
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    await expect(adminPage.locator('tbody tr')).toHaveCount(3);
    await adminPage.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(adminPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
    await adminPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-admin-dark.png`),
      fullPage: true,
    });
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        adminPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await adminPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-admin-mobile.png`),
      fullPage: true,
    });

    // The desktop route uses the same renderer; keep native Electron closed.
    const desktopPage = await studentContext.newPage();
    await desktopPage.goto(
      runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/desktop/calendar'),
    );
    await expect(
      desktopPage.getByRole('heading', { name: 'Class calendar.' }),
    ).toBeVisible();
    await desktopPage.evaluate(() =>
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('desktop-fixture-only') }),
      ),
    );
    await expect
      .poll(() =>
        db
          .collection('error_incidents')
          .countDocuments({ source: 'desktop', code: 'CLIENT_ERROR' }),
      )
      .toBe(1);
    await desktopPage
      .getByRole('button', { name: 'View details', exact: true })
      .click();
    await expect(desktopPage.getByRole('dialog')).toContainText('desktop');
    await desktopPage.screenshot({
      path: path.join(screenshots, `${info.project.name}-desktop-error.png`),
      fullPage: true,
    });
    expect(stack.getLogs()).toContain('application_error');
    expect(stack.getLogs()).toContain(failureBody.requestId);
  } finally {
    if (validatorInstalled)
      await db.command({ collMod: 'sessions', validator: {} });
    for (const context of contexts) await context.close();
    await adminServer?.stop();
    await connection.close();
    await stack.stop();
  }
});
