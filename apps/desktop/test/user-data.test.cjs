'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveUserDataPath } = require('../src/user-data.cjs');
const appData = path.resolve('test-app-data');
const current = path.join(appData, 'Sapiovian Classroom');
const legacy = path.join(appData, 'EDCONNECTION Classroom');
test('a renamed installation retains its existing session and settings directory', () => {
  assert.equal(
    resolveUserDataPath({
      appData,
      isPackaged: true,
      exists: (p) => p === legacy,
    }),
    legacy,
  );
});
test('fresh installations use the Sapiovian directory', () => {
  assert.equal(
    resolveUserDataPath({ appData, isPackaged: true, exists: () => false }),
    current,
  );
});
test('an existing Sapiovian profile takes precedence over a legacy profile', () => {
  assert.equal(
    resolveUserDataPath({ appData, isPackaged: true, exists: () => true }),
    current,
  );
});
test('test profiles can override development only', () => {
  const override = path.resolve('isolated-profile');
  assert.equal(
    resolveUserDataPath({ appData, isPackaged: false, override }),
    override,
  );
  assert.equal(
    resolveUserDataPath({
      appData,
      isPackaged: true,
      override,
      exists: () => false,
    }),
    current,
  );
});
