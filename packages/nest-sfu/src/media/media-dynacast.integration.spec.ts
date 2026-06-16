import { EventEmitter } from 'events';
import type { DtlsParameters, ProducerDynacastEvent, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtcpProcessor, RtpRouter } from '@native-sfu/sfu-core';
import { MediaService } from '../media.service';
import { SrtpService } from '../srtp.service';

describe('MediaService dynacast integration', () => {
  it('relays producer dynacast demand from consumer lifecycle changes', async () => {
    const service = new MediaService(fakeIceService(), fakeDtlsService(), new SrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }));
    const events: ProducerDynacastEvent[] = [];
    service.onProducerDynacastEvent((event) => events.push(event));
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
    const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');
    const producerRtp = simulcastRtp();
    await service.bindProducer(publisherTransport.id, 'publisher', producerRtp);
    await service.registerProducer({
      id: 'producer-video',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters: producerRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    await service.registerConsumer({
      id: 'consumer-high',
      producerId: 'producer-video',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      preferredLayers: { spatialLayer: 2 },
      targetLayers: { spatialLayer: 2 },
      rtpParameters: consumerRtp(),
      status: 'live',
      createdAt: new Date().toISOString()
    });

    expect(events.some((event) => event.type === 'layers-needed' && event.neededLayers.some((layer) => layer.spatialLayer === 2))).toBe(true);
    expect(service.producerLayerState('producer-video')?.dynacast?.desiredLayers).toEqual([{ spatialLayer: 2, temporalLayer: undefined }]);

    await service.setConsumerPreferredLayers('consumer-high', { spatialLayer: 0 });
    expect(events.some((event) => event.type === 'layers-unneeded' && event.unneededLayers.some((layer) => layer.spatialLayer === 2))).toBe(true);
    expect(service.adaptiveTransportMetrics().producerLayers[0]?.dynacast?.desiredLayers).toEqual([{ spatialLayer: 0, temporalLayer: undefined }]);

    await service.unregisterConsumer('consumer-high');
    expect(service.producerLayerState('producer-video')?.dynacast?.desiredLayers).toEqual([]);
  });
});

interface FakeIceAgent extends EventEmitter {
  snapshot: () => {
    localParameters: TransportOptions['iceParameters'];
    localCandidates: TransportOptions['iceCandidates'];
  };
  sendSelectedDatagram: (packet: Buffer) => Promise<void>;
}

function fakeIceService(): any {
  return {
    createAgent: jest.fn(async (transportId: string) =>
      Object.assign(new EventEmitter(), {
        snapshot: () => ({
          localParameters: { usernameFragment: `ufrag-${transportId}`, password: `pwd-${transportId}`, iceLite: false },
          localCandidates: []
        }),
        sendSelectedDatagram: jest.fn()
      }) as FakeIceAgent
    ),
    validateCandidate: jest.fn(),
    addRemoteCandidate: jest.fn(),
    setRemoteParameters: jest.fn(),
    restartAgent: jest.fn(),
    closeAgent: jest.fn()
  };
}

function fakeDtlsService(): any {
  return {
    createTransport: jest.fn(async (transportId: string) =>
      Object.assign(new EventEmitter(), {
        transportId
      })
    ),
    createParameters: jest.fn(async (): Promise<DtlsParameters> => ({ role: 'auto', fingerprints: [] })),
    setRemoteParameters: jest.fn(),
    closeTransport: jest.fn()
  };
}

function simulcastRtp(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [
      { rid: 'low', ssrc: 1111, spatialLayer: 0, maxBitrate: 250_000 },
      { rid: 'medium', ssrc: 2222, spatialLayer: 1, maxBitrate: 900_000 },
      { rid: 'high', ssrc: 3333, spatialLayer: 2, maxBitrate: 2_500_000 }
    ],
    simulcast: { direction: 'send', rids: ['low', 'medium', 'high'] },
    rtcp: { cname: 'producer', reducedSize: true }
  };
}

function consumerRtp(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 120, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc: 9000 }],
    rtcp: { cname: 'consumer', reducedSize: true }
  };
}
