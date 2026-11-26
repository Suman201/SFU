import { describe, expect, it } from '@jest/globals';
import { validatePasswordRecoveryConfig } from './password-recovery.config';
const config = { NODE_ENV: 'production', SMTP_ENABLED: true, FRONTEND_URL: 'https://learn.example.test', ADMIN_PORTAL_URL: 'https://admin.example.test' };
describe('Password recovery origins', () => {
  it('needs no recovery origins when SMTP is disabled', () => { const errors: string[] = []; validatePasswordRecoveryConfig({}, errors); expect(errors).toEqual([]); });
  it('accepts fixed production origins', () => { const errors: string[] = []; validatePasswordRecoveryConfig(config, errors); expect(errors).toEqual([]); });
  it.each(['http://example.test', 'https://example.test/path', 'https://user:password@example.test', 'https://example.test/?redirect=evil', 'https://example.test/#fragment', ''])('rejects unsafe origins: %s', url => {
    const errors: string[] = []; validatePasswordRecoveryConfig({ ...config, FRONTEND_URL: url }, errors); expect(errors).toHaveLength(1);
  });
  it('requires the admin origin for SMTP recovery', () => { const errors: string[] = []; validatePasswordRecoveryConfig({ ...config, ADMIN_PORTAL_URL: '' }, errors); expect(errors[0]).toContain('ADMIN_PORTAL_URL'); });
  it('allows loopback development origins', () => { const errors: string[] = []; validatePasswordRecoveryConfig({ ...config, NODE_ENV: 'test', FRONTEND_URL: 'http://127.0.0.1:4200', ADMIN_PORTAL_URL: 'http://localhost:4300' }, errors); expect(errors).toEqual([]); });
});
