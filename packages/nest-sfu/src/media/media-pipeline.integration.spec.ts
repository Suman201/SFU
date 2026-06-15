import { EventEmitter } from 'events';
import type { DtlsParameters, ProducerKind, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { RtcpProcessor, RtpRouter, createPli } from '@native-sfu/sfu-core';
import { ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';
import { MediaService } from '../media.service';
import { SrtpService } from '../srtp.service';
import { NativeSrtpSession } from '../srtp/srtp-session';

describe('MediaService live media pipeline', () => {
  for (const kind of ['audio', 'video', 'screen'] as ProducerKind[]) {
    it(`routes protected ${kind} RTP from publisher to subscriber and SRTCP feedback upstream`, async () => {
      const ice = fakeIceService();
      const srtp = new SrtpService();
      const service = new MediaService(ice, fakeDtlsService(), srtp, new RtcpProcessor(), new RtpRouter());
      const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
      const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');
      const publisherEdge = srtpPair();
      const subscriberEdge = srtpPair();
      srtp.createSession(publisherTransport.id, publisherEdge.sfuMaterial);
      srtp.createSession(subscriberTransport.id, subscriberEdge.sfuMaterial);
      const rtpParameters = createRtpParameters(kind, 4444, kind === 'audio' ? 111 : 96);
      await service.bindProducer(publisherTransport.id, 'publisher', rtpParameters);
      await service.registerProducer({
        id: `producer-${kind}`,
        roomId: 'room-1',
        participantId: 'publisher',
        kind,
        transportId: publisherTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });
      await service.registerConsumer({
        id: `consumer-${kind}`,
        producerId: `producer-${kind}`,
        participantId: 'subscriber',
        roomId: 'room-1',
        transportId: subscriberTransport.id,
        rtpParameters,
        status: 'live',
        createdAt: new Date().toISOString()
      });
      publisherEdge.browser.setOutboundSsrcs([4444]);
      subscriberEdge.browser.setInboundSsrcs([4444]);

      const rtp = rtpPacket(4444, kind === 'audio' ? 111 : 96, 10, 90_000);
      ice.agent(publisherTransport.id).emit('data', { message: await publisherEdge.browser.protectRtp(rtp) });
      await service.waitForMediaIdle(publisherTransport.id, 'publisher');

      const subscriberDatagram = await waitForDatagram(ice.agent(subscriberTransport.id));
      expect(await subscriberEdge.browser.unprotectRtp(subscriberDatagram)).toEqual(rtp);
      expect(service.mediaCounters(publisherTransport.id, 'publisher').routedRtpPackets).toBe(1);
      expect(service.mediaCounters(subscriberTransport.id, 'subscriber').outboundRtpPackets).toBe(1);

      const pli = createPli({ senderSsrc: 9999, mediaSsrc: 4444 });
      ice.agent(subscriberTransport.id).emit('data', { message: await subscriberEdge.browser.protectRtcp(pli) });
      await service.waitForMediaIdle(subscriberTransport.id, 'subscriber');

      const publisherDatagram = await waitForDatagram(ice.agent(publisherTransport.id));
      expect(await publisherEdge.browser.unprotectRtcp(publisherDatagram)).toEqual(pli);
      expect(service.mediaCounters(subscriberTransport.id, 'subscriber').routedRtcpPackets).toBe(1);
      expect(service.mediaCounters(publisherTransport.id, 'publisher').outboundRtcpPackets).toBe(1);
    });
  }
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
  const payload = Buffer.from('media-pipeline');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  payload.copy(packet, 12);
  return packet;
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
