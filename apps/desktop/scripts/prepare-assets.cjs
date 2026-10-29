"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { serverOrigin } = require("../src/policy.cjs");
const root = path.resolve(__dirname, "..");
const source = path.resolve(root, "../frontend/dist/desktop/browser");
if (!fs.existsSync(path.join(source, "index.html")))
  throw new Error(
    "Build Angular first: npm run build -w @native-sfu/frontend -- --configuration desktop",
  );
const target = path.join(root, "assets/browser");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
const serverUrl = process.env.SFU_DESKTOP_SERVER_URL
  ? serverOrigin(process.env.SFU_DESKTOP_SERVER_URL)
  : undefined;
const websiteUrl = process.env.SFU_DESKTOP_WEBSITE_URL
  ? serverOrigin(process.env.SFU_DESKTOP_WEBSITE_URL)
  : serverUrl;
const adminPortalUrl = process.env.SFU_DESKTOP_ADMIN_URL ? serverOrigin(process.env.SFU_DESKTOP_ADMIN_URL) : serverUrl && new URL(serverUrl).protocol === 'https:' ? '' : 'http://localhost:4300';
fs.appendFileSync(path.join(target, 'env.js'), '\nwindow.__SFU_ENV__ = Object.assign({}, window.__SFU_ENV__, ' + JSON.stringify({ adminPortalUrl }) + ');\n');
const updateUrl = process.env.SFU_DESKTOP_UPDATE_URL;
if (updateUrl) {
  const parsed = new URL(updateUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error(
      "SFU_DESKTOP_UPDATE_URL must be HTTPS without credentials.",
    );
}
fs.writeFileSync(
  path.join(root, "assets/runtime-config.json"),
  JSON.stringify({ serverUrl, websiteUrl, updateUrl }, null, 2),
);
console.log("Desktop interface and runtime configuration prepared.");
