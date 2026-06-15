import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80 } from 'werift-dtls/lib/rtp/src/srtp/const';
import { ReplayProtectionError } from './replay-window';
import { NativeSrtpSession, SrtpAuthenticationError, SrtpSsrcValidationError } from './srtp-session';
import type { DtlsSrtpKeyingMaterial } from '../dtls/dtls.types';

describe('NativeSrtpSession', () => {
  for (const profile of [ProtectionProfileAes128CmHmacSha1_80, ProtectionProfileAeadAes128Gcm]) {
    it(`protects and unprotects RTP with profile ${profile}`, async () => {
      const { sender, receiver } = pair(profile);
      sender.setOutboundSsrcs([1111]);
      receiver.setInboundSsrcs([1111]);
      const rtp = rtpPacket(1111, 3456, 123);

      const protectedPacket = await sender.protectRtp(rtp);
      const unprotected = await receiver.unprotectRtp(protectedPacket);

      expect(protectedPacket.equals(rtp)).toBe(false);
      expect(unprotected).toEqual(rtp);
    });

    it(`protects and unprotects SRTCP with profile ${profile}`, async () => {
      const { sender, receiver } = pair(profile);
      sender.setOutboundSsrcs([2222]);
      receiver.setInboundSsrcs([2222]);
      const rtcp = receiverReport(2222);

      const protectedPacket = await sender.protectRtcp(rtcp);
      const unprotected = await receiver.unprotectRtcp(protectedPacket);

      expect(protectedPacket.equals(rtcp)).toBe(false);
      expect(unprotected).toEqual(rtcp);
    });
  }

  it('rejects tampered RTP authentication tags', async () => {
    const { sender, receiver } = pair(ProtectionProfileAes128CmHmacSha1_80);
    const protectedPacket = await sender.protectRtp(rtpPacket(3333, 1, 9000));
    protectedPacket[protectedPacket.length - 1] = protectedPacket[protectedPacket.length - 1]! ^ 0xff;

    await expectRejected(receiver.unprotectRtp(protectedPacket), SrtpAuthenticationError);
  });

  it('rejects RTP replay', async () => {
    const { sender, receiver } = pair(ProtectionProfileAes128CmHmacSha1_80);
    const protectedPacket = await sender.protectRtp(rtpPacket(4444, 1, 9000));

    await receiver.unprotectRtp(protectedPacket);

    await expectRejected(receiver.unprotectRtp(protectedPacket), ReplayProtectionError);
  });

  it('rejects unexpected inbound RTP SSRCs', async () => {
    const { sender, receiver } = pair(ProtectionProfileAes128CmHmacSha1_80);
    receiver.setInboundSsrcs([5555]);
    const protectedPacket = await sender.protectRtp(rtpPacket(7777, 1, 9000));

    await expectRejected(receiver.unprotectRtp(protectedPacket), SrtpSsrcValidationError);
  });
});

function pair(profile: number): { sender: NativeSrtpSession; receiver: NativeSrtpSession } {
  const senderKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const receiverKey = Buffer.from('102132435465768798a9babbdcdef0f1', 'hex');
  const senderSalt = Buffer.from(profile === ProtectionProfileAeadAes128Gcm ? '00112233445566778899aabb' : '00112233445566778899aabbccdd', 'hex');
  const receiverSalt = Buffer.from(profile === ProtectionProfileAeadAes128Gcm ? '102132435465768798a9babb' : '102132435465768798a9babbdcde', 'hex');
  const senderMaterial: DtlsSrtpKeyingMaterial = {
    profile,
    localKey: senderKey,
    localSalt: senderSalt,
    remoteKey: receiverKey,
    remoteSalt: receiverSalt
  };
  const receiverMaterial: DtlsSrtpKeyingMaterial = {
    profile,
    localKey: receiverKey,
    localSalt: receiverSalt,
    remoteKey: senderKey,
    remoteSalt: senderSalt
  };
  return {
    sender: new NativeSrtpSession(senderMaterial),
    receiver: new NativeSrtpSession(receiverMaterial)
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  const payload = Buffer.from('hello-srtp');
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = 96;
  packet.writeUInt16BE(sequenceNumber, 2);
  packet.writeUInt32BE(timestamp, 4);
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

async function expectRejected(promise: Promise<unknown>, errorType: new (...args: any[]) => Error): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(errorType);
    return;
  }
  throw new Error(`Expected promise to reject with ${errorType.name}`);
}
