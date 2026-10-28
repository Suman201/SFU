'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, 'setup-tutor-verification.cjs');
test('setup creates a private key, preserves it, and never prints it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-key-setup-'));
  try {
    const run = () =>
      spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const keyFile = path.join(cwd, '.local-secrets/tutor-verification.key');
    const key = fs.readFileSync(keyFile, 'utf8');
    assert.equal(Buffer.from(key.trim(), 'base64').length, 32);
    assert.equal(fs.statSync(keyFile).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o077, 0);
    assert.equal(first.stdout.includes(key.trim()), false);
    const env = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
    assert.ok(env.includes(keyFile));
    assert.equal(env.includes(key.trim()), false);
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), key);
    assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), env);
    fs.writeFileSync(keyFile, 'invalid-existing-key');
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), 'invalid-existing-key');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
test('an explicit key path does not modify the environment file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-key-path-'));
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--secret-file', path.join(cwd, 'private/key')],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
