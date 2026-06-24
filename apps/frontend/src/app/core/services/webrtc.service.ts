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
  ProducerSource,
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

export type MediaErrorCode =
  | 'permission_denied'
  | 'device_unavailable'
  | 'device_busy'
  | 'operation_interrupted'
  | 'track_ended'
  | 'publish_failed'
  | 'consume_failed'
  | 'transport_failed'
  | 'autoplay_blocked'
  | 'unknown';
export type MediaErrorSeverity = 'info' | 'warning' | 'error';
export type MediaErrorKind = 'audio' | 'video' | 'screen' | 'transport' | 'consumer' | 'producer';
export type MediaErrorOperation = 'permission' | 'acquire' | 'publish' | 'consume' | 'switch' | 'stop' | 'autoplay' | 'track-ended' | 'refresh';

export interface MediaRecoveryError {
  code: MediaErrorCode;
  severity: MediaErrorSeverity;
  kind: MediaErrorKind;
  operation: MediaErrorOperation;
  message: string;
  recoverable: boolean;
  actionLabel?: string;
  originalName?: string;
}

export interface PublishOptions {
  svc?: boolean;
  scalabilityMode?: string;
  codec?: 'VP8' | 'VP9' | 'H264';
  source?: ProducerSource;
}

export interface RemoteMediaStream {
  producerId: string;
  participantId: string;
  kind: ProducerKind;
  consumerId?: string;
  stream: MediaStream;
}

type LocalDeviceKind = 'audio' | 'video';

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  readonly localStream = signal<MediaStream | null>(null);
  readonly screenStream = signal<MediaStream | null>(null);
  readonly remoteStreams = signal<RemoteMediaStream[]>([]);
  readonly devices = signal<{ audioInputs: DeviceOption[]; videoInputs: DeviceOption[] }>({ audioInputs: [], videoInputs: [] });
  readonly selectedAudioDeviceId = signal<string | null>(null);
  readonly selectedVideoDeviceId = signal<string | null>(null);
  readonly activeAudioDeviceId = signal<string | null>(null);
  readonly activeVideoDeviceId = signal<string | null>(null);
  readonly mediaDeviceLoading = signal(false);
  readonly deviceSwitching = signal<{ audio: boolean; video: boolean }>({ audio: false, video: false });
  readonly mediaDeviceError = signal<string | null>(null);
  readonly lastMediaError = signal<MediaRecoveryError | null>(null);
  readonly networkScore = signal(5);
  readonly turnStatus = signal<TurnStatus>({ state: 'idle', supportedUriCount: 0 });
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly transportPublishCounts = new Map<string, number>();
  private readonly publishedProducers = new Map<string, { kind: ProducerKind; svc: boolean; senders: PublishedSender[] }>();
  private readonly remoteConsumers = new Map<string, { consumer: Consumer; peer: RTCPeerConnection; transport: TransportOptions }>();
  private readonly pendingRemoteProducerIds = new Set<string>();
  private mediaDeviceLoadingCount = 0;
  private cachedIceServers?: { expiresAt: number; servers: RTCIceServer[] };

  constructor(
    private readonly socket: SocketService,
    private readonly http: HttpClient
  ) {}

  clearMediaIssue(kind?: MediaErrorKind): void {
    this.clearMediaError(kind);
  }

  recordAutoplayBlocked(error: unknown): MediaRecoveryError {
    return this.recordMediaError('audio', 'autoplay', error, 'Browser blocked audio playback.');
  }

  async refreshDevices(): Promise<void> {
    this.setMediaDeviceLoading(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((device) => device.kind === 'audioinput').map((device) => ({ id: device.deviceId, label: device.label || 'Microphone' }));
      const videoInputs = devices.filter((device) => device.kind === 'videoinput').map((device) => ({ id: device.deviceId, label: device.label || 'Camera' }));
      this.devices.set({ audioInputs, videoInputs });
      this.reconcileSelectedDevice('audio', audioInputs);
      this.reconcileSelectedDevice('video', videoInputs);
      this.mediaDeviceError.set(null);
    } catch (error) {
      const mediaError = this.recordMediaError('transport', 'refresh', error, 'Unable to refresh media devices.');
      this.mediaDeviceError.set(mediaError.message);
      throw error;
    } finally {
      this.setMediaDeviceLoading(false);
    }
  }

  selectAudioDevice(deviceId: string | null | undefined): void {
    this.selectedAudioDeviceId.set(normalizeDeviceId(deviceId));
  }

  selectVideoDevice(deviceId: string | null | undefined): void {
    this.selectedVideoDeviceId.set(normalizeDeviceId(deviceId));
  }

  async startCamera(...deviceIds: [audioDeviceId?: string | null, videoDeviceId?: string | null]): Promise<MediaStream> {
    const requestedAudioDeviceId = normalizeDeviceId(deviceIds.length > 0 ? deviceIds[0] : this.selectedAudioDeviceId());
    const requestedVideoDeviceId = normalizeDeviceId(deviceIds.length > 1 ? deviceIds[1] : this.selectedVideoDeviceId());
    this.setMediaDeviceLoading(true);
    this.mediaDeviceError.set(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(requestedAudioDeviceId),
        video: videoConstraints(requestedVideoDeviceId)
      });
      stream.getAudioTracks().forEach((track) => this.monitorTrackEnded(track, 'audio'));
      stream.getVideoTracks().forEach((track) => this.monitorTrackEnded(track, 'video'));
      this.localStream.set(stream);
      this.syncDeviceStateFromStream(stream, requestedAudioDeviceId, requestedVideoDeviceId);
      await this.refreshDevices();
      this.clearMediaError('audio');
      this.clearMediaError('video');
      return stream;
    } catch (error) {
      const mediaError = this.recordMediaError('video', 'acquire', error, 'Unable to start camera and microphone.');
      this.mediaDeviceError.set(mediaError.message);
      throw error;
    } finally {
      this.setMediaDeviceLoading(false);
    }
  }

  stopCamera(): void {
    this.localStream()?.getTracks().forEach((track) => track.stop());
    this.localStream.set(null);
    this.activeAudioDeviceId.set(null);
    this.activeVideoDeviceId.set(null);
  }

  async switchCamera(videoDeviceId: string | null | undefined): Promise<MediaStream> {
    return this.switchLocalDeviceTrack('video', videoDeviceId);
  }

  async switchMicrophone(audioDeviceId: string | null | undefined): Promise<MediaStream> {
    return this.switchLocalDeviceTrack('audio', audioDeviceId);
  }

  async startScreen(): Promise<MediaStream> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getTracks().forEach((track) => this.monitorTrackEnded(track, 'screen'));
      this.screenStream.set(stream);
      this.clearMediaError('screen');
      return stream;
    } catch (error) {
      this.recordMediaError('screen', 'acquire', error, 'Unable to start screen sharing.');
      throw error;
    }
  }

  stopScreen(): void {
    this.screenStream()?.getTracks().forEach((track) => track.stop());
    this.screenStream.set(null);
  }

  async preparePeer(roomId: string): Promise<TransportOptions> {
    const transport = await this.socket.emitAck('transport:create', { roomId });
    this.peers.set(transport.id, await this.createPeer(transport));
    return transport;
  }

  async publish(roomId: string, transport: TransportOptions, kind: ProducerKind, stream: MediaStream, options: PublishOptions = {}): Promise<Producer> {
    let activeTransport = transport;
    let producer: Producer | undefined;
    try {
      if (this.transportPublishCounts.get(transport.id)) {
        activeTransport = await this.preparePeer(roomId);
      }
      let peer = this.peers.get(activeTransport.id);
      if (!peer) {
        activeTransport = await this.preparePeer(roomId);
        peer = this.peers.get(activeTransport.id);
      }
      if (!peer) {
        throw new Error('Unable to prepare media transport');
      }
      const senders: PublishedSender[] = [];
      for (const track of stream.getTracks()) {
        if ((kind === 'audio' && track.kind !== 'audio') || (kind !== 'audio' && track.kind !== 'video')) {
          continue;
        }
        const sender = addSenderForTrack(peer, track, stream, kind, options);
        if (sender?.sender) {
          senders.push(sender);
        }
      }
      if (!senders.length) {
        throw new Error(`No ${kind === 'audio' ? 'audio' : 'video'} track is available to publish`);
      }

      if (peer.signalingState !== 'stable') {
        throw new Error('Media negotiation is already in progress');
      }
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localSdp = peer.localDescription?.sdp ?? '';
      const iceParameters = parseIceParameters(localSdp);
      if (iceParameters) {
        await this.socket.emitAck('transport:ice-parameters', { transportId: activeTransport.id, iceParameters });
      }
      const dtlsParameters = parseDtlsParameters(localSdp);
      if (dtlsParameters) {
        await this.socket.emitAck('transport:dtls-parameters', { transportId: activeTransport.id, dtlsParameters });
      }
      const rtpParameters = parseRtpParameters(kind, localSdp) ?? createRtpParameters(kind, options);
      const event = kind === 'screen' ? 'screen:start' : 'producer:create';
      producer = await this.socket.emitAck(event, {
        roomId,
        kind,
        ...(options.source ? { source: options.source } : {}),
        transportId: activeTransport.id,
        rtpParameters
      });
      const answer = buildUnifiedPlanAnswer({
        transport: activeTransport,
        offer: localSdp,
        direction: 'recvonly',
        mediaKind: kind === 'audio' ? 'audio' : 'video',
        rtpParameters
      });
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      this.transportPublishCounts.set(activeTransport.id, (this.transportPublishCounts.get(activeTransport.id) ?? 0) + 1);
      this.publishedProducers.set(producer.id, { kind, svc: Boolean(options.svc && kind !== 'audio'), senders });
      this.clearMediaError(kind === 'audio' ? 'audio' : kind === 'screen' ? 'screen' : 'video');
      return producer;
    } catch (error) {
      if (producer) {
        await this.socket.emitAck(kind === 'screen' ? 'screen:stop' : 'producer:close', { producerId: producer.id }).catch(() => undefined);
      }
      this.recordMediaError(kind === 'audio' ? 'audio' : kind === 'screen' ? 'screen' : 'video', 'publish', error, `Unable to publish ${kind === 'audio' ? 'microphone' : kind === 'screen' ? 'screen share' : 'camera'}.`);
      throw error;
    }
  }

  async consumeProducer(roomId: string, producer: Producer): Promise<Consumer | undefined> {
    if (
      producer.status !== 'live' ||
      this.remoteConsumers.has(producer.id) ||
      this.pendingRemoteProducerIds.has(producer.id) ||
      this.publishedProducers.has(producer.id)
    ) {
      return undefined;
    }
    this.pendingRemoteProducerIds.add(producer.id);
    let transport: TransportOptions | undefined;
    let peer: RTCPeerConnection | undefined;
    try {
      const mediaKind = producer.kind === 'audio' ? 'audio' : 'video';
      transport = await this.preparePeer(roomId);
      peer = this.peers.get(transport.id);
      if (!peer) {
        throw new Error('Unable to prepare receive transport');
      }
      peer.addTransceiver(mediaKind, { direction: 'recvonly' });
      peer.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.upsertRemoteStream({
          producerId: producer.id,
          participantId: producer.participantId,
          kind: producer.kind,
          consumerId: this.remoteConsumers.get(producer.id)?.consumer.id,
          stream
        });
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localSdp = peer.localDescription?.sdp ?? '';
      const iceParameters = parseIceParameters(localSdp);
      if (iceParameters) {
        await this.socket.emitAck('transport:ice-parameters', { transportId: transport.id, iceParameters });
      }
      const dtlsParameters = parseDtlsParameters(localSdp);
      if (dtlsParameters) {
        await this.socket.emitAck('transport:dtls-parameters', { transportId: transport.id, dtlsParameters });
      }
      const consumer = await this.socket.emitAck('consumer:create', { roomId, producerId: producer.id, transportId: transport.id });
      const answer = buildUnifiedPlanAnswer({
        transport,
        offer: localSdp,
        direction: 'sendonly',
        mediaKind,
        rtpParameters: consumer.rtpParameters
      });
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      this.remoteConsumers.set(producer.id, { consumer, peer, transport });
      this.clearMediaError('consumer');
      return consumer;
    } catch (error) {
      peer?.close();
      if (transport) {
        this.peers.delete(transport.id);
      }
      this.remoteConsumers.delete(producer.id);
      this.remoteStreams.update((streams) => streams.filter((stream) => stream.producerId !== producer.id));
      this.recordMediaError('consumer', 'consume', error, `Unable to receive ${producer.kind === 'audio' ? 'audio' : producer.kind === 'screen' ? 'screen share' : 'video'}.`);
      throw error;
    } finally {
      this.pendingRemoteProducerIds.delete(producer.id);
    }
  }

  async closeProducer(producerId: string): Promise<void> {
    const publication = this.publishedProducers.get(producerId);
    if (!publication) {
      return;
    }
    await this.socket.emitAck(publication.kind === 'screen' ? 'screen:stop' : 'producer:close', { producerId });
    for (const entry of publication.senders) {
      entry.sender.track?.stop();
    }
    this.publishedProducers.delete(producerId);
  }

  removeRemoteProducer(producerId: string): void {
    const remote = this.remoteConsumers.get(producerId);
    if (remote) {
      void this.socket.emitAck('consumer:close', { consumerId: remote.consumer.id }).catch(() => undefined);
      remote.peer.close();
      this.peers.delete(remote.transport.id);
      this.remoteConsumers.delete(producerId);
    }
    this.remoteStreams.update((streams) => streams.filter((stream) => stream.producerId !== producerId));
  }

  resetRoomMedia(): void {
    this.stopCamera();
    this.stopScreen();
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.transportPublishCounts.clear();
    this.publishedProducers.clear();
    this.remoteConsumers.clear();
    this.pendingRemoteProducerIds.clear();
    this.remoteStreams.set([]);
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

  private async switchLocalDeviceTrack(kind: LocalDeviceKind, deviceId: string | null | undefined): Promise<MediaStream> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const deviceName = kind === 'audio' ? 'microphone' : 'camera';

    this.setDeviceSwitching(kind, true);
    this.setMediaDeviceLoading(true);
    this.mediaDeviceError.set(null);

    let replacementTrack: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'audio'
          ? { audio: audioConstraints(normalizedDeviceId), video: false }
          : { audio: false, video: videoConstraints(normalizedDeviceId) }
      );
      replacementTrack = firstTrackOfKind(stream, kind);
      if (!replacementTrack) {
        throw new Error(`No ${deviceName} track is available from the selected device.`);
      }
      this.monitorTrackEnded(replacementTrack, kind);

      const previousTracks = this.localStream()?.getTracks().filter((track) => track.kind === kind) ?? [];
      const previousPublishedTracks = this.publishedTracksForKind(kind);
      replacementTrack.enabled = previousTracks[0]?.enabled ?? true;

      await this.replacePublishedTracks(kind, replacementTrack);
      const nextStream = this.replaceLocalTrack(kind, replacementTrack);
      this.setSelectedDeviceId(kind, normalizedDeviceId);
      this.setActiveDeviceId(kind, deviceIdFromTrack(replacementTrack) ?? normalizedDeviceId);
      await this.refreshDevices().catch(() => undefined);
      new Set([...previousTracks, ...previousPublishedTracks]).forEach((track) => track.stop());
      this.clearMediaError(kind);
      return nextStream;
    } catch (error) {
      replacementTrack?.stop();
      const mediaError = this.recordMediaError(kind, 'switch', error, `Unable to switch ${deviceName}.`);
      this.mediaDeviceError.set(mediaError.message);
      throw error;
    } finally {
      this.setMediaDeviceLoading(false);
      this.setDeviceSwitching(kind, false);
    }
  }

  private async replacePublishedTracks(kind: LocalDeviceKind, track: MediaStreamTrack): Promise<number> {
    const producerKind: ProducerKind = kind === 'audio' ? 'audio' : 'video';
    const senders = [...this.publishedProducers.values()]
      .filter((publication) => publication.kind === producerKind)
      .flatMap((publication) => publication.senders)
      .filter((entry) => !entry.sender.track || entry.sender.track.kind === kind);

    if (!senders.length) {
      return 0;
    }

    await Promise.all(senders.map((entry) => entry.sender.replaceTrack(track)));
    return senders.length;
  }

  private publishedTracksForKind(kind: LocalDeviceKind): MediaStreamTrack[] {
    const producerKind: ProducerKind = kind === 'audio' ? 'audio' : 'video';
    return [...this.publishedProducers.values()]
      .filter((publication) => publication.kind === producerKind)
      .flatMap((publication) => publication.senders)
      .map((entry) => entry.sender.track)
      .filter((track): track is MediaStreamTrack => track !== null && track.kind === kind);
  }

  private replaceLocalTrack(kind: LocalDeviceKind, track: MediaStreamTrack): MediaStream {
    const currentStream = this.localStream();
    if (!currentStream) {
      const stream = new MediaStream([track]);
      this.localStream.set(stream);
      return stream;
    }

    let inserted = false;
    const tracks = currentStream.getTracks().flatMap((currentTrack) => {
      if (currentTrack.kind !== kind) {
        return [currentTrack];
      }
      if (inserted) {
        return [];
      }
      inserted = true;
      return [track];
    });

    if (!inserted) {
      tracks.push(track);
    }

    const stream = new MediaStream(tracks);
    this.localStream.set(stream);
    return stream;
  }

  private syncDeviceStateFromStream(stream: MediaStream, requestedAudioDeviceId: string | null, requestedVideoDeviceId: string | null): void {
    const audioDeviceId = deviceIdFromTrack(stream.getAudioTracks()[0]) ?? requestedAudioDeviceId;
    const videoDeviceId = deviceIdFromTrack(stream.getVideoTracks()[0]) ?? requestedVideoDeviceId;
    this.activeAudioDeviceId.set(audioDeviceId);
    this.activeVideoDeviceId.set(videoDeviceId);
    this.selectedAudioDeviceId.set(requestedAudioDeviceId ?? audioDeviceId);
    this.selectedVideoDeviceId.set(requestedVideoDeviceId ?? videoDeviceId);
  }

  private reconcileSelectedDevice(kind: LocalDeviceKind, devices: DeviceOption[]): void {
    const selectedDeviceId = kind === 'audio' ? this.selectedAudioDeviceId() : this.selectedVideoDeviceId();
    if (!selectedDeviceId || devices.length === 0 || devices.some((device) => device.id === selectedDeviceId) || devices.every((device) => !device.id)) {
      return;
    }
    this.setSelectedDeviceId(kind, null);
  }

  private setSelectedDeviceId(kind: LocalDeviceKind, deviceId: string | null): void {
    if (kind === 'audio') {
      this.selectedAudioDeviceId.set(deviceId);
      return;
    }
    this.selectedVideoDeviceId.set(deviceId);
  }

  private setActiveDeviceId(kind: LocalDeviceKind, deviceId: string | null): void {
    if (kind === 'audio') {
      this.activeAudioDeviceId.set(deviceId);
      return;
    }
    this.activeVideoDeviceId.set(deviceId);
  }

  private setDeviceSwitching(kind: LocalDeviceKind, switching: boolean): void {
    this.deviceSwitching.update((state) => ({ ...state, [kind]: switching }));
  }

  private setMediaDeviceLoading(loading: boolean): void {
    this.mediaDeviceLoadingCount = Math.max(0, this.mediaDeviceLoadingCount + (loading ? 1 : -1));
    this.mediaDeviceLoading.set(this.mediaDeviceLoadingCount > 0);
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

  private async createPeer(transport: TransportOptions): Promise<RTCPeerConnection> {
    const iceServers = await this.loadIceServers();
    const peer = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    peer.onicecandidate = (event) => {
      if (event.candidate?.candidate) {
        void this.socket.emitAck('transport:ice-candidate', {
          transportId: transport.id,
          candidate: parseCandidate(event.candidate)
        });
      }
    };
    return peer;
  }

  private upsertRemoteStream(remote: RemoteMediaStream): void {
    this.remoteStreams.update((streams) => [...streams.filter((stream) => stream.producerId !== remote.producerId), remote]);
  }

  private monitorTrackEnded(track: MediaStreamTrack, kind: MediaErrorKind): void {
    track.addEventListener(
      'ended',
      () => {
        this.lastMediaError.set({
          code: 'track_ended',
          severity: kind === 'screen' ? 'info' : 'warning',
          kind,
          operation: 'track-ended',
          message: kind === 'screen' ? 'Screen sharing stopped.' : `${kind === 'audio' ? 'Microphone' : 'Camera'} disconnected or stopped.`,
          recoverable: true,
          actionLabel: kind === 'screen' ? 'Share again' : 'Retry media'
        });
      },
      { once: true }
    );
  }

  private clearMediaError(kind?: MediaErrorKind): void {
    const current = this.lastMediaError();
    if (!current || (kind && current.kind !== kind)) {
      return;
    }
    this.lastMediaError.set(null);
  }

  private recordMediaError(kind: MediaErrorKind, operation: MediaErrorOperation, error: unknown, fallback: string): MediaRecoveryError {
    const mediaError = mediaRecoveryError(kind, operation, error, fallback);
    this.lastMediaError.set(mediaError);
    return mediaError;
  }
}

function normalizeDeviceId(deviceId: string | null | undefined): string | null {
  const normalized = deviceId?.trim();
  return normalized ? normalized : null;
}

function audioConstraints(deviceId: string | null): boolean | MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function videoConstraints(deviceId: string | null): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

function firstTrackOfKind(stream: MediaStream, kind: LocalDeviceKind): MediaStreamTrack | undefined {
  return kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
}

function deviceIdFromTrack(track: MediaStreamTrack | undefined): string | null {
  return normalizeDeviceId(track?.getSettings().deviceId);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function mediaRecoveryError(kind: MediaErrorKind, operation: MediaErrorOperation, error: unknown, fallback: string): MediaRecoveryError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : undefined;
  const code = mediaErrorCode(name, operation);
  return {
    code,
    severity: code === 'autoplay_blocked' || code === 'track_ended' ? 'warning' : 'error',
    kind,
    operation,
    message: mediaErrorMessage(code, kind, error, fallback),
    recoverable: code !== 'unknown' || operation !== 'publish',
    actionLabel: mediaActionLabel(code, kind, operation),
    ...(name ? { originalName: name } : {})
  };
}

function mediaErrorCode(name: string | undefined, operation: MediaErrorOperation): MediaErrorCode {
  if (operation === 'autoplay') {
    return 'autoplay_blocked';
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission_denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'device_unavailable';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'device_busy';
    case 'AbortError':
      return 'operation_interrupted';
    default:
      if (operation === 'publish') return 'publish_failed';
      if (operation === 'consume') return 'consume_failed';
      return 'unknown';
  }
}

function mediaErrorMessage(code: MediaErrorCode, kind: MediaErrorKind, error: unknown, fallback: string): string {
  const deviceName = kind === 'audio' ? 'microphone' : kind === 'video' ? 'camera' : kind === 'screen' ? 'screen share' : 'media';
  const combinedCameraAndMic = /camera and microphone|microphone and camera/i.test(fallback);
  switch (code) {
    case 'permission_denied':
      if (combinedCameraAndMic) {
        return 'Camera or microphone permission was blocked. Allow access in your browser, then retry.';
      }
      return `${capitalize(deviceName)} permission was blocked. Allow access in your browser, then retry.`;
    case 'device_unavailable':
      if (combinedCameraAndMic) {
        return 'The selected camera or microphone is unavailable. Refresh devices or choose another one.';
      }
      return `The selected ${deviceName} is unavailable. Refresh devices or choose another one.`;
    case 'device_busy':
      if (combinedCameraAndMic) {
        return 'The selected camera or microphone is busy in another app. Close the other app, then retry.';
      }
      return `The selected ${deviceName} is busy in another app. Close the other app, then retry.`;
    case 'operation_interrupted':
      return `${capitalize(deviceName)} setup was interrupted. Please retry.`;
    case 'autoplay_blocked':
      return 'Browser blocked audio playback. Tap Enable audio to hear the class.';
    case 'track_ended':
      return `${capitalize(deviceName)} stopped unexpectedly.`;
    case 'publish_failed':
      return `Could not publish ${deviceName}. Retry without leaving the class.`;
    case 'consume_failed':
      return `Could not receive remote ${deviceName}. Waiting for recovery or retry.`;
    case 'transport_failed':
    case 'unknown':
    default:
      return errorMessage(error, fallback);
  }
}

function mediaActionLabel(code: MediaErrorCode, kind: MediaErrorKind, operation: MediaErrorOperation): string | undefined {
  if (code === 'autoplay_blocked') return 'Enable audio';
  if (operation === 'refresh' || code === 'device_unavailable') return 'Refresh devices';
  if (kind === 'screen') return 'Retry screen share';
  if (kind === 'audio') return 'Retry microphone';
  if (kind === 'video') return 'Retry camera';
  if (kind === 'consumer') return 'Retry receiving media';
  return undefined;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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

function parseRtpParameters(kind: ProducerKind, sdp: string): RtpParameters | undefined {
  try {
    const mediaKind = kind === 'audio' ? 'audio' : 'video';
    const section = mediaSection(sdp, mediaKind);
    const mLine = section.find((line) => line.startsWith('m=')) ?? '';
    const payloadTypes = mLine.split(/\s+/).slice(3).map(Number).filter(Number.isFinite);
    const primaryPayloadType = selectPrimaryPayloadType(section, payloadTypes, mediaKind);
    const rtpmap = section.find((line) => line.startsWith(`a=rtpmap:${primaryPayloadType} `));
    const codecParts = rtpmap?.split(/\s+/)[1]?.split('/') ?? [];
    const rtxPayloadTypes = rtxPayloadTypesForApt(section, primaryPayloadType);
    const fidGroups = fidGroupsFromSection(section);
    const primarySsrcs = primarySsrcsFromSection(section, fidGroups);
    const ridInfos = mediaKind === 'video' ? ridInfosFromSection(section) : [];
    const cnameSsrc = primarySsrcs[0];
    const cname = cnameSsrc ? section.find((line) => line.startsWith(`a=ssrc:${cnameSsrc} cname:`))?.split('cname:')[1] ?? crypto.randomUUID() : crypto.randomUUID();
    const encodingCount = Math.max(primarySsrcs.length, ridInfos.length, 1);

    return {
      codecs: [
        {
          mimeType: `${mediaKind}/${codecParts[0] ?? (mediaKind === 'audio' ? 'opus' : 'VP8')}`,
          payloadType: primaryPayloadType,
          clockRate: Number(codecParts[1] ?? (mediaKind === 'audio' ? 48000 : 90000)),
          channels: codecParts[2] ? Number(codecParts[2]) : undefined,
          parameters: fmtpParameters(section, primaryPayloadType),
          rtcpFeedback: section
            .filter((line) => line.startsWith(`a=rtcp-fb:${primaryPayloadType}`))
            .map((line) => line.split(/\s+/).slice(1).join(' '))
        },
        ...rtxPayloadTypes.map((payloadType) => ({
          mimeType: `${mediaKind}/rtx`,
          payloadType,
          clockRate: Number(section.find((line) => line.startsWith(`a=rtpmap:${payloadType} `))?.split(/\s+/)[1]?.split('/')[1] ?? 90000),
          parameters: fmtpParameters(section, payloadType),
          rtcpFeedback: []
        }))
      ],
      headerExtensions: headerExtensionsFromSection(section),
      encodings: Array.from({ length: encodingCount }).map((_, index) => {
        const ssrc = primarySsrcs[index];
        const ridInfo = ridInfos[index];
        const rtxSsrc = ssrc === undefined ? undefined : fidGroups.get(ssrc);
        return {
          ssrc,
          rid: mediaKind === 'audio' ? undefined : ridInfo?.rid ?? ridAt(section, index),
          spatialLayer: mediaKind === 'audio' ? undefined : spatialLayerFromRid(ridInfo?.rid, index),
          maxBitrate: ridInfo?.maxBitrate,
          scaleResolutionDownBy: ridInfo?.scaleResolutionDownBy,
          rtx: rtxSsrc !== undefined ? { ssrc: rtxSsrc, payloadType: rtxPayloadTypes[0] } : undefined
        };
      }),
      simulcast:
        mediaKind === 'video' && ridInfos.length > 1
          ? {
              direction: 'send',
              rids: ridInfos.map((rid) => rid.rid),
              pausedRids: ridInfos.filter((rid) => rid.paused).map((rid) => rid.rid)
            }
          : undefined,
      rtcp: { cname, reducedSize: section.includes('a=rtcp-rsize') || section.includes('a=rtcp-mux') }
    };
  } catch {
    return undefined;
  }
}

function buildUnifiedPlanAnswer(options: {
  transport: TransportOptions;
  offer: string;
  direction: 'sendonly' | 'recvonly' | 'inactive';
  mediaKind: 'audio' | 'video';
  rtpParameters?: RtpParameters;
}): string {
  const sections = mediaSections(options.offer);
  const targetIndex = sections.findIndex((section) => mediaTypeFromSection(section) === options.mediaKind);
  if (targetIndex < 0) {
    throw new Error('SDP offer does not include a compatible media section');
  }
  const candidate = options.transport.iceCandidates.find((item) => item.ip === '127.0.0.1') ?? options.transport.iceCandidates[0];
  if (!candidate) {
    throw new Error('Transport does not include ICE candidates');
  }
  const mediaAnswers: string[][] = [];
  const activeMids: string[] = [];

  sections.forEach((section, index) => {
    const mid = findLineValue(section, 'a=mid:') ?? String(index);
    const mLine = section.find((line) => line.startsWith('m=')) ?? '';
    const mParts = mLine.split(/\s+/);
    const mediaType = mParts[0]?.slice(2) ?? options.mediaKind;
    const protocol = mParts[2] ?? 'UDP/TLS/RTP/SAVPF';
    const payloadTypes = mParts.slice(3).join(' ');
    if (index !== targetIndex) {
      mediaAnswers.push([
        `m=${mediaType} 0 ${protocol} ${payloadTypes}`.trimEnd(),
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=inactive',
        ...(section.includes('a=rtcp-mux') ? ['a=rtcp-mux'] : [])
      ]);
      return;
    }

    activeMids.push(mid);
    const selectedPayloadTypes = answerPayloadTypes(section, options.rtpParameters);
    const activePayloadTypes = selectedPayloadTypes.length ? selectedPayloadTypes.join(' ') : payloadTypes;
    const codecLines = section.filter((line) => {
      if (/^(a=extmap:|a=extmap-allow-mixed)/.test(line)) {
        return true;
      }
      const payloadType = payloadTypeFromCodecLine(line);
      return payloadType !== undefined && (!selectedPayloadTypes.length || selectedPayloadTypes.includes(payloadType));
    });
    const activeLines = [
      `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${activePayloadTypes}`.trimEnd(),
      'c=IN IP4 0.0.0.0',
      `a=mid:${mid}`,
      `a=ice-ufrag:${options.transport.iceParameters.usernameFragment}`,
      `a=ice-pwd:${options.transport.iceParameters.password}`,
      'a=ice-options:trickle',
      ...options.transport.dtlsParameters.fingerprints.map((fingerprint) => `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`),
      'a=setup:passive',
      `a=${options.direction}`,
      'a=rtcp-mux',
      'a=rtcp-rsize',
      ...codecLines,
      ...simulcastAnswerLines(section, options.direction),
      candidateLine(candidate),
      'a=end-of-candidates'
    ];

    if (options.direction === 'sendonly' && options.rtpParameters) {
      for (const encoding of options.rtpParameters.encodings) {
        if (encoding.ssrc === undefined) {
          continue;
        }
        if (encoding.rtx?.ssrc !== undefined) {
          activeLines.push(`a=ssrc-group:FID ${encoding.ssrc} ${encoding.rtx.ssrc}`);
        }
        activeLines.push(`a=ssrc:${encoding.ssrc} cname:${options.rtpParameters.rtcp.cname}`);
        activeLines.push(`a=ssrc:${encoding.ssrc} msid:sfu-stream ${options.mediaKind}-track`);
        if (encoding.rtx?.ssrc !== undefined) {
          activeLines.push(`a=ssrc:${encoding.rtx.ssrc} cname:${options.rtpParameters.rtcp.cname}`);
          activeLines.push(`a=ssrc:${encoding.rtx.ssrc} msid:sfu-stream ${options.mediaKind}-rtx`);
        }
      }
    }
    mediaAnswers.push(activeLines);
  });

  return [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${activeMids.join(' ')}`,
    'a=msid-semantic: WMS *',
    ...mediaAnswers.flat()
  ].join('\r\n') + '\r\n';
}

function mediaSections(sdp: string): string[][] {
  return sdp
    .split(/\r?\n(?=m=)/)
    .slice(1)
    .map((section) => section.split(/\r?\n/).filter(Boolean))
    .filter((section) => /^m=(audio|video)\s/.test(section[0] ?? ''));
}

function mediaSection(sdp: string, mediaKind: 'audio' | 'video'): string[] {
  const section = mediaSections(sdp).find((item) => item[0]?.startsWith(`m=${mediaKind} `));
  if (!section) {
    throw new Error('SDP does not include a compatible media section');
  }
  return section;
}

function mediaTypeFromSection(section: string[]): 'audio' | 'video' | undefined {
  const type = section[0]?.split(/\s+/)[0]?.slice(2);
  return type === 'audio' || type === 'video' ? type : undefined;
}

function findLineValue(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

function answerPayloadTypes(section: string[], rtpParameters: RtpParameters | undefined): number[] {
  if (!rtpParameters?.codecs?.length) {
    return [];
  }
  const offeredPayloadTypes = ((section.find((line) => line.startsWith('m=')) ?? '').split(/\s+/).slice(3))
    .map((value) => Number(value))
    .filter(Number.isFinite);
  const selectedPayloadTypes = new Set(rtpParameters.codecs.map((codec) => codec.payloadType));
  return offeredPayloadTypes.filter((payloadType) => selectedPayloadTypes.has(payloadType));
}

function payloadTypeFromCodecLine(line: string): number | undefined {
  const match = line.match(/^a=(?:rtpmap|rtcp-fb|fmtp):(\d+)/);
  if (!match) {
    return undefined;
  }
  const payloadType = Number(match[1]);
  return Number.isFinite(payloadType) ? payloadType : undefined;
}

function selectPrimaryPayloadType(section: string[], payloadTypes: number[], mediaKind: 'audio' | 'video'): number {
  const rtxPayloads = new Set(
    section
      .filter((line) => /a=rtpmap:\d+\s+rtx\//i.test(line))
      .map((line) => Number(line.match(/^a=rtpmap:(\d+)/)?.[1]))
      .filter(Number.isFinite)
  );
  const preferred = mediaKind === 'audio' ? /opus/i : /^(VP8|VP9|H264|AV1)\//i;
  return (
    payloadTypes.find((payloadType) => !rtxPayloads.has(payloadType) && preferred.test(section.find((line) => line.startsWith(`a=rtpmap:${payloadType} `))?.split(/\s+/)[1] ?? '')) ??
    payloadTypes.find((payloadType) => !rtxPayloads.has(payloadType)) ??
    payloadTypes[0] ??
    (mediaKind === 'audio' ? 111 : 96)
  );
}

function fmtpParameters(section: string[], payloadType: number): Record<string, string | number | boolean> | undefined {
  const fmtp = section.find((line) => line.startsWith(`a=fmtp:${payloadType} `))?.split(/\s+/).slice(1).join(' ');
  if (!fmtp) {
    return undefined;
  }
  return Object.fromEntries(
    fmtp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, value = true] = part.split('=');
        const numeric = typeof value === 'string' ? Number(value) : Number.NaN;
        return [key, Number.isFinite(numeric) ? numeric : value];
      })
  );
}

function rtxPayloadTypesForApt(section: string[], apt: number): number[] {
  return section
    .filter((line) => line.startsWith('a=fmtp:') && line.includes(`apt=${apt}`))
    .map((line) => Number(line.match(/^a=fmtp:(\d+)/)?.[1]))
    .filter(Number.isFinite);
}

function headerExtensionsFromSection(section: string[]): RtpParameters['headerExtensions'] {
  return section
    .filter((line) => line.startsWith('a=extmap:'))
    .map((line) => {
      const [idPart, uri, directionPart] = line.slice('a=extmap:'.length).trim().split(/\s+/);
      const [id, direction] = (idPart ?? '').split('/');
      return {
        id: Number(id),
        uri: uri ?? '',
        direction: (direction ?? directionPart) as RtpParameters['headerExtensions'] extends Array<infer T> ? T extends { direction?: infer D } ? D : never : never
      };
    })
    .filter((extension) => Number.isFinite(extension.id) && extension.uri);
}

function fidGroupsFromSection(section: string[]): Map<number, number> {
  const groups = new Map<number, number>();
  for (const line of section.filter((entry) => entry.startsWith('a=ssrc-group:FID '))) {
    const values = line.slice('a=ssrc-group:FID '.length).trim().split(/\s+/).map(Number);
    const primary = values[0];
    const rtx = values[1];
    if (primary !== undefined && rtx !== undefined && Number.isFinite(primary) && Number.isFinite(rtx)) {
      groups.set(primary, rtx);
    }
  }
  return groups;
}

function primarySsrcsFromSection(section: string[], fidGroups: Map<number, number>): number[] {
  const rtxSsrcs = new Set(fidGroups.values());
  return [
    ...new Set(
      section
        .filter((line) => line.startsWith('a=ssrc:'))
        .map((line) => Number(line.match(/^a=ssrc:(\d+)/)?.[1]))
        .filter((ssrc) => Number.isFinite(ssrc) && !rtxSsrcs.has(ssrc))
    )
  ];
}

function ridInfosFromSection(section: string[]): Array<{ rid: string; paused: boolean; maxBitrate?: number; scaleResolutionDownBy?: number }> {
  return section
    .filter((line) => line.startsWith('a=rid:') && /\ssend(?:\s|$)/.test(line))
    .map((line, index) => {
      const parts = line.slice('a=rid:'.length).trim().split(/\s+/);
      const rid = parts[0] ?? ridAt(section, index) ?? String(index);
      const params = parts.slice(2).join(' ');
      const maxBitrate = Number(params.match(/max-br=(\d+)/)?.[1]);
      return {
        rid,
        paused: line.includes('paused'),
        maxBitrate: Number.isFinite(maxBitrate) ? maxBitrate : undefined,
        scaleResolutionDownBy: rid === 'low' ? 4 : rid === 'medium' || rid === 'mid' ? 2 : 1
      };
    });
}

function ridAt(_section: string[], index: number): string | undefined {
  return ['low', 'medium', 'high'][index];
}

function simulcastAnswerLines(section: string[], direction: 'sendonly' | 'recvonly' | 'inactive'): string[] {
  if (direction !== 'recvonly') {
    return [];
  }
  const rids = ridInfosFromSection(section).map((rid) => rid.rid);
  if (rids.length <= 1) {
    return [];
  }
  return [
    ...rids.map((rid) => `a=rid:${rid} recv`),
    `a=simulcast:recv ${rids.join(';')}`
  ];
}

function candidateLine(candidate: TransportOptions['iceCandidates'][number]): string {
  const base = [
    `a=candidate:${candidate.foundation}`,
    candidate.component,
    candidate.protocol.toUpperCase(),
    candidate.priority,
    candidate.ip,
    candidate.port,
    'typ',
    candidate.type
  ];
  if (candidate.relatedAddress) {
    base.push('raddr', candidate.relatedAddress);
  }
  if (candidate.relatedPort) {
    base.push('rport', candidate.relatedPort);
  }
  if (candidate.tcpType) {
    base.push('tcptype', candidate.tcpType);
  }
  return base.join(' ');
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
