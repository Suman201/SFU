import { expect, test } from '@playwright/test';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startAcceptanceStack, seedClassroom, login } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';

test('historical private Q&A refreshes both ways, clears read state, and isolates classmates', async ({ browser }, info) => {
  test.setTimeout(180000);
  const stack = await startAcceptanceStack({ frontendPort: 4514, backendPort: 3414 });
  const contexts: any[] = [];
  const output = path.resolve('reports/p1', info.project.name);
  await mkdir(output, { recursive: true });
  try {
    const fixture = await seedClassroom({ batchName: 'P1 acceptance ' + randomUUID() });
    const sessionId = fixture.previousSessionId;
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    let studentId = '', peerId = '', studentName = '', peerName = '';
    try {
      const db = connection.db!;
      const student = await db.collection('users').findOne({ email: 'student.one@example.com' });
      const peer = await db.collection('users').findOne({ email: 'student.two@example.com' });
      studentId = String(student!._id); peerId = String(peer!._id);
      studentName = student!.displayName || student!.name; peerName = peer!.displayName || peer!.name;
      await db.collection('student_enrollments').updateOne({ batchId: fixture.batchId, studentId }, { $set: { status: 'completed', enrolledAt: new Date(Date.now() - 86400000) } });
      await db.collection('student_enrollments').insertOne({ _id: randomUUID() as any, studentId: peerId, studentName: peerName, studentEmail: peer!.email, batchId: fixture.batchId, teacherId: (await db.collection('batches').findOne({ _id: fixture.batchId as any }))!.teacherId, status: 'completed', enrolledAt: new Date(Date.now() - 86400000), createdAt: new Date() });
    } finally { await connection.close(); }
    const teacherAuth = await login(stack.nodeAUrl, 'teacher.one@example.com', 'Password@12345');
    const studentAuth = await login(stack.nodeAUrl, 'student.one@example.com', 'Password@12345');
    const peerAuth = await login(stack.nodeAUrl, 'student.two@example.com', 'Password@12345');
    const outsiderAuth = await login(stack.nodeAUrl, 'student.three@example.com', 'Password@12345');
    const api = async (token: string, endpoint: string, method = 'GET', data?: any, expected?: number) => {
      const response = await fetch(stack.nodeAUrl + '/api/v1' + endpoint, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000) });
      if (expected) expect(response.status, endpoint).toBe(expected); else expect(response.ok, endpoint + ': ' + response.status).toBe(true);
      const body = await response.json(); return body.data ?? body;
    };
    const homework = await api(teacherAuth.accessToken, '/assignments', 'POST', { batchId: fixture.batchId, sessionId, title: 'Historical practice set', instructions: 'Review the worked example.', allowedSubmissionTypes: ['text'] });
    const historicalAssignments = await api(studentAuth.accessToken, '/student/assignments?batchId=' + fixture.batchId + '&sessionId=' + sessionId);
    expect(historicalAssignments.items.some((item: any) => item.assignmentId === homework.assignmentId)).toBe(true);
    expect((await api(studentAuth.accessToken, '/student/assignments/' + homework.assignmentId)).readOnly).toBe(true);
    await api(studentAuth.accessToken, '/student/assignments/' + homework.assignmentId + '/submission', 'POST', { text: 'Must not write after enrollment ended' }, 403);
    await api(outsiderAuth.accessToken, '/student/assignments/' + homework.assignmentId, 'GET', undefined, 403);
    const base = '/class-sessions/' + sessionId;
    const query = '?batchId=' + fixture.batchId;
    const question = 'Please explain my private follow-up question.';
    const peerSecret = 'This separate classmate question must remain private.';
    await api(studentAuth.accessToken, base + '/post-class-chat' + query, 'POST', { message: question });
    await api(peerAuth.accessToken, base + '/post-class-chat' + query, 'POST', { message: peerSecret });
    const createPage = async (token: string, width: number, height: number) => {
      const context = await browser.newContext({ viewport: { width, height } }); contexts.push(context);
      await context.addInitScript(token => sessionStorage.setItem('native-sfu.auth.accessToken', token), token);
      return context.newPage();
    };
    const student = await createPage(studentAuth.accessToken, 390, 844);
    const teacher = await createPage(teacherAuth.accessToken, 1024, 768);
    await student.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/student/classes/completed/' + sessionId) + '&batchId=' + fixture.batchId);
    await student.getByRole('heading', { name: 'Ask the teacher', exact: true }).scrollIntoViewIfNeeded();
    await expect(student.getByText(question, { exact: true })).toBeVisible();
    await expect(student.getByText('Access is restricted', { exact: true })).toHaveCount(0);
    await expect(student.getByText(peerSecret, { exact: true })).toHaveCount(0);
    await teacher.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/teacher/dashboard/batches/' + fixture.batchId));
    await teacher.locator('.calendar-month button, .calendar-list-row').filter({ hasText: 'Previous classroom fixture' }).first().click();
    await teacher.getByRole('button', { name: 'Post-class Q&A', exact: true }).click();
    const threads = teacher.locator('.post-class-thread-list');
    await threads.getByRole('button').filter({ hasText: studentName }).click();
    await expect(teacher.locator('.post-class-message-list').getByText(question, { exact: true })).toBeVisible();
    const reply = 'Review the worked example and tell me which step needs more detail.';
    await teacher.getByPlaceholder('Write a private answer for this student', { exact: true }).fill(reply);
    await teacher.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(student.getByText(reply, { exact: true })).toBeVisible({ timeout: 20000 });
    await student.getByPlaceholder('Ask a private follow-up question', { exact: true }).fill('Thank you. The third step is the one I need.');
    await student.getByRole('button', { name: 'Send question', exact: true }).click();
    await expect(teacher.locator('.post-class-message-list').getByText('Thank you. The third step is the one I need.', { exact: true })).toBeVisible({ timeout: 20000 });
    const unread = async (token: string) => (await api(token, '/class-sessions/student/completed/' + sessionId + query)).chatSummary.studentThread.unreadCount;
    await expect.poll(() => unread(studentAuth.accessToken)).toBe(0);
    await expect.poll(async () => (await api(teacherAuth.accessToken, base + '/post-class-chat/summary' + query)).threads.find((thread: any) => thread.participantId === studentId).unreadCount).toBe(0);
    const roomId = (await api(studentAuth.accessToken, '/class-sessions/student/completed/' + sessionId + query)).chatSummary.roomId;
    const read = await api(studentAuth.accessToken, base + '/chat/read', 'POST', { batchId: fixture.batchId, roomId, scope: 'private', readAt: new Date(0).toISOString() });
    expect(Date.parse(read.lastReadAt)).toBeGreaterThan(0);
    expect(await unread(studentAuth.accessToken)).toBe(0);
    await api(studentAuth.accessToken, base + '/post-class-chat' + query + '&participantId=' + peerId, 'GET', undefined, 403);
    await api(studentAuth.accessToken, base + '/chat/read', 'POST', { batchId: fixture.batchId, roomId, participantId: peerId, scope: 'private' }, 403);
    await api(outsiderAuth.accessToken, base + '/post-class-chat' + query, 'GET', undefined, 403);
    await api(outsiderAuth.accessToken, base + '/chat/read', 'POST', { batchId: fixture.batchId, roomId, scope: 'private' }, 403);
    await threads.getByRole('button').filter({ hasText: peerName }).click();
    await expect(teacher.locator('.post-class-message-list').getByText(peerSecret, { exact: true })).toBeVisible();
    await expect(teacher.locator('.post-class-message-list').getByText(question, { exact: true })).toHaveCount(0);
    await threads.getByRole('button').filter({ hasText: studentName }).click();
    await expect(teacher.locator('.post-class-message-list').getByText(reply, { exact: true })).toBeVisible();
    await expect(teacher.locator('.post-class-message-list').getByText(peerSecret, { exact: true })).toHaveCount(0);
    // Hold a real persisted reply response while the teacher switches away/back.
    // A response from the old selection must not clear the newly typed draft.
    let releaseReply!: () => void, replyPersisted!: () => void;
    const heldReply = new Promise<void>(resolve => { releaseReply = resolve; });
    const persistedReply = new Promise<void>(resolve => { replyPersisted = resolve; });
    const replyPath = '/api/v1/class-sessions/' + sessionId + '/post-class-chat';
    await teacher.route(url => url.pathname === replyPath, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const response = await route.fetch(); replyPersisted(); await heldReply;
      await route.fulfill({ response });
    });
    try {
      await teacher.getByPlaceholder('Write a private answer for this student', { exact: true }).fill('Reply sent before switching threads.');
      await teacher.getByRole('button', { name: 'Send reply', exact: true }).click();
      await persistedReply;
      await threads.getByRole('button').filter({ hasText: peerName }).click();
      await threads.getByRole('button').filter({ hasText: studentName }).click();
      const draft = teacher.getByPlaceholder('Write a private answer for this student', { exact: true });
      await draft.fill('Keep this unsent draft after returning.');
      const resumed = teacher.waitForResponse(response => new URL(response.url()).pathname === replyPath && response.request().method() === 'POST');
      releaseReply(); await (await resumed).finished();
      await teacher.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      await expect(student.getByText('Reply sent before switching threads.', { exact: true })).toBeVisible({ timeout: 20000 });
      await expect(draft).toHaveValue('Keep this unsent draft after returning.');
    } finally { releaseReply(); }
    expect(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await student.screenshot({ path: path.join(output, 'student-qna-mobile.png'), fullPage: true });
    await teacher.screenshot({ path: path.join(output, 'teacher-qna-tablet.png'), fullPage: true });
    const homeworkPage = await createPage(studentAuth.accessToken, 390, 844);
    await homeworkPage.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/student/assignments/' + homework.assignmentId));
    await expect(homeworkPage.getByText('Your enrollment has ended.', { exact: false })).toBeVisible();
    await expect(homeworkPage.getByRole('button', { name: 'Submit assignment', exact: true })).toHaveCount(0);
    await expect(homeworkPage.getByText('Access is restricted', { exact: true })).toHaveCount(0);
    await homeworkPage.screenshot({ path: path.join(output, 'historical-homework-mobile.png'), fullPage: true });

    await writeFile(path.join(output, 'post-class.json'), JSON.stringify({ passed: true, realBackend: true, historicalEnrollment: true, historicalHomeworkReadOnly: true, lateReplyPreservesDraftAcrossThreadSwitches: true, noLiveParticipants: true, bidirectionalRefreshWithoutReload: true, unreadCleared: true, olderReceiptCannotRewind: true, peerAndOutsiderIsolation: true, productionSignoff: false }, null, 2));
  } finally {
    await writeFile(info.outputPath('backend-runtime.log'), stack.getLogs());
    for (const context of contexts) await context.close().catch(() => undefined);
    await stack.stop();
  }
});
