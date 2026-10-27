import { expect, test, chromium, type Page } from '@playwright/test';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startAcceptanceStack, seedClassroom, login, draw, board, elementCount, assertBoardsEqual, classroomState, waitJoined, takeOffline, largeBoard } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';

test.describe('Desktop classroom with the real backend', () => {
  test.setTimeout(900_000);
  test('teacher and student sign in, prepare, collaborate, reconnect and replay a real recorded lesson', async ({ browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Desktop shares the Chromium classroom runtime.');
    const stack = await startAcceptanceStack({ frontendPort: 4450, backendPort: 3350 });
    const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    const teacherContext = await browser.newContext({ viewport: { width: 1680, height: 1100 }, permissions: ['camera', 'microphone'] });
    const studentContext = await browser.newContext({ viewport: { width: 1680, height: 1100 }, permissions: ['camera', 'microphone'] });
    const teacher = await teacherContext.newPage(); const student = await studentContext.newPage();
    teacher.setDefaultTimeout(25_000); student.setDefaultTimeout(25_000);
    const fixture = await seedClassroom();
    const evidence: Array<Record<string, unknown>> = [{ step: 'real stack', frontend: stack.frontendBaseUrl, backend: stack.nodeAUrl, fixture, mockedApis: false, mediaDevices: 'Chromium synthetic camera and microphone' }];
    let teacherToken = ''; let studentToken = ''; let recordingId = ''; let playbackUrl = ''; let materialTitle = '';
    for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
      page.on('pageerror', (error) => evidence.push({ type: 'pageerror', role, message: error.message }));
      page.on('response', async (response) => { if (response.status() >= 400) evidence.push({ type: 'http', role, method: response.request().method(), status: response.status(), url: response.url().split('?ticket=')[0], body: (await response.text().catch(() => '')).slice(0, 1200) }); });
    }
    const api = async (token: string, path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${stack.nodeAUrl}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      expect(response.ok, `${method} ${path}: ${response.status} ${text}`).toBeTruthy();
      const value = text ? JSON.parse(text) : null; return value?.data ?? value;
    };
    try {
      await step('teacher and student use the actual desktop login screen', async () => {
        teacherToken = await uiLogin(teacher, 'teacher.one@example.com');
        studentToken = await uiLogin(student, 'student.one@example.com');
        for (const page of [teacher, student]) await expect(page.getByRole('heading', { name: 'Upcoming classes', exact: true })).toBeVisible();
        const studentCard = student.locator('.class-card').filter({ has: student.getByRole('heading', { name: 'Whiteboard classroom acceptance', exact: true }) }).last();
        await expect(studentCard).toContainText('Waiting for teacher');
        await teacher.screenshot({ path: testInfo.outputPath('teacher-upcoming.png'), fullPage: true });
        await student.reload();
        await expect(student.getByRole('heading', { name: 'Upcoming classes', exact: true })).toBeVisible();
      });
      await step('generated schedules and rescheduling appear without pre-created session records', async () => {
        const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
        const dayOfWeek = days[(new Date().getDay() + 1) % 7];
        const batch = await api(teacherToken, '/teacher/batches', 'POST', { name: `Desktop schedule ${Date.now()}`, year: new Date().getFullYear(), maxCapacity: 5, schedule: [{ dayOfWeek, startTime: '12:00' }] });
        const batchId = batch.id;
        expect(batchId).toBeTruthy();
        const planned = (await api(teacherToken, '/desktop/classes')).items.find((item: any) => item.batchId === batchId);
        expect(planned).toBeTruthy();
        expect((await api(teacherToken, `/desktop/classes/${planned.sessionId}`)).role).toBe('teacher');
        await api(teacherToken, `/teacher/batches/${batchId}`, 'PATCH', { schedule: [{ dayOfWeek, startTime: '13:00' }] });
        const moved = await api(teacherToken, `/desktop/classes/${planned.sessionId}`);
        expect(moved.rescheduledAt).toBeTruthy();
        expect(Date.parse(moved.scheduledAt) - Date.parse(moved.originalScheduledAt)).toBe(60 * 60 * 1000);
        await api(teacherToken, `/teacher/batches/${batchId}`, 'DELETE');
      });
      await step('dedicated device setup checks microphone, speakers and private webcam preview', async () => {
        await teacher.getByRole('link', { name: 'Settings', exact: true }).click();
        await teacher.getByRole('link', { name: 'Open device setup', exact: true }).click();
        const preview = teacher.getByLabel('Private webcam preview', { exact: true });
        await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
        for (const label of ['Microphone device', 'Speaker device', 'Webcam device']) await expect(teacher.getByLabel(label, { exact: true })).toBeVisible();
        await teacher.getByLabel('Speaker device', { exact: true }).selectOption('');
        await teacher.getByRole('button', { name: 'Test speakers', exact: true }).click();
        await expect(teacher.getByRole('status')).toContainText('short tone');
        await expect(teacher.getByRole('button', { name: 'Test speakers', exact: true })).toBeEnabled();
        await teacher.getByRole('button', { name: 'Test microphone', exact: true }).click();
        await expect(teacher.getByRole('button', { name: 'Stop microphone test', exact: true })).toBeVisible();
        await expect.poll(() => teacher.getByRole('meter', { name: 'Microphone level' }).getAttribute('value')).not.toBe('0');
        await teacher.screenshot({ path: testInfo.outputPath('teacher-device-setup.png'), fullPage: true });
        await teacher.getByRole('button', { name: 'Stop microphone test', exact: true }).click();
        await teacher.getByRole('button', { name: 'Stop camera preview', exact: true }).click();
        await expect(preview).toHaveCount(0);
        await teacher.getByRole('button', { name: 'Preview camera', exact: true }).click();
        await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
        await teacher.getByRole('link', { name: 'Upcoming classes', exact: true }).click();
        await expect(preview).toHaveCount(0);
      });
      await step('teacher prepares privately then explicitly starts the class', async () => {
        await teacher.locator(`a[href*="sessionId=${fixture.sessionId}"]`).click();
        await expect(teacher.getByRole('button', { name: 'Prepare privately', exact: true })).toBeEnabled();
        await teacher.getByRole('button', { name: 'Use microphone only', exact: true }).click();
        await expect(teacher.getByRole('button', { name: 'Enable camera preview', exact: true })).toBeEnabled();
        expect(await teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).preflightPreviewStream()?.getVideoTracks().length ?? 0)).toBe(0);
        await teacher.getByRole('button', { name: 'Enable camera preview', exact: true }).click();
        await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).preflightPreviewStream()?.getVideoTracks().length ?? 0)).toBe(1);
        await teacher.screenshot({ path: testInfo.outputPath('teacher-preflight.png'), fullPage: true });
        await teacher.getByRole('button', { name: 'Prepare privately', exact: true }).click();
        await expect(teacher.getByText('Private preparation · Students cannot see this board until you start the class.')).toBeVisible();
        await draw(teacher, 0); expect(await elementCount(teacher)).toBe(1);
        expect((await api(studentToken, `/desktop/classes/${fixture.sessionId}`)).status).toBe('scheduled');
        await teacher.getByRole('button', { name: 'Start class', exact: true }).click();
        await expect(teacher.getByRole('button', { name: 'Start Live Class', exact: true })).toBeEnabled();
        await teacher.getByRole('button', { name: 'Start Live Class', exact: true }).click();
        await expect(teacher.locator('.teacher-preflight-backdrop')).toHaveCount(0);
        await waitJoined(teacher, 'teacher');
        await expect.poll(() => elementCount(teacher)).toBe(1);
      });
      await step('student joins the live class and sees the prepared board', async () => {
        await student.getByRole('button', { name: 'Refresh', exact: true }).click();
        await student.locator(`a[href*="sessionId=${fixture.sessionId}"]`).click();
        await expect(student.getByRole('button', { name: 'Join Class', exact: true })).toBeEnabled();
        await student.getByRole('button', { name: 'Join Class', exact: true }).click();
        await waitJoined(student, 'student');
        await student.locator('.student-whiteboard-button').click();
        await assertBoardsEqual(teacher, student);
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
      });
      await step('both classroom settings dialogs preserve live media and room synchronization', async () => {
        await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
        for (const [page, role] of [[teacher, 'teacher'], [student, 'student']] as const) {
          const media = () => page.locator(`sfu-${role}-class-session`).evaluate((element) => {
            const component = (window as any).ng.getComponent(element);
            const streams = [component.webrtc.localStream(), ...component.webrtc.remoteStreams().map((item: any) => item.stream)].filter(Boolean);
            return { roomId: component.session().roomId, tracks: streams.flatMap((stream: MediaStream) => stream.getTracks().map((track) => ({ id: track.id, state: track.readyState }))).sort((a: any, b: any) => a.id.localeCompare(b.id)) };
          });
          await expect.poll(async () => (await media()).tracks.length).toBeGreaterThan(0);
          const before = await media();
          await page.getByRole('button', { name: 'Device setup', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Device setup', exact: true });
          await expect(dialog).toBeVisible();
          await expect.poll(() => dialog.getByLabel('Private webcam preview', { exact: true }).evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
          await page.screenshot({ path: testInfo.outputPath(`${role}-classroom-device-setup.png`), fullPage: true });
          await dialog.getByRole('button', { name: 'Close device setup', exact: true }).click();
          await expect(dialog).toHaveCount(0);
          const after = await media();
          expect(after.roomId).toBe(before.roomId);
          for (const track of before.tracks) expect(after.tracks).toContainEqual({ id: track.id, state: 'live' });
          await waitJoined(page, role);
        }
        await student.locator('.student-whiteboard-button').click();
        await draw(teacher, 0.5); await expect.poll(() => elementCount(student)).toBe(2);
        await assertBoardsEqual(teacher, student);
      });
      await step('teacher starts real composed video and audio recording from the classroom', async () => {
        await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
        await teacher.getByRole('menuitem', { name: 'Start Recording', exact: true }).click();
        await teacher.getByRole('button', { name: 'Start recording', exact: true }).click();
        await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).lessonRecorder.activeId()), { timeout: 30_000 }).not.toBe('');
        recordingId = await teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).lessonRecorder.activeId());
        evidence.push({ step: 'recording started', recordingId });
        await draw(teacher, 1); await expect.poll(() => elementCount(student)).toBe(3);
        await assertBoardsEqual(teacher, student);
      });
      await step('student control and reconnect use the real socket and persistence services', async () => {
        await teacher.getByRole('button', { name: /^Allow .+ to control the whiteboard$/ }).click();
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        await draw(student, 2); await expect.poll(() => elementCount(teacher)).toBe(4);
        await assertBoardsEqual(teacher, student);
        await teacher.getByRole('button', { name: /^Revoke whiteboard control for / }).click();
        await expect(student.locator('.student-whiteboard-drawer')).toHaveCount(0);
        await student.locator('.student-whiteboard-button').click();
        await takeOffline(student, studentContext, 'student');
        await draw(teacher, 3);
        await studentContext.setOffline(false); await waitJoined(student, 'student');
        await assertBoardsEqual(teacher, student);
      });
      await step('private classroom chat recovers after the student reconnects', async () => {
        await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
        const openChat = student.getByTitle('Open class chat', { exact: true }); if (await openChat.isVisible()) await openChat.click();
        const message = `Student reconnected ${Date.now()}`; const reply = `Teacher received ${Date.now()}`;
        await student.locator('sfu-session-chat .chat-composer input[type="text"]').fill(message);
        await student.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(teacher.locator('sfu-session-chat').getByText(message, { exact: true })).toBeVisible({ timeout: 15_000 });
        await teacher.locator('sfu-session-chat .chat-composer input[type="text"]').fill(reply);
        await teacher.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(student.locator('sfu-session-chat').getByText(reply, { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(student.locator('sfu-session-chat').getByText('Join the classroom before loading chat history.', { exact: true })).toHaveCount(0);
        await student.getByRole('button', { name: 'Collapse chat', exact: true }).click();
        await student.locator('.student-whiteboard-button').click();
      });
      await step('large lesson board stays synchronized in the desktop classroom', async () => {
        await expect.poll(async () => (await classroomState(teacher, 'teacher')).saveState).toBe('saved');
        const path = `/class-sessions/${fixture.sessionId}/whiteboard?batchId=${fixture.batchId}`;
        const existing = await api(teacherToken, path);
        const snapshot = largeBoard(); const started = Date.now();
        await api(teacherToken, path, 'PUT', { batchId: fixture.batchId, snapshot, expectedSnapshotVersion: existing.snapshotVersion, expectedLastOperationSeq: existing.lastOperationSeq ?? 0 });
        await teacher.locator('sfu-teacher-class-session').evaluate(async (element) => { const c = (window as any).ng.getComponent(element); c.loadWhiteboardMemory(c.session(), true); await c.socket.emitAck('whiteboard:refresh', { roomId: c.session().roomId }); });
        await expect.poll(() => elementCount(teacher), { timeout: 30_000 }).toBe(1500);
        await expect.poll(() => elementCount(student), { timeout: 30_000 }).toBe(1500);
        await assertBoardsEqual(teacher, student);
        evidence.push({ step: 'large board', pages: 30, elements: 1500, synchronizedMs: Date.now() - started });
        await teacher.screenshot({ path: testInfo.outputPath('teacher-classroom.png'), fullPage: true });
        await student.screenshot({ path: testInfo.outputPath('student-classroom.png'), fullPage: true });
      });
      await step('recording upload recovers after the teacher loses network access', async () => {
        await takeOffline(teacher, teacherContext, 'teacher');
        await expect(teacher.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
        expect(await elementCount(teacher)).toBe(1500);
        await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate((element) => { const capture = (window as any).ng.getComponent(element).lessonRecorder.capture; return capture ? capture.chunkCount - capture.uploadedCount : 0; }), { timeout: 15_000 }).toBeGreaterThan(0);
        await teacherContext.setOffline(false); await waitJoined(teacher, 'teacher');
        await expect.poll(() => elementCount(teacher), { timeout: 30_000 }).toBe(1500);
        await assertBoardsEqual(teacher, student);
        await draw(teacher, 4); await expect.poll(() => elementCount(student)).toBe(1501);
        await assertBoardsEqual(teacher, student);
        await teacher.locator('sfu-teacher-class-session').evaluate(async (element) => (window as any).ng.getComponent(element).lessonRecorder.recover());
        await expect.poll(async () => (await api(teacherToken, `/desktop/recordings/${recordingId}/upload`)).chunkCount, { timeout: 30_000 }).toBeGreaterThan(0);
      });
      await step('stopping the recording creates playable indexed WebM on the real backend', async () => {
        await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
        await teacher.getByRole('menuitem', { name: 'Stop Recording', exact: true }).click();
        const stopDialog = teacher.locator('.teacher-confirm-backdrop');
        if (await stopDialog.isVisible()) await stopDialog.locator('.confirm-primary').click();
        await expect.poll(async () => (await api(teacherToken, '/desktop/recordings')).items.find((item: any) => item.recordingId === recordingId)?.status, { timeout: 120_000 }).toBe('available');
        const playback = await api(teacherToken, `/desktop/recordings/${recordingId}/playback`);
        const mediaResponse = await fetch(new URL(playback.playbackUrl, stack.nodeAUrl));
        expect(mediaResponse.status).toBe(200); expect(mediaResponse.headers.get('content-type')).toContain('video/webm');
        const file = testInfo.outputPath('recorded-lesson.webm'); await writeFile(file, Buffer.from(await mediaResponse.arrayBuffer()));
        const probe = await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
        const info = JSON.parse(probe.stdout); expect(info.streams.some((stream: any) => stream.codec_type === 'video')).toBeTruthy(); expect(info.streams.some((stream: any) => stream.codec_type === 'audio')).toBeTruthy(); expect(Number(info.format.duration)).toBeGreaterThan(5);
        evidence.push({ step: 'real recorded media', duration: info.format.duration, bytes: info.format.size, streams: info.streams.map((stream: any) => ({ codec: stream.codec_name, type: stream.codec_type, width: stream.width, height: stream.height })) });
        await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', '-ss', '4', '-i', file, '-frames:v', '1', testInfo.outputPath('recorded-lesson-frame.png')]);
      });
      await step('publication restricts playback and notes to authorized students', async () => {
        const notPublished = await fetch(`${stack.nodeAUrl}/api/v1/desktop/recordings/${recordingId}/playback`, { headers: { authorization: `Bearer ${studentToken}` } }); expect(notPublished.status).toBe(404);
        await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
        await teacher.getByRole('menuitem', { name: 'End for everyone', exact: true }).click();
        await teacher.getByRole('button', { name: 'End session', exact: true }).click();
        await expect(teacher.getByRole('heading', { name: 'Upcoming classes', exact: true })).toBeVisible({ timeout: 40_000 });
        await api(teacherToken, `/class-sessions/${fixture.sessionId}/post-class-workspace/recordings/${recordingId}/publish`, 'POST', { batchId: fixture.batchId });
        await api(teacherToken, `/class-sessions/${fixture.sessionId}/post-class-workspace/whiteboard/publish`, 'POST', { batchId: fixture.batchId });
        const form = new FormData(); form.append('files', new Blob(['Desktop acceptance lesson worksheet.'], { type: 'text/plain' }), 'Lesson worksheet.txt');
        const uploaded = await fetch(`${stack.nodeAUrl}/api/v1/class-sessions/${fixture.sessionId}/materials/upload?batchId=${fixture.batchId}`, { method: 'POST', headers: { authorization: `Bearer ${teacherToken}` }, body: form });
        expect(uploaded.ok).toBeTruthy(); const payload = await uploaded.json(); const material = (payload.data ?? payload)[0]; materialTitle = material.title;
        await api(teacherToken, `/class-sessions/${fixture.sessionId}/post-class-workspace/materials/${material.materialId}/publish`, 'POST', { batchId: fixture.batchId });
        const outsider = await login(stack.nodeAUrl, 'student.two@example.com', 'Password@12345');
        const forbidden = await fetch(`${stack.nodeAUrl}/api/v1/desktop/recordings/${recordingId}/playback`, { headers: { authorization: `Bearer ${outsider.accessToken}` } }); expect(forbidden.status).toBe(403);
      });
      await step('student plays, seeks, changes speed and resumes the published lesson', async () => {
        await student.goto(`${stack.frontendBaseUrl}/desktop/recordings?recordingId=${recordingId}`);
        const video = student.getByLabel('Class recording', { exact: true });
        await expect(video).toBeVisible();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
        await student.getByLabel('Playback speed', { exact: true }).selectOption({ label: '1.5×' });
        expect(await video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
        await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = Math.min(3, element.duration / 3); });
        await expect.poll(async () => (await api(studentToken, `/desktop/recordings/${recordingId}/playback`)).lastPositionSeconds).toBeGreaterThan(1);
        playbackUrl = (await api(studentToken, `/desktop/recordings/${recordingId}/playback`)).playbackUrl;
        const range = await fetch(new URL(playbackUrl, stack.nodeAUrl), { headers: { range: 'bytes=0-127' } }); expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(128);
        await student.reload(); await expect(video).toBeVisible(); await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 30_000 }).toBeGreaterThan(1);
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.seeking)).toBe(false);
        const rendered = await video.evaluate(async (element: HTMLVideoElement) => {
          element.muted = true;
          let callback = 0; let timer: ReturnType<typeof setTimeout> | undefined;
          const decoded = new Promise<VideoFrameCallbackMetadata>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('The recording did not present a decoded video frame.')), 10_000);
            callback = element.requestVideoFrameCallback((_time, metadata) => { clearTimeout(timer); resolve(metadata); });
          });
          let frame: VideoFrameCallbackMetadata;
          try { await element.play(); frame = await decoded; }
          finally { clearTimeout(timer); element.cancelVideoFrameCallback(callback); element.pause(); }
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
          const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let brightness = 0; let lit = 0;
          for (let index = 0; index < pixels.length; index += 4) { const value = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3; brightness += value; if (value > 40) lit++; }
          return { width: element.videoWidth, height: element.videoHeight, readyState: element.readyState, currentTime: element.currentTime, presentedFrames: frame.presentedFrames, mediaTime: frame.mediaTime, meanBrightness: brightness / (pixels.length / 4), litPixelFraction: lit / (pixels.length / 4) };
        });
        expect(rendered.width).toBe(1600); expect(rendered.height).toBe(900);
        expect(rendered.presentedFrames).toBeGreaterThan(0); expect(rendered.meanBrightness).toBeGreaterThan(40); expect(rendered.litPixelFraction).toBeGreaterThan(0.2);
        evidence.push({ step: 'student decoded recording frame', ...rendered });
        await video.screenshot({ path: testInfo.outputPath('student-recording-frame.png') });
        await student.screenshot({ path: testInfo.outputPath('student-recording.png'), fullPage: true });
        const notes = await api(studentToken, `/desktop/recordings/${recordingId}/notes`); expect(notes.snapshot.pages.length).toBe(30);
        await student.getByRole('button', { name: 'View whiteboard notes', exact: true }).click();
        await expect(student.getByRole('button', { name: 'Hide whiteboard notes', exact: true })).toBeVisible();
        await expect(student.locator('sfu-whiteboard')).toBeVisible();
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
        const downloadPromise = student.waitForEvent('download');
        await student.getByRole('button', { name: materialTitle, exact: true }).click();
        const download = await downloadPromise; const worksheet = testInfo.outputPath('lesson-worksheet.txt'); await download.saveAs(worksheet);
        expect(await readFile(worksheet, 'utf8')).toBe('Desktop acceptance lesson worksheet.');

        await api(teacherToken, `/class-sessions/${fixture.sessionId}/post-class-workspace/recordings/${recordingId}/unpublish`, 'POST', { batchId: fixture.batchId });
        expect((await fetch(new URL(playbackUrl, stack.nodeAUrl))).status).toBe(404);
        await api(teacherToken, `/class-sessions/${fixture.sessionId}/post-class-workspace/recordings/${recordingId}/publish`, 'POST', { batchId: fixture.batchId });
      });
      await step('deep links preserve the intended class across sign-in and enforce enrollment', async () => {
        const guest = await browser.newContext(); const page = await guest.newPage();
        try {
          const target = `/desktop/join?sessionId=${fixture.sessionId}&batchId=${fixture.batchId}`;
          await page.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/desktop/login') + `&returnUrl=${encodeURIComponent(target)}`);
          await uiLogin(page, 'student.two@example.com', false);
          await expect(page.getByRole('heading', { name: 'Unable to open this class' })).toBeVisible();
          await expect(page.getByRole('alert')).toContainText(/access|allowed|enrolled/i);
        } finally { await guest.close(); }
      });
      expect(evidence.filter((item) => item.type === 'pageerror'), JSON.stringify(evidence.filter((item) => item.type === 'pageerror'))).toHaveLength(0);
    } finally {
      await mkdir(testInfo.outputDir, { recursive: true });
      await writeFile(testInfo.outputPath('desktop-evidence.json'), JSON.stringify(evidence, null, 2));
      await writeFile(testInfo.outputPath('stack.log'), stack.getLogs());
      await Promise.all([teacher.screenshot({ path: testInfo.outputPath('teacher-final.png'), fullPage: true }).catch(() => undefined), student.screenshot({ path: testInfo.outputPath('student-final.png'), fullPage: true }).catch(() => undefined)]);
      await browser.close(); await stack.stop();
    }
    async function uiLogin(page: Page, email: string, navigate = true) {
      if (navigate) await page.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/desktop/login'));
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('Password@12345');
      const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const response = await responsePromise; expect(response.ok()).toBeTruthy(); const payload = await response.json();
      return (payload.data ?? payload).accessToken as string;
    }
    async function step(title: string, action: () => Promise<void>) {
      await test.step(title, async () => { const start = Date.now(); console.info(`Desktop acceptance: ${title}`); try { await action(); evidence.push({ step: title, status: 'passed', ms: Date.now() - start }); } catch (error) { evidence.push({ step: title, status: 'failed', error: String(error) }); throw error; } finally { await mkdir(testInfo.outputDir, { recursive: true }); await writeFile(testInfo.outputPath('desktop-evidence.json'), JSON.stringify(evidence, null, 2)); } });
    }
  });
});
