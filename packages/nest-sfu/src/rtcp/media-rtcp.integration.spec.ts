import type { Producer, RtpParameters } from '@native-sfu/contracts';
import { RtcpProcessor, RtpRouter } from '@native-sfu/sfu-core';
import { createPli } from '@native-sfu/sfu-core';
import { EventEmitter } from 'events';
import { MediaService } from '../media.service';

describe('MediaService RTCP integration', () => {
  it('processes decrypted RTCP and routes feedback through the RTP router', async () => {
    const service = new MediaService(
      fakeIceService(),
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter()
    );
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
    const viewerTransport = await service.createWebRtcTransport('room-1', 'viewer');
    const rtpParameters = createRtpParameters();
    const producer: Producer = {
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    };
    await service.bindProducer(publisherTransport.id, 'publisher', rtpParameters);
    await service.registerProducer(producer);
    await service.registerConsumer({
      id: 'consumer-1',
      producerId: producer.id,
      participantId: 'viewer',
      roomId: 'room-1',
      transportId: viewerTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    const result = await service.handleRtcp(viewerTransport.id, 'viewer', createPli({ senderSsrc: 9999, mediaSsrc: 1234 }));

    expect(result.feedback.pliSsrcs).toEqual([1234]);
    expect(result.forwarded).toBe(1);
  });
});

function createRtpParameters(): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
    encodings: [{ rid: 'high', ssrc: 1234 }],
    rtcp: { cname: 'test', reducedSize: true }
  };
}

function fakeIceService(): any {
  return {
    createAgent: jest.fn(async () => Object.assign(new EventEmitter(), {
      snapshot: () => ({
        localParameters: { usernameFragment: 'local', password: 'local-password', iceLite: true },
        localCandidates: []
      }),
      sendSelectedDatagram: jest.fn()
    })),
    validateCandidate: jest.fn(),
    addRemoteCandidate: jest.fn(),
    setRemoteParameters: jest.fn(),
    restartAgent: jest.fn()
  };
}

function fakeDtlsService(): any {
  return {
    createTransport: jest.fn(async (transportId: string) => ({
      transportId,
      on: jest.fn()
    })),
    createParameters: jest.fn(async () => ({
      role: 'auto',
      fingerprints: []
    })),
    setRemoteParameters: jest.fn(),
    closeTransport: jest.fn()
  };
}

function fakeSrtpService(): any {
  const session = {
    setInboundSsrcs: jest.fn(),
    setOutboundSsrcs: jest.fn(),
    protectRtp: jest.fn(async (packet: Buffer) => packet),
    protectRtcp: jest.fn(async (packet: Buffer) => packet)
  };
  return {
    createSession: jest.fn(() => session),
    getSession: jest.fn(() => session),
    closeSession: jest.fn()
  };
}
