import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  ERROR_CATALOG,
  errorCodeForStatus,
  errorPath,
  errorReference,
  isAppErrorCode,
  type ApiErrorBody,
  type ErrorField,
} from '@native-sfu/contracts';
import { Request } from 'express';
import { ErrorsService } from '../../errors/errors.service';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly incidents?: ErrorsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const rawStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserStatus(exception);
    const statusCode =
      rawStatus >= 400 && rawStatus <= 599
        ? rawStatus
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const response =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const errors = statusCode < 500 ? extractFields(response) : [];
    const path = errorPath(request.url);
    const declaredCode =
      response && typeof response === 'object' && 'code' in response
        ? response.code
        : undefined;
    const code = isAppErrorCode(declaredCode)
      ? declaredCode
      : errorCodeForStatus(statusCode);
    const info = ERROR_CATALOG[code];
    const body: ApiErrorBody = {
      success: false,
      code,
      title: info.title,
      message:
        statusCode >= 500 || code === 'INVALID_CREDENTIALS'
          ? info.message
          : extractMessage(response, statusCode, info.message),
      nextStep: info.nextStep,
      errors,
      statusCode,
      path,
      timestamp: new Date().toISOString(),
      requestId: errorReference(String(request.id ?? '')) ?? randomUUID(),
    };
    if (statusCode >= 500) {
      try {
        if (this.incidents)
          this.incidents.capture(body, exception, request as never);
        else this.logFallback(body);
      } catch {
        this.logFallback(body);
      }
    }
    const res = context.getResponse();
    httpAdapter.setHeader?.(res, 'x-request-id', body.requestId);
    httpAdapter.setHeader?.(res, 'Cache-Control', 'no-store');
    httpAdapter.reply(res, body, statusCode);
  }
  private logFallback(body: ApiErrorBody): void {
    this.logger.error({
      event: 'application_error',
      code: body.code,
      requestId: body.requestId,
      path: body.path,
      statusCode: body.statusCode,
    });
  }
}
function parserStatus(error: unknown): number {
  // Express body-parser errors are not Nest HttpExceptions. Never turn malformed JSON into a 500.
  if (error && typeof error === 'object' && 'type' in error) {
    const type = (error as { type?: string }).type;
    if (type === 'entity.too.large') return 413;
    if (type === 'entity.parse.failed') return 400;
  }
  return 500;
}
function extractMessage(
  response: unknown,
  status: number,
  fallback: string,
): string {
  const value =
    typeof response === 'object' && response !== null && 'message' in response
      ? (response as { message?: unknown }).message
      : response;
  if (Array.isArray(value))
    return status === 400 || status === 422 ? 'Validation failed' : fallback;
  return typeof value === 'string' && value.trim()
    ? value.slice(0, 600)
    : fallback;
}
function extractFields(response: unknown): ErrorField[] {
  const value =
    typeof response === 'object' && response !== null && 'message' in response
      ? (response as { message?: unknown }).message
      : undefined;
  if (!Array.isArray(value)) return [];
  const fields: ErrorField[] = [];
  function walk(items: unknown[], parent = '', depth = 0): void {
    if (depth > 6 || fields.length >= 30) return;
    for (const item of items.slice(0, 30)) {
      if (typeof item === 'string') {
        fields.push({ field: '', message: item.slice(0, 300) });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const row = item as {
        property?: unknown;
        constraints?: unknown;
        children?: unknown;
      };
      const key =
        typeof row.property === 'string'
          ? row.property.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100)
          : '';
      const field = parent && key ? `${parent}.${key}` : key || parent;
      if (row.constraints && typeof row.constraints === 'object') {
        for (const message of Object.values(row.constraints).slice(0, 8)) {
          if (typeof message === 'string' && fields.length < 30)
            fields.push({ field, message: message.slice(0, 300) });
        }
      }
      if (Array.isArray(row.children)) walk(row.children, field, depth + 1);
    }
  }
  walk(value);
  return fields.slice(0, 30);
}
