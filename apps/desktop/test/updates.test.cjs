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
test('late update check responses remain deferred after a class opens', async () => {
  const { native, controller } = setup();
  let finish; native.checkForUpdates = () => new Promise(resolve => { finish = resolve; });
  const checking = controller.check(); controller.setActive(true);
  native.emit('update-available', {version:'2.0.0'}); finish({cancellationToken:{cancel(){},cancelled:false}}); await checking;
  assert.equal(controller.state.status,'deferred');
  controller.setActive(false); assert.equal(controller.state.status,'available');
});
test('a newer candidate never installs the previously downloaded version', async () => {
  const {native,controller,counts}=setup();
  native.emit('update-downloaded',{version:'2.0.0'});
  native.emit('update-available',{version:'2.1.0'});
  assert.equal(controller.ready,false);
  await controller.install();assert.equal(counts().installs,0);
  native.emit('update-downloaded',{version:'2.0.0'});assert.equal(controller.ready,false);
});
test('failed update verification clears installation readiness', async () => {
  const {native,controller,counts}=setup();
  native.emit('update-downloaded',{version:'2.0.0'});native.emit('error',new Error('signature mismatch'));
  await controller.install();assert.equal(counts().installs,0);assert.equal(controller.state.status,'error');
});

test('a withdrawn cached candidate is not offered after a fresh update check',async()=>{
  const {native,controller,counts}=setup();native.emit('update-downloaded',{version:'2.0.0'});native.emit('update-not-available',{version:'1.0.0'});await controller.install();assert.equal(counts().installs,0);assert.equal(controller.ready,false);
});
