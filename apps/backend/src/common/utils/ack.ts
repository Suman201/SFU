import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import {
  ERROR_CATALOG,
  errorCodeForStatus,
  errorFrames,
  errorReason,
  publicErrorCode,
  type Ack,
  type AckResponse,
} from '@native-sfu/contracts';

const logger = new Logger('SocketAck');

export async function socketAck<T>(
  ack: Ack<T>,
  operation: () => Promise<T>,
): Promise<void> {
  try {
    ack({ ok: true, data: await operation() } as AckResponse<T>);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    const response =
      error instanceof HttpException ? error.getResponse() : undefined;
    const declaredCode =
      response && typeof response === 'object' && 'code' in response
        ? response.code
        : undefined;
    const status =
      error instanceof HttpException ? error.getStatus() : undefined;
    const reason =
      errorReason(declaredCode) ??
      (status ? errorCodeForStatus(status) : 'CLASSROOM_ERROR');
    const publicCode = publicErrorCode(reason);
    const requestId = randomUUID();
    const redirect = err.name === 'ROOM_REDIRECT';
    const details =
      typeof error === 'object' && error !== null && 'details' in error
        ? (error as { details?: unknown }).details
        : undefined;
    if (!redirect && (status === undefined || status >= 500)) {
      logger.error({
        event: 'application_error',
        source: 'socket',
        code: publicCode,
        reason,
        requestId,
        exceptionName: err.name,
        frames: errorFrames(err.stack),
      });
    }
    ack({
      ok: false,
      error: {
        // Keep the signaling discriminator and redirect payload for existing recovery logic.
        code: err.name || 'Error',
        publicCode,
        reason,
        requestId,
        message:
          redirect || (status !== undefined && status < 500)
            ? err.message.slice(0, 600)
            : ERROR_CATALOG[reason].message,
        ...(details === undefined ? {} : { details }),
      },
    });
  }
}
