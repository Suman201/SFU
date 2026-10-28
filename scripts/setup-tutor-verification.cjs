#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const i = args.indexOf('--secret-file');
const file = path.resolve(
  i >= 0 ? args[i + 1] : '.local-secrets/tutor-verification.key',
);
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
if (!fs.existsSync(file))
  fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
const key = fs.readFileSync(file, 'utf8').trim();
if (
  Buffer.from(key, 'base64').length !== 32 ||
  Buffer.from(key, 'base64').toString('base64') !== key
)
  throw new Error(
    'The existing key file must contain a 32-byte base64 key. It was not overwritten.',
  );
fs.chmodSync(file, 0o600);
if (i < 0) {
  const env = path.resolve('.env');
  let text = fs.existsSync(env) ? fs.readFileSync(env, 'utf8') : '';
  if (!/^TUTOR_VERIFICATION_ENCRYPTION_KEY(?:_FILE)?=.+$/m.test(text)) {
    text += '\nTUTOR_VERIFICATION_ENCRYPTION_KEY_FILE=' + file + '\n';
    fs.writeFileSync(env, text, { mode: 0o600 });
  }
}
process.stdout.write(
  'Private verification key is configured. Keep the key outside Git and retain a separate secure backup.\n',
);
