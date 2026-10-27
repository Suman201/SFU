"use strict";

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function trustedPermissionFrame(
  contents,
  mainContents,
  expectedOrigin,
  details,
  requestingOrigin,
) {
  return Boolean(
    contents &&
      contents === mainContents &&
      details?.isMainFrame === true &&
      originOf(
        requestingOrigin || details.securityOrigin || details.requestingUrl,
      ) === expectedOrigin,
  );
}

function mediaTypes(details) {
  if (Array.isArray(details?.mediaTypes))
    return [
      ...new Set(
        details.mediaTypes.filter(
          (type) => type === "video" || type === "audio",
        ),
      ),
    ];
  return details?.mediaType === "video" || details?.mediaType === "audio"
    ? [details.mediaType]
    : [];
}

function nativeMediaType(type) {
  return type === "video" ? "camera" : "microphone";
}

function hasMacMediaConsent(preferences, details) {
  const types = mediaTypes(details);
  return (
    types.length > 0 &&
    types.every(
      (type) =>
        preferences.getMediaAccessStatus(nativeMediaType(type)) === "granted",
    )
  );
}

async function requestMacMediaConsent(preferences, details) {
  const types = mediaTypes(details);
  if (!types.length) return false;
  for (const type of types) {
    const nativeType = nativeMediaType(type);
    const status = preferences.getMediaAccessStatus(nativeType);
    if (status === "denied" || status === "restricted") return false;
    if (
      status !== "granted" &&
      !(await preferences.askForMediaAccess(nativeType))
    )
      return false;
  }
  return true;
}

module.exports = {
  trustedPermissionFrame,
  mediaTypes,
  hasMacMediaConsent,
  requestMacMediaConsent,
};
