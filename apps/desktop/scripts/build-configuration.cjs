"use strict";
function buildConfiguration(base, runtime) {
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
