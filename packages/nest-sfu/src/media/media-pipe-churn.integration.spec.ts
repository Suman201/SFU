import { EventEmitter } from 'events';
import type { Consumer, DtlsParameters, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { createPli, parsePli, parseRtcpCompound, PipeTransportManager, RtcpProcessor, RtpPacket, RtpRouter } from '@native-sfu/sfu-core';
import { MediaService } from '../media.service';
import { PipeTransportService } from '../pipe-transport.service';

describe('MediaService cross-node pipe churn integration', () => {
  it('survives repeated remote attach and release cycles across fresh pipe transports', async () => {
    const roomId = 'room-pipe-churn';
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const pipe = new PipeTransportService(new PipeTransportManager());
    const owner = new MediaService(
      ownerIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }),
      pipe
    );
    const remoteDrops: string[] = [];
    const remote = new MediaService(
      remoteIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({
        enablePacing: false,
        enableJoinKeyframeGate: false,
        onDroppedPacket: (reason) => remoteDrops.push(reason)
      }),
      pipe
    );
    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    const ownerPublisher = await owner.createWebRtcTransport(roomId, 'publisher');

    await owner.bindProducer(ownerPublisher.id, 'publisher', sourceRtp);
    await owner.registerProducer(producer('producer-1', roomId, 'publisher', ownerPublisher.id, sourceRtp));

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const ownerPipeId = `pipe-owner-${iteration}`;
      const remotePipeId = `pipe-remote-${iteration}`;
      const subscriberId = `subscriber-${iteration}`;
      const consumerId = `consumer-${iteration}`;
      const remoteForwarded: number[] = [];
      const ownerRtcpForwarded: number[] = [];
      const ownerPipeMediaSsrcs: number[] = [];
      const asyncErrors: string[] = [];

      const ownerPipe = pipe.createTransport({ id: ownerPipeId, roomId, localNodeId: 'node-a', remoteNodeId: 'node-b' });
      const remotePipe = pipe.createTransport({ id: remotePipeId, roomId, localNodeId: 'node-b', remoteNodeId: 'node-a' });
      pipe.connectTransports(ownerPipe, remotePipe);
      pipe.createProducer(ownerPipeId, {
        id: 'producer-1',
        participantId: 'publisher',
        rtpParameters: pipeRtp
      });
      pipe.createProducer(remotePipeId, {
        id: 'producer-1',
        participantId: 'publisher',
        rtpParameters: pipeRtp,
        ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
      });

      const offRtp = pipe.onRtp(remotePipeId, (event) => {
        void remote.handlePipeRtp(remotePipeId, event.producerId, event.packet).then((count) => {
          remoteForwarded.push(count);
        }).catch((error) => {
          asyncErrors.push(errorMessage(error));
        });
      });
      const offRtcp = pipe.onRtcp(ownerPipeId, (event) => {
        ownerPipeMediaSsrcs.push(parsePli(parseRtcpCompound(event.packet)[0]!)?.mediaSsrc ?? -1);
        void owner
          .handlePipeRtcp(ownerPipeId, event.packet, { roomId: event.roomId, sourceParticipantId: subscriberId })
          .then((result) => {
            ownerRtcpForwarded.push(result.forwarded);
          })
          .catch((error) => {
            asyncErrors.push(errorMessage(error));
          });
      });

      try {
        await remote.registerPipeProducer(producer('producer-1', roomId, 'publisher', remotePipeId, pipeRtp), remotePipeId);
        const subscriberTransport = await remote.createWebRtcTransport(roomId, subscriberId);
        await remote.registerConsumer(consumer(consumerId, 'producer-1', roomId, subscriberId, subscriberTransport.id, pipeRtp));

        expect(await pipe.sendRtp(ownerPipeId, 'producer-1', rtpPacket(2222, 10 + iteration, 90_000 + iteration * 3_000))).toBe(true);
        await waitFor(
          () => remoteForwarded[remoteForwarded.length - 1] === 1,
          () =>
            [
              `iteration=${iteration}`,
              `remoteForwarded=${JSON.stringify(remoteForwarded)}`,
              `remoteDrops=${JSON.stringify(remoteDrops)}`,
              `asyncErrors=${JSON.stringify(asyncErrors)}`,
              `ownerSnapshot=${JSON.stringify(pipe.snapshot(ownerPipeId))}`,
              `remoteSnapshot=${JSON.stringify(pipe.snapshot(remotePipeId))}`,
              `remoteStats=${JSON.stringify(remote.adaptiveTransportMetrics().statistics)}`
            ].join(' ')
        );
        await waitFor(() => remoteIce.agent(subscriberTransport.id).sent.length > 0);

        const delivered = RtpPacket.parse(remoteIce.agent(subscriberTransport.id).sent.shift()!);
        expect(delivered.ssrc).toBe(2222);
        expect(delivered.sequenceNumber).toBe(10 + iteration);

        expect(await pipe.sendRtcp(remotePipeId, createPli({ senderSsrc: 9000 + iteration, mediaSsrc: 2222 }), { producerId: 'producer-1' })).toBe(true);
        await waitFor(() => ownerPipeMediaSsrcs[ownerPipeMediaSsrcs.length - 1] !== undefined);
        await waitFor(() => ownerRtcpForwarded[ownerRtcpForwarded.length - 1] !== undefined);

        expect(ownerPipeMediaSsrcs[ownerPipeMediaSsrcs.length - 1]).toBe(1111);
        expect(ownerRtcpForwarded[ownerRtcpForwarded.length - 1]).toBeDefined();
        expect(asyncErrors).toEqual([]);
      } finally {
        offRtp();
        offRtcp();
        await remote.unregisterConsumer(consumerId).catch(() => undefined);
        await remote.closeParticipantTransports(subscriberId).catch(() => undefined);
        await remote.unregisterProducer('producer-1').catch(() => undefined);
        pipe.closeTransport(ownerPipeId, 'iteration_complete');
        pipe.closeTransport(remotePipeId, 'iteration_complete');
      }

      expect(pipe.snapshots().length).toBe(0);
      expect(remoteIce.agentCount()).toBe(0);
    }

    await remote.closeRoom(roomId);
    await owner.closeRoom(roomId);

    expect(pipe.snapshots().length).toBe(0);
    expect(ownerIce.agentCount()).toBe(0);
    expect(remoteIce.agentCount()).toBe(0);
  });

  it('surfaces a repeatable remote-publisher churn signal across fresh pipe transports', async () => {
    const roomId = 'room-remote-publisher-churn';
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const pipe = new PipeTransportService(new PipeTransportManager());
    const owner = new MediaService(
      ownerIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }),
      pipe
    );
    const remote = new MediaService(
      remoteIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }),
      pipe
    );
    const producerId = 'producer-1';
    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    const remotePublisher = await remote.createWebRtcTransport(roomId, 'publisher');

    await remote.bindProducer(remotePublisher.id, 'publisher', sourceRtp);
    await remote.registerProducer(producer(producerId, roomId, 'publisher', remotePublisher.id, sourceRtp));

    for (let iteration = 0; iteration < 16; iteration += 1) {
      const ownerPipeId = `pipe-owner-${iteration}`;
      const remotePipeId = `pipe-remote-${iteration}`;
      const subscriberId = 'subscriber';
      const consumerId = 'consumer-1';
      const pipeConsumerId = 'pipe-consumer-1';
      const ownerForwarded: number[] = [];
      const remotePipePlis: Array<{ senderSsrc: number; mediaSsrc: number }> = [];
      const asyncErrors: string[] = [];

      const ownerPipe = pipe.createTransport({ id: ownerPipeId, roomId, localNodeId: 'node-a', remoteNodeId: 'node-b' });
      const remotePipe = pipe.createTransport({ id: remotePipeId, roomId, localNodeId: 'node-b', remoteNodeId: 'node-a' });
      pipe.connectTransports(ownerPipe, remotePipe);
      pipe.createProducer(ownerPipeId, {
        id: producerId,
        participantId: 'publisher',
        rtpParameters: pipeRtp,
        ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
      });
      pipe.createProducer(remotePipeId, {
        id: producerId,
        participantId: 'publisher',
        rtpParameters: pipeRtp
      });

      const offRtp = pipe.onRtp(ownerPipeId, (event) => {
        void owner.handlePipeRtp(ownerPipeId, event.producerId, event.packet).then((count) => {
          ownerForwarded.push(count);
        }).catch((error) => {
          asyncErrors.push(errorMessage(error));
        });
      });
      const offRtcp = pipe.onRtcp(remotePipeId, (event) => {
        const pli = parsePli(parseRtcpCompound(event.packet)[0]!);
        if (pli) {
          remotePipePlis.push({ senderSsrc: pli.senderSsrc, mediaSsrc: pli.mediaSsrc });
        }
        void remote
          .handlePipeRtcp(remotePipeId, event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' })
          .catch((error) => {
            asyncErrors.push(errorMessage(error));
          });
      });

      try {
        await owner.registerPipeProducer(producer(producerId, roomId, 'publisher', ownerPipeId, pipeRtp), ownerPipeId);
        const subscriberTransport = await owner.createWebRtcTransport(roomId, subscriberId);
        await owner.registerConsumer(consumer(consumerId, producerId, roomId, subscriberId, subscriberTransport.id, pipeRtp));
        const publisherAttachSignalCountBefore = countPliEvents(parseSentPlis(remoteIce.agent(remotePublisher.id).sent), 2222, 1111);
        await remote.registerPipeConsumer(consumer(pipeConsumerId, producerId, roomId, 'pipe:node-a', remotePipeId, pipeRtp), remotePipeId);

        await waitFor(
          () =>
            countPliEvents(remotePipePlis, 1111, 1111) === 1 &&
            countPliEvents(parseSentPlis(remoteIce.agent(remotePublisher.id).sent), 2222, 1111) === publisherAttachSignalCountBefore + 1,
          () =>
            [
              `iteration=${iteration}`,
              `remotePipePlis=${JSON.stringify(remotePipePlis)}`,
              `publisherSentPlis=${JSON.stringify(parseSentPlis(remoteIce.agent(remotePublisher.id).sent))}`,
              `asyncErrors=${JSON.stringify(asyncErrors)}`
            ].join(' ')
        );

        expect(await pipe.sendRtp(remotePipeId, producerId, rtpPacket(2222, 200 + iteration, 180_000 + iteration * 3_000))).toBe(true);
        await waitFor(
          () => ownerForwarded[ownerForwarded.length - 1] === 1,
          () =>
            [
              `iteration=${iteration}`,
              `ownerForwarded=${JSON.stringify(ownerForwarded)}`,
              `ownerSnapshot=${JSON.stringify(pipe.snapshot(ownerPipeId))}`,
              `remoteSnapshot=${JSON.stringify(pipe.snapshot(remotePipeId))}`,
              `asyncErrors=${JSON.stringify(asyncErrors)}`
            ].join(' ')
        );
        await waitFor(() => ownerIce.agent(subscriberTransport.id).sent.length > 0);

        const delivered = RtpPacket.parse(ownerIce.agent(subscriberTransport.id).sent.shift()!);
        expect(delivered.ssrc).toBe(2222);
        expect(delivered.sequenceNumber).toBe(200 + iteration);
        expect(asyncErrors).toEqual([]);
      } finally {
        offRtp();
        offRtcp();
        await owner.closeParticipantTransports(subscriberId).catch(() => undefined);
        await remote.unregisterConsumer(pipeConsumerId).catch(() => undefined);
        await owner.unregisterProducer(producerId).catch(() => undefined);
        pipe.closeTransport(ownerPipeId, 'iteration_complete');
        pipe.closeTransport(remotePipeId, 'iteration_complete');
      }

      expect(pipe.snapshots().length).toBe(0);
      expect(ownerIce.agentCount()).toBe(0);
    }

    await remote.closeRoom(roomId);
    await owner.closeRoom(roomId);

    expect(pipe.snapshots().length).toBe(0);
    expect(ownerIce.agentCount()).toBe(0);
    expect(remoteIce.agentCount()).toBe(0);
  });

  it('remains stable across repeated multi-room publisher and subscriber churn without leaving stale room or pipe state behind', async () => {
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const pipe = new PipeTransportService(new PipeTransportManager());
    const owner = new MediaService(
      ownerIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }),
      pipe
    );
    const remote = new MediaService(
      remoteIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, enableJoinKeyframeGate: false }),
      pipe
    );
    const asyncErrors: string[] = [];
    const roomCount = 6;
    const subscribersPerRoom = 2;

    try {
      for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
        const roomId = `room-operational-${roomIndex}`;
        const producerId = `producer-${roomIndex}`;
        const publisherId = `publisher-${roomIndex}`;
        const ownerPipeId = `pipe-owner-${roomIndex}`;
        const remotePipeId = `pipe-remote-${roomIndex}`;
        const sourceRtp = rtpParameters(4_000 + roomIndex);
        const pipeRtp = rtpParameters(8_000 + roomIndex);
        const ownerPublisher = await owner.createWebRtcTransport(roomId, publisherId);
        const remoteForwarded: number[] = [];
        const subscriberBindings: Array<{ participantId: string; consumerId: string; transportId: string }> = [];

        await owner.bindProducer(ownerPublisher.id, publisherId, sourceRtp);
        await owner.registerProducer(producer(producerId, roomId, publisherId, ownerPublisher.id, sourceRtp));
        const ownerPipe = pipe.createTransport({ id: ownerPipeId, roomId, localNodeId: 'node-a', remoteNodeId: 'node-b' });
        const remotePipe = pipe.createTransport({ id: remotePipeId, roomId, localNodeId: 'node-b', remoteNodeId: 'node-a' });
        pipe.connectTransports(ownerPipe, remotePipe);
        pipe.createProducer(ownerPipeId, {
          id: producerId,
          participantId: publisherId,
          rtpParameters: pipeRtp
        });
        pipe.createProducer(remotePipeId, {
          id: producerId,
          participantId: publisherId,
          rtpParameters: pipeRtp,
          ssrcMappings: [{ sourceSsrc: 8_000 + roomIndex, targetSsrc: 4_000 + roomIndex }]
        });

        const offRtp = pipe.onRtp(remotePipeId, (event) => {
          void remote.handlePipeRtp(remotePipeId, event.producerId, event.packet).then((count) => {
            remoteForwarded.push(count);
          }).catch((error) => {
            asyncErrors.push(errorMessage(error));
          });
        });

        try {
          await remote.registerPipeProducer(producer(producerId, roomId, publisherId, remotePipeId, pipeRtp), remotePipeId);

          for (let subscriberIndex = 0; subscriberIndex < subscribersPerRoom; subscriberIndex += 1) {
            const participantId = `subscriber-${roomIndex}-${subscriberIndex}`;
            const consumerId = `consumer-${roomIndex}-${subscriberIndex}`;
            const subscriberTransport = await remote.createWebRtcTransport(roomId, participantId);
            subscriberBindings.push({ participantId, consumerId, transportId: subscriberTransport.id });
            await remote.registerConsumer(consumer(consumerId, producerId, roomId, participantId, subscriberTransport.id, pipeRtp));
          }

          expect(
            await pipe.sendRtp(ownerPipeId, producerId, rtpPacket(8_000 + roomIndex, 500 + roomIndex, 360_000 + roomIndex * 3_000))
          ).toBe(true);
          await waitFor(
            () => remoteForwarded[remoteForwarded.length - 1] === subscribersPerRoom,
            () =>
              [
                `roomId=${roomId}`,
                `forwarded=${JSON.stringify(remoteForwarded)}`,
                `ownerSnapshot=${JSON.stringify(pipe.snapshot(ownerPipeId))}`,
                `remoteSnapshot=${JSON.stringify(pipe.snapshot(remotePipeId))}`,
                `asyncErrors=${JSON.stringify(asyncErrors)}`
              ].join(' ')
          );
          for (const binding of subscriberBindings) {
            await waitFor(() => remoteIce.agent(binding.transportId).sent.length > 0);
            const delivered = RtpPacket.parse(remoteIce.agent(binding.transportId).sent.shift()!);
            expect(delivered.ssrc).toBe(8_000 + roomIndex);
            expect(delivered.sequenceNumber).toBe(500 + roomIndex);
          }
        } finally {
          offRtp();
          for (const binding of subscriberBindings) {
            await remote.unregisterConsumer(binding.consumerId).catch(() => undefined);
            await remote.closeParticipantTransports(binding.participantId).catch(() => undefined);
          }
          await remote.unregisterProducer(producerId).catch(() => undefined);
          pipe.closeTransport(ownerPipeId, 'room_cycle_complete');
          pipe.closeTransport(remotePipeId, 'room_cycle_complete');
          await remote.closeRoom(roomId).catch(() => undefined);
          await owner.closeRoom(roomId).catch(() => undefined);
        }

        expect(pipe.snapshots().length).toBe(0);
        expect(ownerIce.agentCount()).toBe(0);
        expect(remoteIce.agentCount()).toBe(0);
        expect(owner.adaptiveTransportMetrics().statistics.rooms.map((state) => state.roomId)).not.toContain(roomId);
        expect(remote.adaptiveTransportMetrics().statistics.rooms.map((state) => state.roomId)).not.toContain(roomId);
        expect(owner.adaptiveTransportMetrics().quality.rooms.map((state) => state.roomId)).not.toContain(roomId);
        expect(remote.adaptiveTransportMetrics().quality.rooms.map((state) => state.roomId)).not.toContain(roomId);
      }
    } finally {
      expect(asyncErrors).toEqual([]);
    }
  });
});

function producer(id: string, roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
  return {
    id,
    roomId,
    participantId,
    kind: 'video',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function consumer(
  id: string,
  producerId: string,
  roomId: string,
  participantId: string,
  transportId: string,
  rtpParameters: RtpParameters
): Consumer {
  return {
    id,
    producerId,
    participantId,
    roomId,
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rtpParameters(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-video', reducedSize: true }
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 96, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('pipe-churn')).serialize();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countPliEvents(plis: Array<{ senderSsrc: number; mediaSsrc: number }>, senderSsrc: number, mediaSsrc: number): number {
  return plis.filter((pli) => pli.senderSsrc === senderSsrc && pli.mediaSsrc === mediaSsrc).length;
}

function parseSentPlis(packets: Buffer[]): Array<{ senderSsrc: number; mediaSsrc: number }> {
  return packets.flatMap((packet) => {
    try {
      const pli = parsePli(parseRtcpCompound(packet)[0]!);
      return pli ? [{ senderSsrc: pli.senderSsrc, mediaSsrc: pli.mediaSsrc }] : [];
    } catch {
      return [];
    }
  });
}

function fakeIceService(): {
  createAgent: jest.Mock;
  validateCandidate: jest.Mock;
  addRemoteCandidate: jest.Mock;
  setRemoteParameters: jest.Mock;
  restartAgent: jest.Mock;
  closeAgent: jest.Mock;
  agent: (transportId: string) => FakeIceAgent;
  agentCount: () => number;
} {
  const agents = new Map<string, FakeIceAgent>();
  return {
    createAgent: jest.fn(async (transportId: string) => {
      const agent = Object.assign(new EventEmitter(), {
        sent: [] as Buffer[],
        snapshot: () => ({
          localParameters: { usernameFragment: `ufrag-${transportId}`, password: `pwd-${transportId}`, iceLite: false },
          localCandidates: []
        }),
        sendSelectedDatagram: jest.fn(async function (this: FakeIceAgent, packet: Buffer) {
          this.sent.push(packet);
        })
      }) as FakeIceAgent;
      agents.set(transportId, agent);
      return agent;
    }),
    validateCandidate: jest.fn(),
    addRemoteCandidate: jest.fn(),
    setRemoteParameters: jest.fn(),
    restartAgent: jest.fn(),
    closeAgent: jest.fn((transportId: string) => {
      agents.delete(transportId);
    }),
    agent: (transportId: string) => {
      const agent = agents.get(transportId);
      if (!agent) {
        throw new Error(`Missing fake ICE agent ${transportId}`);
      }
      return agent;
    },
    agentCount: () => agents.size
  };
}

function fakeDtlsService(): any {
  return {
    createTransport: jest.fn(async (transportId: string) =>
      Object.assign(new EventEmitter(), {
        transportId
      })
    ),
    createParameters: jest.fn(async (): Promise<DtlsParameters> => ({ role: 'auto', fingerprints: [] })),
    setRemoteParameters: jest.fn(),
    closeTransport: jest.fn()
  };
}

function fakeSrtpService(): any {
  const session = {
    setInboundSsrcs: jest.fn(),
    setOutboundSsrcs: jest.fn(),
    protectRtp: jest.fn(async (packet: Buffer) => packet),
    protectRtcp: jest.fn(async (packet: Buffer) => packet),
    unprotectRtp: jest.fn(async (packet: Buffer) => packet),
    unprotectRtcp: jest.fn(async (packet: Buffer) => packet)
  };
  return {
    createSession: jest.fn(() => session),
    getSession: jest.fn(() => session),
    closeSession: jest.fn()
  };
}

async function waitFor(predicate: () => boolean, describe?: () => string, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      const suffix = describe ? `: ${describe()}` : '';
      throw new Error(`Timed out waiting for pipe churn media event${suffix}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeIceAgent extends EventEmitter {
  sent: Buffer[];
  snapshot: () => {
    localParameters: TransportOptions['iceParameters'];
    localCandidates: TransportOptions['iceCandidates'];
  };
  sendSelectedDatagram: (packet: Buffer) => Promise<void>;
}
