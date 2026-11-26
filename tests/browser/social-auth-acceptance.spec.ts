import { test, expect, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { startAcceptanceStack } from './helpers/whiteboard-classroom';
import { startSocialProvider } from './helpers/social-provider';
const { setupSocialAuthIndexes } = require('../../scripts/setup-social-auth.cjs');

// Real Angular + NestJS + Mongo + signed synthetic provider JWTs; no mocked auth service or API responses.
test('Google and Apple sign-in, safe linking, role boundaries and replay protection', async ({ browser }, info) => {
  const provider = await startSocialProvider();
  const nonce = randomUUID();
  const overrides = {
    GOOGLE_AUTH_ENABLED: 'true', GOOGLE_AUTH_CLIENT_ID: 'google-fixture-client', GOOGLE_AUTH_CLIENT_SECRET: 'synthetic-google-client-secret', GOOGLE_AUTH_CLIENT_SECRET_FILE: '', GOOGLE_AUTH_REDIRECT_URI: 'http://127.0.0.1:3446/api/v1/auth/social/google/callback',
    APPLE_AUTH_ENABLED: 'true', APPLE_AUTH_CLIENT_ID: 'apple-fixture-client', APPLE_AUTH_TEAM_ID: 'TESTTEAMID', APPLE_AUTH_KEY_ID: 'TESTKEYID', APPLE_AUTH_PRIVATE_KEY: provider.applePrivateKey, APPLE_AUTH_PRIVATE_KEY_FILE: '', APPLE_AUTH_REDIRECT_URI: 'http://127.0.0.1:3446/api/v1/auth/social/apple/callback',
    SFU_SOCIAL_FIXTURE_ORIGIN: provider.origin, NODE_OPTIONS: `--require ${path.resolve('tests/browser/helpers/social-provider-preload.cjs')}`,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let stack: Awaited<ReturnType<typeof startAcceptanceStack>> | undefined;
  const contexts: BrowserContext[] = [];
  const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
  const folder = path.resolve('reports/social', info.project.name); await mkdir(folder, { recursive: true });
  const newEmail = `social-${nonce}@example.test`, relayEmail = `relay-${nonce}@privaterelay.appleid.com`;
  let scenario = { email: newEmail, subject: 'new-' + nonce, cancel: false, invalid: '' };
  try {
    // Provision production indexes before enabling providers; repeated provisioning preserves existing accounts.
    await setupSocialAuthIndexes(connection); await setupSocialAuthIndexes(connection);
    Object.assign(process.env, overrides);
    try { stack = await startAcceptanceStack({ frontendPort: 4546, backendPort: 3446, socialAuthEnabled: true, frontendDir: path.resolve('apps/frontend/dist/frontend/browser') }); }
    finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    const db = connection.db!;
    // Separate fixture accounts per browser and run. Use a real teacher's password hash without modifying seeded identities.
    const template = await db.collection('users').findOne({ email: 'teacher.one@example.com' });
    const teacherEmail = `teacher-${nonce}@example.test`, adminEmail = `admin-${nonce}@example.test`;
    await db.collection('users').insertMany([
      { ...template, _id: new mongoose.Types.ObjectId(), email: teacherEmail, roles: ['TEACHER'], tutorReviewStatus: 'draft', googleSubject: undefined, appleSubject: undefined },
      { ...template, _id: new mongoose.Types.ObjectId(), email: adminEmail, roles: ['SUPER_ADMIN'], googleSubject: undefined, appleSubject: undefined },
    ], { ignoreUndefined: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 950 } }); contexts.push(context);
    await context.addInitScript(() => localStorage.setItem('native-sfu-theme', 'light'));
    await context.route(/^https:\/\/(accounts\.google\.com|appleid\.apple\.com)\//, async route => {
      const url = new URL(route.request().url());
      const name = url.hostname === 'accounts.google.com' ? 'google' : 'apple';
      const local = new URL(provider.origin + '/' + name + '/authorize'); local.search = url.search;
      local.searchParams.set('fixture_email', scenario.email); local.searchParams.set('fixture_subject', scenario.subject);
      if (scenario.cancel) local.searchParams.set('fixture_cancel', '1');
      if (scenario.invalid) local.searchParams.set('fixture_invalid', scenario.invalid);
      await route.fulfill({ response: await route.fetch({ url: local.href }) });
    });
    const page = await context.newPage();
    const begin = async (name: 'Google' | 'Apple', role = 'student', returnUrl?: string) => {
      await page.evaluate(() => { sessionStorage.removeItem('native-sfu.auth.accessToken'); sessionStorage.removeItem('native-sfu.auth.refreshToken'); });
      await context.clearCookies();
      await page.goto(stack!.frontendBaseUrl + '/' + role + '/login' + (returnUrl ? '?returnUrl=' + encodeURIComponent(returnUrl) : ''));
      await expect(page).toHaveURL(new RegExp('/' + role + '/login'));
      await page.getByRole('button', { name: 'Continue with ' + name, exact: true }).click();
      await page.getByRole('button', { name: 'Authorize test account' }).click();
      await expect(page).toHaveURL(/\/auth\/social\/callback/);
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    };
    await page.goto(stack.frontendBaseUrl + '/student/login');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await page.screenshot({ path: path.join(folder, 'student-login.png'), fullPage: true });
    await expect(new AxeBuilder({ page }).include('.auth-card').withTags(['wcag2a', 'wcag2aa']).analyze()).resolves.toMatchObject({ violations: [] });
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(folder, `student-login-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1366, height: 950 });
    await begin('Google', 'student', '/student/profile');
    await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page).toHaveURL(/\/student\/profile/);
    const student = await db.collection('users').findOne({ email: newEmail });
    expect(student?.roles).toEqual(['STUDENT']); expect(student?.passwordHash).toBeUndefined();
    expect(student?.googleSubject).toBe('new-' + nonce);
    await page.screenshot({ path: path.join(folder, 'google-student-profile.png'), fullPage: true });
    // The same subject signs in without linking again.
    await begin('Google'); await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page).toHaveURL(/\/student\/dashboard/);
    expect(await db.collection('users').countDocuments({ email: newEmail })).toBe(1);
    // Existing teacher with Apple's private relay: explicit password proof, no email-based automatic linking.
    scenario = { email: relayEmail, subject: 'teacher-apple-' + nonce, cancel: false, invalid: '' };
    await begin('Apple', 'teacher');
    await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page.getByRole('button', { name: 'Link account and sign in' })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(teacherEmail);
    await page.getByLabel('Password', { exact: true }).fill('WrongPassword123');
    await page.getByRole('button', { name: 'Link account and sign in' }).click();
    await expect(page.locator('.auth-card').getByRole('alert')).toContainText('incorrect');
    expect((await db.collection('users').findOne({ email: teacherEmail }))?.appleSubject).toBeUndefined();
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    await page.screenshot({ path: path.join(folder, 'apple-teacher-link.png'), fullPage: true, mask: [page.getByLabel('Password', { exact: true })] });
    await page.getByRole('button', { name: 'Link account and sign in' }).click();
    await expect(page).toHaveURL(/\/teacher\/dashboard/);
    const teacher = await db.collection('users').findOne({ email: teacherEmail });
    expect(teacher?.appleSubject).toBe(scenario.subject); expect(teacher?.tutorReviewStatus).toBe('draft');
    expect(await db.collection('users').countDocuments({ email: relayEmail })).toBe(0);
    await begin('Apple', 'teacher'); await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page).toHaveURL(/\/teacher\/dashboard/);
    // Both providers work for both roles, including matching-email password linking.
    scenario = { email: teacherEmail, subject: 'teacher-google-' + nonce, cancel: false, invalid: '' };
    await begin('Google', 'teacher'); await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page.getByRole('button', { name: 'Link account and sign in' })).toBeVisible();
    expect((await db.collection('users').findOne({ email: teacherEmail }))?.googleSubject).toBeUndefined();
    await page.getByLabel('Email', { exact: true }).fill(teacherEmail); await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    await page.getByRole('button', { name: 'Link account and sign in' }).click(); await expect(page).toHaveURL(/\/teacher\/dashboard/);
    scenario = { email: 'apple-student-' + nonce + '@privaterelay.appleid.com', subject: 'apple-student-' + nonce, cancel: false, invalid: '' };
    await begin('Apple'); await page.getByRole('button', { name: 'Finish signing in' }).click(); await expect(page).toHaveURL(/\/student\/dashboard/);
    expect((await db.collection('users').findOne({ email: scenario.email }))?.displayName).toBe('Apple Learner');
    scenario = { email: relayEmail, subject: 'teacher-apple-' + nonce, cancel: false, invalid: '' };
    // Role selection cannot promote a student or change teacher review.
    await begin('Apple', 'student'); await page.getByRole('button', { name: 'Finish signing in' }).click();
    await expect(page.locator('.auth-card').getByRole('alert')).toContainText('teacher login');
    // Missing/invalid provider proofs and cancellation never create accounts.
    for (const invalid of ['nonce', 'audience', 'unverified']) {
      scenario = { email: `invalid-${nonce}@example.test`, subject: 'invalid-' + nonce, cancel: false, invalid };
      await begin('Google'); await expect(page.locator('.auth-card').getByRole('alert')).toContainText('could not be verified');
    }
    scenario = { email: newEmail, subject: 'new-' + nonce, cancel: true, invalid: '' };
    await begin('Google'); await expect(page.locator('.auth-card').getByRole('alert')).toContainText('cancelled');
    expect(await db.collection('users').countDocuments({ email: `invalid-${nonce}@example.test` })).toBe(0);
    // Exercise browser binding, one-time redemption, expiry and server-side account safeguards through actual HTTP.
    const api = async (endpoint: string, data: unknown) => {
      const response = await fetch(stack!.nodeAUrl + '/api/v1/auth/social' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000) });
      return { status: response.status, body: await response.json() };
    };
    const ready = async (name: 'google' | 'apple', role: string, email: string, subject: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const start = await api('/' + name + '/start', { role, challenge: createHash('sha256').update(verifier).digest('hex') }); expect(start.status).toBe(200);
      const authorization = new URL(start.body.data.authorizationUrl);
      const local = new URL(provider.origin + '/' + name + '/authorize'); local.search = authorization.search; local.searchParams.set('fixture_email', email); local.searchParams.set('fixture_subject', subject);
      const html = await (await fetch(local)).text();
      const code = html.match(/name="code" value="([^"]+)"/)![1];
      const query = new URLSearchParams({ code, state: authorization.searchParams.get('state')! });
      const callbackUrl = stack!.nodeAUrl + '/api/v1/auth/social/' + name + '/callback';
      const callback = await fetch(name === 'google' ? callbackUrl + '?' + query : callbackUrl, { method: name === 'google' ? 'GET' : 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, ...(name === 'apple' ? { body: query.toString() } : {}), redirect: 'manual' });
      expect(callback.status).toBe(303);
      const ticket = new URLSearchParams(new URL(callback.headers.get('location')!).hash.slice(1)).get('ticket')!; expect(ticket).toBeTruthy();
      const replay = await fetch(callbackUrl + '?' + query, { redirect: 'manual' }); expect(replay.headers.get('location')).toContain('error=failed');
      return { ticket, verifier };
    };
    const handoff = await ready('google', 'student', newEmail, 'new-' + nonce);
    expect((await api('/exchange', { ...handoff, verifier: randomBytes(32).toString('base64url') })).status).toBe(401);
    const concurrent = await Promise.all([api('/exchange', handoff), api('/exchange', handoff)]);
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await api('/exchange', handoff)).status).toBe(401);
    const signedIn = concurrent.find(result => result.status === 200)!.body.data;
    expect(JSON.stringify(signedIn)).not.toContain('unused-provider-access-token');
    expect(JSON.stringify(signedIn)).not.toContain('googleSubject');
    const refreshed = await fetch(stack.nodeAUrl + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: signedIn.refreshToken }) });
    expect(refreshed.status).toBe(200);
    const refreshedSession = (await refreshed.json()).data;
    const me = await fetch(stack.nodeAUrl + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + refreshedSession.accessToken } });
    expect(me.status).toBe(200);
    const logout = await fetch(stack.nodeAUrl + '/api/v1/auth/logout-all', { method: 'POST', headers: { authorization: 'Bearer ' + refreshedSession.accessToken } });
    expect(logout.status).toBe(204);
    expect((await fetch(stack.nodeAUrl + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + refreshedSession.accessToken } })).status).toBe(401);

    const expired = await ready('google', 'student', newEmail, 'new-' + nonce);
    await db.collection('social_auth_flows').updateOne({ ticketHash: createHash('sha256').update(expired.ticket).digest('hex') }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api('/exchange', expired)).status).toBe(401);
    // Matching email alone never links a different provider identity.
    const collision = await ready('apple', 'student', newEmail, 'collision-' + nonce);
    expect((await api('/exchange', collision)).status).toBe(409);
    expect((await db.collection('users').findOne({ email: newEmail }))?.appleSubject).toBeUndefined();
    const adminFlow = await ready('google', 'teacher', adminEmail, 'admin-' + nonce);
    expect((await api('/exchange', { ...adminFlow, email: adminEmail, password: 'Password@12345' })).status).toBe(401);
    expect((await db.collection('users').findOne({ email: adminEmail }))?.googleSubject).toBeUndefined();
    const replacement = await ready('apple', 'teacher', relayEmail, 'different-apple-' + nonce);
    expect((await api('/exchange', { ...replacement, email: teacherEmail, password: 'Password@12345' })).status).toBe(409);
    expect((await db.collection('users').findOne({ email: teacherEmail }))?.appleSubject).toBe('teacher-apple-' + nonce);
    const attempts = await ready('google', 'teacher', teacherEmail, 'unlinked-google-' + nonce);
    for (let index = 0; index < 5; index++) expect((await api('/exchange', { ...attempts, email: teacherEmail, password: 'WrongPassword123' })).status).toBe(401);
    const exhausted = await api('/exchange', { ...attempts, email: teacherEmail, password: 'Password@12345' });
    expect(exhausted.status).toBe(401); expect(exhausted.body.message).toContain('expired');
    const disabled = await ready('google', 'student', newEmail, 'new-' + nonce);
    await db.collection('users').updateOne({ email: newEmail }, { $set: { disabled: true } });
    expect((await api('/exchange', disabled)).status).toBe(401);
    expect((await api('/google/start', { role: 'admin', challenge: 'a'.repeat(64) })).status).toBe(400);
    // Unique provider indexes prevent one identity being bound to multiple accounts.
    await expect(db.collection('users').insertOne({ email: 'duplicate-' + nonce + '@example.test', googleSubject: 'new-' + nonce })).rejects.toMatchObject({ code: 11000 });
    const audit = await db.collection('audit_logs').find({ action: /^auth.social./, targetId: teacher!._id.toString() }).toArray();
    expect(audit.some(entry => entry.action === 'auth.social.link')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('Password@12345'); expect(JSON.stringify(audit)).not.toContain('unused-provider-access-token');
    expect(provider.requests.some(entry => entry.provider === 'google')).toBe(true); expect(provider.requests.some(entry => entry.provider === 'apple')).toBe(true);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await stack?.stop(); await connection.close(); await provider.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
