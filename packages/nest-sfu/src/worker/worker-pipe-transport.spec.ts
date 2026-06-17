import { createPli, RtpPacket } from '@native-sfu/sfu-core';
import { WorkerPipeTransport } from './worker-pipe-transport';

describe('WorkerPipeTransport', () => {
  jest.setTimeout(10000);

  it('sends RTP and RTCP directly between worker-owned UDP transports without parent IPC', async () => {
    const ownerInboundRtp: Array<{ producerId: string; packet: Buffer }> = [];
    const ownerInboundRtcp: Buffer[] = [];
    const remoteInboundRtp: Array<{ producerId: string; packet: Buffer }> = [];
    const remoteInboundRtcp: Buffer[] = [];
    const ownerOutboundIpcRtp = jest.fn();
    const ownerOutboundIpcRtcp = jest.fn();
    const remoteOutboundIpcRtp = jest.fn();
    const remoteOutboundIpcRtcp = jest.fn();
    const owner = new WorkerPipeTransport({
      onInboundRtp: (event) => ownerInboundRtp.push({ producerId: event.producerId, packet: event.packet }),
      onInboundRtcp: (event) => ownerInboundRtcp.push(event.packet),
      onOutboundIpcRtp: ownerOutboundIpcRtp,
      onOutboundIpcRtcp: ownerOutboundIpcRtcp
    });
    const remote = new WorkerPipeTransport({
      onInboundRtp: (event) => remoteInboundRtp.push({ producerId: event.producerId, packet: event.packet }),
      onInboundRtcp: (event) => remoteInboundRtcp.push(event.packet),
      onOutboundIpcRtp: remoteOutboundIpcRtp,
      onOutboundIpcRtcp: remoteOutboundIpcRtcp
    });

    try {
      const ownerLocal = await owner.ensureTransport({
        pipeTransportId: 'pipe-owner',
        roomId: 'room-1',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        protocol: 'udp',
        listenPort: 0,
        advertisedIp: '127.0.0.1',
        peerToken: 'worker-pipe-token'
      });
      const remoteLocal = await remote.ensureTransport({
        pipeTransportId: 'pipe-remote',
        roomId: 'room-1',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        protocol: 'udp',
        listenPort: 0,
        advertisedIp: '127.0.0.1',
        peerToken: 'worker-pipe-token'
      });

      await owner.ensureTransport({
        pipeTransportId: 'pipe-owner',
        roomId: 'room-1',
        localNodeId: 'node-a',
        remoteNodeId: 'node-b',
        protocol: 'udp',
        remoteEndpoint: remoteLocal.localEndpoint
      });
      await remote.ensureTransport({
        pipeTransportId: 'pipe-remote',
        roomId: 'room-1',
        localNodeId: 'node-b',
        remoteNodeId: 'node-a',
        protocol: 'udp',
        remoteEndpoint: ownerLocal.localEndpoint
      });

      const rtpPacket = workerRtpPacket(1234, 10, 90_000);
      expect(await owner.sendRtp('pipe-owner', 'producer-1', rtpPacket)).toBe(true);
      await waitFor(() => remoteInboundRtp.length > 0);
      expect(remoteInboundRtp[0]?.producerId).toBe('producer-1');
      expect(remoteInboundRtp[0]?.packet).toEqual(rtpPacket);

      const pli = createPli({ senderSsrc: 9000, mediaSsrc: 1234 });
      expect(await remote.sendRtcp('pipe-remote', pli, { producerId: 'producer-1' })).toBe(true);
      await waitFor(() => ownerInboundRtcp.length > 0);
      expect(ownerInboundRtcp[0]).toEqual(pli);

      expect(ownerOutboundIpcRtp).not.toHaveBeenCalled();
      expect(ownerOutboundIpcRtcp).not.toHaveBeenCalled();
      expect(remoteOutboundIpcRtp).not.toHaveBeenCalled();
      expect(remoteOutboundIpcRtcp).not.toHaveBeenCalled();
      expect(owner.transportSnapshot('pipe-owner')?.sentRtpPackets).toBeGreaterThan(0);
      expect(remote.transportSnapshot('pipe-remote')?.rtpPackets).toBeGreaterThan(0);
      expect(remote.transportSnapshot('pipe-remote')?.sentRtcpPackets).toBeGreaterThan(0);
      expect(owner.transportSnapshot('pipe-owner')?.rtcpPackets).toBeGreaterThan(0);
    } finally {
      await owner.closeTransport('pipe-owner');
      await remote.closeTransport('pipe-remote');
    }
  });

  it('survives repeated worker pipe setup churn while closing rooms between attach cycles', async () => {
    const ownerInboundRtcp: Buffer[] = [];
    const remoteInboundRtp: Array<{ producerId: string; packet: Buffer }> = [];
    const owner = new WorkerPipeTransport({
      onInboundRtp: () => undefined,
      onInboundRtcp: (event) => ownerInboundRtcp.push(event.packet),
      onOutboundIpcRtp: () => undefined,
      onOutboundIpcRtcp: () => undefined
    });
    const remote = new WorkerPipeTransport({
      onInboundRtp: (event) => remoteInboundRtp.push({ producerId: event.producerId, packet: event.packet }),
      onInboundRtcp: () => undefined,
      onOutboundIpcRtp: () => undefined,
      onOutboundIpcRtcp: () => undefined
    });
    const roomId = 'room-churn';
    const ownerPipeId = 'pipe-owner';
    const remotePipeId = 'pipe-remote';

    try {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const ownerLocal = await owner.ensureTransport({
          pipeTransportId: ownerPipeId,
          roomId,
          localNodeId: 'node-a',
          remoteNodeId: 'node-b',
          protocol: 'udp',
          listenPort: 0,
          advertisedIp: '127.0.0.1',
          peerToken: 'worker-pipe-token'
        });
        const remoteLocal = await remote.ensureTransport({
          pipeTransportId: remotePipeId,
          roomId,
          localNodeId: 'node-b',
          remoteNodeId: 'node-a',
          protocol: 'udp',
          listenPort: 0,
          advertisedIp: '127.0.0.1',
          peerToken: 'worker-pipe-token'
        });

        await owner.ensureTransport({
          pipeTransportId: ownerPipeId,
          roomId,
          localNodeId: 'node-a',
          remoteNodeId: 'node-b',
          protocol: 'udp',
          remoteEndpoint: remoteLocal.localEndpoint
        });
        await remote.ensureTransport({
          pipeTransportId: remotePipeId,
          roomId,
          localNodeId: 'node-b',
          remoteNodeId: 'node-a',
          protocol: 'udp',
          remoteEndpoint: ownerLocal.localEndpoint
        });

        expect(owner.transportSnapshot(ownerPipeId)?.listening).toBe(true);
        expect(remote.transportSnapshot(remotePipeId)?.listening).toBe(true);
        expect(await owner.sendRtp(ownerPipeId, 'producer-1', workerRtpPacket(1234, 100 + iteration, 180_000 + iteration * 3_000))).toBe(true);
        await waitFor(() => remoteInboundRtp.length === iteration + 1);
        expect(remoteInboundRtp[iteration]).toEqual({
          producerId: 'producer-1',
          packet: workerRtpPacket(1234, 100 + iteration, 180_000 + iteration * 3_000)
        });

        const pli = createPli({ senderSsrc: 9000 + iteration, mediaSsrc: 1234 });
        expect(await remote.sendRtcp(remotePipeId, pli, { producerId: 'producer-1' })).toBe(true);
        await waitFor(() => ownerInboundRtcp.length === iteration + 1);
        expect(ownerInboundRtcp[iteration]).toEqual(pli);

        await owner.closeRoom(roomId);
        await remote.closeRoom(roomId);

        expect(owner.transportSnapshot(ownerPipeId)).toBeUndefined();
        expect(remote.transportSnapshot(remotePipeId)).toBeUndefined();
      }
    } finally {
      await owner.closeRoom(roomId);
      await remote.closeRoom(roomId);
    }
  });
});

function workerRtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 96, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('worker-pipe')).serialize();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for worker pipe transport event');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
