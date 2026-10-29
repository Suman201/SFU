import { errorReference } from '@native-sfu/contracts';
import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header(REQUEST_ID_HEADER);
    const requestId = errorReference(String(request.id ?? '')) ?? errorReference(incoming) ?? randomUUID();
    request.id = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
