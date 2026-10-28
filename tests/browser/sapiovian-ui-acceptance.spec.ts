import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  startAcceptanceStack,
  seedClassroom,
  login,
} from './helpers/whiteboard-classroom';

test('global discovery and teacher/student UI work with the real backend', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const evidence =
    process.env.SFU_UI_EVIDENCE_DIR ?? testInfo.outputPath('ui-evidence');
  await mkdir(evidence, { recursive: true });
  const stack = await startAcceptanceStack({
    frontendPort: 4462,
    backendPort: 3362,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const checks: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const capture = async (name: string) => {
    await page.screenshot({
      path: path.join(evidence, `${name}.png`),
      fullPage: true,
    });
  };
  const noOverflow = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  try {
    const teacher = await login(
      stack.nodeAUrl,
      'teacher.one@example.com',
      'Password@12345',
    );
    const updated = await fetch(`${stack.nodeAUrl}/api/v1/profile/me`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${teacher.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        displayName: 'Avery Morgan',
        headline: 'Build confidence in English, one conversation at a time.',
        bio: 'Patient, practical lessons shaped around your goals. This is an isolated UI acceptance profile.',
        skills: ['English', 'Conversation', 'Writing'],
        languages: ['English', 'Spanish'],
        location: 'London, United Kingdom',
        timezone: 'Europe/London',
        availability: 'Weekday evenings',
        publicProfileEnabled: true,
        credentials: [
          { title: 'English language teaching', issuer: 'Test profile' },
        ],
      }),
    });
    expect(updated.ok).toBe(true);
    await seedClassroom();

    await page.goto(stack.frontendBaseUrl);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Find the right teacher. Learn from anywhere.',
    );
    await expect(page.locator('.hero-banner img')).toBeVisible();
    await page
      .locator('.hero-banner img')
      .evaluate((img: HTMLImageElement) => img.decode());
    await expect(
      page.getByRole('navigation', { name: 'Browse by subject' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Sapiovian home' }),
    ).toContainText('Your curiosity. Their calling.');
    await page
      .locator('header sfu-brand-mark img')
      .evaluate((img: HTMLImageElement) => img.decode());
    await page
      .locator('.classroom-preview img')
      .evaluate((img: HTMLImageElement) => img.decode());
    await expect(page.locator('main')).not.toContainText('Digital India');
    await expect(page.locator('main')).not.toContainText('10,000+');
    await noOverflow();
    await capture('home-desktop');
    await page.screenshot({ path: path.join(evidence, 'home-preview.png') });
    checks.push(
      'Global homepage renders without fabricated statistics or overflow',
    );

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'How it works' })
      .click();
    await expect
      .poll(() =>
        page
          .locator('#how-it-works')
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      )
      .toBe(96);
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'For teachers' })
      .click();
    await expect
      .poll(() =>
        page
          .locator('#for-teachers')
          .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
      )
      .toBe(96);
    await page.getByRole('link', { name: 'Sapiovian home' }).click();
    checks.push(
      'Homepage navigation scrolls to the correct section below the sticky header',
    );

    await page.getByLabel('What would you like to learn?').fill('English');
    const searchResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/teachers?') &&
        response.url().includes('q=English') &&
        response.ok(),
    );
    await page
      .getByRole('button', { name: 'Find a teacher', exact: false })
      .click();
    const result = await searchResponse;
    expect(result.headers()['content-type']).toContain('application/json');
    await expect(page).toHaveURL(/\/teachers\?q=English/);
    await expect(page.getByLabel('What would you like to learn?')).toHaveValue(
      'English',
    );
    await expect(
      page.getByRole('heading', { name: 'Avery Morgan', exact: true }),
    ).toBeVisible();
    await noOverflow();
    await capture('teachers-desktop');
    checks.push(
      'Homepage search reaches the real teacher API and returns published profile',
    );

    await page
      .getByLabel('What would you like to learn?')
      .fill('no-such-subject-acceptance');
    await page.getByRole('button', { name: 'Find teachers' }).click();
    await expect(
      page.getByRole('heading', { name: 'No teachers match this search' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Explore all teachers' }).click();
    await expect(
      page.getByRole('heading', { name: 'Avery Morgan', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel('What would you like to learn?')).toHaveValue(
      'no-such-subject-acceptance',
    );
    await page.goBack();
    await expect(page.getByLabel('What would you like to learn?')).toHaveValue(
      'English',
    );
    checks.push('Search, empty state, reset and browser history stay aligned');

    await page
      .getByRole('heading', { name: 'Avery Morgan', exact: true })
      .getByRole('link')
      .click();
    await expect(
      page.getByRole('heading', { name: 'Avery Morgan', exact: true }),
    ).toBeVisible();
    await noOverflow();
    await capture('teacher-profile');
    checks.push('Discovery opens the real teacher profile');

    await page.goto(`${stack.frontendBaseUrl}/student/login`);
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await capture('login-desktop');
    await page
      .getByLabel('Email', { exact: true })
      .fill('student.one@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'My learning', exact: true }),
    ).toBeVisible();
    await noOverflow();
    await capture('student-dashboard');
    await expect(
      page
        .locator('main > section')
        .nth(2)
        .getByRole('heading', { name: 'Your upcoming classes' }),
    ).toBeVisible();
    checks.push('Real student sign-in and upcoming-class-first dashboard');

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${stack.frontendBaseUrl}/teacher/login`);
    await page
      .getByLabel('Email', { exact: true })
      .fill('teacher.one@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Password@12345');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'My teaching', exact: true }),
    ).toBeVisible();
    await noOverflow();
    await capture('teacher-dashboard');
    checks.push('Real teacher sign-in and teaching dashboard');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();

    await page.goto(`${stack.frontendBaseUrl}/register`);
    await expect(page.getByLabel('Your name')).toHaveValue('');
    await expect(page.getByLabel('Email address')).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await noOverflow();
    await capture('register-desktop');
    checks.push('Account creation has no prefilled demo identity or password');

    await page.goto(stack.frontendBaseUrl);
    await page.getByRole('button', { name: /dark/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await noOverflow();
    await capture('home-dark');
    await page.getByRole('button', { name: /light/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(stack.frontendBaseUrl);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await noOverflow();
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(
        page.getByRole('navigation', { name: 'Primary' }),
      ).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link')
        .first()
        .focus();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Menu', exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole('navigation', { name: 'Primary' }),
      ).not.toBeVisible();
      if (width === 390) {
        await capture('home-mobile');
        await page.screenshot({
          path: path.join(evidence, 'home-mobile-preview.png'),
        });
      }
      await page.goto(`${stack.frontendBaseUrl}/teachers?q=English`);
      await expect(
        page.getByRole('heading', { name: 'Avery Morgan', exact: true }),
      ).toBeVisible();
      await noOverflow();
      if (width === 390) await capture('teachers-mobile');
      await page.goto(`${stack.frontendBaseUrl}/student/login`);
      await noOverflow();
      await page.goto(`${stack.frontendBaseUrl}/register`);
      await noOverflow();
    }
    checks.push(
      'Light/dark themes and 768/390/320px layouts; accessible mobile menu',
    );
    // Exercise the production desktop renderer and its actual local proxy without
    // launching Electron. Authentication and class data still use the real backend.
    if (process.env.SFU_UI_DESKTOP_DIR) {
      const { startServer } = await import('../../apps/desktop/src/server.cjs');
      const desktopServer = await startServer({
        frontendDir: process.env.SFU_UI_DESKTOP_DIR,
        backendOrigin: stack.nodeAUrl,
        websiteOrigin: stack.frontendBaseUrl,
      });
      try {
        for (const role of ['teacher', 'student']) {
          const desktopContext = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            colorScheme: 'light',
          });
          const desktopPage = await desktopContext.newPage();
          desktopPage.on('pageerror', (error) => errors.push(error.message));
          try {
            await desktopPage.goto(desktopServer.origin);
            await expect(desktopPage).toHaveTitle('Sapiovian Classroom');
            await expect(desktopPage.locator('sfu-brand-logo')).toContainText(
              'Your curiosity. Their calling.',
            );
            for (const img of await desktopPage
              .locator('sfu-brand-logo img')
              .all())
              await img.evaluate((el: HTMLImageElement) => el.decode());
            if (role === 'teacher')
              await desktopPage.screenshot({
                path: path.join(evidence, 'desktop-login.png'),
              });
            await desktopPage
              .getByLabel('Email', { exact: true })
              .fill(`${role}.one@example.com`);
            await desktopPage
              .getByLabel('Password', { exact: true })
              .fill('Password@12345');
            await desktopPage
              .getByRole('button', { name: 'Sign in', exact: true })
              .click();
            await expect(
              desktopPage.getByRole('heading', {
                name: 'Upcoming classes',
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              desktopPage
                .locator('header')
                .getByRole('img', { name: 'Sapiovian' }),
            ).toBeVisible();
            await desktopPage.screenshot({
              path: path.join(evidence, `desktop-${role}-upcoming.png`),
            });
            await desktopPage
              .getByRole('link', { name: 'Recordings', exact: true })
              .click();
            await expect(
              desktopPage.getByRole('heading', {
                name: 'Recordings',
                exact: true,
              }),
            ).toBeVisible();
            await desktopPage
              .getByRole('link', { name: 'Settings', exact: true })
              .click();
            await desktopPage
              .getByLabel('Appearance', { exact: true })
              .selectOption('dark');
            await expect(desktopPage.locator('html')).toHaveAttribute(
              'data-theme',
              'dark',
            );
            await expect(desktopPage.locator('.desktop-header')).toHaveCSS(
              'background-color',
              'rgb(26, 43, 35)',
            );
            await expect(
              desktopPage.locator('.desktop-header .wordmark'),
            ).toHaveCSS('filter', 'brightness(0) invert(1)');
            await desktopPage.screenshot({
              path: path.join(evidence, `desktop-${role}-dark.png`),
            });
            await desktopPage
              .getByRole('button', { name: 'Sign out', exact: true })
              .click();
            await expect(
              desktopPage.getByRole('heading', { name: 'Welcome back' }),
            ).toBeVisible();
            await expect(desktopPage.locator('.login-card')).toHaveCSS(
              'background-color',
              'rgb(26, 43, 35)',
            );
            if (role === 'teacher')
              await desktopPage.screenshot({
                path: path.join(evidence, 'desktop-login-dark.png'),
              });
          } finally {
            await desktopContext.close();
          }
        }
        checks.push(
          'Built desktop renderer: real teacher/student sign-in, shared branding, upcoming classes, recordings, dark settings and sign-out; Electron remained closed',
        );
      } finally {
        await desktopServer.close();
      }
    }
    expect(errors).toEqual([]);
    await writeFile(
      path.join(evidence, 'validation.json'),
      JSON.stringify(
        {
          backend: 'real NestJS, MongoDB, Redis; no HTTP mocks',
          checks,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await capture('failure').catch(() => undefined);
    await writeFile(path.join(evidence, 'failure-log.txt'), stack.getLogs());
    throw error;
  } finally {
    await context.close();
    await stack.stop();
  }
});
