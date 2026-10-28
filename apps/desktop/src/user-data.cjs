'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Keep existing logins and device preferences when upgrading the renamed app.
function resolveUserDataPath({
  appData,
  isPackaged,
  override,
  exists = fs.existsSync,
}) {
  if (!isPackaged && override) return path.resolve(override);
  const current = path.join(appData, 'Sapiovian Classroom');
  const legacy = path.join(appData, 'EDCONNECTION Classroom');
  return !exists(current) && exists(legacy) ? legacy : current;
}
module.exports = { resolveUserDataPath };
