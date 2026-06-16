import { test, expect, type Page } from '@playwright/test';
import type { Consumer, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import {
  buildUnifiedPlanAnswer,
  createPli,
  DtlsService,
  IceService,
  MediaService,
  NestSfuOptions,
  parseSdpCandidates,
  parseSdpDtlsParameters,
  parseSdpIceParameters,
  parseSdpRtpParameters,
  PipeTransportManager,
  PipeTransportService,
  RtcpProcessor,
  SrtpService,
  UdpPortAllocator,
  WorkerMediaService
} from '@native-sfu/nest-sfu';
import { RtpRouter } from '@native-sfu/sfu-core';

test.describe('browser cross-node pipe transport interoperability', () => {
  test('owner-node publisher reaches a remote-node subscriber over UDP pipe transport and returns RTCP upstream', async ({ page, browserName }) => {
    const roomId = 'room-cross-node-pipe';
    const ownerPipeId = 'pipe-owner-udp';
    const remotePipeId = 'pipe-remote-udp';
    const stack = createCrossNodeStack();

    try {
      try {
        await stack.setupUdpPipePair({ roomId, ownerPipeId, remotePipeId });
      } catch (error) {
        test.skip(true, `UDP pipe loopback transport is unavailable in this environment: ${errorMessage(error)}`);
        return;
      }

      const publisherTransport = await stack.owner.media.createWebRtcTransport(roomId, 'publisher');
      const publisherOffer = await createVideoPublisherOffer(page);
      await applyRemoteTransport(stack.owner.media, publisherTransport, 'publisher', publisherOffer);
      const sourceRtp = parseSdpRtpParameters('video', publisherOffer);
      const pipeRtp = remapRtpParameters(sourceRtp, 720_000, 820_000);
      const reversePipeMappings = buildSsrcMappings(pipeRtp, sourceRtp);
      const ownerProducer = videoProducer('producer-cross-node', roomId, 'publisher', publisherTransport.id, sourceRtp);

      await stack.owner.media.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
      await stack.owner.media.registerProducer(ownerProducer);
      stack.pipe.createProducer(ownerPipeId, {
        id: ownerProducer.id,
        participantId: ownerProducer.participantId,
        rtpParameters: pipeRtp
      });
      stack.pipe.createProducer(remotePipeId, {
        id: ownerProducer.id,
        participantId: ownerProducer.participantId,
        rtpParameters: pipeRtp,
        ssrcMappings: reversePipeMappings
      });
      await stack.owner.media.registerPipeConsumer(
        {
          id: 'pipe-consumer-cross-node',
          roomId,
          producerId: ownerProducer.id,
          participantId: 'pipe:node-b',
          transportId: ownerPipeId,
          rtpParameters: pipeRtp,
          status: 'live',
          createdAt: new Date().toISOString()
        },
        ownerPipeId
      );
      await stack.remote.media.registerPipeProducer(videoProducer(ownerProducer.id, roomId, 'publisher', remotePipeId, pipeRtp), remotePipeId);

      const subscriberTransport = await stack.remote.media.createWebRtcTransport(roomId, 'subscriber');
      const subscriberOffer = await createVideoSubscriberOffer(page);
      await applyRemoteTransport(stack.remote.media, subscriberTransport, 'subscriber', subscriberOffer);
      const remoteConsumer: Consumer = {
        id: 'consumer-cross-node',
        producerId: ownerProducer.id,
        participantId: 'subscriber',
        roomId,
        transportId: subscriberTransport.id,
        rtpParameters: pipeRtp,
        status: 'live',
        createdAt: new Date().toISOString()
      };
      await stack.remote.media.registerConsumer(remoteConsumer);

      await setSubscriberAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: subscriberTransport,
          offer: subscriberOffer,
          direction: 'sendonly',
          rtpParameters: pipeRtp
        })
      );
      await setPublisherAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: publisherTransport,
          offer: publisherOffer,
          direction: 'recvonly',
          mediaKind: 'video',
          rtpParameters: sourceRtp
        })
      );

      await waitForInboundPackets(page, 'video', 1);
      await expect.poll(() => stack.pipe.getUdpTransport(ownerPipeId)?.snapshot().sentRtpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(() => stack.pipe.getUdpTransport(remotePipeId)?.snapshot().rtpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

      await stack.remote.media.handleRtcp(
        subscriberTransport.id,
        'subscriber',
        createPli({ senderSsrc: 9900, mediaSsrc: firstMediaSsrc(pipeRtp) })
      );
      await expect.poll(() => stack.rtcpForwarded[stack.rtcpForwarded.length - 1] ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(() => stack.pipe.getUdpTransport(remotePipeId)?.snapshot().sentRtcpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(() => stack.pipe.getUdpTransport(ownerPipeId)?.snapshot().rtcpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

      const acceptableDtlsStates = browserName === 'firefox' ? ['connecting', 'connected'] : ['connected'];
      expect(acceptableDtlsStates).toContain(stack.owner.dtls.getTransportSnapshot(publisherTransport.id)?.state);
      expect(acceptableDtlsStates).toContain(stack.remote.dtls.getTransportSnapshot(subscriberTransport.id)?.state);
      expect(stack.asyncErrors).toEqual([]);
    } finally {
      await closeBrowserPeers(page);
      await stack.dispose(roomId);
    }
  });

  test('remote publisher reaches an owner-node subscriber over UDP pipe transport with worker-mode media services', async ({ page }) => {
    const roomId = 'room-cross-node-pipe-worker';
    const ownerPipeId = 'pipe-owner-worker';
    const remotePipeId = 'pipe-remote-worker';
    const stack = await createWorkerCrossNodeStack();

    try {
      try {
        await stack.setupUdpPipePair({ roomId, ownerPipeId, remotePipeId });
      } catch (error) {
        test.skip(true, `UDP pipe loopback transport is unavailable in this environment: ${errorMessage(error)}`);
        return;
      }

      const publisherTransport = await stack.remote.media.createWebRtcTransport(roomId, 'publisher');
      const publisherOffer = await createVideoPublisherOffer(page);
      await applyRemoteTransport(stack.remote.media, publisherTransport, 'publisher', publisherOffer);
      const sourceRtp = parseSdpRtpParameters('video', publisherOffer);
      const pipeRtp = remapRtpParameters(sourceRtp, 640_000, 740_000);
      const reversePipeMappings = buildSsrcMappings(pipeRtp, sourceRtp);
      const remoteProducer = videoProducer('producer-cross-node-worker', roomId, 'publisher', publisherTransport.id, sourceRtp);

      await stack.remote.media.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
      await stack.remote.media.registerProducer(remoteProducer);
      stack.pipe.createProducer(ownerPipeId, {
        id: remoteProducer.id,
        participantId: remoteProducer.participantId,
        rtpParameters: pipeRtp,
        ssrcMappings: reversePipeMappings
      });
      stack.pipe.createProducer(remotePipeId, {
        id: remoteProducer.id,
        participantId: remoteProducer.participantId,
        rtpParameters: pipeRtp
      });
      await stack.owner.media.registerPipeProducer(videoProducer(remoteProducer.id, roomId, 'publisher', ownerPipeId, pipeRtp), ownerPipeId);
      await stack.remote.media.registerPipeConsumer(
        {
          id: 'pipe-consumer-cross-node-worker',
          roomId,
          producerId: remoteProducer.id,
          participantId: 'pipe:node-a',
          transportId: remotePipeId,
          rtpParameters: pipeRtp,
          status: 'live',
          createdAt: new Date().toISOString()
        },
        remotePipeId
      );

      const subscriberTransport = await stack.owner.media.createWebRtcTransport(roomId, 'subscriber');
      const subscriberOffer = await createVideoSubscriberOffer(page);
      await applyRemoteTransport(stack.owner.media, subscriberTransport, 'subscriber', subscriberOffer);
      await stack.owner.media.registerConsumer({
        id: 'consumer-cross-node-worker',
        producerId: remoteProducer.id,
        participantId: 'subscriber',
        roomId,
        transportId: subscriberTransport.id,
        rtpParameters: pipeRtp,
        status: 'live',
        createdAt: new Date().toISOString()
      });

      await setSubscriberAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: subscriberTransport,
          offer: subscriberOffer,
          direction: 'sendonly',
          rtpParameters: pipeRtp
        })
      );
      await setPublisherAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: publisherTransport,
          offer: publisherOffer,
          direction: 'recvonly',
          mediaKind: 'video',
          rtpParameters: sourceRtp
        })
      );

      await waitForInboundPackets(page, 'video', 1);
      await expect.poll(() => stack.pipe.getUdpTransport(ownerPipeId)?.snapshot().rtpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

      await stack.owner.media.handleRtcp(
        subscriberTransport.id,
        'subscriber',
        createPli({ senderSsrc: 9910, mediaSsrc: firstMediaSsrc(pipeRtp) })
      );
      await expect.poll(() => stack.rtcpForwarded[stack.rtcpForwarded.length - 1] ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(() => stack.pipe.getUdpTransport(remotePipeId)?.snapshot().rtcpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(stack.asyncErrors).toEqual([]);
    } finally {
      await closeBrowserPeers(page);
      await stack.dispose(roomId);
    }
  });
});

function createCrossNodeStack(): {
  owner: InProcessNodeStack;
  remote: InProcessNodeStack;
  pipe: PipeTransportService;
  rtcpForwarded: number[];
  asyncErrors: string[];
  setupUdpPipePair: (options: { roomId: string; ownerPipeId: string; remotePipeId: string }) => Promise<void>;
  dispose: (roomId: string) => Promise<void>;
} {
  const pipe = new PipeTransportService(new PipeTransportManager());
  const owner = createNodeStack({ portRange: { min: 46_000, max: 46_999 } }, pipe);
  const remote = createNodeStack({ portRange: { min: 47_000, max: 47_999 } }, pipe);
  const rtcpForwarded: number[] = [];
  const asyncErrors: string[] = [];
  const unsubscribers: Array<() => void> = [];

  return {
    owner,
    remote,
    pipe,
    rtcpForwarded,
    asyncErrors,
    async setupUdpPipePair({ roomId, ownerPipeId, remotePipeId }): Promise<void> {
      pipe.createUdpTransport({
        id: ownerPipeId,
        roomId,
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        listenPort: 0,
        peerToken: 'phase-11-token',
        authMode: 'token'
      });
      pipe.createUdpTransport({
        id: remotePipeId,
        roomId,
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        listenPort: 0,
        peerToken: 'phase-11-token',
        authMode: 'token'
      });
      const ownerEndpoint = await pipe.listenUdpTransport(ownerPipeId);
      const remoteEndpoint = await pipe.listenUdpTransport(remotePipeId);
      pipe.connectUdpTransport(ownerPipeId, { address: '127.0.0.1', port: remoteEndpoint.port, nodeId: 'node-b' });
      pipe.connectUdpTransport(remotePipeId, { address: '127.0.0.1', port: ownerEndpoint.port, nodeId: 'node-a' });
      unsubscribers.push(
        pipe.onUdpRtp(remotePipeId, (event) => {
          void remote.media.handlePipeRtp(remotePipeId, event.producerId, event.packet).catch((error) => {
            asyncErrors.push(errorMessage(error));
          });
        }),
        pipe.onUdpRtcp(ownerPipeId, (event) => {
          void owner.media
            .handlePipeRtcp(ownerPipeId, event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' })
            .then((result) => {
              rtcpForwarded.push(result.forwarded);
            })
            .catch((error) => {
              asyncErrors.push(errorMessage(error));
            });
        })
      );
    },
    async dispose(roomId: string): Promise<void> {
      while (unsubscribers.length > 0) {
        unsubscribers.pop()?.();
      }
      pipe.closeRoom(roomId);
      await remote.media.closeRoom(roomId).catch(() => undefined);
      await owner.media.closeRoom(roomId).catch(() => undefined);
    }
  };
}

type MediaFacade = MediaService | WorkerMediaService;
type InProcessNodeStack = { media: MediaService; dtls: DtlsService };
type WorkerNodeStack = { media: WorkerMediaService };

function createNodeStack(
  options: { portRange: { min: number; max: number } },
  pipe: PipeTransportService
): { media: MediaService; dtls: DtlsService } {
  const sfuOptions: NestSfuOptions = {
    turnSecret: 'test-secret',
    turnUris: [],
    includeLoopbackCandidates: true,
    hostCandidatePortRange: options.portRange,
    iceTaMs: 10,
    iceTransactionTimeoutMs: 1000,
    consentIntervalMs: 1000,
    consentTimeoutMs: 1000,
    maxConsentFailures: 2
  };
  const ice = new IceService(sfuOptions, new UdpPortAllocator(options.portRange.min, options.portRange.max));
  const dtls = new DtlsService();
  return {
    dtls,
    media: new MediaService(ice, dtls, new SrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }), pipe)
  };
}

async function createWorkerCrossNodeStack(): Promise<{
  owner: WorkerNodeStack;
  remote: WorkerNodeStack;
  pipe: PipeTransportService;
  rtcpForwarded: number[];
  asyncErrors: string[];
  setupUdpPipePair: (options: { roomId: string; ownerPipeId: string; remotePipeId: string }) => Promise<void>;
  dispose: (roomId: string) => Promise<void>;
}> {
  const pipe = new PipeTransportService(new PipeTransportManager());
  const ownerOptions: NestSfuOptions = {
    turnSecret: 'test-secret',
    turnUris: [],
    mediaWorkerMode: 'worker',
    mediaWorkerCount: 1,
    mediaWorkerRequestTimeoutMs: 3000,
    mediaWorkerStartupTimeoutMs: 10000,
    mediaWorkerHeartbeatIntervalMs: 250,
    mediaWorkerHeartbeatTimeoutMs: 2000,
    mediaWorkerRestartBackoffMs: 50,
    mediaWorkerExecArgv: ['-r', 'ts-node/register'],
    includeLoopbackCandidates: true,
    hostCandidatePortRange: { min: 48_000, max: 48_999 },
    iceTaMs: 10,
    iceTransactionTimeoutMs: 1000,
    consentIntervalMs: 1000,
    consentTimeoutMs: 1000,
    maxConsentFailures: 2
  };
  const remoteOptions: NestSfuOptions = {
    ...ownerOptions,
    hostCandidatePortRange: { min: 49_000, max: 49_999 }
  };
  const ownerMedia = new WorkerMediaService(ownerOptions, pipe);
  const remoteMedia = new WorkerMediaService(remoteOptions, pipe);
  await ownerMedia.onModuleInit();
  await remoteMedia.onModuleInit();
  const rtcpForwarded: number[] = [];
  const asyncErrors: string[] = [];
  const unsubscribers: Array<() => void> = [];

  return {
    owner: { media: ownerMedia },
    remote: { media: remoteMedia },
    pipe,
    rtcpForwarded,
    asyncErrors,
    async setupUdpPipePair({ roomId, ownerPipeId, remotePipeId }): Promise<void> {
      pipe.createUdpTransport({
        id: ownerPipeId,
        roomId,
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        listenPort: 0,
        peerToken: 'phase-11-worker-token',
        authMode: 'token'
      });
      pipe.createUdpTransport({
        id: remotePipeId,
        roomId,
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        listenPort: 0,
        peerToken: 'phase-11-worker-token',
        authMode: 'token'
      });
      const ownerEndpoint = await pipe.listenUdpTransport(ownerPipeId);
      const remoteEndpoint = await pipe.listenUdpTransport(remotePipeId);
      pipe.connectUdpTransport(ownerPipeId, { address: '127.0.0.1', port: remoteEndpoint.port, nodeId: 'node-b' });
      pipe.connectUdpTransport(remotePipeId, { address: '127.0.0.1', port: ownerEndpoint.port, nodeId: 'node-a' });
      unsubscribers.push(
        pipe.onUdpRtp(ownerPipeId, (event) => {
          void ownerMedia.handlePipeRtp(ownerPipeId, event.producerId, event.packet).catch((error) => {
            asyncErrors.push(errorMessage(error));
          });
        }),
        pipe.onUdpRtcp(remotePipeId, (event) => {
          void remoteMedia
            .handlePipeRtcp(remotePipeId, event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' })
            .then((result) => {
              rtcpForwarded.push(result.forwarded);
            })
            .catch((error) => {
              asyncErrors.push(errorMessage(error));
            });
        })
      );
    },
    async dispose(roomId: string): Promise<void> {
      while (unsubscribers.length > 0) {
        unsubscribers.pop()?.();
      }
      pipe.closeRoom(roomId);
      await ownerMedia.closeRoom(roomId).catch(() => undefined);
      await remoteMedia.closeRoom(roomId).catch(() => undefined);
      await ownerMedia.onModuleDestroy().catch(() => undefined);
      await remoteMedia.onModuleDestroy().catch(() => undefined);
    }
  };
}

async function createVideoPublisherOffer(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc = pc;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2D context unavailable');
    }
    let frame = 0;
    setInterval(() => {
      context.fillStyle = '#1f4fbf';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '24px sans-serif';
      context.fillText(`pipe-${frame++}`, 24, 96);
    }, 33);
    const stream = canvas.captureStream(30);
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return pc.localDescription?.sdp ?? '';

    async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
      if (peer.iceGatheringState === 'complete') {
        return;
      }
      await new Promise<void>((resolve) => {
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') {
            resolve();
          }
        };
      });
    }
  });
}

async function createVideoSubscriberOffer(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return pc.localDescription?.sdp ?? '';

    async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
      if (peer.iceGatheringState === 'complete') {
        return;
      }
      await new Promise<void>((resolve) => {
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') {
            resolve();
          }
        };
      });
    }
  });
}

async function applyRemoteTransport(
  media: Pick<MediaService, 'setRemoteIceParameters' | 'addRemoteCandidate' | 'setRemoteDtlsParameters'>,
  transport: TransportOptions,
  participantId: string,
  sdp: string
): Promise<void> {
  await media.setRemoteIceParameters(transport.id, participantId, parseSdpIceParameters(sdp));
  for (const candidate of parseSdpCandidates(sdp).filter((item) => item.protocol === 'udp')) {
    await media.addRemoteCandidate(transport.id, participantId, candidate);
  }
  await media.setRemoteDtlsParameters(transport.id, participantId, parseSdpDtlsParameters(sdp));
}

function remapRtpParameters(rtpParameters: RtpParameters, primaryBase: number, rtxBase: number): RtpParameters {
  return {
    ...rtpParameters,
    encodings: rtpParameters.encodings.map((encoding, index) => ({
      ...encoding,
      ssrc: primaryBase + index,
      rtx: encoding.rtx
        ? {
            ...encoding.rtx,
            ssrc: rtxBase + index
          }
        : encoding.rtx
    }))
  };
}

function buildSsrcMappings(source: RtpParameters, target: RtpParameters): Array<{ sourceSsrc: number; targetSsrc: number }> {
  return source.encodings.flatMap((encoding, index) => {
    const mapped = target.encodings[index];
    const pairs: Array<{ sourceSsrc: number; targetSsrc: number }> = [];
    if (mapped) {
      pairs.push({ sourceSsrc: encoding.ssrc, targetSsrc: mapped.ssrc });
      if (encoding.rtx?.ssrc && mapped.rtx?.ssrc) {
        pairs.push({ sourceSsrc: encoding.rtx.ssrc, targetSsrc: mapped.rtx.ssrc });
      }
    }
    return pairs;
  });
}

function firstMediaSsrc(rtpParameters: RtpParameters): number {
  const ssrc = rtpParameters.encodings[0]?.ssrc;
  if (!ssrc) {
    throw new Error('Expected at least one media SSRC for pipe RTP');
  }
  return ssrc;
}

function videoProducer(id: string, roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
  return {
    id,
    roomId,
    participantId,
    kind: 'video',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

async function waitForInboundPackets(page: Page, kind: 'video', minimumPackets: number): Promise<void> {
  await page.waitForFunction(
    async ({ mediaKind, packets }) => {
      const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
      if (!pc) {
        return false;
      }
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        if (report.type === 'inbound-rtp' && report.kind === mediaKind && (report.packetsReceived ?? 0) >= packets) {
          return true;
        }
      }
      return false;
    },
    { mediaKind: kind, packets: minimumPackets },
    { timeout: 10_000 }
  );
}

async function setPublisherAnswer(page: Page, sdp: string): Promise<void> {
  await page.evaluate(async (answer) => {
    const pc = (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc;
    if (!pc) {
      throw new Error('Publisher peer connection missing');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }, sdp);
}

async function setSubscriberAnswer(page: Page, sdp: string): Promise<void> {
  await page.evaluate(async (answer) => {
    const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
    if (!pc) {
      throw new Error('Subscriber peer connection missing');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }, sdp);
}

async function closeBrowserPeers(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
      (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
    })
    .catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
