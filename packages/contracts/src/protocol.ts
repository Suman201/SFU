/** Bump for an incompatible wire change; older unversioned clients speak v1. */
export const SFU_PROTOCOL_VERSION = 1;
export const SFU_PROTOCOL_HEADER = 'x-sfu-protocol-version';
export const SFU_CLIENT_UPDATE_MESSAGE = 'This app version is no longer supported. Refresh the page or update the app.';
export function supportsSfuProtocol(value: unknown): boolean {
  const version = value === undefined ? 1 : value;
  return version === SFU_PROTOCOL_VERSION || version === String(SFU_PROTOCOL_VERSION);
}
