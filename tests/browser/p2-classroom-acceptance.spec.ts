import { expect, test, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClassroomHarness, waitJoined, classroomState, login } from './helpers/whiteboard-classroom';
import { runtimeUrl } from './helpers/local-ui-stack';

test('classroom presets enforce server permissions and accessible English/Hindi entry', async ({}, info) => {
  const h = await createClassroomHarness({ frontendPort: 4536, backendPort: 3436, batchName: 'P2 classroom ' + randomUUID() });
  const { teacher, student, fixture, stack } = h;
  const folder = path.resolve('reports/p2', 'chromium');
  await mkdir(folder, { recursive: true });
  const api = async (token: string, endpoint: string, method = 'GET', data?: unknown, expected?: number) => {
    const response = await fetch(stack.nodeAUrl + '/api/v1' + endpoint, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (expected) expect(response.status, endpoint + ': ' + JSON.stringify(body)).toBe(expected); else expect(response.ok, endpoint + ': ' + JSON.stringify(body)).toBe(true);
    return body.data ?? body;
  };
  const settings = '/teacher/batches/' + fixture.batchId + '/live-settings';
  const scan = async (page: Page, selector: string) => {
    const result = await new AxeBuilder({ page }).include(selector).withRules(['button-name', 'label', 'aria-dialog-name', 'aria-valid-attr-value', 'color-contrast']).analyze();
    expect(result.violations).toEqual([]); return result.violations;
  };
  const keyboardDialog = async (page: Page, dialog: Locator) => {
    await expect(dialog).toBeVisible();
    const selectors = 'button:visible:enabled,a[href]:visible,input:visible:enabled,select:visible:enabled,textarea:visible:enabled';
    const controls = dialog.locator(selectors);
    await controls.first().focus(); await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
    await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
    const setup = dialog.getByRole('button', { name: 'Device setup', exact: true });
    await setup.focus(); await page.keyboard.press('Enter');
    await expect(dialog.locator('dialog[open]')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog.locator('dialog[open]')).toHaveCount(0);
    await expect(dialog).toBeVisible(); await expect(setup).toBeFocused();
  };
  try {
    const otherTeacher = (await login(stack.nodeAUrl, 'teacher.two@example.com', 'Password@12345')).accessToken;
    await api(otherTeacher, settings + '/preset', 'POST', { presetId: 'teaching' }, 404);
    await api(h.studentTokens.accessToken, settings + '/preset', 'POST', { presetId: 'teaching' }, 403);
    await api(h.teacherTokens.accessToken, settings + '/preset', 'POST', { presetId: 'unknown' }, 400);
    await teacher.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, '/teacher/dashboard/batches/' + fixture.batchId));
    await teacher.getByRole('button', { name: 'Apply Controlled entry preset', exact: true }).click();
    await expect.poll(async () => (await api(h.teacherTokens.accessToken, settings)).overrides.chat?.studentChatInitiallyLocked).toBe(true);
    const controlled = await api(h.teacherTokens.accessToken, settings);
    expect(controlled.overrides.access.lockClassAfterTeacherStarts).toBe(true);
    // Explicit customization keeps the class locked but uses direct entry after the teacher unlocks it.
    await api(h.teacherTokens.accessToken, settings, 'PATCH', { ...controlled.overrides, access: { ...controlled.overrides.access, waitingRoomEnabled: false } });
    await teacher.goto(h.urlFor('teacher'));
    const preflight = teacher.locator('.teacher-preflight-backdrop');
    await expect(teacher.getByRole('button', { name: 'Start Live Class', exact: true })).toBeEnabled();
    await keyboardDialog(teacher, preflight); await scan(teacher, '.teacher-preflight-backdrop');
    await teacher.screenshot({ path: path.join(folder, 'teacher-preflight.png'), fullPage: true });
    await teacher.evaluate(() => { document.documentElement.dataset['theme'] = 'dark'; });
    await teacher.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)); await scan(teacher, '.teacher-preflight-backdrop');
    await teacher.screenshot({ path: path.join(folder, 'teacher-preflight-dark.png'), fullPage: true });
    await teacher.evaluate(() => { document.documentElement.dataset['theme'] = 'light'; });
    await teacher.getByRole('button', { name: 'Start Live Class', exact: true }).focus(); await teacher.keyboard.press('Enter');
    await waitJoined(teacher, 'teacher');
    expect(await teacher.locator('sfu-teacher-class-session').evaluate(el => (window as any).ng.getComponent(el).store.room().settings.locked)).toBe(true);
    const roomId = (await classroomState(teacher, 'teacher')).roomId;
    const mediaButton = teacher.getByRole('button', { name: 'Open media controls', exact: true });
    await mediaButton.click(); await teacher.getByRole('menuitem', { name: 'Unlock class', exact: true }).click();
    await student.setViewportSize({ width: 390, height: 844 });
    await student.goto(h.urlFor('student'));
    const prejoin = student.locator('.student-prejoin-backdrop');
    await expect(student.getByRole('button', { name: 'Join Class', exact: true })).toBeEnabled();
    await keyboardDialog(student, prejoin);
    await prejoin.getByLabel('Classroom language', { exact: true }).selectOption('hi');
    await expect(prejoin.getByRole('heading', { name: 'जुड़ने के लिए तैयार हैं?', exact: true })).toBeVisible();
    await expect(student.locator('.student-session-shell')).toHaveAttribute('lang', 'hi');
    await expect(prejoin.getByRole('button', { name: 'कक्षा में शामिल हों', exact: true })).toBeEnabled();
    await scan(student, '.student-prejoin-backdrop');
    expect(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await student.screenshot({ path: path.join(folder, 'student-prejoin-hindi-mobile.png'), fullPage: true });
    await prejoin.getByLabel('कक्षा की भाषा', { exact: true }).selectOption('en');
    await prejoin.getByRole('button', { name: 'Join Class', exact: true }).focus(); await student.keyboard.press('Enter');
    await waitJoined(student, 'student');
    const chatButton = student.getByTitle('Open class chat', { exact: true });
    await expect.poll(async () => { const chat = await chatButton.boundingBox(), controls = await student.locator('.live-media-controls').boundingBox(); return Boolean(chat && controls && chat.y + chat.height <= controls.y); }).toBe(true);
    await chatButton.click();
    await expect(student.getByText('Your teacher has paused your chat. You can still read replies.', { exact: true })).toBeVisible();
    const composer = student.locator('sfu-session-chat .composer-fields input[type=text]');
    await expect(composer).toBeDisabled();
    const directSend = () => student.locator('sfu-student-class-session').evaluate(async el => {
      const c = (window as any).ng.getComponent(el);
      try { await c.socket.emitAck('chat:send', { roomId: c.session().roomId, scope: 'private', message: 'Bypass paused composer' }); return 'unexpected success'; }
      catch (error: any) { return error.message; }
    });
    expect(await directSend()).toMatch(/chat.*permission|permission.*chat|not.*allowed|paused/i);
    await teacher.getByRole('button', { name: 'Allow student chat', exact: true }).click();
    await expect(composer).toBeEnabled();
    await composer.fill('Permission granted message');
    await student.locator('sfu-session-chat').getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(student.locator('sfu-session-chat').getByText('Permission granted message', { exact: true })).toBeVisible();
    await teacher.getByRole('button', { name: 'Pause student chat', exact: true }).click();
    await expect(composer).toBeDisabled();
    await expect(student.locator('sfu-session-chat').getByText('Permission granted message', { exact: true })).toBeVisible();
    expect(await directSend()).toMatch(/chat.*permission|permission.*chat|not.*allowed|paused/i);
    await api(h.teacherTokens.accessToken, settings + '/preset', 'POST', { presetId: 'discussion' });
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    try {
      const live = await connection.db!.collection('class_sessions').findOne({ _id: fixture.sessionId as any });
      expect(live!.liveSettings.chat.studentChatInitiallyLocked).toBe(true);
      expect(live!.liveSettings.media.allowStudentsToUnmuteSelf).toBe(false);
      const audit = await connection.db!.collection('audit_logs').findOne({ resourceId: fixture.batchId, action: 'batch.classroom_policy.applied' });
      expect(audit).toBeTruthy();
    } finally { await connection.close(); }
    await student.screenshot({ path: path.join(folder, 'student-paused-chat-mobile.png'), fullPage: true });
    await api(h.teacherTokens.accessToken, '/class-sessions/' + fixture.sessionId + '/end', 'POST');
    await writeFile(path.join(folder, 'classroom-policy.json'), JSON.stringify({ passed: true, realBackend: true, roomId, lockedStart: true, serverChatPermissionEnforced: true, historyReadableWhenPaused: true, liveSnapshotUnaffectedByPresetChange: true, ownershipEnforced: true, keyboardFocusWrap: true, nestedEscape: true, classroomLanguages: ['en', 'hi'], physicalScreenReaderSignoff: false, productionSignoff: false }, null, 2));
  } finally { await writeFile(info.outputPath('classroom-backend.log'), stack.getLogs()); await h.close(); }
});
