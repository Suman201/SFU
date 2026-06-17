import { EventEmitter } from 'events';
import type { Consumer, DtlsParameters, Producer, RtpParameters, TransportOptions } from '@native-sfu/contracts';
import { PipeTransportManager, RtcpProcessor, RtpPacket, RtpRouter, createPli, createSenderReport } from '@native-sfu/sfu-core';
import { MediaService } from '../media.service';
import { PipeTransportService } from '../pipe-transport.service';

describe('MediaService pipe transport integration', () => {
  it('bridges owner RTP to a remote local subscriber and routes remote RTCP back to the owner producer', async () => {
    const pipeManager = new PipeTransportManager();
    const pipe = new PipeTransportService(pipeManager);
    const owner = new MediaService(fakeIceService(), fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const remoteIce = fakeIceService();
    const remoteDrops: string[] = [];
    const remote = new MediaService(
      remoteIce,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false, onDroppedPacket: (reason) => remoteDrops.push(reason) }),
      pipe
    );
    const ownerPipe = pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remotePipe = pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    pipe.connectTransports(ownerPipe, remotePipe);

    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    pipe.createProducer('pipe-owner', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    pipe.createProducer('pipe-remote', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp,
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    const remotePipeRtp = new Promise<number>((resolve, reject) => {
      pipe.onRtp('pipe-remote', (event) => {
        remote.handlePipeRtp('pipe-remote', event.producerId, event.packet).then(resolve, reject);
      });
    });
    pipe.onRtcp('pipe-owner', (event) => {
      void owner.handlePipeRtcp('pipe-owner', event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' });
    });

    const ownerPublisher = await owner.createWebRtcTransport('room-1', 'publisher');
    await owner.bindProducer(ownerPublisher.id, 'publisher', sourceRtp);
    await owner.registerProducer(producer('producer-1', 'room-1', 'publisher', ownerPublisher.id, sourceRtp));
    await remote.registerPipeProducer(producer('producer-1', 'room-1', 'publisher', 'pipe-remote', pipeRtp), 'pipe-remote');
    expect(remote.producerLayerState('producer-1')?.availableLayers[0]?.ssrc).toBe(2222);
    const remoteSubscriber = await remote.createWebRtcTransport('room-1', 'subscriber');
    await remote.registerConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: remoteSubscriber.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    expect(await pipe.sendRtp('pipe-owner', 'producer-1', rtpPacket(2222, 10, 90_000))).toBe(true);
    const forwardedCount = await remotePipeRtp;
    expect({ forwardedCount, remoteDrops }).toEqual({ forwardedCount: 1, remoteDrops: [] });
    await waitFor(() => remoteIce.agent(remoteSubscriber.id).sent.length > 0);

    const forwarded = RtpPacket.parse(remoteIce.agent(remoteSubscriber.id).sent.shift()!);
    expect(forwarded.ssrc).toBe(2222);
    expect(forwarded.sequenceNumber).toBe(10);
    expect(forwarded.timestamp).toBe(90_000);

    await remote.handleRtcp(remoteSubscriber.id, 'subscriber', createPli({ senderSsrc: 9999, mediaSsrc: 2222 }));
    await waitFor(() => fakeAgent(owner, ownerPublisher.id).sent.length > 0);
    expect(fakeAgent(owner, ownerPublisher.id).sent[0]).toEqual(createPli({ senderSsrc: 9999, mediaSsrc: 1111 }));
  });

  it('bridges remote publisher RTP to an owner subscriber and routes owner RTCP back to the remote producer', async () => {
    const pipeManager = new PipeTransportManager();
    const pipe = new PipeTransportService(pipeManager);
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const owner = new MediaService(ownerIce, fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const remote = new MediaService(remoteIce, fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const ownerPipe = pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remotePipe = pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    pipe.connectTransports(ownerPipe, remotePipe);

    const sourceRtp = rtpParameters(1111);
    const pipeRtp = rtpParameters(2222);
    pipe.createProducer('pipe-owner', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp,
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    pipe.createProducer('pipe-remote', {
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    const ownerPipeRtp = new Promise<number>((resolve, reject) => {
      pipe.onRtp('pipe-owner', (event) => {
        owner.handlePipeRtp('pipe-owner', event.producerId, event.packet).then(resolve, reject);
      });
    });
    pipe.onRtcp('pipe-remote', (event) => {
      void remote.handlePipeRtcp('pipe-remote', event.packet, { roomId: event.roomId, sourceParticipantId: 'subscriber' });
    });

    const remotePublisher = await remote.createWebRtcTransport('room-1', 'publisher');
    await remote.bindProducer(remotePublisher.id, 'publisher', sourceRtp);
    await remote.registerProducer(producer('producer-1', 'room-1', 'publisher', remotePublisher.id, sourceRtp));
    await owner.registerPipeProducer(producer('producer-1', 'room-1', 'publisher', 'pipe-owner', pipeRtp), 'pipe-owner');
    const ownerSubscriber = await owner.createWebRtcTransport('room-1', 'subscriber');
    await owner.registerConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: ownerSubscriber.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await remote.registerPipeConsumer({
      id: 'pipe-consumer-1',
      producerId: 'producer-1',
      participantId: 'pipe:node-a',
      roomId: 'room-1',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-remote');

    expect(await pipe.sendRtp('pipe-remote', 'producer-1', rtpPacket(2222, 10, 90_000))).toBe(true);
    const forwardedCount = await ownerPipeRtp;
    expect(forwardedCount).toBe(1);
    await waitFor(() => ownerIce.agent(ownerSubscriber.id).sent.length > 0);

    const delivered = RtpPacket.parse(ownerIce.agent(ownerSubscriber.id).sent.shift()!);
    expect(delivered.ssrc).toBe(2222);
    expect(delivered.sequenceNumber).toBe(10);
    expect(delivered.timestamp).toBe(90_000);

    await owner.handleRtcp(ownerSubscriber.id, 'subscriber', createPli({ senderSsrc: 9999, mediaSsrc: 2222 }));
    await waitFor(() => fakeAgent(remote, remotePublisher.id).sent.length > 0);
    expect(fakeAgent(remote, remotePublisher.id).sent[0]).toEqual(createPli({ senderSsrc: 9999, mediaSsrc: 1111 }));
  });

  it('includes pipe-only transports and rooms in adaptive transport snapshots', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    const service = new MediaService(fakeIceService(), fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);

    pipe.createTransport({ id: 'pipe-only', roomId: 'room-pipe-only', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    await service.registerPipeProducer(producer('producer-pipe-only', 'room-pipe-only', 'publisher', 'pipe-only', rtpParameters(3333)), 'pipe-only');
    await service.registerPipeConsumer(
      {
        id: 'consumer-pipe-only',
        producerId: 'producer-pipe-only',
        participantId: 'pipe:node-b',
        roomId: 'room-pipe-only',
        transportId: 'pipe-only',
        rtpParameters: rtpParameters(3333),
        status: 'live',
        createdAt: new Date().toISOString()
      },
      'pipe-only'
    );

    const metrics = service.adaptiveTransportMetrics();

    expect(metrics.quality.transports.map((state) => state.transportId)).toContain('pipe-only');
    expect(metrics.quality.rooms.map((state) => state.roomId)).toContain('room-pipe-only');
    expect(metrics.statistics.rooms.map((state) => state.roomId)).toContain('room-pipe-only');
  });

  it('routes pipe-consumer feedback to the local upstream producer transport and requests an initial keyframe when the producer is local', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    const router = createRouterStub();
    const service = new MediaService(
      fakeIceService(),
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      router as unknown as RtpRouter,
      pipe
    );
    const sourceRtp = videoRtpParameters(1111);
    const pipeRtp = videoRtpParameters(2222);
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
    const pipeConsumer: Consumer = {
      id: 'pipe-consumer-1',
      producerId: 'producer-1',
      participantId: 'pipe:node-a',
      roomId: 'room-1',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    };

    await service.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
    await service.registerProducer({
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters: sourceRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    const pipeSendRtcp = jest.spyOn(pipe, 'sendRtcp');
    await service.registerPipeConsumer(pipeConsumer, 'pipe-remote');
    expect(router.consumerRtcpCallback).toBeDefined();
    expect(fakeAgent(service, publisherTransport.id).sent[0]).toEqual(createPli({ senderSsrc: 2222, mediaSsrc: 1111 }));

    const pli = createPli({ senderSsrc: 9999, mediaSsrc: 2222 });
    await router.consumerRtcpCallback!(pli, pipeConsumer);

    expect(fakeAgent(service, publisherTransport.id).sent[1]).toEqual(pli);
    expect(pipeSendRtcp).not.toHaveBeenCalled();
  });

  it('routes subscriber feedback for pipe-backed producers back across the pipe transport', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const router = createRouterStub();
    const service = new MediaService(
      fakeIceService(),
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      router as unknown as RtpRouter,
      pipe
    );
    const pipeRtp = videoRtpParameters(2222);
    const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');
    const consumer: Consumer = {
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    };

    await service.registerPipeProducer({
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: 'pipe-owner',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-owner');
    const pipeSendRtcp = jest.spyOn(pipe, 'sendRtcp').mockResolvedValue(true);
    await service.registerConsumer(consumer);
    expect(router.consumerRtcpCallback).toBeDefined();
    expect(pipeSendRtcp).toHaveBeenCalledTimes(1);
    expect(pipeSendRtcp.mock.calls[0]).toEqual([
      'pipe-owner',
      createPli({ senderSsrc: 2222, mediaSsrc: 2222 }),
      { producerId: 'producer-1' }
    ]);

    const pli = createPli({ senderSsrc: 9999, mediaSsrc: 2222 });
    await router.consumerRtcpCallback!(pli, consumer);

    expect(pipeSendRtcp).toHaveBeenCalledTimes(2);
    expect(pipeSendRtcp).toHaveBeenCalledWith('pipe-owner', pli, { producerId: 'producer-1' });
  });

  it('routes sender reports downstream to local consumers instead of back to the producer transport', async () => {
    const service = new MediaService(
      fakeIceService(),
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false }),
      new PipeTransportService(new PipeTransportManager())
    );
    const sourceRtp = videoRtpParameters(1111);
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');
    const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');

    await service.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
    await service.registerProducer({
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters: sourceRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await service.registerConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      rtpParameters: sourceRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    const senderReport = createSenderReport({
      senderSsrc: 1111,
      ntpTimestamp: 1n,
      rtpTimestamp: 90_000,
      packetCount: 1,
      octetCount: 160
    });
    await service.handleRtcp(publisherTransport.id, 'publisher', senderReport);

    await waitFor(() => fakeAgent(service, subscriberTransport.id).sent.some((packet) => packet.equals(senderReport)));
    expect(fakeAgent(service, subscriberTransport.id).sent.some((packet) => packet.equals(senderReport))).toBe(true);
    expect(fakeAgent(service, publisherTransport.id).sent.some((packet) => packet.equals(senderReport))).toBe(false);
  });

  it('keeps pipe-backed video consumers gated until a keyframe arrives while requesting an initial keyframe', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const service = new MediaService(
      fakeIceService(),
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({ enablePacing: false }),
      pipe
    );
    const pipeRtp = videoRtpParameters(2222);
    const subscriberTransport = await service.createWebRtcTransport('room-1', 'subscriber');

    await service.registerPipeProducer({
      id: 'producer-video-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: 'pipe-owner',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-owner');
    const pipeSendRtcp = jest.spyOn(pipe, 'sendRtcp').mockResolvedValue(true);
    await service.registerConsumer({
      id: 'consumer-video-1',
      producerId: 'producer-video-1',
      participantId: 'subscriber',
      roomId: 'room-1',
      transportId: subscriberTransport.id,
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });

    expect(pipeSendRtcp).toHaveBeenCalledWith(
      'pipe-owner',
      createPli({ senderSsrc: 2222, mediaSsrc: 2222 }),
      { producerId: 'producer-video-1' }
    );

    const dropped = await service.handlePipeRtp('pipe-owner', 'producer-video-1', videoRtpPacket(2222, 9, 87_000, false));
    expect(dropped).toBe(0);
    expect(fakeAgent(service, subscriberTransport.id).sent.length).toBe(0);

    const forwarded = await service.handlePipeRtp('pipe-owner', 'producer-video-1', videoRtpPacket(2222, 10, 90_000, true));
    expect(forwarded).toBe(1);
    await waitFor(() => fakeAgent(service, subscriberTransport.id).sent.length > 0);

    const delivered = RtpPacket.parse(fakeAgent(service, subscriberTransport.id).sent.shift()!);
    expect(delivered.ssrc).toBe(2222);
    expect(delivered.sequenceNumber).toBe(10);
    expect(delivered.timestamp).toBe(90_000);
  });

  it('rewrites inbound pipe RTCP SSRCs back to the local producer before routing feedback', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    const service = new MediaService(fakeIceService(), fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const sourceRtp = videoRtpParameters(1111);
    const pipeRtp = videoRtpParameters(2222);
    const publisherTransport = await service.createWebRtcTransport('room-1', 'publisher');

    await service.bindProducer(publisherTransport.id, 'publisher', sourceRtp);
    await service.registerProducer({
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: publisherTransport.id,
      rtpParameters: sourceRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    });
    await service.registerPipeConsumer({
      id: 'pipe-consumer-rtcp-rewrite',
      producerId: 'producer-1',
      participantId: 'pipe:node-a',
      roomId: 'room-1',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-remote');

    await service.handlePipeRtcp('pipe-remote', createPli({ senderSsrc: 9999, mediaSsrc: 2222 }), {
      roomId: 'room-1',
      sourceParticipantId: 'subscriber'
    });

    await waitFor(() => fakeAgent(service, publisherTransport.id).sent.length > 1);
    const expected = createPli({ senderSsrc: 9999, mediaSsrc: 1111 });
    expect(fakeAgent(service, publisherTransport.id).sent.some((packet) => packet.equals(expected))).toBe(true);
  });

  it('removes pipe-backed media state when a pipe transport closes', async () => {
    const pipe = new PipeTransportService(new PipeTransportManager());
    pipe.createTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    const service = new MediaService(fakeIceService(), fakeDtlsService(), fakeSrtpService(), new RtcpProcessor(), new RtpRouter({ enablePacing: false }), pipe);
    const pipeRtp = videoRtpParameters(2222);

    await service.registerPipeProducer({
      id: 'producer-1',
      roomId: 'room-1',
      participantId: 'publisher',
      kind: 'video',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-remote');
    await service.registerPipeConsumer({
      id: 'pipe-consumer-1',
      producerId: 'producer-1',
      participantId: 'pipe:node-a',
      roomId: 'room-1',
      transportId: 'pipe-remote',
      rtpParameters: pipeRtp,
      status: 'live',
      createdAt: new Date().toISOString()
    }, 'pipe-remote');

    await service.closePipeTransport('pipe-remote');

    expect(service.getProducer('producer-1')).toBeUndefined();
    expect(await service.handlePipeRtp('pipe-remote', 'producer-1', videoRtpPacket(2222, 1, 90_000))).toBe(0);
  });

  it('proves owner-side adaptive downgrade and recovery from distributed subscriber feedback across a live multi-layer pipe path', async () => {
    const roomId = 'room-distributed-adaptive-signoff';
    const ownerIce = fakeIceService();
    const remoteIce = fakeIceService();
    const pipe = new PipeTransportService(new PipeTransportManager());
    const owner = new MediaService(
      ownerIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({
        enablePacing: false,
        enableJoinKeyframeGate: false,
        qualityUpdateIntervalMs: 0,
        sequenceNumberGenerator: () => 32000,
        timestampGenerator: () => 900000
      }),
      pipe
    );
    const remote = new MediaService(
      remoteIce as any,
      fakeDtlsService(),
      fakeSrtpService(),
      new RtcpProcessor(),
      new RtpRouter({
        enablePacing: false,
        enableJoinKeyframeGate: false,
        qualityUpdateIntervalMs: 0,
        sequenceNumberGenerator: () => 42000,
        timestampGenerator: () => 1200000
      }),
      pipe
    );

    const ownerPipeId = 'pipe-owner-adaptive';
    const remotePipeId = 'pipe-remote-adaptive';
    const ownerProducerId = 'producer-adaptive';
    const ownerPipeConsumerId = 'pipe-consumer-adaptive';
    const remoteConsumerId = 'consumer-adaptive';
    const sourceRtp = simulcastVideoRtpParameters(1111);
    const pipeRtp = simulcastVideoRtpParameters(2111);
    const remoteForwarded: number[] = [];
    const asyncErrors: string[] = [];

    const ownerPipe = pipe.createTransport({ id: ownerPipeId, roomId, localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remotePipe = pipe.createTransport({ id: remotePipeId, roomId, localNodeId: 'node-b', remoteNodeId: 'node-a' });
    pipe.connectTransports(ownerPipe, remotePipe);
    pipe.createProducer(ownerPipeId, {
      id: ownerProducerId,
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    pipe.createProducer(remotePipeId, {
      id: ownerProducerId,
      participantId: 'publisher',
      rtpParameters: pipeRtp
    });
    const offRtp = pipe.onRtp(remotePipeId, (event) => {
      void remote.handlePipeRtp(remotePipeId, event.producerId, event.packet).then((count) => {
        remoteForwarded.push(count);
      }).catch((error) => {
        asyncErrors.push(errorMessage(error));
      });
    });

    try {
      const ownerPublisher = await owner.createWebRtcTransport(roomId, 'publisher');
      const remoteSubscriber = await remote.createWebRtcTransport(roomId, 'subscriber');

      await owner.bindProducer(ownerPublisher.id, 'publisher', sourceRtp);
      await owner.registerProducer(videoProducer(ownerProducerId, roomId, 'publisher', ownerPublisher.id, sourceRtp));
      await owner.registerPipeConsumer(
        {
          id: ownerPipeConsumerId,
          producerId: ownerProducerId,
          participantId: 'pipe:node-b',
          roomId,
          transportId: ownerPipeId,
          preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
          rtpParameters: pipeRtp,
          status: 'live',
          createdAt: new Date().toISOString()
        },
        ownerPipeId
      );
      await remote.registerPipeProducer(videoProducer(ownerProducerId, roomId, 'publisher', remotePipeId, pipeRtp), remotePipeId);
      await remote.registerConsumer({
        id: remoteConsumerId,
        producerId: ownerProducerId,
        participantId: 'subscriber',
        roomId,
        transportId: remoteSubscriber.id,
        preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
        rtpParameters: singleConsumerVideoRtp(9000),
        status: 'live',
        createdAt: new Date().toISOString()
      });

      let inboundCount = 0;
      const emitOwnerRtp = async (packet: Buffer) => {
        inboundCount += 1;
        fakeAgent(owner, ownerPublisher.id).emit('data', { message: packet });
        await waitFor(() => owner.mediaCounters(ownerPublisher.id, 'publisher').inboundPackets >= inboundCount);
      };
      const bridgeObservation = (observation: Parameters<MediaService['applyConsumerTwccObservation']>[1]) => {
        const remoteState = remote.applyConsumerTwccObservation(remoteConsumerId, observation);
        const ownerState = owner.applyConsumerTwccObservation(ownerPipeConsumerId, observation);
        return { remoteState, ownerState };
      };

      await emitOwnerRtp(simulcastVideoRtpPacket(3333, 10, 90_000, 0, true));

      await waitFor(() => fakeAgent(remote, remoteSubscriber.id).sent.length > 0);
      await waitFor(() => owner.consumerLayerState(ownerPipeConsumerId)?.currentLayers?.spatialLayer === 2);
      await waitFor(() => remote.consumerLayerState(remoteConsumerId)?.currentLayers?.spatialLayer === 2);
      expect(owner.producerLayerState(ownerProducerId)?.dynacast?.desiredLayers.some((layer) => layer.spatialLayer === 2)).toBe(true);

      const baselineBandwidth = owner.adaptiveTransportMetrics().bandwidth.find((estimate) => estimate.id === ownerPipeConsumerId);

      let degradedBridgeState: ReturnType<typeof bridgeObservation> | undefined;
      for (let round = 0; round < 6; round += 1) {
        degradedBridgeState = bridgeObservation({
          packetLoss: 0.24,
          delayVariationMs: 130,
          jitter: 95,
          rtt: 180,
          sendDeltaMs: 20,
          receiveDeltaMs: 92,
          timestamp: 2000 + round * 20
        });
      }
      const packetsBeforeDegradeRecovery = fakeAgent(remote, remoteSubscriber.id).sent.length;
      await emitOwnerRtp(simulcastVideoRtpPacket(3333, 11, 93_000, 1, false));
      await emitOwnerRtp(simulcastVideoRtpPacket(1111, 12, 96_000, 0, true));

      await waitFor(() => owner.consumerLayerState(ownerPipeConsumerId)?.currentLayers?.spatialLayer === 0);
      await waitFor(() => remote.consumerLayerState(remoteConsumerId)?.currentLayers?.spatialLayer === 0);
      await waitFor(() => fakeAgent(remote, remoteSubscriber.id).sent.length > packetsBeforeDegradeRecovery);
      const degradedBandwidth = owner.adaptiveTransportMetrics().bandwidth.find((estimate) => estimate.id === ownerPipeConsumerId);
      const degradedOwnerState = owner.consumerQualityState(ownerPipeConsumerId);
      const degradedRemoteState = remote.consumerQualityState(remoteConsumerId);

      expect(degradedBridgeState?.ownerState?.score.reasons).toContain('packet_loss');
      expect(degradedBridgeState?.remoteState?.score.reasons).toContain('packet_loss');
      expect(degradedOwnerState?.score.reasons).toContain('packet_loss');
      expect(degradedRemoteState?.score.reasons).toContain('packet_loss');
      expect(owner.consumerLayerState(ownerPipeConsumerId)?.currentLayers?.spatialLayer).toBe(0);
      expect(remote.consumerLayerState(remoteConsumerId)?.currentLayers?.spatialLayer).toBe(0);
      expect(degradedBandwidth?.recommendedBitrate ?? Number.POSITIVE_INFINITY).toBeLessThan(
        baselineBandwidth?.recommendedBitrate ?? Number.POSITIVE_INFINITY
      );

      let recoveredBridgeState: ReturnType<typeof bridgeObservation> | undefined;
      for (let round = 0; round < 12; round += 1) {
        recoveredBridgeState = bridgeObservation({
          packetLoss: 0,
          delayVariationMs: 4,
          jitter: 2,
          rtt: 24,
          sendDeltaMs: 20,
          receiveDeltaMs: 16,
          timestamp: 3000 + round * 20
        });
      }
      const packetsBeforeRecovery = fakeAgent(remote, remoteSubscriber.id).sent.length;
      for (let round = 0; round < 6; round += 1) {
        await emitOwnerRtp(simulcastVideoRtpPacket(1111, 13 + round, 99_000 + round * 3_000, 0, round === 0));
      }
      await emitOwnerRtp(simulcastVideoRtpPacket(3333, 12, 117_000, 0, true));

      await waitFor(() => owner.consumerLayerState(ownerPipeConsumerId)?.currentLayers?.spatialLayer === 2);
      await waitFor(() => remote.consumerLayerState(remoteConsumerId)?.currentLayers?.spatialLayer === 2);
      await waitFor(() => fakeAgent(remote, remoteSubscriber.id).sent.length > packetsBeforeRecovery);
      const recoveredBandwidth = owner.adaptiveTransportMetrics().bandwidth.find((estimate) => estimate.id === ownerPipeConsumerId);
      const recoveredOwnerState = owner.consumerQualityState(ownerPipeConsumerId);
      const recoveredRemoteState = remote.consumerQualityState(remoteConsumerId);

      expect(recoveredBridgeState?.ownerState?.score.reasons).not.toContain('packet_loss');
      expect(recoveredBridgeState?.remoteState?.score.reasons).not.toContain('packet_loss');
      expect(recoveredOwnerState?.score.reasons).not.toContain('packet_loss');
      expect(recoveredRemoteState?.score.reasons).not.toContain('packet_loss');
      expect(recoveredBandwidth?.recommendedBitrate ?? 0).toBeGreaterThan(degradedBandwidth?.recommendedBitrate ?? 0);
      expect(owner.producerLayerState(ownerProducerId)?.dynacast?.desiredLayers.some((layer) => layer.spatialLayer === 2)).toBe(true);
      expect(remoteForwarded.some((count) => count > 0)).toBe(true);
      expect(asyncErrors).toEqual([]);
    } finally {
      offRtp();
      await remote.closeRoom(roomId).catch(() => undefined);
      await owner.closeRoom(roomId).catch(() => undefined);
      pipe.closeTransport(ownerPipeId, 'test_complete');
      pipe.closeTransport(remotePipeId, 'test_complete');
    }
  });
});

function producer(id: string, roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
  return {
    id,
    roomId,
    participantId,
    kind: 'audio',
    transportId,
    rtpParameters,
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function rtpParameters(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-audio', reducedSize: true }
  };
}

function videoRtpParameters(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-video', reducedSize: true }
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 111, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('pipe-media')).serialize();
}

function videoRtpPacket(ssrc: number, sequenceNumber: number, timestamp: number, keyframe = false): Buffer {
  return new RtpPacket(
    2,
    false,
    false,
    false,
    96,
    sequenceNumber,
    timestamp,
    ssrc,
    [],
    null,
    Buffer.from(keyframe ? [0x10, 0x00, 0xaa, 0xbb] : [0x10, 0x01, 0xaa, 0xbb])
  ).serialize();
}

function simulcastVideoRtpPacket(
  ssrc: number,
  sequenceNumber: number,
  timestamp: number,
  temporalLayer: number,
  keyframe = false
): Buffer {
  const payload = Buffer.alloc(4000, 0xaa);
  payload[0] = 0x90;
  payload[1] = 0x20;
  payload[2] = (temporalLayer & 0x03) << 6;
  payload[3] = keyframe ? 0x00 : 0x01;
  payload[4] = 0x00;
  return new RtpPacket(
    2,
    false,
    false,
    false,
    96,
    sequenceNumber,
    timestamp,
    ssrc,
    [],
    null,
    payload
  ).serialize();
}

function simulcastVideoRtpParameters(firstSsrc = 1111): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [
      { rid: 'low', ssrc: firstSsrc, spatialLayer: 0, maxBitrate: 180_000 },
      { rid: 'medium', ssrc: firstSsrc + 1111, spatialLayer: 1, maxBitrate: 350_000 },
      { rid: 'high', ssrc: firstSsrc + 2222, spatialLayer: 2, maxBitrate: 550_000 }
    ],
    simulcast: { direction: 'send', rids: ['low', 'medium', 'high'] },
    rtcp: { cname: 'pipe-simulcast-video', reducedSize: true }
  };
}

function singleConsumerVideoRtp(ssrc: number): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-video-consumer', reducedSize: true }
  };
}

function videoProducer(id: string, roomId: string, participantId: string, transportId: string, rtpParameters: RtpParameters): Producer {
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

function fakeAgent(service: MediaService, transportId: string): FakeIceAgent {
  const ice = (service as unknown as { ice: ReturnType<typeof fakeIceService> }).ice;
  return ice.agent(transportId);
}

interface RouterStub {
  consumerRtcpCallback?: (packet: Buffer, consumer: Consumer) => Promise<void>;
  onConsumerLayerEvent: jest.Mock;
  onProducerDynacastEvent: jest.Mock;
  onConsumerTwccObservation: jest.Mock;
  onConsumerScoreUpdated: jest.Mock;
  onProducerScoreUpdated: jest.Mock;
  onTransportQualityUpdated: jest.Mock;
  onRoomQualityUpdated: jest.Mock;
  addProducer: jest.Mock;
  addConsumer: jest.Mock;
  removeProducer: jest.Mock;
  removeConsumer: jest.Mock;
  removeParticipant: jest.Mock;
  removeRoom: jest.Mock;
  producerDynacastSnapshot: jest.Mock;
  producerLayerSnapshot: jest.Mock;
  consumerLayerSnapshot: jest.Mock;
  consumerQualitySnapshot: jest.Mock;
  producerQualitySnapshot: jest.Mock;
  transportQualitySnapshot: jest.Mock;
  roomQualitySnapshot: jest.Mock;
  bandwidthEstimates: jest.Mock;
  pacingSnapshots: jest.Mock;
  statistics: jest.Mock;
}

function createRouterStub(): RouterStub {
  const router: RouterStub = {
    consumerRtcpCallback: undefined,
    onConsumerLayerEvent: jest.fn(),
    onProducerDynacastEvent: jest.fn(),
    onConsumerTwccObservation: jest.fn(),
    onConsumerScoreUpdated: jest.fn(),
    onProducerScoreUpdated: jest.fn(),
    onTransportQualityUpdated: jest.fn(),
    onRoomQualityUpdated: jest.fn(),
    addProducer: jest.fn(),
    addConsumer: jest.fn((_consumer, _onRtp, onRtcp) => {
      router.consumerRtcpCallback = onRtcp;
    }),
    removeProducer: jest.fn(),
    removeConsumer: jest.fn(),
    removeParticipant: jest.fn(),
    removeRoom: jest.fn(),
    producerDynacastSnapshot: jest.fn(() => undefined),
    producerLayerSnapshot: jest.fn(() => undefined),
    consumerLayerSnapshot: jest.fn(() => undefined),
    consumerQualitySnapshot: jest.fn(() => undefined),
    producerQualitySnapshot: jest.fn(() => undefined),
    transportQualitySnapshot: jest.fn(() => undefined),
    roomQualitySnapshot: jest.fn(() => undefined),
    bandwidthEstimates: jest.fn(() => []),
    pacingSnapshots: jest.fn(() => []),
    statistics: jest.fn(() => ({ producers: [], consumers: [], bandwidth: [], pacing: [], probes: [], rooms: [] }))
  };
  return router;
}

interface FakeIceAgent extends EventEmitter {
  sent: Buffer[];
  snapshot: () => {
    localParameters: TransportOptions['iceParameters'];
    localCandidates: TransportOptions['iceCandidates'];
  };
  sendSelectedDatagram: (packet: Buffer) => Promise<void>;
}

function fakeIceService(): any {
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
    closeAgent: jest.fn(),
    agent: (transportId: string) => {
      const agent = agents.get(transportId);
      if (!agent) {
        throw new Error(`Missing fake ICE agent ${transportId}`);
      }
      return agent;
    }
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for pipe media event');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
