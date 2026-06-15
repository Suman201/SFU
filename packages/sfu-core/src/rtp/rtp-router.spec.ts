import type { Consumer, Producer } from '@native-sfu/contracts';
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
  const raw = Buffer.alloc(13);
  raw[0] = 0x80;
  raw[1] = 96;
  raw.writeUInt16BE(sequenceNumber, 2);
  raw.writeUInt32BE(1, 4);
  raw.writeUInt32BE(ssrc, 8);
  raw[12] = 0xff;
  return raw;
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
