import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { localDateTime, utcInstantsForLocal } from '@native-sfu/contracts';
import { login, startAcceptanceStack } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';
import { startLocalSmtpSink } from './helpers/tutor-launch-acceptance';

test('real calendar: batch enrollment, local times, changes, durable mail and class access', async ({
  browser,
  request,
}, info) => {
  test.setTimeout(240000);
  const uri = new URL(process.env.MONGODB_URI!);
  if (
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.pathname !== '/whiteboard_acceptance'
  )
    throw Error('Use the isolated local acceptance database.');
  const connection = await mongoose
    .createConnection(process.env.MONGODB_URI!)
    .asPromise();
  const db = connection.db!;
  for (const name of [
    'batches',
    'batch_schedules',
    'class_sessions',
    'student_enrollments',
    'class_notices',
  ])
    await db.collection(name).deleteMany({});
  const smtp = await startLocalSmtpSink();
  const stack = await startAcceptanceStack({
    frontendPort: 4484,
    backendPort: 3384,
    secondBackendPort: 3386,
    localSmtpPort: smtp.port,
  }).catch(async (e) => {
    await connection.close();
    await smtp.close();
    throw e;
  });
  const contexts: any[] = [];
  const screens = process.env.CALENDAR_UI_OUTPUT || info.outputPath('ui');
  await mkdir(screens, { recursive: true });
  try {
    const teacher = await login(
      stack.nodeAUrl,
      'teacher.one@example.com',
      'Password@12345',
    );
    const student = await login(
      stack.nodeAUrl,
      'student.one@example.com',
      'Password@12345',
    );
    const otherTeacher = await login(
      stack.nodeAUrl,
      'teacher.two@example.com',
      'Password@12345',
    );
    const studentDoc = await db
      .collection('users')
      .findOne({ email: 'student.one@example.com' });
    const { _id, ...studentCopy } = studentDoc!;
    for (const email of [
      'calendar-student-two@example.com',
      'calendar-student-three@example.com',
    ])
      await db.collection('users').updateOne(
        { email },
        {
          $set: {
            ...studentCopy,
            email,
            displayName: 'Calendar Student',
            name: 'Calendar Student',
          },
        },
        { upsert: true },
      );
    const studentTwo = await login(
      stack.nodeAUrl,
      'calendar-student-two@example.com',
      'Password@12345',
    );
    const studentThree = await login(
      stack.nodeAUrl,
      'calendar-student-three@example.com',
      'Password@12345',
    );
    const api = async (
      method: string,
      url: string,
      data?: any,
      status = 200,
      token = teacher.accessToken,
      base = stack.nodeAUrl,
    ) => {
      const response = await request.fetch(`${base}/api/v1${url}`, {
        method,
        data,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      expect(
        response.status(),
        `${method} ${url}: ${await response.text()}`,
      ).toBe(status);
      if (status === 204) return undefined;
      const body = await response.json();
      return body.data ?? body;
    };
    expect((await api('GET', '/calendar/google')).configured).toBe(false);
    await api('GET', '/calendar/google', undefined, 403, student.accessToken);
    await api('POST', '/calendar/google/connect', {}, 503);
    const invalidCallback = await request.get(
      `${stack.nodeAUrl}/api/v1/calendar/google/callback?state=invalid&code=invalid`,
    );
    expect(invalidCallback.status()).toBe(400);
    expect(await invalidCallback.text()).not.toContain('invalid&code');
    const now = new Date();
    const batch = await api(
      'POST',
      '/teacher/batches',
      {
        name: 'Algebra workshop',
        courseName: 'Mathematics',
        year: now.getUTCFullYear(),
        maxCapacity: 1,
        feeAmount: 0,
        scheduleTimezone: 'Europe/Paris',
        schedule: [{ dayOfWeek: 'THURSDAY', startTime: '16:00' }],
      },
      201,
    );
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(start.getTime() + 61 * 86400000);
    const query = `?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
    const classes = await api('GET', '/calendar/classes' + query);
    const item = classes.find(
      (c: any) => Date.parse(c.scheduledAt) > Date.now() + 2 * 86400000,
    );
    expect(item).toBeTruthy();
    expect(item.scheduleTimezone).toBe('Europe/Paris');
    expect(localDateTime(item.scheduledAt, 'Europe/Paris').slice(-5)).toBe(
      '16:00',
    );
    expect(
      await api(
        'GET',
        '/calendar/classes' + query,
        undefined,
        200,
        student.accessToken,
      ),
    ).toEqual([]);
    await api('GET', '/calendar/classes' + query, undefined, 401, '');
    await api(
      'GET',
      '/calendar/classes?from=2026-01-01&to=2027-12-31',
      undefined,
      400,
    );
    await api(
      'GET',
      `/class-sessions/${item.id}?batchId=${batch.id}`,
      undefined,
      403,
      student.accessToken,
    );
    await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      { action: 'cancel', expectedScheduledAt: item.scheduledAt },
      403,
      student.accessToken,
    );
    await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      { action: 'cancel', expectedScheduledAt: item.scheduledAt },
      403,
      otherTeacher.accessToken,
    );
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1600, height: 1100 },
      timezoneId: 'Europe/Paris',
    });
    contexts.push(context);
    await context.addInitScript(
      (token) => sessionStorage.setItem('native-sfu.auth.accessToken', token),
      teacher.accessToken,
    );
    const teacherPage = await context.newPage();
    const errors: string[] = [];
    teacherPage.on('pageerror', (e) => errors.push(e.message));
    teacherPage.on('console', (m) => {
      if (m.type() === 'warning') console.log('Calendar warning:', m.text());
    });
    const studentContext = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 1600, height: 1100 },
      timezoneId: 'Asia/Kolkata',
    });
    contexts.push(studentContext);
    await studentContext.addInitScript(
      (token) => sessionStorage.setItem('native-sfu.auth.accessToken', token),
      student.accessToken,
    );
    const studentPage = await studentContext.newPage();
    studentPage.on('pageerror', (e) => errors.push(e.message));
    await studentPage.goto(
      runtimeUrl(
        stack.frontendBaseUrl,
        stack.nodeAUrl,
        `/student/explore?batchId=${batch.id}`,
      ),
    );
    await expect(
      studentPage.getByRole('heading', {
        name: 'Algebra workshop',
        exact: true,
      }),
    ).toBeVisible();
    await studentPage
      .getByRole('button', { name: 'Enroll', exact: true })
      .click();
    await expect(
      studentPage.getByRole('link', { name: 'Enrolled · View calendar' }),
    ).toBeVisible();
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-batch-enrolled.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('link', { name: 'Enrolled · View calendar' })
      .click();
    await expect(
      studentPage.getByRole('heading', { name: 'Class calendar.' }),
    ).toBeVisible();
    expect(
      (
        await api(
          'GET',
          '/calendar/classes' + query,
          undefined,
          200,
          student.accessToken,
        )
      ).map((c: any) => c.id),
    ).toContain(item.id);
    await api(
      'POST',
      `/student-enrollments/me/batches/${batch.id}`,
      {},
      409,
      student.accessToken,
    );
    await api(
      'POST',
      `/student-enrollments/me/batches/${batch.id}`,
      {},
      409,
      studentTwo.accessToken,
    );
    await expect
      .poll(
        async () =>
          (
            (await api(
              'GET',
              '/calendar/notices',
              undefined,
              200,
              student.accessToken,
            )) as any[]
          ).some((n) => n.title === 'Enrollment confirmed'),
        { timeout: 15000 },
      )
      .toBe(true);
    await expect.poll(() => smtp.failures(), { timeout: 15000 }).toBe(1);

    const notice = (
      await api('GET', '/calendar/notices', undefined, 200, student.accessToken)
    )[0];
    await api(
      'POST',
      `/calendar/notices/${notice.id}/read`,
      {},
      404,
      otherTeacher.accessToken,
    );
    await api(
      'POST',
      `/calendar/notices/${notice.id}/read`,
      {},
      201,
      student.accessToken,
    );
    await teacherPage.goto(
      runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/calendar'),
    );
    await expect(
      teacherPage.getByRole('heading', { name: 'Class calendar.' }),
    ).toBeVisible();
    await teacherPage
      .getByLabel('Choose month')
      .fill(item.scheduledAt.slice(0, 7));
    await expect(teacherPage.locator('[data-class-id]').first()).toBeVisible();
    await teacherPage.locator('h1').click();
    await teacherPage.screenshot({
      path: path.join(screens, `${info.project.name}-teacher-month.png`),
      fullPage: true,
    });
    await teacherPage
      .getByRole('button', { name: 'Week', exact: true })
      .click();
    await expect(
      teacherPage.getByRole('button', { name: 'Week', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(teacherPage.locator('wts-calendar-angular')).toBeVisible();
    await expect(
      teacherPage.locator('wts-calendar-angular [data-calendar-view-engine]'),
    ).toHaveAttribute('data-calendar-view-engine', 'week');
    await expect(
      teacherPage.locator('wts-calendar-angular .week-days'),
    ).not.toHaveCSS('display', 'block');
    await teacherPage
      .getByRole('button', { name: 'Next period', exact: true })
      .click();

    await teacherPage.screenshot({
      path: path.join(screens, `${info.project.name}-teacher-week.png`),
      fullPage: true,
    });
    await teacherPage
      .getByRole('button', { name: 'Month', exact: true })
      .click();
    await teacherPage
      .getByLabel('Choose month')
      .fill(item.scheduledAt.slice(0, 7));
    // Several recurring classes share a clock time. Select the intended calendar day.

    await teacherPage.locator(`[data-class-id="${item.id}"]`).first().click();
    await teacherPage
      .getByRole('button', { name: 'Reschedule', exact: true })
      .click();
    const newDay = new Date(Date.parse(item.scheduledAt) + 86400000)
      .toISOString()
      .slice(0, 10);
    const newLocal = newDay + 'T10:30';
    await teacherPage
      .getByLabel('New date and time', { exact: false })
      .fill(newLocal);
    await teacherPage
      .getByLabel('Message to students')
      .fill('We are moving this lesson to Friday morning.');
    await teacherPage.screenshot({
      path: path.join(screens, `${info.project.name}-reschedule.png`),
      fullPage: true,
    });
    await teacherPage
      .getByRole('button', { name: 'Save new time', exact: true })
      .click();
    await expect(teacherPage.locator('.notice[role="status"]')).toContainText(
      'Class rescheduled',
    );
    const changed = (
      await api(
        'GET',
        '/calendar/classes' + query,
        undefined,
        200,
        student.accessToken,
        stack.nodeBUrl,
      )
    ).find((c: any) => c.id === item.id);
    expect(changed.scheduledAt).toBe(
      utcInstantsForLocal(newLocal, 'Europe/Paris')[0],
    );
    expect(changed.originalScheduledAt).toBe(item.scheduledAt);
    await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      { action: 'cancel', expectedScheduledAt: item.scheduledAt },
      409,
    );
    await expect
      .poll(
        async () =>
          (
            (await api(
              'GET',
              '/calendar/notices',
              undefined,
              200,
              student.accessToken,
            )) as any[]
          ).some((n) => n.title === 'Class rescheduled'),
        { timeout: 15000 },
      )
      .toBe(true);
    await studentPage.reload();
    await studentPage.getByLabel('Choose month').fill(newDay.slice(0, 7));
    await studentPage
      .getByLabel('Timezone', { exact: true })
      .fill('Asia/Kolkata');
    await studentPage
      .getByRole('button', { name: 'Save timezone', exact: true })
      .click();
    await expect(studentPage.locator('.timezone-bar')).toContainText(
      'Asia/Kolkata',
    );

    await studentPage.locator(`[data-class-id="${item.id}"]`).first().click();
    await expect(studentPage.locator('.detail-card').first()).toContainText(
      '15:00',
    );
    await expect(
      studentPage.getByRole('button', { name: 'Reschedule', exact: true }),
    ).toHaveCount(0);
    await expect(
      studentPage.getByRole('button', { name: 'Join classroom', exact: true }),
    ).toHaveCount(0);
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-student-calendar.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('button', { name: 'Class notifications', exact: true })
      .click();
    await expect(
      studentPage.getByRole('region', { name: 'Class notifications' }),
    ).toContainText('Class rescheduled');
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-notifications.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('button', { name: 'Class notifications', exact: true })
      .click();
    await studentPage
      .getByRole('button', { name: 'Switch to dark mode', exact: true })
      .click();
    await expect(studentPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
    await expect(studentPage.locator('h1')).toHaveCSS(
      'color',
      'rgb(237, 244, 237)',
    );
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-student-dark.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('button', { name: 'Switch to light mode', exact: true })
      .click();
    await expect(studentPage.locator('html')).toHaveAttribute(
      'data-theme',
      'light',
    );
    await expect(studentPage.locator('h1')).toHaveCSS(
      'color',
      'rgb(33, 54, 45)',
    );
    await studentPage.setViewportSize({ width: 390, height: 844 });
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-student-mobile.png`),
      fullPage: true,
    });
    expect(
      await studentPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Shared desktop routes render in a headless browser; Electron is never launched.
    await studentPage.setViewportSize({ width: 1500, height: 1000 });
    await studentPage.goto(
      runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/desktop/calendar'),
    );
    await expect(
      studentPage.getByRole('heading', { name: 'Class calendar.' }),
    ).toBeVisible();
    await expect(
      studentPage
        .getByRole('link', { name: 'Explore batches', exact: true })
        .first(),
    ).toBeVisible();
    await studentPage.screenshot({
      path: path.join(screens, `${info.project.name}-desktop-calendar.png`),
      fullPage: true,
    });
    await studentPage
      .getByRole('link', { name: 'Explore batches', exact: true })
      .first()
      .click();
    await expect(
      studentPage.getByRole('heading', {
        name: 'Explore classes',
        exact: true,
      }),
    ).toBeVisible();
    // DST validation is enforced by the real API, including repeated autumn clock times.
    await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      {
        action: 'reschedule',
        expectedScheduledAt: changed.scheduledAt,
        localTime: '2027-03-28T02:30',
        timeZone: 'Europe/Berlin',
      },
      400,
    );
    await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      {
        action: 'reschedule',
        expectedScheduledAt: changed.scheduledAt,
        localTime: '2027-10-31T02:30',
        timeZone: 'Europe/Berlin',
      },
      400,
    );
    const cancelled = await api(
      'PATCH',
      `/calendar/batches/${batch.id}/classes/${item.id}`,
      {
        action: 'cancel',
        expectedScheduledAt: changed.scheduledAt,
        reason: 'This session is cancelled. The rest of the batch continues.',
      },
    );
    expect(cancelled.status).toBe('cancelled');
    await expect
      .poll(
        async () =>
          (
            (await api(
              'GET',
              '/calendar/notices',
              undefined,
              200,
              student.accessToken,
            )) as any[]
          ).some((n) => n.title === 'Class cancelled'),
        { timeout: 15000 },
      )
      .toBe(true);
    await api(
      'POST',
      `/class-sessions/${item.id}/start`,
      { batchId: batch.id },
      400,
    );
    // Email/Google links preserve the intended classroom through a fresh login.
    for (const role of ['teacher', 'student']) {
      const fresh = await browser.newContext();
      contexts.push(fresh);
      const linked = await fresh.newPage();
      await linked.goto(
        runtimeUrl(
          stack.frontendBaseUrl,
          stack.nodeAUrl,
          `/class-session/${role}?sessionId=${item.id}&batchId=${batch.id}`,
        ),
      );
      await expect(linked).toHaveURL(new RegExp(`/${role}/login`));
      await linked
        .getByLabel('Email', { exact: true })
        .fill(
          role === 'teacher'
            ? 'teacher.one@example.com'
            : 'student.one@example.com',
        );
      await linked
        .getByLabel('Password', { exact: true })
        .fill('Password@12345');
      await linked.getByRole('button', { name: 'Log in', exact: true }).click();
      await expect.poll(()=>new URL(linked.url()).pathname).toBe(`/class-session/${role}`);
      expect(new URL(linked.url()).searchParams.get('sessionId')).toBe(item.id);
      await linked.close();
    }
    // Simultaneous requests to two backend nodes cannot overbook the last place.
    const raceBatch = await api(
      'POST',
      '/teacher/batches',
      {
        name: 'One-place seminar',
        year: now.getUTCFullYear(),
        maxCapacity: 1,
        feeAmount: 0,
        scheduleTimezone: 'UTC',
        schedule: [{ dayOfWeek: 'MONDAY', startTime: '09:00' }],
      },
      201,
    );
    const races = await Promise.all([
      request.post(
        `${stack.nodeAUrl}/api/v1/student-enrollments/me/batches/${raceBatch.id}`,
        { headers: { Authorization: `Bearer ${studentTwo.accessToken}` } },
      ),
      request.post(
        `${stack.nodeBUrl}/api/v1/student-enrollments/me/batches/${raceBatch.id}`,
        { headers: { Authorization: `Bearer ${studentThree.accessToken}` } },
      ),
    ]);
    expect(races.map((r) => r.status()).sort()).toEqual([201, 409]);
    expect(
      await db
        .collection('student_enrollments')
        .countDocuments({ batchId: raceBatch.id, status: 'active' }),
    ).toBe(1);
    // A due reminder uses the real SMTP sink; stale/cancelled/removal jobs are discarded.
    const liveId = `calendar-live-${randomUUID()}`;
    const future = new Date(Date.now() + 60 * 60000 - 2000);
    await db.collection('class_sessions').insertOne({
      _id: liveId as any,
      batchId: batch.id,
      teacherId: String(
        (await db.collection('batches').findOne({ _id: batch.id }))!.teacherId,
      ),
      title: 'A class starting soon',
      sessionNumber: 999,
      scheduledAt: future,
      durationMinutes: 60,
      status: 'scheduled',
      roomId: `classroom:${liveId}`,
      chatChannelId: `chat:${liveId}`,
      whiteboardChannelId: `board:${liveId}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .collection('student_enrollments')
      .updateMany(
        { batchId: batch.id },
        { $set: { enrolledAt: new Date(Date.now() - 2 * 3600000) } },
      );
    await expect
      .poll(
        () =>
          smtp.messages.filter((m) => m.subject.includes('Class in one hour'))
            .length,
        { timeout: 20000 },
      )
      .toBe(2);
    const reminders = await db
      .collection('class_notices')
      .find({ sessionId: liveId, kind: 'reminder' })
      .toArray();
    expect(reminders).toHaveLength(2);
    for (const kind of ['cancelled', 'moved', 'unenrolled']) {
      const id = `stale-${kind}-${randomUUID()}`;
      await db.collection('class_notices').insertOne({
        _id: id as any,
        userId: String(studentDoc!._id),
        batchId: batch.id,
        sessionId: kind === 'cancelled' ? item.id : liveId,
        kind: 'reminder',
        title: 'Class in one hour',
        body: 'This old reminder must not be sent.',
        scheduledAt: new Date(future.getTime() + 86400000),
        availableAt: new Date(),
        nextAttemptAt: new Date(),
        attempts: 0,
        emailStatus: 'queued',
        createdAt: new Date(),
      });
    }
    await expect
      .poll(
        () =>
          db
            .collection('class_notices')
            .countDocuments({ _id: /^stale-/, emailStatus: 'void' }),
        { timeout: 15000 },
      )
      .toBe(3);
    await api(
      'POST',
      `/class-sessions/${liveId}/start`,
      { batchId: batch.id },
      201,
    );
    const joined = await api(
      'POST',
      `/class-sessions/${liveId}/join`,
      { batchId: batch.id },
      201,
      student.accessToken,
    );
    expect(joined.canJoin).toBe(true);
    await api(
      'DELETE',
      `/student-enrollments/me/batches/${batch.id}`,
      undefined,
      200,
      student.accessToken,
    );
    await api(
      'POST',
      `/class-sessions/${liveId}/join`,
      { batchId: batch.id },
      403,
      student.accessToken,
    );
    expect(
      await api(
        'GET',
        '/calendar/classes' + query,
        undefined,
        200,
        student.accessToken,
      ),
    ).toEqual([]);
    await api(
      'POST',
      `/class-sessions/${liveId}/end`,
      { batchId: batch.id },
      201,
    );
    await expect
      .poll(
        async () =>
          (
            (await api(
              'GET',
              '/calendar/notices',
              undefined,
              200,
              student.accessToken,
            )) as any[]
          ).some((n) => n.title === 'Enrollment cancelled'),
        { timeout: 15000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          smtp.messages.filter((m) =>
            m.subject.includes('Enrollment confirmed'),
          ).length >= 1,
        { timeout: 45000 },
      )
      .toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    console.error(stack.getLogs().slice(-20000));
    throw error;
  } finally {
    for (const c of contexts) await c.close();
    await stack.stop();
    await smtp.close();
    await connection.close();
  }
});
