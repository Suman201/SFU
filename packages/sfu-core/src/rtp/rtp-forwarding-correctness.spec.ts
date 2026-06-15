import type { Consumer, Producer, RtpParameters } from '@native-sfu/contracts';
import { createNack } from '../rtcp/rtcp-packet';
import { RtpPacket } from './rtp-packet';
import { RtpRouter } from './rtp-router';

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
