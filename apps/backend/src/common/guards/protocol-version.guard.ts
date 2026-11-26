import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { SFU_CLIENT_UPDATE_MESSAGE, SFU_PROTOCOL_HEADER, SFU_PROTOCOL_VERSION, supportsSfuProtocol } from '@native-sfu/contracts';
import type { Request, Response } from 'express';

@Injectable()
export class ProtocolVersionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const pathname = (request.originalUrl || request.url).split('?')[0]!;
    // Provider callbacks and media/download tickets are not app protocol clients.
    if (!pathname.startsWith('/api/') || /\/(?:webhooks?|callback)(?:\/|$)/.test(pathname) || /^\/api\/v\d+\/desktop\/recordings\/[^/]+\/content$/.test(pathname)) return true;
    response.setHeader(SFU_PROTOCOL_HEADER, String(SFU_PROTOCOL_VERSION));
    if (!supportsSfuProtocol(request.headers[SFU_PROTOCOL_HEADER])) {
      throw new HttpException({ message: SFU_CLIENT_UPDATE_MESSAGE, supportedProtocolVersion: SFU_PROTOCOL_VERSION }, 426);
    }
    return true;
  }
}
