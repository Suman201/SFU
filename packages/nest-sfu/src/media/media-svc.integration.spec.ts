import { EventEmitter } from 'events';
import type { ConsumerLayerEvent, DtlsParameters, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtcpProcessor, RtpRouter } from '@native-sfu/sfu-core';
import { MediaService } from '../media.service';
import { SrtpService } from '../srtp.service';

describe('MediaService SVC integration', () => {
  it('exposes VP9 SVC capabilities and relays preferred SVC layer changes', async () => {
    const service = new MediaService(fakeIceService(), fakeDtlsService(), new SrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }));
    const events: ConsumerLayerEvent[] = [];
    service.onConsumerLayerEvent((event) => events.push(event));
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
    const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');
    const producerRtp = vp9SvcRtp();
    await service.bindProducer(publisherTransport.id, 'publisher', producerRtp);
    await service.registerProducer({
      id: 'producer-svc',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters: producerRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    expect(service.producerLayerState('producer-svc')?.svc?.capabilities).toEqual({
      supported: true,
      codec: 'VP9',
      scalabilityMode: 'L3T3_KEY',
      spatialLayerCount: 3,
      temporalLayerCount: 3,
      fallback: 'native_svc',
      canPauseIndividualLayers: false,
      requiresKeyframeForSpatialSwitch: true
    });

    await service.registerConsumer({
      id: 'consumer-svc',
      producerId: 'producer-svc',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      preferredSvcLayers: { spatialLayerId: 0, temporalLayerId: 0 },
      rtpParameters: consumerRtp(),
      status: 'live',
      createdAt: new Date().toISOString()
    });

    const snapshot = await service.setConsumerPreferredSvcLayers('consumer-svc', { spatialLayerId: 2, temporalLayerId: 1 });

    expect(snapshot?.preferredSvcLayers).toEqual({ spatialLayerId: 2, temporalLayerId: 1, qualityLayerId: 2 });
    expect(snapshot?.targetSvcLayers).toEqual({ spatialLayerId: 2, temporalLayerId: 1, qualityLayerId: 2 });
    expect(events.some((event) => event.type === 'switching' && event.targetSvcLayers?.spatialLayerId === 2)).toBe(true);
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

function vp9SvcRtp(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP9', payloadType: 98, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' }, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc: 7777, maxBitrate: 2_700_000, scalabilityMode: 'L3T3_KEY' }],
    rtcp: { cname: 'producer', reducedSize: true }
  };
}

function consumerRtp(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP9', payloadType: 120, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' }, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc: 9000, scalabilityMode: 'L3T3_KEY' }],
    rtcp: { cname: 'consumer', reducedSize: true }
  };
}
