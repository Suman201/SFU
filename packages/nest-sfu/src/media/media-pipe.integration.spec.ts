import { EventEmitter } from 'events';
import type { DtlsParameters, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { PipeTransportManager, RtcpProcessor, RtpPacket, RtpRouter, createPli } from '@native-sfu/sfu-core';
import { MediaService } from '../media.service';
import { PipeTransportService } from '../pipe-transport.service';

describe('MediaService pipe transport integration', () => {
  it('bridges owner RTP to a remote local subscriber and routes remote RTCP back to the owner producer', async () => {
    const pipeManager = new PipeTransportManager();
    const pipe = new PipeTransportService(pipeManager);
    const owner = new MediaService(fakeIceService(), fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const remoteIce = fakeIceService();
    const remoteDrops: string[] = [];
    const remote = new MediaService(
      remoteIce,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, onDroppedPacket: (reason) => remoteDrops.push(reason) }),
      pipe
    );
    const ownerPipe = pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remotePipe = pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    pipe.connectTransports(ownerPipe, remotePipe);

    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    pipe.createProducer('pipe-owner', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    pipe.createProducer('pipe-remote', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp,
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    const remotePipeRtp = new Promise<number>((resolve, reject) => {
      pipe.onRtp('pipe-remote', (event) => {
        remote.handlePipeRtp('pipe-remote', event.producerId, event.packet).then(resolve, reject);
      });
    });
    pipe.onRtcp('pipe-owner', (event) => {
      void owner.handlePipeRtcp('pipe-owner', event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' });
    });

    const ownerPublisher = await owner.createWebRtcTransport('room-1', 'publisher');
    await owner.bindProducer(ownerPublisher.id, 'publisher', sourceRtp);
    await owner.registerProducer(producer('producer-1', 'room-1', 'publisher', ownerPublisher.id, sourceRtp));
    await remote.registerPipeProducer(producer('producer-1', 'room-1', 'publisher', 'pipe-remote', pipeRtp), 'pipe-remote');
    expect(remote.producerLayerState('producer-1')?.availableLayers[0]?.ssrc).toBe(2222);
    const remoteSubscriber = await remote.createWebRtcTransport('room-1', 'subscriber');
    await remote.registerConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: remoteSubscriber.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    expect(await pipe.sendRtp('pipe-owner', 'producer-1', rtpPacket(2222, 10, 90_000))).toBe(true);
    const forwardedCount = await remotePipeRtp;
    expect({ forwardedCount, remoteDrops }).toEqual({ forwardedCount: 1, remoteDrops: [] });
    await waitFor(() => remoteIce.agent(remoteSubscriber.id).sent.length > 0);

    const forwarded = RtpPacket.parse(remoteIce.agent(remoteSubscriber.id).sent.shift()!);
    expect(forwarded.ssrc).toBe(2222);
    expect(forwarded.sequenceNumber).toBe(10);
    expect(forwarded.timestamp).toBe(90_000);

    await remote.handleRtcp(remoteSubscriber.id, 'subscriber', createPli({ senderSsrc: 9999, mediaSsrc: 2222 }));
    await waitFor(() => fakeAgent(owner, ownerPublisher.id).sent.length > 0);
    expect(fakeAgent(owner, ownerPublisher.id).sent[0]).toEqual(createPli({ senderSsrc: 9999, mediaSsrc: 1111 }));
  });

  it('bridges remote publisher RTP to an owner subscriber and routes owner RTCP back to the remote producer', async () => {
    const pipeManager = new PipeTransportManager();
    const pipe = new PipeTransportService(pipeManager);
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const owner = new MediaService(ownerIce, fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const remote = new MediaService(remoteIce, fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const ownerPipe = pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remotePipe = pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    pipe.connectTransports(ownerPipe, remotePipe);

    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    pipe.createProducer('pipe-owner', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp,
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    pipe.createProducer('pipe-remote', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    const ownerPipeRtp = new Promise<number>((resolve, reject) => {
      pipe.onRtp('pipe-owner', (event) => {
        owner.handlePipeRtp('pipe-owner', event.producerId, event.packet).then(resolve, reject);
      });
    });
    pipe.onRtcp('pipe-remote', (event) => {
      void remote.handlePipeRtcp('pipe-remote', event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' });
    });

    const remotePublisher = await remote.createWebRtcTransport('room-1', 'publisher');
    await remote.bindProducer(remotePublisher.id, 'publisher', sourceRtp);
    await remote.registerProducer(producer('producer-1', 'room-1', 'publisher', remotePublisher.id, sourceRtp));
    await owner.registerPipeProducer(producer('producer-1', 'room-1', 'publisher', 'pipe-owner', pipeRtp), 'pipe-owner');
    const ownerSubscriber = await owner.createWebRtcTransport('room-1', 'subscriber');
    await owner.registerConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: ownerSubscriber.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await remote.registerPipeConsumer({
      id: 'pipe-consumer-1',
      producerId: 'producer-1',
      participantId: 'pipe:node-a',
      roomId: 'room-1',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-remote');

    expect(await pipe.sendRtp('pipe-remote', 'producer-1', rtpPacket(2222, 10, 90_000))).toBe(true);
    const forwardedCount = await ownerPipeRtp;
    expect(forwardedCount).toBe(1);
    await waitFor(() => ownerIce.agent(ownerSubscriber.id).sent.length > 0);

    const delivered = RtpPacket.parse(ownerIce.agent(ownerSubscriber.id).sent.shift()!);
    expect(delivered.ssrc).toBe(2222);
    expect(delivered.sequenceNumber).toBe(10);
    expect(delivered.timestamp).toBe(90_000);

    await owner.handleRtcp(ownerSubscriber.id, 'subscriber', createPli({ senderSsrc: 9999, mediaSsrc: 2222 }));
    await waitFor(() => fakeAgent(remote, remotePublisher.id).sent.length > 0);
    expect(fakeAgent(remote, remotePublisher.id).sent[0]).toEqual(createPli({ senderSsrc: 9999, mediaSsrc: 1111 }));
  });
});

function producer(id: string, roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
  return {
    id,
    roomId,
    participantId,
    kind: 'audio',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rtpParameters(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-audio', reducedSize: true }
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 111, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('pipe-media')).serialize();
}

function fakeAgent(service: MediaService, transportId: string): FakeIceAgent {
  const ice = (service as unknown as { ice: ReturnType<typeof fakeIceService> }).ice;
  return ice.agent(transportId);
}

interface FakeIceAgent extends EventEmitter {
  sent: Buffer[];
  snapshot: () => {
    localParameters: TransportOptions['iceParameters'];
    localCandidates: TransportOptions['iceCandidates'];
  };
  sendSelectedDatagram: (packet: Buffer) => Promise<void>;
}

function fakeIceService(): any {
  const agents = new Map<string, FakeIceAgent>();
  return {
    createAgent: jest.fn(async (transportId: string) => {
      const agent = Object.assign(new EventEmitter(), {
        sent: [] as Buffer[],
        snapshot: () => ({
          localParameters: { usernameFragment: `ufrag-${transportId}`, password: `pwd-${transportId}`, iceLite: false },
          localCandidates: []
        }),
        sendSelectedDatagram: jest.fn(async function (this: FakeIceAgent, packet: Buffer) {
          this.sent.push(packet);
        })
      }) as FakeIceAgent;
      agents.set(transportId, agent);
      return agent;
    }),
    validateCandidate: jest.fn(),
    addRemoteCandidate: jest.fn(),
    setRemoteParameters: jest.fn(),
    restartAgent: jest.fn(),
    closeAgent: jest.fn(),
    agent: (transportId: string) => {
      const agent = agents.get(transportId);
      if (!agent) {
        throw new Error(`Missing fake ICE agent ${transportId}`);
      }
      return agent;
    }
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

function fakeSrtpService(): any {
  const session = {
    setInboundSsrcs: jest.fn(),
    setOutboundSsrcs: jest.fn(),
    protectRtp: jest.fn(async (packet: Buffer) => packet),
    protectRtcp: jest.fn(async (packet: Buffer) => packet),
    unprotectRtp: jest.fn(async (packet: Buffer) => packet),
    unprotectRtcp: jest.fn(async (packet: Buffer) => packet)
  };
  return {
    createSession: jest.fn(() => session),
    getSession: jest.fn(() => session),
    closeSession: jest.fn()
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for pipe media event');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
