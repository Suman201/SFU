"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { buildConfiguration } = require("./scripts/build-configuration.cjs");
const runtime = JSON.parse(
  fs.readFileSync(path.join(__dirname, "assets/runtime-config.json"), "utf8"),
);
module.exports = buildConfiguration(require("./package.json").build, runtime);
