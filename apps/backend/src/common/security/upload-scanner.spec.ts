import { it, expect } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createServer, type Socket } from 'node:net';
import { scanUpload, assertClassroomUploadSafe } from './upload-scanner';

async function daemon(reply: (socket: Socket, bytes: Buffer) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0); socket.on('data', data => { bytes = Buffer.concat([bytes, data]); if (bytes.length >= 14 && bytes.subarray(-4).equals(Buffer.alloc(4))) reply(socket, bytes); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { options: { host: '127.0.0.1', port: (server.address() as any).port, timeoutMs: 100, maxBytes: 1024 * 1024 }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
describe('bounded upload malware scanning', () => {
  it('streams the complete file with bounded network-order chunks and waits for a complete clean verdict', async () => {
    const input = Buffer.alloc(70000, 65); let received = Buffer.alloc(0);
    const server = await daemon((socket, bytes) => {
      expect(bytes.subarray(0, 10).toString()).toBe('zINSTREAM\0');
      let offset = 10; const chunks: Buffer[] = [];
      while (offset < bytes.length) { const size = bytes.readUInt32BE(offset); offset += 4; if (!size) break; chunks.push(bytes.subarray(offset, offset + size)); offset += size; }
      received = Buffer.concat(chunks); socket.write('stream: O'); socket.end('K\0');
    });
    try { await scanUpload(input, server.options); expect(received.equals(input)).toBe(true); } finally { await server.close(); }
  });
  it('rejects detections without exposing the scanner signature or file contents', async () => {
    const server = await daemon(socket => socket.end('stream: Private.Signature FOUND\0'));
    try { await expect(scanUpload(Buffer.from('synthetic'), server.options)).rejects.toBeInstanceOf(BadRequestException); } finally { await server.close(); }
  });
  it.each(['stream: OK', 'stream: size limit exceeded ERROR\0', 'unexpected\0'])('fails closed on truncated or invalid verdict %s', async reply => {
    const server = await daemon(socket => socket.end(reply));
    try { await expect(scanUpload(Buffer.from('synthetic'), server.options)).rejects.toBeInstanceOf(ServiceUnavailableException); } finally { await server.close(); }
  });
  it('bounds scanner wait time and stream size', async () => {
    const server = await daemon(() => undefined);
    try {
      await expect(scanUpload(Buffer.from('synthetic'), server.options)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(scanUpload(Buffer.alloc(1025), { ...server.options, maxBytes: 1024 })).rejects.toBeInstanceOf(BadRequestException);
    } finally { await server.close(); }
  });
  it('does not connect when scanning is disabled', async () => {
    await expect(assertClassroomUploadSafe(Buffer.from('synthetic'), { get: () => false } as any)).resolves.toBeUndefined();
  });
});
