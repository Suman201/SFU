import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ERROR_CATALOG,
  publicErrorCode,
  type AppErrorCode,
} from '@native-sfu/contracts';
import { startAdminTestServer } from './helpers/admin-test-server';

test('public admin-domain encyclopedia: all codes, search, deep links and backend-independent access', async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  // Real static admin release build, with a genuinely unavailable upstream. No HTTP response mocks.
  const server = await startAdminTestServer('http://127.0.0.1:9');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const output =
    process.env.ERROR_ENCYCLOPEDIA_UI_OUTPUT || info.outputPath('ui');
  await mkdir(output, { recursive: true });
  try {
    await context.addInitScript(() =>
      localStorage.setItem(
        'native-sfu.admin.auth.accessToken',
        'stale-admin-session',
      ),
    );
    const page = await context.newPage();
    const apiCalls: string[] = [],
      pageErrors: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/'))
        apiCalls.push(request.url());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(server.origin + '/error-encyclopedia');
    await expect(
      page.getByRole('heading', { name: 'Error Encyclopedia.', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.auth-loading')).toHaveCount(0);
    await expect(page.locator('.code-row')).toHaveCount(
      Object.keys(ERROR_CATALOG).length,
    );
    await page.screenshot({
      path: path.join(output, `${info.project.name}-encyclopedia-index.png`),
      fullPage: false,
    });
    await page
      .getByRole('searchbox', { name: 'Search error codes' })
      .fill(ERROR_CATALOG.NETWORK_ERROR.message);
    await expect(page.locator('.code-row')).toHaveCount(1);
    await page
      .getByRole('searchbox', { name: 'Search error codes' })
      .fill('network_error');
    await expect(page.locator('.code-row')).toHaveCount(1);
    await page.locator('.code-row').click();
    await expect(page).toHaveURL(server.origin + '/error-encyclopedia/SAP3001');
    await expect(
      page.getByRole('heading', {
        name: 'Network connection failed',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Debugging this error', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Page link' })).toHaveValue(
      server.origin + '/error-encyclopedia/SAP3001',
    );
    await page.screenshot({
      path: path.join(output, `${info.project.name}-network-error-guide.png`),
      fullPage: true,
    });
    await page.goto(
      server.origin +
        '/error-encyclopedia/SAP3001?requestId=private-occurrence&token=private-token',
    );
    await expect(
      page.getByRole('textbox', { name: 'Page link' }),
    ).not.toHaveValue(/private/);
    await expect(page.locator('main')).not.toContainText('private-occurrence');
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.locator('.copy-feedback')).toBeVisible(); // Success or selectable fallback on browsers that block clipboard.
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: 'Network connection failed',
        exact: true,
      }),
    ).toBeVisible();
    for (const reason of Object.keys(ERROR_CATALOG) as AppErrorCode[]) {
      const code = publicErrorCode(reason);
      await page.goto(`${server.origin}/error-encyclopedia/${code}`);
      await expect(page.locator('.guide-kicker code')).toHaveText(code);
      await expect(page.locator('#causes li')).toHaveCount(3);
      await expect(page.locator('#user-fixes li')).toHaveCount(3);
      await expect(page.locator('#developer-checks li')).toHaveCount(3);
      await expect(page.locator('.example pre')).toContainText(code);
      await expect(page.locator('.developer-reason')).toContainText(reason);
      await page.goto(`${server.origin}/error-encyclopedia/${reason}`);
      await expect(page.locator('.guide-kicker code')).toHaveText(code);
      await expect(
        page.getByRole('textbox', { name: 'Page link' }),
      ).toHaveValue(`${server.origin}/error-encyclopedia/${code}`);
    }
    await page.goto(server.origin + '/error-encyclopedia/SAP3001');
    await page
      .locator('.page-sections')
      .getByRole('link', { name: 'Developer checks', exact: true })
      .click();
    await expect(page.locator('#developer-checks h2')).toBeInViewport();
    const relatedLink = page
      .locator('.related-links a')
      .filter({ hasText: 'SAP3003' });
    await relatedLink.scrollIntoViewIfNeeded();
    const previousScroll = await page.evaluate(() => scrollY);
    await relatedLink.click();
    await expect(
      page.getByRole('heading', {
        name: 'Service is temporarily unavailable',
        exact: true,
      }),
    ).toBeInViewport();
    await page.goBack();
    await expect(page.locator('.guide-kicker code')).toHaveText('SAP3001');
    await expect
      .poll(() =>
        page.evaluate(
          (position) => Math.abs(scrollY - position) < 3,
          previousScroll,
        ),
      )
      .toBe(true);
    expect(apiCalls).toEqual([]);
    await page.goto(server.origin + '/error-encyclopedia/does-not-exist');
    await expect(
      page.getByRole('heading', { name: 'Code not found', exact: true }),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex',
    );
    await page
      .getByRole('link', { name: 'Browse all error codes', exact: true })
      .click();
    await page
      .getByRole('searchbox', { name: 'Search error codes' })
      .fill('unmatched-private-reference-0000');
    await expect(
      page.getByRole('heading', {
        name: 'No matching error codes',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Show all error codes', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Area', exact: true })
      .selectOption('Classroom & devices');
    await expect(page.locator('.code-row')).toHaveCount(4);
    await page.locator('.code-row').filter({ hasText: 'SAP5001' }).click();
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({
      path: path.join(output, `${info.project.name}-device-guide-dark.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(output, `${info.project.name}-guide-mobile.png`),
      fullPage: true,
    });
    await page.goto(server.origin + '/error-encyclopedia');
    await expect(page.locator('.code-row')).toHaveCount(
      Object.keys(ERROR_CATALOG).length,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(output, `${info.project.name}-index-mobile.png`),
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
    expect(apiCalls).toEqual([]);
  } finally {
    await context.close();
    await server.stop();
  }
});

test('existing errors link to public code descriptions while incident logs require admin sign-in', async ({
  browser,
}, info) => {
  const server = await startAdminTestServer('http://127.0.0.1:9');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.origin + '/errors');
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole('heading', { name: 'Sapiovian operations' }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Email', exact: true })
      .fill('admin@example.test');
    await page.getByLabel(/Password/).fill('Password@12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Error information' });
    const code = notice.locator('.notice-code');
    await expect(code).toContainText('Error code');
    await expect(code.getByRole('link')).toHaveAttribute(
      'href',
      server.origin + '/error-encyclopedia/SAP3003',
    );
    const output =
      process.env.ERROR_ENCYCLOPEDIA_UI_OUTPUT || info.outputPath('ui');
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: path.join(output, `${info.project.name}-visible-code-admin.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(code).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(output, `${info.project.name}-visible-code-mobile.png`),
      fullPage: true,
    });
    const [directGuide] = await Promise.all([
      page.waitForEvent('popup'),
      code.getByRole('link').click(),
    ]);
    await expect(directGuide.locator('.guide-kicker code')).toHaveText(
      'SAP3003',
    );
    await directGuide.close();
    await notice.getByRole('button', { name: 'View details' }).click();
    const link = page.getByRole('link', {
      name: 'Read this code in the Error Encyclopedia',
    });
    await expect(link).toHaveAttribute(
      'href',
      server.origin + '/error-encyclopedia/SAP3003',
    );
    const [guide] = await Promise.all([
      page.waitForEvent('popup'),
      link.click(),
    ]);
    await expect(
      guide.getByRole('heading', {
        name: 'Service is temporarily unavailable',
        exact: true,
      }),
    ).toBeVisible();
    await expect(guide.locator('.auth-loading')).toHaveCount(0);
    expect(new URL(guide.url()).search).toBe('');
    expect(new URL(guide.url()).origin).toBe(server.origin);
  } finally {
    await context.close();
    await server.stop();
  }
});
