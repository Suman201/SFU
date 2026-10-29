import { describe, it, expect, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { RequestIdMiddleware } from '../middleware/request-id.middleware';
import { errorFrames, errorPath } from '@native-sfu/contracts';

describe('Public error contract', () => {
  function run(error: unknown, path = '/api/v1/test?token=secret') {
    let body: any;
    const capture = jest.fn();
    const headers: Record<string, string> = {};
    new GlobalExceptionFilter(
      {
        httpAdapter: {
          reply: (_response: unknown, value: unknown) => {
            body = value;
          },
          setHeader: (_response: unknown, key: string, value: string) => {
            headers[key] = value;
          },
        },
      } as never,
      { capture } as never,
    ).catch(error, {
      switchToHttp: () => ({
        getRequest: () => ({
          url: path,
          method: 'POST',
          id: 'test-reference-123',
        }),
        getResponse: () => ({}),
      }),
    } as never);
    return { body, capture, headers };
  }
  it('keeps internal exception messages and request queries out of the response', () => {
    const { body, capture, headers } = run(
      new Error('password=top-secret database URI'),
    );
    expect(body).toMatchObject({
      statusCode: 500,
      code: 'SAP4001',
      reason: 'INTERNAL_ERROR',
      requestId: 'test-reference-123',
      path: '/api/v1/test',
    });
    expect(JSON.stringify(body)).not.toMatch(/top-secret|token=|database URI/);
    expect(body.nextStep).toContain('before trying again');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['x-request-id']).toBe(body.requestId);
    expect(headers['x-error-code']).toBe(body.code);
  });
  it('also sanitizes explicitly thrown 5xx HttpExceptions', () => {
    const { body, capture } = run(
      new ServiceUnavailableException('Internal connection string secret'),
    );
    expect(body.code).toBe('SAP3003');
    expect(JSON.stringify(body)).not.toContain('connection string');
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('flattens nested validation constraints without leaking target objects or field values', () => {
    const { body, capture } = run(
      new BadRequestException([
        {
          property: 'profile',
          target: { password: 'hidden' },
          children: [
            {
              property: 'email',
              value: 'hidden@example.com',
              constraints: { isEmail: 'Enter a valid email address.' },
            },
          ],
        },
      ]),
    );
    expect(body.errors).toEqual([
      { field: 'profile.email', message: 'Enter a valid email address.' },
    ]);
    expect(body.message).toBe('Validation failed');
    expect(JSON.stringify(body)).not.toMatch(/hidden|target/);
    expect(capture).not.toHaveBeenCalled();
  });
  it('explains sign-in and access failures without recording routine mistakes as incidents', () => {
    expect(
      run(
        new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials',
        }),
        '/api/v1/auth/login',
      ).body.code,
    ).toBe('SAP2001');
    const denied = run(
      new ForbiddenException('Only enrolled students can join.'),
    );
    expect(denied.body).toMatchObject({
      code: 'SAP2003',
      reason: 'ACCESS_DENIED',
      message: 'Only enrolled students can join.',
    });
    expect(denied.capture).not.toHaveBeenCalled();
  });
  it('recognizes body-parser failures without echoing malformed request content', () => {
    expect(
      run({ type: 'entity.parse.failed', body: 'secret' }).body.statusCode,
    ).toBe(400);
    expect(run({ type: 'entity.too.large' }).body.code).toBe('SAP1003');
  });
  it('honors registered exception codes and rejects unknown codes', () => {
    expect(
      run(
        new BadRequestException({
          code: 'UNSUPPORTED_FILE_TYPE',
          message: 'Choose a PDF.',
        }),
      ).body,
    ).toMatchObject({
      code: 'SAP1004',
      reason: 'UNSUPPORTED_FILE_TYPE',
      statusCode: 400,
      message: 'Choose a PDF.',
    });
    expect(
      run(
        new BadRequestException({
          code: 'PRIVATE_CUSTOM_ERROR',
          message: 'Review the request.',
        }),
      ).body.code,
    ).toBe('SAP1001');
    const internal = run(
      new ServiceUnavailableException({
        code: 'REQUEST_TIMEOUT',
        message: 'secret database address',
      }),
    ).body;
    expect(internal.code).toBe('SAP3002');
    expect(internal.message).not.toContain('secret');
  });
  it('uses safe request IDs and returns the same header reference', () => {
    const req: any = { header: () => 'forged id with spaces\n' };
    const setHeader = jest.fn();
    const next = jest.fn();
    new RequestIdMiddleware().use(req, { setHeader } as never, next);
    expect(req.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(setHeader).toHaveBeenCalledWith('x-request-id', req.id);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('retains only file basenames and frame coordinates in diagnostics', () => {
    expect(
      errorFrames(
        'Error: secret\n    at work (/private/user/path/service.js:12:4)\nrun@https://user:password@example.com/chunk.js?token=secret:5:6',
      ),
    ).toEqual(['service.js:12:4', 'chunk.js:5:6']);
    expect(
      errorPath(
        'https://user:password@example.com/calendar?token=secret#private',
      ),
    ).toBe('/calendar');
  });
});
