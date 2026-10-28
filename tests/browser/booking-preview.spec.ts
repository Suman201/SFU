import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('apps/frontend/dist/frontend/browser');
let server: Server;
let origin = '';
test.beforeAll(async () => {
  if (!existsSync(path.join(dist, 'index.html')))
    throw new Error(
      'Build the frontend before testing the static booking flow.',
    );
  server = createServer((req, res) => {
    const relative = decodeURIComponent(
      new URL(req.url!, 'http://localhost').pathname,
    );
    let file = path.resolve(dist, '.' + relative);
    if (!file.startsWith(dist + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile())
      file = path.join(dist, 'index.html');
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
    };
    res.setHeader(
      'Content-Type',
      types[path.extname(file)] || 'application/octet-stream',
    );
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function assertNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function shots(page: Page, name: string, project: string) {
  const folder = process.env.BOOKING_UI_OUTPUT || test.info().outputPath('ui');
  await mkdir(folder, { recursive: true });
  await page.screenshot({
    path: path.join(folder, `${project}-${name}.png`),
    fullPage: true,
  });
}
test('static lesson, timezone, declined card, retry and confirmation without server writes', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      writes.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/booking');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Start with the right lesson.',
  );
  await expect(
    page.getByText('A preview of booking on Sapiovian.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '3 Payment' })).toBeDisabled();
  await page.getByRole('radio', { name: /Introductory lesson/ }).check();
  await page
    .getByRole('textbox', { name: 'Learning goal' })
    .fill('Practise algebra and build confidence.');
  await expect(
    page.getByRole('complementary', { name: 'Lesson summary' }),
  ).toContainText('€15.00');
  await shots(page, '01-lesson', info.project.name);
  await page
    .getByRole('button', { name: 'Choose a time', exact: false })
    .click();
  await expect(
    page.getByRole('button', { name: /Continue to payment/ }),
  ).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Your timezone' })
    .selectOption('Europe/Berlin');
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page
    .getByRole('group', { name: 'Available times', exact: true })
    .getByRole('button')
    .first()
    .click();
  const first = await page
    .getByRole('group', { name: 'Available times', exact: true })
    .getByRole('button', { pressed: true })
    .innerText();
  await page
    .getByRole('combobox', { name: 'Your timezone' })
    .selectOption('America/New_York');
  await expect(
    page
      .getByRole('group', { name: 'Available times', exact: true })
      .getByRole('button', { pressed: true }),
  ).not.toHaveText(first);
  await page
    .getByRole('combobox', { name: 'Your timezone' })
    .selectOption('Europe/Berlin');
  await expect(
    page
      .getByRole('group', { name: 'Available times', exact: true })
      .getByRole('button', { pressed: true }),
  ).toHaveText(first);
  await page
    .getByRole('button', { name: 'Previous week', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Continue to payment/ }),
  ).toBeDisabled();
  await page
    .getByRole('group', { name: 'Available times', exact: true })
    .getByRole('button')
    .last()
    .click();
  await shots(page, '02-time', info.project.name);
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'One last look.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Card number', exact: true }),
  ).not.toBeEditable();
  await page.getByRole('button', { name: '← Change date & time' }).click();
  await page
    .getByRole('group', { name: 'Choose a date', exact: true })
    .getByRole('button')
    .nth(1)
    .click();
  await expect(page.getByRole('button', { name: '3 Payment' })).toBeDisabled();
  await page
    .getByRole('group', { name: 'Available times', exact: true })
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await shots(page, '03-payment', info.project.name);
  await page
    .getByRole('combobox', { name: 'Choose a sample card' })
    .selectOption('declined');
  await page.getByRole('button', { name: /Preview payment/ }).click();
  await expect(page.getByRole('alert')).toContainText(
    'sample card was declined',
  );
  await page
    .getByRole('combobox', { name: 'Choose a sample card' })
    .selectOption('success');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: /Preview payment/ }).click();
  await expect(
    page.getByRole('button', { name: /Processing preview/ }),
  ).toBeDisabled();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your lesson, all planned out.',
  );
  await expect(
    page.getByText(
      'No money was charged and this lesson has not been reserved.',
      { exact: false },
    ),
  ).toBeVisible();
  await shots(page, '04-confirmation', info.project.name);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download preview summary/ }).click();
  const download = await downloaded;
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('Actual amount charged: €0.00');
  expect(text).not.toContain('4242');
  expect(text).not.toContain('jamie@example.com');
  await page.getByRole('button', { name: 'Start another preview' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Start with the right lesson.',
  );
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await assertNoOverflow(page);
});

test('mobile and dark payment UI validates fields and keeps billing data out of storage', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    localStorage.setItem('native-sfu-theme', 'dark'),
  );
  await page.goto(origin + '/booking');
  await assertNoOverflow(page);
  await page.getByRole('button', { name: /Choose a time/ }).click();
  await page
    .getByRole('group', { name: 'Available times', exact: true })
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await assertNoOverflow(page);
  await shots(page, '05-mobile-payment-dark', info.project.name);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('');
  await page.getByRole('button', { name: /Preview payment/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'One last look.',
  );
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Preview Learner');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill('invalid');
  await page.getByRole('button', { name: /Preview payment/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'One last look.',
  );
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill('preview-learner@example.com');
  await page.getByRole('button', { name: /Preview payment/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your lesson, all planned out.',
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(storage).not.toContain('Preview Learner');
  expect(storage).not.toContain('preview-learner@example.com');
  await assertNoOverflow(page);
  await shots(page, '06-mobile-confirmation-dark', info.project.name);
  await page.setViewportSize({ width: 320, height: 750 });
  await assertNoOverflow(page);
});

test('calendar navigation returns to the original week across a UTC date boundary', async ({
  browser,
}) => {
  const context = await browser.newContext({
    timezoneId: 'Pacific/Kiritimati',
  });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/booking');
    await page.getByRole('button', { name: /Choose a time/ }).click();
    const calendar = page.getByRole('group', {
      name: 'Choose a date',
      exact: true,
    });
    const first = await calendar
      .getByRole('button')
      .first()
      .getAttribute('aria-label');
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Next week', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Previous week', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Previous week', exact: true })
      .click();
    await expect(calendar.getByRole('button').first()).toHaveAttribute(
      'aria-label',
      first!,
    );
    await expect(
      page.getByRole('button', { name: 'Previous week', exact: true }),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});

test('teacher profile links to a preview with the same teacher and handles unavailable profiles', async ({
  page,
}) => {
  const id = '000000000000000000000123';
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.endsWith(`/teachers/${id}/profile`))
      return route.fulfill({
        json: {
          id,
          displayName: 'Maya Reed',
          headline: 'Physics for curious learners',
          languages: ['English'],
          skills: [],
          credentials: [],
          education: [],
          experience: [],
          socialLinks: [],
          gallery: [],
          demoClasses: [],
          batches: [],
          availability: 'Weekday afternoons',
          timezone: 'Europe/London',
        },
      });
    if (url.endsWith('/teaching-catalog'))
      return route.fulfill({
        json: { categories: [], subjects: [], curricula: [] },
      });
    return route.fulfill({
      status: 404,
      json: { message: 'Unavailable fixture' },
    });
  });
  await page.goto(origin + '/teachers/' + id);
  await page.getByRole('link', { name: /Preview booking/ }).click();
  await expect(page).toHaveURL(origin + '/teachers/' + id + '/book');
  await expect(
    page.getByRole('heading', { name: 'Maya Reed', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('complementary')).not.toContainText(
    'Alex Morgan',
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Maya Reed', exact: true }),
  ).toBeVisible();
  await page.goto(origin + '/teachers/000000000000000000000999/book');
  await expect(
    page.getByRole('heading', { name: 'Teacher unavailable' }),
  ).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
});
