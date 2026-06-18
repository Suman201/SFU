import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { OperationsTokenGuard } from './operations-token.guard';

describe('OperationsTokenGuard', () => {
  it('allows access when no operations token is configured', () => {
    const guard = new OperationsTokenGuard({
      get: jest.fn(() => undefined)
    } as never);

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('accepts requests with the configured operations token header', () => {
    const guard = new OperationsTokenGuard({
      get: jest.fn(() => 'ops-token-12345678901234567890')
    } as never);

    expect(guard.canActivate(createContext('ops-token-12345678901234567890'))).toBe(true);
  });

  it('rejects requests without a matching operations token header', () => {
    const guard = new OperationsTokenGuard({
      get: jest.fn(() => 'ops-token-12345678901234567890')
    } as never);

    expect(() => guard.canActivate(createContext())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(createContext('wrong-token'))).toThrow(UnauthorizedException);
  });
});

function createContext(token?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: token ? { 'x-operations-token': token } : {}
      })
    })
  } as ExecutionContext;
}
