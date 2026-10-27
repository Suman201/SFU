import { normalizeDesktopDestination } from './desktop-bridge';

describe('desktop classroom destinations', () => {
  it('normalizes teacher invitations to the server-authorized join route', () => {
    expect(normalizeDesktopDestination('/class-session/teacher?sessionId=session-1&batchId=batch-2&accessToken=secret'))
      .toBe('/desktop/join?sessionId=session-1&batchId=batch-2');
  });
  it('preserves a student invitation across sign-in without trusting its role', () => {
    expect(normalizeDesktopDestination('/class-session/student?batchId=batch-2&sessionId=session-1'))
      .toBe('/desktop/join?sessionId=session-1&batchId=batch-2');
  });
  it('rejects external, malformed and administration destinations', () => {
    for (const destination of ['https://attacker.test/', '//attacker.test/', '/\\attacker.test/', '/teacher/dashboard', '/desktop/join?sessionId=../admin', '/desktop/join', '/desktop/join?sessionId=a&batchId=%2Fsecret']) {
      expect(normalizeDesktopDestination(destination)).withContext(destination).toBeNull();
    }
  });
  it('permits only the two safe landing screens and drops arbitrary query parameters', () => {
    expect(normalizeDesktopDestination('/desktop/upcoming?accessToken=secret')).toBe('/desktop/upcoming');
    expect(normalizeDesktopDestination('/desktop/recordings')).toBe('/desktop/recordings');
  });
});
