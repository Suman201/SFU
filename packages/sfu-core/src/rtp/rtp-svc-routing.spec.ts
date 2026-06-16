import type { Consumer, ConsumerLayerEvent, Producer, RtpParameters } from '@native-sfu/contracts';
import { RtpPacket } from './rtp-packet';
import { RtpRouter } from './rtp-router';

describe('RtpRouter SVC routing', () => {
  it('forwards decodable VP9 SVC chains and switches temporal layers without a keyframe', async () => {
    const events: ConsumerLayerEvent[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      enableAdaptiveLayerSelection: false,
      sequenceNumberGenerator: () => 30000,
      timestampGenerator: () => 900000
    });
    const producer = createVp9Producer();
    const consumer = createConsumer(producer, { spatialLayerId: 0, temporalLayerId: 0 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });
    router.onConsumerLayerEvent((event) => events.push(event));

    expect(await router.route(rawPacket(7777, 98, 10, 1000, vp9Payload(0, 0, true)))).toBe(1);
    expect(await router.route(rawPacket(7777, 98, 11, 2000, vp9Payload(1, 0, true)))).toBe(0);

    router.setConsumerPreferredSvcLayers(consumer.id, { spatialLayerId: 2, temporalLayerId: 1 });
    expect(await router.route(rawPacket(7777, 98, 12, 3000, vp9Payload(1, 0)))).toBe(0);
    expect(await router.route(rawPacket(7777, 98, 13, 4000, vp9Payload(0, 0, true)))).toBe(1);
    expect(await router.route(rawPacket(7777, 98, 14, 5000, vp9Payload(1, 0)))).toBe(1);
    expect(await router.route(rawPacket(7777, 98, 15, 6000, vp9Payload(2, 1)))).toBe(1);

    router.setConsumerPreferredSvcLayers(consumer.id, { spatialLayerId: 2, temporalLayerId: 0 });
    expect(await router.route(rawPacket(7777, 98, 16, 7000, vp9Payload(2, 1)))).toBe(0);
    expect(await router.route(rawPacket(7777, 98, 17, 8000, vp9Payload(2, 0)))).toBe(1);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001, 30002, 30003, 30004]);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentSvcLayers).toEqual({ spatialLayerId: 2, temporalLayerId: 0, qualityLayerId: 2 });
    expect(events.filter((event) => event.currentSvcLayers).map((event) => event.type)).toEqual(['changed', 'switching', 'switch-failed', 'changed', 'switching', 'changed']);
    expect(events.some((event) => event.reason === 'missing_keyframe' && event.targetSvcLayers?.spatialLayerId === 2)).toBe(true);

    const stats = router.statistics();
    expect(stats.producers[0]?.svc?.capabilities.scalabilityMode).toBe('L3T3_KEY');
    expect(stats.consumers[0]?.svcLayers.find((layer) => layer.layer.spatialLayer === 2 && layer.layer.temporalLayer === 0)?.packets).toBe(1);
  });

  it('adapts SVC layer targets from bandwidth estimates while preserving dependency forwarding', async () => {
    let recommendedBitrate = 3_000_000;
    const router = new RtpRouter({
      enablePacing: false,
      bandwidthEstimator: {
        estimate: (id: string) => estimate(id, recommendedBitrate),
        observePacket: (id: string) => estimate(id, recommendedBitrate),
        snapshot: () => [estimate('consumer-1', recommendedBitrate)]
      } as never
    });
    const producer = createVp9Producer();
    const consumer = createConsumer(producer, { spatialLayerId: 2, temporalLayerId: 2 });
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(7777, 98, 10, 1000, vp9Payload(0, 0, true)))).toBe(1);
    expect(await router.route(rawPacket(7777, 98, 11, 2000, vp9Payload(2, 2)))).toBe(1);
    recommendedBitrate = 250_000;
    expect(await router.route(rawPacket(7777, 98, 12, 3000, vp9Payload(2, 2)))).toBe(1);
    expect(await router.route(rawPacket(7777, 98, 13, 4000, vp9Payload(0, 0)))).toBe(1);

    expect(writes.length).toBe(4);
    expect(router.consumerLayerSnapshot(consumer.id)?.currentSvcLayers?.spatialLayerId).toBe(0);
  });
});

function createVp9Producer(): Producer {
  return {
    id: 'producer-1',
    participantId: 'publisher',
    roomId: 'room-1',
    kind: 'video',
    transportId: 'transport-pub',
    status: 'live',
    createdAt: new Date().toISOString(),
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP9', payloadType: 98, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' }, rtcpFeedback: ['nack pli'] }],
      encodings: [{ ssrc: 7777, maxBitrate: 2_700_000, scalabilityMode: 'L3T3_KEY' }],
      rtcp: { cname: 'producer', reducedSize: true }
    }
  };
}

function createConsumer(producer: Producer, preferredSvcLayers: Consumer['preferredSvcLayers']): Consumer {
  return {
    id: 'consumer-1',
    producerId: producer.id,
    participantId: 'viewer',
    roomId: producer.roomId,
    transportId: 'transport-sub',
    preferredLayer: 'high',
    preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
    preferredSvcLayers,
    rtpParameters: consumerRtp(),
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function consumerRtp(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP9', payloadType: 120, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' }, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc: 9000, scalabilityMode: 'L3T3_KEY' }],
    rtcp: { cname: 'consumer', reducedSize: true }
  };
}

function rawPacket(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number, payload: Buffer): Buffer {
  return new RtpPacket(2, false, false, false, payloadType, sequenceNumber, timestamp, ssrc, [], null, payload).serialize();
}

function vp9Payload(spatialLayer: number, temporalLayer: number, keyframe = false): Buffer {
  return Buffer.from([(keyframe ? 0x2c : 0x6c), ((temporalLayer & 0x07) << 5) | ((spatialLayer & 0x07) << 1) | (spatialLayer > 0 ? 0x01 : 0), 0x00, 0x10]);
}

function estimate(id: string, recommendedBitrate: number) {
  return {
    id,
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
    updatedAt: 1000
  };
}
