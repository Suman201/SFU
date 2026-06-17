import type { Consumer, Producer } from '@native-sfu/contracts';
import { BandwidthEstimator } from '../bandwidth/bandwidth-estimator';
import { createFir, createNack, createPli, createRemb, createSenderReport } from '../rtcp/rtcp-packet';
import { RtpRouter } from './rtp-router';

describe('RtpRouter', () => {
  it('routes packets to consumers of the matching producer', async () => {
    const forwardedKinds: string[] = [];
    const droppedReasons: string[] = [];
    const router = new RtpRouter({
      onForwardedPacket: (kind) => forwardedKinds.push(kind),
      onDroppedPacket: (reason) => droppedReasons.push(reason)
    });
    const producer: Producer = {
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: 'transport-1',
      status: 'live',
      createdAt: new Date().toISOString(),
      rtpParameters: {
        codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
        encodings: [{ rid: 'high', ssrc: 1234 }],
        rtcp: { cname: 'test', reducedSize: true }
      }
    };
    const consumer: Consumer = {
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'viewer',
      roomId: 'room-1',
      transportId: 'transport-2',
      preferredLayer: 'high',
      status: 'live',
      createdAt: new Date().toISOString(),
      rtpParameters: producer.rtpParameters
    };
    const writes: number[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet.sequenceNumber);
    });

    const raw = Buffer.alloc(13);
    raw[0] = 0x80;
    raw[1] = 96;
    raw.writeUInt16BE(77, 2);
    raw.writeUInt32BE(1, 4);
    raw.writeUInt32BE(1234, 8);
    raw[12] = 0xff;

    const forwarded = await router.route(raw);
    expect(forwarded).toBe(1);
    expect(writes).toEqual([77]);
    expect(forwardedKinds).toEqual(['video']);
    expect(droppedReasons).toEqual([]);
  });

  it('routes upstream RTCP feedback to the producer of the referenced media SSRC', async () => {
    const forwarded: string[] = [];
    const router = new RtpRouter({
      keyframeRequestIntervalMs: 0,
      onForwardedRtcpPacket: (kind, direction) => forwarded.push(`${direction}:${kind}`)
    });
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const producerWrites: string[] = [];
    router.addProducer(producer, async (_packet, target, kind) => {
      producerWrites.push(`${target.id}:${kind}`);
    });
    router.addConsumer(consumer, async () => undefined, async () => undefined);

    const count = await router.routeRtcp(
      Buffer.concat([
        createNack({ senderSsrc: 9999, mediaSsrc: 1234, lostPacketIds: [77] }),
        createPli({ senderSsrc: 9999, mediaSsrc: 1234 }),
        createFir({ senderSsrc: 9999, mediaSsrc: 0, entries: [{ ssrc: 1234, sequenceNumber: 1 }] }),
        createRemb({ senderSsrc: 9999, mediaSsrc: 0, bitrateBps: 1_200_000, ssrcs: [1234] })
      ])
    );

    expect(count).toBe(4);
    expect(producerWrites).toEqual(['producer-1:nack', 'producer-1:pli', 'producer-1:fir', 'producer-1:remb']);
    expect(forwarded).toEqual(['producer:nack', 'producer:pli', 'producer:fir', 'producer:remb']);
  });

  it('routes Sender Reports from producers to active consumers', async () => {
    const router = new RtpRouter();
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const consumerWrites: string[] = [];
    router.addProducer(producer, async () => undefined);
    router.addConsumer(consumer, async () => undefined, async (_packet, target, kind) => {
      consumerWrites.push(`${target.id}:${kind}`);
    });

    const count = await router.routeRtcp(
      createSenderReport({
        senderSsrc: 1234,
        ntpTimestamp: 1n,
        rtpTimestamp: 2,
        packetCount: 3,
        octetCount: 4
      })
    );

    expect(count).toBe(1);
    expect(consumerWrites).toEqual(['consumer-1:sender-report']);
  });

  it('retransmits cached RTP packets on NACK without forwarding upstream', async () => {
    const retransmittedKinds: string[] = [];
    const router = new RtpRouter({
      retransmissionCacheSize: 8,
      onRetransmittedPacket: (kind) => retransmittedKinds.push(kind)
    });
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const producerFeedback: string[] = [];
    const writes: number[] = [];
    router.addProducer(producer, async (_packet, _target, kind) => {
      producerFeedback.push(kind);
    });
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet.sequenceNumber);
    });
    await router.route(rtpPacket(1234, 77));

    const recovered = await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 1234, lostPacketIds: [77] }), {
      sourceTransportId: consumer.transportId,
      sourceParticipantId: consumer.participantId
    });

    expect(recovered).toBe(1);
    expect(writes).toEqual([77, 77]);
    expect(producerFeedback).toEqual([]);
    expect(retransmittedKinds).toEqual(['video']);
  });

  it('forwards NACK upstream when packets are missing from the retransmission cache', async () => {
    const router = new RtpRouter({ retransmissionCacheSize: 1 });
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const producerFeedback: string[] = [];
    router.addProducer(producer, async (packet, _target, kind) => {
      producerFeedback.push(`${kind}:${packet.length}`);
    });
    router.addConsumer(consumer, async () => undefined);

    const forwarded = await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 1234, lostPacketIds: [88] }), {
      sourceTransportId: consumer.transportId
    });

    expect(forwarded).toBe(1);
    expect(producerFeedback).toEqual(['nack:16']);
  });

  it('coalesces repeated PLI and FIR requests per producer', async () => {
    let now = 1000;
    const coalesced: string[] = [];
    const forwarded: string[] = [];
    const router = new RtpRouter({
      keyframeRequestIntervalMs: 500,
      now: () => now,
      onKeyframeRequestCoalesced: (producerId, kind) => coalesced.push(`${producerId}:${kind}`),
      onKeyframeRequestForwarded: (producerId, kind) => forwarded.push(`${producerId}:${kind}`)
    });
    const producer = createProducer();
    const producerFeedback: string[] = [];
    router.addProducer(producer, async (_packet, _target, kind) => {
      producerFeedback.push(kind);
    });

    await router.routeRtcp(createPli({ senderSsrc: 9999, mediaSsrc: 1234 }));
    await router.routeRtcp(createPli({ senderSsrc: 9998, mediaSsrc: 1234 }));
    await router.routeRtcp(createFir({ senderSsrc: 9997, mediaSsrc: 0, entries: [{ ssrc: 1234, sequenceNumber: 1 }] }));
    await router.routeRtcp(createFir({ senderSsrc: 9996, mediaSsrc: 0, entries: [{ ssrc: 1234, sequenceNumber: 2 }] }));
    now += 600;
    await router.routeRtcp(createPli({ senderSsrc: 9995, mediaSsrc: 1234 }));

    expect(producerFeedback).toEqual(['pli', 'pli']);
    expect(forwarded).toEqual(['producer-1:pli', 'producer-1:pli']);
    expect(coalesced).toEqual(['producer-1:pli', 'producer-1:fir', 'producer-1:fir']);
  });

  it('allows a downstream PLI to bypass the join-time bootstrap cooldown', async () => {
    let now = 1000;
    const coalesced: string[] = [];
    const forwardedPackets: Buffer[] = [];
    const router = new RtpRouter({
      keyframeRequestIntervalMs: 500,
      now: () => now,
      onKeyframeRequestCoalesced: (producerId, kind) => coalesced.push(`${producerId}:${kind}`)
    });
    const producer = createProducer();
    const consumer = createConsumer(producer);
    producer.rtpParameters.codecs[0]!.rtcpFeedback = ['nack pli'];
    router.addProducer(producer, async (packet) => {
      forwardedPackets.push(Buffer.from(packet));
    });

    router.addConsumer(consumer, async () => undefined, async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await router.routeRtcp(createPli({ senderSsrc: 9999, mediaSsrc: 1234 }), {
      sourceTransportId: consumer.transportId,
      sourceParticipantId: consumer.participantId
    });

    expect(forwardedPackets.length).toBe(2);
    expect(forwardedPackets[0]?.equals(createPli({ senderSsrc: 1234, mediaSsrc: 1234 }))).toBe(true);
    expect(forwardedPackets[1]?.equals(createPli({ senderSsrc: 9999, mediaSsrc: 1234 }))).toBe(true);
    expect(coalesced).toEqual([]);
  });

  it('retries keyframe requests after an initial bootstrap send failure', async () => {
    let now = 1000;
    const forwardedPackets: Buffer[] = [];
    const router = new RtpRouter({
      keyframeRequestIntervalMs: 500,
      now: () => now
    });
    const producer = createProducer();
    const consumer = createConsumer(producer);
    producer.rtpParameters.codecs[0]!.rtcpFeedback = ['nack pli'];
    let attempts = 0;
    router.addProducer(producer, async (packet) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('transport not ready');
      }
      forwardedPackets.push(Buffer.from(packet));
    });

    router.addConsumer(consumer, async () => undefined, async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(forwardedPackets.length).toBe(0);

    await router.routeRtcp(createPli({ senderSsrc: 9999, mediaSsrc: 1234 }), {
      sourceTransportId: consumer.transportId,
      sourceParticipantId: consumer.participantId
    });

    expect(forwardedPackets.length).toBe(1);
    expect(forwardedPackets[0]?.equals(createPli({ senderSsrc: 9999, mediaSsrc: 1234 }))).toBe(true);
  });

  it('retries pipe-backed keyframe requests after a coalesced cooldown window elapses', async () => {
    let now = 1000;
    const forwardedPackets: Buffer[] = [];
    const router = new RtpRouter({
      keyframeRequestIntervalMs: 500,
      now: () => now
    });
    const producer = createProducer();
    producer.transportId = 'pipe-owner';
    producer.rtpParameters.codecs[0]!.rtcpFeedback = ['nack pli'];
    const consumer = createConsumer(producer);
    router.addProducer(producer, async (packet) => {
      forwardedPackets.push(Buffer.from(packet));
    });
    router.addConsumer(consumer, async () => undefined, async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(forwardedPackets.length).toBe(1);
    expect(forwardedPackets[0]?.equals(createPli({ senderSsrc: 1234, mediaSsrc: 1234 }))).toBe(true);

    await router.route(rtpPacket(1234, 77));
    expect(forwardedPackets.length).toBe(1);

    now += 600;
    await router.route(rtpPacket(1234, 78));

    expect(forwardedPackets.length).toBe(2);
    expect(forwardedPackets[1]?.equals(createPli({ senderSsrc: 1234, mediaSsrc: 1234 }))).toBe(true);
  });

  it('does not apply the join keyframe gate to inter-node pipe consumers', async () => {
    const forwardedPackets: Buffer[] = [];
    const router = new RtpRouter();
    const producer = createProducer();
    const consumer = createConsumer(producer);
    producer.rtpParameters.codecs[0]!.rtcpFeedback = ['nack pli'];
    consumer.participantId = 'pipe:node-b';
    consumer.transportId = 'pipe-remote';
    router.addProducer(producer, async (packet) => {
      forwardedPackets.push(Buffer.from(packet));
    });

    router.addConsumer(consumer, async () => undefined, async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(forwardedPackets.length).toBe(0);
  });

  it('reconciles mis-labelled RTX SSRCs when media arrives on the repair SSRC', async () => {
    const router = new RtpRouter({ enablePacing: false });
    const producer = createProducer();
    producer.rtpParameters.codecs = [
      { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 },
      { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 } }
    ];
    producer.rtpParameters.encodings = [{ rid: 'high', ssrc: 1234, rtx: { ssrc: 5678, payloadType: 97 } }];
    const consumer = createConsumer(producer);
    consumer.rtpParameters = {
      ...producer.rtpParameters,
      encodings: [{ rid: 'high', ssrc: 2222, rtx: { ssrc: 3333, payloadType: 97 } }]
    };
    const writes: Array<{ ssrc: number }> = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    const forwarded = await router.route(rawPacket(5678, 96, 10, 1000, Buffer.from([0x10, 0x00])));

    expect(forwarded).toBe(1);
    expect(writes.length).toBe(1);
    expect(writes[0]?.ssrc).toBe(2222);
    expect(producer.rtpParameters.encodings[0]?.ssrc).toBe(5678);
    expect(producer.rtpParameters.encodings[0]?.rtx?.ssrc).toBe(1234);
    expect(router.streamSnapshots(producer.id).find((stream) => stream.ssrc === 5678)?.started).toBe(true);
    expect(router.streamSnapshots(producer.id).find((stream) => stream.ssrc === 1234)?.started).toBe(false);
  });

  it('rebinds a single-encoding producer when primary media arrives on an unknown SSRC', async () => {
    const router = new RtpRouter({ enablePacing: false });
    const producer = createProducer();
    producer.rtpParameters.codecs = [
      { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 },
      { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 } }
    ];
    producer.rtpParameters.encodings = [{ rid: 'high', ssrc: 1234, rtx: { ssrc: 5678, payloadType: 97 } }];
    const consumer = createConsumer(producer);
    consumer.rtpParameters = {
      ...producer.rtpParameters,
      encodings: [{ rid: 'high', ssrc: 2222, rtx: { ssrc: 3333, payloadType: 97 } }]
    };
    const writes: Array<{ ssrc: number }> = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    const forwarded = await router.route(rawPacket(9999, 96, 10, 1000, Buffer.from([0x10, 0x00])), {
      sourceTransportId: producer.transportId,
      sourceParticipantId: producer.participantId
    });

    expect(forwarded).toBe(1);
    expect(writes.length).toBe(1);
    expect(writes[0]?.ssrc).toBe(2222);
    expect(producer.rtpParameters.encodings[0]?.ssrc).toBe(9999);
    expect(producer.rtpParameters.encodings[0]?.rtx?.ssrc).toBe(5678);
    expect(router.streamSnapshots(producer.id).find((stream) => stream.ssrc === 9999)?.started).toBe(true);
    expect(router.streamSnapshots(producer.id).some((stream) => stream.ssrc === 1234)).toBe(false);
  });

  it('allocates shared transport bitrate by consumer priority and exposes quality snapshots', () => {
    const estimator = new BandwidthEstimator();
    estimator.observePacket('transport:transport-2', 'outgoing', 75_000, 1000);
    estimator.observePacket('transport:transport-2', 'outgoing', 75_000, 2000);
    const events: string[] = [];
    const router = new RtpRouter({
      bandwidthEstimator: estimator,
      enablePacing: false,
      onConsumerScoreUpdated: (state) => events.push(`${state.consumerId}:${state.score.level}`)
    });
    const producer = createProducer();
    const lowPriority = createConsumer(producer);
    const highPriority = createConsumer(producer);
    lowPriority.id = 'consumer-low';
    lowPriority.priority = 1;
    highPriority.id = 'consumer-high';
    highPriority.priority = 8;
    router.addProducer(producer);
    router.addConsumer(lowPriority, async () => undefined);
    router.addConsumer(highPriority, async () => undefined);

    router.setConsumerPriority(highPriority.id, 8);

    const stats = router.statistics().consumers;
    const low = stats.find((consumer) => consumer.consumerId === 'consumer-low')!;
    const high = stats.find((consumer) => consumer.consumerId === 'consumer-high')!;
    expect(high.allocation.allocatedBitrate).toBeGreaterThan(low.allocation.allocatedBitrate);
    expect(high.quality.score.score).toBeGreaterThan(0);
    expect(router.transportQualitySnapshot('transport-2')?.consumers.length).toBe(2);
    expect(events.some((event) => event.startsWith('consumer-high:'))).toBe(true);
  });
});

function createProducer(): Producer {
  return {
    id: 'producer-1',
    roomId: 'room-1',
    participantId: 'publisher',
    kind: 'video',
    transportId: 'transport-1',
    status: 'live',
    createdAt: new Date().toISOString(),
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
      encodings: [{ rid: 'high', ssrc: 1234 }],
      rtcp: { cname: 'test', reducedSize: true }
    }
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number): Buffer {
  return rawPacket(ssrc, 96, sequenceNumber, 1, Buffer.from([0xff]));
}

function rawPacket(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number, payload: Buffer): Buffer {
  const raw = Buffer.alloc(12);
  raw[0] = 0x80;
  raw[1] = payloadType;
  raw.writeUInt16BE(sequenceNumber, 2);
  raw.writeUInt32BE(timestamp, 4);
  raw.writeUInt32BE(ssrc, 8);
  return Buffer.concat([raw, payload]);
}

function createConsumer(producer: Producer): Consumer {
  return {
    id: 'consumer-1',
    producerId: producer.id,
    participantId: 'viewer',
    roomId: producer.roomId,
    transportId: 'transport-2',
    preferredLayer: 'high',
    status: 'live',
    createdAt: new Date().toISOString(),
    rtpParameters: producer.rtpParameters
  };
}
