import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { parseRtcpCompound } from '../rtcp/rtcp-packet';
import { RtpPacket } from '../rtp/rtp-packet';

export type UdpPipePacketKind = 'rtp' | 'rtcp' | 'control';
export type UdpPipeAuthMode = 'token' | 'transport-id' | 'token-or-transport-id';
export type UdpPipeDropReason =
  | 'closed'
  | 'not_listening'
  | 'missing_peer'
  | 'invalid_frame'
  | 'unauthorized'
  | 'wrong_room'
  | 'wrong_node'
  | 'invalid_packet'
  | 'oversized'
  | 'backpressure'
  | 'send_error';

export interface UdpPipeEndpoint {
  protocol: 'udp';
  nodeId: string;
  ip: string;
  port: number;
  advertisedIp: string;
  advertisedPort: number;
}

export interface UdpPipeRemoteEndpoint {
  address: string;
  port: number;
  nodeId?: string;
}

export interface UdpPipeTransportOptions {
  id?: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  listenIp?: string;
  listenPort?: number;
  advertisedIp?: string;
  advertisedPort?: number;
  peerToken?: string;
  authMode?: UdpPipeAuthMode;
  remote?: UdpPipeRemoteEndpoint;
  maxDatagramBytes?: number;
  maxHeaderBytes?: number;
  maxQueuePackets?: number;
  maxQueueBytes?: number;
  now?: () => number;
}

export interface UdpPipeSendMetadata {
  producerId?: string;
  consumerId?: string;
}

export interface UdpPipePacketEvent extends UdpPipeSendMetadata {
  transportId: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  kind: Exclude<UdpPipePacketKind, 'control'>;
  packet: Buffer;
  ssrc?: number;
  sequenceNumber?: number;
  timestamp?: number;
  receivedAt: number;
  remoteAddress: string;
  remotePort: number;
}

export interface UdpPipeControlEvent {
  transportId: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  controlType: string;
  payload: Buffer;
  receivedAt: number;
  remoteAddress: string;
  remotePort: number;
}

export interface UdpPipeDropEvent extends UdpPipeSendMetadata {
  transportId: string;
  roomId: string;
  kind?: UdpPipePacketKind;
  reason: UdpPipeDropReason;
  remoteAddress?: string;
  remotePort?: number;
}

export interface UdpPipeErrorEvent {
  transportId: string;
  roomId: string;
  message: string;
  error?: unknown;
}

export interface UdpPipeTransportSnapshot {
  id: string;
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  active: boolean;
  listening: boolean;
  localEndpoint?: UdpPipeEndpoint;
  remoteEndpoint?: UdpPipeRemoteEndpoint;
  rtpPackets: number;
  rtpBytes: number;
  rtcpPackets: number;
  rtcpBytes: number;
  controlPackets: number;
  controlBytes: number;
  sentRtpPackets: number;
  sentRtpBytes: number;
  sentRtcpPackets: number;
  sentRtcpBytes: number;
  sentControlPackets: number;
  sentControlBytes: number;
  droppedPackets: number;
  dropReasons: Record<UdpPipeDropReason, number>;
  backpressureEvents: number;
  queueDepthPackets: number;
  queueDepthBytes: number;
  errors: number;
  createdAt: string;
  closedAt?: string;
}

interface UdpPipeFrameHeader extends UdpPipeSendMetadata {
  transportId: string;
  roomId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sentAt: number;
  token?: string;
  controlType?: string;
}

interface DecodedUdpPipeFrame {
  kind: UdpPipePacketKind;
  header: UdpPipeFrameHeader;
  payload: Buffer;
}

const UDP_PIPE_MAGIC = 'SFUP';
const UDP_PIPE_VERSION = 1;
const UDP_PIPE_FRAME_HEADER_BYTES = 16;
const UDP_PIPE_KIND: Record<UdpPipePacketKind, number> = {
  rtp: 1,
  rtcp: 2,
  control: 3
};
const UDP_PIPE_KIND_BY_ID = new Map(Object.entries(UDP_PIPE_KIND).map(([kind, id]) => [id, kind as UdpPipePacketKind]));
const DEFAULT_MAX_DATAGRAM_BYTES = 65_507;
const DEFAULT_MAX_HEADER_BYTES = 2048;

export class UdpPipeTransport extends EventEmitter {
  readonly id: string;
  private readonly createdAt = new Date().toISOString();
  private readonly now: () => number;
  private readonly maxDatagramBytes: number;
  private readonly maxHeaderBytes: number;
  private readonly maxQueuePackets: number;
  private readonly maxQueueBytes: number;
  private readonly authMode: UdpPipeAuthMode;
  private readonly stats: Omit<
    UdpPipeTransportSnapshot,
    'id' | 'roomId' | 'localNodeId' | 'remoteNodeId' | 'active' | 'listening' | 'localEndpoint' | 'remoteEndpoint' | 'createdAt' | 'closedAt'
  > = {
    rtpPackets: 0,
    rtpBytes: 0,
    rtcpPackets: 0,
    rtcpBytes: 0,
    controlPackets: 0,
    controlBytes: 0,
    sentRtpPackets: 0,
    sentRtpBytes: 0,
    sentRtcpPackets: 0,
    sentRtcpBytes: 0,
    sentControlPackets: 0,
    sentControlBytes: 0,
    droppedPackets: 0,
    dropReasons: {
      closed: 0,
      not_listening: 0,
      missing_peer: 0,
      invalid_frame: 0,
      unauthorized: 0,
      wrong_room: 0,
      wrong_node: 0,
      invalid_packet: 0,
      oversized: 0,
      backpressure: 0,
      send_error: 0
    },
    backpressureEvents: 0,
    queueDepthPackets: 0,
    queueDepthBytes: 0,
    errors: 0
  };

  private socket?: Socket;
  private listening = false;
  private localEndpointValue?: UdpPipeEndpoint;
  private remoteEndpointValue?: UdpPipeRemoteEndpoint;
  private closedAt?: string;

  constructor(private readonly options: UdpPipeTransportOptions) {
    super();
    this.id = options.id ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.maxDatagramBytes = options.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES;
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    this.maxQueuePackets = options.maxQueuePackets ?? 1024;
    this.maxQueueBytes = options.maxQueueBytes ?? 4 * 1024 * 1024;
    this.authMode = options.authMode ?? (options.peerToken ? 'token-or-transport-id' : 'transport-id');
    this.remoteEndpointValue = options.remote;
  }

  async listen(): Promise<UdpPipeEndpoint> {
    if (this.closedAt) {
      throw new Error(`UDP pipe transport ${this.id} is closed`);
    }
    if (this.localEndpointValue) {
      return this.localEndpointValue;
    }

    const socket = createSocket(this.socketType());
    this.socket = socket;
    socket.on('message', (message, remote) => this.handleMessage(message, remote));
    socket.on('error', (error) => this.recordError('UDP pipe socket error', error));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          socket.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          socket.off('error', onError);
          resolve();
        };
        socket.once('error', onError);
        socket.once('listening', onListening);
        socket.bind(this.options.listenPort ?? 0, this.options.listenIp ?? '0.0.0.0');
      });
    } catch (error) {
      this.recordError('UDP pipe bind failed', error);
      this.socket = undefined;
      throw error;
    }

    this.listening = true;
    this.localEndpointValue = this.buildLocalEndpoint(socket.address());
    this.emit('listening', this.localEndpointValue);
    return this.localEndpointValue;
  }

  connect(endpoint: UdpPipeRemoteEndpoint): void {
    this.remoteEndpointValue = { ...endpoint };
  }

  localEndpoint(): UdpPipeEndpoint | undefined {
    return this.localEndpointValue ? { ...this.localEndpointValue } : undefined;
  }

  remoteEndpoint(): UdpPipeRemoteEndpoint | undefined {
    return this.remoteEndpointValue ? { ...this.remoteEndpointValue } : undefined;
  }

  async sendRtp(producerId: string, packet: Buffer): Promise<boolean> {
    try {
      RtpPacket.parse(packet);
    } catch {
      this.drop('invalid_packet', { kind: 'rtp', producerId });
      return false;
    }
    return this.sendFrame('rtp', packet, { producerId });
  }

  async sendRtcp(packet: Buffer, metadata: UdpPipeSendMetadata = {}): Promise<boolean> {
    try {
      parseRtcpCompound(packet);
    } catch {
      this.drop('invalid_packet', { kind: 'rtcp', producerId: metadata.producerId, consumerId: metadata.consumerId });
      return false;
    }
    return this.sendFrame('rtcp', packet, metadata);
  }

  async sendControl(controlType: string, payload: Buffer | string | object = Buffer.alloc(0)): Promise<boolean> {
    if (!controlType) {
      this.drop('invalid_packet', { kind: 'control' });
      return false;
    }
    const controlPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return this.sendFrame('control', controlPayload, { controlType });
  }

  async close(reason = 'manual'): Promise<void> {
    if (this.closedAt) {
      return;
    }
    this.closedAt = new Date(this.now()).toISOString();
    this.listening = false;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      await new Promise<void>((resolve) => {
        socket.close(() => resolve());
      });
    }
    this.emit('close', { transportId: this.id, reason });
  }

  snapshot(): UdpPipeTransportSnapshot {
    return {
      id: this.id,
      roomId: this.options.roomId,
      localNodeId: this.options.localNodeId,
      remoteNodeId: this.options.remoteNodeId,
      active: !this.closedAt,
      listening: this.listening,
      localEndpoint: this.localEndpoint(),
      remoteEndpoint: this.remoteEndpoint(),
      rtpPackets: this.stats.rtpPackets,
      rtpBytes: this.stats.rtpBytes,
      rtcpPackets: this.stats.rtcpPackets,
      rtcpBytes: this.stats.rtcpBytes,
      controlPackets: this.stats.controlPackets,
      controlBytes: this.stats.controlBytes,
      sentRtpPackets: this.stats.sentRtpPackets,
      sentRtpBytes: this.stats.sentRtpBytes,
      sentRtcpPackets: this.stats.sentRtcpPackets,
      sentRtcpBytes: this.stats.sentRtcpBytes,
      sentControlPackets: this.stats.sentControlPackets,
      sentControlBytes: this.stats.sentControlBytes,
      droppedPackets: this.stats.droppedPackets,
      dropReasons: { ...this.stats.dropReasons },
      backpressureEvents: this.stats.backpressureEvents,
      queueDepthPackets: this.stats.queueDepthPackets,
      queueDepthBytes: this.stats.queueDepthBytes,
      errors: this.stats.errors,
      createdAt: this.createdAt,
      closedAt: this.closedAt
    };
  }

  private async sendFrame(kind: UdpPipePacketKind, packet: Buffer, metadata: UdpPipeSendMetadata & { controlType?: string } = {}): Promise<boolean> {
    if (this.closedAt) {
      this.drop('closed', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      return false;
    }
    if (!this.socket || !this.listening) {
      this.drop('not_listening', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      return false;
    }
    if (!this.remoteEndpointValue) {
      this.drop('missing_peer', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      return false;
    }

    let frame: Buffer;
    try {
      frame = this.encodeFrame(kind, packet, metadata);
    } catch {
      this.drop('oversized', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      return false;
    }

    if (!this.reserveQueue(frame.length)) {
      this.drop('backpressure', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      this.stats.backpressureEvents += 1;
      this.emit('backpressure', this.snapshot());
      return false;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.socket!.send(frame, this.remoteEndpointValue!.port, this.remoteEndpointValue!.address, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.recordSent(kind, packet.length);
      return true;
    } catch (error) {
      this.drop('send_error', { kind, producerId: metadata.producerId, consumerId: metadata.consumerId });
      this.recordError('UDP pipe send failed', error);
      return false;
    } finally {
      this.releaseQueue(frame.length);
    }
  }

  private handleMessage(message: Buffer, remote: RemoteInfo): void {
    if (this.closedAt) {
      this.drop('closed', { remoteAddress: remote.address, remotePort: remote.port });
      return;
    }
    if (message.length > this.maxDatagramBytes) {
      this.drop('oversized', { remoteAddress: remote.address, remotePort: remote.port });
      return;
    }

    let frame: DecodedUdpPipeFrame;
    try {
      frame = decodeUdpPipeFrame(message, this.maxHeaderBytes);
    } catch {
      this.drop('invalid_frame', { remoteAddress: remote.address, remotePort: remote.port });
      return;
    }

    const metadata = {
      kind: frame.kind,
      producerId: frame.header.producerId,
      consumerId: frame.header.consumerId,
      remoteAddress: remote.address,
      remotePort: remote.port
    };

    if (!this.isAuthorized(frame.header)) {
      this.drop('unauthorized', metadata);
      return;
    }
    if (frame.header.roomId !== this.options.roomId) {
      this.drop('wrong_room', metadata);
      return;
    }
    if (frame.header.targetNodeId !== this.options.localNodeId || frame.header.sourceNodeId !== this.options.remoteNodeId) {
      this.drop('wrong_node', metadata);
      return;
    }

    if (frame.kind === 'rtp') {
      this.receiveRtp(frame, remote);
      return;
    }
    if (frame.kind === 'rtcp') {
      this.receiveRtcp(frame, remote);
      return;
    }
    this.receiveControl(frame, remote);
  }

  private receiveRtp(frame: DecodedUdpPipeFrame, remote: RemoteInfo): void {
    let packet: RtpPacket;
    try {
      packet = RtpPacket.parse(frame.payload);
    } catch {
      this.drop('invalid_packet', {
        kind: 'rtp',
        producerId: frame.header.producerId,
        remoteAddress: remote.address,
        remotePort: remote.port
      });
      return;
    }
    this.stats.rtpPackets += 1;
    this.stats.rtpBytes += frame.payload.length;
    this.emit('rtp', this.packetEvent(frame, remote, packet));
  }

  private receiveRtcp(frame: DecodedUdpPipeFrame, remote: RemoteInfo): void {
    try {
      parseRtcpCompound(frame.payload);
    } catch {
      this.drop('invalid_packet', {
        kind: 'rtcp',
        producerId: frame.header.producerId,
        consumerId: frame.header.consumerId,
        remoteAddress: remote.address,
        remotePort: remote.port
      });
      return;
    }
    this.stats.rtcpPackets += 1;
    this.stats.rtcpBytes += frame.payload.length;
    this.emit('rtcp', this.packetEvent(frame, remote));
  }

  private receiveControl(frame: DecodedUdpPipeFrame, remote: RemoteInfo): void {
    if (!frame.header.controlType) {
      this.drop('invalid_packet', { kind: 'control', remoteAddress: remote.address, remotePort: remote.port });
      return;
    }
    this.stats.controlPackets += 1;
    this.stats.controlBytes += frame.payload.length;
    this.emit('control', {
      transportId: this.id,
      roomId: this.options.roomId,
      localNodeId: this.options.localNodeId,
      remoteNodeId: this.options.remoteNodeId,
      controlType: frame.header.controlType,
      payload: frame.payload,
      receivedAt: this.now(),
      remoteAddress: remote.address,
      remotePort: remote.port
    } satisfies UdpPipeControlEvent);
  }

  private encodeFrame(kind: UdpPipePacketKind, payload: Buffer, metadata: UdpPipeSendMetadata & { controlType?: string }): Buffer {
    const header: UdpPipeFrameHeader = {
      transportId: this.id,
      roomId: this.options.roomId,
      sourceNodeId: this.options.localNodeId,
      targetNodeId: this.options.remoteNodeId,
      sentAt: this.now(),
      producerId: metadata.producerId,
      consumerId: metadata.consumerId,
      token: this.options.peerToken,
      controlType: metadata.controlType
    };
    const headerBytes = Buffer.from(JSON.stringify(stripUndefined(header)));
    if (headerBytes.length > this.maxHeaderBytes) {
      throw new Error('UDP pipe header is too large');
    }
    const totalLength = UDP_PIPE_FRAME_HEADER_BYTES + headerBytes.length + payload.length;
    if (totalLength > this.maxDatagramBytes) {
      throw new Error('UDP pipe datagram is too large');
    }

    const frame = Buffer.alloc(totalLength);
    frame.write(UDP_PIPE_MAGIC, 0, 'ascii');
    frame[4] = UDP_PIPE_VERSION;
    frame[5] = UDP_PIPE_KIND[kind];
    frame.writeUInt16BE(0, 6);
    frame.writeUInt16BE(headerBytes.length, 8);
    frame.writeUInt16BE(0, 10);
    frame.writeUInt32BE(payload.length, 12);
    headerBytes.copy(frame, UDP_PIPE_FRAME_HEADER_BYTES);
    payload.copy(frame, UDP_PIPE_FRAME_HEADER_BYTES + headerBytes.length);
    return frame;
  }

  private isAuthorized(header: UdpPipeFrameHeader): boolean {
    const transportIdMatches = header.transportId === this.id;
    const tokenMatches = Boolean(this.options.peerToken && header.token && safeEqual(header.token, this.options.peerToken));
    if (this.authMode === 'token') {
      return tokenMatches;
    }
    if (this.authMode === 'transport-id') {
      return transportIdMatches;
    }
    return transportIdMatches || tokenMatches;
  }

  private packetEvent(frame: DecodedUdpPipeFrame, remote: RemoteInfo, packet?: RtpPacket): UdpPipePacketEvent {
    return {
      transportId: this.id,
      roomId: this.options.roomId,
      localNodeId: this.options.localNodeId,
      remoteNodeId: this.options.remoteNodeId,
      producerId: frame.header.producerId,
      consumerId: frame.header.consumerId,
      kind: frame.kind as Exclude<UdpPipePacketKind, 'control'>,
      packet: frame.payload,
      ssrc: packet?.ssrc,
      sequenceNumber: packet?.sequenceNumber,
      timestamp: packet?.timestamp,
      receivedAt: this.now(),
      remoteAddress: remote.address,
      remotePort: remote.port
    };
  }

  private recordSent(kind: UdpPipePacketKind, bytes: number): void {
    if (kind === 'rtp') {
      this.stats.sentRtpPackets += 1;
      this.stats.sentRtpBytes += bytes;
    } else if (kind === 'rtcp') {
      this.stats.sentRtcpPackets += 1;
      this.stats.sentRtcpBytes += bytes;
    } else {
      this.stats.sentControlPackets += 1;
      this.stats.sentControlBytes += bytes;
    }
  }

  private reserveQueue(bytes: number): boolean {
    if (this.stats.queueDepthPackets + 1 > this.maxQueuePackets || this.stats.queueDepthBytes + bytes > this.maxQueueBytes) {
      return false;
    }
    this.stats.queueDepthPackets += 1;
    this.stats.queueDepthBytes += bytes;
    return true;
  }

  private releaseQueue(bytes: number): void {
    this.stats.queueDepthPackets = Math.max(0, this.stats.queueDepthPackets - 1);
    this.stats.queueDepthBytes = Math.max(0, this.stats.queueDepthBytes - bytes);
  }

  private drop(reason: UdpPipeDropReason, event: Partial<UdpPipeDropEvent>): void {
    this.stats.droppedPackets += 1;
    this.stats.dropReasons[reason] += 1;
    this.emit('drop', {
      transportId: this.id,
      roomId: this.options.roomId,
      reason,
      ...event
    } satisfies UdpPipeDropEvent);
  }

  private recordError(message: string, error: unknown): void {
    this.stats.errors += 1;
    const event = { transportId: this.id, roomId: this.options.roomId, message, error } satisfies UdpPipeErrorEvent;
    this.emit('transportError', event);
    if (this.listenerCount('error') > 0) {
      this.emit('error', event);
    }
  }

  private socketType(): 'udp4' | 'udp6' {
    return this.options.listenIp?.includes(':') ? 'udp6' : 'udp4';
  }

  private buildLocalEndpoint(address: AddressInfo | string): UdpPipeEndpoint {
    if (typeof address === 'string') {
      return {
        protocol: 'udp',
        nodeId: this.options.localNodeId,
        ip: this.options.listenIp ?? address,
        port: this.options.listenPort ?? 0,
        advertisedIp: this.options.advertisedIp ?? this.options.listenIp ?? address,
        advertisedPort: this.options.advertisedPort ?? this.options.listenPort ?? 0
      };
    }
    const ip = address.address === '0.0.0.0' ? this.options.listenIp ?? address.address : address.address;
    return {
      protocol: 'udp',
      nodeId: this.options.localNodeId,
      ip,
      port: address.port,
      advertisedIp: this.options.advertisedIp ?? ip,
      advertisedPort: this.options.advertisedPort ?? address.port
    };
  }
}

function decodeUdpPipeFrame(buffer: Buffer, maxHeaderBytes: number): DecodedUdpPipeFrame {
  if (buffer.length < UDP_PIPE_FRAME_HEADER_BYTES || buffer.subarray(0, 4).toString('ascii') !== UDP_PIPE_MAGIC) {
    throw new Error('Invalid UDP pipe magic');
  }
  if (buffer[4] !== UDP_PIPE_VERSION) {
    throw new Error('Unsupported UDP pipe frame version');
  }
  const kind = UDP_PIPE_KIND_BY_ID.get(buffer[5]!);
  if (!kind) {
    throw new Error('Unsupported UDP pipe frame kind');
  }
  const headerLength = buffer.readUInt16BE(8);
  if (headerLength === 0 || headerLength > maxHeaderBytes) {
    throw new Error('Invalid UDP pipe header length');
  }
  const payloadLength = buffer.readUInt32BE(12);
  const payloadOffset = UDP_PIPE_FRAME_HEADER_BYTES + headerLength;
  if (payloadOffset + payloadLength !== buffer.length) {
    throw new Error('Invalid UDP pipe payload length');
  }

  const header = parseFrameHeader(buffer.subarray(UDP_PIPE_FRAME_HEADER_BYTES, payloadOffset));
  return {
    kind,
    header,
    payload: buffer.subarray(payloadOffset)
  };
}

function parseFrameHeader(buffer: Buffer): UdpPipeFrameHeader {
  const value = JSON.parse(buffer.toString('utf8')) as Partial<UdpPipeFrameHeader>;
  if (!isString(value.transportId) || !isString(value.roomId) || !isString(value.sourceNodeId) || !isString(value.targetNodeId) || typeof value.sentAt !== 'number') {
    throw new Error('Invalid UDP pipe frame header');
  }
  if (value.producerId !== undefined && !isString(value.producerId)) {
    throw new Error('Invalid UDP pipe producer id');
  }
  if (value.consumerId !== undefined && !isString(value.consumerId)) {
    throw new Error('Invalid UDP pipe consumer id');
  }
  if (value.token !== undefined && !isString(value.token)) {
    throw new Error('Invalid UDP pipe token');
  }
  if (value.controlType !== undefined && !isString(value.controlType)) {
    throw new Error('Invalid UDP pipe control type');
  }
  return value as UdpPipeFrameHeader;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>;
}
