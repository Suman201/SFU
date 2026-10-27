import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { assertBoardsEqual, createClassroomHarness, draw, enterStudentClassroom, enterTeacherClassroom, mediaDiagnostics } from './helpers/whiteboard-classroom';

test('real classroom camera and static whiteboard sharing deliver remote frames', async ({ browserName }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(browserName !== 'chromium', 'Local media acceptance uses Chromium fake camera and microphone.');
  const harness = await createClassroomHarness();
  const { teacher, student, urlFor } = harness;
  const evidence: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const frames = () => student.locator('video.stage-video').evaluateAll((videos) => videos.map((element) => {
    const video = element as HTMLVideoElement;
    return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames };
  }));
  const screenHasFrames = () => student.locator('sfu-student-class-session').evaluate((element) => {
    const classroom = (window as any).ng.getComponent(element);
    const video = element.querySelector('video.stage-video') as HTMLVideoElement | null;
    return classroom.stageProducer()?.kind === 'screen' && video?.srcObject === classroom.stageStream()
      && video!.videoWidth > 0 && video!.getVideoPlaybackQuality().totalVideoFrames > 0;
  });
  const snapshot = async (phase: string) => {
    evidence.push({ phase, teacher: await mediaDiagnostics(teacher, 'teacher'), student: await mediaDiagnostics(student, 'student'), frames: await frames() });
    await writeFile(testInfo.outputPath('media-evidence.json'), JSON.stringify(evidence, null, 2));
  };
  try {
    await enterTeacherClassroom(teacher, urlFor('teacher'));
    await enterStudentClassroom(student, urlFor('student'));
    await draw(teacher, 0); await assertBoardsEqual(teacher, student);
    await snapshot('before-watching-stage');
    await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
    try {
      await expect.poll(async () => (await frames()).some((video) => video.width > 0 && video.frames > 0), { timeout: 20_000 }).toBe(true);
    } catch { failures.push('Teacher camera did not deliver a decoded frame.'); }
    await snapshot('camera-stage');
    await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'Share whiteboard', exact: true }).click();
    await expect.poll(() => student.locator('sfu-student-class-session').evaluate((element) => (window as any).ng.getComponent(element).hasScreenShare()), { timeout: 20_000 }).toBe(true);
    try {
      await expect.poll(screenHasFrames, { timeout: 25_000 }).toBe(true);
      await snapshot('static-whiteboard-stage');
    } catch {
      failures.push('Static whiteboard did not deliver a decoded frame before another edit.');
      await snapshot('static-whiteboard-failure');
      // Diagnostic only: this cannot turn a failed initial/static frame into a pass.
      await draw(teacher, 1);
      let receivedAfterDraw = false;
      try { await expect.poll(screenHasFrames, { timeout: 15_000 }).toBe(true); receivedAfterDraw = true; } catch { /* retained below */ }
      evidence.push({ phase: 'redraw-probe', receivedAfterDraw });
      await snapshot('after-redraw-probe');
    }
    if (!failures.length) {
      // Recreate the student receiver while the teacher leaves the shared board idle.
      await enterStudentClassroom(student, urlFor('student'));
      await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
      try { await expect.poll(screenHasFrames, { timeout: 25_000 }).toBe(true); }
      catch { failures.push('Rejoining student did not receive the unchanged shared board.'); }
      await snapshot('rejoined-student-static-whiteboard');
    }
    await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'Stop whiteboard', exact: true }).click();
    await expect.poll(() => student.locator('sfu-student-class-session').evaluate((element) => (window as any).ng.getComponent(element).hasScreenShare())).toBe(false);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  } finally {
    await writeFile(testInfo.outputPath('media-evidence.json'), JSON.stringify(evidence, null, 2));
    await writeFile(testInfo.outputPath('backend-runtime.log'), harness.stack.getLogs());
    await harness.close();
  }
});
