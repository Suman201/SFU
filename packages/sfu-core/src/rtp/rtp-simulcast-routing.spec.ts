import type { Consumer, ConsumerLayerEvent, Producer, ProducerDynacastEvent, RtpParameters } from '@native-sfu/contracts';
import type { BandwidthEstimator, BandwidthEstimate } from '../bandwidth/bandwidth-estimator';
import { createReceiverReport } from '../rtcp/rtcp-packet';
import { RTP_HEADER_EXTENSION_URIS, serializeRtpHeaderExtensionElements } from './rtp-header-extension';
import { RtpPacket } from './rtp-packet';
import { RtpRouter } from './rtp-router';

describe('RtpRouter simulcast routing', () => {
  it('learns RID-only browser SSRCs and reports active producer layers', async () => {
    const activeLayers: string[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      onProducerLayerActive: (_producerId, layer) => activeLayers.push(`${layer.rid}:${layer.ssrc}`)
    });
    const producer = createProducer(simulcastProducerRtp(null));
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    expect(
      await router.route(rawPacket(5555, 96, 10, 1000, Buffer.from([0x10, 0x00]), [
        { id: 2, data: Buffer.from('high') }
      ]), {
        sourceTransportId: producer.transportId,
        sourceParticipantId: producer.participantId
      })
    ).toBe(1);

    expect(writes[0]?.ssrc).toBe(9000);
    expect(router.producerLayerSnapshot(producer.id)?.availableLayers.find((layer) => layer.rid === 'high')?.ssrc).toBe(5555);
    expect(activeLayers).toEqual(['high:5555']);
  });

  it('applies setPreferredLayers and forwards only the selected spatial layer', async () => {
    const router = new RtpRouter({ enablePacing: false, enableAdaptiveLayerSelection: false });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 0 });

    expect(await router.route(rawPacket(3333, 96, 1, 1000))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 1, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    expect(router.consumerLayerSnapshot(consumer.id)?.preferredLayers).toEqual({ spatialLayer: 0, temporalLayer: undefined });
    expect(writes.map((packet) => packet.ssrc)).toEqual([9000]);
  });

  it('switches layers only on keyframes while preserving target sequence continuity', async () => {
    const switched: string[] = [];
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 30000,
      timestampGenerator: () => 900000,
      onLayerSwitch: (_consumerId, _producerId, from, to) => switched.push(`${from?.spatialLayer}->${to.spatialLayer}`)
    });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 0 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });
    router.onConsumerLayerEvent((event) => events.push(event));

    expect(await router.route(rawPacket(1111, 96, 10, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 2 });
    expect(await router.route(rawPacket(3333, 96, 1, 50_000, Buffer.from([0x10, 0x01])))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 11, 4000, Buffer.from([0x10, 0x01])))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 2, 53_000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001, 30002]);
    expect(writes.map((packet) => packet.ssrc)).toEqual([9000, 9000, 9000]);
    expect(switched).toEqual(['0->2']);
    expect(events.map((event) => event.type)).toEqual(['changed', 'switching', 'switch-failed', 'changed']);
    expect(events[1]?.targetLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });
    expect(events[2]?.reason).toBe('missing_keyframe');
    const snapshot = router.consumerLayerSnapshot(consumer.id);
    expect(snapshot?.roomId).toBe('room-1');
    expect(snapshot?.participantId).toBe('viewer');
    expect(snapshot?.consumerId).toBe(consumer.id);
    expect(snapshot?.producerId).toBe(producer.id);
    expect(snapshot?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });
    expect(snapshot?.targetLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });
    expect(snapshot?.switchReason).toBe('preferred');
  });

  it('uses bandwidth estimates for automatic downgrade and upgrade', async () => {
    let estimate = bandwidthEstimate(3_000_000);
    const estimator = {
      estimate: () => estimate,
      observePacket: () => estimate,
      snapshot: () => [estimate]
    } as unknown as BandwidthEstimator;
    const router = new RtpRouter({
      enablePacing: false,
      bandwidthEstimator: estimator
    });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(3333, 96, 1, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    estimate = bandwidthEstimate(280_000);
    expect(await router.route(rawPacket(1111, 96, 2, 4000, Buffer.from([0x10, 0x00])))).toBe(1);
    estimate = bandwidthEstimate(3_000_000);
    expect(await router.route(rawPacket(3333, 96, 2, 7000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(writes.length).toBe(3);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });
  });

  it('tracks pipe-backed simulcast quality and dynacast demand from external congestion observations', async () => {
    const router = new RtpRouter({
      enablePacing: false,
      qualityUpdateIntervalMs: 0,
      sequenceNumberGenerator: () => 32000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = {
      ...createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 }, 'pipe-consumer-1', 'pipe:node-b')
    };
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);

    expect(await router.route(rawPacket(3333, 96, 1, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });

    let degraded = router.consumerQualitySnapshot(consumer.id);
    for (let round = 0; round < 6; round += 1) {
      degraded = router.applyExternalConsumerTwccObservation(consumer.id, {
        packetLoss: 0.24,
        delayVariationMs: 130,
        jitter: 95,
        rtt: 180,
        sendDeltaMs: 20,
        receiveDeltaMs: 92,
        timestamp: 2000 + round * 20
      });
    }
    expect(degraded?.score.reasons).toContain('packet_loss');

    expect(await router.route(rawPacket(3333, 96, 2, 4000, Buffer.from([0x10, 0x01])))).toBe(1);
    expect(await router.route(rawPacket(1111, 96, 3, 7000, Buffer.from([0x10, 0x00])))).toBe(1);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 0, temporalLayer: undefined });
    expect(router.producerDynacastSnapshot(producer.id)?.desiredLayers.some((layer) => layer.spatialLayer === 0)).toBe(true);
    expect(router.consumerQualitySnapshot(consumer.id)?.bitrate.recommendedBitrate).toBeLessThan(router.consumerQualitySnapshot(consumer.id)?.bitrate.availableBitrate ?? Infinity);

    let recovered = router.consumerQualitySnapshot(consumer.id);
    for (let round = 0; round < 8; round += 1) {
      recovered = router.applyExternalConsumerTwccObservation(consumer.id, {
        packetLoss: 0,
        delayVariationMs: 4,
        jitter: 2,
        rtt: 24,
        sendDeltaMs: 20,
        receiveDeltaMs: 16,
        timestamp: 3000 + round * 20
      });
    }
    expect(recovered?.score.reasons).not.toContain('packet_loss');
    expect(router.producerDynacastSnapshot(producer.id)?.desiredLayers.some((layer) => layer.spatialLayer === 2)).toBe(true);
  });

  it('combines Dynacast allocation with consumer priority and upgrade hysteresis', async () => {
    let now = 1000;
    let estimate = bandwidthEstimate(1_000_000);
    const estimator = {
      estimate: () => estimate,
      observePacket: () => estimate,
      snapshot: () => [estimate]
    } as unknown as BandwidthEstimator;
    const router = new RtpRouter({
      enablePacing: false,
      bandwidthEstimator: estimator,
      dynacastUpgradeHoldMs: 500,
      now: () => now,
      sequenceNumberGenerator: () => 36000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer(simulcastProducerRtp());
    const normalConsumer = { ...createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 }, 'consumer-normal', 'viewer-normal'), priority: 1 };
    const priorityConsumer = { ...createConsumer(producer, singleConsumerRtp(9001), { spatialLayer: 2 }, 'consumer-priority', 'viewer-priority'), priority: 10 };
    const normalWrites: RtpPacket[] = [];
    const priorityWrites: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(normalConsumer, async (packet) => {
      normalWrites.push(packet);
    });
    router.addConsumer(priorityConsumer, async (packet) => {
      priorityWrites.push(packet);
    });

    expect(await router.route(rawPacket(2222, 96, 1, 1000, Buffer.from([0x10, 0x00])))).toBe(2);
    now = 1600;
    expect(await router.route(rawPacket(3333, 96, 2, 4000, Buffer.from([0x10, 0x00])))).toBe(1);
    expect(priorityWrites.length).toBe(2);
    expect(normalWrites.length).toBe(1);
    expect(router.consumerLayerSnapshot(priorityConsumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: undefined });
    expect(router.consumerLayerSnapshot(normalConsumer.id)?.currentLayers).toEqual({ spatialLayer: 1, temporalLayer: undefined });

    estimate = bandwidthEstimate(50_000);
    now = 1800;
    expect(await router.route(rawPacket(1111, 96, 3, 7000, Buffer.from([0x10, 0x00])))).toBe(2);
    estimate = bandwidthEstimate(3_000_000);
    now = 2000;
    expect(await router.route(rawPacket(3333, 96, 3, 10_000, Buffer.from([0x10, 0x00])))).toBe(0);
    now = 2400;
    expect(await router.route(rawPacket(3333, 96, 4, 13_000, Buffer.from([0x10, 0x00])))).toBe(2);
  });

  it('filters temporal layers, switches temporal targets without a keyframe, and keeps outbound sequence continuity', async () => {
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 30000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2, temporalLayer: 0 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });
    router.onConsumerLayerEvent((event) => events.push(event));

    expect(await router.route(rawPacket(3333, 96, 10, 1000, vp8Payload(0, true)))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 11, 4000, vp8Payload(2)))).toBe(0);
    expect(await router.route(rawPacket(3333, 96, 12, 7000, vp8Payload(0)))).toBe(1);
    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 2, temporalLayer: 2 });
    expect(await router.route(rawPacket(3333, 96, 13, 10_000, vp8Payload(1)))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 14, 13_000, vp8Payload(2)))).toBe(1);
    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 2, temporalLayer: 0 });
    expect(await router.route(rawPacket(3333, 96, 15, 16_000, vp8Payload(2)))).toBe(0);
    expect(await router.route(rawPacket(3333, 96, 16, 19_000, vp8Payload(0)))).toBe(1);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001, 30002, 30003, 30004]);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: 0 });
    expect(events.filter((event) => event.type === 'changed').map((event) => event.currentLayers)).toEqual([
      { spatialLayer: 2, temporalLayer: 0 },
      { spatialLayer: 2, temporalLayer: 2 },
      { spatialLayer: 2, temporalLayer: 0 }
    ]);

    await router.routeRtcp(
      createReceiverReport({
        reporterSsrc: 7777,
        reports: [
          {
            ssrc: 9000,
            fractionLost: 0.25,
            packetsLost: 3,
            highestSequence: 30004,
            jitter: 20,
            lastSenderReport: 0,
            delaySinceLastSenderReport: 65536
          }
        ]
      }),
      { sourceTransportId: consumer.transportId, sourceParticipantId: consumer.participantId }
    );
    const stats = router.statistics();
    const layer = stats.consumers[0]?.layers.find((metric) => metric.layer.spatialLayer === 2 && metric.layer.temporalLayer === 0);
    expect(layer?.packets).toBe(3);
    expect(layer?.packetsLost).toBe(3);
    expect(layer?.fractionLost).toBeCloseTo(0.25);
    expect(layer?.jitter).toBe(20);
    expect(layer?.rtt).toBe(1000);
    expect(layer?.score.degradationReason).toBe('packet_loss');

    await router.routeRtcp(
      createReceiverReport({
        reporterSsrc: 7777,
        reports: [
          {
            ssrc: 9000,
            fractionLost: 0,
            packetsLost: 3,
            highestSequence: 30004,
            jitter: 0,
            lastSenderReport: 0,
            delaySinceLastSenderReport: 6554
          }
        ]
      }),
      { sourceTransportId: consumer.transportId, sourceParticipantId: consumer.participantId }
    );
    const recoveredLayer = router.statistics().consumers[0]?.layers.find((metric) => metric.layer.spatialLayer === 2 && metric.layer.temporalLayer === 0);
    expect(recoveredLayer?.score.degradationReason).toBeUndefined();
    expect(recoveredLayer?.score.recoveryReason).toBe('stable');
  });

  it('routes different temporal preferences for multiple consumers of the same simulcast stream', async () => {
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 40000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer(simulcastProducerRtp());
    const lowConsumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2, temporalLayer: 0 }, 'consumer-low', 'viewer-low');
    const highConsumer = createConsumer(producer, singleConsumerRtp(9001), { spatialLayer: 2, temporalLayer: 2 }, 'consumer-high', 'viewer-high');
    const lowWrites: RtpPacket[] = [];
    const highWrites: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(lowConsumer, async (packet) => {
      lowWrites.push(packet);
    });
    router.addConsumer(highConsumer, async (packet) => {
      highWrites.push(packet);
    });

    expect(await router.route(rawPacket(3333, 96, 10, 1000, vp8Payload(0, true)))).toBe(2);
    expect(await router.route(rawPacket(3333, 96, 11, 4000, vp8Payload(1)))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 12, 7000, vp8Payload(2)))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 13, 10_000, vp8Payload(0)))).toBe(2);

    expect(lowWrites.map((packet) => packet.sequenceNumber)).toEqual([40000, 40001]);
    expect(highWrites.map((packet) => packet.sequenceNumber)).toEqual([40000, 40001, 40002, 40003]);
    expect(router.consumerLayerSnapshot(lowConsumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: 0 });
    expect(router.consumerLayerSnapshot(highConsumer.id)?.currentLayers).toEqual({ spatialLayer: 2, temporalLayer: 2 });
  });

  it('emits dynacast demand events and preserves RTP continuity across layer suspend and resume', async () => {
    const dynacastEvents: ProducerDynacastEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 61000,
      timestampGenerator: () => 1_000_000
    });
    const producer = createProducer(simulcastProducerRtp());
    const lowConsumer = createConsumer(producer, singleConsumerRtp(9100), { spatialLayer: 0 }, 'consumer-low', 'viewer-low');
    const highConsumer = createConsumer(producer, singleConsumerRtp(9200), { spatialLayer: 2 }, 'consumer-high', 'viewer-high');
    const writes = new Map<string, RtpPacket[]>([
      [lowConsumer.id, []],
      [highConsumer.id, []]
    ]);
    router.onProducerDynacastEvent((event) => dynacastEvents.push(event));
    router.addProducer(producer);
    router.addConsumer(lowConsumer, async (packet, target) => {
      writes.get(target.id)?.push(packet);
    });
    router.addConsumer(highConsumer, async (packet, target) => {
      writes.get(target.id)?.push(packet);
    });

    expect(router.producerDynacastSnapshot(producer.id)?.desiredLayers).toEqual([
      { spatialLayer: 0, temporalLayer: undefined },
      { spatialLayer: 2, temporalLayer: undefined }
    ]);
    expect(router.producerDynacastSnapshot(producer.id)?.suspendedLayers).toEqual([{ spatialLayer: 1, temporalLayer: undefined }]);

    expect(await router.route(rawPacket(3333, 96, 10, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    router.setConsumerPaused(highConsumer.id, true);
    expect(router.producerDynacastSnapshot(producer.id)?.desiredLayers).toEqual([{ spatialLayer: 0, temporalLayer: undefined }]);
    expect(await router.route(rawPacket(3333, 96, 11, 4000, Buffer.from([0x10, 0x00])))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 12, 7000, Buffer.from([0x10, 0x00])))).toBe(1);

    router.setConsumerPaused(highConsumer.id, false);
    expect(await router.route(rawPacket(3333, 96, 12, 10_000, Buffer.from([0x10, 0x01])))).toBe(0);
    expect(await router.route(rawPacket(3333, 96, 13, 13_000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(writes.get(highConsumer.id)!.map((packet) => packet.sequenceNumber)).toEqual([61000, 61001]);
    expect(dynacastEvents.some((event) => event.type === 'layers-needed' && event.neededLayers.some((layer) => layer.spatialLayer === 2))).toBe(true);
    expect(dynacastEvents.some((event) => event.type === 'layers-unneeded' && event.unneededLayers.some((layer) => layer.spatialLayer === 2))).toBe(true);
    expect(dynacastEvents.at(-1)?.state.layerResumeCount).toBeGreaterThanOrEqual(3);
  });

  it('stress routes simulcast across multiple publishers, subscribers, rapid preferences, joins, leaves, and metrics', async () => {
    let sequenceBase = 50000;
    let timestampBase = 1_000_000;
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      enableJoinKeyframeGate: false,
      sequenceNumberGenerator: () => {
        const value = sequenceBase;
        sequenceBase += 1000;
        return value;
      },
      timestampGenerator: () => {
        const value = timestampBase;
        timestampBase += 90_000;
        return value;
      }
    });
    const producerA = createProducer(simulcastProducerRtp(), 'producer-a', 'publisher-a');
    const producerB = createProducer(simulcastProducerRtp(4111), 'producer-b', 'publisher-b');
    producerB.rtpParameters.encodings[1]!.ssrc = 4222;
    producerB.rtpParameters.encodings[2]!.ssrc = 4333;
    const lowA = createConsumer(producerA, singleConsumerRtp(9100), { spatialLayer: 2, temporalLayer: 0 }, 'consumer-low-a', 'viewer-low-a');
    const highA = createConsumer(producerA, singleConsumerRtp(9200), { spatialLayer: 2, temporalLayer: 2 }, 'consumer-high-a', 'viewer-high-a');
    const mediumB = createConsumer(producerB, singleConsumerRtp(9300), { spatialLayer: 1, temporalLayer: 1 }, 'consumer-medium-b', 'viewer-medium-b');
    const writes = new Map<string, RtpPacket[]>([
      [lowA.id, []],
      [highA.id, []],
      [mediumB.id, []]
    ]);
    router.onConsumerLayerEvent((event) => events.push(event));
    router.addProducer(producerA);
    router.addProducer(producerB);
    for (const consumer of [lowA, highA, mediumB]) {
      router.addConsumer(consumer, async (packet, target) => {
        writes.get(target.id)?.push(packet);
      });
    }

    expect(await router.route(rawPacket(3333, 96, 10, 1000, vp8Payload(0, true)))).toBe(2);
    expect(await router.route(rawPacket(3333, 96, 11, 4000, vp8Payload(1)))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 12, 7000, vp8Payload(2)))).toBe(1);
    expect(await router.route(rawPacket(4222, 96, 20, 1000, vp8Payload(0, true)))).toBe(1);
    expect(await router.route(rawPacket(4222, 96, 21, 4000, vp8Payload(1)))).toBe(1);
    expect(await router.route(rawPacket(4333, 96, 22, 7000, vp8Payload(0, true)))).toBe(0);

    for (const [index, temporalLayer] of [0, 2, 0, 2, 1, 2].entries()) {
      router.setConsumerPreferredLayers(highA.id, { spatialLayer: 2, temporalLayer });
      await router.route(rawPacket(3333, 96, 13 + index, 10_000 + index * 3000, vp8Payload(temporalLayer)));
    }
    const joinedA = createConsumer(producerA, singleConsumerRtp(9400), { spatialLayer: 2, temporalLayer: 0 }, 'consumer-joined-a', 'viewer-joined-a');
    writes.set(joinedA.id, []);
    router.addConsumer(joinedA, async (packet, target) => {
      writes.get(target.id)?.push(packet);
    });
    expect(await router.route(rawPacket(3333, 96, 19, 50_000, vp8Payload(0, true)))).toBe(3);
    const lowBeforeLeave = writes.get(lowA.id)!.length;
    router.removeConsumer(lowA.id);
    expect(await router.route(rawPacket(3333, 96, 20, 53_000, vp8Payload(0)))).toBe(2);

    expect(writes.get(lowA.id)!.length).toBe(lowBeforeLeave);
    expect(writes.get(highA.id)!.length).toBeGreaterThan(writes.get(lowA.id)!.length);
    expect(writes.get(mediumB.id)!.length).toBe(2);
    expect(writes.get(joinedA.id)!.length).toBe(2);
    const highSequences = writes.get(highA.id)!.map((packet) => packet.sequenceNumber);
    expect(highSequences).toEqual([...highSequences].sort((left, right) => left - right));
    expect(events.some((event) => event.type === 'changed' && event.consumerId === highA.id && event.currentLayers?.temporalLayer === 1)).toBe(true);
    expect(events.some((event) => event.type === 'changed' && event.consumerId === joinedA.id)).toBe(true);

    const stats = router.statistics();
    expect(stats.producers.length).toBe(2);
    expect(stats.consumers.find((consumerStats) => consumerStats.consumerId === highA.id)?.layers.length).toBeGreaterThanOrEqual(3);
    expect(stats.consumers.find((consumerStats) => consumerStats.consumerId === joinedA.id)?.layers[0]?.score.recoveryReason).toBe('stable');
  });

  it('emits an unavailable event when the requested layer is not known', async () => {
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({ enablePacing: false, enableAdaptiveLayerSelection: false });
    const producer = createProducer({
      ...simulcastProducerRtp(),
      encodings: [{ rid: 'low', ssrc: 1111, spatialLayer: 0, maxBitrate: 250_000 }]
    });
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 });
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);
    router.onConsumerLayerEvent((event) => events.push(event));

    expect(await router.route(rawPacket(1111, 96, 10, 1000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(events.some((event) => event.type === 'unavailable' && event.targetLayers?.spatialLayer === 2)).toBe(true);
  });

  it('re-evaluates a stale higher simulcast layer without BWE instead of freezing on a dead target', async () => {
    let now = 1000;
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      activeLayerTimeoutMs: 50,
      now: () => now,
      sequenceNumberGenerator: () => 70000,
      timestampGenerator: () => 1_200_000
    });
    const producer = createProducer(simulcastProducerRtp());
    const consumer = createConsumer(producer, singleConsumerRtp(9000), { spatialLayer: 2 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });
    router.onConsumerLayerEvent((event) => events.push(event));

    expect(await router.route(rawPacket(3333, 96, 10, 1000, Buffer.from([0x10, 0x00])))).toBe(1);

    now = 1100;
    expect(await router.route(rawPacket(1111, 96, 11, 4000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(writes.length).toBe(2);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentLayers).toEqual({ spatialLayer: 0, temporalLayer: undefined });
    expect(events.some((event) => event.type === 'changed' && event.currentLayers?.spatialLayer === 0)).toBe(true);
  });
});

function createProducer(rtp: RtpParameters, id = 'producer-1', participantId = 'publisher'): Producer {
  return {
    id,
    participantId,
    roomId: 'room-1',
    kind: 'video',
    transportId: 'transport-pub',
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function createConsumer(
  producer: Producer,
  rtp: RtpParameters,
  preferredLayers: Consumer['preferredLayers'] = { spatialLayer: 2 },
  id = 'consumer-1',
  participantId = 'viewer'
): Consumer {
  return {
    id,
    producerId: producer.id,
    participantId,
    roomId: producer.roomId,
    transportId: 'transport-sub',
    preferredLayer: 'high',
    preferredLayers,
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function vp8Payload(temporalLayer: number, keyframe = false): Buffer {
  return Buffer.from([0x90, 0x20, (temporalLayer & 0x03) << 6, keyframe ? 0x00 : 0x01, 0x00]);
}

function simulcastProducerRtp(firstSsrc: number | null = 1111): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    headerExtensions: [{ id: 2, uri: RTP_HEADER_EXTENSION_URIS.rid }],
    encodings: [
      { rid: 'low', ssrc: firstSsrc ?? undefined, spatialLayer: 0, maxBitrate: 250_000 },
      { rid: 'medium', ssrc: firstSsrc === null ? undefined : 2222, spatialLayer: 1, maxBitrate: 900_000 },
      { rid: 'high', ssrc: firstSsrc === null ? undefined : 3333, spatialLayer: 2, maxBitrate: 2_500_000 }
    ],
    simulcast: { direction: 'send', rids: ['low', 'medium', 'high'] },
    rtcp: { cname: 'producer', reducedSize: true }
  };
}

function singleConsumerRtp(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 120, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    headerExtensions: [{ id: 9, uri: RTP_HEADER_EXTENSION_URIS.rid }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'consumer', reducedSize: true }
  };
}

function bandwidthEstimate(recommendedBitrate: number): BandwidthEstimate {
  return {
    id: 'consumer-1',
    estimatedIncomingBitrate: 0,
    estimatedOutgoingBitrate: recommendedBitrate,
    availableBitrate: recommendedBitrate,
    recommendedBitrate,
    packetLoss: 0,
    rtt: 0,
    rttVariance: 0,
    jitter: 0,
    delayVariationMs: 0,
    delayTrend: 0,
    overuseState: 'normal',
    probeBitrate: 0,
    lossCorrelation: 0,
    updatedAt: Date.now()
  };
}

function rawPacket(
  ssrc: number,
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  payload: Buffer = Buffer.from('payload'),
  headerElements: Array<{ id: number; data: Buffer }> = []
): Buffer {
  return new RtpPacket(
    2,
    false,
    headerElements.length > 0,
    false,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    [],
    serializeRtpHeaderExtensionElements(headerElements),
    payload
  ).serialize();
}
