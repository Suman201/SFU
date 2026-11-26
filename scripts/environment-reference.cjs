#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const variables = new Map(); let notes = [];
for (const line of source.split(/\r?\n/)) {
  if (line.startsWith('#')) { notes.push(line.replace(/^#\s*/, '')); continue; }
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) {
    const sensitive = /(?:PASSWORD|SECRET|TOKEN|ENCRYPTION_KEY|PRIVATE_KEY|API_KEY)(?:_|$)/.test(match[1]);
    variables.set(match[1], { value: sensitive ? 'Set privately; value omitted' : match[2] || '(empty)', notes: notes.join(' ') || 'See the associated configuration section and deployment guide.' }); notes = [];
  } else if (!line.trim()) notes = [];
}
const locations = new Map();
function add(name, file) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return;
  if (!variables.has(name)) variables.set(name, { value: '(not in template)', notes: 'Configured by the referenced runtime or deployment source; inspect that source for bounds and required combinations.' });
  if (!locations.has(name)) locations.set(name, new Set()); locations.get(name).add(file);
}
for (const base of ['apps/backend/src', 'apps/frontend/src', 'apps/admin-portal/src', 'apps/desktop/src', 'infra']) {
  const directory = path.join(root, base); if (!fs.existsSync(directory)) continue;
  for (const relative of fs.readdirSync(directory, { recursive: true })) {
    if (!/\.(?:ts|cjs|mjs|js|ya?ml)$/.test(relative) || /(?:\.spec\.|\.test\.|\.d\.ts$)/.test(relative)) continue;
    const file = path.join(base, relative).replaceAll(path.sep, '/');
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) add(match[1] || match[2], file);
    for (const match of text.matchAll(/envOrSecretFile\(['"]([A-Z][A-Z0-9_]*)['"]/g)) { add(match[1], file); add(match[1] + '_FILE', file); }
    if (file.endsWith('env.validation.ts')) for (const match of text.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) add(match[1], file);
    if (/\.ya?ml$/.test(file)) for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) add(match[1], file);
  }
}
const escape = text => text.replaceAll('|', '\\|').replaceAll('`', "'").replaceAll('\n', ' ');
const header = '# Environment variable reference\n\nGenerated from the checked-in `.env.example`, runtime configuration and infrastructure sources; this command never reads local or production `.env` files. Examples are illustrative, not evidence of a configured deployment. Secret values are omitted. Joi validation and application configuration remain authoritative for types, bounds and required combinations.\n\nGenerate with `npm run docs:environment`; CI verifies freshness with `npm run release:check`. For secrets, use the supported `_FILE` variables and secret mounts. Review the P0/P1/P2 readiness documents before enabling payments, recording, scanners or distributed media.\n\n| Variable | Example/default in template | Notes | Source |\n| --- | --- | --- | --- |\n';
const rendered = header + [...variables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => `| \`${name}\` | ${escape(item.value)} | ${escape(item.notes)} | ${[...locations.get(name) || []].sort().slice(0, 3).map(file => `[source](../${file})`).join(", ") || ".env.example"} |`).join('\n') + '\n';
const target = path.join(root, 'docs/environment-reference.md');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== rendered) { process.stderr.write('Environment reference is stale. Run npm run docs:environment and review the diff.\n'); process.exitCode = 1; }
  else process.stdout.write(`Environment reference covers ${variables.size} documented configuration variables.\n`);
} else { fs.writeFileSync(target, rendered); process.stdout.write(`Generated reference for ${variables.size} documented configuration variables.\n`); }
