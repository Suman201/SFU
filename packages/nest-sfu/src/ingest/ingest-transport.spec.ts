import { createSocket, type Socket } from 'node:dgram';
import { ServiceUnavailableException } from '@nestjs/common';
import { IngestTransportService } from './ingest-transport.service';
import { TrustedIngestTransport } from './trusted-ingest-transport';

describe('TrustedIngestTransport', () => {
  it('rejects non-loopback bind addresses by default', async () => {
    let thrown: unknown;
    try {
      void new TrustedIngestTransport({ id: 'transport-1', roomId: 'room-1', participantId: 'publisher', listenAddress: '0.0.0.0' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('must be loopback');
  });

  it('accepts loopback RTP and uses the learned endpoint for RTCP egress', async () => {
    const transport = new TrustedIngestTransport({
      id: 'transport-1',
      roomId: 'room-1',
      participantId: 'publisher'
    });
    const options = await transport.bind();
    const client = createSocket('udp4');
    await bindSocket(client);

    try {
      const routed = waitForEvent(transport, 'rtp');
      await sendSocket(client, Buffer.from('rtp-payload'), options.rtpPort, options.listenAddress);
      const [packet] = await routed;
      expect(packet.equals(Buffer.from('rtp-payload'))).toBe(true);

      const rtcpMessage = waitForMessage(client);
      await transport.sendRtcp(Buffer.from('rtcp-payload'));

      expect((await rtcpMessage).equals(Buffer.from('rtcp-payload'))).toBe(true);
      expect(transport.snapshot().counters.inboundRtpPackets).toBe(1);
      expect(transport.snapshot().counters.outboundRtcpPackets).toBe(1);
    } finally {
      await transport.close();
      await closeSocket(client);
    }
  });
});

describe('IngestTransportService', () => {
  it('fails explicitly when trusted ingest hooks are unavailable', async () => {
    const service = new IngestTransportService({} as never);
    let thrown: unknown;
    try {
      await service.createTransport({ roomId: 'room-1', participantId: 'publisher' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
  });
});

function bindSocket(socket: Socket): Promise<void> {
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
      socket.off('error', onError);
      socket.off('listening', onListening);
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(0, '127.0.0.1');
  });
}

function sendSocket(socket: Socket, packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

function waitForMessage(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once('message', (message) => resolve(Buffer.from(message)));
  });
}

function waitForEvent(
  transport: TrustedIngestTransport,
  event: 'rtp' | 'rtcp'
): Promise<[Buffer]> {
  return new Promise((resolve) => {
    transport.once(event, (packet) => resolve([packet]));
  });
}
