import { Injectable, signal } from '@angular/core';
import type { DtlsParameters, IceParameters, ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { SocketService } from './socket.service';

export interface DeviceOption {
  id: string;
  label: string;
}

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  readonly localStream = signal<MediaStream | null>(null);
  readonly screenStream = signal<MediaStream | null>(null);
  readonly devices = signal<{ audioInputs: DeviceOption[]; videoInputs: DeviceOption[] }>({ audioInputs: [], videoInputs: [] });
  readonly networkScore = signal(5);
  private peer?: RTCPeerConnection;

  constructor(private readonly socket: SocketService) {}

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
    this.peer = new RTCPeerConnection({
      iceServers: transport.iceCandidates.map(() => ({ urls: [] })),
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

  async publish(roomId: string, transport: TransportOptions, kind: ProducerKind, stream: MediaStream): Promise<void> {
    if (!this.peer) {
      await this.preparePeer(roomId);
    }
    for (const track of stream.getTracks()) {
      if ((kind === 'audio' && track.kind !== 'audio') || (kind !== 'audio' && track.kind !== 'video')) {
        continue;
      }
      this.peer?.addTrack(track, stream);
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
    const rtpParameters = createRtpParameters(kind);
    const event = kind === 'screen' ? 'screen:start' : 'producer:create';
    await this.socket.emitAck(event, { roomId, kind, transportId: transport.id, rtpParameters });
  }
}

function createRtpParameters(kind: ProducerKind): RtpParameters {
  const ssrcBase = Math.floor(Math.random() * 0xffffffff);
  return {
    codecs: [
      {
        mimeType: kind === 'audio' ? 'audio/opus' : 'video/VP8',
        payloadType: kind === 'audio' ? 111 : 96,
        clockRate: kind === 'audio' ? 48000 : 90000,
        channels: kind === 'audio' ? 2 : undefined,
        rtcpFeedback: kind === 'audio' ? ['transport-cc'] : ['nack', 'nack pli', 'goog-remb', 'transport-cc']
      }
    ],
    encodings:
      kind === 'audio'
        ? [{ ssrc: ssrcBase }]
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
