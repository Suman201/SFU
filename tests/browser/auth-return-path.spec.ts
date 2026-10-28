import { expect, test } from '@playwright/test';
import { safeAuthReturnPath } from '../../apps/frontend/src/app/core/services/auth-return-path';
test('keeps teacher classroom and calendar destinations after login', () => {
  expect(
    safeAuthReturnPath(
      '/class-session/teacher?sessionId=lesson&batchId=batch',
      'teacher',
    ),
  ).toBe('/class-session/teacher?sessionId=lesson&batchId=batch');
  expect(safeAuthReturnPath('/calendar?month=2026-11', 'teacher')).toBe(
    '/calendar?month=2026-11',
  );
});
test('keeps student classroom destinations and existing role pages', () => {
  expect(
    safeAuthReturnPath(
      '/class-session/student?sessionId=lesson&batchId=batch',
      'student',
    ),
  ).toBe('/class-session/student?sessionId=lesson&batchId=batch');
  expect(safeAuthReturnPath('/student/dashboard', 'student')).toBe(
    '/student/dashboard',
  );
});
test('rejects destinations belonging to another role', () => {
  expect(
    safeAuthReturnPath('/class-session/teacher?sessionId=lesson', 'student'),
  ).toBeNull();
  expect(safeAuthReturnPath('/student/profile', 'teacher')).toBeNull();
  expect(safeAuthReturnPath('/admin', 'teacher')).toBeNull();
});
test('rejects external URLs, protocol-relative URLs, traversal and backslashes', () => {
  for (const path of [
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/teacher/../admin',
    '/teacher/%2e%2e/admin',
    'javascript:alert(1)',
  ])
    expect(safeAuthReturnPath(path, 'teacher')).toBeNull();
});
