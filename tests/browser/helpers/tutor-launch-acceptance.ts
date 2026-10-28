import { createServer, type Socket } from 'node:net';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { login } from './whiteboard-classroom';
type Api = (
  method: string,
  url: string,
  token: string | undefined,
  data?: any,
  expected?: number,
) => Promise<any>;
export async function startLocalSmtpSink() {
  const messages: Array<{ subject: string; raw: string }> = [];
  let rejectFirst = true;
  let failures = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost tutor acceptance SMTP\r\n');
    let buffer = '';
    let data = false;
    let lines: string[] = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            const raw = lines.join('\r\n');
            let subject =
              raw
                .match(/^Subject: (.*(?:\r\n[ \t].*)*)/im)?.[1]
                ?.replace(/\r\n[ \t]+/g, '') || '';
            subject = subject.replace(
              /=\?UTF-8\?([BQ])\?([^?]+)\?=/gi,
              (_, type, text) =>
                type.toUpperCase() === 'B'
                  ? Buffer.from(text, 'base64').toString('utf8')
                  : Buffer.from(
                      text
                        .replace(/_/g, ' ')
                        .replace(/=([0-9A-F]{2})/gi, (_: string, n: string) =>
                          String.fromCharCode(parseInt(n, 16)),
                        ),
                      'binary',
                    ).toString('utf8'),
            );
            messages.push({ subject, raw });
            lines = [];
            data = false;
            socket.write('250 accepted\r\n');
          } else lines.push(line);
          continue;
        }
        if (/^EHLO|^HELO/i.test(line))
          socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line) && rejectFirst) {
          rejectFirst = false;
          failures++;
          socket.write('451 Temporary acceptance-test mail outage\r\n');
        } else if (/^DATA/i.test(line)) {
          data = true;
          socket.write('354 End with dot\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.end('221 Bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as any).port,
    messages,
    failures: () => failures,
    rejectNext: () => { rejectFirst = true; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export async function approveFixtureContent(api: Api, token: string) {
  const snapshot = await api('GET', '/teaching-catalog', undefined);
  for (const entry of [...snapshot.categories, ...snapshot.levels])
    if (entry.assessmentApprovedVersion !== entry.version)
      await api(
        'POST',
        `/admin/teaching-catalog/${entry.kind}/${entry.id}/assessment-approval`,
        token,
        {
          version: entry.version,
          expertise:
            'Synthetic acceptance reviewer with fixture subject expertise.',
          notes:
            'Synthetic fixture instructions, academic suitability and review criteria checked.',
          qualifiedReviewerConfirmed: true,
        },
        201,
      );
}
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const start = Buffer.byteLength(text);
  text +=
    'xref\n0 5\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('');
  text += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
export async function uploadPrivateEvidence(
  page: Page,
  api: Api,
  request: APIRequestContext,
  base: string,
  nodeB: string,
  teacherId: string,
  teacherToken: string,
  adminToken: string,
  studentToken: string,
  screens: string,
) {
  await page.getByRole('button', { name: '4 Experience' }).click();
  const editor = page.locator('sfu-tutor-verification');
  const png = await readFile(
    'apps/frontend/src/assets/brand/sapiovian-mark.png',
  );
  const pdf = pdfFixture();
  await editor.getByRole('combobox').selectOption('identity');
  await editor
    .getByLabel('Upload verification document', { exact: true })
    .setInputFiles({
      name: 'identity-fixture.png',
      mimeType: 'image/png',
      buffer: png,
    });
  await expect(
    editor.getByText('identity · identity-fixture.png', { exact: true }),
  ).toBeVisible();
  await editor.getByRole('combobox').selectOption('qualification');
  await editor
    .getByLabel('Upload verification document', { exact: true })
    .setInputFiles({
      name: 'qualification-fixture.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    });
  await expect(
    editor.getByText('qualification · qualification-fixture.pdf', {
      exact: true,
    }),
  ).toBeVisible();
  await editor.screenshot({
    path: path.join(screens, 'teacher-private-verification.png'),
    style: 'sfu-header{visibility:hidden!important}',
  });
  const app = await api('GET', '/tutor-application/me', teacherToken);
  expect(app.verificationDocuments).toHaveLength(2);
  const identity = app.verificationDocuments.find(
    (d: any) => d.kind === 'identity',
  );
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const url = `/api/v1/tutor-application/me/verification-documents/${identity.id}`;
  expect((await request.get(base + url)).status()).toBe(401);
  expect(
    (await request.get(base + url, { headers: auth(studentToken) })).status(),
  ).toBe(403);
  const other = await login(base, 'teacher.two@example.com', 'Password@12345');
  expect(
    (
      await request.get(base + url, { headers: auth(other.accessToken) })
    ).status(),
  ).toBe(404);
  const owner = await request.get(base + url, { headers: auth(teacherToken) });
  expect(owner.status()).toBe(200);
  expect(await owner.body()).toEqual(png);
  expect(owner.headers()['cache-control']).toContain('no-store');
  expect(owner.headers()['content-disposition']).toContain('attachment');
  const replica = await request.get(
    `${nodeB}/api/v1/admin/tutor-applications/${teacherId}/verification-documents/${identity.id}`,
    { headers: auth(adminToken) },
  );
  expect(replica.status()).toBe(200);
  expect(await replica.body()).toEqual(png);
  await api(
    'POST',
    `/admin/tutor-applications/${teacherId}/verification-documents/${app.verificationDocuments.find((d: any) => d.kind === 'qualification').id}/review`,
    adminToken,
    {
      decision: 'verified',
      note: 'Synthetic qualification evidence reviewed and checked.',
    },
    400,
  );
  const invalid = await request.post(
    `${base}/api/v1/tutor-application/me/verification-documents/identity`,
    {
      headers: auth(teacherToken),
      multipart: {
        file: {
          name: 'bad.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 not a readable document %%EOF'),
        },
      },
    },
  );
  expect(invalid.status()).toBe(400);
  const connection = await mongoose
    .createConnection(process.env.MONGODB_URI!)
    .asPromise();
  try {
    const user = await connection
      .db!.collection('users')
      .findOne({ _id: new mongoose.Types.ObjectId(teacherId) });
    const stored = user!.tutorVerificationDocuments.find(
      (d: any) => d.id === identity.id,
    );
    const file = path.join(
      process.env.TUTOR_VERIFICATION_LOCAL_PATH!,
      teacherId,
      stored.fileName,
    );
    const encrypted = await readFile(file);
    expect(encrypted.subarray(0, 8)).not.toEqual(png.subarray(0, 8));
    expect((await stat(file)).mode & 0o077).toBe(0);
    const altered = Buffer.from(encrypted);
    altered[altered.length - 1] ^= 1;
    await writeFile(file, altered);
    try {
      expect(
        (
          await request.get(base + url, { headers: auth(teacherToken) })
        ).status(),
      ).toBe(503);
    } finally {
      await writeFile(file, encrypted);
    }
    const extra = await request.post(
      `${base}/api/v1/tutor-application/me/verification-documents/safeguarding`,
      {
        headers: auth(teacherToken),
        multipart: {
          file: {
            name: 'retention-fixture.png',
            mimeType: 'image/png',
            buffer: png,
          },
        },
      },
    );
    expect(extra.status()).toBe(201);
    const extraBody = await extra.json();
    const expired = extraBody.data ?? extraBody;
    await connection.db!.collection('users').updateOne(
      {
        _id: new mongoose.Types.ObjectId(teacherId),
        'tutorVerificationDocuments.id': expired.id,
      },
      {
        $set: {
          'tutorVerificationDocuments.$.expiresAt': new Date(
            Date.now() - 60000,
          ).toISOString(),
        },
      },
    );
    await expect
      .poll(
        async () => {
          const current = await api(
            'GET',
            '/tutor-application/me',
            teacherToken,
          );
          return Boolean(
            current.verificationDocuments.find((d: any) => d.id === expired.id)
              ?.purgedAt,
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect(
      (
        await request.get(
          base +
            `/api/v1/tutor-application/me/verification-documents/${expired.id}`,
          { headers: auth(teacherToken) },
        )
      ).status(),
    ).toBe(404);
    await api(
      'DELETE',
      `/tutor-application/me/verification-documents/${expired.id}`,
      teacherToken,
    );
  } finally {
    await connection.close();
  }
}
export async function reviewPrivateEvidence(
  api: Api,
  adminPage: Page,
  teacherId: string,
  teacherToken: string,
  adminToken: string,
  screens: string,
) {
  const app = await api('GET', '/tutor-application/me', teacherToken);
  for (const doc of app.verificationDocuments) {
    const section = adminPage.locator(`[data-verification-id='${doc.id}']`);
    const download = adminPage.waitForEvent('download');
    await section.getByRole('button', { name: 'Download for review' }).click();
    await download;
    await section
      .getByLabel('Verification findings')
      .fill(
        'Synthetic evidence inspected and verified for the acceptance fixture.',
      );
    await section
      .getByRole('button', { name: 'Mark verified', exact: true })
      .click();
    await expect(
      section.getByText('Status: verified', { exact: true }),
    ).toBeVisible();
  }
  await adminPage
    .locator('.catalog-editor')
    .screenshot({ path: path.join(screens, 'admin-private-verification.png') });
  const verified = await api('GET', '/tutor-application/me', teacherToken);
  expect(verified.status).toBe('submitted');
  expect(
    verified.verificationDocuments.every((d: any) => d.status === 'verified'),
  ).toBe(true);
}
export async function verifyNoticesAndReadiness(
  api: Api,
  page: Page,
  request: APIRequestContext,
  base: string,
  teacherToken: string,
  adminToken: string,
  studentToken: string,
  smtp: Awaited<ReturnType<typeof startLocalSmtpSink>>,
  screens: string,
) {
  const notices = await api('GET', '/tutor-application/notices', teacherToken);
  expect(notices.some((n: any) => n.status === 'submitted')).toBe(true);
  expect(notices.some((n: any) => n.status === 'approved')).toBe(true);
  expect(new Set(notices.map((n: any) => n.id)).size).toBe(notices.length);
  await page.getByRole('button', { name: 'Application updates' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Application notifications' })
      .getByText('Teaching profile approved', { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole('region', { name: 'Application notifications' }).screenshot({path: path.join(screens, 'teacher-application-updates.png')});
  await page
    .getByRole('button', { name: 'Mark read', exact: true })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await api('GET', '/tutor-application/notices', teacherToken)).filter(
          (n: any) => n.readAt,
        ).length,
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Application updates' }).click();
  expect(smtp.failures()).toBe(1);
  await expect
    .poll(
      () =>
        smtp.messages.some((m) => m.subject.includes('Application received')),
      { timeout: 45000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        smtp.messages.some((m) =>
          m.subject.includes('Teaching profile approved'),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect
    .poll(() => smtp.messages.length, { timeout: 45000 })
    .toBe(notices.length);
  await api(
    'GET',
    '/admin/tutor-onboarding/readiness',
    studentToken,
    undefined,
    403,
  );
  const report = await api(
    'GET',
    '/admin/tutor-onboarding/readiness',
    adminToken,
  );
  expect(report.checks.encryptedVerificationStorage).toBe(true);
  expect(report.checks.documentValidator).toBe(true);
  expect(report.checks.smtpTransport).toBe(true);
  const result = await promisify(execFile)(
    process.execPath,
    [
      'scripts/tutor-onboarding-readiness.cjs',
      '--base-url',
      base,
      '--output',
      path.join(screens, 'onboarding-readiness.json'),
    ],
    {
      env: { ...process.env, TUTOR_READINESS_ADMIN_TOKEN: adminToken },
      encoding: 'utf8',
      timeout: 35000,
    },
  ).catch((error: any) => {
    if (error.code === 2) return { stdout: error.stdout, stderr: error.stderr };
    throw error;
  });
  const cli = JSON.parse(result.stdout);
  expect(cli.checks.encryptedVerificationStorage).toBe(true);
}

export async function verifyReviewDecisionsAndWithdrawal(
  api: Api,
  teacherId: string,
  teacherToken: string,
  adminToken: string,
) {
  let application = await api('GET', '/tutor-application/me', teacherToken);
  await api('PATCH', '/profile/me', teacherToken, {
    availability:
      application.profile.availability + ' Additional pilot availability.',
  });
  const submit = async () => {
    application = await api('GET', '/tutor-application/me', teacherToken);
    return api(
      'POST',
      '/tutor-application/submit',
      teacherToken,
      {
        revision: application.revision,
        adultTutorConfirmed: true,
        codeOfConductAccepted: true,
        safeguardingAccepted: true,
      },
      201,
    );
  };
  for (const decision of ['changes_requested', 'rejected']) {
    application = await submit();
    await api(
      'POST',
      `/admin/tutor-applications/${teacherId}/review`,
      adminToken,
      {
        decision,
        revision: application.revision,
        note: 'Synthetic decision fixture: specific teaching improvements requested.',
      },
      201,
    );
    const notices = await api(
      'GET',
      '/tutor-application/notices',
      teacherToken,
    );
    expect(notices[0].status).toBe(decision);
    expect(JSON.stringify(notices)).not.toContain('emailStatus');
    expect(JSON.stringify(notices)).not.toContain(
      'specific teaching improvements',
    );
  }
  application = await submit();
  await api(
    'POST',
    `/admin/tutor-applications/${teacherId}/review`,
    adminToken,
    {
      decision: 'approved',
      revision: application.revision,
      note: 'Synthetic resubmission verified and teaching tasks reviewed.',
      introVideoReviewed: true,
      identityChecked: true,
      teachingSuitabilityChecked: true,
      safeguardingChecked: true,
      assessmentResults: application.requiredAssessments.map((task: any) => ({
        categoryId: task.categoryId,
        levelId: task.levelId,
        taskVersion: task.taskVersion,
        version: task.version,
        passed: true,
        notes: 'Synthetic teaching answer meets the selected academic stage.',
      })),
    },
    201,
  );
  const published = await api(
    'GET',
    `/teachers/${teacherId}/profile`,
    undefined,
  );
  expect(published.verificationDocuments).toBeUndefined();
  const identity = application.verificationDocuments.find(
    (doc: any) => doc.kind === 'identity',
  );
  await api(
    'DELETE',
    `/tutor-application/me/verification-documents/${identity.id}`,
    teacherToken,
  );
  application = await api('GET', '/tutor-application/me', teacherToken);
  expect(application.status).toBe('draft');
  expect(application.missing.join(' ')).toContain('identity document');
  await api('GET', `/teachers/${teacherId}/profile`, undefined, undefined, 404);
  await api(
    'POST',
    '/tutor-application/submit',
    teacherToken,
    {
      revision: application.revision,
      adultTutorConfirmed: true,
      codeOfConductAccepted: true,
      safeguardingAccepted: true,
    },
    400,
  );
}
