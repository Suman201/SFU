#!/usr/bin/env node
'use strict';
// Read-only application checks, except private temporary storage probes that are removed immediately.
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
(async () => {
  const base = option('--base-url');
  if (!base)
    throw new Error(
      'Use --base-url http://127.0.0.1:3000 and set TUTOR_READINESS_ADMIN_TOKEN or --token-file.',
    );
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Use an HTTP(S) base URL without credentials.');
  const token =
    process.env.TUTOR_READINESS_ADMIN_TOKEN ||
    (option('--token-file')
      ? fs.readFileSync(option('--token-file'), 'utf8').trim()
      : '');
  if (!token)
    throw new Error(
      'Provide an admin token through TUTOR_READINESS_ADMIN_TOKEN or --token-file.',
    );
  const response = await fetch(
    new URL('/api/v1/admin/tutor-onboarding/readiness', url),
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`Readiness request failed (HTTP ${response.status}).`);
  const envelope = await response.json();
  const result = envelope.data ?? envelope;
  const text = JSON.stringify(result, null, 2) + '\n';
  if (option('--output'))
    fs.writeFileSync(option('--output'), text, { mode: 0o600 });
  process.stdout.write(text);
  process.exitCode = result.technicalReady ? 0 : 2;
})().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
