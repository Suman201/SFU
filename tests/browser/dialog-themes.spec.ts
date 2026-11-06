import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { startAdminTestServer } from './helpers/admin-test-server';
import {
  createClassroomHarness,
  login,
  seedClassroom,
  startAcceptanceStack,
} from './helpers/whiteboard-classroom';

const frontendDir = 'apps/frontend/dist/frontend/browser';
const password = 'Password@12345';

test.use({ actionTimeout: 12_000 });
const themes = ['light', 'dark'] as const;

async function checkBounds(panel: Locator) {
  await expect(panel).toBeVisible();
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= -1 &&
          rect.right <= innerWidth + 1 &&
          rect.top >= -1 &&
          rect.bottom <= innerHeight + 1
        );
      }),
    )
    .toBe(true);
}

async function checkPanel(panel: Locator, appearance: (typeof themes)[number]) {
  await checkBounds(panel);
  await expect(panel.page().locator('html')).toHaveAttribute(
    'data-theme',
    appearance,
  );
  const colors = await panel.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const normalize = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color.trim();
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    return [
      normalize(getComputedStyle(element).backgroundColor),
      normalize(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--dialog-surface',
        ),
      ),
    ];
  });
  expect(colors[0]).toEqual(colors[1]);
}

async function setSystemTheme(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('native-sfu-theme', 'system'),
  );
}

test('web and admin dialogs and failures stay readable in both themes', async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const output = process.env.DIALOG_UI_OUTPUT || info.outputPath('ui');
  await mkdir(output, { recursive: true });
  const capture = (page: Page, label: string) =>
    page.screenshot({
      path: path.join(output, `${info.project.name}-${label}.png`),
    });
  const stack = await startAcceptanceStack({
    frontendPort: 4489,
    backendPort: 3389,
    frontendDir,
  });
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  let adminServer: Awaited<ReturnType<typeof startAdminTestServer>> | undefined;
  try {
    const fixture = await seedClassroom();
    const connection = await mongoose
      .createConnection(process.env.MONGODB_URI!)
      .asPromise();
    let teacherId: string;
    let scheduledAt: string;
    try {
      const db = connection.db!;
      const teacher = await db
        .collection('users')
        .findOne({ email: 'teacher.one@example.com' });
      if (!teacher) throw Error('Missing fixture teacher');
      const { _id, ...copy } = teacher;
      teacherId = String(_id);
      await db.collection('users').updateOne(
        { email: 'dialog-admin@example.com' },
        {
          $set: {
            ...copy,
            email: 'dialog-admin@example.com',
            roles: ['ADMIN'],
            permissions: ['*'],
          },
        },
        { upsert: true },
      );
      const dayOffset =
        3 + ['chromium', 'firefox', 'webkit'].indexOf(info.project.name);
      const future = new Date(Date.now() + dayOffset * 86_400_000);
      await db
        .collection('batches')
        .updateOne(
          { _id: fixture.batchId as any },
          { $set: { endDate: new Date(future.getTime() + 86_400_000) } },
        );
      scheduledAt = future.toISOString();
      await db
        .collection('class_sessions')
        .updateOne(
          { _id: fixture.sessionId as any },
          { $set: { scheduledAt: future } },
        );
    } finally {
      await connection.close();
    }

    const newPage = async (theme: 'light' | 'dark' = 'light') => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        colorScheme: theme,
      });
      contexts.push(context);
      return context.newPage();
    };
    const guest = await newPage();
    await setSystemTheme(guest);
    await guest.goto(stack.frontendBaseUrl + '/teacher/login');
    await guest
      .getByLabel('Email', { exact: true })
      .fill('teacher.one@example.com');
    await guest
      .getByLabel('Password', { exact: true })
      .fill('WrongPassword123!');
    await guest.getByRole('button', { name: 'Log in', exact: true }).click();
    const notice = guest.getByRole('region', { name: 'Error information' });
    await expect(notice).toContainText('SAP2001');
    for (const theme of themes) {
      await guest.emulateMedia({ colorScheme: theme });
      await guest.setViewportSize({
        width: theme === 'light' ? 1440 : 390,
        height: 844,
      });
      await checkPanel(notice, theme);
      await notice.getByRole('button', { name: 'View details' }).click();
      const details = guest.getByRole('dialog', {
        name: 'Check your sign-in details',
      });
      await checkPanel(details, theme);
      await expect(
        details.getByRole('button', { name: 'Close error details' }),
      ).toBeFocused();
      await expect(details).toContainText('SAP2001');
      await capture(guest, `error-details-${theme}`);
      await guest.keyboard.press('Escape');
      await expect(details).toBeHidden();
    }

    await guest.goto(stack.frontendBaseUrl + '/whiteboard');
    for (const theme of themes) {
      await guest.emulateMedia({ colorScheme: theme });
      await guest.setViewportSize({ width: 1440, height: 900 });
      await guest.getByRole('button', { name: 'Menu', exact: true }).click();
      await guest
        .getByRole('button', { name: 'Math tools', exact: true })
        .click();
      await checkBounds(guest.getByRole('dialog', { name: 'Math tools' }));
      await guest.getByRole('button', { name: 'Close math tools' }).click();
      await guest.setViewportSize({ width: 320, height: 720 });
      await guest
        .getByRole('button', { name: 'Slide Deck & Manager', exact: true })
        .click();
      const deck = guest.getByRole('dialog', { name: 'Slide Deck' });
      await checkPanel(deck, theme);
      await capture(guest, `whiteboard-slide-deck-${theme}`);
      await guest.reload();
    }

    const teacher = await login(
      stack.nodeAUrl,
      'teacher.one@example.com',
      password,
    );
    const workspace = await newPage();
    await setSystemTheme(workspace);
    await workspace.addInitScript(
      (token) => sessionStorage.setItem('native-sfu.auth.accessToken', token),
      teacher.accessToken,
    );
    await workspace.goto(stack.frontendBaseUrl + '/teacher/dashboard');
    for (const theme of themes) {
      await workspace.emulateMedia({ colorScheme: theme });
      await workspace.setViewportSize({
        width: theme === 'light' ? 1440 : 390,
        height: 844,
      });
      const open = workspace
        .getByRole('button', { name: 'Create a class group', exact: true })
        .first();
      await open.click();
      const drawer = workspace.getByRole('dialog', { name: 'New batch' });
      await checkPanel(drawer, theme);
      await expect(
        drawer.getByRole('textbox', { name: 'Batch name' }),
      ).toBeVisible();
      await expect(
        drawer.getByRole('button', { name: 'Close add batch form' }),
      ).toBeFocused();
      await workspace
        .locator('sfu-header a.brand')
        .evaluate((element: HTMLElement) => element.focus());
      await expect(
        drawer.getByRole('button', { name: 'Close add batch form' }),
      ).toBeFocused();
      await capture(workspace, `batch-drawer-${theme}`);
      const monday = drawer.getByRole('checkbox', { name: 'Monday', exact: true });
      await monday.click();
      await expect(monday).toBeChecked();
      await monday.click();
      await expect(monday).not.toBeChecked();
      if (theme === 'light') await workspace.mouse.click(30, 60);
      else await workspace.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
    }

    await workspace.setViewportSize({ width: 1440, height: 960 });
    await workspace.goto(stack.frontendBaseUrl + '/calendar');
    await workspace.getByLabel('Choose month').fill(scheduledAt.slice(0, 7));
    await workspace
      .locator(`[data-class-id="${fixture.sessionId}"]`)
      .first()
      .click();
    for (const theme of themes) {
      await workspace.emulateMedia({ colorScheme: theme });
      await workspace
        .getByRole('button', { name: 'Reschedule', exact: true })
        .click();
      const dialog = workspace.getByRole('dialog', { name: 'Find a new time' });
      if (theme === 'dark')
        await workspace.setViewportSize({ width: 390, height: 844 });
      await checkPanel(dialog, theme);
      await capture(workspace, `calendar-reschedule-${theme}`);
      await workspace.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }

    adminServer = await startAdminTestServer(stack.nodeAUrl);
    const admin = await login(
      stack.nodeAUrl,
      'dialog-admin@example.com',
      password,
    );
    const operator = await newPage();
    await operator.addInitScript(
      (token) =>
        sessionStorage.setItem('native-sfu.admin.auth.accessToken', token),
      admin.accessToken,
    );
    await operator.goto(adminServer.origin + '/users');
    for (const theme of themes) {
      if ((await operator.locator('html').getAttribute('data-theme')) !== theme)
        await operator
          .getByRole('button', { name: `Switch to ${theme} mode` })
          .click();
      const deactivate = operator
        .locator('tbody tr')
        .filter({ hasText: 'teacher.one@example.com' })
        .getByRole('button', { name: 'Deactivate', exact: true });
      await deactivate.focus();
      await deactivate.press('Enter');
      const dialog = operator.getByRole('dialog', {
        name: 'Deactivate Teacher One?',
      });
      await checkPanel(dialog, theme);
      const cancel = dialog.getByRole('button', {
        name: 'Cancel',
        exact: true,
      });
      await expect(cancel).toBeFocused();
      await capture(operator, `admin-confirm-${theme}`);
      await cancel.press('Enter');
      await expect(dialog).toBeHidden();
      await expect(deactivate).toBeFocused();
    }
    const unchanged = await fetch(
      `${stack.nodeAUrl}/api/v1/admin/users/${teacherId}`,
      {
        headers: { authorization: `Bearer ${admin.accessToken}` },
      },
    );
    expect(unchanged.ok).toBe(true);
    expect((await unchanged.json()).data.disabled).toBe(false);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await adminServer?.stop();
    await stack.stop();
  }
});

test('classroom dialogs honor both themes and Enter cancels when Cancel has focus', async ({
  browserName,
}, info) => {
  test.skip(
    browserName !== 'chromium',
    'The classroom desktop runtime uses Chromium.',
  );
  test.setTimeout(150_000);
  const output = process.env.DIALOG_UI_OUTPUT || info.outputPath('ui');
  await mkdir(output, { recursive: true });
  const desktopDir = process.env.SFU_UI_DESKTOP_DIR;
  const stack = await startAcceptanceStack({
    frontendPort: 4491,
    backendPort: 3391,
    frontendDir: desktopDir || frontendDir,
  });
  const harness = await createClassroomHarness({ stack }).catch(
    async (error) => {
      await stack.stop();
      throw error;
    },
  );
  const { teacher, student, urlFor } = harness;
  const capture = (page: Page, label: string) =>
    page.screenshot({ path: path.join(output, `chromium-${label}.png`) });
  try {
    for (const page of [teacher, student]) {
      await setSystemTheme(page);
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await teacher.goto(urlFor('teacher'));
    if (desktopDir) await expect(teacher).toHaveTitle('Sapiovian Classroom');
    const start = teacher.getByRole('button', {
      name: 'Start Live Class',
      exact: true,
    });
    await expect(start).toBeEnabled();
    for (const theme of themes) {
      await teacher.emulateMedia({ colorScheme: theme });
      await checkPanel(teacher.locator('.teacher-preflight-modal'), theme);
      await capture(teacher, `teacher-preflight-${theme}`);
      await teacher
        .getByRole('button', { name: 'Device setup', exact: true })
        .click();
      const devices = teacher.getByRole('dialog', {
        name: 'Device setup',
        exact: true,
      });
      await checkPanel(devices, theme);
      await capture(teacher, `classroom-devices-${theme}`);
      await teacher.keyboard.press('Escape');
      await expect(devices).toBeHidden();
    }
    await start.click();
    await expect(teacher.locator('.teacher-preflight-backdrop')).toBeHidden();
    await expect(
      teacher.getByRole('button', { name: 'Writing Pen', exact: true }),
    ).toBeEnabled({ timeout: 30_000 });
    await student.goto(urlFor('student'));
    for (const theme of themes) {
      await student.emulateMedia({ colorScheme: theme });
      await checkPanel(student.locator('.student-prejoin-modal'), theme);
      await capture(student, `student-prejoin-${theme}`);
    }

    for (const theme of themes) {
      await teacher.emulateMedia({ colorScheme: theme });
      await teacher
        .getByRole('button', { name: 'Attach link', exact: true })
        .click();
      const link = teacher.getByRole('dialog', { name: 'Add a chat link' });
      await checkPanel(link, theme);
      await link.getByLabel('Link URL').fill('not-a-link');
      await link
        .getByRole('button', { name: 'Attach link', exact: true })
        .click();
      await expect(link.getByRole('alert')).toContainText('Enter a valid link');
      await capture(teacher, `chat-link-error-${theme}`);
      await teacher.keyboard.press('Escape');
      await expect(link).toBeHidden();

      await teacher
        .getByRole('button', { name: 'Open media controls', exact: true })
        .click();
      await teacher
        .getByRole('menuitem', { name: 'End for everyone', exact: true })
        .click();
      const end = teacher.getByRole('dialog', {
        name: 'End class for everyone?',
      });
      await checkPanel(end, theme);
      const cancel = end.getByRole('button', { name: 'Keep class live', exact: true });
      await expect(cancel).toBeFocused();
      await capture(teacher, `classroom-confirm-${theme}`);
      await cancel.press('Enter');
      await expect(end).toBeHidden();
      await expect(
        teacher.getByRole('button', { name: 'Writing Pen', exact: true }),
      ).toBeEnabled();
    }
  } finally {
    await harness.close();
    await stack.stop();
  }
});
