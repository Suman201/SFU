import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { startAcceptanceStack, login } from './helpers/whiteboard-classroom';
import { startAdminTestServer } from './helpers/admin-test-server';

test('real backend: compact admin workspace, navigation, records, editors and responsive layouts', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240_000);
  if (
    !existsSync(
      path.resolve('apps/admin-portal/dist/admin-portal/browser/index.html'),
    )
  )
    throw Error('Build the admin portal before acceptance.');
  const uri = new URL(process.env.MONGODB_URI!);
  if (
    !['localhost', '127.0.0.1'].includes(uri.hostname) ||
    uri.pathname !== '/whiteboard_acceptance'
  )
    throw Error('Use isolated local acceptance MongoDB.');
  const stack = await startAcceptanceStack({
    frontendPort: 4488,
    backendPort: 3388,
  });
  const connection = await mongoose
    .createConnection(process.env.MONGODB_URI!)
    .asPromise();
  const db = connection.db!;
  const server = await startAdminTestServer(stack.nodeAUrl).catch(
    async (error) => {
      await connection.close();
      await stack.stop();
      throw error;
    },
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const output = process.env.ADMIN_MAKEOVER_UI_OUTPUT || info.outputPath('ui');
  await mkdir(output, { recursive: true });
  try {
    const teacher = await db
      .collection('users')
      .findOne({ email: 'teacher.one@example.com' });
    const student = await db
      .collection('users')
      .findOne({ email: 'student.one@example.com' });
    if (!teacher || !student) throw Error('Missing fixture users');
    const { _id, ...copy } = teacher;
    await db.collection('users').updateOne(
      { email: 'admin-makeover@example.com' },
      {
        $set: {
          ...copy,
          name: 'Alex Morgan',
          displayName: 'Alex Morgan',
          email: 'admin-makeover@example.com',
          roles: ['ADMIN'],
          permissions: ['*'],
        },
      },
      { upsert: true },
    );
    await db
      .collection('users')
      .updateOne(
        { _id },
        {
          $set: {
            name: 'Elena Martins',
            displayName: 'Elena Martins',
            phone: '',
          },
        },
      );
    for (const name of [
      'batches',
      'class_sessions',
      'student_enrollments',
      'invoices',
      'invoice_settings',
      'invoice_counters',
    ])
      await db.collection(name).deleteMany({});
    await db
      .collection('teaching_catalog')
      .deleteMany({ name: 'Acceptance teaching language' });
    const stamp = new Date();
    const names = [
      'Mathematics · Advanced',
      'English for everyday life',
      'Introduction to computer science',
    ];
    const batchIds = names.map(() => randomUUID());
    for (let index = 0; index < names.length; index++) {
      await db.collection('batches').insertOne({
        _id: batchIds[index] as any,
        name: names[index],
        courseId: `course-${index}`,
        courseName: names[index],
        teacherId: String(_id),
        year: stamp.getUTCFullYear(),
        startDate: new Date(stamp.getTime() - 86400000),
        endDate: new Date(stamp.getTime() + 30 * 86400000),
        maxCapacity: 20,
        feeAmount: 45,
        status: 'ACTIVE',
        scheduleTimezone: 'Europe/Paris',
        createdAt: stamp,
        updatedAt: stamp,
      });
      await db.collection('class_sessions').insertOne({
        _id: randomUUID() as any,
        batchId: batchIds[index],
        teacherId: String(_id),
        title: [
          'Functions and graphs',
          'Speaking with confidence',
          'Thinking in algorithms',
        ][index],
        sessionNumber: 1,
        scheduledAt: stamp,
        startedAt: new Date(stamp.getTime() - (index + 1) * 600000),
        durationMinutes: 60,
        status: 'live',
        roomId: `admin-ui-fixture-${index}`,
        chatChannelId: `chat-${index}`,
        whiteboardChannelId: `board-${index}`,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await db.collection('student_enrollments').insertOne({
        _id: randomUUID() as any,
        studentId: String(student._id),
        studentName: student.name,
        studentEmail: student.email,
        batchId: batchIds[index],
        batchName: names[index],
        courseId: `course-${index}`,
        teacherId: String(_id),
        status: 'active',
        enrolledAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    const admin = await login(
      stack.nodeAUrl,
      'admin-makeover@example.com',
      'Password@12345',
    );
    const starter = await request.post(
      stack.nodeAUrl + '/api/v1/admin/teaching-catalog/starter',
      { headers: { Authorization: `Bearer ${admin.accessToken}` }, data: {} },
    );
    expect(starter.ok()).toBe(true);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.origin + '/login');
    await page.screenshot({
      path: path.join(output, `${info.project.name}-login.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByText('Enter a valid email address.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Email', exact: true })
      .fill('admin-makeover@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Dashboard', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.metric-card').first().locator('strong'),
    ).toHaveText('3');
    await expect(page.locator('.live-panel tbody tr')).toHaveCount(3);
    await page.screenshot({
      path: path.join(output, `${info.project.name}-dashboard.png`),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Collapse sidebar', exact: true })
      .click();
    await expect(page.locator('.admin-shell')).toHaveClass(/nav-collapsed/);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Expand sidebar', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Expand sidebar', exact: true })
      .click();
    await page
      .getByRole('searchbox', { name: 'Find a module' })
      .fill('invoice');
    await expect(
      page.locator('nav[aria-label="Main navigation"] a'),
    ).toHaveCount(1);
    await page
      .locator('nav[aria-label="Main navigation"]')
      .getByRole('link', { name: 'Invoices', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Invoices', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'New invoice', exact: false })
      .click();
    await page
      .getByRole('textbox', { name: 'Customer name', exact: true })
      .fill('Sofia Laurent');
    await page
      .getByRole('textbox', { name: 'Item description 1', exact: true })
      .fill('Mathematics · October lessons');
    await page
      .getByRole('spinbutton', { name: 'Unit price 1', exact: true })
      .fill('45');
    await page.screenshot({
      path: path.join(output, `${info.project.name}-invoice-editor.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Invoice draft', exact: true }),
    ).toBeVisible();
    expect(await db.collection('invoices').countDocuments({})).toBe(1);
    await page.goto(server.origin + '/users');
    await expect(
      page.getByRole('heading', { name: 'Users', exact: true }),
    ).toBeVisible();
    await page.getByText('More filters', { exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Page size', exact: true })
      .selectOption({ label: '10' });
    await page
      .getByRole('searchbox', { name: 'Search users' })
      .fill('Elena Martins');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody')).toContainText('Elena Martins');
    await page.getByText('More filters', { exact: true }).click();
    await page
      .locator('tbody')
      .getByRole('button', { name: 'Deactivate', exact: true })
      .click();
    const confirm = page.getByRole('dialog', {
      name: 'Deactivate Elena Martins?',
    });
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect((await db.collection('users').findOne({ _id }))?.disabled).toBe(
      false,
    );
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.locator('tbody tr')).not.toHaveCount(1);
    await page.screenshot({
      path: path.join(output, `${info.project.name}-users.png`),
      fullPage: true,
    });
    await page
      .locator('tbody tr')
      .filter({ hasText: 'Elena Martins' })
      .getByRole('link', { name: 'View', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Phone', exact: true })
      .fill('+33 1 23 45 67 89');
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect
      .poll(async () => (await db.collection('users').findOne({ _id }))?.phone)
      .toBe('+33 1 23 45 67 89');
    await page.screenshot({
      path: path.join(output, `${info.project.name}-user-detail.png`),
      fullPage: true,
    });
    const routes = [
      '/class-sessions',
      '/courses',
      '/batches',
      '/enrollments',
      '/attendance',
      '/recordings',
      '/class-library',
      '/tutor-applications',
      '/teaching-catalog',
      '/invoices',
      '/support',
      '/cms/contact',
      '/teacher-promotions',
      '/cms/pages',
      '/audit-logs',
      '/errors',
      `/batches/${batchIds[0]}`,
      '/courses/course-0',
    ];
    for (const route of routes) {
      await page.goto(server.origin + route);
      await expect(page.locator('.page-content h1').first()).toBeVisible();
      await expect(page.locator('.table-error,[role="alert"]')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        route,
      ).toBe(true);
    }
    await page.goto(server.origin + '/teaching-catalog');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.screenshot({
      path: path.join(output, `${info.project.name}-catalogue.png`),
      fullPage: false,
    });
    await page
      .getByRole('button', { name: 'Teaching languages', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add language', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Acceptance teaching language');
    await page
      .getByRole('button', { name: 'Save language', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('Catalogue saved');
    expect(
      await db
        .collection('teaching_catalog')
        .countDocuments({ name: 'Acceptance teaching language' }),
    ).toBe(1);
    await page.goto(server.origin + '/dashboard');
    await page
      .getByRole('button', { name: 'Switch to dark mode', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({
      path: path.join(output, `${info.project.name}-dashboard-dark.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(
      page.getByRole('button', { name: 'Open navigation' }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(output, `${info.project.name}-tablet.png`),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Switch to light mode', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'Open navigation', exact: true })
      .click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.screenshot({
      path: path.join(output, `${info.project.name}-mobile-navigation.png`),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Open navigation', exact: true }),
    ).toBeFocused();
    for (const route of [
      '/dashboard',
      '/users',
      '/teaching-catalog',
      '/invoices',
      '/batches',
    ]) {
      await page.goto(server.origin + route);
      await expect(page.locator('.page-content h1').first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        route,
      ).toBe(true);
      await page.screenshot({
        path: path.join(
          output,
          `${info.project.name}-mobile-${route.slice(1)}.png`,
        ),
        fullPage: false,
      });
    }
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    const studentSession = await login(
      stack.nodeAUrl,
      'student.one@example.com',
      'Password@12345',
    );
    await context.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      studentSession.accessToken,
    );
    await page.goto(server.origin + '/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByText('This portal is limited to administrators.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await context.close();
    await server.stop();
    await connection.close();
    await stack.stop();
  }
});
