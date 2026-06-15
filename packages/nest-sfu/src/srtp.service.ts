import { Injectable } from '@nestjs/common';

export interface SrtpSession {
  protectRtp(packet: Buffer): Promise<Buffer>;
  unprotectRtp(packet: Buffer): Promise<Buffer>;
  protectRtcp(packet: Buffer): Promise<Buffer>;
  unprotectRtcp(packet: Buffer): Promise<Buffer>;
}

export class SrtpUnavailableError extends Error {
  constructor() {
    super('SRTP is fail-closed until a production DTLS-SRTP keying engine is installed.');
  }
}

class FailClosedSrtpSession implements SrtpSession {
  async protectRtp(): Promise<Buffer> {
    throw new SrtpUnavailableError();
  }

  async unprotectRtp(): Promise<Buffer> {
    throw new SrtpUnavailableError();
  }

  async protectRtcp(): Promise<Buffer> {
    throw new SrtpUnavailableError();
  }

  async unprotectRtcp(): Promise<Buffer> {
    throw new SrtpUnavailableError();
  }
}

@Injectable()
export class SrtpService {
  createSession(): SrtpSession {
    return new FailClosedSrtpSession();
  }
}
