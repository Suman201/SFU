import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { connectStagingSocket, emitAck, loginToStaging } from './helpers/staging-browser';
import { runtimeUrl, startLocalUiStack } from './helpers/local-ui-stack';

type AuthUser = {
  email: string;
  password: string;
  displayName: string;
};

test.describe('operator incident browser workflow', () => {
  test.setTimeout(240_000);

  test('incident timeline, snapshot history, recovery controls, metrics, and room failure stay coherent in the real UI', async ({
    browser,
    browserName
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Focused local operator signoff currently runs on Chromium; transport/media browser interoperability remains covered by the wider suite.'
    );
    const stack = await startLocalUiStack({
      frontendPort: 4420,
      nodePorts: [3310],
      workerMode: 'worker'
    });
    const user = HOST_USER;
    const context = await browser.newContext();
    let probeSocket: Awaited<ReturnType<typeof connectStagingSocket>> | undefined;

    try {
      await primeAuthenticatedContext(context, stack.nodeAUrl, user);
      const page = await context.newPage();
      const roomName = `U2A Incident ${Date.now()}`;

      await createRoomFromUi(page, runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl), roomName);
      const roomId = roomIdFromPage(page);
      probeSocket = await joinRoomViaSocket(stack.nodeAUrl, roomId, STUDENT_TWO);
      await emitAck(probeSocket, 'transport:create', { roomId });

      await expect(page.getByText('protected: off')).toBeVisible();
      await expect(page.getByText('recovery: idle')).toBeVisible();

      await page.getByRole('button', { name: 'Protect room' }).click();
      await expect(page.getByText('protected: on')).toBeVisible();

      await page.getByRole('button', { name: 'Capture snapshot' }).click();
      await expect.poll(async () => page.locator('.snapshots li').count(), { timeout: 20_000 }).toBeGreaterThan(0);

      await page.getByRole('button', { name: 'Mark recovery' }).click();
      await expect(page.getByText('recovery: active')).toBeVisible();
      await expect.poll(async () => page.locator('.timeline li').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

      const incidentState = await fetchJson<{
        protected: boolean;
        underRecovery: boolean;
        snapshotCount: number;
        status: string;
      }>(`${stack.nodeAUrl}/api/v1/media/diagnostics/rooms/${roomId}/incident-state`, stack.operationsToken);
      expect(incidentState.protected).toBe(true);
      expect(incidentState.underRecovery).toBe(true);
      expect(incidentState.snapshotCount).toBeGreaterThan(0);

      const snapshotHistory = await fetchJson<{ bundles: Array<{ bundleId: string }> }>(
        `${stack.nodeAUrl}/api/v1/media/diagnostics/rooms/${roomId}/snapshot-history`,
        stack.operationsToken
      );
      expect(snapshotHistory.bundles.length).toBeGreaterThan(0);

      const timeline = await fetchJson<{ events: Array<{ id: string }> }>(
        `${stack.nodeAUrl}/api/v1/media/diagnostics/rooms/${roomId}/incident-timeline`,
        stack.operationsToken
      );
      expect(timeline.events.length).toBeGreaterThanOrEqual(3);

      const metrics = await fetchText(`${stack.nodeAUrl}/metrics`, stack.operationsToken);
      expect(readMetric(metrics, 'sfu_room_recovery_actions_total', ['action="protect_room"', 'outcome="executed"'])).toBeGreaterThanOrEqual(1);
      expect(readMetric(metrics, 'sfu_room_recovery_actions_total', ['action="force_incident_snapshot"', 'outcome="executed"'])).toBeGreaterThanOrEqual(1);
      expect(readMetric(metrics, 'sfu_room_recovery_actions_total', ['action="mark_operator_recovery"', 'outcome="executed"'])).toBeGreaterThanOrEqual(1);
      expect(readMetric(metrics, 'sfu_snapshot_bundles_generated_total', ['trigger="manual_operator"', 'mode="manual"'])).toBeGreaterThanOrEqual(1);
      expect(readMetric(metrics, 'sfu_room_incident_timeline_events_total')).toBeGreaterThanOrEqual(3);

      await postJson(`${stack.nodeAUrl}/api/v1/media/diagnostics/rooms/${roomId}/fail`, stack.operationsToken, {
        workerId: 'operator-test-worker',
        message: 'Media worker operator-test-worker force-closed room during diagnostics validation'
      });

      await expect(page.locator('.error')).toContainText(/Media worker .*force-closed/i, { timeout: 20_000 });
      await expect.poll(
        async () =>
          readMetric(await fetchText(`${stack.nodeAUrl}/metrics`, stack.operationsToken), 'sfu_media_worker_room_failures_total', ['reason="worker_drained_forced"']),
        { timeout: 20_000 }
      ).toBeGreaterThanOrEqual(1);
    } finally {
      probeSocket?.disconnect();
      await context.close();
      await stack.stop();
    }
  });

  test('distributed join redirect stays on the frontend origin, rehydrates the room, and points runtime traffic at the owner node', async ({
    browser,
    browserName
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Focused local operator signoff currently runs on Chromium; transport/media browser interoperability remains covered by the wider suite.'
    );
    const stack = await startLocalUiStack({
      frontendPort: 4520,
      nodePorts: [3410, 3412],
      workerMode: 'in-process'
    });
    const ownerUser = HOST_USER;
    const joinerUser = STUDENT_ONE;
    const ownerContext = await browser.newContext();
    const joinerContext = await browser.newContext();

    try {
      await primeAuthenticatedContext(ownerContext, stack.nodeAUrl, ownerUser);
      const ownerPage = await ownerContext.newPage();
      const roomName = `U2A Redirect ${Date.now()}`;

      await createRoomFromUi(ownerPage, runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl), roomName);
      const roomId = roomIdFromPage(ownerPage);

      await primeAuthenticatedContext(joinerContext, stack.nodeBUrl!, joinerUser);
      const joinerPage = await joinerContext.newPage();
      await joinerPage.goto(runtimeUrl(stack.frontendBaseUrl, stack.nodeBUrl!), { waitUntil: 'domcontentloaded' });
      const joinForm = joinerPage.locator('form').filter({ has: joinerPage.getByRole('heading', { name: 'Join room' }) });
      await joinForm.getByLabel('Room ID').fill(roomId);
      await joinForm.getByLabel('Display name').fill(joinerUser.displayName);
      await joinForm.getByRole('button', { name: 'Join' }).click();

      await expect(joinerPage).toHaveURL(new RegExp(`/rooms/${roomId}`), { timeout: 20_000 });
      await expect(joinerPage.locator('h1')).toHaveText(roomName, { timeout: 20_000 });
      await expect
        .poll(() => new URL(joinerPage.url()).searchParams.get('apiBaseUrl'), { timeout: 20_000 })
        .toBe(`${stack.nodeAUrl}/api/v1`);
      await expect
        .poll(() => new URL(joinerPage.url()).searchParams.get('socketUrl'), { timeout: 20_000 })
        .toBe(`${stack.nodeAUrl}/sfu`);
      await expect(ownerPage.getByText(joinerUser.displayName).first()).toBeVisible({ timeout: 20_000 });

      const metrics = await fetchText(`${stack.nodeBUrl}/metrics`, stack.operationsToken);
      expect(readMetric(metrics, 'sfu_room_owner_redirects_total')).toBeGreaterThanOrEqual(1);
    } finally {
      await ownerContext.close();
      await joinerContext.close();
      await stack.stop();
    }
  });
});

async function primeAuthenticatedContext(
  context: BrowserContext,
  backendBaseUrl: string,
  user: AuthUser
): Promise<void> {
  const tokens = await loginToStaging(backendBaseUrl, user.email, user.password);
  await context.addInitScript(
    ({ accessToken, refreshToken }) => {
      window.localStorage.setItem('sfu.accessToken', accessToken);
      if (refreshToken) {
        window.localStorage.setItem('sfu.refreshToken', refreshToken);
      }
    },
    {
      accessToken: tokens.accessToken,
      refreshToken: (tokens as { refreshToken?: string }).refreshToken
    }
  );
}

async function createRoomFromUi(page: Page, formsUrl: string, roomName: string): Promise<void> {
  await page.goto(formsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Authenticated')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Room name').fill(roomName);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/rooms\//, { timeout: 20_000 });
  await expect(page.locator('h1')).toHaveText(roomName, { timeout: 20_000 });
}

function roomIdFromPage(page: Page): string {
  const url = new URL(page.url());
  const roomId = url.pathname.split('/').filter(Boolean).at(-1);
  if (!roomId) {
    throw new Error(`Unable to determine room id from ${page.url()}`);
  }
  return roomId;
}

async function joinRoomViaSocket(nodeBaseUrl: string, roomId: string, user: AuthUser) {
  const tokens = await loginToStaging(nodeBaseUrl, user.email, user.password);
  const socket = await connectStagingSocket(nodeBaseUrl, tokens.accessToken);
  await emitAck(socket, 'room:join', {
    roomId,
    displayName: user.displayName
  });
  return socket;
}

async function fetchJson<T>(url: string, operationsToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'x-operations-token': operationsToken
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string, operationsToken: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'x-operations-token': operationsToken
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function postJson<T>(url: string, operationsToken: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-operations-token': operationsToken
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST failed for ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function readMetric(metrics: string, metricName: string, requiredLabels: string[] = []): number {
  const line = metrics
    .split('\n')
    .find((entry) => entry.startsWith(metricName) && requiredLabels.every((label) => entry.includes(label)));
  if (!line) {
    return 0;
  }
  const value = Number(line.trim().split(/\s+/).at(-1));
  return Number.isFinite(value) ? value : 0;
}

const HOST_USER: AuthUser = {
  email: 'teacher.one@example.com',
  password: 'Password@12345',
  displayName: 'Teacher One'
};

const STUDENT_ONE: AuthUser = {
  email: 'student.one@example.com',
  password: 'Password@12345',
  displayName: 'Redirect Guest'
};

const STUDENT_TWO: AuthUser = {
  email: 'student.two@example.com',
  password: 'Password@12345',
  displayName: 'Failure Probe'
};
