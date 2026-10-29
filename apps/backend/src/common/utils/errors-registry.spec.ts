import { describe, it, expect } from '@jest/globals';
import {
  ERROR_CATALOG,
  errorGuideUrl,
  errorReason,
  publicErrorCode,
  type AppErrorCode,
} from '@native-sfu/contracts';

describe('Published Sapiovian error identifiers', () => {
  it('keeps published identifiers stable and unique', () => {
    const published = {
      VALIDATION_FAILED: 'SAP1001',
      INVALID_REQUEST: 'SAP1002',
      REQUEST_TOO_LARGE: 'SAP1003',
      UNSUPPORTED_FILE_TYPE: 'SAP1004',
      CONFLICT: 'SAP1005',
      INVALID_CREDENTIALS: 'SAP2001',
      AUTHENTICATION_REQUIRED: 'SAP2002',
      ACCESS_DENIED: 'SAP2003',
      RESOURCE_NOT_FOUND: 'SAP2004',
      NETWORK_ERROR: 'SAP3001',
      REQUEST_TIMEOUT: 'SAP3002',
      SERVICE_UNAVAILABLE: 'SAP3003',
      RATE_LIMITED: 'SAP3004',
      INTERNAL_ERROR: 'SAP4001',
      INVALID_RESPONSE: 'SAP4002',
      CLIENT_ERROR: 'SAP4003',
      DEVICE_PERMISSION_DENIED: 'SAP5001',
      DEVICE_NOT_FOUND: 'SAP5002',
      DEVICE_BUSY: 'SAP5003',
      CLASSROOM_ERROR: 'SAP5004',
    };
    expect(
      Object.fromEntries(
        Object.entries(ERROR_CATALOG).map(([reason, info]) => [
          reason,
          info.code,
        ]),
      ),
    ).toEqual(published);
    expect(new Set(Object.values(published)).size).toBe(20);
  });
  it('resolves every numbered code and legacy reason to the same registry entry', () => {
    for (const reason of Object.keys(ERROR_CATALOG) as AppErrorCode[]) {
      const code = publicErrorCode(reason);
      expect(errorReason(code)).toBe(reason);
      expect(errorReason(reason)).toBe(reason);
      expect(errorGuideUrl('https://admin.example.com', reason)).toBe(
        errorGuideUrl('https://admin.example.com', code),
      );
    }
  });
  it('rejects invented codes and arbitrary paths', () => {
    for (const value of ['SAP9999', '../SAP3001', '', null, {}, 'toString'])
      expect(errorReason(value)).toBeUndefined();
    expect(
      errorGuideUrl('https://admin.example.com', 'SAP9999' as never),
    ).toBeNull();
  });
});
