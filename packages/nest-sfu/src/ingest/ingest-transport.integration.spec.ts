import { EventEmitter } from 'node:events';
import { createSocket, type Socket } from 'node:dgram';
import type { DtlsParameters, ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { PipeTransportManager, RtcpProcessor, RtpRouter, createPli } from '@native-sfu/sfu-core';
import { ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';
import { IngestTransportService } from './ingest-transport.service';
import { MediaService } from '../media.service';
import { PipeTransportService } from '../pipe-transport.service';
import { SrtpService } from '../srtp.service';
import { NativeSrtpSession } from '../srtp/srtp-session';

describe('Trusted ingest transport integration', () => {
  it('routes local RTP into the SFU and forwards RTCP feedback back to the ingest source', async () => {
    const ice = fakeIceService();
    const srtp = new SrtpService();
    const media = new MediaService(ice, fakeDtlsService(), srtp, new RtcpProcessor(), new RtpRouter());
    const ingest = new IngestTransportService(media as never);
    const subscriberTransport = await media.createWebRtcTransport('room-1', 'subscriber');
    const subscriberEdge = srtpPair();
    srtp.createSession(subscriberTransport.id, subscriberEdge.sfuMaterial);
    const ingestTransport = await ingest.createTransport({ roomId: 'room-1', participantId: 'publisher' });
    const rtpParameters = createRtpParameters('video', 4444, 96);
    await media.bindProducer(ingestTransport.id, 'publisher', rtpParameters);
    await media.registerProducer({
      id: 'producer-video',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: ingestTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await media.registerConsumer({
      id: 'consumer-video',
      producerId: 'producer-video',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    subscriberEdge.browser.setInboundSsrcs([4444]);

    const publisherSocket = createSocket('udp4');
    await bindSocket(publisherSocket);

    try {
      const rtp = rtpPacket(4444, 96, 10, 90_000);
      await sendSocket(publisherSocket, rtp, ingestTransport.rtpPort, ingestTransport.listenAddress);

      const subscriberDatagram = await waitForDatagram(ice.agent(subscriberTransport.id));
      expect(await subscriberEdge.browser.unprotectRtp(subscriberDatagram)).toEqual(rtp);

      const pli = createPli({ senderSsrc: 9999, mediaSsrc: 4444 });
      const publisherRtcp = waitForMessage(publisherSocket);
      ice.agent(subscriberTransport.id).emit('data', { message: await subscriberEdge.browser.protectRtcp(pli) });
      await media.waitForMediaIdle(subscriberTransport.id, 'subscriber');

      expect(await publisherRtcp).toEqual(pli);
      expect(ingest.snapshot(ingestTransport.id)?.counters.inboundRtpPackets).toBe(1);
      expect(ingest.snapshot(ingestTransport.id)?.counters.outboundRtcpPackets).toBe(1);
    } finally {
      await ingest.closeTransport(ingestTransport.id);
      await closeSocket(publisherSocket);
    }
  });

  it('fans out trusted ingest media to multiple subscribers and cleans the room on close', async () => {
    const harness = createMediaHarness();
    const ingest = new IngestTransportService(harness.media as never);
    const subscriberATransport = await harness.media.createWebRtcTransport('room-1', 'subscriber-a');
    const subscriberBTransport = await harness.media.createWebRtcTransport('room-1', 'subscriber-b');
    const subscriberAEdge = srtpPair();
    const subscriberBEdge = srtpPair();
    harness.srtp.createSession(subscriberATransport.id, subscriberAEdge.sfuMaterial);
    harness.srtp.createSession(subscriberBTransport.id, subscriberBEdge.sfuMaterial);
    const ingestTransport = await ingest.createTransport({ roomId: 'room-1', participantId: 'publisher' });
    const rtpParameters = createRtpParameters('video', 4444, 96);
    await harness.media.bindProducer(ingestTransport.id, 'publisher', rtpParameters);
    await harness.media.registerProducer({
      id: 'producer-video',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: ingestTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await harness.media.registerConsumer({
      id: 'consumer-video-a',
      producerId: 'producer-video',
      participantId: 'subscriber-a',
      roomId: 'room-1',
      transportId: subscriberATransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await harness.media.registerConsumer({
      id: 'consumer-video-b',
      producerId: 'producer-video',
      participantId: 'subscriber-b',
      roomId: 'room-1',
      transportId: subscriberBTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    subscriberAEdge.browser.setInboundSsrcs([4444]);
    subscriberBEdge.browser.setInboundSsrcs([4444]);

    const publisherSocket = createSocket('udp4');
    await bindSocket(publisherSocket);

    try {
      const rtp = rtpPacket(4444, 96, 20, 91_000);
      await sendSocket(publisherSocket, rtp, ingestTransport.rtpPort, ingestTransport.listenAddress);

      const [subscriberADatagram, subscriberBDatagram] = await Promise.all([
        waitForDatagram(harness.ice.agent(subscriberATransport.id)),
        waitForDatagram(harness.ice.agent(subscriberBTransport.id))
      ]);
      expect(await subscriberAEdge.browser.unprotectRtp(subscriberADatagram)).toEqual(rtp);
      expect(await subscriberBEdge.browser.unprotectRtp(subscriberBDatagram)).toEqual(rtp);

      const summary = await harness.media.closeRoom('room-1');
      expect(summary.transportCount).toBe(3);
      expect(summary.consumerCount).toBe(2);
      expect(summary.producerCounts.video).toBe(1);
      expect(summary.participantIds.includes('publisher')).toBe(true);
      expect(summary.participantIds.includes('subscriber-a')).toBe(true);
      expect(summary.participantIds.includes('subscriber-b')).toBe(true);
      expect(harness.media.workerPoolSnapshot().activeRooms).toBe(0);
      expect(ingest.snapshot(ingestTransport.id)).toBeUndefined();
    } finally {
      await closeSocket(publisherSocket);
    }
  });

  it('repeats trusted ingest startup and room cleanup without leaking active rooms', async () => {
    const harness = createMediaHarness();
    const ingest = new IngestTransportService(harness.media as never);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const roomId = `room-loop-${iteration}`;
      const subscriberId = `subscriber-${iteration}`;
      const transport = await harness.media.createWebRtcTransport(roomId, subscriberId);
      const edge = srtpPair();
      harness.srtp.createSession(transport.id, edge.sfuMaterial);
      const ingestTransport = await ingest.createTransport({ roomId, participantId: 'publisher' });
      const rtpParameters = createRtpParameters('video', 5000 + iteration, 96);
      await harness.media.bindProducer(ingestTransport.id, 'publisher', rtpParameters);
      await harness.media.registerProducer({
        id: `producer-${iteration}`,
        roomId,
        participantId: 'publisher',
        kind: 'video',
        transportId: ingestTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });
      await harness.media.registerConsumer({
        id: `consumer-${iteration}`,
        producerId: `producer-${iteration}`,
        participantId: subscriberId,
        roomId,
        transportId: transport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });
      edge.browser.setInboundSsrcs([5000 + iteration]);
      const publisherSocket = createSocket('udp4');
      await bindSocket(publisherSocket);

      try {
        const rtp = rtpPacket(5000 + iteration, 96, 100 + iteration, 92_000 + iteration);
        await sendSocket(publisherSocket, rtp, ingestTransport.rtpPort, ingestTransport.listenAddress);
        expect(await edge.browser.unprotectRtp(await waitForDatagram(harness.ice.agent(transport.id)))).toEqual(rtp);
        const summary = await harness.media.closeRoom(roomId);
        expect(summary.transportCount).toBe(2);
        expect(summary.consumerCount).toBe(1);
        expect(summary.producerCounts.video).toBe(1);
        expect(harness.media.workerPoolSnapshot().activeRooms).toBe(0);
        expect(ingest.snapshot(ingestTransport.id)).toBeUndefined();
      } finally {
        await closeSocket(publisherSocket);
      }
    }
  });

  it('forwards trusted ingest media over the distributed pipe path to a remote subscriber and returns RTCP upstream', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    const owner = createMediaHarness(pipe);
    const remote = createMediaHarness(pipe);
    const ingest = new IngestTransportService(owner.media as never);
    const roomId = 'room-distributed-ingest';
    const ownerPipeId = 'pipe-owner-ingest';
    const remotePipeId = 'pipe-remote-ingest';
    const asyncErrors: string[] = [];

    pipe.createUdpTransport({
      id: ownerPipeId,
      roomId,
      localNodeId: 'node-a',
      remoteNodeId: 'node-b',
      listenIp: '127.0.0.1',
      listenPort: 0,
      peerToken: 'ingest-phase-7-token',
      authMode: 'token'
    });
    pipe.createUdpTransport({
      id: remotePipeId,
      roomId,
      localNodeId: 'node-b',
      remoteNodeId: 'node-a',
      listenIp: '127.0.0.1',
      listenPort: 0,
      peerToken: 'ingest-phase-7-token',
      authMode: 'token'
    });
    const ownerEndpoint = await pipe.listenUdpTransport(ownerPipeId);
    const remoteEndpoint = await pipe.listenUdpTransport(remotePipeId);
    pipe.connectUdpTransport(ownerPipeId, { address: '127.0.0.1', port: remoteEndpoint.port, nodeId: 'node-b' });
    pipe.connectUdpTransport(remotePipeId, { address: '127.0.0.1', port: ownerEndpoint.port, nodeId: 'node-a' });
    const unsubscribeRtp = pipe.onUdpRtp(remotePipeId, (event) => {
      void remote.media.handlePipeRtp(remotePipeId, event.producerId, event.packet).catch((error) => {
        asyncErrors.push(error instanceof Error ? error.message : String(error));
      });
    });
    const unsubscribeRtcp = pipe.onUdpRtcp(ownerPipeId, (event) => {
      void owner.media.handlePipeRtcp(ownerPipeId, event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' }).catch((error) => {
        asyncErrors.push(error instanceof Error ? error.message : String(error));
      });
    });
    const subscriberTransport = await remote.media.createWebRtcTransport(roomId, 'subscriber');
    const subscriberEdge = srtpPair();
    remote.srtp.createSession(subscriberTransport.id, subscriberEdge.sfuMaterial);
    const ingestTransport = await ingest.createTransport({ roomId, participantId: 'publisher' });
    const rtpParameters = createRtpParameters('video', 4444, 96);
    await owner.media.bindProducer(ingestTransport.id, 'publisher', rtpParameters);
    await owner.media.registerProducer({
      id: 'producer-video',
      roomId,
      participantId: 'publisher',
      kind: 'video',
      transportId: ingestTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    pipe.createProducer(ownerPipeId, {
      id: 'producer-video',
      participantId: 'publisher',
      rtpParameters
    });
    pipe.createProducer(remotePipeId, {
      id: 'producer-video',
      participantId: 'publisher',
      rtpParameters
    });
    await owner.media.registerPipeConsumer(
      {
        id: 'pipe-consumer-video',
        roomId,
        producerId: 'producer-video',
        participantId: 'pipe:node-b',
        transportId: ownerPipeId,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      },
      ownerPipeId
    );
    await remote.media.registerPipeProducer(
      {
        id: 'producer-video',
        roomId,
        participantId: 'publisher',
        kind: 'video',
        transportId: remotePipeId,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      },
      remotePipeId
    );
    await remote.media.registerConsumer({
      id: 'remote-consumer-video',
      producerId: 'producer-video',
      participantId: 'subscriber',
      roomId,
      transportId: subscriberTransport.id,
      rtpParameters,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    subscriberEdge.browser.setInboundSsrcs([4444]);

    const publisherSocket = createSocket('udp4');
    await bindSocket(publisherSocket);

    try {
      const rtp = rtpPacket(4444, 96, 30, 92_000);
      await sendSocket(publisherSocket, rtp, ingestTransport.rtpPort, ingestTransport.listenAddress);
      expect(await subscriberEdge.browser.unprotectRtp(await waitForDatagram(remote.ice.agent(subscriberTransport.id)))).toEqual(rtp);

      const pli = createPli({ senderSsrc: 9999, mediaSsrc: 4444 });
      const publisherRtcp = waitForMessage(publisherSocket);
      remote.ice.agent(subscriberTransport.id).emit('data', { message: await subscriberEdge.browser.protectRtcp(pli) });
      await remote.media.waitForMediaIdle(subscriberTransport.id, 'subscriber');

      expect(await publisherRtcp).toEqual(pli);
      expect(pipe.getUdpTransport(ownerPipeId)?.snapshot().sentRtpPackets ?? 0).toBeGreaterThan(0);
      expect(pipe.getUdpTransport(remotePipeId)?.snapshot().rtpPackets ?? 0).toBeGreaterThan(0);
      expect(pipe.getUdpTransport(remotePipeId)?.snapshot().sentRtcpPackets ?? 0).toBeGreaterThan(0);
      expect(pipe.getUdpTransport(ownerPipeId)?.snapshot().rtcpPackets ?? 0).toBeGreaterThan(0);
      expect(asyncErrors).toEqual([]);
    } finally {
      unsubscribeRtp();
      unsubscribeRtcp();
      pipe.closeRoom(roomId);
      await owner.media.closeRoom(roomId).catch(() => undefined);
      await remote.media.closeRoom(roomId).catch(() => undefined);
      await closeSocket(publisherSocket);
    }
  });
});

function createMediaHarness(pipe?: PipeTransportService): {
  ice: ReturnType<typeof fakeIceService>;
  srtp: SrtpService;
  media: MediaService;
} {
  const ice = fakeIceService();
  const srtp = new SrtpService();
  const media = new MediaService(ice as never, fakeDtlsService(), srtp, new RtcpProcessor(), new RtpRouter(), pipe as never);
  return { ice, srtp, media };
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

function createRtpParameters(kind: ProducerKind, ssrc: number, payloadType: number): RtpParameters {
  return {
    codecs: [
      {
        mimeType: kind === 'audio' ? 'audio/opus' : 'video/VP8',
        payloadType,
        clockRate: kind === 'audio' ? 48000 : 90000,
        channels: kind === 'audio' ? 2 : undefined
      }
    ],
    encodings: [{ ssrc, rid: kind === 'audio' ? undefined : 'high' }],
    rtcp: { cname: `${kind}-cname`, reducedSize: true }
  };
}

function srtpPair(): { browser: NativeSrtpSession; sfuMaterial: DtlsSrtpKeyingMaterial } {
  const browserKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const sfuKey = Buffer.from('102132435465768798a9babbdcdef0f1', 'hex');
  const browserSalt = Buffer.from('00112233445566778899aabbccdd', 'hex');
  const sfuSalt = Buffer.from('102132435465768798a9babbdcde', 'hex');
  const browserMaterial: DtlsSrtpKeyingMaterial = {
    profile: ProtectionProfileAes128CmHmacSha1_80,
    localKey: browserKey,
    localSalt: browserSalt,
    remoteKey: sfuKey,
    remoteSalt: sfuSalt
  };
  const sfuMaterial: DtlsSrtpKeyingMaterial = {
    profile: ProtectionProfileAes128CmHmacSha1_80,
    localKey: sfuKey,
    localSalt: sfuSalt,
    remoteKey: browserKey,
    remoteSalt: browserSalt
  };
  return {
    browser: new NativeSrtpSession(browserMaterial),
    sfuMaterial
  };
}

function rtpPacket(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number): Buffer {
  const payload = Buffer.from('trusted-ingest');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  payload.copy(packet, 12);
  return packet;
}

function bindSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('listening', onListening);
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(0, '127.0.0.1');
  });
}

function sendSocket(socket: Socket, packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

function waitForMessage(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once('message', (message) => resolve(Buffer.from(message)));
  });
}

async function waitForDatagram(agent: FakeIceAgent): Promise<Buffer> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const packet = agent.sent.shift();
    if (packet) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for outbound media datagram');
}
