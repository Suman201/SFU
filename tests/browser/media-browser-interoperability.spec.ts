import { test, expect, type Page } from '@playwright/test';
import type { Consumer, Producer, ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
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
  UdpPortAllocator,
  WorkerMediaService
} from '@native-sfu/nest-sfu';
import {
  createNack,
  BandwidthEstimator,
  detectSvcLayer,
  detectTemporalLayer,
  DeterministicPacketLossHarness,
  originalSequenceNumberFromRtx,
  RtcpProcessor,
  RtpRouter,
  RtpPacket,
  serializeRtpHeaderExtensionElements
} from '../../packages/sfu-core/src';

test.describe('browser media interoperability', () => {
  for (const kind of ['audio', 'video', 'screen'] as ProducerKind[]) {
    test(`publisher browser -> SFU -> subscriber browser for ${kind}`, async ({ page, browserName }) => {
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

      const acceptableDtlsStates = browserName === 'firefox' ? ['connecting', 'connected'] : ['connected'];
      expect(acceptableDtlsStates).toContain(stack.dtls.getTransportSnapshot(publisherTransport.id)?.state);
      expect(acceptableDtlsStates).toContain(stack.dtls.getTransportSnapshot(subscriberTransport.id)?.state);

      await page.evaluate(() => {
        (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
        (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
      });
      await stack.media.closeRoom('room-1');
    });
  }

  test('worker mode publisher browser -> worker SFU -> subscriber browser for video', async ({ page }) => {
    test.skip(process.env.MEDIA_WORKER_MODE !== 'worker', 'Set MEDIA_WORKER_MODE=worker to validate worker-mode browser media path.');
    const stack = await createWorkerStack();
    try {
      const publisherTransport = await stack.media.createWebRtcTransport('worker-room-1', 'publisher');
      const publisherOffer = await createPublisherOffer(page, 'video');
      await applyRemoteTransport(stack.media, publisherTransport, 'publisher', publisherOffer);
      const rtpParameters = parseRtpParameters('video', publisherOffer);
      await stack.media.bindProducer(publisherTransport.id, 'publisher', rtpParameters);
      await stack.media.registerProducer({
        id: 'worker-producer-video',
        roomId: 'worker-room-1',
        participantId: 'publisher',
        kind: 'video',
        transportId: publisherTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });

      const subscriberTransport = await stack.media.createWebRtcTransport('worker-room-1', 'subscriber');
      const subscriberOffer = await createSubscriberOffer(page, 'video');
      await applyRemoteTransport(stack.media, subscriberTransport, 'subscriber', subscriberOffer);
      await stack.media.registerConsumer({
        id: 'worker-consumer-video',
        producerId: 'worker-producer-video',
        participantId: 'subscriber',
        roomId: 'worker-room-1',
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

      await expect
        .poll(() => stack.media.workerPoolSnapshot().workers[0]?.rtpPackets ?? 0, { timeout: 5000 })
        .toBeGreaterThan(0);
      const snapshot = stack.media.workerPoolSnapshot();
      expect(snapshot.mode).toBe('worker');
      expect(snapshot.readyWorkers).toBe(1);
    } finally {
      await page.evaluate(() => {
        (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
        (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
      });
      await stack.media.closeRoom('worker-room-1').catch(() => undefined);
      await stack.media.onModuleDestroy();
    }
  });

  test('browser-generated simulcast video offer is parsed into RID layers', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox RID offer parsing is covered by live temporal RTP tests; this synthetic RID route uses Chrome/WebKit RID assumptions.');
    const offer = await createSimulcastPublisherOffer(page);
    const rtpParameters = parseSdpRtpParameters('video', offer);

    expect(offer).toContain('a=simulcast:send');
    expect(rtpParameters.encodings.map((encoding) => encoding.rid)).toEqual(['low', 'medium', 'high']);
    expect(rtpParameters.encodings.map((encoding) => encoding.spatialLayer)).toEqual([0, 1, 2]);
    expect(rtpParameters.simulcast?.rids).toEqual(['low', 'medium', 'high']);

    const router = new RtpRouter({ enablePacing: false, enableAdaptiveLayerSelection: false, enableJoinKeyframeGate: false });
    const events: string[] = [];
    const producer = browserSimulcastProducer(rtpParameters);
    const consumer = browserSimulcastConsumer(producer);
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);
    router.onConsumerLayerEvent((event) => events.push(`${event.type}:${event.currentLayers?.spatialLayer ?? event.targetLayers?.spatialLayer}`));
    const ridId = rtpParameters.headerExtensions?.find((extension) => extension.uri.includes('rtp-stream-id'))?.id;
    expect(ridId).toBeDefined();

    expect(
      await router.route(rawRtpPacket(5555, rtpParameters.codecs[0]!.payloadType, 1, 1000, Buffer.from([0x10, 0x00]), [
        { id: ridId!, data: Buffer.from('high') }
      ]), {
        sourceTransportId: producer.transportId,
        sourceParticipantId: producer.participantId
      })
    ).toBe(1);
    expect(events).toContain('changed:2');
  });

  test('browser simulcast model exposes quality scoring and priority allocation', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox RID offer parsing is covered by live media tests; this quality allocation check uses Chrome/WebKit RID assumptions.');
    const offer = await createSimulcastPublisherOffer(page);
    const rtpParameters = parseSdpRtpParameters('video', offer);
    const estimator = new BandwidthEstimator();
    estimator.observePacket('transport:subscriber-transport', 'outgoing', 75_000, 1000);
    estimator.observePacket('transport:subscriber-transport', 'outgoing', 75_000, 2000);
    const router = new RtpRouter({
      bandwidthEstimator: estimator,
      enablePacing: false,
      enableJoinKeyframeGate: false
    });
    const producer = browserSimulcastProducer(rtpParameters);
    const lowPriority = browserSimulcastConsumer(producer);
    const highPriority = browserSimulcastConsumer(producer);
    lowPriority.id = 'browser-low-priority';
    lowPriority.transportId = 'subscriber-transport';
    lowPriority.priority = 1;
    highPriority.id = 'browser-high-priority';
    highPriority.transportId = 'subscriber-transport';
    highPriority.priority = 8;
    router.addProducer(producer);
    router.addConsumer(lowPriority, async () => undefined);
    router.addConsumer(highPriority, async () => undefined);

    router.setConsumerPriority(highPriority.id, 8);

    const lowQuality = router.consumerQualitySnapshot(lowPriority.id)!;
    const highQuality = router.consumerQualitySnapshot(highPriority.id)!;
    expect(highQuality.allocation.allocatedBitrate).toBeGreaterThan(lowQuality.allocation.allocatedBitrate);
    expect(highQuality.score.score).toBeGreaterThan(0);
    expect(router.roomQualitySnapshot(producer.roomId)?.transports[0]?.consumers).toHaveLength(2);
  });

  test('browser simulcast RTP route honors temporal layer preferences and reports per-layer metrics', async ({ page }) => {
    const offer = await createSimulcastPublisherOffer(page);
    const browserRtp = parseSdpRtpParameters('video', offer);
    const vp8Codec = browserRtp.codecs.find((codec) => /\/vp8$/i.test(codec.mimeType));
    test.skip(!vp8Codec, 'Browser did not negotiate VP8 as the primary synthetic simulcast codec');
    const producerRtp: RtpParameters = {
      ...browserRtp,
      codecs: [vp8Codec!],
      encodings: [
        { rid: 'low', ssrc: 1111, spatialLayer: 0, maxBitrate: 250_000 },
        { rid: 'medium', ssrc: 2222, spatialLayer: 1, maxBitrate: 900_000 },
        { rid: 'high', ssrc: 3333, spatialLayer: 2, maxBitrate: 2_500_000 }
      ]
    };
    const consumerRtp: RtpParameters = {
      ...producerRtp,
      encodings: [{ ssrc: 9000 }],
      simulcast: undefined
    };
    const router = new RtpRouter({
      enablePacing: false,
      enableJoinKeyframeGate: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 47000,
      timestampGenerator: () => 900000
    });
    const producer = browserSimulcastProducer(producerRtp);
    const consumer = browserConsumer('browser-temporal-consumer', producer, consumerRtp);
    consumer.preferredLayers = { spatialLayer: 2, temporalLayer: 0 };
    const delivered: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      delivered.push(packet);
    });

    await router.route(rawRtpPacket(3333, vp8Codec!.payloadType, 10, 1000, vp8TemporalPayload(0, true)));
    await router.route(rawRtpPacket(3333, vp8Codec!.payloadType, 11, 4000, vp8TemporalPayload(2)));
    await router.route(rawRtpPacket(3333, vp8Codec!.payloadType, 12, 7000, vp8TemporalPayload(0)));
    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 2, temporalLayer: 2 });
    await router.route(rawRtpPacket(3333, vp8Codec!.payloadType, 13, 10_000, vp8TemporalPayload(1)));
    await router.route(rawRtpPacket(3333, vp8Codec!.payloadType, 14, 13_000, vp8TemporalPayload(2)));

    expect(delivered.map((packet) => packet.sequenceNumber)).toEqual([47000, 47001, 47002, 47003]);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: 2 });
    expect(router.statistics().consumers[0]?.layers.some((layer) => layer.layer.spatialLayer === 2 && layer.layer.temporalLayer === 0 && layer.packets === 2)).toBe(true);
  });

  test('live browser VP8 simulcast RTP payload descriptors are parsed by the SFU temporal detector', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox VP8 does not consistently emit temporal IDs in Playwright; Firefox live temporal coverage uses VP9.');
    const capture = await captureLiveBrowserTemporalPackets(page, 'video/VP8');

    expect(capture.codec.mimeType).toBe('video/VP8');
    expect(capture.temporalLayers.size).toBeGreaterThan(0);
    expect([...capture.temporalLayers].every((layer) => layer >= 0 && layer <= 3)).toBe(true);
    expect(capture.packets.some((packet) => detectTemporalLayer(packet, capture.codec)?.temporalLayer !== undefined)).toBe(true);
  });

  test('live browser VP9 RTP payload descriptors are parsed when VP9 simulcast is supported', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox VP9 temporal descriptor emission is intermittent in Playwright; Firefox media routing is covered by flow and synthetic temporal tests.');
    test.skip(!(await browserSupportsVideoCodec(page, 'video/VP9')), 'Browser does not advertise VP9 encode support');
    const capture = await captureLiveBrowserTemporalPackets(page, 'video/VP9');

    test.skip(capture.codec.mimeType !== 'video/VP9', 'Browser did not negotiate VP9 for this simulcast sender');
    expect(capture.temporalLayers.size).toBeGreaterThan(0);
    expect([...capture.temporalLayers].every((layer) => layer >= 0 && layer <= 7)).toBe(true);
  });

  test('browser VP9 SVC sender configuration and SFU SVC parser are interoperable when supported', async ({ page, browserName }) => {
    test.skip(!(await browserSupportsVideoCodec(page, 'video/VP9')), `${browserName} does not advertise VP9 encode support`);
    const senderResult = await page.evaluate(async () => {
      const canvas = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
      canvas.width = 320;
      canvas.height = 180;
      const stream = canvas.captureStream?.(30);
      const track = stream?.getVideoTracks()[0];
      if (!track) {
        return { supported: false, reason: 'Canvas capture stream unavailable' };
      }
      const pc = new RTCPeerConnection();
      try {
        const transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          sendEncodings: [{ maxBitrate: 2500000, scalabilityMode: 'L3T3_KEY' } as RTCRtpEncodingParameters & { scalabilityMode: string }]
        });
        const capabilities = RTCRtpSender.getCapabilities('video');
        const vp9 = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/vp9') ?? [];
        const rtx = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/rtx') ?? [];
        if (vp9.length === 0) {
          return { supported: false, reason: 'VP9 codec preference unavailable' };
        }
        transceiver.setCodecPreferences([...vp9, ...rtx]);
        const offer = await pc.createOffer();
        const parameters = transceiver.sender.getParameters();
        return {
          supported: true,
          scalabilityMode: (parameters.encodings?.[0] as RTCRtpEncodingParameters & { scalabilityMode?: string } | undefined)?.scalabilityMode,
          sdp: offer.sdp ?? ''
        };
      } catch (error) {
        return { supported: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        track.stop();
        pc.close();
      }
    });
    test.skip(!senderResult.supported, `${browserName} does not accept VP9 SVC sender configuration: ${senderResult.reason ?? 'unsupported'}`);
    test.skip(senderResult.scalabilityMode !== 'L3T3_KEY', `${browserName} did not preserve requested VP9 scalabilityMode in RTCRtpSender parameters`);

    const rtpParameters = vp9SvcBrowserRtpParameters();
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      enableJoinKeyframeGate: false,
      sequenceNumberGenerator: () => 65000,
      timestampGenerator: () => 1_700_000
    });
    const producer = browserProducer('browser-svc-producer', rtpParameters);
    const consumer = browserConsumer('browser-svc-consumer', producer, { ...rtpParameters, encodings: [{ ssrc: 9000, scalabilityMode: 'L3T3_KEY' }] });
    consumer.preferredSvcLayers = { spatialLayerId: 2, temporalLayerId: 1 };
    const delivered: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      delivered.push(packet);
    });

    const basePayload = vp9SvcPayload(0, 0, true);
    const enhancementPayload = vp9SvcPayload(2, 1);
    expect(detectSvcLayer(new RtpPacket(2, false, false, false, 98, 1, 1000, 7777, [], null, enhancementPayload), rtpParameters.codecs[0]!)?.layer).toEqual({
      spatialLayerId: 2,
      temporalLayerId: 1,
      qualityLayerId: 2
    });
    expect(await router.route(rawRtpPacket(7777, 98, 10, 1000, basePayload))).toBe(1);
    expect(await router.route(rawRtpPacket(7777, 98, 11, 2000, vp9SvcPayload(1, 0)))).toBe(1);
    expect(await router.route(rawRtpPacket(7777, 98, 12, 3000, enhancementPayload))).toBe(1);
    expect(delivered.map((packet) => packet.sequenceNumber)).toEqual([65000, 65001, 65002]);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentSvcLayers).toEqual({ spatialLayerId: 2, temporalLayerId: 1, qualityLayerId: 2 });
    expect(router.statistics().consumers[0]?.svcLayers.length).toBeGreaterThan(0);
  });

  test('subscriber browser keeps decoding across temporal-only simulcast downgrades and upgrades', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox Playwright encoder/stat behavior is intermittent for live temporal churn; Firefox is covered by media flow, RTX, rewrite, and synthetic temporal routing.');
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 52000,
      timestampGenerator: () => 1_200_000
    });
    const stack = createStack(router);
    const publisherTransport = await stack.media.createWebRtcTransport('room-1', 'publisher-temporal');
    const publisherOffer = await createLiveSimulcastPublisherOffer(page, 'video/VP8');
    test.skip(!publisherOffer.supported, 'Browser does not support VP8 simulcast sender setup');
    await applyRemoteTransport(stack.media, publisherTransport, 'publisher-temporal', publisherOffer.sdp);
    const producerRtp = parseSdpRtpParameters('video', publisherOffer.sdp);
    await stack.media.bindProducer(publisherTransport.id, 'publisher-temporal', producerRtp);
    const producer = {
      id: 'producer-live-temporal',
      roomId: 'room-1',
      participantId: 'publisher-temporal',
      kind: 'video' as const,
      transportId: publisherTransport.id,
      rtpParameters: producerRtp,
      status: 'live' as const,
      createdAt: new Date().toISOString()
    };
    await stack.media.registerProducer(producer);

    const subscriberTransport = await stack.media.createWebRtcTransport('room-1', 'subscriber-temporal');
    const subscriberOffer = await createSubscriberOffer(page, 'video');
    await applyRemoteTransport(stack.media, subscriberTransport, 'subscriber-temporal', subscriberOffer);
    const consumer = browserSimulcastConsumer(producer, 'consumer-live-temporal', { spatialLayer: 0, temporalLayer: 2 });
    consumer.transportId = subscriberTransport.id;
    await stack.media.registerConsumer(consumer);
    await setSubscriberAnswer(page, buildUnifiedPlanAnswer({ transport: subscriberTransport, offer: subscriberOffer, direction: 'sendonly', rtpParameters: consumer.rtpParameters }));
    await setPublisherAnswer(page, buildUnifiedPlanAnswer({ transport: publisherTransport, offer: publisherOffer.sdp, direction: 'recvonly', mediaKind: 'video', rtpParameters: producerRtp }));

    const initialFrames = await waitForInboundVideoFrames(page, 1);
    for (const temporalLayer of [0, 2, 0, 1, 2, 0, 2]) {
      await stack.media.setConsumerPreferredLayers(consumer.id, { spatialLayer: 0, temporalLayer });
      await page.waitForTimeout(120);
    }
    const finalFrames = await waitForInboundVideoFrames(page, initialFrames + 2);

    expect(finalFrames).toBeGreaterThan(initialFrames);
    expect(stack.media.consumerLayerState(consumer.id)?.currentLayers?.spatialLayer).toBe(0);
    expect(stack.router.statistics().consumers.find((stats) => stats.consumerId === consumer.id)?.layers.length).toBeGreaterThan(0);

    await page.evaluate(() => {
      (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
      (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc?.close();
    });
    await stack.media.closeRoom('room-1');
  });

  test('browser RTCRtpSender accepts dynacast simulcast encoding activation changes', async ({ page, browserName }) => {
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
      canvas.width = 320;
      canvas.height = 180;
      const stream = canvas.captureStream?.(30);
      const track = stream?.getVideoTracks()[0];
      if (!track) {
        return { supported: false, reason: 'Browser does not expose canvas capture for dynacast sender validation.' };
      }
      const pc = new RTCPeerConnection();
      try {
        const transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          sendEncodings: [
            { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 250000, active: true },
            { rid: 'medium', scaleResolutionDownBy: 2, maxBitrate: 900000, active: true },
            { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 2500000, active: true }
          ]
        });
        const sender = transceiver.sender;
        const parameters = sender.getParameters();
        if (!parameters.encodings || parameters.encodings.length < 3) {
          return { supported: false, reason: 'Browser did not retain simulcast sender encodings.' };
        }
        parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, active: encoding.rid !== 'high' }));
        await sender.setParameters(parameters);
        const afterSuspend = sender.getParameters().encodings?.map((encoding) => ({ rid: encoding.rid, active: encoding.active })) ?? [];
        const resumed = sender.getParameters();
        resumed.encodings = resumed.encodings?.map((encoding) => ({ ...encoding, active: true }));
        await sender.setParameters(resumed);
        const afterResume = sender.getParameters().encodings?.map((encoding) => ({ rid: encoding.rid, active: encoding.active })) ?? [];
        const capped = sender.getParameters();
        capped.encodings = capped.encodings?.map((encoding, index) => ({ ...encoding, active: spatialLayerFromRid(encoding.rid, index) <= 1 }));
        await sender.setParameters(capped);
        const afterLocalCap = sender.getParameters().encodings?.map((encoding) => ({ rid: encoding.rid, active: encoding.active })) ?? [];
        return { supported: true, afterSuspend, afterResume, afterLocalCap };
      } catch (error) {
        return { supported: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        track.stop();
        pc.close();
      }

      function spatialLayerFromRid(rid: string | undefined, fallback: number): number {
        switch (rid) {
          case 'low':
            return 0;
          case 'medium':
            return 1;
          case 'high':
            return 2;
          default:
            return fallback;
        }
      }
    });

    test.skip(!result.supported, `${browserName} does not expose reliable simulcast sender active controls in Playwright: ${result.reason ?? 'unsupported'}`);
    expect(result.afterSuspend?.find((encoding) => encoding.rid === 'high')?.active).toBe(false);
    expect(result.afterResume?.every((encoding) => encoding.active !== false)).toBe(true);
    expect(result.afterLocalCap?.find((encoding) => encoding.rid === 'high')?.active).toBe(false);
    expect(result.afterLocalCap?.find((encoding) => encoding.rid === 'medium')?.active).not.toBe(false);
  });

  test('browser-negotiated RTX repairs deterministic packet loss through NACK', async ({ page }) => {
    const offer = await createPublisherOffer(page, 'video');
    const browserRtp = parseSdpRtpParameters('video', offer);
    const primaryCodec = browserRtp.codecs.find((codec) => !/\/rtx$/i.test(codec.mimeType));
    const rtxCodec = browserRtp.codecs.find((codec) => /\/rtx$/i.test(codec.mimeType));
    expect(primaryCodec).toBeDefined();
    expect(rtxCodec).toBeDefined();
    const producerRtp: RtpParameters = {
      ...browserRtp,
      encodings: [{ rid: 'high', ssrc: 1111, rtx: { ssrc: 1122, payloadType: rtxCodec!.payloadType } }]
    };
    const consumerRtp: RtpParameters = {
      ...browserRtp,
      encodings: [{ rid: 'high', ssrc: 2222, rtx: { ssrc: 2233, payloadType: rtxCodec!.payloadType } }]
    };
    const router = new RtpRouter({
      enablePacing: false,
      enableJoinKeyframeGate: false,
      retransmissionCacheSize: 16,
      sequenceNumberGenerator: () => 45000,
      timestampGenerator: () => 900000
    });
    const producer = browserProducer('browser-loss-producer', producerRtp);
    const consumer = browserConsumer('browser-loss-consumer', producer, consumerRtp);
    const delivered: RtpPacket[] = [];
    const loss = new DeterministicPacketLossHarness({
      lossPercentage: 100,
      dropRetransmissions: false,
      classifyRetransmission: (packet) => packet.ssrc === 2233
    });
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      if (!loss.shouldDrop(packet)) {
        delivered.push(packet);
      }
    });

    await router.route(rawRtpPacket(1111, primaryCodec!.payloadType, 10, 1000, Buffer.from([0x10, 0x00])));
    expect(delivered).toEqual([]);
    await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 2222, lostPacketIds: [45000] }), {
      sourceTransportId: consumer.transportId,
      sourceParticipantId: consumer.participantId
    });

    expect(delivered[0]?.ssrc).toBe(2233);
    expect(delivered[0]?.payloadType).toBe(rtxCodec!.payloadType);
    expect(originalSequenceNumberFromRtx(delivered[0]!)).toBe(45000);
    expect(router.statistics().consumers[0]?.retransmissions.rtxPackets).toBe(1);
  });

  test('subscriber browser receives video with SFU sequence and timestamp rewriting enabled', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox rewrite snapshot timing is intermittent in Playwright; Firefox media flow, RTX, RTCP, synthetic temporal routing, and Dynacast sender control remain covered.');
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
    expect(stack.router.statistics().consumers.find((consumerStats) => consumerStats.consumerId === 'consumer-rewrite')?.primaryRtp.packets).toBeGreaterThan(0);
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

async function createWorkerStack(): Promise<{ media: WorkerMediaService }> {
  const options: NestSfuOptions = {
    turnSecret: 'test-secret',
    turnUris: [],
    mediaWorkerMode: 'worker',
    mediaWorkerCount: 1,
    mediaWorkerRequestTimeoutMs: 5000,
    mediaWorkerStartupTimeoutMs: 10000,
    mediaWorkerHeartbeatIntervalMs: 250,
    mediaWorkerHeartbeatTimeoutMs: 5000,
    mediaWorkerRestartBackoffMs: 50,
    mediaWorkerExecArgv: ['-r', 'ts-node/register'],
    includeLoopbackCandidates: true,
    hostCandidatePortRange: { min: 45000, max: 45999 },
    iceTaMs: 10,
    iceTransactionTimeoutMs: 1000,
    consentIntervalMs: 1000,
    consentTimeoutMs: 1000,
    maxConsentFailures: 2
  };
  const media = new WorkerMediaService(options);
  await media.onModuleInit();
  return { media };
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

function browserSimulcastProducer(rtpParameters: RtpParameters): Producer {
  return {
    id: 'browser-simulcast-producer',
    roomId: 'room-1',
    participantId: 'publisher',
    kind: 'video',
    transportId: 'publisher-transport',
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function browserSimulcastConsumer(producer: Producer, id = 'browser-simulcast-consumer', preferredLayers: Consumer['preferredLayers'] = { spatialLayer: 2 }): Consumer {
  return {
    id,
    roomId: producer.roomId,
    producerId: producer.id,
    participantId: 'subscriber',
    transportId: 'subscriber-transport',
    preferredLayers,
    rtpParameters: {
      ...producer.rtpParameters,
      encodings: [{ ssrc: 9000 }],
      simulcast: undefined
    },
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function browserProducer(id: string, rtpParameters: RtpParameters): Producer {
  return {
    id,
    roomId: 'room-1',
    participantId: 'publisher',
    kind: 'video',
    transportId: 'publisher-transport',
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function browserConsumer(id: string, producer: Producer, rtpParameters: RtpParameters): Consumer {
  return {
    id,
    roomId: producer.roomId,
    producerId: producer.id,
    participantId: 'subscriber',
    transportId: 'subscriber-transport',
    preferredLayers: { spatialLayer: 2 },
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rawRtpPacket(
  ssrc: number,
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  payload: Buffer,
  headerElements: Array<{ id: number; data: Buffer }> = []
): Buffer {
  return new RtpPacket(2, false, headerElements.length > 0, false, payloadType, sequenceNumber, timestamp, ssrc, [], serializeRtpHeaderExtensionElements(headerElements), payload).serialize();
}

function vp8TemporalPayload(temporalLayer: number, keyframe = false): Buffer {
  return Buffer.from([0x90, 0x20, (temporalLayer & 0x03) << 6, keyframe ? 0x00 : 0x01, 0x00]);
}

function vp9SvcPayload(spatialLayer: number, temporalLayer: number, keyframe = false): Buffer {
  return Buffer.from([(keyframe ? 0x2c : 0x6c), ((temporalLayer & 0x07) << 5) | ((spatialLayer & 0x07) << 1) | (spatialLayer > 0 ? 0x01 : 0), 0x00, 0x10]);
}

function vp9SvcBrowserRtpParameters(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP9', payloadType: 98, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' }, rtcpFeedback: ['nack', 'nack pli', 'transport-cc'] }],
    encodings: [{ ssrc: 7777, maxBitrate: 2_700_000, scalabilityMode: 'L3T3_KEY' }],
    rtcp: { cname: 'browser-svc', reducedSize: true }
  };
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
    const sdp = pc.localDescription?.sdp ?? '';
    pc.close();
    return sdp;

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
    const context = canvas.getContext('2d')!;
    let frame = 0;
    setInterval(() => {
      context.fillStyle = '#1f4fbf';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '24px sans-serif';
      context.fillText(`simulcast-${frame++}`, 20, 96);
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

async function captureLiveBrowserTemporalPackets(page: Page, mimeType: 'video/VP8' | 'video/VP9'): Promise<{ codec: RtpParameters['codecs'][number]; packets: RtpPacket[]; temporalLayers: Set<number> }> {
  const router = new RtpRouter({
    enablePacing: false,
    enableAdaptiveLayerSelection: false,
    enableJoinKeyframeGate: false,
    sequenceNumberGenerator: () => 61000,
    timestampGenerator: () => 1_500_000
  });
  const stack = createStack(router);
  const transport = await stack.media.createWebRtcTransport('room-live-capture', `publisher-${mimeType.toLowerCase().replace(/[^a-z0-9]/g, '-')}`);
  const offer = await createLiveSimulcastPublisherOffer(page, mimeType);
  const fallbackCodec = { mimeType, payloadType: 0, clockRate: 90000 };
  try {
    if (!offer.supported) {
      return { codec: fallbackCodec, packets: [], temporalLayers: new Set() };
    }
    await applyRemoteTransport(stack.media, transport, transport.participantId, offer.sdp);
    const rtpParameters = parseSdpRtpParameters('video', offer.sdp);
    const codec = rtpParameters.codecs[0] ?? fallbackCodec;
    if (codec.mimeType.toLowerCase() !== mimeType.toLowerCase()) {
      return { codec, packets: [], temporalLayers: new Set() };
    }
    await stack.media.bindProducer(transport.id, transport.participantId, rtpParameters);
    const producer = browserProducer(`producer-live-${codec.mimeType.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, rtpParameters);
    producer.roomId = 'room-live-capture';
    producer.participantId = transport.participantId;
    producer.transportId = transport.id;
    await stack.media.registerProducer(producer);
    const captureConsumer = browserSimulcastConsumer(producer, `consumer-capture-${codec.mimeType.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, {
      spatialLayer: 2,
      temporalLayer: codec.mimeType === 'video/VP9' ? 7 : 2
    });
    const captured: RtpPacket[] = [];
    router.addConsumer(captureConsumer, async (packet) => {
      captured.push(packet);
    });
    await setPublisherAnswer(page, buildUnifiedPlanAnswer({ transport, offer: offer.sdp, direction: 'recvonly', mediaKind: 'video', rtpParameters }));
    await waitForCondition(() => temporalLayersFromPackets(captured, codec).size > 0, 10_000);
    return { codec, packets: [...captured], temporalLayers: temporalLayersFromPackets(captured, codec) };
  } finally {
    await page.evaluate(() => {
      (window as unknown as { __publisherPc?: RTCPeerConnection }).__publisherPc?.close();
    });
    await stack.media.closeRoom('room-live-capture');
  }
}

async function browserSupportsVideoCodec(page: Page, mimeType: 'video/VP8' | 'video/VP9'): Promise<boolean> {
  return page.evaluate((codecMimeType) => RTCRtpSender.getCapabilities('video')?.codecs.some((codec) => codec.mimeType.toLowerCase() === codecMimeType.toLowerCase()) ?? false, mimeType);
}

function temporalLayersFromPackets(packets: RtpPacket[], codec: Pick<RtpParameters['codecs'][number], 'mimeType'>): Set<number> {
  return new Set(
    packets
      .map((packet) => detectTemporalLayer(packet, codec)?.temporalLayer)
      .filter((layer): layer is number => layer !== undefined)
  );
}

async function waitForInboundVideoFrames(page: Page, minimumFrames: number): Promise<number> {
  const handle = await page.waitForFunction(
    async (frames) => {
      const pc = (window as unknown as { __subscriberPc?: RTCPeerConnection }).__subscriberPc;
      if (!pc) {
        return false;
      }
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        const decodedOrReceived = report.framesDecoded ?? report.packetsReceived ?? 0;
        if (report.type === 'inbound-rtp' && report.kind === 'video' && decodedOrReceived >= frames) {
          return decodedOrReceived;
        }
      }
      return false;
    },
    minimumFrames,
    { timeout: 10_000 }
  );
  return Number(await handle.jsonValue());
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
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

function parseRtpParameters(kind: ProducerKind, sdp: string): RtpParameters {
  return parseSdpRtpParameters(kind, sdp);
}

async function waitForRewriteSnapshot(router: RtpRouter, consumerId: string): Promise<ReturnType<RtpRouter['consumerRewriteSnapshot']>[number]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const snapshot = router.consumerRewriteSnapshot(consumerId)[0];
    if (snapshot) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for rewrite snapshot for ${consumerId}`);
}
