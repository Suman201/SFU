import { test, expect, type Page } from '@playwright/test';
import type { ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import {
  buildUnifiedPlanAnswer,
  DtlsService,
  IceService,
  MediaService,
  NestSfuOptions,
  parseSdpCandidates,
  parseSdpDtlsParameters,
  parseSdpIceParameters,
  parseSdpRtpParameters,
  SrtpService,
  UdpPortAllocator
} from '@native-sfu/nest-sfu';
import { RtcpProcessor, RtpRouter } from '../../packages/sfu-core/src';

test.describe('browser media interoperability', () => {
  for (const kind of ['audio', 'video', 'screen'] as ProducerKind[]) {
    test(`publisher browser -> SFU -> subscriber browser for ${kind}`, async ({ page }) => {
      const stack = createStack();
      const publisherTransport = await stack.media.createWebRtcTransport('room-1', 'publisher');
      const publisherOffer = await createPublisherOffer(page, kind);
      await applyRemoteTransport(stack.media, publisherTransport, 'publisher', publisherOffer);
      const rtpParameters = parseRtpParameters(kind, publisherOffer);
      await stack.media.bindProducer(publisherTransport.id, 'publisher', rtpParameters);
      await stack.media.registerProducer({
        id: `producer-${kind}`,
        roomId: 'room-1',
        participantId: 'publisher',
        kind,
        transportId: publisherTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });

      const subscriberTransport = await stack.media.createWebRtcTransport('room-1', 'subscriber');
      const subscriberOffer = await createSubscriberOffer(page, kind);
      await applyRemoteTransport(stack.media, subscriberTransport, 'subscriber', subscriberOffer);
      await stack.media.registerConsumer({
        id: `consumer-${kind}`,
        producerId: `producer-${kind}`,
        participantId: 'subscriber',
        roomId: 'room-1',
        transportId: subscriberTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });

      await setSubscriberAnswer(page, buildUnifiedPlanAnswer({ transport: subscriberTransport, offer: subscriberOffer, direction: 'sendonly', rtpParameters }));
      await setPublisherAnswer(page, buildUnifiedPlanAnswer({ transport: publisherTransport, offer: publisherOffer, direction: 'recvonly' }));

      await page.waitForFunction(
        async (mediaKind) => {
          const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
          if (!pc) {
            return false;
          }
          const stats = await pc.getStats();
          for (const report of stats.values()) {
            if (report.type === 'inbound-rtp' && report.kind === (mediaKind === 'audio' ? 'audio' : 'video') && report.packetsReceived > 0) {
              return true;
            }
          }
          return false;
        },
        kind,
        { timeout: 10_000 }
      );

      expect(stack.dtls.getTransportSnapshot(publisherTransport.id)?.state).toBe('connected');
      expect(stack.dtls.getTransportSnapshot(subscriberTransport.id)?.state).toBe('connected');

      await page.evaluate(() => {
        (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
        (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
      });
      await stack.media.closeRoom('room-1');
    });
  }

  test('browser-generated simulcast video offer is parsed into RID layers', async ({ page }) => {
    const offer = await createSimulcastPublisherOffer(page);
    const rtpParameters = parseSdpRtpParameters('video', offer);

    expect(offer).toContain('a=simulcast:send');
    expect(rtpParameters.encodings.map((encoding) => encoding.rid)).toEqual(['low', 'medium', 'high']);
    expect(rtpParameters.encodings.map((encoding) => encoding.spatialLayer)).toEqual([0, 1, 2]);
    expect(rtpParameters.simulcast?.rids).toEqual(['low', 'medium', 'high']);
  });

  test('subscriber browser receives video with SFU sequence and timestamp rewriting enabled', async ({ page }) => {
    const stack = createStack(
      new RtpRouter({
        enableJoinKeyframeGate: false,
        sequenceNumberGenerator: () => 50000,
        timestampGenerator: () => 1_000_000
      })
    );
    const publisherTransport = await stack.media.createWebRtcTransport('room-1', 'publisher');
    const publisherOffer = await createPublisherOffer(page, 'video');
    await applyRemoteTransport(stack.media, publisherTransport, 'publisher', publisherOffer);
    const rtpParameters = parseRtpParameters('video', publisherOffer);
    expect(rtpParameters.headerExtensions?.some((extension) => extension.uri.includes('transport-wide-cc'))).toBe(true);
    await stack.media.bindProducer(publisherTransport.id, 'publisher', rtpParameters);
    await stack.media.registerProducer({
      id: 'producer-rewrite',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    const subscriberTransport = await stack.media.createWebRtcTransport('room-1', 'subscriber');
    const subscriberOffer = await createSubscriberOffer(page, 'video');
    await applyRemoteTransport(stack.media, subscriberTransport, 'subscriber', subscriberOffer);
    await stack.media.registerConsumer({
      id: 'consumer-rewrite',
      producerId: 'producer-rewrite',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    await setSubscriberAnswer(page, buildUnifiedPlanAnswer({ transport: subscriberTransport, offer: subscriberOffer, direction: 'sendonly', rtpParameters }));
    await setPublisherAnswer(page, buildUnifiedPlanAnswer({ transport: publisherTransport, offer: publisherOffer, direction: 'recvonly' }));

    await page.waitForFunction(
      async () => {
        const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
        if (!pc) {
          return false;
        }
        const stats = await pc.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'video' && report.packetsReceived > 0) {
            return true;
          }
        }
        return false;
      },
      undefined,
      { timeout: 10_000 }
    );

    const rewrite = await waitForRewriteSnapshot(stack.router, 'consumer-rewrite');
    expect(rewrite?.targetBaseSequenceNumber).toBe(50000);
    expect(rewrite?.targetBaseTimestamp).toBe(1_000_000);
    expect(stack.router.bandwidthEstimate('consumer-rewrite').estimatedOutgoingBitrate).toBeGreaterThan(0);
    const pacing = stack.router.pacingSnapshots().map((snapshot) => snapshot.id);
    expect(pacing.some((id) => id === 'consumer:consumer-rewrite')).toBe(true);
    expect(pacing.some((id) => id === `transport:${subscriberTransport.id}`)).toBe(true);

    await page.evaluate(() => {
      (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
      (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
    });
    await stack.media.closeRoom('room-1');
  });
});

function createStack(router = new RtpRouter()): { media: MediaService; dtls: DtlsService; router: RtpRouter } {
  const options: NestSfuOptions = {
    turnSecret: 'test-secret',
    turnUris: [],
    includeLoopbackCandidates: true,
    hostCandidatePortRange: { min: 44000, max: 44999 },
    iceTaMs: 10,
    iceTransactionTimeoutMs: 1000,
    consentIntervalMs: 1000,
    consentTimeoutMs: 1000,
    maxConsentFailures: 2
  };
  const ice = new IceService(options, new UdpPortAllocator(options.hostCandidatePortRange!.min, options.hostCandidatePortRange!.max));
  const dtls = new DtlsService();
  const media = new MediaService(ice, dtls, new SrtpService(), new RtcpProcessor(), router);
  return { media, dtls, router };
}

async function createPublisherOffer(page: Page, kind: ProducerKind): Promise<string> {
  return page.evaluate(async (producerKind) => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc = pc;
    const stream = producerKind === 'audio' ? createAudioStream() : createCanvasStream(producerKind);
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

    function createAudioStream(): MediaStream {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    }

    function createCanvasStream(label: string): MediaStream {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      let frame = 0;
      setInterval(() => {
        context.fillStyle = label === 'screen' ? '#116149' : '#1f4fbf';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#ffffff';
        context.font = '24px sans-serif';
        context.fillText(`${label}-${frame++}`, 24, 96);
      }, 33);
      return canvas.captureStream(30);
    }
  }, kind);
}

async function createSubscriberOffer(page: Page, kind: ProducerKind): Promise<string> {
  return page.evaluate(async (producerKind) => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc = pc;
    pc.addTransceiver(producerKind === 'audio' ? 'audio' : 'video', { direction: 'recvonly' });
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
  }, kind);
}

async function createSimulcastPublisherOffer(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1f4fbf';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(30);
    const [track] = stream.getVideoTracks();
    if (!track) {
      throw new Error('Canvas video track missing');
    }
    pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [
        { rid: 'low', maxBitrate: 250000, scaleResolutionDownBy: 4 },
        { rid: 'medium', maxBitrate: 900000, scaleResolutionDownBy: 2 },
        { rid: 'high', maxBitrate: 2500000, scaleResolutionDownBy: 1 }
      ]
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    pc.close();
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

async function applyRemoteTransport(media: MediaService, transport: TransportOptions, participantId: string, sdp: string): Promise<void> {
  await media.setRemoteIceParameters(transport.id, participantId, parseSdpIceParameters(sdp));
  for (const candidate of parseSdpCandidates(sdp)) {
    await media.addRemoteCandidate(transport.id, participantId, candidate);
  }
  await media.setRemoteDtlsParameters(transport.id, participantId, parseSdpDtlsParameters(sdp));
}

function parseRtpParameters(kind: ProducerKind, sdp: string): RtpParameters {
  return parseSdpRtpParameters(kind, sdp);
}

async function waitForRewriteSnapshot(router: RtpRouter, consumerId: string): Promise<ReturnType<RtpRouter['consumerRewriteSnapshot']>[number]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    const snapshot = router.consumerRewriteSnapshot(consumerId)[0];
    if (snapshot) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for rewrite snapshot for ${consumerId}`);
}
