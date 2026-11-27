import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { startAcceptanceStack } from './helpers/whiteboard-classroom';

test('students see each paid placement on its own surface', async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const stack = await startAcceptanceStack({
    frontendPort: 4466, backendPort: 3366, frontendDir: 'apps/frontend/dist/frontend/browser'
  });
  const teachers = [
    { name: 'Amelia Hart', placement: null, location: 'Dublin' },
    { name: 'Maya Vega', placement: 'profile_badge', location: 'Valencia' },
    { name: 'Yara Santos', placement: 'search_boost', location: 'Lisbon' },
    { name: 'Zoe Rivera', placement: 'marketplace_featured', location: 'Madrid' }
  ].map(teacher => ({ ...teacher, id: new mongoose.Types.ObjectId() }));
  const [organic, badge, boosted, featured] = teachers;
  const skill = 'Spanish for travel';
  const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
  try {
    await connection.collection('users').insertMany(teachers.map(({ id, name, location }) => ({
      _id: id, displayName: name, name, email: id + '@example.test', roles: ['TEACHER'], status: 'active',
      disabled: false, publicProfileEnabled: true, tutorReviewStatus: 'approved', location,
      headline: 'Conversational Spanish tutor', bio: 'Build fluency through everyday conversations.',
      skills: ['Conversation', 'Pronunciation', 'Spanish', skill], languages: ['English', 'Spanish']
    })));
    const now = Date.now();
    await connection.collection('teacher_promotions').insertMany(teachers.filter(t => t.placement).map(t => ({
      promotionId: randomUUID(), teacherId: t.id.toString(), placement: t.placement,
      status: 'active', billingStatus: 'paid', paymentConfirmedAt: new Date(now), approvedByUserId: 'test-admin',
      startsAt: new Date(now - 60_000), endsAt: new Date(now + 3_600_000)
    })));

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('native-sfu-theme', 'light'));
    await page.goto(stack.frontendBaseUrl + '/teachers');
    const grid = page.getByRole('region', { name: 'Teachers', exact: true });
    const fixtures = grid.locator('article.teacher-card').filter({ has: page.getByRole('link', {
      name: new RegExp(teachers.map(t => t.name).join('|'))
    }) });
    const card = (name: string) => fixtures.filter({ has: page.getByRole('link', { name, exact: true }) });
    const titles = fixtures.locator('h2');
    const featuredHeading = grid.getByRole('heading', { name: 'Featured teachers', exact: true });
    await expect(featuredHeading).toBeVisible();
    await expect(titles).toHaveText([featured.name, organic.name, badge.name, boosted.name]);
    await expect(card(featured.name)).toContainText('Featured');
    await expect(fixtures.locator('.promotion-badge')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('marketplace-featured.png') });

    await page.getByRole('searchbox').fill('Conversational Spanish');
    await page.getByRole('button', { name: 'Find teachers' }).click();
    await expect(titles).toHaveText([boosted.name, organic.name, badge.name, featured.name]);
    await expect(featuredHeading).toHaveCount(0);
    await expect(card(boosted.name)).toContainText('Sponsored');
    await expect(fixtures.locator('.promotion-badge')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('teacher-search-boost.png') });

    // A filter-only search must still paginate the sponsored and organic segments exactly once.
    const names: string[] = [];
    for (const pageNumber of [1, 2]) {
      const response = await request.get(stack.nodeAUrl + '/api/v1/teachers', {
        params: { skill, page: pageNumber, limit: 2 }
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      const results = body.data ?? body;
      expect(results.total).toBe(4);
      names.push(...results.teachers.map((t: { displayName: string }) => t.displayName));
    }
    expect(names).toEqual([boosted.name, organic.name, badge.name, featured.name]);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(featuredHeading).toBeVisible();
    await card(badge.name).getByRole('link', { name: 'View profile' }).click();
    await expect(page.getByRole('heading', { level: 1, name: badge.name })).toBeVisible();
    await expect(page.getByText('Sponsored profile', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('Sponsored profile', { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('public-profile-badge.png') });

    await connection.collection('teacher_promotions').updateOne({ teacherId: badge.id.toString() }, { $set: { status: 'paused' } });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: badge.name })).toBeVisible();
    await expect(page.getByText('Sponsored profile', { exact: true })).toHaveCount(0);
    for (const teacher of [featured, boosted]) {
      await page.goto(stack.frontendBaseUrl + '/teachers/' + teacher.id);
      await expect(page.getByRole('heading', { level: 1, name: teacher.name })).toBeVisible();
      await expect(page.getByText('Sponsored profile', { exact: true })).toHaveCount(0);
    }
  } finally {
    await connection.collection('teacher_promotions').deleteMany({ teacherId: { $in: teachers.map(t => t.id.toString()) } });
    await connection.collection('users').deleteMany({ _id: { $in: teachers.map(t => t.id) } });
    await connection.close();
    await stack.stop();
  }
});
