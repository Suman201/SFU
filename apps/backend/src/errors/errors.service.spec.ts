import { describe, it, expect } from '@jest/globals';
import { developerDiagnosis } from './errors.service';
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
