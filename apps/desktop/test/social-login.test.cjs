"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { DesktopSocialLogin, authorizationUrl } = require("../src/social-login.cjs");
const consent = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture";
function fixture(options = {}) {
  let body, opened;
  const ready = Promise.withResolvers();
  const controller = new DesktopSocialLogin({
    backendOrigin: "https://api.example.test",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.example.test/api/v1/auth/social/google/start");
      assert.equal(init.redirect, "error");
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { authorizationUrl: consent } }) };
    },
    openExternal: async url => { opened = url; ready.resolve(); },
    ...options,
  });
  return { controller, ready: ready.promise, body: () => body, opened: () => opened };
}
test("native sign-in binds a temporary loopback callback to its private verifier", async t => {
  const f = fixture(); t.after(() => f.controller.cancel());
  const result = f.controller.start("google", "teacher");
  await f.ready;
  assert.equal(f.opened(), consent);
  assert.equal(f.body().role, "teacher");
  const callback = f.body().desktopRedirectUri;
  assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[\w-]{43}$/);
  await assert.rejects(f.controller.start("apple", "student"), /already/);
  for (const suffix of ["?ticket=bad", "?error=attacker", "?ticket=" + "a".repeat(43) + "&ticket=" + "b".repeat(43)])
    assert.equal((await fetch(callback + suffix)).status, 400);
  assert.equal((await fetch(new URL("/other?ticket=" + "a".repeat(43), callback))).status, 404);
  assert.equal((await fetch(callback + "?ticket=" + "a".repeat(43), { method: "POST" })).status, 404);
  const response = await fetch(callback + "?ticket=" + "a".repeat(43));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(await response.text(), /Return to Sapiovian/);
  const handoff = await result;
  assert.equal(handoff.ticket, "a".repeat(43));
  assert.equal(createHash("sha256").update(handoff.verifier).digest("hex"), f.body().challenge);
  await assert.rejects(fetch(callback + "?ticket=" + "a".repeat(43)));
});
test("callback rejects a forged host without consuming the pending flow", async t => {
  const f = fixture(); t.after(() => f.controller.cancel());
  const result = f.controller.start("google", "student");
  const rejected = assert.rejects(result, /cancelled/);
  await f.ready;
  const status = await new Promise((resolve, reject) => {
    const req = http.get(f.body().desktopRedirectUri + "?ticket=" + "a".repeat(43), { headers: { host: "attacker.test" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(status, 404);
  f.controller.cancel(); await rejected;
});
test("cancelled and failed provider callbacks clean up without exposing a verifier", async () => {
  for (const error of ["cancelled", "failed"]) {
    const f = fixture();
    const result = assert.rejects(f.controller.start("google", "student"), error === "cancelled" ? /cancelled/ : /could not be verified/);
    await f.ready;
    const response = await fetch(f.body().desktopRedirectUri + "?error=" + error);
    assert.doesNotMatch(await response.text(), /ticket|verifier/);
    await result; assert.equal(f.controller.pending, null);
  }
});
test("cancelling during backend startup cannot open a late consent window", async () => {
  const response = Promise.withResolvers(), started = Promise.withResolvers(); let opened = false;
  const f = fixture({ fetchImpl: async () => { started.resolve(); return response.promise; }, openExternal: async () => { opened = true; } });
  const rejected = assert.rejects(f.controller.start("google", "student"), /cancelled/);
  await started.promise; f.controller.cancel(); await rejected;
  response.resolve({ ok: true, json: async () => ({ data: { authorizationUrl: consent } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, false);
});
test("immediate cancellation cannot leave a callback listener behind", async () => {
  const f = fixture();
  const result = assert.rejects(f.controller.start("google", "student"), /cancelled/);
  const server = f.controller.pending.server;
  f.controller.cancel(); await result;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.listening, false);
});
test("timeout and browser launch failure release the listener", async () => {
  const expired = fixture({ timeoutMs: 20 });
  await assert.rejects(expired.controller.start("google", "student"), /expired/);
  assert.equal(expired.controller.pending, null);
  const failed = fixture({ openExternal: async () => { throw Error("OS error with sensitive data"); } });
  await assert.rejects(failed.controller.start("google", "student"), /^Error: Sign-in could not start/);
  assert.equal(failed.controller.pending, null);
});
test("only exact HTTPS provider authorization endpoints can leave the app", async () => {
  for (const url of ["http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com.attacker.test/o/oauth2/v2/auth", "https://accounts.google.com/other", "https://user:password@accounts.google.com/o/oauth2/v2/auth", consent + "#secret", "file:///tmp/command", "sfu-classroom://join"])
    assert.throws(() => authorizationUrl(url, "google"));
  assert.equal(authorizationUrl("https://appleid.apple.com/auth/authorize?state=test", "apple"), "https://appleid.apple.com/auth/authorize?state=test");
  const f = fixture();
  await assert.rejects(f.controller.start("google", "admin"));
  await assert.rejects(f.controller.start("__proto__", "student"));
});
test("preload returns the handoff and keeps native IPC diagnostics out of user errors", async () => {
  const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
  let bridge, response = { ticket: "a".repeat(43), verifier: "b".repeat(43) };
  const invokes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.cjs"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => { invokes.push(args); if (response instanceof Error) throw response; return response; } },
    }),
  });
  assert.deepEqual(await bridge.startSocialLogin("apple", "teacher"), response);
  assert.deepEqual(invokes[0], ["desktop:social-start", "apple", "teacher"]);
  response = { error: "Sign-in was cancelled. You can try again." };
  await assert.rejects(bridge.startSocialLogin("apple", "teacher"), /cancelled/);
  response = Error("IPC channel and implementation detail");
  await assert.rejects(bridge.startSocialLogin("apple", "teacher"), /^Error: Sign-in could not start. Please try again.$/);
});
