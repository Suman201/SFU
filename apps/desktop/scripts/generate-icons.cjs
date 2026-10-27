"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const resources = path.join(root, "resources");
const source = fs
  .readFileSync(
    path.resolve(root, "../frontend/src/assets/brand/edconnection-mark.svg"),
    "utf8",
  )
  .trim();
const inner = source.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="#f7faff"/><g transform="translate(128 188) scale(12)">' +
  inner +
  "</g></svg>";
(async () => {
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "icon.svg"), svg + "\n");
  const browser = await chromium.launch();
  const png = new Map();
  try {
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        '<html><body style="margin:0;background:transparent">' +
          svg +
          "</body></html>",
      );
      png.set(size, await page.screenshot({ omitBackground: true }));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(resources, "icon.png"), png.get(1024));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * sizes.length;
  for (const size of sizes) {
    const bytes = png.get(size),
      entry = Buffer.alloc(16);
    entry[0] = entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(bytes.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += bytes.length;
  }
  fs.writeFileSync(
    path.join(resources, "icon.ico"),
    Buffer.concat([header, ...entries, ...sizes.map((size) => png.get(size))]),
  );
  const types = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
  ];
  const records = types.map(([type, size]) => {
    const bytes = png.get(size),
      record = Buffer.alloc(8);
    record.write(type, 0, 4, "ascii");
    record.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([record, bytes]);
  });
  const total = records.reduce((sum, record) => sum + record.length, 8),
    icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(total, 4);
  fs.writeFileSync(
    path.join(resources, "icon.icns"),
    Buffer.concat([icnsHeader, ...records]),
  );
  console.log(
    "Generated Windows and macOS icons from the shared EDCONNECTION brand mark.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
