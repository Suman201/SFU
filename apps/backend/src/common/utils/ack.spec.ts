import { describe, it, expect, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ERROR_CATALOG, type AckResponse } from '@native-sfu/contracts';
import { socketAck } from './ack';

describe('Shared signaling error contract', () => {
  async function fail(error: unknown) {
    let result!: AckResponse<never>;
    await socketAck<never>(
      (value) => {
        result = value;
      },
      async () => {
        throw error;
      },
    );
    if (result.ok) throw new Error('Expected rejected acknowledgment');
    return result.error;
  }
  it('retains permission discriminators while providing a public code and unique occurrence reference', async () => {
    const first = await fail(
      new ForbiddenException('Only the teacher can do this.'),
    );
    const second = await fail(new ForbiddenException());
    expect(first).toMatchObject({
      code: 'ForbiddenException',
      publicCode: 'SAP2003',
      reason: 'ACCESS_DENIED',
      message: 'Only the teacher can do this.',
    });
    expect(first.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.requestId).not.toBe(second.requestId);
  });
  it('accepts only registered explicit application codes', async () => {
    expect(
      (
        await fail(
          new BadRequestException({
            code: 'UNSUPPORTED_FILE_TYPE',
            message: 'Choose a PDF.',
          }),
        )
      ).publicCode,
    ).toBe('SAP1004');
    expect(
      (await fail(new BadRequestException({ code: 'UNKNOWN_PRIVATE_ERROR' })))
        .publicCode,
    ).toBe('SAP1001');
  });
  it('keeps internal exception text out of acknowledgments and logs', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const result = await fail(
        new Error('mongodb://user:secret@private-server'),
      );
      expect(result.publicCode).toBe('SAP5004');
      expect(result.message).toBe(ERROR_CATALOG.CLASSROOM_ERROR.message);
      expect(JSON.stringify(log.mock.calls)).toContain(result.requestId!);
      expect(JSON.stringify([result, log.mock.calls])).not.toContain('secret');
      expect(
        (
          await fail(
            new ServiceUnavailableException('private dependency password'),
          )
        ).message,
      ).toBe(ERROR_CATALOG.SERVICE_UNAVAILABLE.message);
    } finally {
      log.mockRestore();
    }
  });
  it('preserves room redirects and their typed recovery payload', async () => {
    const details = {
      roomId: 'room-1',
      ownerNodeId: 'node-b',
      publicUrl: 'https://class.example',
    };
    const redirect = Object.assign(new Error('Switch room owner'), {
      name: 'ROOM_REDIRECT',
      details,
    });
    expect(await fail(redirect)).toMatchObject({
      code: 'ROOM_REDIRECT',
      details,
    });
  });
});
