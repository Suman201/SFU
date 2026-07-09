import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ContactInboxService } from './contact-inbox.service';

describe('ContactInboxService', () => {
  it('stores a sanitized public contact submission and writes audit metadata', async () => {
    const { service, submissions, auditLogs } = createService();
    submissions.create.mockImplementation(async (payload: unknown) => submissionDoc(payload as Record<string, unknown>));

    const ack = await service.createPublicSubmission(
      {
        name: '<b>Ada</b>',
        email: 'ADA@EXAMPLE.TEST',
        subject: 'Partnership',
        message: '<script>alert(1)</script>Hello bearer token-123',
        category: 'partnership',
        sourcePageSlug: 'Contact Us'
      },
      { ipAddress: '127.0.0.1', userAgent: 'Browser' }
    );

    const payload = submissions.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.name).toBe('Ada');
    expect(payload.email).toBe('ada@example.test');
    expect(payload.message).toBe('Hello [redacted]');
    expect(payload.category).toBe('partnership');
    expect(payload.sourcePageSlug).toBe('contact-us');
    expect(typeof payload.ipHash).toBe('string');
    expect(ack.submissionId).toBe('submission-1');
    const auditPayload = auditLogs.record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditPayload.action).toBe('contact.submission.created');
    expect(auditPayload.resourceType).toBe('contact_submission');
  });

  it('rejects invalid public contact emails', async () => {
    const { service, submissions } = createService();

    let thrown: unknown;
    try {
      await service.createPublicSubmission({ name: 'Ada', email: 'bad', subject: 'Hello', message: 'Message' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(submissions.create).not.toHaveBeenCalled();
  });

  it('rejects admin inbox reads for non-admin users', async () => {
    const { service, submissions } = createService();

    let thrown: unknown;
    try {
      await service.listAdminSubmissions(studentUser());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(submissions.find).not.toHaveBeenCalled();
  });

  it('stores admin replies even when email is skipped', async () => {
    const doc = submissionDoc({ email: 'sender@example.test', subject: 'Help', replies: [] });
    const { service, submissions, email, auditLogs } = createService();
    submissions.findOne.mockReturnValue(query(doc));
    email.sendEmail.mockResolvedValue({ channel: 'email', attempted: 1, delivered: 0, skipped: 1, failed: 0, errors: [] });

    const updated = await service.replyToSubmission(adminUser(), 'submission-1', { message: 'Thanks, we will help.' });

    expect(email.sendEmail).toHaveBeenCalledWith({
      to: 'sender@example.test',
      subject: 'Re: Help',
      text: 'Thanks, we will help.'
    });
    expect(doc.replies.length).toBe(1);
    expect(doc.replies[0]?.deliveryStatus).toBe('skipped');
    expect(updated.status).toBe('open');
    expect(doc.save).toHaveBeenCalled();
    const auditPayload = auditLogs.record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditPayload.action).toBe('contact.submission.replied');
  });

  it('updates status, priority, assignee, and notes for admins', async () => {
    const doc = submissionDoc({ status: 'new', priority: 'normal' });
    const { service, submissions } = createService();
    submissions.findOne.mockReturnValue(query(doc));

    const updated = await service.updateAdminSubmission(adminUser(), 'submission-1', {
      status: 'waiting_for_user',
      priority: 'high',
      assignedToName: 'Admin One',
      internalNotes: 'Follow up tomorrow.'
    });

    expect(updated.status).toBe('waiting_for_user');
    expect(updated.priority).toBe('high');
    expect(updated.assignedToName).toBe('Admin One');
    expect(updated.internalNotes).toBe('Follow up tomorrow.');
    expect(doc.save).toHaveBeenCalled();
  });

  it('archives and marks spam through explicit admin actions', async () => {
    const doc = submissionDoc({ status: 'open' });
    const { service, submissions } = createService();
    submissions.findOne.mockReturnValueOnce(query(doc));

    const archived = await service.archiveSubmission(adminUser(), 'submission-1');
    expect(archived.status).toBe('archived');
    expect(doc.archivedAt).toBeInstanceOf(Date);

    submissions.findOne.mockReturnValueOnce(query(doc));
    const spam = await service.markSpam(adminUser(), 'submission-1');
    expect(spam.status).toBe('spam');
  });
});

function createService() {
  const findChain = queryChain([]);
  const submissions: any = {
    create: jest.fn(),
    find: jest.fn((_filter?: unknown) => findChain),
    findOne: jest.fn((_filter?: unknown) => query(submissionDoc())),
    countDocuments: jest.fn((_filter?: unknown) => query(0))
  };
  const auditLogs = { record: jest.fn().mockResolvedValue(undefined) };
  const email = {
    sendEmail: jest.fn().mockResolvedValue({ channel: 'email', attempted: 1, delivered: 1, skipped: 0, failed: 0, errors: [] })
  };
  return {
    service: new ContactInboxService(submissions as never, auditLogs as never, email as never),
    submissions,
    auditLogs,
    email
  };
}

function adminUser(): AuthenticatedUser {
  return {
    sub: 'admin-1',
    email: 'admin@example.test',
    roles: ['ADMIN'],
    permissions: [],
    tokenId: 'token-1'
  };
}

function studentUser(): AuthenticatedUser {
  return {
    sub: 'student-1',
    email: 'student@example.test',
    roles: ['STUDENT'],
    permissions: [],
    tokenId: 'token-1'
  };
}

function submissionDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mongo-contact-1',
    submissionId: 'submission-1',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '+15550000000',
    subject: 'Hello',
    message: 'Message',
    category: 'general',
    status: 'new',
    priority: 'normal',
    sourcePageSlug: 'contact-us',
    userAgent: 'Browser',
    ipHash: 'hash',
    replies: [],
    internalNotes: '',
    archivedAt: undefined,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  } as any;
}

function query<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
}

function queryChain<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value)
  };
}
