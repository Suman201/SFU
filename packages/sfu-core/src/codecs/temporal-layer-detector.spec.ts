import { RtpPacket } from '../rtp/rtp-packet';
import { detectTemporalLayer, parseVp8TemporalLayer, parseVp9TemporalLayer } from './temporal-layer-detector';

describe('temporal layer detector', () => {
  it('parses VP8 TID from the payload descriptor', () => {
    expect(parseVp8TemporalLayer(Buffer.from([0x80, 0x20, 0x80, 0x10, 0x00]))).toBe(2);
    expect(detectTemporalLayer(packet(Buffer.from([0x80, 0x20, 0x40, 0x10, 0x00])), 'video/VP8')).toEqual({ codec: 'VP8', temporalLayer: 1 });
  });

  it('parses VP8 descriptors with PictureID and TL0PICIDX before TID', () => {
    expect(parseVp8TemporalLayer(Buffer.from([0x80, 0xe0, 0x81, 0x23, 0x44, 0xc0, 0x10, 0x00]))).toBe(3);
  });

  it('parses VP9 TID from layer indices', () => {
    expect(parseVp9TemporalLayer(Buffer.from([0x20, 0x40, 0x01, 0x02]))).toBe(2);
    expect(detectTemporalLayer(packet(Buffer.from([0xa0, 0x81, 0x11, 0x20, 0x01])), 'video/VP9')).toEqual({ codec: 'VP9', temporalLayer: 1 });
  });

  it('parses VP9 TID before flexible-mode reference diffs', () => {
    expect(parseVp9TemporalLayer(Buffer.from([0x70, 0x64, 0x82, 0x01, 0x10]))).toBe(3);
  });

  it('returns undefined when temporal metadata is absent', () => {
    expect(parseVp8TemporalLayer(Buffer.from([0x10, 0x00]))).toBeUndefined();
    expect(parseVp9TemporalLayer(Buffer.from([0x00, 0x01]))).toBeUndefined();
    expect(detectTemporalLayer(packet(Buffer.from([0x10, 0x00])), 'video/H264')).toBeNull();
  });
});

function packet(payload: Buffer): RtpPacket {
  return new RtpPacket(2, false, false, false, 96, 1, 1000, 1111, [], null, payload);
}
