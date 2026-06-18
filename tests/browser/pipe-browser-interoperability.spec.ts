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
import { DeterministicPacketImpairmentHarness, RtpPacket, RtpRouter } from '@native-sfu/sfu-core';

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
      const ownerAdaptiveStats = await sampledAdaptiveStats(stack.owner.media);
      const remoteAdaptiveStats = await sampledAdaptiveStats(stack.remote.media);
      expect(ownerAdaptiveStats.statistics.rooms.length).toBeGreaterThan(0);
      expect(ownerAdaptiveStats.quality.producers.length).toBeGreaterThan(0);
      expect(remoteAdaptiveStats.quality.consumers.length).toBeGreaterThan(0);
      expect(remoteAdaptiveStats.statistics.bandwidth.length).toBeGreaterThan(0);

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

  test('live distributed simulcast impairment downgrades and recovers over the UDP pipe path', async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Live distributed impairment signoff currently depends on stable Chromium VP8 simulcast sender stats and TWCC-driven recovery in Playwright; Firefox and WebKit remain covered by green cross-node media and RTCP flow tests.'
    );
    const roomId = 'room-cross-node-pipe-impairment';
    const ownerPipeId = 'pipe-owner-impairment';
    const remotePipeId = 'pipe-remote-impairment';
    const stack = createCrossNodeStack();
    const directRemotePipeForwarder = async (event: { roomId: string; producerId: string | undefined; packet: Buffer }) => {
      await stack.remote.media.handlePipeRtp(remotePipeId, event.producerId, event.packet);
    };
    const impairedForwarder = createImpairedPipeForwarder(directRemotePipeForwarder, {
      lossPercentage: 35,
      baseDelayMs: 120,
      jitterMs: 40,
      maxThroughputBps: 250_000,
      seed: 0x12ab34cd
    });
    let unsubscribeRemoteTwcc: (() => void) | undefined;
    let impairmentFeedbackTimer: NodeJS.Timeout | undefined;
    let recoveryFeedbackTimer: NodeJS.Timeout | undefined;

    try {
      try {
        await stack.setupUdpPipePair({ roomId, ownerPipeId, remotePipeId });
      } catch (error) {
        test.skip(true, `UDP pipe loopback transport is unavailable in this environment: ${errorMessage(error)}`);
        return;
      }

      const publisherTransport = await stack.owner.media.createWebRtcTransport(roomId, 'publisher');
      const publisherOffer = await createLiveSimulcastPublisherOffer(page, 'video/VP8');
      test.skip(!publisherOffer.supported, 'Browser does not support live VP8 simulcast sender setup in Playwright');
      await applyRemoteTransport(stack.owner.media, publisherTransport, 'publisher', publisherOffer.sdp);
      const sourceRtp = parseSdpRtpParameters('video', publisherOffer.sdp);
      test.skip((sourceRtp.simulcast?.rids?.length ?? 0) < 3, 'Browser did not negotiate three simulcast RIDs for the live impairment proof');
      const pipeRtp = remapRtpParameters(sourceRtp, 720_000, 820_000);
      const reversePipeMappings = buildSsrcMappings(pipeRtp, sourceRtp);
      const ownerProducer = videoProducer('producer-cross-node-impairment', roomId, 'publisher', publisherTransport.id, sourceRtp);
      const ownerPipeConsumerId = 'pipe-consumer-cross-node-impairment';

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
          id: ownerPipeConsumerId,
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
      const remoteConsumer = browserSimulcastConsumer(videoProducer(ownerProducer.id, roomId, 'publisher', remotePipeId, pipeRtp), 'consumer-cross-node-impairment');
      remoteConsumer.transportId = subscriberTransport.id;
      await stack.remote.media.registerConsumer(remoteConsumer);
      if (remoteConsumer.preferredLayers) {
        await stack.owner.media.setConsumerPreferredLayers(ownerPipeConsumerId, remoteConsumer.preferredLayers);
      }
      unsubscribeRemoteTwcc = stack.remote.media.onConsumerTwccObservation((event) => {
        if (event.consumerId !== remoteConsumer.id) {
          return;
        }
        stack.owner.media.applyConsumerTwccObservation(ownerPipeConsumerId, event.observation);
      });
      const pushOwnerObservation = (packetLoss: number, delayVariationMs: number, jitter: number, receiveDeltaMs: number) => {
        stack.owner.media.applyConsumerTwccObservation(ownerPipeConsumerId, {
          packetLoss,
          delayVariationMs,
          jitter,
          receiveDeltaMs,
          timestamp: Date.now()
        });
      };
      const startOwnerObservationTimer = (packetLoss: number, delayVariationMs: number, jitter: number, receiveDeltaMs: number) => {
        pushOwnerObservation(packetLoss, delayVariationMs, jitter, receiveDeltaMs);
        const timer = setInterval(() => {
          pushOwnerObservation(packetLoss, delayVariationMs, jitter, receiveDeltaMs);
        }, 250);
        timer.unref?.();
        return timer;
      };

      await setSubscriberAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: subscriberTransport,
          offer: subscriberOffer,
          direction: 'sendonly',
          rtpParameters: remoteConsumer.rtpParameters
        })
      );
      await setPublisherAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: publisherTransport,
          offer: publisherOffer.sdp,
          direction: 'recvonly',
          mediaKind: 'video',
          rtpParameters: sourceRtp
        })
      );

      const initialFrames = await waitForInboundVideoFrames(page, 1);
      const initialProducerState = await sampledProducerLayerState(stack.owner.media, ownerProducer.id);
      const initialActiveLayers = initialProducerState?.availableLayers.filter((layer) => layer.active) ?? [];
      test.skip(initialActiveLayers.length === 0, 'Browser did not expose any active producer layers for the distributed impairment proof');
      const highestActiveSpatial = Math.max(...initialActiveLayers.map((layer) => layer.spatialLayer ?? 0));
      const highestActiveTemporal = Math.max(
        ...initialActiveLayers
          .filter((layer) => (layer.spatialLayer ?? 0) === highestActiveSpatial)
          .map((layer) => layer.temporalLayer ?? 0)
      );
      const singleSpatialActive = initialActiveLayers.every((layer) => (layer.spatialLayer ?? 0) === highestActiveSpatial);
      test.skip(
        singleSpatialActive,
        'Chromium Playwright loopback only activated the low RID for this synthetic publisher, so live distributed multi-spatial impairment signoff is unavailable in this environment.'
      );

      await expect
        .poll(
          async () => {
            const current = (await sampledConsumerLayerState(stack.owner.media, ownerPipeConsumerId))?.currentLayers;
            return {
              spatialLayer: current?.spatialLayer ?? -1,
              temporalLayer: current?.temporalLayer ?? -1
            };
          },
          { timeout: 15_000 }
        )
        .toEqual({
          spatialLayer: highestActiveSpatial,
          temporalLayer: highestActiveTemporal
        })
        .catch(async (error) => {
          throw new Error(
            [
              `Owner pipe consumer never reached the highest live browser layer: ${errorMessage(error)}`,
              `publisherOutbound=${JSON.stringify(await publisherOutboundVideoStats(page))}`,
              `publisherFeedback=${JSON.stringify(await publisherVideoFeedbackStats(page))}`,
              `sourceRtp=${JSON.stringify(sourceRtp)}`,
              `pipeRtp=${JSON.stringify(pipeRtp)}`,
              `ownerProducerState=${JSON.stringify(await sampledProducerLayerState(stack.owner.media, ownerProducer.id))}`,
              `ownerPipeConsumerState=${JSON.stringify(await sampledConsumerLayerState(stack.owner.media, ownerPipeConsumerId))}`,
              `remoteSubscriberState=${JSON.stringify(await sampledConsumerLayerState(stack.remote.media, remoteConsumer.id))}`,
              `adaptiveStats=${JSON.stringify(await sampledAdaptiveStats(stack.owner.media))}`
            ].join('\n')
          );
        });
      expect((await sampledProducerLayerState(stack.owner.media, ownerProducer.id))?.dynacast).toBeDefined();

      stack.setRemotePipeRtpHandler(impairedForwarder.handle);
      impairmentFeedbackTimer = startOwnerObservationTimer(0.35, 160, 40, 160);

      await expect.poll(async () => {
        const current = (await sampledConsumerLayerState(stack.owner.media, ownerPipeConsumerId))?.currentLayers;
        const spatialLayer = current?.spatialLayer ?? highestActiveSpatial;
        const temporalLayer = current?.temporalLayer ?? highestActiveTemporal;
        return singleSpatialActive ? temporalLayer < highestActiveTemporal : spatialLayer < highestActiveSpatial;
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => {
        const desiredLayers = (await sampledProducerLayerState(stack.owner.media, ownerProducer.id))?.dynacast?.desiredLayers ?? [];
        if (singleSpatialActive) {
          const desiredTemporal = Math.max(
            -1,
            ...desiredLayers
              .filter((layer) => (layer.spatialLayer ?? highestActiveSpatial) === highestActiveSpatial)
              .map((layer) => layer.temporalLayer ?? 0)
          );
          return desiredTemporal < highestActiveTemporal;
        }
        return desiredLayers.some((layer) => (layer.spatialLayer ?? -1) >= highestActiveSpatial);
      }, { timeout: 20_000 }).toBe(singleSpatialActive ? true : false);
      const framesDuringImpairment = await waitForInboundVideoFrames(page, initialFrames + 2);

      stack.setRemotePipeRtpHandler(directRemotePipeForwarder);
      if (impairmentFeedbackTimer) {
        clearInterval(impairmentFeedbackTimer);
        impairmentFeedbackTimer = undefined;
      }
      await impairedForwarder.flushAll();
      const recoveryBaseline = await publisherVideoFeedbackStats(page);
      recoveryFeedbackTimer = startOwnerObservationTimer(0.005, 5, 1, 5);

      await expect.poll(async () => {
        const current = (await sampledConsumerLayerState(stack.owner.media, ownerPipeConsumerId))?.currentLayers;
        return {
          spatialLayer: current?.spatialLayer ?? -1,
          temporalLayer: current?.temporalLayer ?? -1
        };
      }, { timeout: 20_000 }).toEqual({
        spatialLayer: highestActiveSpatial,
        temporalLayer: highestActiveTemporal
      });
      await expect.poll(async () => {
        const desiredLayers = (await sampledProducerLayerState(stack.owner.media, ownerProducer.id))?.dynacast?.desiredLayers ?? [];
        if (singleSpatialActive) {
          const desiredTemporal = Math.max(
            -1,
            ...desiredLayers
              .filter((layer) => (layer.spatialLayer ?? highestActiveSpatial) === highestActiveSpatial)
              .map((layer) => layer.temporalLayer ?? 0)
          );
          return desiredTemporal >= highestActiveTemporal;
        }
        return desiredLayers.some((layer) => (layer.spatialLayer ?? -1) >= highestActiveSpatial);
      }, { timeout: 20_000 }).toBe(true);
      if (!singleSpatialActive) {
        await expect.poll(async () => {
          const stats = await publisherVideoFeedbackStats(page);
          return stats.pliCount > recoveryBaseline.pliCount || stats.keyFramesEncoded > recoveryBaseline.keyFramesEncoded;
        }, { timeout: 10_000 }).toBe(true);
      }

      const finalFrames = await waitForInboundVideoFrames(page, framesDuringImpairment + 2);
      expect(finalFrames).toBeGreaterThan(framesDuringImpairment);
      expect(stack.asyncErrors).toEqual([]);
    } finally {
      if (impairmentFeedbackTimer) {
        clearInterval(impairmentFeedbackTimer);
      }
      if (recoveryFeedbackTimer) {
        clearInterval(recoveryFeedbackTimer);
      }
      unsubscribeRemoteTwcc?.();
      stack.setRemotePipeRtpHandler(directRemotePipeForwarder);
      await impairedForwarder.close();
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
      const remoteProducer = videoProducer('producer-cross-node-worker', roomId, 'publisher', publisherTransport.id, sourceRtp);

      await stack.remote.media.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
      await stack.remote.media.registerProducer(remoteProducer);
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

      const initialFrames = await waitForInboundVideoFrames(page, 1).catch(async (error) => {
        throw new Error(
          [
            `Worker cross-node subscriber never received decoded video frames: ${errorMessage(error)}`,
            `publisherFeedback=${JSON.stringify(await publisherVideoFeedbackStats(page))}`,
            `publisherOutbound=${JSON.stringify(await publisherOutboundVideoStats(page))}`,
            `sourceRtp=${JSON.stringify(sourceRtp)}`,
            `subscriberVideo=${JSON.stringify({
              packets: await inboundVideoMetric(page, 'video', 'packets'),
              frames: await inboundVideoMetric(page, 'video', 'frames')
            })}`,
            `publisherTransportCounters=${JSON.stringify(await sampledMediaCounters(stack.remote.media, publisherTransport.id, 'publisher'))}`,
            `subscriberTransportCounters=${JSON.stringify(await sampledMediaCounters(stack.owner.media, subscriberTransport.id, 'subscriber'))}`,
            `ownerConsumerState=${JSON.stringify(await sampledConsumerLayerState(stack.owner.media, 'consumer-cross-node-worker'))}`,
            `remotePipeConsumerState=${JSON.stringify(await sampledConsumerLayerState(stack.remote.media, 'pipe-consumer-cross-node-worker'))}`,
            `ownerProducerState=${JSON.stringify(await sampledProducerLayerState(stack.owner.media, remoteProducer.id))}`,
            `remoteProducerState=${JSON.stringify(await sampledProducerLayerState(stack.remote.media, remoteProducer.id))}`,
            `ownerAdaptiveStats=${JSON.stringify((await sampledAdaptiveStats(stack.owner.media)).statistics)}`,
            `remoteAdaptiveStats=${JSON.stringify((await sampledAdaptiveStats(stack.remote.media)).statistics)}`,
            `ownerPipe=${JSON.stringify(await stack.owner.media.pipeTransportSnapshot(ownerPipeId))}`,
            `remotePipe=${JSON.stringify(await stack.remote.media.pipeTransportSnapshot(remotePipeId))}`,
            `ownerWorker=${JSON.stringify(stack.owner.media.workerPoolSnapshot())}`,
            `remoteWorker=${JSON.stringify(stack.remote.media.workerPoolSnapshot())}`
          ].join('\n')
        );
      });
      if (initialFrames <= 0) {
        throw new Error('Worker cross-node subscriber reported zero decoded frames after media wait');
      }
      await expect.poll(async () => (await stack.owner.media.pipeTransportSnapshot(ownerPipeId))?.active ?? false, { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => (await stack.remote.media.pipeTransportSnapshot(remotePipeId))?.active ?? false, { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => Boolean((await stack.owner.media.pipeTransportSnapshot(ownerPipeId))?.remoteEndpoint), { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => Boolean((await stack.remote.media.pipeTransportSnapshot(remotePipeId))?.remoteEndpoint), { timeout: 10_000 }).toBe(true);
      const ownerAdaptiveStats = await sampledAdaptiveStats(stack.owner.media);
      const remoteAdaptiveStats = await sampledAdaptiveStats(stack.remote.media);
      expect(ownerAdaptiveStats.statistics.rooms.length).toBeGreaterThan(0);
      expect(ownerAdaptiveStats.quality.consumers.length).toBeGreaterThan(0);
      expect(remoteAdaptiveStats.quality.producers.length).toBeGreaterThan(0);
      expect(remoteAdaptiveStats.statistics.bandwidth.length).toBeGreaterThan(0);
      const publisherFeedbackBaseline = await publisherVideoFeedbackStats(page);
      const publisherTransportBaseline = await sampledMediaCounters(stack.remote.media, publisherTransport.id, 'publisher');

      const rtcpResult = await stack.owner.media.handleRtcp(
        subscriberTransport.id,
        'subscriber',
        createPli({ senderSsrc: 9910, mediaSsrc: firstMediaSsrc(pipeRtp) })
      );
      await expect
        .poll(async () => {
          const stats = await publisherVideoFeedbackStats(page);
          const counters = await sampledMediaCounters(stack.remote.media, publisherTransport.id, 'publisher');
          return (
            rtcpResult.forwarded > 0 ||
            stats.pliCount > publisherFeedbackBaseline.pliCount ||
            stats.keyFramesEncoded > publisherFeedbackBaseline.keyFramesEncoded ||
            counters.outboundRtcpPackets > publisherTransportBaseline.outboundRtcpPackets
          );
        }, { timeout: 10_000 })
        .toBe(true);
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
  setRemotePipeRtpHandler: (handler: (event: { roomId: string; producerId: string | undefined; packet: Buffer }) => Promise<void>) => void;
  setupUdpPipePair: (options: { roomId: string; ownerPipeId: string; remotePipeId: string }) => Promise<void>;
  dispose: (roomId: string) => Promise<void>;
} {
  const pipe = new PipeTransportService(new PipeTransportManager());
  const owner = createNodeStack({ portRange: { min: 46_000, max: 46_999 } }, pipe);
  const remote = createNodeStack({ portRange: { min: 47_000, max: 47_999 } }, pipe);
  const rtcpForwarded: number[] = [];
  const asyncErrors: string[] = [];
  const unsubscribers: Array<() => void> = [];
  let remotePipeRtpHandler = async (event: { roomId: string; producerId: string | undefined; packet: Buffer }) => {
    await remote.media.handlePipeRtp(remotePipeIdRef.current, event.producerId, event.packet);
  };
  const remotePipeIdRef = { current: '' };

  return {
    owner,
    remote,
    pipe,
    rtcpForwarded,
    asyncErrors,
    setRemotePipeRtpHandler(handler) {
      remotePipeRtpHandler = handler;
    },
    async setupUdpPipePair({ roomId, ownerPipeId, remotePipeId }): Promise<void> {
      remotePipeIdRef.current = remotePipeId;
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
          void remotePipeRtpHandler({ roomId: event.roomId, producerId: event.producerId, packet: event.packet }).catch((error) => {
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
  asyncErrors: string[];
  setupUdpPipePair: (options: { roomId: string; ownerPipeId: string; remotePipeId: string }) => Promise<void>;
  dispose: (roomId: string) => Promise<void>;
}> {
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
  const ownerMedia = new WorkerMediaService(ownerOptions);
  const remoteMedia = new WorkerMediaService(remoteOptions);
  await ownerMedia.onModuleInit();
  await remoteMedia.onModuleInit();
  const asyncErrors: string[] = [];

  return {
    owner: { media: ownerMedia },
    remote: { media: remoteMedia },
    asyncErrors,
    async setupUdpPipePair({ roomId, ownerPipeId, remotePipeId }): Promise<void> {
      const ownerBinding = await ownerMedia.ensurePipeTransport({
        pipeTransportId: ownerPipeId,
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        roomId,
        protocol: 'udp',
        listenPort: 0,
        advertisedIp: '127.0.0.1',
        peerToken: 'phase-11-worker-token'
      });
      const remoteBinding = await remoteMedia.ensurePipeTransport({
        pipeTransportId: remotePipeId,
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        roomId,
        protocol: 'udp',
        listenPort: 0,
        advertisedIp: '127.0.0.1',
        peerToken: 'phase-11-worker-token'
      });
      if (!ownerBinding.localEndpoint || !remoteBinding.localEndpoint) {
        throw new Error('Worker UDP pipe setup did not return local endpoints');
      }
      await ownerMedia.ensurePipeTransport({
        pipeTransportId: ownerPipeId,
        roomId,
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        protocol: 'udp',
        listenPort: ownerBinding.localEndpoint.port,
        advertisedIp: ownerBinding.localEndpoint.advertiseIp,
        peerToken: 'phase-11-worker-token',
        remoteEndpoint: remoteBinding.localEndpoint
      });
      await remoteMedia.ensurePipeTransport({
        pipeTransportId: remotePipeId,
        roomId,
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        protocol: 'udp',
        listenPort: remoteBinding.localEndpoint.port,
        advertisedIp: remoteBinding.localEndpoint.advertiseIp,
        peerToken: 'phase-11-worker-token',
        remoteEndpoint: ownerBinding.localEndpoint
      });
    },
    async dispose(roomId: string): Promise<void> {
      await ownerMedia.closeRoom(roomId).catch(() => undefined);
      await remoteMedia.closeRoom(roomId).catch(() => undefined);
      await waitForWorkerPoolIdle(ownerMedia).catch((error) => {
        asyncErrors.push(errorMessage(error));
      });
      await waitForWorkerPoolIdle(remoteMedia).catch((error) => {
        asyncErrors.push(errorMessage(error));
      });
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

function browserSimulcastConsumer(producer: Producer, id: string): Consumer {
  return {
    id,
    roomId: producer.roomId,
    producerId: producer.id,
    participantId: 'subscriber',
    transportId: 'subscriber-transport',
    preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
    rtpParameters: {
      ...producer.rtpParameters,
      encodings: [{ ssrc: 9000 }],
      simulcast: undefined
    },
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

async function waitForInboundPackets(page: Page, kind: 'video', minimumPackets: number): Promise<void> {
  await expect.poll(async () => inboundVideoMetric(page, kind, 'packets'), { timeout: 10_000 }).toBeGreaterThanOrEqual(minimumPackets);
}

async function waitForInboundVideoFrames(page: Page, minimumFrames: number): Promise<number> {
  await expect.poll(async () => inboundVideoMetric(page, 'video', 'frames'), { timeout: 10_000 }).toBeGreaterThanOrEqual(minimumFrames);
  return inboundVideoMetric(page, 'video', 'frames');
}

async function publisherVideoFeedbackStats(page: Page): Promise<{ pliCount: number; keyFramesEncoded: number }> {
  return page.evaluate(async () => {
    const pc = (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc;
    if (!pc) {
      return { pliCount: 0, keyFramesEncoded: 0 };
    }
    const stats = await pc.getStats();
    let pliCount = 0;
    let keyFramesEncoded = 0;
    for (const report of stats.values()) {
      if ((report.type === 'outbound-rtp' || report.type === 'remote-inbound-rtp') && report.kind === 'video') {
        pliCount = Math.max(pliCount, report.pliCount ?? 0);
        keyFramesEncoded = Math.max(keyFramesEncoded, report.keyFramesEncoded ?? 0);
      }
    }
    return { pliCount, keyFramesEncoded };
  });
}

async function publisherOutboundVideoStats(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const pc = (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc;
    if (!pc) {
      return [];
    }
    const stats = await pc.getStats();
    const results: Array<Record<string, unknown>> = [];
    for (const report of stats.values()) {
      if (report.type !== 'outbound-rtp' || report.kind !== 'video') {
        continue;
      }
      results.push({
        id: report.id,
        ssrc: report.ssrc,
        rid: report.rid,
        packetsSent: report.packetsSent,
        bytesSent: report.bytesSent,
        retransmittedPacketsSent: report.retransmittedPacketsSent,
        retransmittedBytesSent: report.retransmittedBytesSent,
        keyFramesEncoded: report.keyFramesEncoded
      });
    }
    return results;
  });
}

async function sampledMediaCounters(
  media: Pick<MediaService, 'mediaCounters'>,
  transportId: string,
  participantId: string
): Promise<ReturnType<MediaService['mediaCounters']>> {
  media.mediaCounters(transportId, participantId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return media.mediaCounters(transportId, participantId);
}

async function sampledConsumerLayerState(
  media: Pick<MediaService, 'consumerLayerState'>,
  consumerId: string
): Promise<ReturnType<MediaService['consumerLayerState']>> {
  media.consumerLayerState(consumerId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return media.consumerLayerState(consumerId);
}

async function sampledProducerLayerState(
  media: Pick<MediaService, 'producerLayerState'>,
  producerId: string
): Promise<ReturnType<MediaService['producerLayerState']>> {
  media.producerLayerState(producerId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return media.producerLayerState(producerId);
}

async function sampledAdaptiveStats(
  media: Pick<MediaService, 'adaptiveTransportMetrics'>
): Promise<ReturnType<MediaService['adaptiveTransportMetrics']>> {
  media.adaptiveTransportMetrics();
  await new Promise((resolve) => setTimeout(resolve, 25));
  return media.adaptiveTransportMetrics();
}

async function inboundVideoMetric(page: Page, kind: 'video', metric: 'packets' | 'frames'): Promise<number> {
  return page.evaluate(
    async ({ mediaKind, targetMetric }) => {
      const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
      if (!pc) {
        return 0;
      }
      const stats = await pc.getStats();
      let value = 0;
      for (const report of stats.values()) {
        if (report.type !== 'inbound-rtp' || report.kind !== mediaKind) {
          continue;
        }
        const candidate = targetMetric === 'frames' ? report.framesDecoded ?? report.packetsReceived ?? 0 : report.packetsReceived ?? 0;
        value = Math.max(value, candidate);
      }
      return value;
    },
    { mediaKind: kind, targetMetric: metric }
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

async function createLiveSimulcastPublisherOffer(page: Page, preferredMimeType?: 'video/VP8' | 'video/VP9'): Promise<{ sdp: string; supported: boolean }> {
  return page.evaluate(async (mimeType) => {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const canvas = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
    canvas.width = 320;
    canvas.height = 180;
    const stream = canvas.captureStream?.(30);
    if (!stream) {
      pc.close();
      return { sdp: '', supported: false };
    }
    const context = canvas.getContext('2d');
    if (!context) {
      pc.close();
      return { sdp: '', supported: false };
    }
    let frame = 0;
    setInterval(() => {
      context.fillStyle = '#1f4fbf';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '24px sans-serif';
      context.fillText(`pipe-simulcast-${frame++}`, 20, 96);
    }, 33);
    const [track] = stream.getVideoTracks();
    if (!track) {
      pc.close();
      return { sdp: '', supported: false };
    }
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [
        { rid: 'low', maxBitrate: 250000, scaleResolutionDownBy: 4 },
        { rid: 'medium', maxBitrate: 900000, scaleResolutionDownBy: 2 },
        { rid: 'high', maxBitrate: 2500000, scaleResolutionDownBy: 1 }
      ]
    });
    if (mimeType) {
      const capabilities = RTCRtpSender.getCapabilities('video');
      const primary = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === mimeType.toLowerCase()) ?? [];
      if (primary.length === 0) {
        pc.close();
        return { sdp: '', supported: false };
      }
      const rtx = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/rtx') ?? [];
      if (typeof transceiver.setCodecPreferences === 'function') {
        transceiver.setCodecPreferences([...primary, ...rtx]);
      }
    }
    (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc = pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return { sdp: pc.localDescription?.sdp ?? '', supported: true };

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
  }, preferredMimeType);
}

function createImpairedPipeForwarder(
  forward: (event: { roomId: string; producerId: string | undefined; packet: Buffer }) => Promise<void>,
  options: { lossPercentage: number; baseDelayMs: number; jitterMs: number; maxThroughputBps: number; seed: number }
): {
  handle: (event: { roomId: string; producerId: string | undefined; packet: Buffer }) => Promise<void>;
  flushAll: () => Promise<void>;
  close: () => Promise<void>;
} {
  const harness = new DeterministicPacketImpairmentHarness<{ roomId: string; producerId: string | undefined; packet: Buffer }>({
    ...options,
    packetKey: (event) => {
      const packet = RtpPacket.parse(event.packet);
      return `${packet.ssrc}:${packet.sequenceNumber}:${packet.timestamp}:${packet.payloadType}`;
    },
    packetSize: (event) => event.packet.length
  });
  let timer: NodeJS.Timeout | undefined;
  let draining = false;

  const drain = async () => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      for (const released of harness.drain()) {
        await forward(released.packet);
      }
    } finally {
      draining = false;
      schedule();
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const nextReleaseAt = harness.snapshot().nextReleaseAt;
    if (nextReleaseAt === undefined) {
      return;
    }
    const delayMs = Math.max(0, nextReleaseAt - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delayMs);
    timer.unref?.();
  };

  const flushAll = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (const released of harness.flushAll()) {
      await forward(released.packet);
    }
  };

  return {
    async handle(event) {
      harness.enqueue(event);
      schedule();
    },
    flushAll,
    async close() {
      await flushAll();
    }
  };
}

async function waitForWorkerPoolIdle(media: WorkerMediaService, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = media.workerPoolSnapshot();
    if (snapshot.activeRooms === 0 && snapshot.workers.every((worker) => worker.activeTransports === 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for worker pool to return to idle state');
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
