import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { adminPermissionForRequest } from '../rbac/admin-access';
import { AuthService } from './auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{
        headers: Record<string, string | undefined>;
        method: string;
        originalUrl: string;
        url: string;
        user?: unknown;
      }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const user = await this.auth.verifyAccessToken(
      header.slice('Bearer '.length),
    );
    request.user = user;
    if (user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      const permission = adminPermissionForRequest(
        request.method,
        request.originalUrl ?? request.url ?? '',
      );
      if (
        permission === 'super-admin' ||
        (permission && !user.permissions.includes(permission))
      )
        throw new ForbiddenException(
          'Your staff access profile does not permit this action.',
        );
      const path = (request.originalUrl ?? request.url ?? '')
        .split('?')[0]!
        .replace(/^\/api(?:\/v\d+)?/, '');
      if (
        user.adminRoleId &&
        permission === null &&
        !/^\/(?:auth|profile|notifications|desktop)(?:\/|$)/.test(path)
      )
        throw new ForbiddenException(
          'This API is not available to managed staff profiles.',
        );
      if (
        user.adminRoleId &&
        !['GET', 'HEAD'].includes(request.method) &&
        /^\/api(?:\/v\d+)?\/class-sessions\/[^/]+\/whiteboard/.test(
          request.originalUrl ?? request.url ?? '',
        )
      )
        throw new ForbiddenException(
          'Use the controlled admin whiteboard recovery workflow.',
        );
    }
    return true;
  }
}
