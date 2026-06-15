import type { Consumer, Producer } from '@native-sfu/contracts';
import { createNack, createReceiverReport, createSenderReport } from './rtcp-packet';
import { RtcpProcessor } from './rtcp-processor';
import { RtpRouter } from '../rtp/rtp-router';

describe('RTCP processor and router integration', () => {
  it('processes receiver feedback and routes it upstream to the producer', async () => {
    const processor = new RtcpProcessor();
    const router = new RtpRouter();
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const producerFeedback: string[] = [];
    router.addProducer(producer, async (_packet, _target, kind) => {
      producerFeedback.push(kind);
    });
    router.addConsumer(consumer, async () => undefined, async () => undefined);
    const compound = Buffer.concat([
      createReceiverReport({
        reporterSsrc: 9999,
        reports: [
          {
            ssrc: 1234,
            fractionLost: 0.125,
            packetsLost: 2,
            highestSequence: 102,
            jitter: 3,
            lastSenderReport: 4,
            delaySinceLastSenderReport: 5
          }
        ]
      }),
      createNack({ senderSsrc: 9999, mediaSsrc: 1234, lostPacketIds: [100, 101] })
    ]);

    const feedback = processor.process('room-1', 'viewer', compound);
    const forwarded = await router.routeRtcp(compound);

    expect(feedback.receiverReports.map((report) => report.ssrc)).toEqual([1234]);
    expect(feedback.nackPacketIds).toEqual([100, 101]);
    expect(forwarded).toBe(2);
    expect(producerFeedback).toEqual(['receiver-report', 'nack']);
  });

  it('routes producer Sender Reports downstream to consumers', async () => {
    const router = new RtpRouter();
    const producer = createProducer();
    const consumer = createConsumer(producer);
    const consumerFeedback: string[] = [];
    router.addProducer(producer, async () => undefined);
    router.addConsumer(consumer, async () => undefined, async (_packet, _target, kind) => {
      consumerFeedback.push(kind);
    });

    const forwarded = await router.routeRtcp(
      createSenderReport({
        senderSsrc: 1234,
        ntpTimestamp: 10n,
        rtpTimestamp: 20,
        packetCount: 30,
        octetCount: 40
      })
    );

    expect(forwarded).toBe(1);
    expect(consumerFeedback).toEqual(['sender-report']);
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
