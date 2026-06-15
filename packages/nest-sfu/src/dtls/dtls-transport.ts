import { EventEmitter } from 'events';
import type { DtlsParameters } from '@native-sfu/contracts';
import { DtlsServer } from 'werift-dtls/lib/dtls/src';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80, keyLength, saltLength } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { IceAgent } from '../ice/ice-agent';
import { validateFingerprint } from './fingerprint';
import { IceDatagramTransport } from './ice-datagram-transport';
import type { DtlsSrtpKeyingMaterial, DtlsTransportSnapshot, DtlsTransportState, LocalDtlsCertificate } from './dtls.types';

interface IceDataEvent {
  message: Buffer;
  remote: {
    address: string;
    port: number;
  };
}

const DTLS_CONTENT_TYPES = new Set([20, 21, 22, 23]);
const DTLS_VERSIONS = new Set([0xfeff, 0xfefd]);
const HANDSHAKE_CONTENT_TYPE = 22;
const CERTIFICATE_HANDSHAKE_TYPE = 11;
const SRTP_PROFILES = [ProtectionProfileAes128CmHmacSha1_80, ProtectionProfileAeadAes128Gcm];

export class DtlsTransport extends EventEmitter {
  private state: DtlsTransportState = 'new';
  private remoteParameters?: DtlsParameters;
  private socket?: DtlsServer;
  private datagramTransport?: IceDatagramTransport;
  private remoteCertificate?: Buffer;
  private remoteFingerprintVerified = false;
  private srtpKeys?: DtlsSrtpKeyingMaterial;
  private readonly certificateAssembler = new DtlsCertificateAssembler();
  private readonly iceDataHandler = (event: IceDataEvent) => this.handleIceData(event);

  constructor(
    readonly transportId: string,
    private readonly ice: IceAgent,
    private readonly certificate: LocalDtlsCertificate
  ) {
    super();
  }

  snapshot(): DtlsTransportSnapshot {
    return {
      transportId: this.transportId,
      state: this.state,
      role: 'server',
      localParameters: this.localParameters(),
      remoteParameters: this.remoteParameters,
      remoteFingerprintVerified: this.remoteFingerprintVerified,
      srtpKeys: this.srtpKeys
    };
  }

  localParameters(): DtlsParameters {
    return {
      role: 'auto',
      fingerprints: this.certificate.fingerprints
    };
  }

  setRemoteParameters(parameters: DtlsParameters): void {
    if (!parameters.fingerprints.length) {
      throw new Error('Remote DTLS parameters require at least one fingerprint');
    }
    this.remoteParameters = parameters;
    this.validateObservedCertificate();
  }

  async start(): Promise<void> {
    if (this.socket || this.state === 'closed') {
      return;
    }
    this.setState('connecting');
    this.datagramTransport = new IceDatagramTransport(this.ice);
    this.socket = new DtlsServer({
      transport: this.datagramTransport,
      cert: this.certificate.certPem,
      key: this.certificate.keyPem,
      signatureHash: this.certificate.signatureHash,
      certificateRequest: true,
      extendedMasterSecret: true,
      srtpProfiles: SRTP_PROFILES
    });
    this.socket.onConnect.subscribe(() => this.handleConnected());
    this.socket.onData.subscribe((data) => this.emit('data', data));
    this.socket.onError.subscribe((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.socket.onClose.subscribe(() => {
      if (this.state !== 'closed') {
        this.setState('closed');
      }
    });
    this.ice.on('data', this.iceDataHandler);
  }

  close(): void {
    if (this.state === 'closed') {
      return;
    }
    this.ice.off('data', this.iceDataHandler);
    this.socket?.close();
    this.socket = undefined;
    this.datagramTransport = undefined;
    this.setState('closed');
  }

  private handleIceData(event: IceDataEvent): void {
    if (!isDtlsPacket(event.message) || !this.datagramTransport || this.state === 'closed' || this.state === 'failed') {
      return;
    }
    try {
      for (const certificate of this.certificateAssembler.extract(event.message)) {
        this.remoteCertificate = certificate;
        this.validateObservedCertificate();
      }
      this.datagramTransport.push(event.message, [event.remote.address, event.remote.port]);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleConnected(): void {
    try {
      this.validateObservedCertificate(true);
      const socket = this.socket;
      const profile = socket?.srtp.srtpProfile;
      if (!profile) {
        throw new Error('DTLS handshake completed without an SRTP protection profile');
      }
      const material = socket.extractSessionKeys(keyLength(profile), saltLength(profile));
      this.srtpKeys = {
        profile,
        localKey: Buffer.from(material.localKey),
        localSalt: Buffer.from(material.localSalt),
        remoteKey: Buffer.from(material.remoteKey),
        remoteSalt: Buffer.from(material.remoteSalt)
      };
      this.setState('connected');
      this.emit('connect', this.srtpKeys);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private validateObservedCertificate(required = false): void {
    if (!this.remoteCertificate) {
      if (required) {
        throw new Error('Remote DTLS certificate was not observed during handshake');
      }
      return;
    }
    if (!this.remoteParameters) {
      if (required) {
        throw new Error('Remote DTLS parameters must be set before secure transport establishment');
      }
      return;
    }
    validateFingerprint(this.remoteParameters, this.remoteCertificate);
    this.remoteFingerprintVerified = true;
  }

  private fail(error: Error): void {
    if (this.state === 'closed' || this.state === 'failed') {
      return;
    }
    this.setState('failed');
    this.emit('error', error);
    this.ice.off('data', this.iceDataHandler);
    this.socket?.close();
    this.socket = undefined;
    this.datagramTransport = undefined;
  }

  private setState(state: DtlsTransportState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit('stateChange', state);
  }
}

export function isDtlsPacket(packet: Buffer): boolean {
  return packet.length >= 13 && DTLS_CONTENT_TYPES.has(packet[0]!) && DTLS_VERSIONS.has(packet.readUInt16BE(1));
}

class DtlsCertificateAssembler {
  private readonly fragments = new Map<number, CertificateFragmentSet>();

  extract(packet: Buffer): Buffer[] {
    const certificates: Buffer[] = [];
    let recordOffset = 0;
    while (recordOffset + 13 <= packet.length) {
      const contentType = packet[recordOffset]!;
      const version = packet.readUInt16BE(recordOffset + 1);
      const length = packet.readUInt16BE(recordOffset + 11);
      const fragmentStart = recordOffset + 13;
      const fragmentEnd = fragmentStart + length;
      if (fragmentEnd > packet.length) {
        break;
      }
      if (contentType === HANDSHAKE_CONTENT_TYPE && DTLS_VERSIONS.has(version)) {
        certificates.push(...this.extractFromHandshakeRecord(packet.subarray(fragmentStart, fragmentEnd)));
      }
      recordOffset = fragmentEnd;
    }
    return certificates;
  }

  private extractFromHandshakeRecord(record: Buffer): Buffer[] {
    const certificates: Buffer[] = [];
    let offset = 0;
    while (offset + 12 <= record.length) {
      const type = record[offset]!;
      const length = readUInt24(record, offset + 1);
      const sequence = record.readUInt16BE(offset + 4);
      const fragmentOffset = readUInt24(record, offset + 6);
      const fragmentLength = readUInt24(record, offset + 9);
      const bodyStart = offset + 12;
      const bodyEnd = bodyStart + fragmentLength;
      if (bodyEnd > record.length) {
        break;
      }
      if (type === CERTIFICATE_HANDSHAKE_TYPE) {
        const body =
          fragmentOffset === 0 && fragmentLength === length
            ? record.subarray(bodyStart, bodyEnd)
            : this.addFragment(sequence, length, fragmentOffset, record.subarray(bodyStart, bodyEnd));
        if (body) {
          certificates.push(...parseCertificateList(body));
        }
      }
      offset = bodyEnd;
    }
    return certificates;
  }

  private addFragment(sequence: number, length: number, offset: number, data: Buffer): Buffer | undefined {
    const existing = this.fragments.get(sequence) ?? new CertificateFragmentSet(length);
    this.fragments.set(sequence, existing);
    const body = existing.add(offset, data);
    if (body) {
      this.fragments.delete(sequence);
    }
    return body;
  }
}

class CertificateFragmentSet {
  private readonly chunks: Array<{ offset: number; data: Buffer }> = [];

  constructor(private readonly length: number) {}

  add(offset: number, data: Buffer): Buffer | undefined {
    this.chunks.push({ offset, data });
    const body = Buffer.alloc(this.length);
    let filled = 0;
    for (const chunk of this.chunks.sort((left, right) => left.offset - right.offset)) {
      chunk.data.copy(body, chunk.offset);
      filled += chunk.data.length;
    }
    return filled >= this.length ? body : undefined;
  }
}

function parseCertificateList(body: Buffer): Buffer[] {
  if (body.length < 3) {
    return [];
  }
  const listLength = readUInt24(body, 0);
  const certificates: Buffer[] = [];
  let offset = 3;
  const end = Math.min(body.length, 3 + listLength);
  while (offset + 3 <= end) {
    const certificateLength = readUInt24(body, offset);
    const certificateStart = offset + 3;
    const certificateEnd = certificateStart + certificateLength;
    if (certificateEnd > end) {
      break;
    }
    certificates.push(body.subarray(certificateStart, certificateEnd));
    offset = certificateEnd;
  }
  return certificates;
}

function readUInt24(buffer: Buffer, offset: number): number {
  return (buffer[offset]! << 16) | (buffer[offset + 1]! << 8) | buffer[offset + 2]!;
}
