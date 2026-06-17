import type { Consumer, Producer, RtpParameters } from '@native-sfu/contracts';
import { parseRtcpCompound } from '../rtcp/rtcp-packet';
import { createTransportWideCcFeedback } from '../twcc/twcc';
import { DeterministicPacketImpairmentHarness } from './packet-impairment-harness';
import { RTP_HEADER_EXTENSION_URIS, parseRtpHeaderExtensions, serializeRtpHeaderExtensionElements } from './rtp-header-extension';
import { RtpPacket } from './rtp-packet';
import { RtpRouter } from './rtp-router';

describe('RtpRouter adaptive transport foundation', () => {
  it('rewrites RTP header extensions and inserts outbound TWCC per consumer', async () => {
    const router = new RtpRouter({
      sequenceNumberGenerator: () => 4000,
      timestampGenerator: () => 90_000
    });
    const producer = createProducer(rtpParameters(1111, 96, [
      { id: 1, uri: RTP_HEADER_EXTENSION_URIS.mid },
      { id: 2, uri: RTP_HEADER_EXTENSION_URIS.rid }
    ]));
    const consumer = createConsumer(producer, rtpParameters(2222, 120, [
      { id: 8, uri: RTP_HEADER_EXTENSION_URIS.mid },
      { id: 9, uri: RTP_HEADER_EXTENSION_URIS.rid },
      { id: 5, uri: RTP_HEADER_EXTENSION_URIS.twcc },
      { id: 6, uri: RTP_HEADER_EXTENSION_URIS.absoluteSendTime }
    ]));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    await router.route(rawPacket(1111, 96, 10, 1000, Buffer.from('payload'), [
      { id: 1, data: Buffer.from('0') },
      { id: 2, data: Buffer.from('high') }
    ]));

    expect(writes.length).toBe(1);
    expect(writes[0]?.sequenceNumber).toBe(4000);
    const parsed = parseRtpHeaderExtensions(writes[0]!, consumer.rtpParameters);
    expect(typeof parsed.find((extension) => extension.kind === 'twcc')?.value).toBe('number');
    expect(typeof parsed.find((extension) => extension.kind === 'absoluteSendTime')?.value).toBe('number');
    expect(parsed.map((extension) => [extension.id, extension.kind, typeof extension.value === 'number' ? 'number' : extension.value])).toEqual([
      [5, 'twcc', 'number'],
      [6, 'absoluteSendTime', 'number'],
      [8, 'mid', '0'],
      [9, 'rid', 'high']
    ]);
    expect(router.pacingSnapshots().map((snapshot) => snapshot.id).sort()).toEqual(['consumer:consumer-1', 'transport:transport-sub']);
  });

  it('updates bandwidth estimates from received TWCC feedback', async () => {
    const estimates: number[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      onBandwidthEstimate: (_id, estimate) => estimates.push(estimate.recommendedBitrate)
    });
    const producer = createProducer(rtpParameters(1111, 96));
    const consumer = createConsumer(producer, rtpParameters(2222, 120));
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);
    await router.route(rawPacket(1111, 96, 10, 1000));

    await router.routeRtcp(
      createTransportWideCcFeedback({
        senderSsrc: 9999,
        mediaSsrc: 2222,
        feedbackPacketCount: 1,
        arrivals: [
          { sequenceNumber: 1, arrivalTimeMs: 1000, size: 1000 },
          { sequenceNumber: 3, arrivalTimeMs: 1040, size: 1000 }
        ]
      }),
      { sourceTransportId: consumer.transportId, sourceParticipantId: consumer.participantId }
    );

    expect(estimates.length).toBeGreaterThan(0);
    expect(router.bandwidthEstimate(consumer.id).packetLoss).toBeGreaterThan(0);
  });

  it('updates owner-side allocation from externally applied consumer TWCC observations', async () => {
    const router = new RtpRouter({
      enablePacing: false,
      qualityUpdateIntervalMs: 0
    });
    const producer = createProducer(rtpParameters(1111, 96));
    const consumer = createConsumer(producer, rtpParameters(2222, 120));
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);

    const initial = router.consumerQualitySnapshot(consumer.id)!;
    const updated = router.applyExternalConsumerTwccObservation(consumer.id, {
      packetLoss: 0.22,
      delayVariationMs: 95,
      jitter: 80,
      rtt: 140,
      sendDeltaMs: 20,
      receiveDeltaMs: 70,
      timestamp: 2000
    });

    expect(updated).toBeDefined();
    expect(router.bandwidthEstimate(consumer.id).packetLoss).toBeGreaterThan(initial.network.packetLoss);
    expect(router.bandwidthEstimate(`transport:${consumer.transportId}`).packetLoss).toBeGreaterThan(0);
    expect(updated?.network.packetLoss).toBeGreaterThan(initial.network.packetLoss);
  });

  it('ignores stale externally applied consumer TWCC observations', async () => {
    const router = new RtpRouter({
      enablePacing: false,
      qualityUpdateIntervalMs: 0
    });
    const producer = createProducer(rtpParameters(1111, 96));
    const consumer = createConsumer(producer, rtpParameters(2222, 120));
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);

    const degraded = router.applyExternalConsumerTwccObservation(consumer.id, {
      packetLoss: 0.28,
      delayVariationMs: 110,
      jitter: 70,
      rtt: 160,
      timestamp: 3000
    });
    const afterDegraded = router.bandwidthEstimate(consumer.id);
    const stale = router.applyExternalConsumerTwccObservation(consumer.id, {
      packetLoss: 0.01,
      delayVariationMs: 10,
      jitter: 4,
      rtt: 20,
      timestamp: 2000
    });

    expect(degraded).toBeDefined();
    expect(stale?.network.packetLoss).toBeCloseTo(degraded!.network.packetLoss, 5);
    expect(router.bandwidthEstimate(consumer.id).packetLoss).toBeCloseTo(afterDegraded.packetLoss, 5);
    expect(router.bandwidthEstimate(consumer.id).delayVariationMs).toBeCloseTo(afterDegraded.delayVariationMs, 5);
  });

  it('tracks transport-cc send history, probe results, and statistics API state', async () => {
    let now = 1000;
    const router = new RtpRouter({
      enablePacing: false,
      now: () => now,
      sequenceNumberGenerator: () => 5000,
      timestampGenerator: () => 200000,
      defaultPacingBitrateBps: 100_000,
      probeClusterIntervalMs: 0,
      probeBurstPackets: 3,
      probeBitrateMultiplier: 1.1
    });
    const producer = createProducer(rtpParameters(1111, 96, [{ id: 4, uri: RTP_HEADER_EXTENSION_URIS.twcc }]));
    const consumer = createConsumer(producer, rtpParameters(2222, 120, [{ id: 5, uri: RTP_HEADER_EXTENSION_URIS.twcc }]));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    for (let index = 0; index < 4; index += 1) {
      await router.route(rawPacket(1111, 96, 10 + index, 1000 + index * 3000, Buffer.from('payload'), [{ id: 4, data: Buffer.from([(100 + index) >> 8, (100 + index) & 0xff]) }]));
      now += 20;
    }
    const twccSequences = writes.map((packet) => parseRtpHeaderExtensions(packet, consumer.rtpParameters).find((extension) => extension.kind === 'twcc')?.value as number);
    await router.routeRtcp(
      createTransportWideCcFeedback({
        senderSsrc: 9999,
        mediaSsrc: 2222,
        feedbackPacketCount: 2,
        arrivals: [
          { sequenceNumber: twccSequences[0]!, arrivalTimeMs: 64000, size: 1000 },
          { sequenceNumber: twccSequences[1]!, arrivalTimeMs: 64022, size: 1000 },
          { sequenceNumber: twccSequences[3]!, arrivalTimeMs: 64070, size: 1000 }
        ]
      }),
      { sourceTransportId: consumer.transportId, sourceParticipantId: consumer.participantId }
    );

    const stats = router.statistics().consumers[0]!;
    expect(stats.twccSendHistory.sentPackets).toBe(4);
    expect(stats.bitrate.estimate.rtt).toBeGreaterThan(0);
    expect(stats.bitrate.estimate.packetLoss).toBeGreaterThan(0);
    expect(stats.bitrate.probes.length).toBeGreaterThan(0);
    expect(stats.bitrate.history.length).toBeGreaterThan(0);
    expect(stats.layers[0]?.fractionLost).toBeGreaterThan(0);
    expect(stats.layers[0]?.rtt).toBeGreaterThan(0);
    expect(stats.layers[0]?.score.degradationReason).toBe('packet_loss');
    expect(router.statistics().probes.length).toBeGreaterThan(0);
  });

  it('drives overuse, recovery, and probe visibility from deterministic external impairment observations', async () => {
    let now = 1000;
    const router = new RtpRouter({
      enablePacing: false,
      now: () => now,
      sequenceNumberGenerator: () => 6000,
      timestampGenerator: () => 210000,
      qualityUpdateIntervalMs: 0,
      probeClusterIntervalMs: 0,
      probeBurstPackets: 2,
      probeBitrateMultiplier: 1.1
    });
    const producer = createProducer(rtpParameters(1111, 96, [{ id: 4, uri: RTP_HEADER_EXTENSION_URIS.twcc }]));
    const consumer = createConsumer(producer, rtpParameters(2222, 120, [{ id: 5, uri: RTP_HEADER_EXTENSION_URIS.twcc }]));
    router.addProducer(producer);
    router.addConsumer(consumer, async () => undefined);

    for (let round = 0; round < 8; round += 1) {
      await router.route(rawPacket(1111, 96, 10 + round, 1000 + round * 3000));
      const observation = observationFromImpairment(
        scenarioPackets(round * 10),
        new DeterministicPacketImpairmentHarness<RtpPacket>({
          lossPercentage: 20,
          baseDelayMs: 80,
          jitterMs: 25,
          maxThroughputBps: 180_000,
          seed: 91
        }),
        now
      );
      router.applyExternalConsumerTwccObservation(consumer.id, observation);
      now += 120;
    }

    const congested = router.bandwidthEstimate(consumer.id);
    const congestedRecommendedBitrate = congested.recommendedBitrate;
    expect(congested.overuseState).toBe('overuse');
    expect(congested.packetLoss).toBeGreaterThan(0);

    for (let round = 0; round < 12; round += 1) {
      await router.route(rawPacket(1111, 96, 40 + round, 20_000 + round * 3000));
      const observation = observationFromImpairment(
        scenarioPackets(100 + round * 10),
        new DeterministicPacketImpairmentHarness<RtpPacket>({
          lossPercentage: 0,
          baseDelayMs: 2,
          jitterMs: 0,
          maxThroughputBps: 12_000_000,
          seed: 17
        }),
        now
      );
      observation.receiveDeltaMs = Math.max(1, observation.sendDeltaMs - 4);
      router.applyExternalConsumerTwccObservation(consumer.id, observation);
      now += 120;
    }

    const recovered = router.bandwidthEstimate(consumer.id);
    const stats = router.statistics().consumers[0]!;
    expect(recovered.recommendedBitrate).toBeGreaterThan(congestedRecommendedBitrate);
    expect(stats.bitrate.events.some((event) => event.type === 'overuse')).toBe(true);
    expect(recovered.packetLoss).toBeLessThan(congested.packetLoss);
    expect(router.statistics().probes.length).toBeGreaterThan(0);
  });

  it('requests a keyframe and holds active video joins until a keyframe arrives', async () => {
    const rtcpWrites: Buffer[] = [];
    const gateEvents: string[] = [];
    const router = new RtpRouter({
      enablePacing: false,
      keyframeRequestIntervalMs: 0,
      onKeyframeGateDropped: (consumerId) => gateEvents.push(`drop:${consumerId}`),
      onKeyframeGateOpened: (consumerId) => gateEvents.push(`open:${consumerId}`)
    });
    const producer = createProducer({
      ...rtpParameters(1111, 96),
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }]
    });
    const consumer = createConsumer(producer, producer.rtpParameters);
    const writes: RtpPacket[] = [];
    router.addProducer(producer, async (packet) => {
      rtcpWrites.push(packet);
    });
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });
    await Promise.resolve();

    expect(rtcpWrites.some((packet) => parseRtcpCompound(packet)[0]?.type === 206)).toBe(true);
    expect(await router.route(rawPacket(1111, 96, 10, 1000, Buffer.from([0x10, 0x01])))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 11, 2000, Buffer.from([0x10, 0x00])))).toBe(1);
    expect(writes.length).toBe(1);
    expect(gateEvents).toEqual([`drop:${consumer.id}`, `open:${consumer.id}`]);
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

function createConsumer(producer: Producer, rtp: RtpParameters): Consumer {
  return {
    id: 'consumer-1',
    producerId: producer.id,
    participantId: 'viewer',
    roomId: producer.roomId,
    transportId: 'transport-sub',
    preferredLayer: 'high',
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rtpParameters(ssrc: number, payloadType: number, headerExtensions: RtpParameters['headerExtensions'] = []): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType, clockRate: 90000 }],
    headerExtensions,
    encodings: [{ rid: 'high', ssrc }],
    rtcp: { cname: `${ssrc}`, reducedSize: true }
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
  const packet = new RtpPacket(
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
  );
  return packet.serialize();
}

function scenarioPackets(offset: number): RtpPacket[] {
  return [
    new RtpPacket(2, false, false, false, 96, 100 + offset, 10_000 + offset * 3000, 1111, [], null, Buffer.alloc(1200, 0x11)),
    new RtpPacket(2, false, false, false, 96, 101 + offset, 13_000 + offset * 3000, 1111, [], null, Buffer.alloc(1200, 0x11)),
    new RtpPacket(2, false, false, false, 96, 102 + offset, 16_000 + offset * 3000, 1111, [], null, Buffer.alloc(1200, 0x11)),
    new RtpPacket(2, false, false, false, 96, 103 + offset, 19_000 + offset * 3000, 1111, [], null, Buffer.alloc(1200, 0x11))
  ];
}

function observationFromImpairment(
  packets: RtpPacket[],
  harness: DeterministicPacketImpairmentHarness<RtpPacket>,
  startAt: number
): {
  packetLoss: number;
  delayVariationMs: number;
  jitter: number;
  rtt: number;
  sendDeltaMs: number;
  receiveDeltaMs: number;
  timestamp: number;
} {
  const sentAt = packets.map((_packet, index) => startAt + index * 20);
  for (let index = 0; index < packets.length; index += 1) {
    harness.enqueue(packets[index]!, sentAt[index]!);
  }
  const released = harness.flushAll();
  const sendDeltaMs = averageDelta(sentAt);
  const receiveDeltaMs = averageDelta(released.map((packet) => packet.releaseAt)) || sendDeltaMs;
  const delays = released.map((packet) => packet.releaseAt - packet.sentAt);
  const delayMean = delays.length === 0 ? 0 : delays.reduce((sum, value) => sum + value, 0) / delays.length;
  const delayVariationMs =
    delays.length === 0 ? 0 : delays.reduce((sum, value) => sum + Math.abs(value - delayMean), 0) / delays.length;
  return {
    packetLoss: 1 - released.length / packets.length,
    delayVariationMs,
    jitter: delayVariationMs,
    rtt: delayMean * 2,
    sendDeltaMs,
    receiveDeltaMs,
    timestamp: released[released.length - 1]?.releaseAt ?? startAt
  };
}

function averageDelta(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += values[index]! - values[index - 1]!;
  }
  return total / (values.length - 1);
}
