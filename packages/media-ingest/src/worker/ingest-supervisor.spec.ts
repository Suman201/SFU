import { EventEmitter } from 'node:events';
import type { MediaIngestExitInfo, MediaIngestRunnerSnapshot, MediaIngestRuntimeConfig } from '../types';
import { MediaIngestSupervisor } from './ingest-supervisor';
import type { MediaIngestRunner } from './ingest-runner';

describe('MediaIngestSupervisor', () => {
  it('restarts after a failure and reaches live state on the next attempt', async () => {
    const runners: FakeRunner[] = [
      new FakeRunner({ exitAfterStart: { code: 1, signal: null } }),
      new FakeRunner({ emitLiveAfterStart: true })
    ];

    const supervisor = new MediaIngestSupervisor(createConfig(), {
      runnerFactory: () => runners.shift() as unknown as MediaIngestRunner
    });

    await supervisor.start();
    await supervisor.waitForState('live', 2_000);

    const snapshot = supervisor.snapshot();
    expect(snapshot.restartCount).toBe(1);
    expect(snapshot.metrics.starts).toBe(2);
    expect(snapshot.metrics.restarts).toBe(1);
    expect(snapshot.metrics.liveTransitions).toBe(1);

    await supervisor.stop();
    expect(supervisor.snapshot().state).toBe('stopped');
  });

  it('fails permanently when restart policy is exhausted', async () => {
    const supervisor = new MediaIngestSupervisor(createConfig(), {
      runnerFactory: () => new FakeRunner({ exitAfterStart: { code: 1, signal: null } }) as unknown as MediaIngestRunner
    });

    await supervisor.start();
    await supervisor.waitForState('failed', 2_000);

    const snapshot = supervisor.snapshot();
    expect(snapshot.state).toBe('failed');
    expect(snapshot.restartCount).toBe(1);
    expect(snapshot.metrics.failures).toBeGreaterThan(0);
  });
});

class FakeRunner extends EventEmitter {
  private resolveExit?: (value: MediaIngestExitInfo) => void;
  private readonly exitPromise = new Promise<MediaIngestExitInfo>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly behavior: {
      emitLiveAfterStart?: boolean;
      exitAfterStart?: MediaIngestExitInfo;
    } = {}
  ) {
    super();
  }

  async start(): Promise<void> {
    this.emit('probe', {
      formatName: 'mp4',
      durationSeconds: 1,
      bitrateBps: 1000,
      hasAudio: true,
      hasVideo: true,
      streams: [],
      raw: {}
    });
    this.emit('started', { pid: 1234 });
    if (this.behavior.emitLiveAfterStart) {
      queueMicrotask(() => {
        this.emit('progress', {
          progress: 'continue',
          rawFields: { progress: 'continue' }
        });
      });
      return;
    }
    if (this.behavior.exitAfterStart) {
      const exit = this.behavior.exitAfterStart;
      queueMicrotask(() => {
        this.emit('exit', exit);
        this.resolveExit?.(exit);
      });
    }
  }

  async waitForExit(): Promise<MediaIngestExitInfo> {
    return this.exitPromise;
  }

  async stop(): Promise<MediaIngestExitInfo> {
    const exit = { code: 0, signal: 'SIGTERM' as const };
    this.emit('exit', exit);
    this.resolveExit?.(exit);
    return exit;
  }

  snapshot(): MediaIngestRunnerSnapshot {
    return {
      ingestId: 'fake',
      health: {
        state: 'live',
        healthy: true,
        stale: false,
        progressCount: 1
      }
    };
  }
}

function createConfig(): MediaIngestRuntimeConfig {
  return {
    ingestId: 'ingest-supervisor',
    source: {
      type: 'mp4',
      url: '/tmp/fake.mp4'
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
        ssrc: 1111
      }
    ],
    restartPolicy: {
      mode: 'on_failure',
      maxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 1
    },
    startupTimeoutMs: 2_000
  };
}
