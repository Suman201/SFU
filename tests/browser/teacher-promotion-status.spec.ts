import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { startAdminTestServer } from './helpers/admin-test-server';
import { login, startAcceptanceStack } from './helpers/whiteboard-classroom';

test('open teacher history and filtered admin queues follow the approved campaign window', async ({ browser, page, request }, info) => {
  test.setTimeout(120_000);
  const stack = await startAcceptanceStack({
    frontendPort: 4466, backendPort: 3366, frontendDir: 'apps/frontend/dist/frontend/browser'
  });
  let adminServer: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  const email = `history-${randomUUID()}@example.test`;
  const teacherId = new mongoose.Types.ObjectId();
  const db = mongoose.createConnection();
  try {
    await db.openUri(process.env.MONGODB_URI!);
    const users = db.collection('users');
    const template = await users.findOne({ email: 'teacher.one@example.com' });
    if (!template) throw new Error('Missing seeded teacher');
    await users.insertOne({
      ...template, _id: teacherId, email, displayName: 'Robin Taylor',
      publicProfileEnabled: true, tutorReviewStatus: 'approved', refreshTokenIds: []
    });
    const teacher = await login(stack.nodeAUrl, email, 'Password@12345');
    const admin = await login(stack.nodeAUrl, 'admin@example.com', 'Password@12345');
    await page.addInitScript(token => sessionStorage.setItem('native-sfu.auth.accessToken', token), teacher.accessToken);
    await page.goto(stack.frontendBaseUrl + '/teacher/profile');
    const promotions = page.getByRole('button', { name: 'Promotions', exact: true });
    await expect(promotions).toBeVisible();

    adminServer = await startAdminTestServer(stack.nodeAUrl);
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
    try {
      await context.addInitScript(token => sessionStorage.setItem('native-sfu.admin.auth.accessToken', token), admin.accessToken);
      const active = await context.newPage();
      const expired = await context.newPage();
      const queue = adminServer.origin + '/teacher-promotions';
      await Promise.all([active.goto(queue), expired.goto(queue)]);
      await active.getByRole('combobox', { name: 'Status' }).selectOption('active');
      await expired.getByRole('combobox', { name: 'Status' }).selectOption('expired');

      const api = stack.nodeAUrl + '/api/v1';
      const startsAt = Date.now() + 12_000;
      const submitted = await request.post(api + '/teachers/me/promotions/request', {
        headers: { authorization: 'Bearer ' + teacher.accessToken },
        data: { placement: 'profile_badge', startsAt: new Date(startsAt), endsAt: new Date(startsAt + 14_000) }
      });
      expect(submitted.ok(), await submitted.text()).toBe(true);
      const body = await submitted.json();
      const { promotionId } = body.data ?? body;
      const campaignUrl = api + '/admin/teacher-promotions/' + promotionId;
      const headers = { authorization: 'Bearer ' + admin.accessToken };
      const receipt = await request.post(campaignUrl + '/confirm-payment', {
        headers, data: { feeCents: 500, paymentReference: 'HISTORY-RECEIPT' }
      });
      expect(receipt.ok(), await receipt.text()).toBe(true);
      const approval = await request.post(campaignUrl + '/approve', { headers, data: {} });
      expect(approval.ok(), await approval.text()).toBe(true);

      async function applySearch(view: Page) {
        await view.getByRole('searchbox', { name: 'Search promotions' }).fill(promotionId);
        await view.getByRole('button', { name: 'Apply' }).click();
        await expect(view.locator('.table-footer')).toContainText('0 total');
        await expect(view.getByText('No teacher promotions match these filters.')).toBeVisible();
      }
      await Promise.all([applySearch(active), applySearch(expired), promotions.click()]);
      const history = page.locator('.promotion-history');
      const status = history.locator('article').filter({ hasText: promotionId }).locator('.status-pill');
      const activeRow = active.getByRole('row').filter({ hasText: promotionId });
      const expiredRow = expired.getByRole('row').filter({ hasText: promotionId });
      await expect(status).toHaveText('scheduled');
      // Draft edits are only applied when the admin submits the filters.
      await active.getByRole('searchbox', { name: 'Search promotions' }).fill('unapplied edit');
      await expect(status).toHaveText('active', { timeout: 18_000 });
      await expect(activeRow.locator('.data-pill')).toHaveText('active');
      await expect(active.locator('.table-footer')).toContainText('1 total');
      await expect(expiredRow).toHaveCount(0);
      await active.getByRole('searchbox', { name: 'Search promotions' }).fill(promotionId);
      await active.locator('.data-table-shell').screenshot({ path: info.outputPath('admin-campaign-active.png') });
      await history.screenshot({ path: info.outputPath('teacher-campaign-active.png') });

      await expect(status).toHaveText('expired', { timeout: 20_000 });
      await expect(expiredRow.locator('.data-pill')).toHaveText('expired');
      await expect(expired.locator('.table-footer')).toContainText('1 total');
      await expect(activeRow).toHaveCount(0);
      await expect(active.locator('.table-footer')).toContainText('0 total');
      for (const name of ['Approve', 'Pause', 'Cancel']) {
        await expect(expiredRow.getByRole('button', { name })).toBeDisabled();
      }
      await history.screenshot({ path: info.outputPath('teacher-campaign-expired.png') });
      await expired.locator('.data-table-shell').screenshot({ path: info.outputPath('admin-campaign-expired.png') });
    } finally {
      await context.close();
    }
  } finally {
    try {
      if (db.readyState === 1) {
        await db.collection('teacher_promotions').deleteMany({ teacherId: teacherId.toString() });
        await db.collection('users').deleteOne({ _id: teacherId });
      }
    } finally {
      await db.close();
      await adminServer?.stop();
      await stack.stop();
    }
  }
});
