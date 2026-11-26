#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const p1 = process.argv.includes('--p1');
const p2 = process.argv.includes('--p2');
if (p1 && p2) throw Error('Choose one acceptance suite.');
const mongo = process.env.P0_MONGODB_URI || 'mongodb://127.0.0.1:27028/whiteboard_acceptance?directConnection=true&replicaSet=p0-tests';
const redis = process.env.P0_REDIS_URL || 'redis://127.0.0.1:6394/15';
const m = new URL(mongo), r = new URL(redis);
if (m.hostname !== '127.0.0.1' || m.port !== '27028' || m.pathname !== '/whiteboard_acceptance' || r.hostname !== '127.0.0.1' || r.port !== '6394' || r.pathname !== '/15') throw Error('P0 acceptance only runs on its owned local database/services.');
const patch = spawnSync(process.execPath, [path.join(root, 'scripts/patch-playwright-loader.cjs')], { cwd: root, stdio: 'inherit' });
if (patch.status !== 0) process.exit(patch.status || 1);
const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', p2 ? '--config=playwright.p2.config.ts' : p1 ? '--config=playwright.p1.config.ts' : '--config=playwright.p0.config.ts', ...process.argv.slice(2).filter(arg => arg !== '--p1' && arg !== '--p2')], {
  cwd: root, stdio: 'inherit', env: {
    ...process.env,
    MONGODB_URI: mongo, REDIS_URL: redis, REDIS_REQUIRED: 'true',
    P0_FRONTEND_DIR: path.join(root, 'apps/frontend/dist/p0-frontend/browser'),
    JWT_ACCESS_SECRET: 'p0-access-synthetic-fixture-secret-32', JWT_REFRESH_SECRET: 'p0-refresh-synthetic-fixture-secret-32',
    TURN_SECRET: 'p0-turn-synthetic-fixture-secret-32',
    RATE_LIMIT_MAX: '5000', RECORDING_STORAGE_DRIVER: 'local',
    SFU_NODE_BIN: process.execPath,
    UPLOAD_SCAN_ENABLED: 'false', PAYMENTS_ENABLED: 'false', PAYMENT_GATEWAY: 'test', BOOKINGS_ENABLED: 'false', SMTP_ENABLED: 'false',
    STRIPE_SECRET_KEY: '', STRIPE_SECRET_KEY_FILE: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_WEBHOOK_SECRET_FILE: '',
    PAYMENTS_STRIPE_WEBHOOK_SECRET: '', PAYMENTS_STRIPE_WEBHOOK_SECRET_FILE: '',
    P1_REQUIRED_PROOF: p1 ? 'true' : 'false',
  },
});
process.exitCode = typeof result.status === 'number' ? result.status : 1;
