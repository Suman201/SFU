#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'packages/contracts/dist');
const baselinePath = path.join(root, 'packages/contracts/api-baseline.json');
if (!fs.existsSync(directory)) throw Error('Build @native-sfu/contracts before checking its API.');
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const declarations = {};
for (const name of fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith('.d.ts')).sort()) {
  const source = ts.createSourceFile(name, fs.readFileSync(path.join(directory, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  declarations[name.replaceAll(path.sep, '/')] = createHash('sha256').update(printer.printFile(source)).digest('hex');
}
if (!Object.keys(declarations).length) throw Error('No compiled contract declarations found.');
if (process.argv.includes('--update')) {
  fs.writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, declarations }, null, 2) + '\n');
  process.stdout.write('Updated the public API baseline. Review the source diff and bump the wire protocol for incompatible changes.\n');
} else {
  const previous = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).declarations;
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(declarations)])].filter(name => previous[name] !== declarations[name]);
  if (changed.length) { process.stderr.write('Public contract API changed: ' + changed.join(', ') + '\nReview compatibility, bump the wire protocol for breaking changes, and run npm run contracts:baseline.\n'); process.exitCode = 1; }
  else process.stdout.write('Public contract API matches the reviewed baseline.\n');
}
