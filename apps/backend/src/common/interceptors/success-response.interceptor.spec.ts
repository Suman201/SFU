import { StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { SuccessResponseInterceptor } from './success-response.interceptor';

describe('SuccessResponseInterceptor', () => {
  it('does not wrap guarded class-session chat attachment downloads', async () => {
    const interceptor = new SuccessResponseInterceptor();

    const response = await firstValueFrom(
      interceptor.intercept(executionContext('/api/v1/class-sessions/session-1/chat/attachments/attachment-1'), handler('raw-bytes'))
    );

    expect(response).toBe('raw-bytes');
  });

  it('preserves streamed introduction video bytes', async () => {
    const file = new StreamableFile(Buffer.from('video bytes'));
    const result = await firstValueFrom(new SuccessResponseInterceptor().intercept(executionContext('/api/v1/tutor-application/me/introduction-video'), handler(file)));
    expect(result).toBe(file);
  });

  it('wraps regular API responses', async () => {
    const interceptor = new SuccessResponseInterceptor();

    const response = await firstValueFrom(interceptor.intercept(executionContext('/api/v1/rooms'), handler({ id: 'room-1' })));

    expect(response).toEqual({
      success: true,
      message: 'OK',
      data: { id: 'room-1' }
    });
  });
});

function executionContext(originalUrl: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl })
    })
  } as ExecutionContext;
}

function handler(value: unknown): CallHandler {
  return {
    handle: () => of(value)
  };
}
