import { once } from 'node:events';
import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { createPli, parsePli } from '../rtcp/rtcp-packet';
import { RtpPacket } from '../rtp/rtp-packet';
import { UdpPipeTransport, type UdpPipeDropEvent, type UdpPipePacketEvent, type UdpPipeControlEvent } from './udp-pipe-transport';

describe('UdpPipeTransport', () => {
  const transports: UdpPipeTransport[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.close()));
    await Promise.all(sockets.splice(0).map((socket) => closeSocket(socket)));
  });

  it('listens on loopback UDP and forwards framed RTP with advertised endpoint metadata', async () => {
    const owner = track(
      new UdpPipeTransport({
        id: 'pipe-owner',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        listenPort: 0,
        advertisedIp: '203.0.113.10',
        peerToken: 'shared-token',
        authMode: 'token'
      })
    );
    const remote = track(
      new UdpPipeTransport({
        id: 'pipe-remote',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        listenPort: 0,
        peerToken: 'shared-token',
        authMode: 'token'
      })
    );

    const ownerEndpoint = await owner.listen();
    const remoteEndpoint = await remote.listen();
    owner.connect({ address: '127.0.0.1', port: remoteEndpoint.port, nodeId: 'node-b' });
    remote.connect({ address: '127.0.0.1', port: ownerEndpoint.port, nodeId: 'node-a' });
    const received = waitForEvent<UdpPipePacketEvent>(remote, 'rtp');

    expect(await owner.sendRtp('producer-1', rtpPacket(1111, 10, 9000))).toBe(true);

    const event = await received;
    expect(event.producerId).toBe('producer-1');
    expect(event.ssrc).toBe(1111);
    expect(event.sequenceNumber).toBe(10);
    expect(event.timestamp).toBe(9000);
    expect(remote.snapshot().rtpPackets).toBe(1);
    expect(owner.snapshot().sentRtpPackets).toBe(1);
    expect(ownerEndpoint.advertisedIp).toBe('203.0.113.10');
    expect(ownerEndpoint.advertisedPort).toBe(ownerEndpoint.port);
  });

  it('forwards RTCP and control frames over loopback UDP', async () => {
    const owner = track(
      new UdpPipeTransport({
        id: 'pipe-owner',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        peerToken: 'shared-token',
        authMode: 'token'
      })
    );
    const remote = track(
      new UdpPipeTransport({
        id: 'pipe-remote',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        peerToken: 'shared-token',
        authMode: 'token'
      })
    );
    await connectLoopback(owner, remote);
    const rtcpReceived = waitForEvent<UdpPipePacketEvent>(owner, 'rtcp');
    const controlReceived = waitForEvent<UdpPipeControlEvent>(owner, 'control');

    expect(await remote.sendRtcp(createPli({ senderSsrc: 9000, mediaSsrc: 2222 }), { consumerId: 'consumer-1' })).toBe(true);
    expect(await remote.sendControl('ping', { seq: 1 })).toBe(true);

    const rtcp = await rtcpReceived;
    expect(rtcp.consumerId).toBe('consumer-1');
    expect(parsePliFromBuffer(rtcp.packet)?.mediaSsrc).toBe(2222);
    const control = await controlReceived;
    expect(control.controlType).toBe('ping');
    expect(JSON.parse(control.payload.toString('utf8'))).toEqual({ seq: 1 });
    expect(owner.snapshot().rtcpPackets).toBe(1);
    expect(owner.snapshot().controlPackets).toBe(1);
  });

  it('rejects packets that do not present the shared peer token', async () => {
    const receiver = track(
      new UdpPipeTransport({
        id: 'pipe-receiver',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        peerToken: 'expected-token',
        authMode: 'token'
      })
    );
    const sender = track(
      new UdpPipeTransport({
        id: 'pipe-sender',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        peerToken: 'wrong-token',
        authMode: 'token'
      })
    );
    const receiverEndpoint = await receiver.listen();
    await sender.listen();
    sender.connect({ address: '127.0.0.1', port: receiverEndpoint.port, nodeId: 'node-b' });
    const drop = waitForEvent<UdpPipeDropEvent>(receiver, 'drop');

    expect(await sender.sendRtp('producer-1', rtpPacket(1111, 10, 9000))).toBe(true);

    expect((await drop).reason).toBe('unauthorized');
    expect(receiver.snapshot().rtpPackets).toBe(0);
    expect(receiver.snapshot().dropReasons.unauthorized).toBe(1);
  });

  it('can authenticate with a shared transport id when no token is configured', async () => {
    const owner = track(
      new UdpPipeTransport({
        id: 'pipe-shared',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1'
      })
    );
    const remote = track(
      new UdpPipeTransport({
        id: 'pipe-shared',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1'
      })
    );
    await connectLoopback(owner, remote);
    const received = waitForEvent<UdpPipePacketEvent>(remote, 'rtp');

    expect(await owner.sendRtp('producer-1', rtpPacket(1111, 44, 9000))).toBe(true);

    expect((await received).sequenceNumber).toBe(44);
    expect(remote.snapshot().dropReasons.unauthorized).toBe(0);
  });

  it('encrypts token-authenticated media and rejects replayed datagrams', async () => {
    const sender = track(
      new UdpPipeTransport({
        id: 'pipe-sender',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        peerToken: 'shared-secret-token',
        authMode: 'token'
      })
    );
    const receiver = track(
      new UdpPipeTransport({
        id: 'pipe-receiver',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        peerToken: 'shared-secret-token',
        authMode: 'token'
      })
    );
    const receiverEndpoint = await receiver.listen();
    await sender.listen();
    const relay = createSocket('udp4');
    sockets.push(relay);
    const relayEndpoint = await bindSocket(relay);
    sender.connect({ address: '127.0.0.1', port: relayEndpoint.port, nodeId: 'node-b' });
    receiver.connect({ address: '127.0.0.1', port: relayEndpoint.port, nodeId: 'node-a' });
    const received = waitForEvent<UdpPipePacketEvent>(receiver, 'rtp');
    const replayDrop = waitForEvent<UdpPipeDropEvent>(receiver, 'drop');
    const forwarded = new Promise<void>((resolve, reject) => {
      relay.once('message', (message) => {
        try {
          expect(message.includes(Buffer.from('shared-secret-token'))).toBe(false);
          expect(message.includes(Buffer.from('pipe-media'))).toBe(false);
          relay.send(message, receiverEndpoint.port, '127.0.0.1', (error) => {
            if (error) {
              reject(error);
              return;
            }
            relay.send(message, receiverEndpoint.port, '127.0.0.1', (replayError) => replayError ? reject(replayError) : resolve());
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    expect(await sender.sendRtp('producer-1', rtpPacket(1111, 45, 9000))).toBe(true);
    await forwarded;
    expect((await received).sequenceNumber).toBe(45);
    expect((await replayDrop).reason).toBe('replay');
    expect(receiver.snapshot().dropReasons.replay).toBe(1);
  });

  it('reports backpressure before sending frames beyond queue limits', async () => {
    const owner = track(
      new UdpPipeTransport({
        id: 'pipe-owner',
        roomId: 'room-udp',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        listenIp: '127.0.0.1',
        peerToken: 'shared-token',
        authMode: 'token',
        maxQueueBytes: 8
      })
    );
    const remote = track(
      new UdpPipeTransport({
        id: 'pipe-remote',
        roomId: 'room-udp',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        listenIp: '127.0.0.1',
        peerToken: 'shared-token',
        authMode: 'token'
      })
    );
    await connectLoopback(owner, remote);

    expect(await owner.sendRtp('producer-1', rtpPacket(1111, 10, 9000))).toBe(false);

    expect(owner.snapshot().backpressureEvents).toBe(1);
    expect(owner.snapshot().dropReasons.backpressure).toBe(1);
    expect(remote.snapshot().rtpPackets).toBe(0);
  });

  function track(transport: UdpPipeTransport): UdpPipeTransport {
    transports.push(transport);
    return transport;
  }
});

async function connectLoopback(owner: UdpPipeTransport, remote: UdpPipeTransport): Promise<void> {
  const ownerEndpoint = await owner.listen();
  const remoteEndpoint = await remote.listen();
  owner.connect({ address: '127.0.0.1', port: remoteEndpoint.port, nodeId: remoteEndpoint.nodeId });
  remote.connect({ address: '127.0.0.1', port: ownerEndpoint.port, nodeId: ownerEndpoint.nodeId });
}

async function waitForEvent<T>(transport: UdpPipeTransport, event: string, timeoutMs = 1000): Promise<T> {
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
  });
  const eventPromise = once(transport, event).then(([value]) => value as T);
  return Promise.race([eventPromise, timer]);
}

async function bindSocket(socket: Socket): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('listening', resolve);
    socket.bind(0, '127.0.0.1');
  });
  return socket.address() as AddressInfo;
}

async function closeSocket(socket: Socket): Promise<void> {
  if (!socket.address) {
    return;
  }
  await new Promise<void>((resolve) => socket.close(() => resolve()));
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 96, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('pipe-media')).serialize();
}

function parsePliFromBuffer(packet: Buffer) {
  return parsePli({ version: 2, padding: false, count: packet[0]! & 0x1f, type: packet[1]! as 206, length: packet.readUInt16BE(2), payload: packet.subarray(4) });
}
