import type { Consumer, Producer, RtpParameters } from '@native-sfu/contracts';
import { createNack, createReceiverReport, createSenderReport, parseReceiverReport, parseRtcpCompound, parseSenderReport } from '../rtcp/rtcp-packet';
import { DeterministicPacketLossHarness } from './packet-loss-harness';
import { RtpPacket } from './rtp-packet';
import { RtpRouter } from './rtp-router';
import { addSequenceNumber } from './rtp-sequence';
import { originalSequenceNumberFromRtx } from './rtx';

describe('RtpRouter forwarding correctness', () => {
  it('validates payload type and drops malformed RTP packets without throwing', async () => {
    const drops: string[] = [];
    const router = new RtpRouter({ onDroppedPacket: (reason) => drops.push(reason) });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    router.addProducer(producer);
    router.addConsumer(createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120)), async () => undefined);

    expect(await router.route(rawPacket(1111, 97, 1, 1000))).toBe(0);
    const malformed = Buffer.from(rawPacket(1111, 96, 2, 2000));
    malformed[0] = 0x40;
    expect(await router.route(malformed)).toBe(0);

    expect(drops).toEqual(['invalid_payload_type', 'invalid_version']);
  });

  it('buffers reordered packets, releases them in order, and drops duplicates and late packets', async () => {
    const drops: string[] = [];
    const router = new RtpRouter({
      sequenceNumberGenerator: () => 30000,
      timestampGenerator: () => 700000,
      onDroppedPacket: (reason) => drops.push(reason)
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120)), async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(1111, 96, 10, 1000))).toBe(1);
    expect(await router.route(rawPacket(1111, 96, 12, 7000))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 11, 4000))).toBe(2);
    expect(await router.route(rawPacket(1111, 96, 11, 4000))).toBe(0);
    expect(await router.route(rawPacket(1111, 96, 9, 500))).toBe(0);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001, 30002]);
    expect(writes.map((packet) => packet.timestamp)).toEqual([700000, 703000, 706000]);
    expect(drops).toEqual(['duplicate_packet', 'late_packet']);
  });

  it('drains reordered packets after missing packet timeout', async () => {
    const expired: string[] = [];
    const router = new RtpRouter({
      maxReorderDelayMs: 5,
      sequenceNumberGenerator: () => 30000,
      timestampGenerator: () => 700000,
      onReorderGapExpired: (ssrc, expected, released) => expired.push(`${ssrc}:${expected}->${released}`)
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120)), async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(1111, 96, 10, 1000))).toBe(1);
    expect(await router.route(rawPacket(1111, 96, 12, 7000))).toBe(0);
    await waitFor(() => writes.length === 2);

    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([30000, 30001]);
    expect(expired).toEqual(['1111:11->12']);
  });

  it('rewrites RTP per consumer and maps rewritten NACK repairs back to cached producer packets', async () => {
    const router = new RtpRouter({
      retransmissionCacheSize: 16,
      sequenceNumberGenerator: () => 40000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120));
    const writes: RtpPacket[] = [];
    const upstreamFeedback: Buffer[] = [];
    router.addProducer(producer, async (packet) => {
      upstreamFeedback.push(packet);
    });
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(1111, 96, 10, 1000))).toBe(1);
    expect(writes[0]?.ssrc).toBe(2222);
    expect(writes[0]?.payloadType).toBe(120);
    expect(writes[0]?.sequenceNumber).toBe(40000);
    expect(writes[0]?.timestamp).toBe(900000);

    const repaired = await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 2222, lostPacketIds: [40000] }), {
      sourceTransportId: 'transport-sub',
      sourceParticipantId: 'viewer'
    });

    expect(repaired).toBe(1);
    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([40000, 40000]);
    expect(upstreamFeedback).toEqual([]);
  });

  it('generates RTX packets for cached NACK repairs when RTX is negotiated', async () => {
    let sequence = 41000;
    const router = new RtpRouter({
      retransmissionCacheSize: 16,
      sequenceNumberGenerator: () => sequence++,
      timestampGenerator: () => 900000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96, 1122, 97));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120, 2233, 121));
    const writes: RtpPacket[] = [];
    const upstreamFeedback: Buffer[] = [];
    router.addProducer(producer, async (packet) => {
      upstreamFeedback.push(packet);
    });
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    await router.route(rawPacket(1111, 96, 10, 1000));
    const targetSequenceNumber = writes[0]!.sequenceNumber;
    const repaired = await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 2222, lostPacketIds: [targetSequenceNumber] }), {
      sourceTransportId: 'transport-sub',
      sourceParticipantId: 'viewer'
    });

    expect(repaired).toBe(1);
    expect(writes[1]?.ssrc).toBe(2233);
    expect(writes[1]?.payloadType).toBe(121);
    expect(originalSequenceNumberFromRtx(writes[1]!)).toBe(targetSequenceNumber);
    expect(writes[1]?.payload.subarray(2).toString()).toBe('forwarding');
    expect(upstreamFeedback).toEqual([]);
  });

  it('uses deterministic packet loss validation to prove NACK to RTX repair and separated metrics', async () => {
    let sequence = 42000;
    const router = new RtpRouter({
      retransmissionCacheSize: 16,
      enablePacing: false,
      sequenceNumberGenerator: () => sequence++,
      timestampGenerator: () => 900000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96, 1122, 97));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120, 2233, 121));
    const delivered: RtpPacket[] = [];
    const dropped: RtpPacket[] = [];
    const loss = new DeterministicPacketLossHarness({
      lossPercentage: 100,
      dropRetransmissions: false,
      classifyRetransmission: (packet) => packet.ssrc === 2233,
      onDroppedPacket: (packet) => dropped.push(packet)
    });
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      if (!loss.shouldDrop(packet)) {
        delivered.push(packet);
      }
    });

    expect(await router.route(rawPacket(1111, 96, 10, 1000))).toBe(1);
    expect(delivered).toEqual([]);
    const lostSequenceNumber = dropped[0]!.sequenceNumber;

    const repaired = await router.routeRtcp(createNack({ senderSsrc: 9999, mediaSsrc: 2222, lostPacketIds: [lostSequenceNumber] }), {
      sourceTransportId: 'transport-sub',
      sourceParticipantId: 'viewer'
    });

    expect(repaired).toBe(1);
    expect(delivered[0]?.ssrc).toBe(2233);
    expect(originalSequenceNumberFromRtx(delivered[0]!)).toBe(lostSequenceNumber);
    expect(loss.snapshot().droppedPackets).toBe(1);
    const stats = router.statistics().consumers[0]!;
    expect(stats.primaryRtp.packets).toBe(1);
    expect(stats.retransmissions.requestedPackets).toBe(1);
    expect(stats.retransmissions.rtxPackets).toBe(1);
    expect(stats.retransmissions.successRate).toBe(1);
    expect(stats.retransmissions.failureRate).toBe(0);
  });

  it('rewrites Sender Reports to the consumer SSRC and RTP timestamp mapping', async () => {
    const router = new RtpRouter({
      sequenceNumberGenerator: () => 40000,
      timestampGenerator: () => 900000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120));
    const rtcpWrites: Buffer[] = [];
    router.addProducer(producer);
    router.addConsumer(
      consumer,
      async () => undefined,
      async (packet) => {
        rtcpWrites.push(packet);
      }
    );

    await router.route(rawPacket(1111, 96, 10, 1000));
    await router.routeRtcp(
      createSenderReport({
        senderSsrc: 1111,
        ntpTimestamp: 0x100000002n,
        rtpTimestamp: 4000,
        packetCount: 10,
        octetCount: 1000
      })
    );
    const rewritten = parseSenderReport(parseRtcpCompound(rtcpWrites[0]!)[0]!);

    expect(rewritten?.senderSsrc).toBe(2222);
    expect(rewritten?.rtpTimestamp).toBe(903000);
    expect(rewritten?.ntpTimestamp).toBe(0x100000002n);
  });

  it('rewrites compound Sender Report blocks for mapped consumer streams', async () => {
    const router = new RtpRouter({
      sequenceNumberGenerator: () => 43000,
      timestampGenerator: () => 1_000_000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120));
    const rtcpWrites: Buffer[] = [];
    router.addProducer(producer);
    router.addConsumer(
      consumer,
      async () => undefined,
      async (packet) => {
        rtcpWrites.push(packet);
      }
    );

    await router.route(rawPacket(1111, 96, 10, 1000));
    await router.routeRtcp(
      Buffer.concat([
        createSenderReport({
          senderSsrc: 1111,
          ntpTimestamp: 0x100000002n,
          rtpTimestamp: 4000,
          packetCount: 10,
          octetCount: 1000,
          reports: [{ ssrc: 1111, fractionLost: 0, packetsLost: 0, highestSequence: 10, jitter: 1, lastSenderReport: 2, delaySinceLastSenderReport: 3 }]
        })
      ])
    );

    const senderReport = parseSenderReport(parseRtcpCompound(rtcpWrites[0]!)[0]!);
    expect(senderReport?.senderSsrc).toBe(2222);
    expect(senderReport?.reports[0]?.ssrc).toBe(2222);
  });

  it('rewrites upstream Receiver Reports for negotiated RTX SSRCs before a repair stream exists', async () => {
    const router = new RtpRouter();
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96, 1122, 97));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120, 2233, 121));
    const upstreamFeedback: Buffer[] = [];
    router.addProducer(producer, async (packet) => {
      upstreamFeedback.push(packet);
    });
    router.addConsumer(consumer, async () => undefined);

    const forwarded = await router.routeRtcp(
      createReceiverReport({
        reporterSsrc: 9999,
        reports: [{ ssrc: 2233, fractionLost: 0, packetsLost: 0, highestSequence: 10, jitter: 1, lastSenderReport: 2, delaySinceLastSenderReport: 3 }]
      }),
      { sourceTransportId: 'transport-sub', sourceParticipantId: 'viewer' }
    );

    expect(forwarded).toBe(1);
    expect(parseReceiverReport(parseRtcpCompound(upstreamFeedback[0]!)[0]!)?.reports[0]?.ssrc).toBe(1122);
  });

  it('detects producer stream restart and resets consumer rewrite state', async () => {
    let nextSequenceBase = 1000;
    const restarts: string[] = [];
    const router = new RtpRouter({
      restartSequenceGap: 100,
      sequenceNumberGenerator: () => nextSequenceBase,
      timestampGenerator: () => 500000,
      onStreamRestart: (producerId, ssrc) => restarts.push(`${producerId}:${ssrc}`)
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120)), async (packet) => {
      writes.push(packet);
    });

    await router.route(rawPacket(1111, 96, 10, 1000));
    nextSequenceBase = 5000;
    await router.route(rawPacket(1111, 96, 1000, 90000));

    expect(restarts).toEqual(['producer-1:1111']);
    expect(writes.map((packet) => packet.sequenceNumber)).toEqual([1000, 5000]);
  });

  it('preserves reverse NACK mapping across consumer sequence wrap', async () => {
    let nextSequenceBase = 65534;
    const router = new RtpRouter({
      retransmissionCacheSize: 16,
      sequenceNumberGenerator: () => nextSequenceBase++,
      timestampGenerator: () => 500000
    });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    await router.route(rawPacket(1111, 96, 65534, 1000));
    await router.route(rawPacket(1111, 96, 65535, 4000));
    await router.route(rawPacket(1111, 96, 0, 7000));

    const deliveredSequences = writes.map((packet) => packet.sequenceNumber);
    expect(deliveredSequences).toEqual([
      deliveredSequences[0]!,
      addSequenceNumber(deliveredSequences[0]!, 1),
      addSequenceNumber(deliveredSequences[0]!, 2)
    ]);
    const wrappedTargetSequence = deliveredSequences[2]!;

    const repaired = await router.routeRtcp(
      createNack({ senderSsrc: 9999, mediaSsrc: 2222, lostPacketIds: [wrappedTargetSequence] }),
      {
        sourceTransportId: consumer.transportId,
        sourceParticipantId: consumer.participantId
      }
    );

    expect(repaired).toBe(1);
    expect(writes.at(-1)?.sequenceNumber).toBe(wrappedTargetSequence);
    expect(writes.at(-1)?.payload.toString()).toBe('forwarding');
  });

  it('maps RTX SSRC and payload type when both producer and consumer advertise RTX', async () => {
    const router = new RtpRouter({ sequenceNumberGenerator: () => 60000, timestampGenerator: () => 1000000 });
    const producer = createProducer('producer-1', 'publisher', 'transport-pub', rtpParameters(1111, 96, 1122, 97));
    const consumer = createConsumer('consumer-1', producer, 'viewer', 'transport-sub', rtpParameters(2222, 120, 2233, 121));
    const writes: RtpPacket[] = [];
    router.addProducer(producer);
    router.addConsumer(consumer, async (packet) => {
      writes.push(packet);
    });

    expect(await router.route(rawPacket(1122, 97, 5, 12345))).toBe(1);

    expect(writes[0]?.ssrc).toBe(2233);
    expect(writes[0]?.payloadType).toBe(121);
    expect(writes[0]?.sequenceNumber).toBe(60000);
  });

  it('handles multiple producers, multiple consumers, and dynamic unsubscribe', async () => {
    const router = new RtpRouter();
    const producerA = createProducer('producer-a', 'publisher-a', 'transport-pa', rtpParameters(1111, 96));
    const producerB = createProducer('producer-b', 'publisher-b', 'transport-pb', rtpParameters(3333, 98));
    const writes: string[] = [];
    router.addProducer(producerA);
    router.addProducer(producerB);
    router.addConsumer(createConsumer('consumer-a1', producerA, 'viewer-1', 'transport-a1', rtpParameters(2111, 120)), async (packet, consumer) => {
      writes.push(`${consumer.id}:${packet.ssrc}:${packet.sequenceNumber}`);
    });
    router.addConsumer(createConsumer('consumer-a2', producerA, 'viewer-2', 'transport-a2', rtpParameters(2112, 120)), async (packet, consumer) => {
      writes.push(`${consumer.id}:${packet.ssrc}:${packet.sequenceNumber}`);
    });
    router.addConsumer(createConsumer('consumer-b1', producerB, 'viewer-3', 'transport-b1', rtpParameters(2333, 121)), async (packet, consumer) => {
      writes.push(`${consumer.id}:${packet.ssrc}:${packet.sequenceNumber}`);
    });

    expect(await router.route(rawPacket(1111, 96, 1, 1000))).toBe(2);
    router.removeConsumer('consumer-a2');
    expect(await router.route(rawPacket(1111, 96, 2, 2000))).toBe(1);
    expect(await router.route(rawPacket(3333, 98, 1, 1000))).toBe(1);

    expect(writes).toEqual(['consumer-a1:2111:1', 'consumer-a2:2112:1', 'consumer-a1:2111:2', 'consumer-b1:2333:1']);
  });
});

function createProducer(id: string, participantId: string, transportId: string, rtp: RtpParameters): Producer {
  return {
    id,
    participantId,
    roomId: 'room-1',
    kind: 'video',
    transportId,
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function createConsumer(id: string, producer: Producer, participantId: string, transportId: string, rtp: RtpParameters): Consumer {
  return {
    id,
    producerId: producer.id,
    participantId,
    roomId: producer.roomId,
    transportId,
    preferredLayer: 'high',
    rtpParameters: rtp,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rtpParameters(ssrc: number, payloadType: number, rtxSsrc?: number, rtxPayloadType?: number): RtpParameters {
  return {
    codecs: [
      { mimeType: 'video/VP8', payloadType, clockRate: 90000 },
      ...(rtxPayloadType !== undefined ? [{ mimeType: 'video/rtx', payloadType: rtxPayloadType, clockRate: 90000, parameters: { apt: payloadType } }] : [])
    ],
    encodings: [{ rid: 'high', ssrc, rtx: rtxSsrc !== undefined ? { ssrc: rtxSsrc, payloadType: rtxPayloadType } : undefined }],
    rtcp: { cname: `${ssrc}`, reducedSize: true }
  };
}

function rawPacket(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number): Buffer {
  const payload = Buffer.from('forwarding');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType;
  packet.writeUInt16BE(sequenceNumber & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  payload.copy(packet, 12);
  return packet;
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
