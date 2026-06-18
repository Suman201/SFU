import { expect, type Page } from '@playwright/test';
import type { AckResponse, ClientToServerEvents, RoomQualityState, ServerToClientEvents, TransportOptions } from '@native-sfu/contracts';
import { parseSdpCandidates, parseSdpDtlsParameters, parseSdpIceParameters } from '@native-sfu/nest-sfu';
import { io, type Socket } from 'socket.io-client';

export interface AuthTokens {
  accessToken: string;
}

export interface TurnCredentials {
  username: string;
  credential: string;
  ttl: number;
  uris: string[];
}

export interface BrowserIceServer {
  urls: string[];
  username: string;
  credential: string;
}

export interface StagingPublisherOffer {
  sdp: string;
  codecPreferenceApplied: boolean;
}

export interface BrowserPeerDiagnostics {
  connectionState?: RTCPeerConnectionState;
  iceConnectionState?: RTCIceConnectionState;
  gatheredCandidateTypes: string[];
  relayCandidateCount: number;
  selectedPairState?: string;
  selectedLocalCandidateType?: string;
  selectedRemoteCandidateType?: string;
  selectedLocalCandidateProtocol?: string;
  selectedRemoteCandidateProtocol?: string;
  selectedPairCurrentRoundTripTime?: number;
}

type BrowserPeerRole = 'publisher' | 'subscriber';

export type StagingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_SOCKET_TIMEOUT_MS = 15_000;

export async function loginToStaging(baseUrl: string, email: string, password: string): Promise<AuthTokens> {
  const response = await fetch(new URL('/api/v1/auth/login', baseUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) {
    throw new Error(`Login failed for ${email}: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<AuthTokens>;
}

export async function registerInStaging(baseUrl: string, email: string, password: string, displayName: string): Promise<AuthTokens> {
  const response = await fetch(new URL('/api/v1/auth/register', baseUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName })
  });
  if (!response.ok) {
    throw new Error(`Registration failed for ${email}: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<AuthTokens>;
}

export async function fetchTurnCredentials(baseUrl: string, accessToken: string): Promise<TurnCredentials> {
  const response = await fetch(new URL('/api/v1/media/turn-credentials', baseUrl).toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`TURN credentials request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<TurnCredentials>;
}

export function supportedTurnIceServer(credentials: TurnCredentials): BrowserIceServer {
  const urls = (Array.isArray(credentials.uris) ? credentials.uris : []).filter((uri) => isSupportedTurnUri(uri));
  if (urls.length === 0) {
    throw new Error('TURN credentials returned no supported UDP relay URIs');
  }
  return {
    urls,
    username: credentials.username,
    credential: credentials.credential
  };
}

export async function connectStagingSocket(baseUrl: string, accessToken: string, timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS): Promise<StagingSocket> {
  const socket = io(`${baseUrl}/sfu`, {
    transports: ['websocket'],
    auth: { token: accessToken },
    reconnection: false
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Socket connect timeout for ${baseUrl}`)), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return socket;
}

export async function emitAck<T>(socket: StagingSocket, event: keyof ClientToServerEvents, payload: unknown, timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timeout for ${String(event)}`)), timeoutMs);
    (socket as unknown as { emit: (name: string, body: unknown, ack: (response: AckResponse<unknown>) => void) => void }).emit(String(event), payload, (response) => {
      clearTimeout(timer);
      if (response?.ok) {
        resolve(response.data as T);
        return;
      }
      const failure = response as Extract<AckResponse<unknown>, { ok: false }> | undefined;
      reject(new Error(failure?.error?.message ?? `Ack failed for ${String(event)}`));
    });
  });
}

export async function applyRemoteTransportOverSocket(
  socket: StagingSocket,
  transportId: string,
  sdp: string,
  timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS
): Promise<void> {
  await emitAck<void>(
    socket,
    'transport:ice-parameters',
    {
      transportId,
      iceParameters: parseSdpIceParameters(sdp)
    },
    timeoutMs
  );
  for (const candidate of parseSdpCandidates(sdp).filter((item) => item.protocol === 'udp')) {
    await emitAck<void>(
      socket,
      'transport:ice-candidate',
      {
        transportId,
        candidate
      },
      timeoutMs
    );
  }
  await emitAck<void>(
    socket,
    'transport:dtls-parameters',
    {
      transportId,
      dtlsParameters: parseSdpDtlsParameters(sdp)
    },
    timeoutMs
  );
}

export async function createStagingPublisherOffer(
  page: Page,
  iceServer: BrowserIceServer,
  preferredMimeType?: 'video/VP9'
): Promise<StagingPublisherOffer> {
  return page.evaluate(async ({ server, mimeType }) => {
    const globals = window as typeof window & {
      __publisherPc?: RTCPeerConnection;
      __stagingPublisherCandidates?: string[];
      __stagingIntervals?: number[];
    };
    const pc = new RTCPeerConnection({
      iceServers: [server],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    const candidates: string[] = [];
    const intervals = globals.__stagingIntervals ?? [];
    globals.__publisherPc = pc;
    globals.__stagingPublisherCandidates = candidates;
    globals.__stagingIntervals = intervals;
    const canvas = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (!context) {
      pc.close();
      throw new Error('Canvas context unavailable for staging publisher offer');
    }
    const stream = canvas.captureStream?.(30);
    const track = stream?.getVideoTracks()[0];
    if (!track) {
      pc.close();
      throw new Error('Canvas video track unavailable for staging publisher offer');
    }
    let frame = 0;
    const intervalId = window.setInterval(() => {
      context.fillStyle = '#1f4fbf';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '28px sans-serif';
      context.fillText(`staging-ingress-${frame++}`, 28, 180);
    }, 33);
    intervals.push(intervalId);

    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream]
    });
    let codecPreferenceApplied = false;
    if (mimeType && typeof transceiver.setCodecPreferences === 'function') {
      try {
        const capabilities = RTCRtpSender.getCapabilities('video');
        const primary = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === mimeType.toLowerCase()) ?? [];
        const rtx = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/rtx') ?? [];
        if (primary.length > 0) {
          transceiver.setCodecPreferences([...primary, ...rtx]);
          codecPreferenceApplied = true;
        }
      } catch {
        codecPreferenceApplied = false;
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate) {
        candidates.push(event.candidate.candidate);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return {
      sdp: pc.localDescription?.sdp ?? '',
      codecPreferenceApplied
    };

    async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
      if (peer.iceGatheringState === 'complete') {
        return;
      }
      await new Promise<void>((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') {
            resolve();
          }
        });
      });
    }
  }, { server: iceServer, mimeType: preferredMimeType });
}

export async function createStagingSubscriberOffer(page: Page, iceServer: BrowserIceServer): Promise<string> {
  return page.evaluate(async (server) => {
    const globals = window as typeof window & {
      __subscriberPc?: RTCPeerConnection;
      __stagingSubscriberCandidates?: string[];
    };
    const pc = new RTCPeerConnection({
      iceServers: [server],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    const candidates: string[] = [];
    globals.__subscriberPc = pc;
    globals.__stagingSubscriberCandidates = candidates;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate) {
        candidates.push(event.candidate.candidate);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return pc.localDescription?.sdp ?? '';

    async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
      if (peer.iceGatheringState === 'complete') {
        return;
      }
      await new Promise<void>((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') {
            resolve();
          }
        });
      });
    }
  }, iceServer);
}

export async function setPublisherAnswer(page: Page, sdp: string): Promise<void> {
  await setRemoteAnswer(page, 'publisher', sdp);
}

export async function setSubscriberAnswer(page: Page, sdp: string): Promise<void> {
  await setRemoteAnswer(page, 'subscriber', sdp);
}

export async function waitForPeerConnected(page: Page, role: BrowserPeerRole, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    (targetRole) => {
      const globals = window as typeof window & {
        __publisherPc?: RTCPeerConnection;
        __subscriberPc?: RTCPeerConnection;
      };
      const pc = targetRole === 'publisher' ? globals.__publisherPc : globals.__subscriberPc;
      if (!pc) {
        return false;
      }
      return (
        pc.connectionState === 'connected' ||
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      );
    },
    role,
    { timeout: timeoutMs }
  );
}

export async function waitForInboundVideoFrames(page: Page, minimumFrames: number, timeoutMs = 20_000): Promise<number> {
  await expect.poll(async () => inboundVideoMetric(page), { timeout: timeoutMs }).toBeGreaterThanOrEqual(minimumFrames);
  return inboundVideoMetric(page);
}

export async function publisherOutboundVideoStats(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const pc = (window as typeof window & { __publisherPc?: RTCPeerConnection }).__publisherPc;
    if (!pc) {
      return [];
    }
    const stats = await pc.getStats();
    const statsMap = stats as unknown as Map<string, Record<string, unknown>>;
    const results: Array<Record<string, unknown>> = [];
    for (const report of statsMap.values()) {
      if (report.type !== 'outbound-rtp' || report.kind !== 'video') {
        continue;
      }
      results.push({
        id: report.id,
        ssrc: report.ssrc,
        rid: report.rid,
        packetsSent: report.packetsSent,
        bytesSent: report.bytesSent,
        framesEncoded: report.framesEncoded,
        keyFramesEncoded: report.keyFramesEncoded
      });
    }
    return results;
  });
}

export async function readPeerDiagnostics(page: Page, role: BrowserPeerRole): Promise<BrowserPeerDiagnostics> {
  return page.evaluate(async (targetRole) => {
    const globals = window as typeof window & {
      __publisherPc?: RTCPeerConnection;
      __subscriberPc?: RTCPeerConnection;
      __stagingPublisherCandidates?: string[];
      __stagingSubscriberCandidates?: string[];
    };
    const pc = targetRole === 'publisher' ? globals.__publisherPc : globals.__subscriberPc;
    const collected = targetRole === 'publisher' ? globals.__stagingPublisherCandidates ?? [] : globals.__stagingSubscriberCandidates ?? [];
    if (!pc) {
      return {
        gatheredCandidateTypes: [],
        relayCandidateCount: 0
      };
    }
    const stats = await pc.getStats();
    const statsMap = stats as unknown as Map<string, Record<string, unknown>>;
    let selectedPair: Record<string, unknown> | undefined;
    for (const report of statsMap.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPair = statsMap.get(String(report.selectedCandidatePairId));
        break;
      }
    }
    if (!selectedPair) {
      for (const report of statsMap.values()) {
        if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
          selectedPair = report;
          break;
        }
      }
    }
    const localCandidate = selectedPair?.localCandidateId ? statsMap.get(String(selectedPair.localCandidateId)) : undefined;
    const remoteCandidate = selectedPair?.remoteCandidateId ? statsMap.get(String(selectedPair.remoteCandidateId)) : undefined;
    const parsedCandidates = collected
      .map((candidate) => candidate.trim().split(/\s+/))
      .map((parts) => ({
        type: readCandidateField(parts, 'typ') ?? 'host'
      }));
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      gatheredCandidateTypes: [...new Set(parsedCandidates.map((candidate) => candidate.type))],
      relayCandidateCount: parsedCandidates.filter((candidate) => candidate.type === 'relay').length,
      selectedPairState: selectedPair && 'state' in selectedPair ? String(selectedPair.state) : undefined,
      selectedLocalCandidateType: localCandidate && 'candidateType' in localCandidate ? String(localCandidate.candidateType) : undefined,
      selectedRemoteCandidateType: remoteCandidate && 'candidateType' in remoteCandidate ? String(remoteCandidate.candidateType) : undefined,
      selectedLocalCandidateProtocol: localCandidate && 'protocol' in localCandidate ? String(localCandidate.protocol) : undefined,
      selectedRemoteCandidateProtocol: remoteCandidate && 'protocol' in remoteCandidate ? String(remoteCandidate.protocol) : undefined,
      selectedPairCurrentRoundTripTime:
        selectedPair && 'currentRoundTripTime' in selectedPair && typeof selectedPair.currentRoundTripTime === 'number'
          ? selectedPair.currentRoundTripTime
          : undefined
    };

    function readCandidateField(parts: string[], label: string): string | undefined {
      const index = parts.findIndex((part) => part.toLowerCase() === label);
      return index >= 0 ? parts[index + 1]?.toLowerCase() : undefined;
    }
  }, role);
}

export async function closeStagingBrowserPeers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = window as typeof window & {
      __publisherPc?: RTCPeerConnection;
      __subscriberPc?: RTCPeerConnection;
      __stagingIntervals?: number[];
    };
    for (const pc of [globals.__publisherPc, globals.__subscriberPc]) {
      pc?.getSenders().forEach((sender) => sender.track?.stop());
      pc?.getReceivers().forEach((receiver) => receiver.track?.stop());
      pc?.close();
    }
    for (const intervalId of globals.__stagingIntervals ?? []) {
      window.clearInterval(intervalId);
    }
    globals.__publisherPc = undefined;
    globals.__subscriberPc = undefined;
    globals.__stagingIntervals = [];
  });
}

export async function fetchRoomQuality(socket: StagingSocket, roomId: string, timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS): Promise<RoomQualityState> {
  return emitAck<RoomQualityState>(socket, 'room:get-quality', { roomId }, timeoutMs);
}

export async function closeStagingSocket(socket: StagingSocket | undefined): Promise<void> {
  if (!socket) {
    return;
  }
  socket.removeAllListeners();
  socket.disconnect();
}

async function inboundVideoMetric(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const pc = (window as typeof window & { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
    if (!pc) {
      return 0;
    }
    const stats = await pc.getStats();
    const statsMap = stats as unknown as Map<string, Record<string, unknown>>;
    let value = 0;
    for (const report of statsMap.values()) {
      if (report.type !== 'inbound-rtp' || report.kind !== 'video') {
        continue;
      }
      value = Math.max(value, Number(report.framesDecoded ?? report.packetsReceived ?? 0));
    }
    return value;
  });
}

async function setRemoteAnswer(page: Page, role: BrowserPeerRole, sdp: string): Promise<void> {
  await page.evaluate(
    async ({ targetRole, answer }) => {
      const globals = window as typeof window & {
        __publisherPc?: RTCPeerConnection;
        __subscriberPc?: RTCPeerConnection;
      };
      const pc = targetRole === 'publisher' ? globals.__publisherPc : globals.__subscriberPc;
      if (!pc) {
        throw new Error(`${targetRole} peer connection missing`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    },
    { targetRole: role, answer: sdp }
  );
}

function isSupportedTurnUri(uri: string): boolean {
  const normalized = uri.trim().toLowerCase();
  return normalized.startsWith('turn:') && normalized.includes('transport=udp');
}
