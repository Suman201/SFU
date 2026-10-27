"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConfiguration } = require("../scripts/build-configuration.cjs");
test("local builds do not pretend to have an update feed", () => {
  const config = buildConfiguration({ appId: "test.classroom" }, {});
  assert.equal(config.publish, null);
  assert.equal(config.appId, "test.classroom");
});
test("update-enabled installers produce provider metadata and require code signing", () => {
  const config = buildConfiguration(
    { appId: "test.classroom", publish: null },
    { updateUrl: "https://updates.school.example/classroom" },
  );
  assert.deepEqual(config.publish, {
    provider: "generic",
    url: "https://updates.school.example/classroom",
  });
  assert.equal(config.forceCodeSigning, true);
  for (const updateUrl of [
    "http://updates.school.example",
    "https://user:secret@updates.school.example",
  ])
    assert.throws(() => buildConfiguration({}, { updateUrl }));
});
