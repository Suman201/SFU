import { RtpPacket } from '../rtp/rtp-packet';
import { detectKeyframe } from './keyframe-detector';

describe('keyframe detector', () => {
  it('detects VP8 keyframes', () => {
    expect(detectKeyframe(packet(Buffer.from([0x10, 0x00])), 'video/VP8')).toEqual({ codec: 'VP8', keyframe: true });
    expect(detectKeyframe(packet(Buffer.from([0x10, 0x01])), 'video/VP8')).toEqual({ codec: 'VP8', keyframe: false });
  });

  it('detects H264 IDR frames', () => {
    expect(detectKeyframe(packet(Buffer.from([0x65, 0x88])), 'video/H264')).toEqual({ codec: 'H264', keyframe: true });
    expect(detectKeyframe(packet(Buffer.from([0x41, 0x9a])), 'video/H264')).toEqual({ codec: 'H264', keyframe: false });
  });

  it('detects VP9 keyframes', () => {
    expect(detectKeyframe(packet(Buffer.from([0x08, 0x00])), 'video/VP9')).toEqual({ codec: 'VP9', keyframe: true });
    expect(detectKeyframe(packet(Buffer.from([0x48, 0x00])), 'video/VP9')).toEqual({ codec: 'VP9', keyframe: false });
  });
});

function packet(payload: Buffer): RtpPacket {
  return new RtpPacket(2, false, false, false, 96, 1, 1000, 1111, [], null, payload);
}
