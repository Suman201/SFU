"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOptions, commandPlan } = require("../../../scripts/desktop.cjs");

test("help does not require a configured backend or trigger a build", () => {
  assert.deepEqual(parseOptions(["--help"]), { help: true });
  assert.deepEqual(parseOptions(["package:win", "--help"]), { help: true });
});
test("desktop commands accept platform-neutral URL flags and environment fallback", () => {
  const result = parseOptions(
    [
      "package:win",
      "--server-url",
      "https://api.school.example",
      "--website-url=https://school.example",
      "--update-url",
      "https://updates.school.example/classroom",
    ],
    { SFU_DESKTOP_SERVER_URL: "https://old.school.example" },
  );
  assert.equal(result.command, "package:win");
  assert.equal(
    result.environment.SFU_DESKTOP_SERVER_URL,
    "https://api.school.example",
  );
  assert.equal(
    result.environment.SFU_DESKTOP_WEBSITE_URL,
    "https://school.example",
  );
  assert.equal(
    result.environment.SFU_DESKTOP_UPDATE_URL,
    "https://updates.school.example/classroom",
  );
});
test("commands reject malformed options before any expensive build", () => {
  for (const args of [
    ["package:win"],
    ["dev", "--unknown"],
    ["dev", "--server-url"],
    ["dev", "--server-url", "http://remote.example"],
    ["build", "--update-url", "http://remote.example"],
    [
      "build",
      "--server-url=https://x.example",
      "--server-url=https://y.example",
    ],
  ])
    assert.throws(() => parseOptions(args));
});
test("local dev and unpacked builds reuse the existing backend instead of launching another", () => {
  const result = parseOptions(["dev"]);
  assert.equal(
    result.environment.SFU_DESKTOP_SERVER_URL,
    "http://127.0.0.1:3000",
  );
  assert.equal(
    result.environment.SFU_DESKTOP_WEBSITE_URL,
    "http://localhost:4200",
  );
  assert.equal(result.localDefault, true);
});

test("root and direct workspace commands build fresh desktop assets exactly once", () => {
  const { scripts } = require("../package.json");
  const dev = commandPlan("dev");
  assert.deepEqual(
    dev.map((args) => args[1]),
    ["build:frontend", "prepare:assets", "start"],
  );
  assert.match(scripts["build:frontend"], /--configuration desktop$/);
  for (const command of ["build", "package:mac", "package:win"]) {
    assert.deepEqual(commandPlan(command), [
      ["run", command, "-w", "@native-sfu/desktop"],
    ]);
    const steps = scripts[command].split(" && ");
    assert.equal(steps[0], "npm run build:frontend");
    assert.equal(steps[1], "npm run prepare:assets");
    assert.equal(
      steps.filter((step) => step === "npm run build:frontend").length,
      1,
    );
    assert.match(steps[2], /^electron-builder /);
  }
});
