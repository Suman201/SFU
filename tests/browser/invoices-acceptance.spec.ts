import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { startAcceptanceStack, login } from './helpers/whiteboard-classroom';
import { startLocalSmtpSink } from './helpers/tutor-launch-acceptance';
import { startAdminTestServer } from './helpers/admin-test-server';

test('real backend: create, issue, PDF, email retry, numbering and payment records', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240000);
  const isolated = new URL(process.env.MONGODB_URI!);
  if (
    !['127.0.0.1', 'localhost'].includes(isolated.hostname) ||
    isolated.pathname !== '/whiteboard_acceptance'
  )
    throw new Error('Use the isolated local acceptance database.');
  const cleanup = await mongoose
    .createConnection(process.env.MONGODB_URI!)
    .asPromise();
  try {
    await cleanup.db!.collection('invoices').deleteMany({});
  } finally {
    await cleanup.close();
  }
  const smtp = await startLocalSmtpSink();
  const stack = await startAcceptanceStack({
    frontendPort: 4474,
    backendPort: 3374,
    secondBackendPort: 3376,
    localSmtpPort: smtp.port,
  }).catch(async (error) => {
    await smtp.close();
    throw error;
  });
  const contexts: any[] = [];
  let adminServer: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  const screens = process.env.INVOICE_UI_OUTPUT || info.outputPath('ui');
  const pdfOutput = process.env.INVOICE_PDF_OUTPUT || info.outputPath('pdf');
  await mkdir(screens, { recursive: true });
  await mkdir(pdfOutput, { recursive: true });
  try {
    const connection = await mongoose
      .createConnection(process.env.MONGODB_URI!)
      .asPromise();
    try {
      const db = connection.db!;
      const teacher = await db
        .collection('users')
        .findOne({ email: 'teacher.one@example.com' });
      if (!teacher) throw Error('Missing acceptance teacher');
      const { _id, ...copy } = teacher;
      await db.collection('users').updateOne(
        { email: 'invoice-admin@example.com' },
        {
          $set: {
            ...copy,
            email: 'invoice-admin@example.com',
            name: 'Invoice Administrator',
            displayName: 'Invoice Administrator',
            roles: ['ADMIN'],
            permissions: ['*'],
          },
        },
        { upsert: true },
      );
      for (const name of ['invoices', 'invoice_settings', 'invoice_counters'])
        await db.collection(name).deleteMany({});
    } finally {
      await connection.close();
    }
    const admin = await login(
      stack.nodeAUrl,
      'invoice-admin@example.com',
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
    const api = async (
      method: string,
      url: string,
      data?: any,
      expected = 200,
      token = admin.accessToken,
      base = stack.nodeAUrl,
    ) => {
      const res = await request.fetch(`${base}/api/v1/admin/invoices${url}`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        data,
      });
      expect(res.status(), `${method} ${url}: ${await res.text()}`).toBe(
        expected,
      );
      const body = await res.json();
      return body.data ?? body;
    };
    await api('GET', '', undefined, 401, '');
    await api('GET', '', undefined, 403, student.accessToken);
    await api('GET', '/settings', undefined, 403, teacher.accessToken);
    await api('POST', '', { currency: 'EUR' }, 400);
    adminServer = await startAdminTestServer(stack.nodeAUrl);
    const context = await browser.newContext({
      viewport: { width: 1680, height: 1100 },
    });
    contexts.push(context);
    await context.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      admin.accessToken,
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(adminServer.origin + '/invoices');
    await expect(
      page.getByRole('heading', { name: 'Invoices', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Invoice settings', exact: true })
      .click();
    await page
      .getByRole('textbox', {
        name: 'VAT / tax registration number',
        exact: true,
      })
      .fill('IE1234567T');
    await page
      .getByRole('button', { name: 'Save settings', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Invoice settings saved',
    );
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-settings.png`),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'All invoices', exact: false })
      .click();
    await page
      .getByRole('button', { name: 'New invoice', exact: false })
      .click();
    await page
      .getByRole('textbox', { name: 'Customer name', exact: true })
      .fill('José Müller');
    await page
      .getByRole('spinbutton', { name: 'Quantity 1', exact: true })
      .fill('2');
    await page
      .getByRole('spinbutton', { name: 'Unit price 1', exact: true })
      .fill('35');
    await page
      .getByRole('spinbutton', { name: 'Tax rate 1', exact: true })
      .fill('20');
    await page.getByRole('button', { name: 'Add item', exact: false }).click();
    await page
      .getByRole('textbox', { name: 'Item description 2', exact: true })
      .fill('Introductory meeting');
    await page
      .getByRole('spinbutton', { name: 'Unit price 2', exact: true })
      .fill('15');
    await page
      .getByRole('textbox', { name: 'Tax information', exact: true })
      .fill(
        'VAT applies to taxable lesson services. No VAT charged on the introductory meeting.',
      );
    await expect(page.locator('.summary-panel')).toContainText('€99.00');
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-create.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Invoice draft', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/invoices\/[a-f0-9-]{36}$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const draft = await api('GET', '/' + id);
    expect(draft.totals).toMatchObject({
      subtotalMinor: 8500,
      taxMinor: 1400,
      totalMinor: 9900,
    });
    expect(
      (
        await request.get(`${stack.nodeAUrl}/api/v1/admin/invoices/${id}/pdf`)
      ).status(),
    ).toBe(401);
    await api('POST', `/${id}/email`, { requestId: randomUUID() }, 400);
    await api('PATCH', '/' + id, { ...draft, customer: undefined }, 400);
    await page
      .getByRole('button', { name: 'Issue invoice', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /INV-\d{4}-\d{6}/,
    );
    const issued = await api('GET', '/' + id);
    expect(issued.status).toBe('issued');
    expect(issued.number).toMatch(/^INV-/);
    const headers = { Authorization: `Bearer ${admin.accessToken}` };
    const pdf = await request.get(
      `${stack.nodeAUrl}/api/v1/admin/invoices/${id}/pdf`,
      { headers },
    );
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['cache-control']).toContain('no-store');
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    await writeFile(
      path.join(pdfOutput, `sapiovian-invoice-${info.project.name}.pdf`),
      bytes,
    );
    await api('PATCH', '/' + id, { ...draft, version: issued.version }, 400);
    const patch = {
      customer: draft.customer,
      invoiceDate: draft.invoiceDate,
      dueDate: draft.dueDate,
      supplyDate: draft.supplyDate,
      currency: draft.currency,
      lines: draft.lines,
      taxNote: draft.taxNote,
      notes: draft.notes,
      reference: draft.reference,
      version: issued.version,
    };
    await api('PATCH', '/' + id, patch, 409);
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'could not be delivered',
    );
    expect(smtp.failures()).toBe(1);
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Invoice emailed');
    expect(smtp.messages).toHaveLength(1);
    const raw = smtp.messages[0]!.raw;
    expect(raw).toContain(issued.number + '.pdf');
    const attachment = raw
      .split(/\r\n--/)
      .find((part) => part.includes('Content-Type: application/pdf'));
    expect(attachment).toBeTruthy();
    const encoded = attachment!
      .split('\r\n\r\n')
      .slice(1)
      .join('\r\n\r\n')
      .trim();
    expect(Buffer.from(encoded.replace(/\s/g, ''), 'base64')).toEqual(bytes);
    const sent = await api('GET', '/' + id);
    const same = await api(
      'POST',
      `/${id}/email`,
      { requestId: sent.emailAttempts.at(-1).requestId },
      201,
    );
    expect(same.emailAttempts).toHaveLength(2);
    expect(smtp.messages).toHaveLength(1);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-issued.png`),
      fullPage: true,
    });
    const settings = await api('GET', '/settings');
    await api('PATCH', '/settings', {
      ...settings,
      seller: { ...settings.seller, name: 'Changed Seller Ltd' },
    });
    expect((await api('GET', '/' + id)).seller.name).toBe(issued.seller.name);
    expect(
      await (
        await request.get(`${stack.nodeAUrl}/api/v1/admin/invoices/${id}/pdf`, {
          headers,
        })
      ).body(),
    ).toEqual(bytes);
    const nextDrafts = await Promise.all(
      Array.from({ length: 4 }, () => api('POST', '', patch, 201)),
    );
    const numbers = await Promise.all(
      nextDrafts.map((item, index) =>
        api(
          'POST',
          `/${item.id}/issue`,
          { version: item.version },
          201,
          admin.accessToken,
          index % 2 ? stack.nodeBUrl! : stack.nodeAUrl,
        ),
      ),
    );
    expect(
      new Set([issued.number, ...numbers.map((item) => item.number)]).size,
    ).toBe(5);
    const other = numbers[0];
    const voided = await api(
      'POST',
      `/${other.id}/void`,
      { version: other.version, reason: 'Duplicate invoice entered in error.' },
      201,
    );
    expect(voided.status).toBe('void');
    await api('POST', `/${other.id}/email`, { requestId: randomUUID() }, 400);
    const many = {
      ...patch,
      lines: Array.from({ length: 40 }, (_, index) => ({
        description: `Lesson ${index + 1}: Étude, Prüfung, Μαθηματικά and математика. Detailed preparation, guided practice and individual feedback for this learning session.`,
        quantityMilli: 1000,
        unitPriceMinor: 2800,
        taxRateBps: 0,
      })),
      taxNote: 'No VAT charged.',
    };
    const longDraft = await api('POST', '', many, 201);
    const longInvoice = await api(
      'POST',
      `/${longDraft.id}/issue`,
      { version: longDraft.version },
      201,
    );
    await writeFile(
      path.join(pdfOutput, `sapiovian-invoice-long-${info.project.name}.pdf`),
      await (
        await request.get(
          `${stack.nodeAUrl}/api/v1/admin/invoices/${longInvoice.id}/pdf`,
          { headers },
        )
      ).body(),
    );
    smtp.rejectNext();
    await page
      .getByRole('button', { name: 'Record payment', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Payment reference', exact: true })
      .fill('BANK-TRANSFER-1028');
    await page
      .getByRole('button', { name: 'Save payment', exact: true })
      .click();
    await expect(page.locator('.detail-toolbar .data-pill')).toHaveText('paid');
    await expect.poll(() => smtp.messages.length, { timeout: 45000 }).toBe(2);
    const paid = await api('GET', '/' + id);
    expect(paid.paymentEmail.status).toBe('done');
    expect(smtp.failures()).toBe(2);
    await expect(page.locator('.delivery-status')).toHaveText('Sent', {
      timeout: 10000,
    });
    await expect(page.getByRole('status')).toContainText('invoice emailed');
    await api(
      'POST',
      `/${id}/void`,
      { version: paid.version, reason: 'This must not void a paid invoice.' },
      409,
    );
    expect(
      await (
        await request.get(`${stack.nodeAUrl}/api/v1/admin/invoices/${id}/pdf`, {
          headers,
        })
      ).body(),
    ).toEqual(bytes);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-mobile.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1680, height: 1100 });
    await page
      .getByRole('button', { name: 'All invoices', exact: false })
      .click();
    await expect(page.getByRole('table')).toContainText(issued.number);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-list.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(screens, `${info.project.name}-invoice-list-dark.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await writeFile(
      path.join(screens, `${info.project.name}-acceptance.json`),
      JSON.stringify(
        {
          realBackend: true,
          realDatabase: true,
          localSmtp: true,
          invoiceNumber: issued.number,
          acceptedEmails: smtp.messages.length,
          numberingAcrossTwoProcesses: true,
          totalMinor: issued.totals.totalMinor,
          actualGatewayUsed: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(info.outputPath('stack.log'), stack.getLogs());
    for (const [index, context] of contexts.entries())
      for (const [n, page] of context.pages().entries())
        await page
          .screenshot({
            path: info.outputPath(`failure-${index}-${n}.png`),
            fullPage: true,
          })
          .catch(() => undefined);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await adminServer?.stop();
    await stack.stop();
    await smtp.close();
  }
});
