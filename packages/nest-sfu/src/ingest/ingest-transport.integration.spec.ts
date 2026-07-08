import { EventEmitter } from 'node:events';
import { createSocket, type Socket } from 'node:dgram';
import type { DtlsParameters, ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtcpProcessor, RtpRouter, createPli } from '@native-sfu/sfu-core';
import { ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';
import { IngestTransportService } from './ingest-transport.service';
import { MediaService } from '../media.service';
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
});

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
