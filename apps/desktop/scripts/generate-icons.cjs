'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'resources');
const brand = path.resolve(root, '../frontend/src/assets/brand');
const artwork = JSON.parse(
  fs.readFileSync(path.join(brand, 'sapiovian-artwork.json'), 'utf8'),
);
const source =
  'data:image/png;base64,' +
  fs.readFileSync(path.join(brand, artwork.source)).toString('base64');
const image = `<image width="${artwork.width}" height="${artwork.height}" href="${source}"/>`;
const viewport = (box) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}">${image}</svg>`;
const markSvg = viewport(artwork.mark);
// Render the exact approved symbol in the monochrome app treatment shown in the
// approved concept. The original artwork is never redrawn or modified.
const appIcon = (
  mark,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="white" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter></defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="${artwork.tileColor}"/>
  <image x="284" y="208" width="456" height="608" href="${mark}" filter="url(#white)"/>
</svg>`;
(async () => {
  fs.mkdirSync(resources, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const png = new Map();
  const render = async (content, width, height) => {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(
        '<html><body style="margin:0;background:transparent">' +
          content +
          '</body></html>',
      );
      // Wait for the embedded master before exporting, including cached loads.
      await page.evaluate(async () => {
        const urls = Array.from(document.querySelectorAll('image'), (image) =>
          image.getAttribute('href'),
        );
        await Promise.all(
          urls.map(
            (url) =>
              new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = reject;
                image.src = url;
              }),
          ),
        );
      });
      return await page.screenshot({ omitBackground: true });
    } finally {
      await page.close();
    }
  };
  try {
    // Shared web assets are build exports of the same approved PNG, not new artwork.
    fs.writeFileSync(path.join(brand, 'sapiovian-mark.svg'), markSvg + '\n');
    const markPng = await render(markSvg, 324, 432);
    fs.writeFileSync(path.join(brand, 'sapiovian-mark.png'), markPng);
    const svg = appIcon('data:image/png;base64,' + markPng.toString('base64'));
    fs.writeFileSync(path.join(resources, 'icon.svg'), svg + '\n');
    fs.writeFileSync(
      path.join(brand, 'sapiovian-wordmark.png'),
      await render(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${artwork.wordmark.join(' ')}"><defs><clipPath id="letters"><rect x="476" y="240" width="1384" height="270"/><rect x="851" y="500" width="51" height="49"/></clipPath></defs><g clip-path="url(#letters)">${image}</g></svg>`,
        1384,
        312,
      ),
    );
    fs.writeFileSync(
      path.join(brand, 'sapiovian-lockup.png'),
      await render(viewport(artwork.lockup), 1736, 468),
    );
    for (const size of [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024]) {
      png.set(size, await render(svg, size, size));
    }
    fs.writeFileSync(path.join(brand, 'favicon-32.png'), png.get(32));
    fs.writeFileSync(path.join(brand, 'apple-touch-icon.png'), png.get(180));
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(resources, 'icon.png'), png.get(1024));
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
    path.join(resources, 'icon.ico'),
    Buffer.concat([header, ...entries, ...sizes.map((size) => png.get(size))]),
  );
  fs.copyFileSync(
    path.join(resources, 'icon.ico'),
    path.join(brand, 'favicon.ico'),
  );
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
  ];
  const records = types.map(([type, size]) => {
    const bytes = png.get(size),
      record = Buffer.alloc(8);
    record.write(type, 0, 4, 'ascii');
    record.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([record, bytes]);
  });
  const total = records.reduce((sum, record) => sum + record.length, 8),
    icnsHeader = Buffer.alloc(8);
  icnsHeader.write('icns');
  icnsHeader.writeUInt32BE(total, 4);
  fs.writeFileSync(
    path.join(resources, 'icon.icns'),
    Buffer.concat([icnsHeader, ...records]),
  );
  console.log(
    'Generated Windows and macOS icons from the shared Sapiovian brand mark.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
