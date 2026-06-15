import type { Consumer, Producer } from '@native-sfu/contracts';
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
});
