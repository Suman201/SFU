import { expect, test, chromium, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { startAcceptanceStack, seedClassroom, login, enterTeacherClassroom, enterStudentClassroom, draw, assertBoardsEqual, takeOffline, waitJoined } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';

test('P0 paid learner journey: real login, checkout, media, reconnect, recording, private questions and teacher replies', async ({}, info) => {
  test.setTimeout(420000);
  const recordingDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfu-p0-recordings-'));
  const previousRecording = process.env.RECORDING_LOCAL_PATH;
  process.env.RECORDING_LOCAL_PATH = recordingDirectory;
  let stack: Awaited<ReturnType<typeof startAcceptanceStack>>;
  try { stack = await startAcceptanceStack({ frontendPort: 4498, backendPort: 3398, paymentsEnabled: true }); }
  catch (error) { await rm(recordingDirectory, { recursive: true, force: true }); throw error; }
  finally { if (previousRecording === undefined) delete process.env.RECORDING_LOCAL_PATH; else process.env.RECORDING_LOCAL_PATH = previousRecording; }
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const teacherContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ['camera', 'microphone'] });
  const studentContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ['camera', 'microphone'] });
  for (const context of [teacherContext, studentContext]) await context.addInitScript(() => localStorage.setItem('native-sfu-theme', 'light'));
  const teacher = await teacherContext.newPage(), student = await studentContext.newPage();
  const output = path.resolve(process.env.P0_REPORT_DIR || 'reports/p0'); await mkdir(output, { recursive: true });
  const evidence: any = { environment: 'isolated-local', productionSignoff: false, realBackend: true, realSfu: true, mediaDevices: 'Chromium synthetic camera/microphone', steps: [], passed: false };
  let teacherToken = '', studentToken = '';
  const api = async (token: string, endpoint: string, method = 'GET', body?: any, status?: number) => {
    const response = await fetch(stack.nodeAUrl + '/api/v1' + endpoint, { method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (status !== undefined) expect(response.status, endpoint).toBe(status); else expect(response.ok, endpoint + ': ' + response.status).toBeTruthy();
    const json = await response.json(); return json.data ?? json;
  };
  const step = async (name: string, action: () => Promise<void>) => {
    await test.step(name, async () => { const start = Date.now(); console.info('P0 journey: ' + name); await action(); evidence.steps.push({ name, passed: true, durationMs: Date.now() - start }); await writeFile(path.join(output, 'learning-journey.json'), JSON.stringify(evidence, null, 2)); });
  };
  const uiLogin = async (page: Page, role: string, email: string) => {
    await page.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/' + role + '/login'));
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    const pending = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const response = await pending; expect(response.ok()).toBeTruthy(); const body = await response.json(); return (body.data ?? body).accessToken;
  };
  let fixture: Awaited<ReturnType<typeof seedClassroom>>;
  let recordingId = '';
  try {
    fixture = await seedClassroom({ enrollStudent: false });
    const db = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    try { await db.db!.collection('batches').updateOne({ _id: fixture.batchId as any }, { $set: { feeAmount: 100, feeMinor: 10000, feeCurrency: 'USD' } }); }
    finally { await db.close(); }
    await step('teacher and student log in through the real website', async () => {
      teacherToken = await uiLogin(teacher, 'teacher', 'teacher.one@example.com');
      studentToken = await uiLogin(student, 'student', 'student.one@example.com');
    });
    await step('verified test checkout grants access to the paid class', async () => {
      await api(studentToken, '/student-enrollments/me/batches/' + fixture.batchId, 'POST', {}, 402);
      await student.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/student/explore') + '&batchId=' + fixture.batchId);
      await student.getByRole('button', { name: /^Pay .*enroll$/ }).click();
      await expect(student.getByRole('heading', { name: 'Pay $100.00', exact: true })).toBeVisible();
      await student.getByRole('button', { name: 'Pay with test card', exact: true }).click();
      await expect(student.getByRole('heading', { name: 'Payment received', exact: true })).toBeVisible();
      await expect(student.getByText('You are enrolled in', { exact: false })).toBeVisible();
      await student.screenshot({ path: path.join(output, 'student-paid-enrollment.png'), fullPage: true });
    });
    await step('teacher starts class and the paid student receives real camera frames', async () => {
      await enterTeacherClassroom(teacher, runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/class-session/teacher') + '&sessionId=' + fixture.sessionId + '&batchId=' + fixture.batchId);
      await enterStudentClassroom(student, runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/class-session/student') + '&sessionId=' + fixture.sessionId + '&batchId=' + fixture.batchId);
      await draw(teacher, 0); await assertBoardsEqual(teacher, student);
      await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
      await expect.poll(() => student.locator('video.stage-video').evaluateAll(elements => elements.some(element => { const video = element as HTMLVideoElement; return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0; })), { timeout: 30000 }).toBe(true);
    });
    await step('static shared whiteboard delivers decoded SFU video', async () => {
      await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
      await teacher.getByRole('menuitem', { name: 'Share whiteboard', exact: true }).click();
      await expect.poll(() => student.locator('sfu-student-class-session').evaluate(element => { const c = (window as any).ng.getComponent(element); const video = element.querySelector('video.stage-video') as HTMLVideoElement; return c.stageProducer()?.kind === 'screen' && video?.srcObject === c.stageStream() && video?.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0; }), { timeout: 30000 }).toBe(true);
      // Decoded frames must contain the existing navy ink, not an initial blank frame.
      await expect.poll(() => student.locator('video.stage-video').evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 120 && pixels[i + 2] < 150 && pixels[i + 3] > 200) ink++;
        return ink;
      }), { timeout: 30000 }).toBeGreaterThan(40);
      await teacher.screenshot({ path: path.join(output, 'teacher-live-classroom.png'), fullPage: true });
      await student.screenshot({ path: path.join(output, 'student-live-classroom.png'), fullPage: true });
    });
    const recordingStart = Date.now();
    await step('actual recording and student reconnect preserve the lesson', async () => {
      await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
      await teacher.getByRole('menuitem', { name: 'Start Recording', exact: true }).click();
      await teacher.getByRole('button', { name: 'Start recording', exact: true }).click();
      await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate(element => (window as any).ng.getComponent(element).lessonRecorder.activeId()), { timeout: 30000 }).not.toBe('');
      recordingId = await teacher.locator('sfu-teacher-class-session').evaluate(element => (window as any).ng.getComponent(element).lessonRecorder.activeId());
      await student.locator('.student-whiteboard-button').click();
      await takeOffline(student, studentContext, 'student'); await draw(teacher, 1);
      await studentContext.setOffline(false); await waitJoined(student, 'student'); await assertBoardsEqual(teacher, student);
      await expect.poll(() => Date.now() - recordingStart, { timeout: 15000 }).toBeGreaterThan(7000);
      await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
      await teacher.getByRole('menuitem', { name: 'Stop Recording', exact: true }).click();
      const dialog = teacher.locator('.teacher-confirm-modal[open]'); if (await dialog.isVisible()) await dialog.locator('.confirm-primary').click();
      await expect.poll(async () => (await api(teacherToken, '/desktop/recordings')).items.find((item: any) => item.recordingId === recordingId)?.status, { timeout: 120000 }).toBe('available');
      const playback = await api(teacherToken, '/desktop/recordings/' + recordingId + '/playback');
      const response = await fetch(new URL(playback.playbackUrl, stack.nodeAUrl)); expect(response.ok).toBeTruthy();
      const file = path.join(output, 'recorded-lesson.webm'); await writeFile(file, Buffer.from(await response.arrayBuffer()));
      const probe = await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
      const media = JSON.parse(probe.stdout); expect(media.streams.some((stream: any) => stream.codec_type === 'video')).toBeTruthy(); expect(media.streams.some((stream: any) => stream.codec_type === 'audio')).toBeTruthy(); expect(Number(media.format.duration)).toBeGreaterThan(5);
      evidence.recording = { durationSeconds: Number(media.format.duration), bytes: Number(media.format.size), streams: media.streams.map((stream: any) => stream.codec_type) };
    });
    await step('ending class publishes authorized recording playback', async () => {
      await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
      await teacher.getByRole('menuitem', { name: 'End for everyone', exact: true }).click();
      await teacher.getByRole('button', { name: 'End session', exact: true }).click();
      await expect.poll(async () => (await api(teacherToken, '/class-sessions/' + fixture.sessionId + '?batchId=' + fixture.batchId)).status).toBe('completed');
      await api(teacherToken, '/class-sessions/' + fixture.sessionId + '/post-class-workspace/recordings/' + recordingId + '/publish', 'POST', { batchId: fixture.batchId });
      await student.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/desktop/recordings') + '&recordingId=' + recordingId);
      const video = student.getByLabel('Class recording', { exact: true }); await expect(video).toBeVisible();
      await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
    });
    await step('student asks privately after class and teacher replies through the website', async () => {
      const detail = '/student/classes/completed/' + fixture.sessionId;
      await student.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, detail) + '&batchId=' + fixture.batchId);
      await student.getByPlaceholder('Ask a private follow-up question', { exact: true }).fill('Could you explain the second step of this lesson?');
      await student.getByRole('button', { name: 'Send question', exact: true }).click();
      await expect(student.getByText('Could you explain the second step of this lesson?', { exact: true })).toBeVisible();
      await teacher.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/teacher/dashboard/batches/' + fixture.batchId));
      await teacher.locator('.calendar-month button, .calendar-list-row').filter({ hasText: 'Whiteboard classroom acceptance' }).first().click();
      await teacher.getByRole('button', { name: 'Post-class Q&A', exact: true }).click();
      await teacher.getByPlaceholder('Write a private answer for this student', { exact: true }).fill('Review the second board example and apply the same rule.');
      await teacher.getByRole('button', { name: 'Send reply', exact: true }).click();
      await expect(teacher.locator('.post-class-message-list').getByText('Review the second board example and apply the same rule.', { exact: true })).toBeVisible();
      await student.reload(); await expect(student.getByText('Review the second board example and apply the same rule.', { exact: true })).toBeVisible();
      const outsider = await login(stack.nodeAUrl, 'student.two@example.com', 'Password@12345');
      await api(outsider.accessToken, '/class-sessions/student/completed/' + fixture.sessionId + '?batchId=' + fixture.batchId, 'GET', undefined, 403);
      await api(outsider.accessToken, '/desktop/recordings/' + recordingId + '/playback', 'GET', undefined, 403);
      await student.screenshot({ path: path.join(output, 'student-private-post-class-qna.png'), fullPage: true });
      await teacher.screenshot({ path: path.join(output, 'teacher-private-post-class-qna.png'), fullPage: true });
    });
    evidence.passed = true;
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    await writeFile(path.join(output, 'learning-journey.json'), JSON.stringify(evidence, null, 2));
    await writeFile(info.outputPath('backend-runtime.log'), stack.getLogs());
    await browser.close().catch(() => undefined); await stack.stop(); await rm(recordingDirectory, { recursive: true, force: true });
  }
});
