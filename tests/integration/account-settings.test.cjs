'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const bcrypt = require('bcrypt');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
async function until(check) { const end = Date.now() + 10000; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out waiting for account delivery.'); }
test('self-service account settings preserve identity and isolate device credentials', { timeout: 180000 }, async t => {
  const identities = new Map();
  const oauth = { enabled: () => true, authorizationUrl: (provider, state) => `https://${provider === 'google' ? 'accounts.google.com' : 'appleid.apple.com'}/auth?state=${state}`, exchange: async (provider, code) => ({ provider, ...identities.get(code) }) };
  const stack = await startBookingStack({ oauth }); t.after(() => stack.stop());
  const db = stack.connection.db, tokens = {};
  async function request(name, method, path, data, expected = method === 'POST' ? 201 : 200) {
    const response = await fetch(stack.origin + '/api/v1/' + path, { method, headers: { ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}), 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text(), body = text ? JSON.parse(text) : undefined;
    assert.equal(response.status, expected, path + ': ' + text); return body?.data ?? body;
  }
  async function login(name = 'student', password = stack.password, email = stack.users[name].email) { const value = await request('', 'POST', 'auth/login', { email, password }, 200); tokens[name] = value.accessToken; return value; }
  const jwt = value => JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
  const first = await login(); tokens.first = first.accessToken;
  const sibling = await login(); tokens.sibling = sibling.accessToken;
  await login('teacher'); await login('other');
  await t.test('account responses exclude credential material and updates cannot change privileges', async () => {
    const setup = require('../../scripts/setup-account-settings.cjs').setupAccountSettingsIndexes;
    const count = await db.collection('users').countDocuments(); await setup(stack.connection); await setup(stack.connection);
    assert.equal(await db.collection('users').countDocuments(), count);
    const account = await request('student', 'GET', 'account');
    assert.equal(account.profile.id, stack.users.student.id); assert.equal(account.security.hasPassword, true);
    assert.equal(account.security.googleLinked, false); assert.equal(account.security.emailDeliveryAvailable, false);
    assert.doesNotMatch(JSON.stringify(account), /passwordHash|googleSubject|appleSubject|refreshTokenHash/);
    await request('student', 'PATCH', 'account/profile', { roles: ['SUPER_ADMIN'], email: 'replacement@account.test' }, 400);
    await request('student', 'PATCH', 'account/profile', { timezone: 'Not/AZone' }, 400);
    await request('student', 'PATCH', 'account/profile', { displayName: 'Updated learner', timezone: 'Europe/London' });
    await request('student', 'PATCH', 'account/preferences', { notifications: { email: null } }, 400);
    await request('student', 'PATCH', 'account/preferences', { theme: 'light', locale: 'en_GB', notifications: { chatMessages: false } });
    await Promise.all([request('student', 'PATCH', 'account/preferences', { notifications: { announcements: false } }), request('student', 'PATCH', 'account/preferences', { privacy: { allowTeacherMessages: false } })]);
    const saved = await request('student', 'GET', 'account');
    assert.equal(saved.profile.settings.notifications.announcements, false); assert.equal(saved.profile.settings.privacy.allowTeacherMessages, false);
    assert.equal(saved.profile.settings.theme, 'light'); assert.equal(saved.profile.settings.locale, 'en-GB'); assert.equal(saved.profile.settings.notifications.chatMessages, false);
    assert.deepEqual(saved.profile.roles, ['STUDENT']);
    await request('teacher', 'PATCH', 'account/profile', { phone: '+441234567', timezone: 'Europe/Paris' });
    assert.equal((await db.collection('users').findOne({ email: stack.users.teacher.email })).tutorReviewStatus, 'approved');
  });
  let rotated;
  await t.test('refresh rotation preserves the device row and compares full-token digests', async () => {
    const before = await db.collection('sessions').findOne({ refreshTokenJti: jwt(first.accessToken).tokenId });
    rotated = await request('', 'POST', 'auth/refresh', { refreshToken: first.refreshToken }, 200); tokens.first = rotated.accessToken;
    assert.equal(jwt(rotated.accessToken).tokenId, jwt(first.accessToken).tokenId);
    assert.notEqual(rotated.refreshToken, first.refreshToken);
    const after = await db.collection('sessions').findOne({ _id: before._id });
    assert.equal(after.refreshTokenHashVersion, 1); assert.equal(after.refreshTokenHash, hash(rotated.refreshToken));
    assert.equal(await db.collection('sessions').countDocuments({ refreshTokenJti: jwt(first.accessToken).tokenId }), 1);
    await request('', 'POST', 'auth/refresh', { refreshToken: first.refreshToken }, 401);
    await request('first', 'GET', 'auth/me', undefined, 401);
    await request('sibling', 'GET', 'auth/me');
    await request('', 'POST', 'auth/refresh', { refreshToken: first.refreshToken }, 401);
    await request('sibling', 'GET', 'auth/me'); // Replaying a signed-out device never revokes other devices.
  });
  await t.test('refresh races cannot revive revoked devices or accept two rotations', async () => {
    const auth = stack.app.get(require('../../apps/backend/dist/auth/auth.service.js').AuthService);
    const device = await login('raceDevice', stack.password, stack.users.student.email), key = jwt(device.accessToken).tokenId;
    const original = auth.tokensForSession.bind(auth); let entered; let release;
    const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
    auth.tokensForSession = async (...args) => { const value = await original(...args); entered(); await gate; return value; };
    try {
      const pending = request('', 'POST', 'auth/refresh', { refreshToken: device.refreshToken }, 401);
      await ready;
      const row = await db.collection('sessions').findOne({ refreshTokenJti: key });
      await request('student', 'POST', 'account/sessions/' + row._id + '/revoke', {}, 200); release(); await pending;
      assert.ok((await db.collection('sessions').findOne({ _id: row._id })).revokedAt);
    } finally { release(); auth.tokensForSession = original; }
    const next = await login('raceDevice', stack.password, stack.users.student.email); let arrivals = 0; let unblock;
    const barrier = new Promise(resolve => unblock = resolve);
    auth.tokensForSession = async (...args) => { const value = await original(...args); if (++arrivals === 2) unblock(); await barrier; return value; };
    try {
      const responses = await Promise.all([1, 2].map(() => fetch(stack.origin + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: next.refreshToken }) })));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
      await request('raceDevice', 'GET', 'auth/me', undefined, 401); await request('student', 'GET', 'auth/me');
    } finally { unblock(); auth.tokensForSession = original; }
  });
  await t.test('legacy bcrypt refresh records migrate on the next valid refresh', async () => {
    const session = await login(); const key = jwt(session.accessToken).tokenId;
    await db.collection('sessions').updateOne({ refreshTokenJti: key }, { $set: { refreshTokenHash: await bcrypt.hash(session.refreshToken, 4) }, $unset: { refreshTokenHashVersion: '' } });
    const next = await request('', 'POST', 'auth/refresh', { refreshToken: session.refreshToken }, 200); tokens.student = next.accessToken;
    assert.equal((await db.collection('sessions').findOne({ refreshTokenJti: key })).refreshTokenHash, hash(next.refreshToken));
  });
  await t.test('session inspection and revocation are owner-scoped and close socket credentials', async () => {
    const mine = await request('student', 'GET', 'account/sessions'); assert.ok(mine.items.some(item => item.current));
    assert.doesNotMatch(JSON.stringify(mine), /refreshToken|tokenId|passwordHash/);
    const otherSessions = await request('other', 'GET', 'account/sessions');
    await request('student', 'POST', 'account/sessions/' + otherSessions.items[0].id + '/revoke', {}, 404);
    const siblingRow = mine.items.find(item => !item.current); assert.ok(siblingRow);
    const siblingDocument = await db.collection('sessions').findOne({ _id: new (require('mongoose').Types.ObjectId)(siblingRow.id) });
    await request('student', 'POST', 'account/sessions/' + siblingRow.id + '/revoke', {}, 200);
    const auth = stack.app.get(require('../../apps/backend/dist/auth/auth.service.js').AuthService);
    assert.deepEqual(await auth.revokedSocketSessions([{ socketId: 'revoked-device', userId: stack.users.student.id, tokenId: siblingDocument.refreshTokenJti, authVersion: 0 }, { socketId: 'current-device', userId: stack.users.student.id, tokenId: jwt(tokens.student).tokenId, authVersion: 0 }]), ['revoked-device']);
    await request('other', 'GET', 'auth/me');
  });
  let teacherPassword = stack.password;
  await t.test('provider linking requires the initiating account, device and proof; login cannot consume its ticket', async () => {
    const verifier = randomBytes(32).toString('base64url');
    await request('teacher', 'POST', 'account/providers/google/start', { currentPassword: 'WrongPassword@123', challenge: hash(verifier) }, 401);
    const start = await request('teacher', 'POST', 'account/providers/google/start', { currentPassword: teacherPassword, challenge: hash(verifier) }, 200);
    const state = new URL(start.authorizationUrl).searchParams.get('state'), code = randomUUID();
    identities.set(code, { subject: 'google-connected-teacher', email: 'provider-can-have-another-email@account.test', name: 'Provider name must not replace the teacher' });
    const callback = await fetch(stack.origin + '/api/v1/auth/social/google/callback?' + new URLSearchParams({ state, code }), { redirect: 'manual' });
    const location = new URL(callback.headers.get('location')); assert.equal(location.pathname, '/account/link-provider');
    const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket'); assert.ok(ticket);
    await request('', 'POST', 'auth/social/exchange', { ticket, verifier }, 401);
    await request('other', 'POST', 'account/providers/complete', { ticket, verifier }, 401);
    const initiatingToken = tokens.teacher;
    const second = await login('teacher'); tokens.teacherSecond = second.accessToken;
    await request('teacherSecond', 'POST', 'account/providers/complete', { ticket, verifier }, 401);
    tokens.teacher = initiatingToken;
    await request('teacher', 'POST', 'account/providers/complete', { ticket, verifier }, 204);
    await request('teacher', 'POST', 'account/providers/complete', { ticket, verifier }, 401);
    const teacher = await db.collection('users').findOne({ email: stack.users.teacher.email });
    assert.equal(teacher.googleSubject, 'google-connected-teacher'); assert.equal(teacher.displayName, 'Avery Morgan'); assert.equal(teacher.tutorReviewStatus, 'approved');
    const security = (await request('teacher', 'GET', 'account')).security; assert.equal(security.googleLinked, true); assert.doesNotMatch(JSON.stringify(security), /google-connected-teacher/);
  });
  const sent = []; let rejectOnce = true;
  const mail = stack.app.get(require('../../apps/backend/dist/notifications/email-notification.service.js').EmailNotificationService);
  mail.sendEmail = async input => { if (rejectOnce) { rejectOnce = false; return { delivered: 0 }; } sent.push(input); return { delivered: 1 }; };
  const config = stack.app.get(require('@nestjs/config').ConfigService);
  config.set('notifications.email.enabled', true); config.set('notifications.email.host', '127.0.0.1'); config.set('notifications.email.fromEmail', 'security@account.test'); config.set('passwordRecovery.webUrl', 'http://127.0.0.1:4485');
  const emails = stack.app.get(require('../../apps/backend/dist/account/account-email.service.js').AccountEmailService); await emails.onModuleInit();
  async function linkFor(email, after = 0) { return until(() => { const item = sent.slice(after).find(item => item.to === email && item.subject === 'Confirm your Sapiovian email address'); return item && /http:\/\/127\.0\.0\.1:4485\/account\/confirm-email#token=([a-f0-9]{64})/.exec(item.text)?.[1]; }); }
  async function resetCooldown() { await db.collection('account_email_jobs').updateOne({ _id: 'email:' + stack.users.student.id }, { $set: { requestedAt: new Date(0), windowStart: new Date(0) } }); }
  await t.test('verification retries mail, stores only hashes, enforces cooldown and verifies the existing address', async () => {
    await request('student', 'POST', 'account/email/request', { email: stack.users.student.email, currentPassword: stack.password }, 202);
    const token = await linkFor(stack.users.student.email);
    const job = await db.collection('account_email_jobs').findOne({ _id: 'email:' + stack.users.student.id });
    assert.equal(job.attempts, 2); assert.equal(job.tokenHash, hash(token)); assert.doesNotMatch(JSON.stringify(job), new RegExp(token));
    await request('student', 'POST', 'account/email/request', { email: stack.users.student.email, currentPassword: stack.password }, 429);
    await request('', 'POST', 'account/email/confirm', { token }, 200);
    await request('', 'POST', 'account/email/confirm', { token }, 400);
    assert.equal((await request('student', 'GET', 'account')).security.emailVerified, true);
    await request('student', 'GET', 'auth/me');
  });
  await t.test('cancelled or expired links cannot change sign-in details', async () => {
    await resetCooldown(); const after = sent.length;
    await request('student', 'POST', 'account/email/request', { email: 'cancelled-new@account.test', currentPassword: stack.password }, 202);
    const token = await linkFor('cancelled-new@account.test', after);
    await request('student', 'POST', 'account/email/cancel', {}, 204); await request('', 'POST', 'account/email/confirm', { token }, 400);
    assert.equal((await request('student', 'GET', 'account')).security.email, stack.users.student.email);
    await resetCooldown(); const expiredAfter = sent.length;
    await request('student', 'POST', 'account/email/request', { email: 'expired-new@account.test', currentPassword: stack.password }, 202);
    const expired = await linkFor('expired-new@account.test', expiredAfter);
    await db.collection('account_email_jobs').updateOne({ _id: 'email:' + stack.users.student.id }, { $set: { tokenExpiresAt: new Date(0) } });
    await request('', 'POST', 'account/email/confirm', { token: expired }, 400);
  });
  await t.test('email confirmation consumes once and signs out previous sessions', async () => {
    await resetCooldown(); const after = sent.length, target = 'confirmed-student@account.test';
    await request('student', 'POST', 'account/email/request', { email: target, currentPassword: stack.password }, 202);
    const token = await linkFor(target, after);
    assert.equal((await request('student', 'GET', 'auth/me')).email, stack.users.student.email);
    const responses = await Promise.all([fetch(stack.origin + '/api/v1/account/email/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), fetch(stack.origin + '/api/v1/account/email/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
    await request('student', 'GET', 'auth/me', undefined, 401); await request('other', 'GET', 'auth/me');
    await login('student', stack.password, target);
    assert.equal((await request('student', 'GET', 'account')).security.emailVerified, true);
    await until(() => sent.some(item => item.to === stack.users.student.email && item.subject === 'Your Sapiovian sign-in email was changed'));
  });
  await t.test('password changes and provider unlink revoke earlier account epochs', async () => {
    await request('teacher', 'POST', 'account/providers/google/unlink', { currentPassword: 'WrongPassword@123' }, 401);
    await request('teacher', 'POST', 'account/providers/google/unlink', { currentPassword: teacherPassword }, 204);
    await request('teacher', 'GET', 'auth/me', undefined, 401);
    await login('teacher'); assert.equal((await request('teacher', 'GET', 'account')).security.googleLinked, false);
    await request('teacher', 'POST', 'account/password', { currentPassword: teacherPassword, newPassword: 'short' }, 400);
    await request('teacher', 'POST', 'account/password', { currentPassword: teacherPassword, newPassword: '😀'.repeat(25) }, 400);
    teacherPassword = 'AccountChanged@12345';
    await request('teacher', 'POST', 'account/password', { currentPassword: stack.password, newPassword: teacherPassword }, 204);
    await request('teacher', 'GET', 'auth/me', undefined, 401);
    await login('teacher', teacherPassword);
    assert.equal((await db.collection('users').findOne({ email: stack.users.teacher.email })).tutorReviewStatus, 'approved');
  });
});
