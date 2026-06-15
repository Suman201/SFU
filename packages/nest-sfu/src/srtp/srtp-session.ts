import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'crypto';
import { RtpPacket } from '@native-sfu/sfu-core';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';
import { parseRtcpSsrcs, parseRtpForSrtp, parseSrtcpIndex, rtpPayloadOffset, type SrtpSsrcState } from './packet';
import { ReplayWindow } from './replay-window';

export interface SrtpSessionSnapshot {
  profile: number;
  inboundSsrcs: number[];
  outboundSsrcs: number[];
  inboundRtpStreams: number[];
  inboundSrtcpStreams: number[];
}

export interface SrtpSession {
  protectRtp(packet: Buffer): Promise<Buffer>;
  unprotectRtp(packet: Buffer): Promise<Buffer>;
  protectRtcp(packet: Buffer): Promise<Buffer>;
  unprotectRtcp(packet: Buffer): Promise<Buffer>;
  setInboundSsrcs(ssrcs: Iterable<number>): void;
  setOutboundSsrcs(ssrcs: Iterable<number>): void;
  snapshot(): SrtpSessionSnapshot;
}

export class SrtpAuthenticationError extends Error {
  constructor() {
    super('SRTP authentication failed');
  }
}

export class SrtpSsrcValidationError extends Error {
  constructor(ssrc: number) {
    super(`Unexpected SRTP SSRC ${ssrc}`);
  }
}

interface CryptoContext {
  masterKey: Buffer;
  masterSalt: Buffer;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  srtpAuthKey: Buffer;
  srtcpKey: Buffer;
  srtcpSalt: Buffer;
  srtcpAuthKey: Buffer;
}

interface RtpInboundState {
  sequence: SrtpSsrcState;
  replay: ReplayWindow;
}

export class NativeSrtpSession implements SrtpSession {
  private readonly local: CryptoContext;
  private readonly remote: CryptoContext;
  private readonly inboundSsrcs = new Set<number>();
  private readonly outboundSsrcs = new Set<number>();
  private readonly inboundRtp = new Map<number, RtpInboundState>();
  private readonly outboundRtp = new Map<number, SrtpSsrcState>();
  private readonly inboundSrtcp = new Map<number, ReplayWindow>();
  private readonly outboundSrtcp = new Map<number, number>();
  private readonly authTagLength: number;
  private readonly srtcpIndexAtPacketEnd: boolean;

  constructor(private readonly keyingMaterial: DtlsSrtpKeyingMaterial) {
    this.local = createCryptoContext(keyingMaterial.localKey, keyingMaterial.localSalt, keyingMaterial.profile);
    this.remote = createCryptoContext(keyingMaterial.remoteKey, keyingMaterial.remoteSalt, keyingMaterial.profile);
    this.authTagLength = keyingMaterial.profile === ProtectionProfileAeadAes128Gcm ? 16 : 10;
    this.srtcpIndexAtPacketEnd = keyingMaterial.profile === ProtectionProfileAeadAes128Gcm;
  }

  async protectRtp(packet: Buffer): Promise<Buffer> {
    const parsed = RtpPacket.parse(packet);
    this.validateOutboundSsrc(parsed.ssrc);
    const state = this.outboundRtpState(parsed.ssrc);
    const packetIndex = parseRtpForSrtp(packet, state).packetIndex;
    const rolloverCounter = Number(packetIndex >> 16n);
    const offset = rtpPayloadOffset(packet);
    const header = packet.subarray(0, offset);
    const payload = packet.subarray(offset);
    const encrypted = this.keyingMaterial.profile === ProtectionProfileAeadAes128Gcm ? this.encryptRtpGcm(header, payload, parsed.ssrc, parsed.sequenceNumber, rolloverCounter) : this.encryptRtpCtr(header, payload, parsed.ssrc, parsed.sequenceNumber, rolloverCounter);
    acceptOutboundRtpSequence(parsed.sequenceNumber, state);
    return encrypted;
  }

  async unprotectRtp(packet: Buffer): Promise<Buffer> {
    const parsed = RtpPacket.parse(packet);
    this.validateInboundSsrc(parsed.ssrc);
    const state = this.inboundRtpState(parsed.ssrc);
    const rtp = parseRtpForSrtp(packet, state.sequence);
    state.replay.check(rtp.packetIndex);
    const decrypted = this.keyingMaterial.profile === ProtectionProfileAeadAes128Gcm ? this.decryptRtpGcm(packet, parsed.ssrc, parsed.sequenceNumber, Number(rtp.packetIndex >> 16n)) : this.decryptRtpCtr(packet, parsed.ssrc, parsed.sequenceNumber, Number(rtp.packetIndex >> 16n));
    state.replay.accept(rtp.packetIndex);
    acceptInboundRtpSequence(parsed.sequenceNumber, state.sequence);
    return decrypted;
  }

  async protectRtcp(packet: Buffer): Promise<Buffer> {
    for (const ssrc of parseRtcpSsrcs(packet)) {
      this.validateOutboundSsrc(ssrc);
    }
    const primarySsrc = packet.readUInt32BE(4);
    const index = this.nextSrtcpIndex(primarySsrc);
    return this.keyingMaterial.profile === ProtectionProfileAeadAes128Gcm ? this.encryptRtcpGcm(packet, primarySsrc, index) : this.encryptRtcpCtr(packet, primarySsrc, index);
  }

  async unprotectRtcp(packet: Buffer): Promise<Buffer> {
    const { ssrc, index } = parseSrtcpIndex(packet, this.authTagLength, this.srtcpIndexAtPacketEnd);
    this.validateInboundSsrc(ssrc);
    const replay = this.inboundSrtcpReplay(ssrc);
    replay.check(index);
    const decrypted = this.keyingMaterial.profile === ProtectionProfileAeadAes128Gcm ? this.decryptRtcpGcm(packet, ssrc, Number(index)) : this.decryptRtcpCtr(packet, ssrc, Number(index));
    for (const rtcpSsrc of parseRtcpSsrcs(decrypted)) {
      this.validateInboundSsrc(rtcpSsrc);
    }
    replay.accept(index);
    return decrypted;
  }

  setInboundSsrcs(ssrcs: Iterable<number>): void {
    replaceSet(this.inboundSsrcs, ssrcs);
  }

  setOutboundSsrcs(ssrcs: Iterable<number>): void {
    replaceSet(this.outboundSsrcs, ssrcs);
  }

  snapshot(): SrtpSessionSnapshot {
    return {
      profile: this.keyingMaterial.profile,
      inboundSsrcs: [...this.inboundSsrcs],
      outboundSsrcs: [...this.outboundSsrcs],
      inboundRtpStreams: [...this.inboundRtp.keys()],
      inboundSrtcpStreams: [...this.inboundSrtcp.keys()]
    };
  }

  private encryptRtpCtr(header: Buffer, payload: Buffer, ssrc: number, sequenceNumber: number, rolloverCounter: number): Buffer {
    const encryptedPayload = aesCtr(payload, this.local.srtpKey, rtpCounter(this.local.srtpSalt, ssrc, rolloverCounter, sequenceNumber));
    const authenticated = Buffer.concat([header, encryptedPayload]);
    return Buffer.concat([authenticated, srtpAuthTag(this.local.srtpAuthKey, authenticated, rolloverCounter)]);
  }

  private decryptRtpCtr(packet: Buffer, ssrc: number, sequenceNumber: number, rolloverCounter: number): Buffer {
    const authTagOffset = packet.length - this.authTagLength;
    if (authTagOffset < 12) {
      throw new Error('SRTP packet too short');
    }
    const authenticated = packet.subarray(0, authTagOffset);
    verifyAuthTag(srtpAuthTag(this.remote.srtpAuthKey, authenticated, rolloverCounter), packet.subarray(authTagOffset));
    const offset = rtpPayloadOffset(authenticated);
    const decryptedPayload = aesCtr(authenticated.subarray(offset), this.remote.srtpKey, rtpCounter(this.remote.srtpSalt, ssrc, rolloverCounter, sequenceNumber));
    return Buffer.concat([authenticated.subarray(0, offset), decryptedPayload]);
  }

  private encryptRtpGcm(header: Buffer, payload: Buffer, ssrc: number, sequenceNumber: number, rolloverCounter: number): Buffer {
    const cipher = createCipheriv('aes-128-gcm', this.local.srtpKey, rtpGcmIv(this.local.srtpSalt, ssrc, rolloverCounter, sequenceNumber));
    cipher.setAAD(header);
    const encryptedPayload = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([header, encryptedPayload, cipher.getAuthTag()]);
  }

  private decryptRtpGcm(packet: Buffer, ssrc: number, sequenceNumber: number, rolloverCounter: number): Buffer {
    const authTagOffset = packet.length - this.authTagLength;
    const offset = rtpPayloadOffset(packet);
    if (authTagOffset < offset) {
      throw new Error('SRTP packet too short');
    }
    const header = packet.subarray(0, offset);
    const decipher = createDecipheriv('aes-128-gcm', this.remote.srtpKey, rtpGcmIv(this.remote.srtpSalt, ssrc, rolloverCounter, sequenceNumber));
    decipher.setAAD(header);
    decipher.setAuthTag(packet.subarray(authTagOffset));
    const decryptedPayload = Buffer.concat([decipher.update(packet.subarray(offset, authTagOffset)), decipher.final()]);
    return Buffer.concat([header, decryptedPayload]);
  }

  private encryptRtcpCtr(packet: Buffer, ssrc: number, index: number): Buffer {
    const encryptedPayload = aesCtr(packet.subarray(8), this.local.srtcpKey, rtpCounter(this.local.srtcpSalt, ssrc, index >> 16, index & 0xffff));
    const indexed = Buffer.concat([packet.subarray(0, 8), encryptedPayload, srtcpIndexBuffer(index, true)]);
    return Buffer.concat([indexed, hmacSha1(this.local.srtcpAuthKey, indexed).subarray(0, this.authTagLength)]);
  }

  private decryptRtcpCtr(packet: Buffer, ssrc: number, index: number): Buffer {
    const indexOffset = packet.length - this.authTagLength - 4;
    const authTag = packet.subarray(packet.length - this.authTagLength);
    const authenticated = packet.subarray(0, packet.length - this.authTagLength);
    verifyAuthTag(hmacSha1(this.remote.srtcpAuthKey, authenticated).subarray(0, this.authTagLength), authTag);
    const encrypted = Boolean(packet[indexOffset]! & 0x80);
    const body = packet.subarray(0, indexOffset);
    if (!encrypted) {
      return Buffer.from(body);
    }
    const decryptedPayload = aesCtr(body.subarray(8), this.remote.srtcpKey, rtpCounter(this.remote.srtcpSalt, ssrc, index >> 16, index & 0xffff));
    return Buffer.concat([body.subarray(0, 8), decryptedPayload]);
  }

  private encryptRtcpGcm(packet: Buffer, ssrc: number, index: number): Buffer {
    const aad = Buffer.concat([packet.subarray(0, 8), srtcpIndexBuffer(index, true)]);
    const cipher = createCipheriv('aes-128-gcm', this.local.srtcpKey, rtcpGcmIv(this.local.srtcpSalt, ssrc, index));
    cipher.setAAD(aad);
    const encryptedPayload = Buffer.concat([cipher.update(packet.subarray(8)), cipher.final()]);
    return Buffer.concat([packet.subarray(0, 8), encryptedPayload, cipher.getAuthTag(), aad.subarray(8)]);
  }

  private decryptRtcpGcm(packet: Buffer, ssrc: number, index: number): Buffer {
    const indexOffset = packet.length - 4;
    const authTagOffset = indexOffset - this.authTagLength;
    if (authTagOffset < 8) {
      throw new Error('SRTCP packet too short');
    }
    const aad = Buffer.concat([packet.subarray(0, 8), packet.subarray(indexOffset)]);
    const decipher = createDecipheriv('aes-128-gcm', this.remote.srtcpKey, rtcpGcmIv(this.remote.srtcpSalt, ssrc, index));
    decipher.setAAD(aad);
    decipher.setAuthTag(packet.subarray(authTagOffset, indexOffset));
    const decryptedPayload = Buffer.concat([decipher.update(packet.subarray(8, authTagOffset)), decipher.final()]);
    return Buffer.concat([packet.subarray(0, 8), decryptedPayload]);
  }

  private inboundRtpState(ssrc: number): RtpInboundState {
    let state = this.inboundRtp.get(ssrc);
    if (!state) {
      state = {
        sequence: { ssrc, rolloverCounter: 0 },
        replay: new ReplayWindow()
      };
      this.inboundRtp.set(ssrc, state);
    }
    return state;
  }

  private outboundRtpState(ssrc: number): SrtpSsrcState {
    let state = this.outboundRtp.get(ssrc);
    if (!state) {
      state = { ssrc, rolloverCounter: 0 };
      this.outboundRtp.set(ssrc, state);
    }
    return state;
  }

  private inboundSrtcpReplay(ssrc: number): ReplayWindow {
    let replay = this.inboundSrtcp.get(ssrc);
    if (!replay) {
      replay = new ReplayWindow();
      this.inboundSrtcp.set(ssrc, replay);
    }
    return replay;
  }

  private nextSrtcpIndex(ssrc: number): number {
    const index = ((this.outboundSrtcp.get(ssrc) ?? 0) + 1) & 0x7fffffff;
    this.outboundSrtcp.set(ssrc, index);
    return index;
  }

  private validateInboundSsrc(ssrc: number): void {
    if (this.inboundSsrcs.size > 0 && !this.inboundSsrcs.has(ssrc)) {
      throw new SrtpSsrcValidationError(ssrc);
    }
  }

  private validateOutboundSsrc(ssrc: number): void {
    if (this.outboundSsrcs.size > 0 && !this.outboundSsrcs.has(ssrc)) {
      throw new SrtpSsrcValidationError(ssrc);
    }
  }
}

function createCryptoContext(masterKey: Buffer, masterSalt: Buffer, profile: number): CryptoContext {
  const saltLength = profile === ProtectionProfileAeadAes128Gcm ? 12 : 14;
  return {
    masterKey,
    masterSalt,
    srtpKey: deriveSessionKey(masterKey, masterSalt, 0, 16),
    srtpSalt: deriveSessionKey(masterKey, masterSalt, 2, saltLength),
    srtpAuthKey: deriveSessionKey(masterKey, masterSalt, 1, 20),
    srtcpKey: deriveSessionKey(masterKey, masterSalt, 3, 16),
    srtcpSalt: deriveSessionKey(masterKey, masterSalt, 5, saltLength),
    srtcpAuthKey: deriveSessionKey(masterKey, masterSalt, 4, 20)
  };
}

function deriveSessionKey(masterKey: Buffer, masterSalt: Buffer, label: number, outputLength: number): Buffer {
  const salt = masterSalt.length < 14 ? Buffer.concat([masterSalt, Buffer.alloc(14 - masterSalt.length)]) : Buffer.from(masterSalt);
  const labelAndIndex = Buffer.from([label, 0, 0, 0, 0, 0, 0]);
  for (let source = labelAndIndex.length - 1, target = salt.length - 1; source >= 0; source -= 1, target -= 1) {
    salt[target] = salt[target]! ^ labelAndIndex[source]!;
  }
  const cipher = createCipheriv('aes-128-ecb', masterKey, null);
  cipher.setAutoPadding(false);
  const blocks: Buffer[] = [];
  for (let counter = 0; Buffer.concat(blocks).length < outputLength; counter += 1) {
    const input = Buffer.concat([salt, Buffer.from([counter >> 8, counter & 0xff])]);
    blocks.push(cipher.update(input));
  }
  cipher.final();
  return Buffer.concat(blocks).subarray(0, outputLength);
}

function aesCtr(payload: Buffer, key: Buffer, counter: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ctr', key, counter);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

function hmacSha1(key: Buffer, ...buffers: Buffer[]): Buffer {
  const hmac = createHmac('sha1', key);
  buffers.forEach((buffer) => hmac.update(buffer));
  return hmac.digest();
}

function srtpAuthTag(authKey: Buffer, authenticated: Buffer, rolloverCounter: number): Buffer {
  const roc = Buffer.alloc(4);
  roc.writeUInt32BE(rolloverCounter);
  return hmacSha1(authKey, authenticated, roc).subarray(0, 10);
}

function verifyAuthTag(expected: Buffer, actual: Buffer): void {
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new SrtpAuthenticationError();
  }
}

function rtpCounter(salt: Buffer, ssrc: number, rolloverCounter: number, sequenceNumber: number): Buffer {
  const counter = Buffer.alloc(16);
  counter.writeUInt32BE(ssrc, 4);
  counter.writeUInt32BE(rolloverCounter, 8);
  counter.writeUInt32BE(Number(BigInt(sequenceNumber) << 16n), 12);
  for (let index = 0; index < salt.length; index += 1) {
    counter[index] = counter[index]! ^ salt[index]!;
  }
  return counter;
}

function rtpGcmIv(salt: Buffer, ssrc: number, rolloverCounter: number, sequenceNumber: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(ssrc, 2);
  iv.writeUInt32BE(rolloverCounter, 6);
  iv.writeUInt16BE(sequenceNumber, 10);
  for (let index = 0; index < iv.length; index += 1) {
    iv[index] = iv[index]! ^ (salt[index] ?? 0);
  }
  return iv;
}

function rtcpGcmIv(salt: Buffer, ssrc: number, index: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(ssrc, 2);
  iv.writeUInt32BE(index, 8);
  for (let byte = 0; byte < iv.length; byte += 1) {
    iv[byte] = iv[byte]! ^ (salt[byte] ?? 0);
  }
  return iv;
}

function srtcpIndexBuffer(index: number, encrypted: boolean): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(index & 0x7fffffff);
  if (encrypted) {
    buffer[0] = buffer[0]! | 0x80;
  }
  return buffer;
}

function acceptInboundRtpSequence(sequenceNumber: number, state: SrtpSsrcState): void {
  acceptRtpSequence(sequenceNumber, state);
}

function acceptOutboundRtpSequence(sequenceNumber: number, state: SrtpSsrcState): void {
  acceptRtpSequence(sequenceNumber, state);
}

function acceptRtpSequence(sequenceNumber: number, state: SrtpSsrcState): void {
  const maxRocDisorder = 100;
  const maxSequenceNumber = 0xffff;
  if (state.lastSequenceNumber !== undefined) {
    if (sequenceNumber === 0 && state.lastSequenceNumber > maxRocDisorder) {
      state.rolloverCounter += 1;
    } else if (state.lastSequenceNumber < maxRocDisorder && sequenceNumber > maxSequenceNumber - maxRocDisorder) {
      state.rolloverCounter = Math.max(0, state.rolloverCounter - 1);
    } else if (sequenceNumber < maxRocDisorder && state.lastSequenceNumber > maxSequenceNumber - maxRocDisorder) {
      state.rolloverCounter += 1;
    }
  }
  state.lastSequenceNumber = sequenceNumber;
}

function replaceSet(target: Set<number>, values: Iterable<number>): void {
  target.clear();
  for (const value of values) {
    target.add(value >>> 0);
  }
}
