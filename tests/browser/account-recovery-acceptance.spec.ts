import { io, type Socket } from 'socket.io-client';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { startAcceptanceStack } from './helpers/whiteboard-classroom';
import { startBuiltUiTestServer } from './helpers/admin-test-server';
import { startLocalSmtpSink } from './helpers/tutor-launch-acceptance';
import { setAccessibilityTheme } from './helpers/accessibility-theme';
const { setupAccountRecoveryIndexes } = require('../../scripts/setup-account-recovery.cjs');
const { UserSchema } = require('../../apps/backend/dist/database/schemas.js');

function emailText(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split), body = raw.slice(split + 4);
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(body.replaceAll(/\s/g, ''), 'base64').toString('utf8');
  return body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

test('password recovery delivers mail, expires links, consumes once and revokes sessions across nodes', async ({ browser }, info) => {
  const redisUrl = new URL(process.env.REDIS_URL!);
  if (redisUrl.hostname !== '127.0.0.1' || redisUrl.port !== '6394' || redisUrl.pathname !== '/15') throw Error('Recovery proof requires owned local Redis database 15.');
  const redis = new Redis(redisUrl.href);
  // Browser projects share the owned test Redis; clear only prior local HTTP throttle windows.
  const throttleKeys = await redis.keys('sfu:throttle:*'); if (throttleKeys.length) await redis.del(...throttleKeys);
  const smtp = await startLocalSmtpSink({ rejectFirst: true });
  const admin = await startBuiltUiTestServer('http://127.0.0.1:3450', path.resolve('apps/admin-portal/dist/admin-portal/browser'), 4551);
  const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
  const contexts: BrowserContext[] = [];
  const sockets: Socket[] = [];
  const nonce = randomUUID(); const folder = path.resolve('reports/recovery', info.project.name); await mkdir(folder, { recursive: true });
  let stack: Awaited<ReturnType<typeof startAcceptanceStack>> | undefined;
  try {
    await setupAccountRecoveryIndexes(connection); await setupAccountRecoveryIndexes(connection);
    stack = await startAcceptanceStack({ frontendPort: 4550, backendPort: 3450, secondBackendPort: 3451, localSmtpPort: smtp.port, adminPortalUrl: admin.origin, frontendDir: path.resolve('apps/frontend/dist/frontend/browser') });
    const db = connection.db!;
    const template = await db.collection('users').findOne({ email: 'teacher.one@example.com' });
    const studentEmail = `recovery-student-${nonce}@example.test`, teacherEmail = `recovery-teacher-${nonce}@example.test`, adminEmail = `recovery-admin-${nonce}@example.test`, socialEmail = `recovery-social-${nonce}@example.test`;
    const accounts = [
      { email: studentEmail, roles: ['STUDENT'] }, { email: teacherEmail, roles: ['TEACHER'] },
      { email: adminEmail, roles: ['SUPER_ADMIN'] }, { email: socialEmail, roles: ['STUDENT'], googleSubject: 'social-' + nonce, passwordHash: undefined },
    ];
    await db.collection('users').insertMany(accounts.map(account => ({ ...template, _id: new mongoose.Types.ObjectId(), tutorReviewStatus: 'draft', authVersion: undefined, ...account })), { ignoreUndefined: true });
    const api = async (endpoint: string, data?: unknown, token?: string, node = stack!.nodeAUrl) => {
      const response = await fetch(node + '/api/v1' + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) });
      const text = await response.text(); return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
    };
    const context = await browser.newContext({ viewport: { width: 1366, height: 950 } }); contexts.push(context);
    await context.addInitScript(() => localStorage.setItem('native-sfu-theme', 'light'));
    const page = await context.newPage();
    const card = (page: Page) => page.locator('sfu-account-recovery-form');
    const requestInUi = async (email: string, role = 'student') => {
      await page.goto((role === 'admin' ? admin.origin + '/login' : stack!.frontendBaseUrl + '/' + role + '/login'));
      await page.getByRole('link', { name: 'Forgot your password?', exact: true }).click();
      await expect(page).toHaveURL(/\/forgot-password/);
      await expect(card(page).getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
      await card(page).getByLabel('Email', { exact: true }).fill(email); await card(page).getByRole('button', { name: 'Send reset link' }).click();
      await expect(card(page).getByRole('status')).toContainText('If an active account matches');
    };
    const linkFor = async (email: string, after = 0): Promise<string> => {
      let link = '';
      await expect.poll(() => {
        const messages = smtp.messages.slice(after).filter(message => message.subject === 'Reset your Sapiovian password' && message.raw.includes(email));
        link = messages.at(-1) ? emailText(messages.at(-1)!.raw).match(/https?:\/\/[^\s]+\/reset-password#[^\s]+/)?.[0] ?? '' : '';
        return link;
      }).not.toBe('');
      return link;
    };
    const fillReset = async (link: string, password: string) => {
      await page.goto(link); await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
      await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
      await page.getByLabel('New password', { exact: true }).fill(password);
      await page.getByLabel('Confirm new password', { exact: true }).fill(password);
    };
    const legacySchema = UserSchema.clone(); legacySchema.set('autoIndex', false); legacySchema.set('autoCreate', false);
    const LegacyUser = connection.model('RecoveryLegacyUser', legacySchema);
    const staleLegacyUser = await LegacyUser.findOne({ email: studentEmail });
    expect(staleLegacyUser.authVersion).toBeUndefined();
    const old = (await api('/auth/login', { email: studentEmail, password: 'Password@12345' })).body.data;
    for (const node of [stack.nodeAUrl, stack.nodeBUrl!]) {
      const socket = io(node + '/sfu', { transports: ['websocket'], reconnection: false, auth: { token: old.accessToken, protocolVersion: 1 } }); sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }

    await requestInUi(studentEmail);
    await page.screenshot({ path: path.join(folder, 'request-acknowledgement.png'), fullPage: true });
    const link = await linkFor(studentEmail); expect(smtp.failures()).toBe(1);
    expect((await db.collection('password_recovery_jobs').findOne({ _id: 'reset:' + createHash('sha256').update(studentEmail).digest('hex') }))?.attempts).toBe(2);
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
    const stored = await db.collection('users').findOne({ email: studentEmail });
    expect(stored?.passwordResetHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await db.collection('password_recovery_jobs').find({}).toArray())).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    const accepted = await api('/auth/forgot-password', { email: studentEmail });
    const unknownEmail = `missing-${nonce}@example.test`;
    const unknown = await api('/auth/forgot-password', { email: unknownEmail });
    expect(accepted.status).toBe(204); expect(unknown.status).toBe(204); expect(accepted.text).toBe(''); expect(unknown.text).toBe('');
    const jobKey = 'reset:' + createHash('sha256').update(unknownEmail).digest('hex');
    await expect.poll(async () => (await db.collection('password_recovery_jobs').findOne({ _id: jobKey }))?.state).toBe('skipped');
    expect(smtp.messages.some(message => message.raw.includes(unknownEmail))).toBe(false);
    // A GET/email scanner cannot consume a reset; no authentication is granted by opening it.
    await fillReset(link, 'ChangedStudent@123');
    await page.getByLabel('Confirm new password', { exact: true }).fill('Different@123'); await page.getByLabel('Confirm new password', { exact: true }).blur();
    await expect(page.getByRole('button', { name: 'Update password' })).toBeDisabled();
    await expect(card(page)).toContainText('Passwords must match');
    await page.getByLabel('Confirm new password', { exact: true }).fill('ChangedStudent@123');
    await page.screenshot({ path: path.join(folder, 'reset-form.png'), fullPage: true, mask: [page.locator('input[type="password"]')] });
    expect((await new AxeBuilder({ page }).include('sfu-account-recovery-form').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(card(page).getByRole('status')).toContainText('Your password has been updated');
    expect(await page.evaluate(() => sessionStorage.getItem('native-sfu.auth.accessToken'))).toBeNull();
    // A login/profile save begun before recovery must not write a default zero over the new epoch.
    staleLegacyUser.lastLoginAt = new Date(); await staleLegacyUser.save();
    expect((await db.collection('users').findOne({ email: studentEmail }))?.authVersion).toBe(1);

    await expect.poll(() => sockets.every(socket => !socket.connected), { timeout: 45000 }).toBe(true);
    // Simulate a session row surviving cleanup: credential versions still deny it.
    const previousSession = JSON.parse(Buffer.from(old.accessToken.split('.')[1], 'base64url').toString()).tokenId;
    await db.collection('sessions').updateOne({ refreshTokenJti: previousSession }, { $unset: { revokedAt: 1 } });
    expect((await api('/auth/me', undefined, old.accessToken)).status).toBe(401);
    expect((await api('/auth/me', undefined, old.accessToken, stack.nodeBUrl)).status).toBe(401);
    expect((await api('/auth/refresh', { refreshToken: (old as { refreshToken: string }).refreshToken }, undefined, stack.nodeBUrl)).status).toBe(401);
    expect((await api('/auth/login', { email: studentEmail, password: 'Password@12345' })).status).toBe(401);
    await expect.poll(() => smtp.messages.filter(message => message.subject === 'Your Sapiovian password was changed' && message.raw.includes(studentEmail)).length).toBe(1);
    expect(smtp.messages.filter(message => message.subject === 'Your Sapiovian password was changed').every(message => !emailText(message.raw).includes('ChangedStudent@123'))).toBe(true);
    const loggedIn = await api('/auth/login', { email: studentEmail, password: 'ChangedStudent@123' }); expect(loggedIn.status).toBe(200);
    // An attacker replaying pre-recovery refresh credentials cannot sign out the new session.
    expect((await api('/auth/refresh', { refreshToken: old.refreshToken }, undefined, stack.nodeBUrl)).status).toBe(401);
    expect((await api('/auth/me', undefined, loggedIn.body.data.accessToken)).status).toBe(200);

    // Old links, including replay from another node, cannot replace the new password.
    expect((await api('/auth/reset-password', { token, password: 'ReplayPassword@123' }, undefined, stack.nodeBUrl)).status).toBe(400);
    await fillReset(link, 'ReplayPassword@123'); await page.getByRole('button', { name: 'Update password' }).click();
    await expect(card(page).getByRole('alert')).toContainText('invalid, expired or already used');
    // Teacher flow preserves identity/review and uses the correct login destination.
    await requestInUi(teacherEmail, 'teacher'); const teacherLink = await linkFor(teacherEmail);
    await fillReset(teacherLink, 'ChangedTeacher@123'); await page.getByRole('button', { name: 'Update password' }).click();
    await expect(card(page).getByRole('status')).toContainText('updated'); await page.getByRole('link', { name: 'Back to login' }).click(); await expect(page).toHaveURL(/teacher\/login/);
    const teacher = await db.collection('users').findOne({ email: teacherEmail }); expect(teacher?.roles).toEqual(['TEACHER']); expect(teacher?.tutorReviewStatus).toBe('draft');
    const teacherJob = 'reset:' + createHash('sha256').update(teacherEmail).digest('hex');
    await db.collection('password_recovery_jobs').updateOne({ _id: teacherJob }, { $set: { nextRequestAt: new Date(0) } });
    const teacherAfter = smtp.messages.length;
    expect((await api('/auth/forgot-password', { email: teacherEmail })).status).toBe(204);
    const pendingTeacherLink = await linkFor(teacherEmail, teacherAfter);
    const teacherSession = (await api('/auth/login', { email: teacherEmail, password: 'ChangedTeacher@123' })).body.data;
    expect((await api('/auth/change-password', { currentPassword: 'ChangedTeacher@123', newPassword: 'TeacherFinal@123' }, teacherSession.accessToken)).status).toBe(204);
    const pendingTeacherToken = new URLSearchParams(new URL(pendingTeacherLink).hash.slice(1)).get('token');
    expect((await api('/auth/reset-password', { token: pendingTeacherToken, password: 'OldTeacherLink@123' })).status).toBe(400);
    expect((await api('/auth/login', { email: teacherEmail, password: 'TeacherFinal@123' })).status).toBe(200);
    // Admin recovery uses its configured origin and retains privileges without auto-login.
    await requestInUi(adminEmail, 'admin'); const adminLink = await linkFor(adminEmail); expect(new URL(adminLink).origin).toBe(admin.origin);
    await fillReset(adminLink, 'ChangedAdmin@123');
    await page.screenshot({ path: path.join(folder, 'admin-reset.png'), fullPage: true, mask: [page.locator('input[type="password"]')] });
    await page.getByRole('button', { name: 'Update password' }).click(); await expect(card(page).getByRole('status')).toContainText('updated');
    expect((await db.collection('users').findOne({ email: adminEmail }))?.roles).toEqual(['SUPER_ADMIN']);
    expect((await api('/auth/login', { email: adminEmail, password: 'ChangedAdmin@123' })).status).toBe(200);
    // Social-only accounts can establish a password through their verified mailbox; provider binding stays intact.
    await requestInUi(socialEmail); const socialLink = await linkFor(socialEmail);
    await fillReset(socialLink, 'ChangedSocial@123'); await page.getByRole('button', { name: 'Update password' }).click(); await expect(card(page).getByRole('status')).toContainText('updated');
    expect((await db.collection('users').findOne({ email: socialEmail }))?.googleSubject).toBe('social-' + nonce);
    expect((await api('/auth/login', { email: socialEmail, password: 'ChangedSocial@123' })).status).toBe(200);
    // Start the next isolated abuse-control proof with a fresh owned IP throttle window.
    const priorKeys = await redis.keys('sfu:throttle:*'); if (priorKeys.length) await redis.del(...priorKeys);
    // A fresh emailed link replaces the previous one; only one of two concurrent submissions can win.
    const resetJob = 'reset:' + createHash('sha256').update(studentEmail).digest('hex');
    const fresh = async () => { const after = smtp.messages.length; await db.collection('password_recovery_jobs').updateOne({ _id: resetJob }, { $set: { nextRequestAt: new Date(0) } }); expect((await api('/auth/forgot-password', { email: studentEmail })).status).toBe(204); return linkFor(studentEmail, after); };
    const first = await fresh(); const second = await fresh();
    const firstToken = new URLSearchParams(new URL(first).hash.slice(1)).get('token')!;
    const secondToken = new URLSearchParams(new URL(second).hash.slice(1)).get('token')!;
    expect((await api('/auth/reset-password', { token: firstToken, password: 'StalePassword@123' })).status).toBe(400);
    const race = await Promise.all([api('/auth/reset-password', { token: secondToken, password: 'ConcurrentOne@123' }), api('/auth/reset-password', { token: secondToken, password: 'ConcurrentTwo@123' }, undefined, stack.nodeBUrl)]);
    expect(race.map(result => result.status).sort()).toEqual([204, 400]);
    const expiryLink = await fresh(); const expiryToken = new URLSearchParams(new URL(expiryLink).hash.slice(1)).get('token')!;
    await db.collection('users').updateOne({ email: studentEmail }, { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } });
    expect((await api('/auth/reset-password', { token: expiryToken, password: 'ExpiredPassword@123' })).status).toBe(400);
    // Disabled accounts never recover, and malformed/short passwords are rejected.
    const disabledLink = await fresh(); const disabledToken = new URLSearchParams(new URL(disabledLink).hash.slice(1)).get('token')!;
    await db.collection('users').updateOne({ email: studentEmail }, { $set: { disabled: true } });
    expect((await api('/auth/reset-password', { token: disabledToken, password: 'DisabledPassword@123' })).status).toBe(400);
    expect((await api('/auth/reset-password', { token: disabledToken, password: 'short' })).status).toBe(400);
    expect((await api('/auth/reset-password', { token: 'invalid', password: 'ValidLength@123' })).status).toBe(400);
    // Reset only owned test throttle windows before independently proving each limit.
    const localKeys = await redis.keys('sfu:throttle:*'); if (localKeys.length) await redis.del(...localKeys);
    // Per-address hourly and per-IP limits are enforced without account-existence responses.
    expect((await db.collection('password_recovery_jobs').findOne({ _id: resetJob }))?.count).toBe(5);
    await db.collection('password_recovery_jobs').updateOne({ _id: resetJob }, { $set: { nextRequestAt: new Date(0) } });
    expect((await api('/auth/forgot-password', { email: studentEmail })).status).toBe(204);
    expect((await db.collection('password_recovery_jobs').findOne({ _id: resetJob }))?.count).toBe(5);
    let limited = false; for (let index = 0; index < 12 && !limited; index++) limited = (await api('/auth/forgot-password', { email: `limit-${index}-${nonce}@example.test` })).status === 429;
    expect(limited).toBe(true);
    const audit = await db.collection('audit_logs').find({ targetId: stored!._id.toString(), action: /^auth.password_reset/ }).toArray();
    expect(audit.some(entry => entry.action === 'auth.password_reset_completed')).toBe(true); expect(JSON.stringify(audit)).not.toContain(token); expect(JSON.stringify(audit)).not.toContain('ChangedStudent@123');
    expect(stack.getLogs()).not.toContain(token);
    // Responsive, light/dark recovery screens remain keyboard accessible without live credentials.
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(stack.frontendBaseUrl + '/forgot-password');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(folder, `request-${width}.png`), fullPage: true });
    }
    await setAccessibilityTheme(page, 'dark');
    expect((await new AxeBuilder({ page }).include('sfu-account-recovery-form').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: path.join(folder, 'request-dark.png'), fullPage: true });
  } finally {
    for (const socket of sockets) socket.disconnect();
    await Promise.all(contexts.map(context => context.close())); await stack?.stop(); await admin.stop(); await connection.close(); await smtp.close(); redis.disconnect();
  }
});
