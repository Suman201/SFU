import { parseFfprobeJson } from './ffprobe';

describe('parseFfprobeJson', () => {
  it('extracts audio/video stream metadata and probe summary', () => {
    const result = parseFfprobeJson(
      JSON.stringify({
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '2.500000',
          bit_rate: '123456'
        },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            bit_rate: '100000',
            width: 1280,
            height: 720
          },
          {
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            bit_rate: '23456',
            sample_rate: '48000',
            channels: 2
          }
        ]
      })
    );

    expect(result.hasVideo).toBe(true);
    expect(result.hasAudio).toBe(true);
    expect(result.durationSeconds).toBe(2.5);
    expect(result.bitrateBps).toBe(123456);
    expect(result.streams).toEqual([
      {
        index: 0,
        kind: 'video',
        codec: 'h264',
        bitrateBps: 100000,
        width: 1280,
        height: 720,
        sampleRate: undefined,
        channels: undefined
      },
      {
        index: 1,
        kind: 'audio',
        codec: 'aac',
        bitrateBps: 23456,
        width: undefined,
        height: undefined,
        sampleRate: 48000,
        channels: 2
      }
    ]);
  });
});
