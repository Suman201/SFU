import { timingSafeEqual } from 'node:crypto';
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
    if (operationsTokenMatches(providedToken, configuredToken)) {
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

export function operationsTokenMatches(providedToken: string | undefined, configuredToken: string): boolean {
  if (!providedToken) {
    return false;
  }
  const provided = Buffer.from(providedToken);
  const configured = Buffer.from(configuredToken);
  return provided.length === configured.length && timingSafeEqual(provided, configured);
}
