import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class SuccessResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ path?: string; originalUrl?: string }>();
    const path = request.originalUrl ?? request.path ?? '';
    if (path.includes('/api/docs') || path === '/metrics' || path.startsWith('/health') || path.startsWith('/api/health')) {
      return next.handle();
    }
    return next.handle().pipe(
      map((data) => ({
        success: true,
        message: 'OK',
        data: data ?? null
      }))
    );
  }
}
