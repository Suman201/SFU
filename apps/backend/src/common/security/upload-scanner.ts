import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createConnection } from 'node:net';
import { once } from 'node:events';

export interface UploadScanOptions { host: string; port: number; timeoutMs: number; maxBytes: number }
let activeScans = 0;

/** All enabled scans fail closed. Never send filenames, paths or credentials. */
export async function assertClassroomUploadSafe(bytes: Buffer, config: ConfigService): Promise<void> {
  if (config.get<boolean>('uploadSecurity.enabled', false) !== true) return;
  const concurrent = config.get<number>('uploadSecurity.maxConcurrent', 2);
  if (activeScans >= concurrent) throw new ServiceUnavailableException('File scanning is busy. Try again shortly.');
  activeScans++;
  try {
    await scanUpload(bytes, {
      host: config.get<string>('uploadSecurity.host', '127.0.0.1'),
      port: config.get<number>('uploadSecurity.port', 3310),
      timeoutMs: config.get<number>('uploadSecurity.timeoutMs', 15000),
      maxBytes: config.get<number>('uploadSecurity.maxBytes', 64 * 1024 * 1024)
    });
  } finally { activeScans--; }
}

export async function scanUpload(bytes: Buffer, options: UploadScanOptions): Promise<void> {
  if (!bytes.length || bytes.length > options.maxBytes) throw new BadRequestException('The file exceeds the security scan size limit.');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port });
    const abort = new AbortController();
    let reply = Buffer.alloc(0), finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(deadline); abort.abort(); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const unavailable = () => finish(new ServiceUnavailableException('File scanning could not complete. Try again later.'));
    const deadline = setTimeout(unavailable, options.timeoutMs);
    socket.on('error', unavailable);
    socket.on('close', () => { if (!finished) unavailable(); });
    socket.on('data', chunk => {
      if (reply.length + chunk.length > 4096) { unavailable(); return; }
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf(0);
      if (end < 0) return;
      const result = reply.subarray(0, end).toString('utf8').trim();
      if (result === 'stream: OK') finish();
      else if (/^stream: .+ FOUND$/.test(result)) finish(new BadRequestException('The file was rejected by the security scan. Upload a clean copy.'));
      else unavailable();
    });
    socket.once('connect', () => {
      void (async () => {
        socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
        for (let offset = 0; offset < bytes.length && !finished; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536);
          const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length);
          socket.write(size);
          if (!socket.write(chunk)) await once(socket, 'drain', { signal: abort.signal });
        }
        if (!finished) socket.write(Buffer.alloc(4));
      })().catch(unavailable);
    });
  });
}
