"use strict";
function buildConfiguration(base, runtime, env = process.env) {
  if (env.SFU_DESKTOP_RELEASE === 'true') {
    const { releaseConfiguration } = require('./release-config.cjs');
    const release = releaseConfiguration(env);
    if (runtime.serverUrl !== release.serverUrl || runtime.websiteUrl !== release.websiteUrl || runtime.updateUrl !== release.updateUrl) throw new Error('Release runtime configuration does not match the reviewed settings.');
    return { ...base, forceCodeSigning: true, publish: { provider: 'generic', url: release.updateUrl },
      mac: { ...base.mac, notarize: true },
      win: { ...base.win, verifyUpdateCodeSignature: true, ...(release.platform === 'win' ? { azureSignOptions: release.azureSignOptions } : {}) },
    };
  }
  if (!runtime.updateUrl) return { ...base, publish: null };
  const url = new URL(runtime.updateUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "Update publishing requires an HTTPS feed without credentials.",
    );
  return {
    ...base,
    publish: { provider: "generic", url: url.href },
    forceCodeSigning: true,
  };
}
module.exports = { buildConfiguration };
