import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createSocket, type Socket } from 'node:dgram';
import { FfprobeClient } from '../ffmpeg/ffprobe';
import { createHttpMp4Fixture } from '../testing/http-ingest-fixture';
import { MediaIngestSupervisor } from './ingest-supervisor';

const ffmpegPath = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';
const describeSkip = (describe as typeof describe & { skip: typeof describe }).skip;
const describeIfFfmpeg: typeof describe = existsSync(ffmpegPath) && existsSync(ffprobePath) ? describe : describeSkip;

describeIfFfmpeg('MediaIngestSupervisor integration', () => {
  it('probes a real fixture and emits local RTP with a real FFmpeg session', async () => {
    const fixture = await createHttpMp4Fixture({
      ffmpegPath,
      durationSeconds: 4
    });

    const videoRtp = await bindSocket();
    const videoRtcp = await bindSocket();
    const audioRtp = await bindSocket();
    const audioRtcp = await bindSocket();
    const supervisor = new MediaIngestSupervisor({
      ingestId: 'real-ffmpeg',
      source: {
        type: 'mp4',
        url: fixture.sourceUrl
      },
      outputs: [
        {
          id: 'video-main',
          kind: 'video',
          codec: 'h264',
          host: '127.0.0.1',
          rtpPort: socketPort(videoRtp),
          rtcpPort: socketPort(videoRtcp),
          payloadType: 102,
          ssrc: 6001,
          bitrateKbps: 1200
        },
        {
          id: 'audio-main',
          kind: 'audio',
          codec: 'opus',
          host: '127.0.0.1',
          rtpPort: socketPort(audioRtp),
          rtcpPort: socketPort(audioRtcp),
          payloadType: 111,
          ssrc: 6002,
          bitrateKbps: 96
        }
      ],
      ffmpegPath,
      ffprobePath,
      probeTimeoutMs: 8_000,
      stopTimeoutMs: 3_000,
      startupTimeoutMs: 8_000,
      extraInputArgs: ['-stream_loop', '-1'],
      restartPolicy: { mode: 'never' }
    });

    try {
      const probe = await new FfprobeClient({ ffprobePath }).probeSource(
        {
          type: 'mp4',
          url: fixture.sourceUrl
        },
        8_000
      );
      expect(probe.hasVideo).toBe(true);
      expect(probe.hasAudio).toBe(true);

      await supervisor.start();
      await supervisor.waitForState('live', 8_000);

      const [videoPacket, audioPacket, videoRtcpPacket] = await Promise.all([
        waitForMessage(videoRtp, 8_000),
        waitForMessage(audioRtp, 8_000),
        waitForMessage(videoRtcp, 8_000)
      ]);
      expect(isRtpPacket(videoPacket)).toBe(true);
      expect(isRtpPacket(audioPacket)).toBe(true);
      expect(isRtcpPacket(videoRtcpPacket)).toBe(true);

      await supervisor.stop();
      expect(supervisor.snapshot().metrics.liveTransitions).toBe(1);
      expect(supervisor.snapshot().state).toBe('stopped');
    } finally {
      await Promise.all([closeSocket(videoRtp), closeSocket(videoRtcp), closeSocket(audioRtp), closeSocket(audioRtcp)]);
      await fixture.close();
    }
  }, 30_000);

  it('restarts after an HTTP source interruption and returns to live media output', async () => {
    const fixture = await createHttpMp4Fixture({
      ffmpegPath,
      durationSeconds: 8,
      failRequestNumbers: [1, 2, 3],
      failStatusCode: 503
    });
    const videoRtp = await bindSocket();
    const videoRtcp = await bindSocket();
    const supervisor = new MediaIngestSupervisor({
      ingestId: 'http-restart',
      source: {
        type: 'mp4',
        url: fixture.sourceUrl
      },
      outputs: [
        {
          id: 'video-main',
          kind: 'video',
          codec: 'h264',
          host: '127.0.0.1',
          rtpPort: socketPort(videoRtp),
          rtcpPort: socketPort(videoRtcp),
          payloadType: 102,
          ssrc: 7001,
          bitrateKbps: 1200
        }
      ],
      ffmpegPath,
      ffprobePath,
      probeTimeoutMs: 8_000,
      stopTimeoutMs: 3_000,
      startupTimeoutMs: 12_000,
      restartPolicy: {
        mode: 'on_failure',
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 250
      }
    });
    const observedErrors: Error[] = [];
    supervisor.on('error', (error) => observedErrors.push(error));

    try {
      const restart = waitForRestart(supervisor, 20_000);
      await supervisor.start();
      await restart;
      await supervisor.waitForState('live', 20_000);

      const snapshot = supervisor.snapshot();
      expect(snapshot.restartCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.metrics.restarts).toBeGreaterThanOrEqual(1);
      expect(snapshot.state).toBe('live');
      expect(observedErrors.length).toBeGreaterThan(0);
    } finally {
      await supervisor.stop().catch(() => undefined);
      await Promise.all([closeSocket(videoRtp), closeSocket(videoRtcp)]);
      await fixture.close();
    }
  }, 45_000);
});

function bindSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const onError = (error: Error) => {
      cleanup();
      socket.close();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(socket);
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

function socketPort(socket: Socket): number {
  const address = socket.address();
  if (typeof address === 'string') {
    throw new Error('Expected UDP socket address');
  }
  return address.port;
}

function waitForMessage(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for UDP message'));
    }, timeoutMs);
    timer.unref?.();
    const onMessage = (message: Buffer) => {
      cleanup();
      resolve(Buffer.from(message));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.once('message', onMessage);
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

function isRtpPacket(packet: Buffer): boolean {
  return packet.length >= 12 && ((packet[0] ?? 0) >> 6) === 2;
}

function isRtcpPacket(packet: Buffer): boolean {
  const packetType = packet[1] ?? 0;
  return packet.length >= 8 && ((packet[0] ?? 0) >> 6) === 2 && packetType >= 192 && packetType <= 223;
}

function waitForRestart(supervisor: MediaIngestSupervisor, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the ingest supervisor to restart'));
    }, timeoutMs);
    timer.unref?.();
    const onRestart = (restartCount: number) => {
      cleanup();
      resolve(restartCount);
    };
    const cleanup = () => {
      clearTimeout(timer);
      supervisor.off('restart', onRestart);
    };
    supervisor.on('restart', onRestart);
  });
}
