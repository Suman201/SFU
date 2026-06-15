import type { Consumer, Producer, RtpParameters } from '@native-sfu/contracts';
import { parseRtcpCompound } from '../rtcp/rtcp-packet';
import { createTransportWideCcFeedback } from '../twcc/twcc';
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
