import type { Consumer, Producer, RtpParameters } from '@native-sfu/contracts';
import type { BandwidthEstimator, BandwidthEstimate } from '../bandwidth/bandwidth-estimator';
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

    expect(await router.route(rawPacket(1111, 96, 10, 1000, Buffer.from([0x10, 0x00])))).toBe(1);
    router.setConsumerPreferredLayers(consumer.id, { spatialLayer: 2 });
    expect(await router.route(rawPacket(3333, 96, 1, 50_000, Buffer.from([0x10, 0x01])))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 11, 4000, Buffer.from([0x10, 0x01])))).toBe(1);
    expect(await router.route(rawPacket(3333, 96, 2, 53_000, Buffer.from([0x10, 0x00])))).toBe(1);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001, 30002]);
    expect(writes.map((packet) => packet.ssrc)).toEqual([9000, 9000, 9000]);
    expect(switched).toEqual(['0->2']);
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
});

function createProducer(rtp: RtpParameters): Producer {
  return {
    id: 'producer-1',
    participantId: 'publisher',
    roomId: 'room-1',
    kind: 'video',
    transportId: 'transport-pub',
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function createConsumer(producer: Producer, rtp: RtpParameters, preferredLayers = { spatialLayer: 2 }): Consumer {
  return {
    id: 'consumer-1',
    producerId: producer.id,
    participantId: 'viewer',
    roomId: producer.roomId,
    transportId: 'transport-sub',
    preferredLayer: 'high',
    preferredLayers,
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
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
    jitter: 0,
    delayVariationMs: 0,
    updatedAt: Date.now()
  };
}

function rawPacket(
  ssrc: number,
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  payload = Buffer.from('payload'),
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
