import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { REQUEST_ID_HEADER } from '../middleware/request-id.middleware';

interface ErrorResponseBody {
  success: false;
  message: string;
  errors: unknown[];
  statusCode: number;
  path: string;
  timestamp: string;
  requestId: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const errors = extractErrors(response);
    const message = extractMessage(response, statusCode);
    const body: ErrorResponseBody = {
      success: false,
      message,
      errors,
      statusCode,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: String(request.id ?? request.header(REQUEST_ID_HEADER) ?? 'unknown')
    };

    httpAdapter.reply(context.getResponse(), body, statusCode);
  }
}

function extractMessage(response: unknown, statusCode: number): string {
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const value = (response as { message?: unknown }).message;
    if (Array.isArray(value)) {
      return statusCode === HttpStatus.BAD_REQUEST ? 'Validation failed' : value.join(', ');
    }
    if (typeof value === 'string') {
      return value;
    }
  }
  if (typeof response === 'string') {
    return response;
  }
  return statusCode === HttpStatus.INTERNAL_SERVER_ERROR ? 'Internal server error' : 'Request failed';
}

function extractErrors(response: unknown): unknown[] {
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const value = (response as { message?: unknown }).message;
    return Array.isArray(value) ? value : [];
  }
  return [];
}
