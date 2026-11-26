#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createConnection } = require('node:net');
const assert = require('node:assert/strict');
const { scanUpload } = require('../apps/backend/dist/common/security/upload-scanner.js');
const root = path.resolve(__dirname, '..');
const name = 'sfu-p1-scanner-' + randomUUID().slice(0, 8);
const label = 'com.sapiovian.test-suite=p1-upload-scan';
const work = mkdtempSync(path.join(tmpdir(), 'sfu-p1-scan-'));
const report = { generatedAt: new Date().toISOString(), passed: false, productionSignoff: false, engine: 'clamav/clamav:1.5_base', syntheticTestSignatureOnly: true, productionVirusDatabase: false, checks: {} };
function docker(args) { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim(); }
function stop() {
  let owner;
  try { owner = docker(['inspect', '--format', '{{ index .Config.Labels "com.sapiovian.test-suite" }}', name]); } catch { return; }
  if (owner !== 'p1-upload-scan') throw Error('Refusing to remove unowned scanner container.');
  docker(['rm', '--force', '--volumes', name]);
}
function ping(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(Error('Scanner startup pending')), 1000);
    socket.once('error', finish);
    socket.once('connect', () => socket.write('zPING\0'));
    socket.once('data', bytes => finish(bytes.toString().startsWith('PONG') ? undefined : Error('Unexpected scanner response')));
  });
}
async function main() {
  chmodSync(work, 0o755);
  const marker = 'P1-ANTIVIRUS-ACCEPTANCE-MARKER';
  writeFileSync(path.join(work, 'acceptance.ndb'), 'P1SyntheticUnsafePayload:0:*:' + Buffer.from(marker).toString('hex') + '\n', { mode: 0o644 });
  writeFileSync(path.join(work, 'clamd.conf'), 'Foreground yes\nTCPSocket 3310\nTCPAddr 0.0.0.0\nDatabaseDirectory /fixtures\nLogFile /tmp/clamd.log\nPidFile /tmp/clamd.pid\nStreamMaxLength 64M\n', { mode: 0o644 });
  docker(['run', '--detach', '--name', name, '--label', label, '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp', '--publish', '127.0.0.1::3310', '--volume', work + ':/fixtures:ro', '--entrypoint', 'clamd', report.engine, '--config-file=/fixtures/clamd.conf']);
  const port = Number(docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "3310/tcp") 0).HostPort}}', name]));
  const deadline = Date.now() + 60000;
  while (true) { try { await ping(port); break; } catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 500)); } }
  const options = { host: '127.0.0.1', port, timeoutMs: 5000, maxBytes: 67108864 };
  await scanUpload(Buffer.from('%PDF-1.4\nP1 ordinary classroom fixture\n%%EOF'), options);
  report.checks.cleanFileAccepted = true;
  await assert.rejects(scanUpload(Buffer.from(marker), options), error => error.getStatus?.() === 400);
  report.checks.engineDetectionRejected = true;
  stop();
  await assert.rejects(scanUpload(Buffer.from('unavailable scanner fixture'), options), error => error.getStatus?.() === 503);
  report.checks.unavailableFailsClosed = true;
  report.passed = true;
}
main().catch(error => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  try { stop(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  rmSync(work, { recursive: true, force: true });
  const output = path.join(root, 'reports/p1/upload-security'); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'engine-drill.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
});
