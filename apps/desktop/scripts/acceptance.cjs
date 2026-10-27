"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const repo = path.resolve(__dirname, "../../..");
const { _electron, chromium, expect } = require(
  repo + "/node_modules/@playwright/test",
);
const mongoose = require(repo + "/node_modules/mongoose");
const { startServer } = require(repo + "/apps/desktop/src/server.cjs");
const evidence =
  process.env.SFU_NATIVE_REPORT_DIR ||
  path.join(
    require("node:os").tmpdir(),
    "edconnection-native-acceptance-" + Date.now(),
  );
fs.mkdirSync(evidence, { recursive: true });
const credentials = {
  teacherEmail: process.env.SFU_NATIVE_TEACHER_EMAIL,
  studentEmail: process.env.SFU_NATIVE_STUDENT_EMAIL,
  password: process.env.SFU_NATIVE_TEST_PASSWORD,
};
if (Object.values(credentials).some((value) => !value))
  throw new Error(
    "Set SFU_NATIVE_TEACHER_EMAIL, SFU_NATIVE_STUDENT_EMAIL, and SFU_NATIVE_TEST_PASSWORD for your isolated acceptance accounts.",
  );
const backend = process.env.SFU_NATIVE_TEST_BACKEND || "http://127.0.0.1:3351",
  website = process.env.SFU_NATIVE_TEST_WEBSITE || "http://127.0.0.1:4451";
if (!["localhost", "127.0.0.1"].includes(new URL(backend).hostname))
  throw new Error("Native acceptance must use a local isolated backend.");
const run = randomUUID();
const result = { backend, mockedBackend: false, milestones: [] };
const assert = expect.configure({ timeout: 25_000 });
let electron, browser, web, teacher, student;
async function step(name, work) {
  await work();
  result.milestones.push(name);
  console.log("PASS", name);
}
async function ink(page) {
  return page.locator("canvas.whiteboard-canvas").evaluate((canvas) => {
    const bytes = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < bytes.length; i += 4)
      if (
        bytes[i] < 80 &&
        bytes[i + 1] < 80 &&
        bytes[i + 2] < 100 &&
        bytes[i + 3] > 200
      )
        ink++;
    return ink;
  });
}
async function draw(page, offset = 0) {
  await page.getByRole("button", { name: "Pen: solid", exact: true }).click();
  const box = await page.locator("canvas.whiteboard-canvas").boundingBox();
  await page.mouse.move(
    box.x + box.width * 0.2,
    box.y + box.height * (0.3 + offset),
  );
  await page.mouse.down();
  for (let i = 1; i <= 14; i++)
    await page.mouse.move(
      box.x + box.width * (0.2 + i * 0.022),
      box.y + box.height * (0.3 + offset + i * 0.008),
    );
  await page.mouse.up();
}
async function studentJoin() {
  await assert(
    student.getByRole("button", { name: "Join Class", exact: true }),
  ).toBeEnabled({ timeout: 40_000 });
  await student
    .getByRole("button", { name: "Join Class", exact: true })
    .click();
  await assert(student.locator(".student-whiteboard-button")).toBeVisible({
    timeout: 40_000,
  });
  if (
    (await student
      .locator(".student-whiteboard-button")
      .getAttribute("aria-expanded")) !== "true"
  )
    await student.locator(".student-whiteboard-button").click();
  await assert(student.locator("canvas.whiteboard-canvas")).toBeVisible();
}
(async () => {
  const connection = await mongoose
    .createConnection("mongodb://127.0.0.1:27028/whiteboard_acceptance")
    .asPromise();
  const db = connection.db;
  const teacherUser = await db
      .collection("users")
      .findOne({ email: credentials.teacherEmail }),
    studentUser = await db
      .collection("users")
      .findOne({ email: credentials.studentEmail });
  const now = new Date();
  const batchId = "native-live-" + run,
    sessionId = "native-live-" + run;
  result.sessionId = sessionId;
  await db
    .collection("batches")
    .insertOne({
      _id: batchId,
      name: "Native live classroom",
      teacherId: String(teacherUser._id),
      year: now.getUTCFullYear(),
      startDate: new Date(now.getTime() - 86400000),
      endDate: new Date(now.getTime() + 86400000),
      maxCapacity: 30,
      feeAmount: 0,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
  await db
    .collection("student_enrollments")
    .insertOne({
      _id: randomUUID(),
      studentId: String(studentUser._id),
      studentName: studentUser.name,
      studentEmail: credentials.studentEmail,
      batchId,
      teacherId: String(teacherUser._id),
      status: "active",
      enrolledAt: now,
      createdAt: now,
      updatedAt: now,
    });
  await db
    .collection("class_sessions")
    .insertOne({
      _id: sessionId,
      batchId,
      teacherId: String(teacherUser._id),
      title: "Native live classroom " + run.slice(0, 6),
      sessionNumber: 1,
      scheduledAt: now,
      durationMinutes: 60,
      status: "scheduled",
      roomId: "pending-" + sessionId,
      chatChannelId: "chat-" + sessionId,
      whiteboardChannelId: "board-" + sessionId,
      createdAt: now,
      updatedAt: now,
    });
  await connection.close();
  web = await startServer({
    frontendDir: path.join(repo, "apps/frontend/dist/frontend/browser"),
    backendOrigin: backend,
    websiteOrigin: website,
  });
  electron = await _electron.launch({
    executablePath: require(repo + "/node_modules/electron"),
    args: [repo + "/apps/desktop"],
    env: {
      ...process.env,
      SFU_DESKTOP_SERVER_URL: backend,
      SFU_DESKTOP_WEBSITE_URL: website,
      SFU_DESKTOP_USER_DATA: path.join(evidence, "live-profile-" + run),
      SFU_DESKTOP_FRONTEND_DIR: path.join(
        repo,
        "apps/frontend/dist/desktop/browser",
      ),
      SFU_DESKTOP_TEST_MEDIA: "1",
    },
    timeout: 30_000,
  });
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1680, 1100),
  );
  teacher = await electron.firstWindow();
  const errors = [];
  teacher.on("pageerror", (e) =>
    errors.push({ role: "teacher", message: e.message }),
  );
  await step("native teacher signs in using existing account", async () => {
    await teacher
      .getByLabel("Email", { exact: true })
      .fill(credentials.teacherEmail);
    await teacher
      .getByLabel("Password", { exact: true })
      .fill(credentials.password);
    await teacher.getByRole("button", { name: "Sign in", exact: true }).click();
    await assert(
      teacher.getByRole("heading", { name: "Upcoming classes", exact: true }),
    ).toBeVisible();
  });
  await step(
    "native teacher opens scheduled lesson and starts through preflight",
    async () => {
      const card = teacher
        .locator(".class-card")
        .filter({ hasText: "Native live classroom " + run.slice(0, 6) });
      await card
        .getByRole("link", { name: "Prepare class", exact: true })
        .click();
      const start = teacher.getByRole("button", {
        name: "Start Live Class",
        exact: true,
      });
      await assert(start).toBeEnabled({ timeout: 40_000 });
      await start.click();
      await assert(teacher.locator(".teacher-preflight-backdrop")).toHaveCount(
        0,
        { timeout: 45_000 },
      );
      await assert(
        teacher.getByRole("button", { name: "Pen: solid", exact: true }),
      ).toBeEnabled({ timeout: 30_000 });
    },
  );
  browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const response = await fetch(backend + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.studentEmail,
      password: credentials.password,
    }),
  });
  const body = await response.json();
  const token = (body.data || body).accessToken;
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1100 },
    permissions: ["camera", "microphone"],
  });
  await context.addInitScript(
    (token) => sessionStorage.setItem("native-sfu.auth.accessToken", token),
    token,
  );
  student = await context.newPage();
  student.on("pageerror", (e) =>
    errors.push({ role: "student", message: e.message }),
  );
  const studentUrl =
    web.origin +
    "/class-session/student?sessionId=" +
    sessionId +
    "&batchId=" +
    batchId;
  await step("browser student joins the same real class", async () => {
    await student.goto(studentUrl);
    await studentJoin();
  });
  await step("teacher stroke appears in browser student canvas", async () => {
    const baseline = await ink(student);
    await draw(teacher);
    await assert.poll(() => ink(student)).toBeGreaterThan(baseline + 100);
    result.teacherStrokeStudentInk = await ink(student);
  });
  await step(
    "native teacher whiteboard video and microphone reach browser student",
    async () => {
      await teacher
        .getByRole("button", { name: "Open media controls", exact: true })
        .click();
      await teacher
        .getByRole("menuitem", { name: "Share whiteboard", exact: true })
        .click();
      await student
        .getByRole("button", { name: "Close whiteboard", exact: true })
        .click();
      await assert
        .poll(
          () =>
            student
              .locator("video.stage-video")
              .evaluateAll((videos) =>
                videos.some(
                  (video) =>
                    video.videoWidth > 0 &&
                    video.readyState >= 2 &&
                    !video.paused,
                ),
              ),
          { timeout: 40_000 },
        )
        .toBe(true);
      await assert
        .poll(
          () =>
            student
              .locator("audio.teacher-audio")
              .evaluateAll((audios) =>
                audios.some((audio) =>
                  audio.srcObject
                    ?.getAudioTracks()
                    .some((track) => track.readyState === "live"),
                ),
              ),
          { timeout: 30_000 },
        )
        .toBe(true);
      result.receivedMedia = await student
        .locator("video.stage-video")
        .evaluate((video) => ({
          width: video.videoWidth,
          height: video.videoHeight,
          currentTime: video.currentTime,
        }));
      await student.screenshot({
        path: path.join(evidence, "native-live-browser-video.png"),
        fullPage: true,
      });
      await student.locator(".student-whiteboard-button").click();
    },
  );
  await step(
    "teacher grants control and browser student drawing reaches native teacher",
    async () => {
      await teacher
        .getByRole("button", { name: /^Allow .+ to control the whiteboard$/ })
        .click();
      await assert(
        student.getByRole("button", { name: "Pen: solid", exact: true }),
      ).toBeEnabled();
      const before = await ink(teacher);
      await draw(student, 0.22);
      await assert.poll(() => ink(teacher)).toBeGreaterThan(before + 100);
      result.studentStrokeTeacherInk = await ink(teacher);
    },
  );
  await step(
    "browser reload rejoins with saved board and control grant",
    async () => {
      await student.reload();
      await studentJoin();
      await assert(
        student.getByRole("button", { name: "Pen: solid", exact: true }),
      ).toBeEnabled({ timeout: 30_000 });
      await assert.poll(() => ink(student)).toBeGreaterThan(100);
    },
  );
  await step(
    "reconnected browser can continue drawing to native teacher",
    async () => {
      const before = await ink(teacher);
      await draw(student, 0.38);
      await assert.poll(() => ink(teacher)).toBeGreaterThan(before + 100);
    },
  );
  await teacher.screenshot({
    path: path.join(evidence, "native-live-teacher.png"),
    fullPage: true,
  });
  await student.screenshot({
    path: path.join(evidence, "native-live-browser-student.png"),
    fullPage: true,
  });
  const teacherToken = await teacher.evaluate(() =>
    decodeURIComponent(
      document.cookie
        .split("; ")
        .find((item) => item.startsWith("native-sfu.auth.accessToken="))
        .split("=")
        .slice(1)
        .join("="),
    ),
  );
  await assert
    .poll(
      async () => {
        const response = await fetch(
          backend +
            "/api/v1/class-sessions/" +
            sessionId +
            "/whiteboard?batchId=" +
            batchId,
          { headers: { Authorization: "Bearer " + teacherToken } },
        );
        const data = (await response.json()).data;
        return (
          data?.snapshot?.pages.reduce(
            (sum, page) => sum + page.elements.length,
            0,
          ) || 0
        );
      },
      { timeout: 25_000 },
    )
    .toBeGreaterThanOrEqual(3);
  result.persistedElementsAtLeast = 3;
  result.errors = errors;
  await step("teacher ends classroom through normal controls", async () => {
    await teacher
      .getByRole("button", { name: "Open media controls", exact: true })
      .click();
    await teacher
      .getByRole("menuitem", { name: "End for everyone", exact: true })
      .click();
    const confirm = teacher
      .getByRole("dialog")
      .getByRole("button", { name: /End/i });
    await confirm.click();
    await assert(
      teacher.getByRole("heading", { name: "Upcoming classes", exact: true }),
    ).toBeVisible({ timeout: 40_000 });
  });
  result.passed = true;
})()
  .catch(async (error) => {
    result.passed = false;
    result.error = error.stack;
    for (const [role, page] of [
      ["teacher", teacher],
      ["student", student],
    ])
      if (page && !page.isClosed()) {
        await page
          .screenshot({
            path: path.join(evidence, "native-live-" + role + "-failure.png"),
            fullPage: true,
          })
          .catch(() => {});
        result[role + "Text"] = await page
          .locator("body")
          .innerText()
          .catch(() => "");
      }
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(
      path.join(evidence, "native-live.json"),
      JSON.stringify(result, null, 2),
    );
    if (teacher && !teacher.isClosed())
      await teacher
        .evaluate(() => window.classroomDesktop.setClassActive(false))
        .catch(() => {});
    await browser?.close().catch(() => {});
    await electron?.close().catch(() => {});
    await web?.close().catch(() => {});
    console.log(
      JSON.stringify({
        passed: result.passed,
        milestones: result.milestones,
        errors: result.errors,
        evidence,
      }),
    );
  });
