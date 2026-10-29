import { describe, it, expect, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { ErrorsService, developerDiagnosis } from './errors.service';
describe('Developer explanations', () => {
  it('explains a database validation error without retaining database details', () => {
    const result = developerDiagnosis({
      name: 'MongoServerError',
      code: 121,
      message: 'private connection and field values',
    });
    expect(result.diagnosticKind).toBe('database_validation');
    expect(result.developerHint).toContain('validation rules');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('identifies unreachable dependencies and uses a safe fallback for unknown failures', () => {
    expect(developerDiagnosis({ code: 'ECONNREFUSED' }).diagnosticKind).toBe(
      'dependency_unreachable',
    );
    expect(developerDiagnosis(new Error('secret')).diagnosticKind).toBe(
      'application_exception',
    );
  });
});

describe('Numbered incident metadata', () => {
  it('reads historical semantic-code records as numbered API records without rewriting history', async () => {
    const id = new Types.ObjectId();
    const row = {
      _id: id,
      code: 'NETWORK_ERROR',
      reference: 'legacy-reference-123',
      source: 'web',
      status: 'open',
      createdAt: new Date(),
    };
    const model = { findById: () => ({ lean: async () => row }) };
    const incident = await new ErrorsService(model as never).get(String(id));
    expect(incident.code).toBe('SAP3001');
    expect(incident.reason).toBe('NETWORK_ERROR');
    expect(row.code).toBe('NETWORK_ERROR');
  });
  it('normalizes both numbered and legacy client reports before storage', async () => {
    const update = jest.fn(async () => ({}));
    const service = new ErrorsService({ findOneAndUpdate: update } as never);
    for (const code of ['SAP5001', 'DEVICE_PERMISSION_DENIED'] as const)
      await service.report(
        {
          reference: 'report-reference-123',
          code,
          source: 'web',
          path: '/devices',
        },
        'student-1',
      );
    for (const call of update.mock.calls as unknown as [
      unknown,
      { $setOnInsert: Record<string, unknown> },
    ][])
      expect(call[1].$setOnInsert).toMatchObject({
        code: 'SAP5001',
        reason: 'DEVICE_PERMISSION_DENIED',
      });
  });
  it('rejects reports with a mismatched code/reason pair', async () => {
    const update = jest.fn();
    const service = new ErrorsService({ findOneAndUpdate: update } as never);
    await expect(
      service.report(
        {
          reference: 'report-reference-123',
          code: 'SAP3001',
          reason: 'INTERNAL_ERROR',
          source: 'web',
          path: '/',
        },
        'student-1',
      ),
    ).rejects.toThrow('The error code and reason do not match.');
    expect(update).not.toHaveBeenCalled();
  });
});
