"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { UpdateController } = require("../src/updates.cjs");
function setup() {
  const native = new EventEmitter();
  let checks = 0,
    installs = 0;
  native.checkForUpdates = async () => {
    checks++;
  };
  native.quitAndInstall = () => {
    installs++;
  };
  const controller = new UpdateController({
    updater: native,
    available: true,
    onState: () => {},
  });
  return { native, controller, counts: () => ({ checks, installs }) };
}
test("active class blocks checking and installation even when an update is ready", async () => {
  const { native, controller, counts } = setup();
  controller.setActive(true);
  await controller.check();
  native.emit("update-downloaded", { version: "2.0.0" });
  await controller.install();
  assert.deepEqual(counts(), { checks: 0, installs: 0 });
  assert.equal(controller.state.status, "deferred");
  controller.setActive(false);
  assert.equal(controller.state.status, "ready");
  await controller.install();
  assert.equal(counts().installs, 1);
});
test("updates never install on quit automatically", () => {
  const { native } = setup();
  assert.equal(native.autoDownload, false);
  assert.equal(native.autoInstallOnAppQuit, false);
});
test("unconfigured unsigned builds expose an honest unavailable state", async () => {
  const controller = new UpdateController({
    available: false,
    onState: () => {},
  });
  assert.equal((await controller.check()).status, "unavailable");
  assert.equal((await controller.install()).status, "unavailable");
});
