#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const [file, sections] of Object.entries({
  'docs/release-checklist.md': ['Migration checks', 'Rollback', 'Screenshots', 'Signoff', 'Escalation'],
  'docs/p2-release-readiness.md': ['Classroom policies', 'Accessibility', 'CMS', 'Remaining deployment proof'],
  'docs/deployment.md': ['setup:cms', 'replica set'],
})) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const section of sections) if (!text.includes(section)) throw Error(`${file} is missing ${section}.`);
}
const check = spawnSync(process.execPath, [path.join(__dirname, 'environment-reference.cjs'), '--check'], { cwd: root, stdio: 'inherit' });
if (check.status !== 0) process.exitCode = 1;
else process.stdout.write('Release documentation and environment inventory are present. Human and deployment signoffs remain separate.\n');
