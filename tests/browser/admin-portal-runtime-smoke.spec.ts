import { expect, test, type Page, type Route } from '@playwright/test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'apps/admin-portal/dist/admin-portal/browser');
const now = '2026-07-09T08:00:00.000Z';

const viewports = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'tablet', width: 820, height: 1180 },
  { label: 'mobile', width: 390, height: 844 }
];

const smokeRoutes = [
  { path: '/dashboard', heading: 'Dashboard' },
  { path: '/class-sessions', heading: 'Class sessions' },
  { path: '/class-sessions/session-smoke', heading: 'Algebra Live Session' },
  { path: '/attendance', heading: 'Attendance' },
  { path: '/recordings', heading: 'Recordings' },
  { path: '/recordings/recording-smoke', heading: 'Algebra Live Session' },
  { path: '/enrollments', heading: 'Enrollments' },
  { path: '/enrollments/enrollment-smoke', heading: 'Student One' },
  { path: '/users', heading: 'Users' },
  { path: '/users/user-teacher', heading: 'Teacher One' },
  { path: '/courses', heading: 'Courses' },
  { path: '/courses/course-math', heading: 'Algebra Foundations' },
  { path: '/batches', heading: 'Batches' },
  { path: '/batches/batch-alpha', heading: 'Alpha Batch' },
  { path: '/support', heading: 'Support queue' },
  { path: '/teacher-promotions', heading: 'Profile promotions' },
  { path: '/audit-logs', heading: 'Audit logs' },
  { path: '/audit-logs/audit-smoke', heading: 'admin.login' },
  { path: '/class-library', heading: 'Artifact search' }
];

let server: Server;
let origin = '';

test.beforeAll(async () => {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('Admin portal build output was not found. Run `npm run build --workspace @native-sfu/admin-portal` before this smoke test.');
  }
  ({ server, origin } = await startStaticServer());
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.describe('admin portal runtime smoke', () => {
  test('loads every major admin route across desktop, tablet, and mobile widths', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installAdminApiMocks(page, 'ADMIN');
    await seedSession(page, 'ADMIN');

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of smokeRoutes) {
        await page.goto(`${origin}${route.path}`);
        await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible();
        await expect(page.locator('.table-error, .detail-state.error, [role="alert"]')).toHaveCount(0);
        await expectNoSensitiveText(page, route.path);
        await expectNoBodyOverflow(page, `${viewport.label} ${route.path}`);
      }
    }

    await page.goto(`${origin}/missing-admin-route`);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    expect(pageErrors, 'admin portal page errors').toEqual([]);
    expect(consoleErrors, 'admin portal console errors').toEqual([]);
  });

  test('redirects non-admin sessions to the login surface', async ({ page }) => {
    await installAdminApiMocks(page, 'STUDENT');
    await seedSession(page, 'STUDENT');

    await page.goto(`${origin}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Sapiovian operations', level: 1 })).toBeVisible();
    await expect(page.locator('body')).toContainText('Sign in with an admin or super admin account');
  });
});

async function startStaticServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requestedPath = decodeURIComponent(url.pathname);
    const filePath = resolveStaticPath(requestedPath);

    if (!filePath) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, { 'content-type': contentType(filePath) });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start admin portal static smoke server.');
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function resolveStaticPath(requestedPath: string): string | undefined {
  const normalized = requestedPath === '/' ? '/index.html' : requestedPath;
  const safePath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, '');
  const candidate = path.join(distDir, safePath);
  if (candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  if (!path.extname(normalized)) {
    return path.join(distDir, 'index.html');
  }
  return undefined;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath);
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function installAdminApiMocks(page: Page, role: 'ADMIN' | 'STUDENT'): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.replace(/^\/api\/v1/, '');

    if (apiPath === '/auth/me') {
      await ok(route, {
        id: role === 'ADMIN' ? 'admin-smoke' : 'student-smoke',
        name: role === 'ADMIN' ? 'Smoke Admin' : 'Smoke Student',
        email: role === 'ADMIN' ? 'admin-smoke@example.test' : 'student-smoke@example.test',
        roles: [role],
        permissions: []
      });
      return;
    }

    if (role !== 'ADMIN') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Forbidden' }) });
      return;
    }

    await ok(route, adminResponseFor(apiPath, url));
  });
}

async function seedSession(page: Page, role: 'ADMIN' | 'STUDENT'): Promise<void> {
  await page.addInitScript((token) => {
    window.localStorage.setItem('native-sfu.admin.auth.accessToken', token);
  }, jwtFor(role));
}

async function ok(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data })
  });
}

function adminResponseFor(apiPath: string, url: URL): unknown {
  if (apiPath === '/admin/dashboard/summary') {
    return dashboardSummary();
  }
  if (apiPath === '/admin/class-sessions/session-smoke/report') {
    return sessionReport();
  }
  if (apiPath === '/admin/class-sessions/session-smoke/health') {
    return sessionHealth();
  }
  if (apiPath === '/admin/class-sessions/session-smoke/timeline') {
    return { sessionId: 'session-smoke', batchId: 'batch-alpha', visibility: 'full', items: [], limit: 25, hasMore: false };
  }
  if (apiPath === '/admin/class-sessions/session-smoke') {
    return sessionRow();
  }
  if (apiPath === '/admin/class-sessions') {
    return paged([sessionRow()], {
      totalSessions: 1,
      liveSessions: 1,
      completedSessions: 0,
      averageAttendancePercent: 92
    });
  }
  if (apiPath === '/admin/attendance/summary') {
    return attendanceSummary();
  }
  if (apiPath === '/admin/attendance/trends') {
    return { items: [{ date: '2026-07-09', sessions: 1, attendanceRate: 92, averageDurationSeconds: 3300, present: 11, enrolled: 12 }], summary: attendanceSummary() };
  }
  if (apiPath === '/admin/attendance/sessions') {
    return paged([attendanceSessionRow()], attendanceSummary());
  }
  if (apiPath === '/admin/attendance/students') {
    return paged([], attendanceSummary());
  }
  if (apiPath === '/admin/recordings/recording-smoke/playback') {
    return { recordingId: 'recording-smoke', status: 'stopped', playerMode: 'video', message: 'Smoke playback is mocked.' };
  }
  if (apiPath === '/admin/recordings/recording-smoke') {
    return recordingDetail();
  }
  if (apiPath === '/admin/recordings') {
    return paged([recordingRow()], recordingSummary());
  }
  if (apiPath === '/admin/enrollments/enrollment-smoke') {
    return enrollmentDetail();
  }
  if (apiPath === '/admin/enrollments') {
    return paged([enrollmentDetail()], {
      totalEnrollments: 1,
      activeEnrollments: 1,
      suspendedEnrollments: 0,
      recentlyAdded: 1,
      lowEnrollmentBatches: 0
    });
  }
  if (apiPath === '/admin/users/user-teacher') {
    return teacherUser();
  }
  if (apiPath === '/admin/users') {
    return paged([teacherUser(), studentUser()], {
      totalUsers: 2,
      teachers: 1,
      students: 1,
      admins: 1,
      disabledUsers: 0
    });
  }
  if (apiPath === '/admin/courses/course-math') {
    return { ...courseRow(), batches: [batchRow()] };
  }
  if (apiPath === '/admin/courses') {
    return paged([courseRow()], {
      totalCourses: 1,
      activeCourses: 1,
      inactiveCourses: 0,
      archivedCourses: 0
    });
  }
  if (apiPath === '/admin/batches/batch-alpha') {
    return { ...batchRow(), roster: [batchRosterRow()], sessions: [batchSessionRow()] };
  }
  if (apiPath === '/admin/batches') {
    return paged([batchRow()], {
      totalBatches: 1,
      activeBatches: 1,
      completedBatches: 0,
      cancelledBatches: 0,
      activeStudents: 12
    });
  }
  if (apiPath === '/admin/support-requests') {
    return paged([supportRequest()], { open: 1, inReview: 0, waitingForStudent: 0, resolved: 0, closed: 0 });
  }
  if (apiPath === '/admin/teacher-promotions') {
    return { items: [], page: pageFrom(url), limit: limitFrom(url), total: 0 };
  }
  if (apiPath === '/admin/audit-logs/audit-smoke') {
    return auditLogDetail();
  }
  if (apiPath === '/admin/audit-logs') {
    return { items: [auditLogDetail()], page: pageFrom(url), limit: limitFrom(url), total: 1 };
  }
  if (apiPath === '/admin/class-library/search') {
    return { items: [], page: pageFrom(url), limit: limitFrom(url), total: 0, query: Object.fromEntries(url.searchParams.entries()) };
  }
  return { items: [], page: pageFrom(url), limit: limitFrom(url), total: 0 };
}

function paged<T>(items: T[], summary: Record<string, unknown>): { items: T[]; summary: Record<string, unknown>; page: number; limit: number; total: number } {
  return { items, summary, page: 1, limit: 25, total: items.length };
}

function pageFrom(url: URL): number {
  return Number(url.searchParams.get('page') ?? 1);
}

function limitFrom(url: URL): number {
  return Number(url.searchParams.get('limit') ?? 25);
}

function sessionRow() {
  return {
    sessionId: 'session-smoke',
    batchId: 'batch-alpha',
    batchName: 'Alpha Batch',
    courseId: 'course-math',
    courseName: 'Algebra Foundations',
    teacherId: 'user-teacher',
    teacherName: 'Teacher One',
    teacherEmail: 'teacher@example.test',
    title: 'Algebra Live Session',
    sessionNumber: 4,
    scheduledAt: now,
    startedAt: now,
    status: 'live',
    roomId: 'room-smoke',
    attendance: { enrolled: 12, present: 11, absent: 1, reconnects: 1, averageDurationSeconds: 3300 }
  };
}

function dashboardSummary() {
  return {
    generatedAt: now,
    todayStart: '2026-07-09T00:00:00.000Z',
    todayEnd: '2026-07-09T23:59:59.999Z',
    liveSessions: 1,
    scheduledToday: 2,
    completedToday: 1,
    todayAttendanceRate: 92,
    activeRecordings: 1,
    failedRecordings: 0,
    newEnrollmentsToday: 1,
    pendingEnrollments: 0,
    activeEnrollments: 12,
    activeUsers: 24,
    teachers: 4,
    students: 18,
    admins: 2,
    activeCourses: 3,
    activeBatches: 5,
    issues: [{ severity: 'warning', label: 'Teacher reconnecting', count: 1, link: '/class-sessions/session-smoke' }],
    liveSessionItems: [
      {
        sessionId: 'session-smoke',
        title: 'Algebra Live Session',
        batchId: 'batch-alpha',
        batchName: 'Alpha Batch',
        teacherId: 'user-teacher',
        teacherName: 'Teacher One',
        startedAt: now,
        roomId: 'room-smoke',
        teacherState: 'reconnecting',
        participantCount: 12,
        activeAlertCount: 1
      }
    ]
  };
}

function attendanceSummary() {
  return {
    totalSessions: 1,
    completedSessions: 1,
    snapshottedSessions: 1,
    inferredSessions: 0,
    totalEnrolledStudents: 12,
    averageAttendanceRate: 92,
    averageDurationSeconds: 3300,
    absentCount: 1,
    lateJoinCount: 0,
    earlyLeaveCount: 0,
    reconnectCount: 1
  };
}

function attendanceSessionRow() {
  return {
    sessionId: 'session-smoke',
    batchId: 'batch-alpha',
    batchName: 'Alpha Batch',
    courseId: 'course-math',
    courseName: 'Algebra Foundations',
    teacherId: 'user-teacher',
    teacherName: 'Teacher One',
    title: 'Algebra Live Session',
    status: 'completed',
    scheduledAt: now,
    startedAt: now,
    completedAt: '2026-07-09T09:00:00.000Z',
    enrolled: 12,
    present: 11,
    absent: 1,
    attendanceRate: 92,
    averageDurationSeconds: 3300,
    reconnects: 1,
    lateJoins: 0,
    earlyLeaves: 0,
    attendanceSource: 'snapshot'
  };
}

function sessionHealth() {
  return {
    generatedAt: now,
    session: sessionRow(),
    room: {
      roomId: 'room-smoke',
      closed: false,
      locked: false,
      mediaStatus: 'stable',
      incidentStatus: 'active',
      incidentHealth: 'degraded',
      protected: false,
      activeAlerts: []
    },
    teacher: { state: 'reconnecting', connected: false, reconnecting: true, participantId: 'host-smoke', reconnectDeadlineAt: '2026-07-09T08:05:00.000Z' },
    participants: { total: 12, admitted: 12, pending: 0, students: 11, hosts: 1, coHosts: 0, handRaised: 1, inactive: 0 },
    media: { audioProducers: 9, videoProducers: 5, screenProducers: 1, whiteboardProducers: 0, pausedProducers: 2, liveConsumers: 18, pausedConsumers: 1 },
    joins: { deniedTotal: 1, deniedByReason: { class_locked: 1 } },
    recording: { total: 1, active: 1, failed: 0, statuses: { recording: 1 } },
    support: { total: 1, open: 1, inReview: 0, waitingForStudent: 0, resolved: 0, closed: 0 },
    issues: {
      total: 1,
      media: 0,
      joinDenied: 1,
      support: 1,
      recording: 0,
      recent: [{ id: 'incident-smoke', severity: 'warn', summary: 'One join denied by class lock.', createdAt: now }]
    },
    lastActivityAt: now,
    links: { timeline: '/class-sessions/session-smoke?tab=timeline', attendance: '/attendance?sessionId=session-smoke', recordings: '/recordings?sessionId=session-smoke', support: '/support?sessionId=session-smoke' }
  };
}

function sessionReport() {
  return {
    audience: 'admin',
    generatedAt: now,
    session: { ...sessionRow(), durationMinutes: 60, status: 'completed', completedAt: '2026-07-09T09:00:00.000Z' },
    attendance: { enrolled: 12, present: 11, absent: 1, attendanceRate: 92, averageDurationSeconds: 3300, reconnects: 1, lateJoins: 0, earlyLeaves: 0, source: 'snapshot' },
    participation: { joins: 11, leaves: 11, reconnects: 1, handRaises: 2, allowedSpeaks: 1, revokedSpeaks: 1, mutedMics: 1, stoppedCameras: 1 },
    broadcasts: { count: 1, latestAt: now, latestPreview: 'Homework reminder' },
    artifacts: { recordings: [], materials: [], whiteboard: { available: true, snapshotVersion: 3, updatedAt: now } },
    assignments: { total: 1, published: 1, archived: 0, submissions: { assigned: 12, viewed: 10, submitted: 8, late: 1, reviewed: 6, returned: 1, completed: 5 } },
    qna: { threads: 2, withQuestions: 2, unanswered: 1, unreadForTeacher: 1, latestAt: now },
    incidents: { total: 1, support: 1, media: 0, moderation: 0, latest: [] }
  };
}

function recordingRow() {
  return {
    id: 'recording-doc-smoke',
    recordingId: 'recording-smoke',
    sessionId: 'session-smoke',
    batchId: 'batch-alpha',
    roomId: 'room-smoke',
    sessionTitle: 'Algebra Live Session',
    sessionNumber: 4,
    batchName: 'Alpha Batch',
    courseId: 'course-math',
    courseName: 'Algebra Foundations',
    teacherId: 'user-teacher',
    status: 'stopped',
    storageProvider: 'local',
    mimeType: 'video/webm',
    container: 'webm',
    size: 1024,
    durationSeconds: 3300,
    startedAt: now,
    stoppedAt: '2026-07-09T09:00:00.000Z',
    canPlayback: true,
    canDownload: false,
    createdAt: now,
    updatedAt: now
  };
}

function recordingDetail() {
  return { ...recordingRow(), scope: 'room', startedBy: 'user-teacher', stoppedBy: 'user-teacher', consentRequired: true, consentVersion: 'v1', trackCount: 3 };
}

function recordingSummary() {
  return { totalRecordings: 1, processingRecordings: 0, readyRecordings: 1, failedRecordings: 0, expiredRecordings: 0, expiringSoonRecordings: 0 };
}

function enrollmentDetail() {
  return {
    id: 'enrollment-smoke',
    studentId: 'user-student',
    studentName: 'Student One',
    studentEmail: 'student@example.test',
    courseId: 'course-math',
    batchId: 'batch-alpha',
    batchName: 'Alpha Batch',
    teacherId: 'user-teacher',
    status: 'active',
    access: { canAccessClassSessions: true, reason: 'Active enrollment' },
    enrolledAt: now,
    createdAt: now,
    updatedAt: now,
    createdBy: 'admin-smoke',
    updatedBy: 'admin-smoke'
  };
}

function teacherUser() {
  return {
    id: 'user-teacher',
    name: 'Teacher One',
    displayName: 'Teacher One',
    email: 'teacher@example.test',
    roles: ['teacher'],
    primaryRole: 'teacher',
    status: 'active',
    disabled: false,
    permissions: [],
    createdAt: now,
    updatedAt: now
  };
}

function studentUser() {
  return {
    id: 'user-student',
    name: 'Student One',
    displayName: 'Student One',
    email: 'student@example.test',
    roles: ['student'],
    primaryRole: 'student',
    status: 'active',
    disabled: false,
    permissions: [],
    createdAt: now,
    updatedAt: now
  };
}

function courseRow() {
  return {
    courseId: 'course-math',
    courseName: 'Algebra Foundations',
    status: 'active',
    batchCount: 1,
    activeBatchCount: 1,
    activeStudentCount: 12,
    teacherCount: 1,
    createdAt: now,
    updatedAt: now
  };
}

function batchRow() {
  return {
    id: 'batch-alpha',
    name: 'Alpha Batch',
    courseId: 'course-math',
    courseName: 'Algebra Foundations',
    teacherId: 'user-teacher',
    teacherName: 'Teacher One',
    teacherEmail: 'teacher@example.test',
    year: 2026,
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    maxCapacity: 24,
    enrolledCount: 12,
    status: 'ACTIVE',
    schedule: [{ id: 'schedule-smoke', dayOfWeek: 'THURSDAY', startTime: '08:00' }],
    nextSessionAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function batchRosterRow() {
  return { id: 'roster-smoke', enrollmentId: 'enrollment-smoke', userId: 'user-student', displayName: 'Student One', email: 'student@example.test', status: 'active', joinedAt: now };
}

function batchSessionRow() {
  return { id: 'session-smoke', batchId: 'batch-alpha', title: 'Algebra Live Session', sessionNumber: 4, scheduledAt: now, durationMinutes: 60, status: 'live', roomId: 'room-smoke', startedAt: now };
}

function supportRequest() {
  return {
    id: 'support-doc-smoke',
    requestId: 'support-smoke',
    studentId: 'user-student',
    studentName: 'Student One',
    studentEmail: 'student@example.test',
    batchId: 'batch-alpha',
    batchName: 'Alpha Batch',
    teacherId: 'user-teacher',
    sessionId: 'session-smoke',
    sessionTitle: 'Algebra Live Session',
    roomId: 'room-smoke',
    issueType: 'audio_video',
    status: 'open',
    subject: 'Cannot hear teacher',
    message: 'Student reported an audio issue.',
    diagnostics: { route: '/student/class-session/session-smoke', classSessionStatus: 'live', roomStatus: 'active', teacherConnectionState: 'reconnecting' },
    comments: [],
    createdAt: now,
    updatedAt: now
  };
}

function auditLogDetail() {
  return {
    id: 'audit-smoke',
    createdAt: now,
    actorId: 'admin-smoke',
    actorEmail: 'admin-smoke@example.test',
    actorName: 'Smoke Admin',
    actorRoles: ['admin'],
    action: 'admin.login',
    resourceType: 'admin_session',
    resourceId: 'admin-smoke',
    resourceLabel: 'Smoke login',
    targetType: 'user',
    targetId: 'admin-smoke',
    status: 'success',
    ipAddress: '127.0.0.1',
    userAgent: 'Playwright smoke',
    requestId: 'request-smoke',
    summary: 'Admin smoke login event',
    metadata: { source: 'smoke' },
    before: {},
    after: {}
  };
}

function jwtFor(role: 'ADMIN' | 'STUDENT'): string {
  const payload = {
    sub: role === 'ADMIN' ? 'admin-smoke' : 'student-smoke',
    email: role === 'ADMIN' ? 'admin-smoke@example.test' : 'student-smoke@example.test',
    roles: [role],
    permissions: [],
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url(payload)}.smoke`;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function expectNoSensitiveText(page: Page, context: string): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  expect(bodyText, `sensitive text leaked on ${context}`).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+|storageKey|storagePath|\/Volumes\/|\/var\/folders\/|mongodb:\/\//i);
}

async function expectNoBodyOverflow(page: Page, context: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `body horizontal overflow on ${context}`).toBeLessThanOrEqual(2);
}
