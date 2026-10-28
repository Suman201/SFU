"use strict";
const fs = require("node:fs");
const path = require("node:path");
const source = path.resolve(__dirname, "../../frontend/src/assets/brand");
const target = path.resolve(__dirname, "../public/brand");
fs.mkdirSync(target, {recursive: true});
for (const name of ["sapiovian-lockup.png", "favicon-32.png", "apple-touch-icon.png"]) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}
console.log("Prepared shared Sapiovian branding.");
