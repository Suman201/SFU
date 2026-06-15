import { Injectable } from '@nestjs/common';
import type { DtlsSrtpKeyingMaterial } from './dtls/dtls.types';
import { NativeSrtpSession, type SrtpSession, type SrtpSessionSnapshot } from './srtp/srtp-session';

export class SrtpSessionNotFoundError extends Error {
  constructor(transportId: string) {
    super(`SRTP session not found for transport ${transportId}`);
  }
}

@Injectable()
export class SrtpService {
  private readonly sessions = new Map<string, SrtpSession>();

  createSession(transportId: string, keyingMaterial: DtlsSrtpKeyingMaterial): SrtpSession {
    const existing = this.sessions.get(transportId);
    if (existing) {
      return existing;
    }
    const session = new NativeSrtpSession(keyingMaterial);
    this.sessions.set(transportId, session);
    return session;
  }

  getSession(transportId: string): SrtpSession | undefined {
    return this.sessions.get(transportId);
  }

  requireSession(transportId: string): SrtpSession {
    const session = this.sessions.get(transportId);
    if (!session) {
      throw new SrtpSessionNotFoundError(transportId);
    }
    return session;
  }

  setInboundSsrcs(transportId: string, ssrcs: Iterable<number>): void {
    this.requireSession(transportId).setInboundSsrcs(ssrcs);
  }

  setOutboundSsrcs(transportId: string, ssrcs: Iterable<number>): void {
    this.requireSession(transportId).setOutboundSsrcs(ssrcs);
  }

  protectRtp(transportId: string, packet: Buffer): Promise<Buffer> {
    return this.requireSession(transportId).protectRtp(packet);
  }

  unprotectRtp(transportId: string, packet: Buffer): Promise<Buffer> {
    return this.requireSession(transportId).unprotectRtp(packet);
  }

  protectRtcp(transportId: string, packet: Buffer): Promise<Buffer> {
    return this.requireSession(transportId).protectRtcp(packet);
  }

  unprotectRtcp(transportId: string, packet: Buffer): Promise<Buffer> {
    return this.requireSession(transportId).unprotectRtcp(packet);
  }

  getSessionSnapshot(transportId: string): SrtpSessionSnapshot | undefined {
    return this.sessions.get(transportId)?.snapshot();
  }

  closeSession(transportId: string): void {
    this.sessions.delete(transportId);
  }
}

export type { SrtpSession, SrtpSessionSnapshot };
