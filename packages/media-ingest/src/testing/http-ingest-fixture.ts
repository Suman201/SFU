import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const defaultFfmpegPath = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
export const defaultFfprobePath = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

export interface HttpIngestFixtureOptions {
  ffmpegPath?: string;
  durationSeconds?: number;
  routePath?: string;
  failRequestNumbers?: number[];
  failStatusCode?: number;
  truncateAfterBytes?: number;
  destroyDelayMs?: number;
}

export interface HttpIngestFixture {
  fixtureDir: string;
  fixturePath: string;
  sourceUrl: string;
  requestCount: () => number;
  waitForRequestCount: (minimumCount: number, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

export function ffmpegBinariesAvailable(
  paths: {
    ffmpegPath?: string;
    ffprobePath?: string;
  } = {}
): boolean {
  return existsSync(paths.ffmpegPath ?? defaultFfmpegPath) && existsSync(paths.ffprobePath ?? defaultFfprobePath);
}

export async function createHttpMp4Fixture(options: HttpIngestFixtureOptions = {}): Promise<HttpIngestFixture> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'native-sfu-ingest-'));
  const fixturePath = join(fixtureDir, 'fixture.mp4');
  const routePath = options.routePath?.trim() || '/fixture.mp4';
  const failRequestNumbers = new Set(options.failRequestNumbers ?? []);
  const destroyDelayMs = options.destroyDelayMs ?? 150;
  const timeoutHandleMap = new Set<NodeJS.Timeout>();
  let requestCount = 0;
  const waiters = new Set<{
    minimumCount: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  await createFixtureMp4(fixturePath, {
    ffmpegPath: options.ffmpegPath,
    durationSeconds: options.durationSeconds
  });
  const payload = await readFile(fixturePath);
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Expected HTTP server to expose an IPv4 or IPv6 address');
  }
  const sourceUrl = `http://127.0.0.1:${address.port}${routePath}`;

  return {
    fixtureDir,
    fixturePath,
    sourceUrl,
    requestCount: () => requestCount,
    waitForRequestCount: (minimumCount, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        if (requestCount >= minimumCount) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for HTTP ingest fixture request count ${minimumCount}; observed ${requestCount}`));
        }, timeoutMs);
        timer.unref?.();
        const waiter = { minimumCount, resolve, reject, timer };
        waiters.add(waiter);
      }),
    close: async () => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('HTTP ingest fixture closed before the expected request count was reached'));
      }
      waiters.clear();
      for (const timer of timeoutHandleMap) {
        clearTimeout(timer);
      }
      timeoutHandleMap.clear();
      await closeServer(server);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((request.url ?? '').split('?')[0] !== routePath) {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    settleWaiters();

    const selection = selectRange(payload, request.headers.range);
    const headers: Record<string, string | number> = {
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
      'cache-control': 'no-store',
      'content-length': selection.totalLength
    };
    if (selection.contentRange) {
      headers['content-range'] = selection.contentRange;
    }
    response.writeHead(selection.statusCode, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    if (failRequestNumbers.has(requestCount)) {
      if (options.failStatusCode) {
        response.writeHead(options.failStatusCode, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store'
        });
        response.end(`fixture forced failure ${options.failStatusCode}`);
        return;
      }
      const partialLength = Math.max(1, Math.min(selection.body.length - 1, options.truncateAfterBytes ?? Math.max(32 * 1024, Math.floor(selection.body.length / 3))));
      response.write(selection.body.subarray(0, partialLength));
      const timer = setTimeout(() => {
        timeoutHandleMap.delete(timer);
        response.socket?.destroy();
      }, destroyDelayMs);
      timer.unref?.();
      timeoutHandleMap.add(timer);
      return;
    }

    response.end(selection.body);
  }

  function settleWaiters(): void {
    for (const waiter of [...waiters]) {
      if (requestCount < waiter.minimumCount) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  }
}

export async function createFixtureMp4(
  filePath: string,
  options: {
    ffmpegPath?: string;
    durationSeconds?: number;
  } = {}
): Promise<void> {
  const ffmpegPath = options.ffmpegPath?.trim() || defaultFfmpegPath;
  const durationSeconds = options.durationSeconds ?? 6;
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
    String(durationSeconds),
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

function selectRange(payload: Buffer, rangeHeader: string | undefined): {
  statusCode: number;
  body: Buffer;
  totalLength: number;
  contentRange?: string;
} {
  if (!rangeHeader?.startsWith('bytes=')) {
    return {
      statusCode: 200,
      body: payload,
      totalLength: payload.length
    };
  }
  const [rawStart, rawEnd] = rangeHeader.slice('bytes='.length).split('-', 2);
  const start = rawStart ? Number.parseInt(rawStart, 10) : 0;
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : payload.length - 1;
  const boundedStart = Number.isFinite(start) ? Math.max(0, Math.min(start, payload.length - 1)) : 0;
  const boundedEnd = Number.isFinite(end) ? Math.max(boundedStart, Math.min(end, payload.length - 1)) : payload.length - 1;
  const body = payload.subarray(boundedStart, boundedEnd + 1);
  return {
    statusCode: 206,
    body,
    totalLength: body.length,
    contentRange: `bytes ${boundedStart}-${boundedEnd}/${payload.length}`
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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
