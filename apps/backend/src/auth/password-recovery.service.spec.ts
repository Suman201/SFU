import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PasswordRecoveryService } from './password-recovery.service';
function fixture(enabled = true) {
  const user = { id: 'user-1', email: 'learner@example.test', authVersion: 1 };
  const users = { findOne: jest.fn(), findOneAndUpdate: jest.fn<() => Promise<unknown>>().mockResolvedValue(user) };
  const sessions = { updateMany: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) };
  const jobs = { updateOne: jest.fn<() => Promise<unknown>>().mockResolvedValue({}), create: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) };
  const mail = { sendEmail: jest.fn() };
  const audit = { record: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) };
  const service = new PasswordRecoveryService(users as never, sessions as never, jobs as never, new ConfigService({ notifications: { email: { enabled } } }), mail as never, audit as never);
  return { service, users, sessions, jobs, mail, audit };
}
describe('Password recovery security boundaries', () => {
  it('does not reveal a token or look up account existence during a request', async () => {
    const { service, users, jobs, mail } = fixture();
    expect(await service.request('Known@example.test')).toBeUndefined();
    expect(users.findOne).not.toHaveBeenCalled(); expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(jobs.updateOne).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jobs.updateOne.mock.calls)).not.toContain('resetToken');
  });
  it('keeps a disabled SMTP installation quiet', async () => {
    const { service, jobs } = fixture(false); await service.request('learner@example.test'); expect(jobs.updateOne).not.toHaveBeenCalled();
  });
  it('silently suppresses cooldown duplicates', async () => {
    const { service, jobs } = fixture(); jobs.updateOne.mockRejectedValue({ code: 11000 }); await expect(service.request('learner@example.test')).resolves.toBeUndefined();
  });
  it('does not suppress infrastructure failures as duplicate requests', async () => {
    const { service, jobs } = fixture(); jobs.updateOne.mockRejectedValue(new Error('DB unavailable')); await expect(service.request('learner@example.test')).rejects.toThrow('DB unavailable');
  });
  it('consumes only an active, unexpired hash and changes the session epoch atomically', async () => {
    const { service, users, sessions, jobs } = fixture(); const token = 'a'.repeat(64);
    await service.reset(token, 'NewPassword@123', {});
    expect(users.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ passwordResetHash: createHash('sha256').update(token).digest('hex'), disabled: false, status: 'active', deletedAt: { $exists: false } }), expect.objectContaining({ $inc: { authVersion: 1 }, $unset: { passwordResetHash: 1, passwordResetExpiresAt: 1, passwordResetIssuedAt: 1 } }), { new: true });
    expect(sessions.updateMany).toHaveBeenCalled(); expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'changed', email: 'learner@example.test' }));
    expect(JSON.stringify(jobs.create.mock.calls)).not.toContain('NewPassword@123');
  });
  it('does not undo a completed reset when session-row cleanup fails', async () => {
    const { service, sessions, audit } = fixture(); sessions.updateMany.mockRejectedValue(new Error('DB outage'));
    await expect(service.reset('a'.repeat(64), 'NewPassword@123', {})).resolves.toBeUndefined(); expect(audit.record).toHaveBeenCalled();
  });
  it('rejects expired or replayed links without revoking anyone else', async () => {
    const { service, users, sessions, jobs } = fixture(); users.findOneAndUpdate.mockResolvedValue(null);
    await expect(service.reset('a'.repeat(64), 'NewPassword@123', {})).rejects.toThrow('invalid, expired or already used'); expect(sessions.updateMany).not.toHaveBeenCalled(); expect(jobs.create).not.toHaveBeenCalled();
  });
  it('rejects multibyte passwords exceeding bcrypt capacity instead of truncating them', async () => {
    const { service, users } = fixture(); await expect(service.reset('a'.repeat(64), 'é'.repeat(40), {})).rejects.toThrow('too long'); expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
