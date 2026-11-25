import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ADMIN_PORTAL_PERMISSIONS } from '@native-sfu/contracts';
import { startAdminTestServer } from './helpers/admin-test-server';
const { startBookingStack } = require('./helpers/booking-stack.cjs');
const bcrypt = require('bcrypt');

test('real staff permissions preserve inspection and enable only authorized writes', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240000);
  const stack = await startBookingStack();
  const server = await startAdminTestServer(stack.origin);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const folder =
    process.env.ADMIN_PERMISSION_UI_OUTPUT || info.outputPath('ui');
  const tokens: Record<string, string> = {};
  async function api(
    actor: string,
    method: string,
    endpoint: string,
    data?: any,
    status = method === 'POST' ? 201 : 200,
  ) {
    const response = await request.fetch(stack.origin + '/api/v1/' + endpoint, {
      method,
      headers: tokens[actor]
        ? { authorization: 'Bearer ' + tokens[actor] }
        : {},
      data,
    });
    expect(response.status(), endpoint + ': ' + (await response.text())).toBe(
      status,
    );
    const body = await response.json();
    return body.data ?? body;
  }
  try {
    await mkdir(folder, { recursive: true });
    for (const name of ['admin', 'student'])
      tokens[name] = (
        await api(
          name,
          'POST',
          'auth/login',
          { email: stack.users[name].email, password: stack.password },
          200,
        )
      ).accessToken;
    for (const name of ['reader', 'writer']) {
      const member = await stack.bookings.users.create({
        displayName: name + ' staff',
        name: name + ' staff',
        email: name + '@booking.test',
        passwordHash: await bcrypt.hash(stack.password, 4),
        roles: ['ADMIN'],
        permissions: [],
        status: 'active',
        disabled: false,
      });
      const permissions = ADMIN_PORTAL_PERMISSIONS.filter(
        (permission) =>
          permission !== 'admin:system:access' &&
          (name === 'writer' || permission.endsWith(':read')),
      );
      const role = await api('admin', 'POST', 'admin/staff/roles', {
        name: name + ' access',
        description: 'Synthetic UI acceptance profile',
        status: 'active',
        permissions,
      });
      await api('admin', 'POST', 'admin/staff/members/' + member.id + '/role', {
        roleId: role.id,
        expectedRoleId: null,
        reason: 'Assign synthetic permission acceptance duties.',
      });
      tokens[name] = (
        await api(
          name,
          'POST',
          'auth/login',
          { email: member.email, password: stack.password },
          200,
        )
      ).accessToken;
    }
    const batch = await api(
      'admin',
      'POST',
      'admin/courses/permission-course/batches',
      {
        name: 'Permission acceptance batch',
        courseName: 'Permission course',
        teacherId: stack.users.teacher.id,
        year: new Date().getUTCFullYear(),
        maxCapacity: 10,
        feeMinor: 0,
        feeCurrency: 'EUR',
        schedule: [{ dayOfWeek: 'MONDAY', startTime: '10:00' }],
      },
    );
    const enrollment = await api('admin', 'POST', 'admin/enrollments', {
      studentId: stack.users.student.id,
      batchId: batch.id,
      status: 'active',
    });
    await api('admin', 'POST', 'admin/cms/pages', {
      title: 'Permission review page',
      slug: 'permission-review',
      pageType: 'page',
      audience: 'public',
      locale: 'en',
      bodyMarkdown: 'A page whose content is inspectable by read-only staff.',
      sections: [],
      tags: [],
    });
    await api('student', 'POST', 'support/requests', {
      issueType: 'audio_video',
      subject: 'Permission support request',
      message: 'Synthetic support request for read-only acceptance.',
    });
    await api('public', 'POST', 'contact/submissions', {
      name: 'Jordan Learner',
      email: 'jordan@example.test',
      subject: 'Permission contact request',
      message: 'Synthetic contact message for admin inspection.',
      category: 'general',
    });
    const date = new Date().toISOString().slice(0, 10);
    const invoice = await api('admin', 'POST', 'admin/invoices', {
      customer: {
        name: 'Permission Customer',
        email: 'customer@example.test',
        address: '123 Synthetic Street',
        countryCode: 'GB',
        vatNumber: '',
      },
      invoiceDate: date,
      dueDate: date,
      supplyDate: date,
      currency: 'EUR',
      lines: [
        {
          description: 'Permission lesson',
          quantityMilli: 1000,
          unitPriceMinor: 5000,
          taxRateBps: 2000,
        },
      ],
      taxNote: '',
      notes: '',
      reference: 'permission-ci',
    });
    const recordingId = randomUUID();
    await stack.connection.db
      .collection('recordings')
      .insertOne({
        recordingId,
        roomId: 'permission-room',
        batchId: batch.id,
        scope: 'room',
        status: 'stopped',
        storageDriver: 'local',
        startedAt: new Date(),
        stoppedAt: new Date(),
        retentionExpiresAt: new Date(Date.now() + 30 * 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
        tracks: [],
      });

    async function session(actor: string) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      contexts.push(context);
      await context.addInitScript((token) => {
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token);
        localStorage.setItem('native-sfu-theme', 'light');
      }, tokens[actor]);
      return context.newPage();
    }
    const reader = await session('reader');
    const failures: string[] = [];
    const writes: string[] = [];
    reader.on('pageerror', (error) => failures.push(error.message));
    reader.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 400)
        failures.push(
          response.status() + ' ' + new URL(response.url()).pathname,
        );
    });
    reader.on('request', (req) => {
      if (
        req.url().includes('/api/') &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method())
      )
        writes.push(req.method() + ' ' + new URL(req.url()).pathname);
    });
    const forbidden =
      /^(Save|Create|Add |Activate$|Deactivate$|Pause$|Suspend$|Reactivate$|Complete$|Cancel$|Archive$|Publish$|Unpublish$|Issue |Send |Record |Review refund|Confirm receipt|Mark verified|Reject document|Mark resolved|Reopen error)/;
    async function inspect(url: string, heading: string) {
      await reader.goto(server.origin + url);
      await expect(
        reader.getByRole('heading', { name: heading, level: 1 }),
      ).toBeVisible({ timeout: 15000 });
      await expect(reader.locator('[role="alert"]')).toHaveCount(0);
      await expect(reader.getByRole('button', { name: forbidden })).toHaveCount(
        0,
      );
      for (const input of await reader
        .locator(
          '.permission-fieldset input, .permission-fieldset select, .permission-fieldset textarea',
        )
        .all())
        await expect(input).toBeDisabled();
    }
    await inspect('/users/' + stack.users.student.id, 'student booking');
    await expect(reader.getByLabel('Name', { exact: true })).toBeDisabled();
    await reader
      .locator('form.edit-form')
      .evaluate((form) =>
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
      );
    await reader.screenshot({
      path: path.join(folder, info.project.name + '-readonly-user.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await inspect('/courses/permission-course', 'Permission course');
    await inspect('/batches/' + batch.id, 'Permission acceptance batch');
    await inspect('/enrollments/' + enrollment.id, 'student booking');
    await inspect('/recordings/' + recordingId, recordingId);
    await inspect('/cms/pages', 'CMS pages');
    await reader.getByRole('button', { name: 'View', exact: true }).click();
    await expect(reader.getByLabel('Body markdown')).toBeDisabled();
    await expect(reader.locator('.cms-preview')).toContainText(
      'Permission review page',
    );
    await inspect('/cms/contact', 'Contact Inbox');
    await reader.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(reader.getByLabel('Internal notes')).toBeDisabled();
    await expect(reader.getByRole('button', { name: 'Mark spam' })).toHaveCount(
      0,
    );
    await inspect('/support', 'Support queue');
    await reader.getByRole('button', { name: 'Triage', exact: true }).click();
    await expect(
      reader.getByRole('button', { name: 'Update request' }),
    ).toHaveCount(0);
    for (const input of await reader
      .locator(
        '.permission-fieldset input, .permission-fieldset select, .permission-fieldset textarea',
      )
      .all())
      await expect(input).toBeDisabled();
    await inspect('/invoices/' + invoice.id, 'Invoice draft');
    await expect(
      reader.getByRole('button', { name: 'Edit draft' }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole('button', { name: /Download/ }),
    ).toBeVisible();
    await reader.goto(server.origin + '/invoices');
    await reader.getByRole('button', { name: 'Invoice settings' }).click();
    await expect(reader.getByLabel('Legal business name')).toBeDisabled();
    await expect(
      reader.getByRole('button', { name: 'Save settings' }),
    ).toHaveCount(0);
    await reader.screenshot({
      path: path.join(
        folder,
        info.project.name + '-readonly-invoice-settings.png',
      ),
      fullPage: true,
      animations: 'disabled',
    });
    await inspect('/teaching-catalog', 'Subjects and categories');
    await expect(
      reader.getByRole('button', { name: 'Add starter catalogue' }),
    ).toHaveCount(0);
    await inspect('/tutor-applications', 'Tutor applications');
    await expect(
      reader.getByRole('combobox', { name: 'Status', exact: true }),
    ).toBeEnabled();
    expect(writes).toEqual([]);
    expect(failures).toEqual([]);
    await api(
      'reader',
      'PATCH',
      'admin/users/' + stack.users.student.id,
      { name: 'Forbidden name' },
      403,
    );

    const writer = await session('writer');
    writer.on('pageerror', (error) => failures.push(error.message));
    await writer.goto(server.origin + '/users/' + stack.users.student.id);
    await expect(
      writer.getByLabel('Display name', { exact: true }),
    ).toBeEnabled();
    await expect(
      writer.getByRole('option', { name: 'Super admin', exact: true }),
    ).toHaveCount(0);
    await writer.getByLabel('Name', { exact: true }).fill('Updated learner');
    await writer
      .getByLabel('Display name', { exact: true })
      .fill('Updated learner');
    await writer
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      writer.getByRole('heading', { name: 'Updated learner', level: 1 }),
    ).toBeVisible();
    expect(
      (await api('admin', 'GET', 'admin/users/' + stack.users.student.id))
        .displayName,
    ).toBe('Updated learner');
    await writer.screenshot({
      path: path.join(
        folder,
        info.project.name + '-authorized-user-editor.png',
      ),
      fullPage: true,
      animations: 'disabled',
    });
    await writer.goto(server.origin + '/users/' + stack.users.admin.id);
    await expect(
      writer.getByRole('button', { name: 'Deactivate', exact: true }),
    ).toHaveCount(0);
    await expect(
      writer.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    await expect(writer.getByLabel('Name', { exact: true })).toBeDisabled();
    await writer.goto(server.origin + '/courses/permission-course');
    await writer
      .getByLabel('Course name', { exact: true })
      .fill('Updated permission course');
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      writer.getByRole('heading', {
        name: 'Updated permission course',
        level: 1,
      }),
    ).toBeVisible();
    await writer.goto(server.origin + '/cms/pages');
    await writer.getByRole('button', { name: 'Edit', exact: true }).click();
    await writer
      .getByLabel('Title', { exact: true })
      .fill('Updated permission page');
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(writer.locator('table')).toContainText(
      'Updated permission page',
    );
    await writer.setViewportSize({ width: 390, height: 844 });
    await writer.getByRole('button', { name: 'Switch to dark mode' }).click();
    await writer.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    expect(
      await writer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await writer.screenshot({
      path: path.join(
        folder,
        info.project.name + '-authorized-cms-mobile-dark.png',
      ),
      fullPage: true,
      animations: 'disabled',
    });
    expect(failures).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await server.stop();
    await stack.stop();
  }
});
