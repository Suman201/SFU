import { test, expect, type Page } from '@playwright/test';
import type { Consumer, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import {
  buildUnifiedPlanAnswer,
  DtlsService,
  IceService,
  IngestTransportService,
  MediaService,
  NestSfuOptions,
  parseSdpCandidates,
  parseSdpDtlsParameters,
  parseSdpIceParameters,
  RtcpProcessor,
  RtpRouter,
  SrtpService,
  UdpPortAllocator
} from '@native-sfu/nest-sfu';
import { MediaIngestSupervisor } from '../../packages/media-ingest/src/worker/ingest-supervisor';
import {
  createHttpMp4Fixture,
  defaultFfmpegPath,
  defaultFfprobePath,
  ffmpegBinariesAvailable
} from '../../packages/media-ingest/src/testing/http-ingest-fixture';

test.describe('browser ingest interoperability', () => {
  test('chromium subscriber receives a live ingest stream and subscribed transport forwarding resumes across HTTP source restart', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Phase 7 ingest browser proof is currently anchored to Chromium for a truthful local H264 receive path.');
    test.skip(
      !ffmpegBinariesAvailable({ ffmpegPath: defaultFfmpegPath, ffprobePath: defaultFfprobePath }),
      'FFmpeg and FFprobe are required for the real ingest browser validation slice.'
    );
    test.setTimeout(90_000);

    const roomId = 'room-ingest-browser';
    const ingestParticipantId = 'ingest-system';
    const subscriberParticipantId = 'subscriber';
    const fixture = await createHttpMp4Fixture({
      ffmpegPath: defaultFfmpegPath,
      durationSeconds: 8
    });
    const stack = createStack();
    const ingest = new IngestTransportService(stack.media as never);
    const ingestTransport = await ingest.createTransport({
      roomId,
      participantId: ingestParticipantId
    });
    const subscriberTransport = await stack.media.createWebRtcTransport(roomId, subscriberParticipantId);
    const subscriberOffer = await createSubscriberOffer(page);
    const offeredH264 = firstOfferedH264Codec(subscriberOffer);
    test.skip(!offeredH264, 'Browser did not advertise an H264 receive codec for the ingest validation slice.');

    const videoRtpParameters = createVideoIngestRtpParameters(6101, offeredH264.payloadType, offeredH264.parameters, offeredH264.rtcpFeedback);
    await stack.media.bindProducer(ingestTransport.id, ingestParticipantId, videoRtpParameters);
    await stack.media.registerProducer(videoProducer(roomId, ingestParticipantId, ingestTransport.id, videoRtpParameters));
    await applyRemoteTransport(stack.media, subscriberTransport, subscriberParticipantId, subscriberOffer);
    await stack.media.registerConsumer(videoConsumer(roomId, subscriberTransport.id, videoRtpParameters));
    await setSubscriberAnswer(
      page,
      buildUnifiedPlanAnswer({
        transport: subscriberTransport,
        offer: subscriberOffer,
        direction: 'sendonly',
        rtpParameters: videoRtpParameters
      })
    );

    const supervisor = new MediaIngestSupervisor({
      ingestId: 'browser-ingest',
      source: {
        type: 'mp4',
        url: fixture.sourceUrl
      },
      outputs: [
        {
          id: 'video-main',
          kind: 'video',
          codec: 'h264',
          host: ingestTransport.listenAddress,
          rtpPort: ingestTransport.rtpPort,
          rtcpPort: ingestTransport.rtcpPort,
          payloadType: offeredH264.payloadType,
          ssrc: 6101,
          clockRate: 90000,
          bitrateKbps: 1500
        }
      ],
      ffmpegPath: defaultFfmpegPath,
      ffprobePath: defaultFfprobePath,
      probeTimeoutMs: 8_000,
      startupTimeoutMs: 12_000,
      stopTimeoutMs: 3_000,
      restartPolicy: {
        mode: 'on_failure',
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 250
      }
    });

    try {
      await supervisor.start();
      await fixture.waitForRequestCount(2, 8_000);
      await expect.poll(() => ingest.snapshot(ingestTransport.id)?.counters.forwardedRtpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect
        .poll(() => stack.media.mediaCounters(subscriberTransport.id, subscriberParticipantId).outboundRtpPackets, { timeout: 10_000 })
        .toBeGreaterThan(0);

      const initialFrames = await waitForInboundVideoFrames(page, 3, 30_000);
      await supervisor.stop();
      await waitForCondition(() => supervisor.snapshot().state === 'stopped', 10_000, 'Timed out waiting for the ingest runtime to stop.');
      await stack.media.waitForMediaIdle(subscriberTransport.id, subscriberParticipantId, 2_000).catch(() => undefined);
      const forwardedBeforeRestart = ingest.snapshot(ingestTransport.id)?.counters.forwardedRtpPackets ?? 0;
      const outboundBeforeRestart = stack.media.mediaCounters(subscriberTransport.id, subscriberParticipantId).outboundRtpPackets;
      const restartRequestBaseline = fixture.requestCount();
      await supervisor.start();
      await supervisor.waitForState('live', 15_000);
      await fixture.waitForRequestCount(restartRequestBaseline + 1, 8_000);
      await expect.poll(() => ingest.snapshot(ingestTransport.id)?.counters.forwardedRtpPackets ?? 0, { timeout: 10_000 }).toBeGreaterThan(forwardedBeforeRestart);
      await expect
        .poll(() => stack.media.mediaCounters(subscriberTransport.id, subscriberParticipantId).outboundRtpPackets, { timeout: 10_000 })
        .toBeGreaterThan(outboundBeforeRestart);
      expect(initialFrames).toBeGreaterThanOrEqual(3);
      expect(supervisor.snapshot().metrics.liveTransitions).toBeGreaterThanOrEqual(2);
      expect(ingest.snapshot(ingestTransport.id)?.counters.inboundRtpPackets ?? 0).toBeGreaterThan(0);
      expect(ingest.snapshot(ingestTransport.id)?.counters.forwardedRtpPackets ?? 0).toBeGreaterThan(0);
    } finally {
      await supervisor.stop().catch(() => undefined);
      await closeSubscriberPeer(page).catch(() => undefined);
      await stack.media.closeRoom(roomId).catch(() => undefined);
      await fixture.close();
    }
  });
});

function createStack(): { media: MediaService; dtls: DtlsService; router: RtpRouter } {
  const router = new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false });
  const options: NestSfuOptions = {
    turnSecret: 'test-secret',
    turnUris: [],
    includeLoopbackCandidates: true,
    hostCandidatePortRange: { min: 52_000, max: 52_999 },
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

function createVideoIngestRtpParameters(
  ssrc: number,
  payloadType: number,
  parameters: Record<string, string | number | boolean>,
  rtcpFeedback: string[]
): RtpParameters {
  return {
    codecs: [
      {
        mimeType: 'video/H264',
        payloadType,
        clockRate: 90000,
        parameters,
        rtcpFeedback
      }
    ],
    encodings: [{ ssrc }],
    rtcp: { cname: 'ingest-browser', reducedSize: true }
  };
}

function videoProducer(roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
  return {
    id: 'producer-ingest-video',
    roomId,
    participantId,
    kind: 'video',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function videoConsumer(roomId: string, transportId: string, rtpParameters: RtpParameters): Consumer {
  return {
    id: 'consumer-ingest-video',
    roomId,
    producerId: 'producer-ingest-video',
    participantId: 'subscriber',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

async function createSubscriberOffer(page: Page): Promise<string> {
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

async function setSubscriberAnswer(page: Page, sdp: string): Promise<void> {
  await page.evaluate(async (answer) => {
    const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
    if (!pc) {
      throw new Error('Subscriber peer connection missing');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }, sdp);
}

async function closeSubscriberPeer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as unknown as { __subscriberPc?: RTCPeerConnection };
    holder.__subscriberPc?.close();
    holder.__subscriberPc = undefined;
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

async function waitForCondition(predicate: () => boolean, timeoutMs: number, timeoutMessage: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(timeoutMessage);
}

async function waitForInboundVideoFrames(page: Page, minimumFrames: number, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const metric = await page.evaluate(async () => {
      const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
      if (!pc) {
        return 0;
      }
      const stats = await pc.getStats();
      let value = 0;
      for (const report of stats.values()) {
        const candidate = report as RTCStats & { kind?: string; mediaType?: string; framesDecoded?: number; packetsReceived?: number };
        const isVideo = candidate.kind === 'video' || candidate.mediaType === 'video';
        if (candidate.type !== 'inbound-rtp' || !isVideo) {
          continue;
        }
        value = Math.max(value, Number(candidate.framesDecoded ?? candidate.packetsReceived ?? 0));
      }
      return value;
    });
    if (metric >= minimumFrames) {
      return metric;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for inbound video stats to reach the expected state');
}

function firstOfferedH264Codec(
  sdp: string
): {
  payloadType: number;
  parameters: Record<string, string | number | boolean>;
  rtcpFeedback: string[];
} | undefined {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+H264\/90000$/i);
    if (!match) {
      continue;
    }
    const payloadType = Number(match[1]);
    const parameters = parseFmtpParameters(lines.find((entry) => entry.startsWith(`a=fmtp:${payloadType} `)));
    if (Number(parameters['packetization-mode'] ?? 0) !== 1) {
      continue;
    }
    return {
      payloadType,
      parameters,
      rtcpFeedback: lines
        .filter((entry) => entry.startsWith(`a=rtcp-fb:${payloadType} `))
        .map((entry) => entry.split(/\s+/).slice(1).join(' '))
    };
  }
  return undefined;
}

function parseFmtpParameters(line: string | undefined): Record<string, string | number | boolean> {
  if (!line) {
    return {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1
    };
  }
  const parameters: Record<string, string | number | boolean> = {};
  for (const part of line.replace(/^a=fmtp:\d+\s+/, '').split(';')) {
    const [rawKey, rawValue] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }
    if (rawValue === undefined) {
      parameters[rawKey] = true;
      continue;
    }
    const numeric = Number(rawValue);
    parameters[rawKey] = Number.isFinite(numeric) && rawValue.trim() !== '' ? numeric : rawValue;
  }
  return parameters;
}
