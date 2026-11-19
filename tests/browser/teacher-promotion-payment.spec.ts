import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { startAdminTestServer } from './helpers/admin-test-server';
import { login, startAcceptanceStack } from './helpers/whiteboard-classroom';

test('manual receipt and approval independently gate marketplace visibility', async ({ browser, page, request }, info) => {
  test.setTimeout(150_000);
  const stack = await startAcceptanceStack({
    frontendPort: 4466, backendPort: 3366, frontendDir: 'apps/frontend/dist/frontend/browser'
  });
  let adminServer: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  const email = `promotion-${randomUUID()}@example.test`;
  const reference = 'TRANSFER-0015';
  try {
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    let teacherId: string;
    try {
      const users = connection.collection('users');
      const template = await users.findOne({ email: 'teacher.one@example.com' });
      if (!template) throw new Error('Missing seeded teacher');
      const teacher = await users.insertOne({
        ...template, _id: new mongoose.Types.ObjectId(), email, displayName: 'Avery Morgan',
        headline: 'Mathematics tutor', bio: 'Maths lessons for teens.', publicProfileEnabled: true,
        tutorReviewStatus: 'approved', refreshTokenIds: []
      });
      teacherId = teacher.insertedId.toString();
    } finally {
      await connection.close();
    }
    const teacher = await login(stack.nodeAUrl, email, 'Password@12345');
    const admin = await login(stack.nodeAUrl, 'admin@example.com', 'Password@12345');
    const api = stack.nodeAUrl + '/api/v1';
    const promoted = async () => {
      const res = await request.get(api + '/teachers?limit=100&search=Avery');
      expect(res.ok()).toBe(true);
      const body = await res.json();
      const card = (body.data ?? body).teachers.find((item: { teacherId: string }) => item.teacherId === teacherId);
      expect(card).toBeDefined();
      return card.promoted;
    };
    await page.addInitScript(token => sessionStorage.setItem('native-sfu.auth.accessToken', token), teacher.accessToken);
    await page.goto(stack.frontendBaseUrl + '/teacher/profile');
    const tab = page.getByRole('button', { name: 'Promotions', exact: true });
    await tab.click();
    await page.getByRole('radio', { name: /Search boost/ }).check();
    const saved = page.waitForResponse(r => r.url().endsWith('/teachers/me/promotions/request') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Request paid promotion' }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json();
    const campaign = body.data ?? body;
    expect(campaign).toMatchObject({ feeCents: 1500, currency: 'EUR', billingStatus: 'pending', status: 'requested' });
    const action = (name: string, data: object, token = admin.accessToken) => request.post(
      api + '/admin/teacher-promotions/' + campaign.promotionId + '/' + name,
      { headers: { authorization: 'Bearer ' + token }, data }
    );
    expect((await action('approve', { billingStatus: 'paid' })).status()).toBe(409);
    expect((await action('confirm-payment', { feeCents: 1500, paymentReference: reference }, teacher.accessToken)).status()).toBe(403);
    expect((await action('confirm-payment', { feeCents: 100, paymentReference: reference })).status()).toBe(400);
    expect(await promoted()).toBe(false);

    adminServer = await startAdminTestServer(stack.nodeAUrl);
    const adminPage = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    try {
      await adminPage.addInitScript(token => sessionStorage.setItem('native-sfu.admin.auth.accessToken', token), admin.accessToken);
      await adminPage.goto(adminServer.origin + '/teacher-promotions');
      const row = adminPage.getByRole('row').filter({ hasText: campaign.promotionId });
      const approve = row.getByRole('button', { name: 'Approve' });
      await expect(approve).toBeDisabled();
      await row.getByRole('button', { name: 'Confirm payment' }).click();
      const dialog = adminPage.getByRole('dialog', { name: 'Confirm payment received' });
      await expect(dialog).toContainText('€15.00');
      await dialog.getByRole('textbox', { name: 'Payment reference' }).fill(reference);
      await dialog.screenshot({ path: info.outputPath('admin-confirm-payment.png') });
      await dialog.getByRole('button', { name: 'Confirm receipt' }).click();
      await expect(row).toContainText('Payment confirmed');
      expect(await promoted()).toBe(false);
      const retry = await action('confirm-payment', { feeCents: 1500, paymentReference: reference });
      expect(retry.ok()).toBe(true);
      expect((await action('confirm-payment', { feeCents: 1500, paymentReference: 'OTHER' })).status()).toBe(409);
      await adminPage.reload();
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(row).toContainText('active');
      expect(await promoted()).toBe(true);
      await page.reload();
      await tab.click();
      const history = page.locator('.promotion-history');
      await expect(history).toContainText('€15');
      await expect(history).toContainText('Payment confirmed');
      await expect(history).toContainText(reference);
      await history.screenshot({ path: info.outputPath('teacher-payment-history.png') });
      await row.getByRole('button', { name: 'Pause' }).click();
      await expect(row).toContainText('paused');
      expect(await promoted()).toBe(false);

      const tomorrow = Date.now() + 86_400_000;
      const future = await request.post(api + '/teachers/me/promotions/request', {
        headers: { authorization: 'Bearer ' + teacher.accessToken },
        data: { placement: 'profile_badge', startsAt: new Date(tomorrow), endsAt: new Date(tomorrow + 86_400_000) }
      });
      expect(future.ok(), await future.text()).toBe(true);
      const futureBody = await future.json();
      const futureCampaign = futureBody.data ?? futureBody;
      expect(futureCampaign.feeCents).toBe(500);
      const futureAdminUrl = api + '/admin/teacher-promotions/' + futureCampaign.promotionId;
      const adminHeaders = { authorization: 'Bearer ' + admin.accessToken };
      const confirm = (ref: string) => request.post(futureAdminUrl + '/confirm-payment', {
        headers: adminHeaders, data: { feeCents: 500, paymentReference: ref }
      });
      const receipts = await Promise.all([confirm('BANK-A'), confirm('BANK-B')]);
      expect(receipts.map(r => r.status()).sort()).toEqual([201, 409]);
      const winningRef = receipts[0].ok() ? 'BANK-A' : 'BANK-B';
      expect((await confirm(winningRef)).ok()).toBe(true);
      const scheduled = await request.post(futureAdminUrl + '/approve', { headers: adminHeaders, data: {} });
      expect(scheduled.ok(), await scheduled.text()).toBe(true);
      const scheduledBody = await scheduled.json();
      expect(scheduledBody.data ?? scheduledBody).toMatchObject({ status: 'scheduled', paymentReference: winningRef });
      expect(await promoted()).toBe(false);
    } finally {
      await adminPage.close();
    }
  } finally {
    await adminServer?.stop();
    await stack.stop();
  }
});
