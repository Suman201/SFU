import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { EmailNotificationService } from './email-notification.service';
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
describe('Sensitive recovery email errors', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('does not log or return an SMTP response containing a reset link', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = 'provider echoed https://example.test/reset-password#token=secret-reset-token';
    jest.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: jest.fn<() => Promise<void>>().mockRejectedValue(new Error(error)) } as never);
    const config = new ConfigService({ notifications: { email: { enabled: true, host: '127.0.0.1', fromEmail: 'security@example.test' } } });
    const result = await new EmailNotificationService(config).sendEmail({ to: 'learner@example.test', subject: 'Reset password', text: 'secret reset link', sensitive: true });
    expect(result.failed).toBe(1); expect(JSON.stringify(result)).not.toContain('secret-reset-token'); expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-reset-token'); warn.mockRestore();
  });
});
