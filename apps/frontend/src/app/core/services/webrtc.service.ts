import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import type {
  Consumer,
  ConsumerQualityState,
  DtlsParameters,
  IceParameters,
  Producer,
  ProducerDynacastEvent,
  ProducerKind,
  ProducerQualityState,
  RoomQualityState,
  RtpLayerSelection,
  RtpParameters,
  SvcLayerSelection,
  TransportOptions
} from '@native-sfu/contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from './app-environment';
import { SocketService } from './socket.service';

export interface DeviceOption {
  id: string;
  label: string;
}

interface PublishedSender {
  sender: RTCRtpSender;
  userMaxSpatialLayer: number;
  svc: boolean;
}

interface TurnCredentialsResponse {
  username: string;
  credential: string;
  ttl: number;
  uris: string[];
}

type TurnStatus =
  | { state: 'idle'; supportedUriCount: 0 }
  | { state: 'ready'; supportedUriCount: number; expiresAt: number }
  | { state: 'degraded'; supportedUriCount: number; reason: 'credentials_fetch_failed' | 'no_supported_uris' };

export interface PublishOptions {
  svc?: boolean;
  scalabilityMode?: string;
  codec?: 'VP8' | 'VP9' | 'H264';
}

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  readonly localStream = signal<MediaStream | null>(null);
  readonly screenStream = signal<MediaStream | null>(null);
  readonly devices = signal<{ audioInputs: DeviceOption[]; videoInputs: DeviceOption[] }>({ audioInputs: [], videoInputs: [] });
  readonly networkScore = signal(5);
  readonly turnStatus = signal<TurnStatus>({ state: 'idle', supportedUriCount: 0 });
  private peer?: RTCPeerConnection;
  private readonly publishedProducers = new Map<string, { kind: ProducerKind; svc: boolean; senders: PublishedSender[] }>();
  private cachedIceServers?: { expiresAt: number; servers: RTCIceServer[] };

  constructor(
    private readonly socket: SocketService,
    private readonly http: HttpClient
  ) {}

  async refreshDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.devices.set({
      audioInputs: devices.filter((device) => device.kind === 'audioinput').map((device) => ({ id: device.deviceId, label: device.label || 'Microphone' })),
      videoInputs: devices.filter((device) => device.kind === 'videoinput').map((device) => ({ id: device.deviceId, label: device.label || 'Camera' }))
    });
  }

  async startCamera(audioDeviceId?: string, videoDeviceId?: string): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    this.localStream.set(stream);
    await this.refreshDevices();
    return stream;
  }

  stopCamera(): void {
    this.localStream()?.getTracks().forEach((track) => track.stop());
    this.localStream.set(null);
  }

  async startScreen(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    this.screenStream.set(stream);
    return stream;
  }

  stopScreen(): void {
    this.screenStream()?.getTracks().forEach((track) => track.stop());
    this.screenStream.set(null);
  }

  async preparePeer(roomId: string): Promise<TransportOptions> {
    const transport = await this.socket.emitAck('transport:create', { roomId });
    const iceServers = await this.loadIceServers();
    this.peer = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    this.peer.onicecandidate = (event) => {
      if (event.candidate?.candidate) {
        void this.socket.emitAck('transport:ice-candidate', {
          transportId: transport.id,
          candidate: parseCandidate(event.candidate)
        });
      }
    };
    return transport;
  }

  async publish(roomId: string, transport: TransportOptions, kind: ProducerKind, stream: MediaStream, options: PublishOptions = {}): Promise<Producer> {
    if (!this.peer) {
      await this.preparePeer(roomId);
    }
    const senders: PublishedSender[] = [];
    for (const track of stream.getTracks()) {
      if ((kind === 'audio' && track.kind !== 'audio') || (kind !== 'audio' && track.kind !== 'video')) {
        continue;
      }
      const sender = this.peer ? addSenderForTrack(this.peer, track, stream, kind, options) : undefined;
      if (sender?.sender) {
        senders.push(sender);
      }
    }
    if (this.peer && this.peer.signalingState === 'stable') {
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      const iceParameters = parseIceParameters(this.peer.localDescription?.sdp ?? '');
      if (iceParameters) {
        await this.socket.emitAck('transport:ice-parameters', { transportId: transport.id, iceParameters });
      }
      const dtlsParameters = parseDtlsParameters(this.peer.localDescription?.sdp ?? '');
      if (dtlsParameters) {
        await this.socket.emitAck('transport:dtls-parameters', { transportId: transport.id, dtlsParameters });
      }
    }
    const rtpParameters = createRtpParameters(kind, options);
    const event = kind === 'screen' ? 'screen:start' : 'producer:create';
    const producer = await this.socket.emitAck(event, { roomId, kind, transportId: transport.id, rtpParameters });
    this.publishedProducers.set(producer.id, { kind, svc: Boolean(options.svc && kind !== 'audio'), senders });
    return producer;
  }

  async setPreferredSvcLayers(consumerId: string, preferredSvcLayers: SvcLayerSelection): Promise<void> {
    await this.socket.emitAck('consumer:set-preferred-svc-layers', { consumerId, preferredSvcLayers });
  }

  async setConsumerPriority(consumerId: string, priority: number): Promise<Consumer> {
    return this.socket.emitAck('consumer:set-priority', { consumerId, priority });
  }

  async setProducerPriority(producerId: string, priority: number): Promise<Producer> {
    return this.socket.emitAck('producer:set-priority', { producerId, priority });
  }

  async getConsumerQuality(consumerId: string): Promise<ConsumerQualityState> {
    return this.socket.emitAck('consumer:get-quality', { consumerId });
  }

  async getProducerQuality(producerId: string): Promise<ProducerQualityState> {
    return this.socket.emitAck('producer:get-quality', { producerId });
  }

  async getRoomQuality(roomId: string): Promise<RoomQualityState> {
    return this.socket.emitAck('room:get-quality', { roomId });
  }

  setNetworkQualityScore(score: number): void {
    this.networkScore.set(Math.max(1, Math.min(5, Math.ceil(score / 20))));
  }

  setLocalPublishQuality(producerId: string, maxSpatialLayer: number): void {
    const publication = this.publishedProducers.get(producerId);
    if (!publication) {
      return;
    }
    const normalized = Math.max(0, Math.min(2, Math.trunc(maxSpatialLayer)));
    publication.senders = publication.senders.map((entry) => ({ ...entry, userMaxSpatialLayer: normalized }));
  }

  async applyProducerDynacast(event: ProducerDynacastEvent): Promise<void> {
    const publication = this.publishedProducers.get(event.producerId);
    if (!publication || publication.kind === 'audio' || publication.svc) {
      return;
    }
    const results = await Promise.all(publication.senders.map((entry) => applySenderDynacast(entry.sender, event, entry.userMaxSpatialLayer)));
    await Promise.all(
      results
        .filter((result) => !result.ok)
        .map((result) =>
          this.socket
            .emitAck('producer:dynacast-control-failed', {
              producerId: event.producerId,
              reason: result.reason ?? 'set_parameters_failed',
              layer: result.layer
            })
            .catch(() => undefined)
        )
    );
  }

  private async loadIceServers(): Promise<RTCIceServer[]> {
    const now = Date.now();
    if (this.cachedIceServers && this.cachedIceServers.expiresAt > now) {
      return this.cachedIceServers.servers;
    }
    try {
      const credentials = await firstValueFrom(this.http.get<TurnCredentialsResponse>(`${API_BASE_URL}/media/turn-credentials`));
      const urls = credentials.uris.filter((uri) => isSupportedTurnUri(uri));
      if (urls.length === 0) {
        this.turnStatus.set({ state: 'degraded', reason: 'no_supported_uris', supportedUriCount: 0 });
        this.cachedIceServers = { expiresAt: now + 5_000, servers: [] };
        console.warn('[WebRtcService] TURN credentials returned no supported UDP relay URIs.');
        return [];
      }
      const servers: RTCIceServer[] = [
        {
          urls,
          username: credentials.username,
          credential: credentials.credential
        }
      ];
      const ttlMs = Math.max(30_000, credentials.ttl * 1000 - 30_000);
      this.cachedIceServers = {
        expiresAt: now + ttlMs,
        servers
      };
      this.turnStatus.set({ state: 'ready', supportedUriCount: urls.length, expiresAt: now + ttlMs });
      return servers;
    } catch (error) {
      this.turnStatus.set({ state: 'degraded', reason: 'credentials_fetch_failed', supportedUriCount: 0 });
      this.cachedIceServers = { expiresAt: now + 5_000, servers: [] };
      console.warn('[WebRtcService] TURN credential fetch failed; continuing without relay ICE servers.', error);
      return [];
    }
  }
}

function isSupportedTurnUri(uri: string): boolean {
  const normalized = uri.trim().toLowerCase();
  return normalized.startsWith('turn:') && normalized.includes('transport=udp');
}

function addSenderForTrack(peer: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream, kind: ProducerKind, options: PublishOptions): PublishedSender | undefined {
  if (track.kind === 'video' && kind !== 'audio') {
    try {
      const transceiver = peer.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: options.svc ? svcSendEncodings(kind, options.scalabilityMode) : simulcastSendEncodings(kind)
      });
      return { sender: transceiver.sender, userMaxSpatialLayer: 2, svc: Boolean(options.svc) };
    } catch {
      try {
        const transceiver = peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        return { sender: transceiver.sender, userMaxSpatialLayer: 2, svc: false };
      } catch {
        return { sender: peer.addTrack(track, stream), userMaxSpatialLayer: 2, svc: false };
      }
    }
  }
  try {
    const transceiver = peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    return { sender: transceiver.sender, userMaxSpatialLayer: 0, svc: false };
  } catch {
    return { sender: peer.addTrack(track, stream), userMaxSpatialLayer: 0, svc: false };
  }
}

function simulcastSendEncodings(kind: ProducerKind): RTCRtpEncodingParameters[] {
  const screenMultiplier = kind === 'screen' ? 1.4 : 1;
  return [
    { rid: 'low', maxBitrate: Math.round(250_000 * screenMultiplier), scaleResolutionDownBy: 4, active: true },
    { rid: 'medium', maxBitrate: Math.round(900_000 * screenMultiplier), scaleResolutionDownBy: 2, active: true },
    { rid: 'high', maxBitrate: Math.round(2_500_000 * screenMultiplier), scaleResolutionDownBy: 1, active: true }
  ];
}

function svcSendEncodings(kind: ProducerKind, scalabilityMode = 'L3T3_KEY'): RTCRtpEncodingParameters[] {
  const screenMultiplier = kind === 'screen' ? 1.4 : 1;
  return [
    {
      maxBitrate: Math.round(2_500_000 * screenMultiplier),
      scaleResolutionDownBy: 1,
      active: true,
      scalabilityMode
    } as RTCRtpEncodingParameters & { scalabilityMode: string }
  ];
}

function createRtpParameters(kind: ProducerKind, options: PublishOptions = {}): RtpParameters {
  const ssrcBase = Math.floor(Math.random() * 0xffffffff);
  const videoCodec = options.codec ?? (options.svc ? 'VP9' : 'VP8');
  const scalabilityMode = options.svc ? options.scalabilityMode ?? 'L3T3_KEY' : undefined;
  return {
    codecs: [
      {
        mimeType: kind === 'audio' ? 'audio/opus' : `video/${videoCodec}`,
        payloadType: kind === 'audio' ? 111 : 96,
        clockRate: kind === 'audio' ? 48000 : 90000,
        channels: kind === 'audio' ? 2 : undefined,
        parameters: scalabilityMode ? { 'scalability-mode': scalabilityMode } : undefined,
        rtcpFeedback: kind === 'audio' ? ['transport-cc'] : ['nack', 'nack pli', 'goog-remb', 'transport-cc']
      }
    ],
    encodings:
      kind === 'audio'
        ? [{ ssrc: ssrcBase }]
        : options.svc
          ? [{ ssrc: ssrcBase, maxBitrate: 2500000, scalabilityMode }]
          : [
            { rid: 'low', ssrc: ssrcBase, maxBitrate: 250000, scaleResolutionDownBy: 4 },
            { rid: 'medium', ssrc: ssrcBase + 1, maxBitrate: 900000, scaleResolutionDownBy: 2 },
            { rid: 'high', ssrc: ssrcBase + 2, maxBitrate: 2500000, scaleResolutionDownBy: 1 }
          ],
    rtcp: {
      cname: crypto.randomUUID(),
      reducedSize: true
    }
  };
}

function parseCandidate(candidate: RTCIceCandidate): {
  foundation: string;
  component: 1 | 2;
  protocol: 'udp' | 'tcp';
  priority: number;
  ip: string;
  port: number;
  type: 'host' | 'srflx' | 'prflx' | 'relay';
} {
  const parts = candidate.candidate.split(' ');
  return {
    foundation: parts[0]?.replace(/^candidate:/, '') ?? '0',
    component: Number(parts[1] ?? 1) as 1 | 2,
    protocol: (parts[2]?.toLowerCase() ?? 'udp') as 'udp' | 'tcp',
    priority: Number(parts[3] ?? 0),
    ip: parts[4] ?? '0.0.0.0',
    port: Number(parts[5] ?? 0),
    type: (parts[7] ?? 'host') as 'host' | 'srflx' | 'prflx' | 'relay'
  };
}

function parseIceParameters(sdp: string): IceParameters | undefined {
  const usernameFragment = sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim();
  const password = sdp.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim();
  if (!usernameFragment || !password) {
    return undefined;
  }
  return {
    usernameFragment,
    password,
    iceLite: false
  };
}

function parseDtlsParameters(sdp: string): DtlsParameters | undefined {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:(sha-256|sha-384|sha-512)\s+(.+)$/gm)].map((match) => ({
    algorithm: match[1] as 'sha-256' | 'sha-384' | 'sha-512',
    value: match[2]?.trim() ?? ''
  }));
  if (!fingerprints.length) {
    return undefined;
  }
  return {
    role: 'client',
    fingerprints
  };
}

async function applySenderDynacast(
  sender: RTCRtpSender,
  event: ProducerDynacastEvent,
  userMaxSpatialLayer: number
): Promise<{ ok: boolean; reason?: string; layer?: RtpLayerSelection }> {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) {
    return { ok: false, reason: 'sender_encodings_missing' };
  }
  const desiredLayers = event.enabled ? event.desiredLayers : undefined;
  parameters.encodings = parameters.encodings.map((encoding, index) => ({
    ...encoding,
    active: desiredLayers ? encodingDesired(encoding, index, desiredLayers, userMaxSpatialLayer) : spatialLayerFromRid(encoding.rid, index) <= userMaxSpatialLayer
  }));
  try {
    await sender.setParameters(parameters);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name || 'set_parameters_failed' : 'set_parameters_failed' };
  }
}

function encodingDesired(encoding: RTCRtpEncodingParameters, index: number, desiredLayers: RtpLayerSelection[], userMaxSpatialLayer: number): boolean {
  if (desiredLayers.length === 0) {
    return false;
  }
  const spatialLayer = spatialLayerFromRid(encoding.rid, index);
  if (spatialLayer > userMaxSpatialLayer) {
    return false;
  }
  return desiredLayers.some((layer) => layer.spatialLayer === undefined || layer.spatialLayer === spatialLayer);
}

function spatialLayerFromRid(rid: string | undefined, fallbackIndex: number): number {
  switch (rid) {
    case 'low':
    case 'q':
      return 0;
    case 'medium':
    case 'mid':
    case 'm':
      return 1;
    case 'high':
    case 'h':
    case 'f':
      return 2;
    default:
      return fallbackIndex;
  }
}
