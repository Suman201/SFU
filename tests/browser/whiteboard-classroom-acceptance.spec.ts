import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { runWhiteboardFeatureAcceptance } from './helpers/whiteboard-feature-acceptance';
import { runStudentTurnAcceptance } from './helpers/whiteboard-student-turn-acceptance';
import { createClassroomHarness, board, elementCount, assertBoardsEqual, classroomState, draw, pointerStroke, takeOffline, waitJoined, largeBoard, enterTeacherClassroom, enterStudentClassroom, renameBoardPage, assertRenderedBoard, boardPixelFingerprint, mediaDiagnostics } from './helpers/whiteboard-classroom';

test.describe('Real classroom whiteboard acceptance', () => {
  test.setTimeout(900_000);
  test('teacher and student share drawing, history, pages, permissions and persisted restores', async ({ browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Local classroom acceptance uses Chromium fake camera and microphone.');
    const harness = await createClassroomHarness();
    const { stack, fixture, teacherTokens, teacherContext, studentContext, teacher, student, urlFor } = harness;
    const evidence: Array<Record<string, unknown>> = [{ step: 'fixture', backend: harness.stack.nodeAUrl, materialDirectory: harness.stack.materialDirectory }];
    try {
      for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
        page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { const text = String(payload); if (text.includes('\"ok\":false')) evidence.push({ role, failedSocketAck: text.slice(0, 6000) }); }));
        page.on('pageerror', (error) => evidence.push({ role, error: error.message, stack: error.stack }));
        page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) evidence.push({ role, console: message.text(), location: message.location() }); });
    page.on('response', async (response) => {
      if (response.status() < 400) return;
      const entry = { role, status: response.status(), method: response.request().method(), url: response.url(), body: (await response.text().catch(() => '')).slice(0, 6000) };
      evidence.push(entry);
      await writeFile(testInfo.outputPath('failed-http.json'), JSON.stringify(evidence.filter((item) => item.status), null, 2)).catch(() => undefined);
      if (response.status() >= 500) await writeFile(testInfo.outputPath('backend-errors.log'), harness.stack.getLogs()).catch(() => undefined);
    });
      }
      await step('teacher starts the scheduled class through the actual preflight UI', async () => {
        await enterTeacherClassroom(teacher, urlFor('teacher'));
        evidence.push({ step: 'teacher-joined', state: await classroomState(teacher!, 'teacher') });
      });
      await step('student joins and opens the read-only saved board', async () => {
        await enterStudentClassroom(student, urlFor('student'));
        await assertRenderedBoard(student);
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
      });
      await step('teacher pointer drawing, undo and redo converge on the student', async () => {
        for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
          evidence.push({ step: 'before-first-stroke', role, board: await board(page), memory: await page.locator(`sfu-${role}-class-session`).evaluate((element) => { const c = (window as any).ng.getComponent(element); return c.whiteboardMemoryState?.() ?? c.liveWhiteboardState?.(); }) });
        }
        const pixelsBefore = await boardPixelFingerprint(student);
        await draw(teacher!, 0);
        await expect.poll(() => elementCount(student!), { timeout: 15_000 }).toBe(1);
        await expect.poll(async () => (await boardPixelFingerprint(student)).hash).not.toBe(pixelsBefore.hash);
        evidence.push({ step: 'student-rendered-ink', before: pixelsBefore, after: await boardPixelFingerprint(student) });
        await assertBoardsEqual(teacher!, student!);
        await teacher!.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect.poll(() => elementCount(student!)).toBe(0);
        await teacher!.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect.poll(() => elementCount(student!)).toBe(1);
        await assertBoardsEqual(teacher!, student!);
      });
      await step('page creation and rename are synchronized', async () => {
        await teacher!.getByRole('button', { name: 'Add board page', exact: true }).click();
        await renameBoardPage(teacher, 'Classroom exercise');
        await draw(teacher!, 1);
        await expect.poll(async () => (await board(student!)).pages.length).toBe(2);
        await assertBoardsEqual(teacher!, student!);
      });
      await step('grant control, student draw, lock and revoke enforce permission', async () => {
        const pane = await teacher.locator('.participants-pane').boundingBox();
        if (pane) { await teacher.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2); await teacher.mouse.wheel(0, 550); }
        evidence.push({ step: 'grant-control-layout', boxes: await teacher.locator('.session-sidebar, .participants-pane, .participant-list').evaluateAll((elements) => elements.map((element) => ({ class: element.className, rect: element.getBoundingClientRect().toJSON(), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop, overflowY: getComputedStyle(element).overflowY }))) });
        await teacher!.getByRole('button', { name: /^Allow .+ to control the whiteboard$/ }).click();
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        await draw(student!, 2);
        await expect.poll(() => elementCount(teacher!)).toBe(3);
        await assertBoardsEqual(teacher!, student!);
        await teacher!.getByRole('button', { name: 'Lock board', exact: true }).click();
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
        const locked = await board(student!);
        await pointerStroke(student!, 3);
        expect(await board(student!)).toEqual(locked);
        await teacher!.getByRole('button', { name: 'Unlock board', exact: true }).click();
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        await teacher!.getByRole('button', { name: /^Revoke whiteboard control for / }).click();
        await expect(student.locator('.student-whiteboard-drawer')).toHaveCount(0);
        await student.locator('.student-whiteboard-button').click();
        await expect(student.locator('sfu-whiteboard')).toBeVisible();
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
      });
      await step('closed student drawer receives teacher changes when reopened', async () => {
        await student!.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
        await draw(teacher!, 4);
        await student!.locator('.student-whiteboard-button').click();
        await expect.poll(() => elementCount(student!)).toBe(4);
        await assertBoardsEqual(teacher!, student!);
      });
      await step('student reconnect catches up without another teacher operation', async () => {
        await takeOffline(student!, studentContext, 'student');
        const before = await elementCount(teacher!);
        await draw(teacher!, 6);
        await expect.poll(() => elementCount(teacher!)).toBe(before + 1);
        await studentContext.setOffline(false);
        await waitJoined(student!, 'student');
        await assertBoardsEqual(teacher!, student!);
        evidence.push({ step: 'student-reconnect', count: await elementCount(student!) });
      });
      await step('student reconnect replays active grant and locked state', async () => {
        await teacher.getByRole('button', { name: /^Allow .+ to control the whiteboard$/ }).click();
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        await takeOffline(student, studentContext, 'student');
        await teacher.getByRole('button', { name: 'Lock board', exact: true }).click();
        await studentContext.setOffline(false);
        await waitJoined(student, 'student');
        await expect(student.locator('.student-whiteboard-drawer')).toBeVisible();
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toHaveCount(0);
        await teacher.getByRole('button', { name: 'Unlock board', exact: true }).click();
        await expect(student.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        await assertBoardsEqual(teacher, student);
        await expect.poll(async () => (await classroomState(teacher, 'teacher')).controllerParticipantId).toBe((await classroomState(student, 'student')).localParticipantId);
        await teacher.getByRole('button', { name: /^Revoke whiteboard control for / }).click();
        await expect(student.locator('.student-whiteboard-drawer')).toHaveCount(0);
        await student.locator('.student-whiteboard-button').click();
        await expect(student.locator('sfu-whiteboard')).toBeVisible();
        evidence.push({ step: 'student-locked-reconnect', student: await classroomState(student, 'student') });
      });
      await step('teacher reconnect catches up with permitted student edits', async () => {
        await teacher!.getByRole('button', { name: /^Allow .+ to control the whiteboard$/ }).click();
        await expect(student!.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled();
        const grantedPermission = await teacher.locator('.whiteboard-permission-panel select').inputValue();
        await takeOffline(teacher!, teacherContext, 'teacher');
        const before = await elementCount(student!);
        await draw(student!, 7);
        await expect.poll(() => elementCount(student!)).toBe(before + 1);
        await teacherContext.setOffline(false);
        await waitJoined(teacher!, 'teacher');
        await assertBoardsEqual(teacher!, student!);
        await expect.poll(async () => (await classroomState(teacher, 'teacher')).controllerParticipantId).toBe((await classroomState(student, 'student')).localParticipantId);
        expect((await classroomState(teacher, 'teacher')).controllerPermissionLevel).toBe(grantedPermission);
        await teacher!.getByRole('button', { name: /^Revoke whiteboard control for / }).click();
        await expect(student.locator('.student-whiteboard-drawer')).toHaveCount(0);
        await student.locator('.student-whiteboard-button').click();
        await expect(student.locator('sfu-whiteboard')).toBeVisible();
        evidence.push({ step: 'teacher-reconnect', count: await elementCount(teacher!) });
      });
      await step('checkpoint restore invalidates student state and survives HTTP reload', async () => {
        await teacher!.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
        await expect(teacher!.locator('[aria-label="Saved whiteboard checkpoints"] button').first()).toBeVisible({ timeout: 20_000 });
        const saved = await board(teacher!);
        await teacher!.getByRole('button', { name: 'Checkpoints', exact: true }).click();
        const checkpoint = teacher!.locator('[aria-label="Saved whiteboard checkpoints"] button').first();
        await expect(checkpoint).toBeVisible();
        await draw(teacher!, 5);
        await expect.poll(() => elementCount(student!)).toBe(saved.pages.reduce((n: number, p: any) => n + p.elements.length, 0) + 1);
        await checkpoint.click();
        await expect.poll(() => board(teacher!), { timeout: 20_000 }).toEqual(saved);
        await assertBoardsEqual(teacher!, student!);
        const response = await fetch(`${stack.nodeAUrl}/api/v1/class-sessions/${fixture.sessionId}/whiteboard?batchId=${fixture.batchId}`, { headers: { authorization: `Bearer ${teacherTokens.accessToken}` } });
        expect(response.ok).toBeTruthy();
        const persisted = (await response.json()).data;
        evidence.push({ step: 'persisted-restore', persisted });
        expect(persisted.snapshot).toEqual(saved);
      });
      await step('previous completed-class board restores through the teacher UI', async () => {
        const current = await board(teacher);
        const sourcePage = { ...current.pages[0], id: `previous-${fixture.previousSessionId}`, title: 'Previous lesson review', tags: ['previous-class'], order: 0 };
        const source = { schemaVersion: 1, activePageId: sourcePage.id, pages: [sourcePage] };
        const headers = { authorization: `Bearer ${teacherTokens.accessToken}`, 'content-type': 'application/json' };
        const seed = await fetch(`${stack.nodeAUrl}/api/v1/class-sessions/${fixture.previousSessionId}/whiteboard`, { method: 'PUT', headers, body: JSON.stringify({ batchId: fixture.batchId, snapshot: source, expectedSnapshotVersion: 0, expectedLastOperationSeq: 0 }) });
        expect(seed.ok, await seed.text()).toBeTruthy();
        await teacher.getByRole('button', { name: 'Previous boards', exact: true }).click();
        await teacher.locator('[aria-label="Previous session boards"]').getByRole('button', { name: /Previous classroom fixture/ }).click();
        await expect.poll(() => board(teacher), { timeout: 20_000 }).toEqual(source);
        await assertBoardsEqual(teacher, student);
        const persisted = await (await fetch(`${stack.nodeAUrl}/api/v1/class-sessions/${fixture.sessionId}/whiteboard?batchId=${fixture.batchId}`, { headers })).json();
        expect(persisted.data.snapshot).toEqual(source);
        evidence.push({ step: 'previous-class-restore', sourceSessionId: fixture.previousSessionId, pageId: sourcePage.id });
      });
      await step('large board persists and loads across both live clients and a student reload', async () => {
        await expect.poll(async () => (await classroomState(teacher!, 'teacher')).saveState).toBe('saved');
        const endpoint = `${stack.nodeAUrl}/api/v1/class-sessions/${fixture.sessionId}/whiteboard?batchId=${fixture.batchId}`;
        const headers = { authorization: `Bearer ${teacherTokens.accessToken}`, 'content-type': 'application/json' };
        const previous = (await (await fetch(endpoint, { headers })).json()).data;
        const snapshot = largeBoard();
        const start = Date.now();
        const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ batchId: fixture.batchId, snapshot, expectedSnapshotVersion: previous.snapshotVersion, expectedLastOperationSeq: previous.lastOperationSeq ?? 0 }) });
        expect(response.ok, await response.text()).toBeTruthy();
        const putMs = Date.now() - start;
        const loadStart = Date.now();
        // The authenticated refresh signal is the same mechanism used by restore.
        await teacher!.locator('sfu-teacher-class-session').evaluate(async (element) => {
          const c = (window as any).ng.getComponent(element);
          c.loadWhiteboardMemory(c.session(), true);
          await c.socket.emitAck('whiteboard:refresh', { roomId: c.session().roomId });
        });
        const triggerAckMs = Date.now() - loadStart;
        const [teacherReadyMs, studentReadyMs] = await Promise.all([
          expect.poll(() => elementCount(teacher), { timeout: 20_000 }).toBe(1500).then(() => Date.now() - loadStart),
          expect.poll(() => elementCount(student), { timeout: 20_000 }).toBe(1500).then(() => Date.now() - loadStart)
        ]);
        const equalityStart = Date.now();
        await assertBoardsEqual(teacher, student);
        const equalityVerificationMs = Date.now() - equalityStart;
        await assertRenderedBoard(student);
        await expect.poll(async () => (await boardPixelFingerprint(student)).fixtureInkPixels).toBeGreaterThan(100);
        const synchronizedMs = Date.now() - start;
        const reloadStart = Date.now();
        await student!.reload();
        await student!.getByRole('button', { name: 'Join Class', exact: true }).click();
        await expect(student!.locator('.student-whiteboard-button')).toBeVisible({ timeout: 30_000 });
        await student!.locator('.student-whiteboard-button').click();
        await expect.poll(() => elementCount(student!), { timeout: 20_000 }).toBe(1500);
        const reloadReadyMs = Date.now() - reloadStart;
        await assertBoardsEqual(teacher!, student!);
        await assertRenderedBoard(student);
        await expect.poll(async () => (await boardPixelFingerprint(student)).fixtureInkPixels).toBeGreaterThan(100);
        await draw(teacher!, 8);
        await expect.poll(() => elementCount(student!), { timeout: 15_000 }).toBe(1501);
        await assertBoardsEqual(teacher!, student!);
        evidence.push({ step: 'large-board', bytes: Buffer.byteLength(JSON.stringify(snapshot)), pages: 30, strokes: 1500, synchronizedMs, putMs, triggerAckMs, teacherReadyMs, studentReadyMs, equalityVerificationMs, reloadReadyMs, renderedPixels: await boardPixelFingerprint(student), finalElementCount: await elementCount(student!) });
      });
      await assertRenderedBoard(teacher);
      await assertRenderedBoard(student);
      await expect(student.getByText('Join to watch teacher media.', { exact: true })).toHaveCount(0);
      expect(evidence.filter((entry) => entry.error || Number(entry.status) >= 500), 'No unexpected browser exceptions or backend failures').toEqual([]);
      await teacher!.screenshot({ path: testInfo.outputPath('teacher-classroom.png'), fullPage: true });
      await student!.screenshot({ path: testInfo.outputPath('student-classroom.png'), fullPage: true });


      evidence.push({ step: 'final', teacher: await classroomState(teacher!, 'teacher'), student: await classroomState(student!, 'student'), canonicalBoardSha256: createHash('sha256').update(JSON.stringify(await board(teacher!))).digest('hex'), pages: (await board(teacher!)).pages.length, elementCount: await elementCount(teacher!) });
    } catch (error) {
      for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
        if (page && !page.isClosed()) {
          await page.screenshot({ path: testInfo.outputPath(`${role}-failure.png`), fullPage: true }).catch(() => undefined);
          evidence.push({ role, classroom: await classroomState(page, role).catch(() => null), body: (await page.locator('body').innerText().catch(() => '')).slice(-14_000) });
        }
      }
      throw error;
    } finally {
      await writeFile(testInfo.outputPath('runtime-stack.log'), stack.getLogs());
      await writeFile(testInfo.outputPath('classroom-evidence.json'), JSON.stringify(evidence, null, 2));
      await testInfo.attach('classroom-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      await harness.close();
    }

  });
});

async function step(name: string, body: () => Promise<void>) {
  console.info(`Classroom acceptance: ${name}`);
  await test.step(name, body);
}

test('every exposed whiteboard feature works in an actual teacher/student classroom', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Classroom acceptance uses Chromium fake camera and microphone.');
  test.setTimeout(900_000);
  const harness = await createClassroomHarness();
  const { teacher, student, urlFor } = harness;
  const evidence: Array<Record<string, unknown>> = [{ step: 'fixture', backend: harness.stack.nodeAUrl, materialDirectory: harness.stack.materialDirectory }];
  for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
    page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { const text = String(payload); if (text.includes('\"ok\":false')) evidence.push({ role, failedSocketAck: text.slice(0, 6000) }); }));
        page.on('pageerror', (error) => evidence.push({ role, error: error.message, stack: error.stack }));
    page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) evidence.push({ role, console: message.text(), location: message.location() }); });
    page.on('response', async (response) => {
      if (response.status() < 400) return;
      const entry = { role, status: response.status(), method: response.request().method(), url: response.url(), body: (await response.text().catch(() => '')).slice(0, 6000) };
      evidence.push(entry);
      await writeFile(testInfo.outputPath('failed-http.json'), JSON.stringify(evidence.filter((item) => item.status), null, 2)).catch(() => undefined);
      if (response.status() >= 500) await writeFile(testInfo.outputPath('backend-errors.log'), harness.stack.getLogs()).catch(() => undefined);
    });
  }
  try {
    await enterTeacherClassroom(teacher, urlFor('teacher'));
    await enterStudentClassroom(student, urlFor('student'));
    await assertRenderedBoard(teacher);
    await assertRenderedBoard(student);
      const expandedFailures: string[] = [];
      try {
        await step('whiteboard video sharing produces remote frames and stops through the UI', async () => {
          await draw(teacher, 0);
          await assertBoardsEqual(teacher, student);
          await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
          await teacher.getByRole('menuitem', { name: 'Share whiteboard', exact: true }).click();
          await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).whiteboardSharing()), { timeout: 20_000 }).toBe(true);
          await expect.poll(() => student.locator('sfu-student-class-session').evaluate((element) => (window as any).ng.getComponent(element).hasScreenShare()), { timeout: 20_000 }).toBe(true);
          await expect.poll(async () => student.locator('video.stage-video').evaluateAll((videos) => videos.some((item) => { const video = item as HTMLVideoElement; return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0; })), { timeout: 25_000 }).toBe(true);
          const frames = await student.locator('video.stage-video').evaluate((item) => { const video = item as HTMLVideoElement; return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames }; });
          expect(frames.width).toBeGreaterThan(0);
          expect(frames.frames).toBeGreaterThan(0);
          evidence.push({ step: 'whiteboard-video', ...frames });
        });
      } catch (error) {
        expandedFailures.push(`Whiteboard video: ${error instanceof Error ? error.message : String(error)}`);
        for (const [role, page] of [['teacher', teacher], ['student', student]] as const) evidence.push({ step: 'media-diagnostics', role, data: await mediaDiagnostics(page, role).catch(() => null) });
        await writeFile(testInfo.outputPath('media-diagnostics.json'), JSON.stringify(evidence.filter((entry) => entry.step === 'media-diagnostics' || entry.failedSocketAck), null, 2));
      }
      finally {
        if (await teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).whiteboardSharing())) {
          if (!await teacher.getByRole('menu', { name: 'Teacher media actions' }).isVisible()) await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
          await teacher.getByRole('menuitem', { name: 'Stop whiteboard', exact: true }).click();
          await expect.poll(() => teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).whiteboardSharing())).toBe(false);
        }
      }
      try { await runStudentTurnAcceptance(teacher, student, testInfo); }
      catch (error) { expandedFailures.push(`Student turns: ${error instanceof Error ? error.message : String(error)}`); await writeFile(testInfo.outputPath('student-turn-failure-runtime.json'), JSON.stringify({ error: error instanceof Error ? error.message : String(error), teacher: await classroomState(teacher, 'teacher'), student: await classroomState(student, 'student') }, null, 2)); await writeFile(testInfo.outputPath('backend-errors.log'), harness.stack.getLogs()); }
      try { await runWhiteboardFeatureAcceptance(teacher, student, testInfo); }
      catch (error) { expandedFailures.push(`Feature matrix: ${error instanceof Error ? error.message : String(error)}`); await writeFile(testInfo.outputPath('feature-phase-failure.json'), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)); }
      expect(evidence.filter((entry) => entry.error || Number(entry.status) >= 500), 'No unexpected browser exceptions or backend failures').toEqual([]);
      expect(expandedFailures).toEqual([]);
  } catch (error) {
    for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
      await page.screenshot({ path: testInfo.outputPath(`${role}-feature-failure.png`), fullPage: true }).catch(() => undefined);
      evidence.push({ role, classroom: await classroomState(page, role).catch(() => null), body: (await page.locator('body').innerText().catch(() => '')).slice(-14_000) });
    }
    throw error;
  } finally {
    for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
      if (!page.isClosed() && await page.locator(`sfu-${role}-class-session`).count()) evidence.push({ step: 'final', role, classroom: await classroomState(page, role).catch(() => null) });
    }
    await writeFile(testInfo.outputPath('runtime-stack.log'), harness.stack.getLogs());
    await writeFile(testInfo.outputPath('feature-runtime-evidence.json'), JSON.stringify(evidence, null, 2));
    await harness.close();
  }
});
