"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  serverOrigin,
  partitionForServer,
  classPath,
  remindersFrom,
  dueReminders,
  websitePath,
} = require("../src/policy.cjs");
const website = "https://school.example";
test("server configuration rejects insecure remote origins and embedded credentials", () => {
  assert.equal(
    serverOrigin("https://school.example/"),
    "https://school.example",
  );
  assert.equal(serverOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  for (const value of [
    "http://school.example",
    "https://user:secret@school.example",
    "https://school.example/api",
    "file:///tmp",
    "https://school.example?token=secret",
  ])
    assert.throws(() => serverOrigin(value));
});
test("class invitations retain only validated classroom identifiers", () => {
  assert.equal(
    classPath(
      "sfu-classroom://join?sessionId=lesson-123&batchId=batch_123&apiBaseUrl=https://evil.example",
      website,
    ),
    "/desktop/join?sessionId=lesson-123&batchId=batch_123",
  );
  assert.equal(
    classPath("/class-session/teacher?sessionId=lesson-123", website),
    "/desktop/join?sessionId=lesson-123",
  );
  for (const value of [
    "https://evil.example/desktop/join?sessionId=x",
    "sfu-classroom://other?sessionId=x",
    "/desktop/join?sessionId=../secret",
    "sfu-classroom://join?sessionId=%3Cscript%3E",
    "/desktop/join",
    "javascript:alert(1)",
  ])
    assert.equal(classPath(value, website), null, value);
});
test("website links never expose arbitrary protocol or foreign navigation", () => {
  assert.equal(
    websitePath("/teacher/dashboard", website),
    "https://school.example/teacher/dashboard",
  );
  for (const value of [
    "//evil.example",
    "javascript:alert(1)",
    "https://school.example@evil.example",
  ])
    assert.throws(() => websitePath(value, website));
});
test("reminders validate payloads, fire within five minutes, and deduplicate", () => {
  const now = Date.now();
  const items = remindersFrom(
    [
      {
        id: "one",
        title: "Maths",
        startsAt: new Date(now + 60_000).toISOString(),
        joinPath: "/desktop/join?sessionId=one",
      },
      {
        id: "later",
        title: "Maths",
        startsAt: new Date(now + 10 * 60_000).toISOString(),
        joinPath: "/desktop/join?sessionId=later",
      },
      {
        id: "bad",
        title: "Bad",
        startsAt: "invalid",
        joinPath: "/desktop/join?sessionId=bad",
      },
      {
        id: "foreign",
        title: "Bad",
        startsAt: new Date(now + 60_000).toISOString(),
        joinPath: "https://evil.example/desktop/join?sessionId=bad",
      },
    ],
    website,
  );
  assert.equal(items.length, 2);
  assert.equal(dueReminders(items, new Set(), now).length, 1);
  assert.equal(
    dueReminders(items, new Set(["one:" + items[0].startsAt]), now).length,
    0,
  );
  assert.equal(dueReminders(items, new Set(), now + 11 * 60_000).length, 0);
});

test("stale schedules do not notify after the renderer stops refreshing", () => {
  const now = Date.now();
  const item = { id: "lesson", startsAt: now + 60_000 };
  assert.equal(dueReminders([item], new Set(), now, now - 90_001).length, 0);
  assert.equal(dueReminders([item], new Set(), now, now - 30_000).length, 1);
});

test("persistent authentication partitions are stable and isolated by backend origin", () => {
  assert.equal(
    partitionForServer("https://school.example/"),
    partitionForServer("https://school.example"),
  );
  assert.notEqual(
    partitionForServer("https://school.example"),
    partitionForServer("https://other-school.example"),
  );
  assert.notEqual(
    partitionForServer("http://127.0.0.1:3000"),
    partitionForServer("http://127.0.0.1:3001"),
  );
  assert.match(
    partitionForServer("https://school.example"),
    /^persist:classroom-[a-f0-9]{24}$/,
  );
});
