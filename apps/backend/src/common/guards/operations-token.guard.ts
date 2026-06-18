import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OperationsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredToken = this.config.get<string | undefined>('security.operationsToken')?.trim();
    if (!configuredToken) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const providedToken = normalizeHeaderValue(request.headers['x-operations-token']);
    if (providedToken === configuredToken) {
      return true;
    }

    throw new UnauthorizedException('Missing or invalid operations token');
  }
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim();
  }
  return value?.trim();
}
