import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { FfprobeClient } from '../ffmpeg/ffprobe';
import { MediaIngestSupervisor } from './ingest-supervisor';

const ffmpegPath = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';
const describeSkip = (describe as typeof describe & { skip: typeof describe }).skip;
const describeIfFfmpeg: typeof describe = existsSync(ffmpegPath) && existsSync(ffprobePath) ? describe : describeSkip;

describeIfFfmpeg('MediaIngestSupervisor integration', () => {
  it('probes a real fixture and emits local RTP with a real FFmpeg session', async () => {
    const fixtureDir = join(tmpdir(), `native-sfu-ingest-${Date.now()}`);
    await mkdir(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, 'fixture.mp4');
    await createFixtureMp4(fixturePath);

    const videoRtp = await bindSocket();
    const videoRtcp = await bindSocket();
    const audioRtp = await bindSocket();
    const audioRtcp = await bindSocket();
    const supervisor = new MediaIngestSupervisor({
      ingestId: 'real-ffmpeg',
      source: {
        type: 'mp4',
        url: fixturePath
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
          url: fixturePath
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
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function createFixtureMp4(filePath: string): Promise<void> {
  await spawnForExit(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000',
    '-t',
    '2',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    filePath
  ]);
}

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

function spawnForExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8') || `ffmpeg exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  });
}
