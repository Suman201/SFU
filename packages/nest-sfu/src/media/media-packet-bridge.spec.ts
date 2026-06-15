import { EventEmitter } from 'events';
import type { Consumer } from '@native-sfu/contracts';
import { ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';
import { NativeSrtpSession } from '../srtp/srtp-session';
import { MediaPacketBridge } from './media-packet-bridge';

describe('MediaPacketBridge', () => {
  it('decrypts inbound SRTP and routes plaintext RTP in order', async () => {
    const { browser, sfu } = pair();
    browser.setOutboundSsrcs([1111]);
    sfu.setInboundSsrcs([1111]);
    const ice = fakeIce();
    const routed: number[] = [];
    const bridge = new MediaPacketBridge({
      transportId: 'transport-1',
      participantId: 'publisher',
      ice: ice as any,
      getSrtpSession: () => sfu,
      onRtp: async (packet) => {
        routed.push(packet.readUInt16BE(2));
        return 1;
      },
      onRtcp: async () => 0
    });
    bridge.on('error', () => undefined);

    ice.emit('data', { message: await browser.protectRtp(rtpPacket(1111, 1)) });
    ice.emit('data', { message: await browser.protectRtp(rtpPacket(1111, 2)) });
    await bridge.waitForIdle();

    expect(routed).toEqual([1, 2]);
    expect(bridge.snapshot().inboundSrtpPackets).toBe(2);
    expect(bridge.snapshot().inboundDecryptedRtpPackets).toBe(2);
    expect(bridge.snapshot().routedRtpPackets).toBe(2);
    bridge.close();
  });

  it('decrypts inbound SRTCP and routes plaintext RTCP', async () => {
    const { browser, sfu } = pair();
    browser.setOutboundSsrcs([2222]);
    sfu.setInboundSsrcs([2222]);
    const ice = fakeIce();
    const routed: Buffer[] = [];
    const bridge = new MediaPacketBridge({
      transportId: 'transport-1',
      participantId: 'publisher',
      ice: ice as any,
      getSrtpSession: () => sfu,
      onRtp: async () => 0,
      onRtcp: async (packet) => {
        routed.push(packet);
        return 1;
      }
    });
    bridge.on('error', () => undefined);

    const rtcp = receiverReport(2222);
    ice.emit('data', { message: await browser.protectRtcp(rtcp) });
    await bridge.waitForIdle();

    expect(routed).toEqual([rtcp]);
    expect(bridge.snapshot().inboundSrtcpPackets).toBe(1);
    expect(bridge.snapshot().inboundDecryptedRtcpPackets).toBe(1);
    bridge.close();
  });

  it('encrypts outbound RTP and sends through ICE', async () => {
    const { browser, sfu } = pair();
    sfu.setOutboundSsrcs([3333]);
    browser.setInboundSsrcs([3333]);
    const ice = fakeIce();
    const bridge = new MediaPacketBridge({
      transportId: 'transport-1',
      participantId: 'subscriber',
      ice: ice as any,
      getSrtpSession: () => sfu,
      onRtp: async () => 0,
      onRtcp: async () => 0
    });
    bridge.on('error', () => undefined);
    const consumer: Consumer = {
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: 'transport-1',
      rtpParameters: {
        codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
        encodings: [{ ssrc: 3333 }],
        rtcp: { cname: 'test', reducedSize: true }
      },
      status: 'live',
      createdAt: new Date().toISOString()
    };

    const rtp = rtpPacket(3333, 9);
    await bridge.sendRtp(rtp, consumer);

    expect(ice.sent.length).toBe(1);
    expect(await browser.unprotectRtp(ice.sent[0]!)).toEqual(rtp);
    expect(bridge.snapshot().outboundRtpPackets).toBe(1);
    bridge.close();
  });
});

function pair(): { browser: NativeSrtpSession; sfu: NativeSrtpSession } {
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
    sfu: new NativeSrtpSession(sfuMaterial)
  };
}

function fakeIce(): EventEmitter & { sent: Buffer[]; sendSelectedDatagram: (packet: Buffer) => Promise<void> } {
  return Object.assign(new EventEmitter(), {
    sent: [] as Buffer[],
    sendSelectedDatagram: jest.fn(async function (this: { sent: Buffer[] }, packet: Buffer) {
      this.sent.push(packet);
    })
  });
}

function rtpPacket(ssrc: number, sequenceNumber: number): Buffer {
  const payload = Buffer.from('bridge-payload');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(123456, 4);
  packet.writeUInt32BE(ssrc, 8);
  payload.copy(packet, 12);
  return packet;
}

function receiverReport(ssrc: number): Buffer {
  const packet = Buffer.alloc(8);
  packet[0] = 0x80;
  packet[1] = 201;
  packet.writeUInt16BE(1, 2);
  packet.writeUInt32BE(ssrc, 4);
  return packet;
}
