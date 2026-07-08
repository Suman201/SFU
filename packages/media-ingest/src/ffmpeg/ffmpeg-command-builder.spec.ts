import { buildFfmpegCommand } from './ffmpeg-command-builder';
import type { MediaIngestRuntimeConfig } from '../types';

describe('buildFfmpegCommand', () => {
  it('builds a deterministic MP4/HLS-friendly command with video and audio outputs', () => {
    const command = buildFfmpegCommand(createConfig());

    expect(command.executable).toBe('ffmpeg');
    expect(command.args).toContain('-progress');
    expect(command.args).toContain('pipe:2');
    expect(command.args).toContain('-re');
    expect(command.args).toContain('-headers');
    expect(command.args).toContain('Authorization: Bearer top-secret-token\r\nX-Source-Key: abc123\r\n');
    expect(command.args).toContain('rtp://127.0.0.1:5004?rtcpport=5005&localrtcpport=0&pkt_size=1200');
    expect(command.args).toContain('rtp://127.0.0.1:5006?rtcpport=5007&localrtcpport=0&pkt_size=1200');
    expect(command.args).toContain('libx264');
    expect(command.args).toContain('libopus');
  });

  it('rejects duplicate output kinds in the Phase 3 profile', () => {
    const config = createConfig();
    config.outputs.push({
      id: 'video-low',
      kind: 'video',
      codec: 'h264',
      host: '127.0.0.1',
      rtpPort: 5010,
      rtcpPort: 5011,
      payloadType: 103,
      ssrc: 9003
    });

    expect(() => buildFfmpegCommand(config)).toThrow('at most one video output target');
  });
});

function createConfig(): MediaIngestRuntimeConfig {
  return {
    ingestId: 'ingest-1',
    source: {
      type: 'mp4',
      url: '/tmp/input.mp4',
      auth: {
        bearerToken: 'top-secret-token',
        headers: [{ name: 'X-Source-Key', value: 'abc123' }]
      }
    },
    outputs: [
      {
        id: 'video-main',
        kind: 'video',
        codec: 'h264',
        host: '127.0.0.1',
        rtpPort: 5004,
        rtcpPort: 5005,
        payloadType: 102,
        ssrc: 9001
      },
      {
        id: 'audio-main',
        kind: 'audio',
        codec: 'opus',
        host: '127.0.0.1',
        rtpPort: 5006,
        rtcpPort: 5007,
        payloadType: 111,
        ssrc: 9002
      }
    ]
  };
}
