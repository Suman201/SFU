import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { startLocalUiStack, runtimeUrl, type LocalUiStack } from './local-ui-stack';

const password = 'Password@12345';
const teacherEmail = 'teacher.one@example.com';
const studentEmail = 'student.one@example.com';

/** Real backend, database, socket and Angular fixture. No service or HTTP mocks. */
export async function startAcceptanceStack(
  options: {
    frontendPort?: number;
    backendPort?: number;
    secondBackendPort?: number;
    localSmtpPort?: number;
  } = {},
) {
  const uri = new URL(process.env.MONGODB_URI ?? 'mongodb://invalid/missing');
  if (
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.pathname !== '/whiteboard_acceptance'
  ) {
    throw new Error(
      'Use local isolated MongoDB database whiteboard_acceptance.',
    );
  }
  const materialDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'sfu-whiteboard-materials-'),
  );
  const overrides: Record<string, string> = {
    MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER: '50',
    SMTP_ENABLED: options.localSmtpPort ? 'true' : 'false',
    CLASS_MATERIAL_LOCAL_PATH: materialDirectory,
    ...(options.localSmtpPort
      ? {
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(options.localSmtpPort),
          SMTP_SECURE: 'false',
          SMTP_USER: '',
          SMTP_PASSWORD: '',
          SMTP_PASSWORD_FILE: '',
          SMTP_FROM_EMAIL: 'tutor-test@example.com',
          SMTP_FROM_NAME: 'Sapiovian',
          TUTOR_NOTIFICATION_POLL_MS: '500',
        }
      : {}),
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  let stack: LocalUiStack;
  try {
    Object.assign(process.env, overrides);
    stack = await startLocalUiStack({
      frontendPort: options.frontendPort ?? 4440,
      nodePorts: options.secondBackendPort
        ? [options.backendPort ?? 3340, options.secondBackendPort]
        : [options.backendPort ?? 3340],
      workerMode: 'in-process',
      operationsToken: 'whiteboard-acceptance-operations-test-token',
    });
  } catch (error) {
    await rm(materialDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return {
    ...stack,
    materialDirectory,
    stop: async () => {
      try {
        await stack.stop();
      } finally {
        await rm(materialDirectory, { recursive: true, force: true });
      }
    },
  };
}

export async function createClassroomHarness(options: { stack?: LocalUiStack; frontendPort?: number; backendPort?: number; enrollStudent?: boolean } = {}) {
  const stack = options.stack ?? await startAcceptanceStack(options);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }).catch(async (error) => { if (!options.stack) await stack.stop(); throw error; });
  const contexts: BrowserContext[] = [];
  const close = async () => {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    if (!options.stack) await stack.stop();
  };
  try {
    const fixture = await seedClassroom({enrollStudent:options.enrollStudent ?? true});
    const teacherTokens = await login(stack.nodeAUrl, teacherEmail, password);
    const studentTokens = await login(stack.nodeAUrl, studentEmail, password);
    const teacherContext = await authenticatedContext(teacherTokens.accessToken);
    const studentContext = await authenticatedContext(studentTokens.accessToken);
    const teacher = await teacherContext.newPage();
    const student = await studentContext.newPage();
    const urlFor = (role: string) => `${runtimeUrl(stack.frontendBaseUrl, stack.nodeAUrl, `/class-session/${role}`)}&sessionId=${fixture.sessionId}&batchId=${fixture.batchId}`;
    return { stack, browser, fixture, teacherTokens, studentTokens, teacherContext, studentContext, teacher, student, urlFor, close };
  } catch (error) { await close(); throw error; }
  async function authenticatedContext(token: string) {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 }, permissions: ['camera', 'microphone'] });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(30_000);
    contexts.push(context);
    await context.addInitScript((value) => sessionStorage.setItem('native-sfu.auth.accessToken', value), token);
    await context.addInitScript(() => {
      const diagnostics: Array<Record<string, unknown>> = [];
      (window as any).__whiteboardMediaDiagnostics = diagnostics;
      const playFailures: Array<Record<string, unknown>> = [];
      (window as any).__whiteboardPlayFailures = playFailures;
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        return originalPlay.call(this).catch((error: any) => {
          playFailures.push({ name: error.name, message: error.message, element: this.className });
          throw error;
        });
      };
      const original = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function(description: RTCSessionDescriptionInit) {
        return original.call(this, description).catch((error: any) => {
          diagnostics.push({ operation: 'setRemoteDescription', name: error.name, message: error.message, errorDetail: error.errorDetail, sdpLineNumber: error.sdpLineNumber });
          throw error;
        });
      };
    });
    return context;
  }
}

export async function enterTeacherClassroom(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Start Live Class', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start Live Class', exact: true }).click();
  await expect(page.locator('.teacher-preflight-backdrop')).toHaveCount(0, { timeout: 45_000 });
  await waitJoined(page, 'teacher');
  await expect(page.getByRole('button', { name: 'Pen: solid', exact: true })).toBeEnabled({ timeout: 20_000 });
}

export async function enterStudentClassroom(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Join Class', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Join Class', exact: true }).click();
  await expect(page.locator('.student-whiteboard-button')).toBeVisible({ timeout: 30_000 });
  await page.locator('.student-whiteboard-button').click();
  await expect(page.locator('sfu-whiteboard')).toBeVisible();
}

export async function seedClassroom(options: {enrollStudent?:boolean} = {}) {
  const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
  try {
    const db = connection.db!;
    const teacher = await db.collection('users').findOne({ email: teacherEmail });
    const student = await db.collection('users').findOne({ email: studentEmail });
    if (!teacher || !student) throw new Error('Local stack did not seed acceptance users');
    const batchId = `whiteboard-acceptance-${randomUUID()}`;
    const sessionId = `whiteboard-acceptance-${randomUUID()}`;
    const previousSessionId = `whiteboard-acceptance-previous-${randomUUID()}`;
    const now = new Date();
    await db.collection('batches').insertOne({ _id: batchId as any, name: 'Whiteboard acceptance classroom', teacherId: String(teacher._id), year: now.getUTCFullYear(), startDate: new Date(now.getTime() - 86_400_000), endDate: new Date(now.getTime() + 86_400_000), maxCapacity: 30, feeAmount: 0, status: 'ACTIVE', createdAt: now, updatedAt: now });
    if (options.enrollStudent !== false) await db.collection('student_enrollments').insertOne({ _id: randomUUID() as any, studentId: String(student._id), studentName: student.name, studentEmail, batchId, teacherId: String(teacher._id), status: 'active', enrolledAt: now, createdAt: now, updatedAt: now });
    await db.collection('class_sessions').insertOne({ _id: sessionId as any, batchId, teacherId: String(teacher._id), title: 'Whiteboard classroom acceptance', sessionNumber: 2, scheduledAt: now, durationMinutes: 60, status: 'scheduled', roomId: `pending-${sessionId}`, chatChannelId: `chat-${sessionId}`, whiteboardChannelId: `board-${sessionId}`, createdAt: now, updatedAt: now });
    await db.collection('class_sessions').insertOne({ _id: previousSessionId as any, batchId, teacherId: String(teacher._id), title: 'Previous classroom fixture', sessionNumber: 1, scheduledAt: new Date(now.getTime() - 7_200_000), durationMinutes: 60, status: 'completed', startedAt: new Date(now.getTime() - 7_200_000), completedAt: new Date(now.getTime() - 3_600_000), roomId: `prior-${previousSessionId}`, chatChannelId: `chat-${previousSessionId}`, whiteboardChannelId: `board-${previousSessionId}`, createdAt: now, updatedAt: now });
    return { batchId, sessionId, previousSessionId };
  } finally { await connection.close(); }
}

export async function board(page: Page): Promise<any> {
  return page.locator('sfu-whiteboard').evaluate((element) => JSON.parse(JSON.stringify((window as any).ng.getComponent(element).exportBoardState())));
}
export async function elementCount(page: Page) { return (await board(page)).pages.reduce((count: number, item: any) => count + item.elements.length, 0); }
export async function assertBoardsEqual(teacher: Page, student: Page) { await expect.poll(() => board(student), { timeout: 15_000 }).toEqual(await board(teacher)); }
export async function classroomState(page: Page, role: string) {
  return page.locator(`sfu-${role}-class-session`).evaluate((element) => {
    const c = (window as any).ng.getComponent(element);
    return { roomJoined: c.roomJoined(), roomId: c.session()?.roomId, sessionId: c.session()?.sessionId, saveState: c.whiteboardMemorySaveState?.(), notice: c.whiteboardMemoryNotice?.(), error: c.mediaError?.(), connected: c.socket.connect().connected, memoryLoading: c.whiteboardMemoryLoading?.(), controllerParticipantId: c.whiteboardControllerParticipantId?.(), controllerPermissionLevel: c.whiteboardControllerPermissionLevel?.(), localParticipantId: c.store.localParticipantId(), mediaFailure: c.webrtc.lastMediaError?.(), nativeMediaFailures: (window as any).__whiteboardMediaDiagnostics, participantCards: element.tagName.toLowerCase() === 'sfu-teacher-class-session' ? c.participants().map((item: any) => ({ id: item.id, userId: item.userId, name: item.name, connected: item.connected, canModerate: item.canModerate })) : undefined, roomParticipants: c.store.room()?.participants?.map((item: any) => ({ id: item.id, participantId: item.participantId, userId: item.userId, connected: item.connected })) };
  });
}
export async function draw(page: Page, index: number) {
  await page.getByRole('button', { name: 'Pen: solid', exact: true }).click();
  await pointerStroke(page, index);
}
export async function pointerStroke(page: Page, index: number) {
  const canvas = page.locator('canvas.whiteboard-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Whiteboard canvas has no bounds');
  const x = box.x + Math.min(box.width * 0.25, 120) + index * 8;
  const y = box.y + Math.min(box.height * 0.3, 160) + index * 15;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 70, y + 30, { steps: 12 });
  await page.mouse.move(x + 120, y + 5, { steps: 12 });
  await page.mouse.up();
}

export async function takeOffline(page: Page, context: BrowserContext, role: string) {
  await context.setOffline(true);
  await page.locator(`sfu-${role}-class-session`).evaluate((element) => (window as any).ng.getComponent(element).socket.connect().io.engine.close());
  await expect.poll(async () => (await classroomState(page, role)).connected).toBe(false);
}
export async function waitJoined(page: Page, role: string) {
  await expect.poll(async () => (await classroomState(page, role)).connected, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await classroomState(page, role)).roomJoined, { timeout: 30_000 }).toBe(true);
}
export function largeBoard() {
  return { schemaVersion: 1, activePageId: 'page-0', pages: Array.from({ length: 30 }, (_, page) => ({
    id: `page-${page}`, title: `Lesson ${page + 1}`, tags: ['acceptance'], order: page, template: 'blank',
    view: { zoom: 1, panX: 0, panY: 0 }, background: null,
    elements: Array.from({ length: 50 }, (_, stroke) => ({ id: `stroke-${page}-${stroke}`, type: 'stroke', color: '#071c41', width: 3,
      points: Array.from({ length: 43 }, (_, point) => ({ x: 20 + (stroke % 5) * 180 + point * 7, y: 20 + Math.floor(stroke / 5) * 50 + point * 5 })) }))
  })) };
}

export async function login(baseUrl: string, email: string, password: string): Promise<{ accessToken: string }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new Error(`Acceptance login failed: ${response.status} ${await response.text()}`);
  const envelope = await response.json();
  const tokens = envelope.data ?? envelope;
  if (!tokens.accessToken) throw new Error('Acceptance login response did not contain an access token');
  return tokens;
}

export async function renameBoardPage(page: Page, title: string) {
  const input = page.getByRole('textbox', { name: 'Rename current board page' });
  const initial = await board(page);
  const currentTitle = initial.pages.find((item: any) => item.id === initial.activePageId)?.title;
  await expect(input).toHaveValue(currentTitle);
  await input.fill(title);
  await expect(input).toHaveValue(title);
  await page.getByLabel('Search board pages', { exact: true }).click();
  await expect.poll(async () => { const snapshot = await board(page); return snapshot.pages.find((item: any) => item.id === snapshot.activePageId)?.title; }).toBe(title);
}

export async function assertRenderedBoard(page: Page, minimumHeight = (page.viewportSize()?.width ?? 1680) < 600 ? 250 : 400) {
  const canvas = page.locator('canvas.whiteboard-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(minimumHeight);
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(250);
}

export async function boardPixelFingerprint(page: Page) {
  return page.locator('canvas.whiteboard-canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 2166136261;
    let fixtureInkPixels = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] === 7 && data[i + 1] === 28 && data[i + 2] === 65 && data[i + 3]! > 200) fixtureInkPixels += 1; hash = Math.imul(hash ^ data[i]!, 16777619); hash = Math.imul(hash ^ data[i + 1]!, 16777619); hash = Math.imul(hash ^ data[i + 2]!, 16777619); }
    return { hash: hash >>> 0, width: canvas.width, height: canvas.height, fixtureInkPixels };
  });
}

export async function mediaDiagnostics(page: Page, role: string) {
  return page.locator(`sfu-${role}-class-session`).evaluate(async (element) => {
    const service = (window as any).ng.getComponent(element).webrtc;
    const peers = await Promise.all([...service.peers.entries()].map(async ([id, peer]: any) => {
      const reports = [...(await peer.getStats()).values()] as any[];
      const rtp = reports.filter((item) => ['inbound-rtp', 'outbound-rtp'].includes(item.type)).map((item) => ({
        type: item.type, kind: item.kind, codecId: item.codecId, packetsReceived: item.packetsReceived, packetsSent: item.packetsSent,
        bytesReceived: item.bytesReceived, bytesSent: item.bytesSent, framesEncoded: item.framesEncoded, framesDecoded: item.framesDecoded,
        keyFramesDecoded: item.keyFramesDecoded, frameWidth: item.frameWidth, frameHeight: item.frameHeight,
        codec: reports.find((candidate) => candidate.id === item.codecId)
      }));
      return { id, connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState, signalingState: peer.signalingState, rtp };
    }));
    const videos = [...document.querySelectorAll('video')].map((video) => ({
      className: video.className, paused: video.paused, muted: video.muted, readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      tracks: video.srcObject instanceof MediaStream ? video.srcObject.getTracks().map((track) => ({ id: track.id, kind: track.kind, readyState: track.readyState, muted: track.muted, enabled: track.enabled })) : []
    }));
    return { error: service.lastMediaError(), nativeMediaFailures: (window as any).__whiteboardMediaDiagnostics, playFailures: (window as any).__whiteboardPlayFailures, peers, videos };
  });
}
