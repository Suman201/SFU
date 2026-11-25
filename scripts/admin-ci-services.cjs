#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const label = 'com.sapiovian.test-suite';
const services = ['sfu-admin-ci-mongo', 'sfu-admin-ci-redis'];
function docker(args, timeout = 30000) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
}
function owned(name) {
  try {
    return (
      docker([
        'inspect',
        '--format',
        '{{ index .Config.Labels "' + label + '" }}',
        name,
      ]) === 'admin-ci'
    );
  } catch {
    return false;
  }
}
async function waitFor(check, description) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      /* The isolated service is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for ' + description);
}
function stop() {
  for (const name of services) {
    if (owned(name)) {
      docker(['rm', '--force', '--volumes', name]);
      process.stdout.write('Removed ' + name + '\n');
    }
  }
}
async function start() {
  const created = [];
  try {
    for (const name of services) {
      let exists = false;
      try {
        docker(['inspect', name]);
        exists = true;
      } catch {
        /* No such container. */
      }
      if (exists)
        throw new Error(name + ' already exists. Refusing to replace it.');
    }
    docker(
      [
        'run',
        '--detach',
        '--name',
        services[0],
        '--label',
        label + '=admin-ci',
        '--publish',
        '127.0.0.1:27124:27017',
        'mongo:7',
        '--replSet',
        'booking-tests',
        '--bind_ip_all',
      ],
      120000,
    );
    created.push(services[0]);
    docker(
      [
        'run',
        '--detach',
        '--name',
        services[1],
        '--label',
        label + '=admin-ci',
        '--publish',
        '127.0.0.1:6395:6379',
        'redis:7-alpine',
      ],
      120000,
    );
    created.push(services[1]);
    await waitFor(
      () =>
        docker([
          'exec',
          services[0],
          'mongosh',
          '--quiet',
          '--eval',
          'db.adminCommand({ping:1}).ok',
        ]) === '1',
      'MongoDB',
    );
    docker([
      'exec',
      services[0],
      'mongosh',
      '--quiet',
      '--eval',
      'rs.initiate({_id:"booking-tests",members:[{_id:0,host:"127.0.0.1:27017"}]})',
    ]);
    await waitFor(
      () =>
        docker([
          'exec',
          services[0],
          'mongosh',
          '--quiet',
          '--eval',
          'db.hello().isWritablePrimary',
        ]) === 'true',
      'MongoDB primary election',
    );
    await waitFor(
      () => docker(['exec', services[1], 'redis-cli', 'ping']) === 'PONG',
      'Redis',
    );
    process.stdout.write(
      'Admin CI Mongo replica set and Redis are ready on isolated localhost ports 27124 and 6395.\n',
    );
  } catch (error) {
    for (const name of created)
      if (owned(name)) docker(['rm', '--force', '--volumes', name]);
    throw error;
  }
}
async function main() {
  const mode = process.argv[2];
  if (mode === 'up') await start();
  else if (mode === 'down') stop();
  else if (mode === 'logs') {
    for (const name of services)
      if (owned(name))
        process.stdout.write(
          name + '\n' + docker(['logs', '--tail', '150', name]) + '\n',
        );
  } else
    throw new Error('Usage: node scripts/admin-ci-services.cjs up|down|logs');
}
main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
