import type {
  Consumer,
  PipeAckMessage,
  PipeCloseMessage,
  PipeCoordinationEnvelope,
  PipeCreateMessage,
  PipeTransportProtocol,
  PipeProducerCloseMessage,
  PipeProducerCreateMessage,
  PipeRtcpMessage,
  Producer
} from '@native-sfu/contracts';
import { PipeTransportManager } from '@native-sfu/sfu-core';
import { PipeTransportService } from '@native-sfu/nest-sfu';
import { PipeCoordinatorService } from './pipe-coordinator.service';

describe('PipeCoordinatorService', () => {
  it('rejects pipe publishing while the feature flag is disabled', async () => {
    const harness = createHarness('node-a', { enabled: false });

    const error = await captureError(() =>
      harness.service.publish('node-b', {
        type: 'pipe:close',
        roomId: 'room-1',
        pipeTransportId: 'pipe-1',
        ownerClaimedAt: CLAIMED_AT,
        reason: 'manual'
      })
    );

    expect(error).toBeDefined();
    expect(harness.redis.publishDurable).not.toHaveBeenCalled();
    expect(harness.service.snapshot().rejectedRequests).toBe(1);
  });

  it('publishes signed create messages and resolves after target acknowledgement', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b');

    const promise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-1',
      remoteNodeId: 'node-b',
      protocol: 'internal'
    });
    await waitForMessageCount(owner.redis, 1);
    const envelope = owner.redis.messages[0] as PipeCoordinationEnvelope<PipeCreateMessage>;
    await remote.service.handleEnvelope(envelope);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);

    const resolved = await promise;
    expect(resolved.correlationId).toBe(envelope.correlationId);
    expect(envelope.auth?.signature.length).toBeGreaterThan(20);
    expect(envelope.idempotencyKey).toBe(envelope.correlationId);
    expect(remote.service.snapshot().activePipeTransports).toBe(1);
    expect(remote.pipe.snapshots()[0]?.id).toBe('pipe-1');
    expect((remote.redis.messages[0]!.payload as PipeAckMessage).ok).toBe(true);
  });

  it('rejects tampered pipe envelopes before applying state and propagates an ack error', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b');
    const promise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-1',
      remoteNodeId: 'node-b',
      protocol: 'internal'
    });
    const errorPromise = captureError(() => promise);
    await waitForMessageCount(owner.redis, 1);
    const envelope = owner.redis.messages[0]!;
    envelope.auth!.signature = 'bad-signature';

    await remote.service.handleEnvelope(envelope);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    const error = await errorPromise;

    expect(errorResponse(error)?.code).toBe('unauthorized');
    expect(remote.service.snapshot().rejectedRequests).toBe(1);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
  });

  it('fences stale owner commands with NodeRegistryService lookup state', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b', { ownerNodeId: 'node-c' });
    const promise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-1',
      remoteNodeId: 'node-b',
      protocol: 'internal'
    });
    const errorPromise = captureError(() => promise);
    await waitForMessageCount(owner.redis, 1);

    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    const error = await errorPromise;

    expect(errorResponse(error)?.code).toBe('owner_mismatch');
    expect(remote.registry.lookupRoomOwner).toHaveBeenCalledWith('room-1');
    expect(remote.service.snapshot().rejectedRequests).toBe(1);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
  });

  it('fences commands whose owner claim timestamp no longer matches the room owner', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b');
    const promise = owner.service.publish('node-b', {
      ...producerCreate('pipe-1', 'producer-1'),
      ownerClaimedAt: '2026-06-15T00:00:00.000Z'
    });
    const errorPromise = captureError(() => promise);
    await waitForMessageCount(owner.redis, 1);

    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    const error = await errorPromise;

    expect(errorResponse(error)?.code).toBe('owner_mismatch');
    expect(remote.service.snapshot().pipeProducers).toBe(0);
  });

  it('retries timed out requests with the same idempotency key and acknowledges duplicates', async () => {
    const owner = createHarness('node-a', { coordinationTimeoutMs: 5, coordinationMaxAttempts: 2 });
    const remote = createHarness('node-b');

    const promise = owner.service.publish('node-b', producerCreate('pipe-1', 'producer-1'));
    await waitForMessageCount(owner.redis, 1);
    const first = owner.redis.messages[0]!;
    await remote.service.handleEnvelope(first);
    expect(remote.service.snapshot().pipeProducers).toBe(1);

    await waitForMessageCount(owner.redis, 2);
    const retry = owner.redis.messages[1]!;
    await remote.service.handleEnvelope(retry);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);

    const resolved = await promise;
    expect(resolved.correlationId).toBe(first.correlationId);
    expect(retry.correlationId).toBe(first.correlationId);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.attempt).toBe(2);
    expect(remote.service.snapshot().pipeProducers).toBe(1);
    expect((remote.redis.messages[1]!.payload as PipeAckMessage).duplicate).toBe(true);
  });

  it('times out when acknowledgements never arrive', async () => {
    const owner = createHarness('node-a', { coordinationTimeoutMs: 5, coordinationMaxAttempts: 2 });

    const error = await captureError(() => owner.service.publish('node-b', producerCreate('pipe-1', 'producer-1')));

    expect(errorResponse(error)?.code).toBe('timeout');
    expect(owner.redis.messages.length).toBe(2);
    expect(owner.service.snapshot().rejectedRequests).toBe(1);
  });

  it('cleans up late successful producer-create acknowledgements after the requester already timed out', async () => {
    const owner = createHarness('node-a', { coordinationTimeoutMs: 5, coordinationMaxAttempts: 1 });
    const remoteMedia = fakeMedia();
    const remote = createHarness('node-b', { media: remoteMedia });
    const firstRequest = producerCreate('pipe-1', 'producer-1');

    const errorPromise = captureError(() => owner.service.publish('node-b', firstRequest));
    await waitForMessageCount(owner.redis, 1);
    const originalRequest = owner.redis.messages[0]!;

    const timeoutError = await errorPromise;
    expect(errorResponse(timeoutError)?.code).toBe('timeout');

    await remote.service.handleEnvelope(originalRequest);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);

    const cleanupPayload = owner.redis.messages[1]?.payload as PipeProducerCloseMessage | undefined;
    expect(cleanupPayload?.type).toBe('pipe:producer:close');
    expect(cleanupPayload?.pipeTransportId).toBe('pipe-1');
    expect(cleanupPayload?.producerId).toBe('producer-1');
    expect(cleanupPayload?.reason).toBe('stale_ack');

    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    expect(remoteMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
  });

  it('propagates target transport errors through negative acknowledgements', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b');
    jest.spyOn(remote.pipe, 'createProducer').mockImplementation(() => {
      throw new Error('pipe boom');
    });
    const promise = owner.service.publish('node-b', producerCreate('pipe-1', 'producer-1'));
    const errorPromise = captureError(() => promise);
    await waitForMessageCount(owner.redis, 1);

    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    const error = await errorPromise;

    expect(errorResponse(error)?.code).toBe('transport_error');
    expect(errorResponse(error)?.message).toBe('pipe boom');
    expect(remote.service.snapshot().rejectedRequests).toBe(1);
  });

  it('routes pipe RTCP into MediaService.handlePipeRtcp when available', async () => {
    const media = fakeMedia();
    const owner = createHarness('node-a', { media });
    const remote = createHarness('node-b');

    const promise = remote.service.publish('node-a', rtcpMessage());
    await waitForMessageCount(remote.redis, 1);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await promise;

    expect(media.handlePipeRtcp).toHaveBeenCalledTimes(1);
    expect(media.handlePipeRtcp).toHaveBeenCalledWith('pipe-1', Buffer.from('rtcp-packet'), { roomId: 'room-1' });
    expect((owner.redis.messages[0]!.payload as PipeAckMessage).ok).toBe(true);
  });

  it('rate-limits pipe setup commands before applying state', async () => {
    const owner = createHarness('node-a');
    const remote = createHarness('node-b', { maxSetupRequestsPerMinute: 0 });
    const promise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-1',
      remoteNodeId: 'node-b',
      protocol: 'internal'
    });
    const errorPromise = captureError(() => promise);
    await waitForMessageCount(owner.redis, 1);

    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    const error = await errorPromise;

    expect(errorResponse(error)?.code).toBe('rate_limited');
    expect(remote.service.snapshot().rejectedRequests).toBe(1);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
  });

  it('allows pipe operations when worker-mode pipe IPC is enabled', async () => {
    const harness = createHarness('node-a', { mediaWorkerMode: 'worker', coordinationTimeoutMs: 5, coordinationMaxAttempts: 1 });

    const error = await captureError(() =>
      harness.service.createPipe({
        targetNodeId: 'node-b',
        roomId: 'room-1',
        pipeTransportId: 'pipe-1',
        remoteNodeId: 'node-b',
        protocol: 'internal'
      })
    );

    expect(error).toBeDefined();
    expect(harness.redis.publishDurable).toHaveBeenCalled();
  });

  it('keeps worker mode marked supported in pipe health snapshots', () => {
    const harness = createHarness('node-a', { mediaWorkerMode: 'worker', advertiseIp: '203.0.113.10' });

    expect(harness.service.healthSnapshot()).toEqual({
      enabled: true,
      durable: true,
      supported: true,
      mediaWorkerMode: 'worker',
      advertiseIpConfigured: true,
      defaultProtocol: 'udp',
      reason: undefined
    });
  });

  it('delegates worker-mode UDP pipe provisioning to the media worker instead of parent pipe sockets', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { mediaWorkerMode: 'worker', advertiseIp: '127.0.0.1', media: ownerMedia });
    const remote = createHarness('node-b', { mediaWorkerMode: 'worker', advertiseIp: '127.0.0.1', media: remoteMedia });

    const promise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-udp',
      remoteNodeId: 'node-b',
      protocol: 'udp'
    });
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    await promise;

    expect(owner.pipe.hasTransport('pipe-udp')).toBe(false);
    expect(remote.pipe.hasTransport('pipe-udp')).toBe(false);
    expect(ownerMedia.ensurePipeTransport).toHaveBeenCalledTimes(2);
    expect(remoteMedia.ensurePipeTransport).toHaveBeenCalledTimes(1);
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.pipeTransportId).toBe('pipe-udp');
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.roomId).toBe('room-1');
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.localNodeId).toBe('node-a');
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.remoteNodeId).toBe('node-b');
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.protocol).toBe('udp');
    expect(ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.advertisedIp).toBe('127.0.0.1');
    expect(typeof ownerMedia.ensurePipeTransport.mock.calls[0]?.[0]?.peerToken).toBe('string');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.pipeTransportId).toBe('pipe-udp');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.roomId).toBe('room-1');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.localNodeId).toBe('node-b');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.remoteNodeId).toBe('node-a');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.protocol).toBe('udp');
    expect(remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.advertisedIp).toBe('127.0.0.1');
    expect(typeof remoteMedia.ensurePipeTransport.mock.calls[0]?.[0]?.peerToken).toBe('string');
    expect(ownerMedia.ensurePipeTransport.mock.calls[1]?.[0]?.remoteEndpoint).toEqual({
      nodeId: 'node-b',
      advertiseIp: '127.0.0.1',
      port: 41000
    });
    expect(owner.service.snapshot().activePipeTransports).toBe(1);
    expect(remote.service.snapshot().activePipeTransports).toBe(1);
  });

  it('closes worker-mode pipe transports through media cleanup without requiring a parent UDP transport', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { mediaWorkerMode: 'worker', advertiseIp: '127.0.0.1', media: ownerMedia });
    const remote = createHarness('node-b', { mediaWorkerMode: 'worker', advertiseIp: '127.0.0.1', media: remoteMedia });

    const createPromise = owner.service.createPipe({
      targetNodeId: 'node-b',
      roomId: 'room-1',
      pipeTransportId: 'pipe-udp',
      remoteNodeId: 'node-b',
      protocol: 'udp'
    });
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[0]!);
    await createPromise;

    const ownerMessagesBeforeClose = owner.redis.messages.length;
    const remoteMessagesBeforeClose = remote.redis.messages.length;
    const closePromise = owner.service.publish('node-b', {
      type: 'pipe:close',
      roomId: 'room-1',
      pipeTransportId: 'pipe-udp',
      ownerClaimedAt: CLAIMED_AT,
      reason: 'manual'
    });
    await waitForMessageCount(owner.redis, ownerMessagesBeforeClose + 1);
    await remote.service.handleEnvelope(owner.redis.messages[ownerMessagesBeforeClose]!);
    await waitForMessageCount(remote.redis, remoteMessagesBeforeClose + 1);
    await owner.service.handleEnvelope(remote.redis.messages[remoteMessagesBeforeClose]!);
    await closePromise;

    expect(remoteMedia.closePipeTransport).toHaveBeenCalledWith('pipe-udp');
    expect(remote.pipe.hasTransport('pipe-udp')).toBe(false);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
  });

  it('allows remote subscriber feed attachment attempts in worker mode', async () => {
    const harness = createHarness('node-b', { mediaWorkerMode: 'worker', ownerNodeId: 'node-a', coordinationTimeoutMs: 5, coordinationMaxAttempts: 1 });

    const error = await captureError(() =>
      harness.service.ensureRemoteConsumerFeed({
        roomId: 'room-1',
        producerId: 'producer-1',
        consumerId: 'consumer-1'
      })
    );

    expect(error).toBeDefined();
    expect(harness.redis.publishDurable).toHaveBeenCalled();
  });

  it('surfaces default protocol and advertise-ip readiness in health snapshots', () => {
    const harness = createHarness('node-a', { advertiseIp: '', nodeEnv: 'test' });

    expect(harness.service.healthSnapshot()).toEqual({
      enabled: true,
      durable: true,
      supported: true,
      mediaWorkerMode: 'in-process',
      advertiseIpConfigured: false,
      defaultProtocol: 'internal',
      reason: undefined
    });
  });

  it('orchestrates an owner feed request into a local pipe consumer and remote proxy producer', async () => {
    const media = fakeMedia();
    const owner = createHarness('node-a', { media, advertiseIp: '' });
    const remote = createHarness('node-b', { media: fakeMedia(), advertiseIp: '' });

    const promise = remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'paused',
      priority: 4,
      preferredLayers: { spatialLayer: 1, temporalLayer: 2 },
      preferredSvcLayers: { spatialLayerId: 1, temporalLayerId: 2, qualityLayerId: 1 }
    });

    await waitForMessageCount(remote.redis, 1);
    const feedRequest = remote.redis.messages[0]!;
    const ownerTask = owner.service.handleEnvelope(feedRequest);
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);
    await waitForMessageCount(owner.redis, 2);
    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    await owner.service.handleEnvelope(remote.redis.messages[2]!);
    await ownerTask;
    await remote.service.handleEnvelope(owner.redis.messages[2]!);

    const resolved = await promise;
    expect(resolved).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
    expect(media.getProducer).toHaveBeenCalledWith('producer-1');
    const ownerPipeConsumer = media.registerPipeConsumer.mock.calls[0]?.[0];
    expect(ownerPipeConsumer?.id).toBe('pipe-consumer:producer-1:node-b');
    expect(ownerPipeConsumer?.producerId).toBe('producer-1');
    expect(ownerPipeConsumer?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(ownerPipeConsumer?.status).toBe('paused');
    expect(ownerPipeConsumer?.priority).toBe(4);
    expect(media.registerPipeConsumer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
    expect(media.setConsumerPaused).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', true);
    expect(media.setConsumerPriority).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', 4);
    expect(media.setConsumerPreferredLayers).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', { spatialLayer: 1, temporalLayer: 2 });
    expect(media.setConsumerPreferredSvcLayers).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', {
      spatialLayerId: 1,
      temporalLayerId: 2,
      qualityLayerId: 1
    });
    const remotePipeProducer = remote.media?.registerPipeProducer.mock.calls[0]?.[0];
    expect(remotePipeProducer?.id).toBe('producer-1');
    expect(remotePipeProducer?.roomId).toBe('room-1');
    expect(remotePipeProducer?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(remote.media?.registerPipeProducer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
  });

  it('keeps remote feed setup live when nested acknowledgements are consumed on the dedicated ack stream worker', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });

    await owner.service.onModuleInit();
    await remote.service.onModuleInit();

    const ownerCommandHandler = durableHandler(owner.redis, 'pipe-coordinator:commands:node-a');
    const ownerAckHandler = durableHandler(owner.redis, 'pipe-coordinator:acks:node-a');
    const remoteCommandHandler = durableHandler(remote.redis, 'pipe-coordinator:commands:node-b');
    const remoteAckHandler = durableHandler(remote.redis, 'pipe-coordinator:acks:node-b');

    const feedPromise = remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'live',
      preferredLayers: { spatialLayer: 2, temporalLayer: 2 }
    });

    await waitForMessageCount(remote.redis, 1);
    const ownerFeedTask = ownerCommandHandler(remote.redis.messages[0]!, durableMeta('pipe-coordinator:commands:node-a', '1-0'));

    await waitForMessageCount(owner.redis, 1);
    await remoteCommandHandler(owner.redis.messages[0]!, durableMeta('pipe-coordinator:commands:node-b', '2-0'));

    await waitForMessageCount(remote.redis, 2);
    await ownerAckHandler(remote.redis.messages[1]!, durableMeta('pipe-coordinator:acks:node-a', '3-0'));

    await waitForMessageCount(owner.redis, 2);
    await remoteCommandHandler(owner.redis.messages[1]!, durableMeta('pipe-coordinator:commands:node-b', '4-0'));

    await waitForMessageCount(remote.redis, 3);
    await ownerAckHandler(remote.redis.messages[2]!, durableMeta('pipe-coordinator:acks:node-a', '5-0'));

    await ownerFeedTask;

    await waitForMessageCount(owner.redis, 3);
    await remoteAckHandler(owner.redis.messages[2]!, durableMeta('pipe-coordinator:acks:node-b', '6-0'));

    const resolvedFeed = await feedPromise;
    expect(resolvedFeed).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
    expect(ownerMedia.registerPipeConsumer.mock.calls[0]?.[0]?.id).toBe('pipe-consumer:producer-1:node-b');
    expect(ownerMedia.registerPipeConsumer.mock.calls[0]?.[0]?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(ownerMedia.registerPipeConsumer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
    expect(remoteMedia.registerPipeProducer.mock.calls[0]?.[0]?.id).toBe('producer-1');
    expect(remoteMedia.registerPipeProducer.mock.calls[0]?.[0]?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(remoteMedia.registerPipeProducer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
  });

  it('reuses an existing remote feed for multiple consumers and tears it down only after the final release', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });

    const firstFeedPromise = remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    await waitForMessageCount(remote.redis, 1);
    const firstFeedRequest = remote.redis.messages[0]!;
    const ownerAttachTask = owner.service.handleEnvelope(firstFeedRequest);
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);
    await waitForMessageCount(owner.redis, 2);
    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    await owner.service.handleEnvelope(remote.redis.messages[2]!);
    await ownerAttachTask;
    await remote.service.handleEnvelope(owner.redis.messages[2]!);
    await firstFeedPromise;

    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    const secondFeed = await remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-2'
    });

    expect(secondFeed).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
    expect(remote.redis.messages.length).toBe(baselineRemoteMessages);
    expect(owner.redis.messages.length).toBe(baselineOwnerMessages);

    await remote.service.releaseRemoteConsumerFeed('consumer-1');

    expect(remote.redis.messages.length).toBe(baselineRemoteMessages);
    expect(ownerMedia.unregisterConsumer).not.toHaveBeenCalled();
    expect(remoteMedia.unregisterProducer).not.toHaveBeenCalled();

    const releasePromise = remote.service.releaseRemoteConsumerFeed('consumer-2');
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const releaseEnvelope = remote.redis.messages[baselineRemoteMessages]!;
    const ownerReleaseTask = owner.service.handleEnvelope(releaseEnvelope);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
    await ownerReleaseTask;
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 2);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
    await releasePromise;

    expect(ownerMedia.unregisterConsumer).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b');
    expect(remoteMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(owner.service.snapshot().activePipeTransports).toBe(0);
    expect(owner.service.snapshot().pipeConsumers).toBe(0);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
    expect(remote.service.snapshot().pipeProducers).toBe(0);
  });

  it('closes all remote feed bindings for a room in one pass', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });

    const firstFeedPromise = remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    await waitForMessageCount(remote.redis, 1);
    const firstFeedRequest = remote.redis.messages[0]!;
    const ownerAttachTask = owner.service.handleEnvelope(firstFeedRequest);
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);
    await waitForMessageCount(owner.redis, 2);
    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    await owner.service.handleEnvelope(remote.redis.messages[2]!);
    await ownerAttachTask;
    await remote.service.handleEnvelope(owner.redis.messages[2]!);
    await firstFeedPromise;

    await remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-2'
    });

    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    const closeTask = remote.service.closeRoomBindings('room-1');
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const releaseEnvelope = remote.redis.messages[baselineRemoteMessages]!;
    const ownerReleaseTask = owner.service.handleEnvelope(releaseEnvelope);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
    await ownerReleaseTask;
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 2);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
    await closeTask;

    expect(ownerMedia.unregisterConsumer).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b');
    expect(remoteMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(owner.service.snapshot().activePipeTransports).toBe(0);
    expect(owner.service.snapshot().pipeConsumers).toBe(0);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
    expect(remote.service.snapshot().pipeProducers).toBe(0);
  });

  it('forcibly closes lingering room pipe transports across peers during room cleanup', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = ownerMedia.getProducer('producer-1')!;

    await establishRemotePublication(owner, remote, producer);

    (owner.service as unknown as { ownerPublishedProducers: Map<string, unknown> }).ownerPublishedProducers.clear();

    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    const closeTask = owner.service.closeRoomBindings('room-1');
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await drainPublishedMessages(owner, remote, baselineOwnerMessages, baselineRemoteMessages);
    await closeTask;

    expect(owner.service.snapshot().activePipeTransports).toBe(0);
    expect(owner.service.snapshot().pipeProducers).toBe(0);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
    expect(remote.service.snapshot().pipeConsumers).toBe(0);
    expect(ownerMedia.closePipeTransport).toHaveBeenCalledWith('pipe:internal:room-1:node-a:node-b');
    expect(remoteMedia.closePipeTransport).toHaveBeenCalledWith('pipe:internal:room-1:node-a:node-b');
  });

  it('continues room cleanup and sweeps lingering pipe transports after a coordinated release failure', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = ownerMedia.getProducer('producer-1')!;

    await establishRemotePublication(owner, remote, producer);

    const originalPublish = owner.service.publish.bind(owner.service);
    jest.spyOn(owner.service, 'publish').mockImplementation(async (targetNodeId, payload) => {
      if (payload.type === 'pipe:consumer:close') {
        throw new Error('forced close failure');
      }
      return originalPublish(targetNodeId, payload);
    });

    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    let thrown: unknown;
    const closeTask = owner.service.closeRoomBindings('room-1').catch((error) => {
      thrown = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await drainPublishedMessages(owner, remote, baselineOwnerMessages, baselineRemoteMessages);
    await closeTask;

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('forced close failure');
    expect(owner.service.snapshot().activePipeTransports).toBe(0);
    expect(owner.service.snapshot().pipeProducers).toBe(0);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
    expect(remote.service.snapshot().pipeConsumers).toBe(0);
    expect((owner.metrics as { pipeCleanupFailures: { labels: jest.Mock } }).pipeCleanupFailures.labels).toHaveBeenCalledWith('room_bindings_owner_published');
  });

  it('closes owner feed consumers with the latest synced remote state version during room cleanup', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });

    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });

    for (const state of [
      { status: 'live' as const, priority: 3, preferredLayers: { spatialLayer: 1, temporalLayer: 1 } },
      { status: 'paused' as const, priority: 5, preferredLayers: { spatialLayer: 2, temporalLayer: 2 } }
    ]) {
      const baselineRemoteMessages = remote.redis.messages.length;
      const baselineOwnerMessages = owner.redis.messages.length;
      const syncPromise = remote.service.syncRemoteConsumerState({
        roomId: 'room-1',
        producerId: 'producer-1',
        consumerId: 'consumer-1',
        ...state
      });
      await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
      await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
      await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
      await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
      await syncPromise;
    }

    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;
    const closeTask = remote.service.closeRoomBindings('room-1');
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const releaseEnvelope = remote.redis.messages[baselineRemoteMessages]!;
    const ownerReleaseTask = owner.service.handleEnvelope(releaseEnvelope);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
    await ownerReleaseTask;
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 2);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
    await closeTask;

    expect(ownerMedia.unregisterConsumer).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b');
    expect(remoteMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(owner.service.snapshot().pipeConsumers).toBe(0);
    expect(owner.service.snapshot().activePipeTransports).toBe(0);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);
  });

  it('orchestrates a remote publisher into an owner proxy producer and source-node pipe consumer', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = ownerMedia.getProducer('producer-1')!;

    const publishPromise = remote.service.ensureRemoteProducerPublication({
      roomId: 'room-1',
      producer
    });

    await waitForMessageCount(remote.redis, 1);
    const publishRequest = remote.redis.messages[0]!;
    const ownerPublishTask = owner.service.handleEnvelope(publishRequest);
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);
    await waitForMessageCount(owner.redis, 2);
    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    await owner.service.handleEnvelope(remote.redis.messages[2]!);
    await ownerPublishTask;
    await remote.service.handleEnvelope(owner.redis.messages[2]!);

    expect(await publishPromise).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
    const ownerPipeProducer = ownerMedia.registerPipeProducer.mock.calls[0]?.[0];
    expect(ownerPipeProducer?.id).toBe('producer-1');
    expect(ownerPipeProducer?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(ownerPipeProducer?.participantId).toBe('publisher');
    const remotePipeConsumer = remoteMedia.registerPipeConsumer.mock.calls[0]?.[0];
    expect(remotePipeConsumer?.id).toBe('pipe-publisher:producer-1:node-b');
    expect(remotePipeConsumer?.producerId).toBe('producer-1');
    expect(remotePipeConsumer?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(remotePipeConsumer?.status).toBe('paused');
    expect(remoteMedia.setConsumerPaused).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b', true);
  });

  it('synchronizes remote consumer demand to the owner-side pipe consumer', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    const syncPromise = remote.service.syncRemoteConsumerState({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'live',
      priority: 6,
      preferredLayers: { spatialLayer: 2, temporalLayer: 1 },
      preferredSvcLayers: { spatialLayerId: 2, temporalLayerId: 1, qualityLayerId: 2 }
    });
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await syncPromise;

    expect(ownerMedia.setConsumerPaused).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', false);
    expect(ownerMedia.setConsumerPriority).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', 6);
    expect(ownerMedia.setConsumerPreferredLayers).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', { spatialLayer: 2, temporalLayer: 1 });
    expect(ownerMedia.setConsumerPreferredSvcLayers).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', {
      spatialLayerId: 2,
      temporalLayerId: 1,
      qualityLayerId: 2
    });
  });

  it('ignores stale remote consumer state versions within the same binding epoch', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    const syncPromise = remote.service.syncRemoteConsumerState({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1',
      status: 'live',
      priority: 6,
      preferredLayers: { spatialLayer: 2, temporalLayer: 1 }
    });
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const appliedEnvelope = remote.redis.messages[baselineRemoteMessages]!;
    await owner.service.handleEnvelope(appliedEnvelope);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await syncPromise;

    ownerMedia.setConsumerPaused.mockClear();
    ownerMedia.setConsumerPriority.mockClear();
    ownerMedia.setConsumerPreferredLayers.mockClear();
    const staleStateBaselineRemote = remote.redis.messages.length;
    const staleStateBaselineOwner = owner.redis.messages.length;
    const staleStatePromise = remote.service.publish('node-a', {
      type: 'pipe:consumer:state',
      roomId: 'room-1',
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      ownerClaimedAt: CLAIMED_AT,
      ownerNodeId: 'node-a',
      remoteNodeId: 'node-b',
      consumerId: 'pipe-consumer:producer-1:node-b',
      producerId: 'producer-1',
      bindingEpoch: (appliedEnvelope.payload as { bindingEpoch?: string }).bindingEpoch,
      stateVersion: Math.max(0, (((appliedEnvelope.payload as { stateVersion?: number }).stateVersion) ?? 1) - 1),
      status: 'paused',
      priority: 1,
      preferredLayers: { spatialLayer: 0, temporalLayer: 0 }
    });
    await waitForMessageCount(remote.redis, staleStateBaselineRemote + 1);
    await owner.service.handleEnvelope(remote.redis.messages[staleStateBaselineRemote]!);
    await waitForMessageCount(owner.redis, staleStateBaselineOwner + 1);
    await remote.service.handleEnvelope(owner.redis.messages[staleStateBaselineOwner]!);
    await staleStatePromise;

    expect(ownerMedia.setConsumerPaused).not.toHaveBeenCalled();
    expect(ownerMedia.setConsumerPriority).not.toHaveBeenCalled();
    expect(ownerMedia.setConsumerPreferredLayers).not.toHaveBeenCalled();
  });

  it('forwards remote consumer TWCC observations to the owner-side pipe consumer', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;
    const observation = {
      packetLoss: 0.18,
      delayVariationMs: 64,
      jitter: 51,
      rtt: 122,
      sendDeltaMs: 20,
      receiveDeltaMs: 67,
      timestamp: 1234
    } as const;

    remoteMedia.emitConsumerTwccObservation({
      roomId: 'room-1',
      participantId: 'subscriber',
      consumerId: 'consumer-1',
      producerId: 'producer-1',
      transportId: 'transport-subscriber',
      observation
    });

    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);

    expect(ownerMedia.applyConsumerTwccObservation).toHaveBeenCalledWith('pipe-consumer:producer-1:node-b', observation);
  });

  it('ignores stale remote consumer feedback versions within the same binding epoch', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    remoteMedia.emitConsumerTwccObservation({
      roomId: 'room-1',
      participantId: 'subscriber',
      consumerId: 'consumer-1',
      producerId: 'producer-1',
      transportId: 'transport-subscriber',
      observation: {
        packetLoss: 0.22,
        delayVariationMs: 72,
        rtt: 130,
        timestamp: 2000
      }
    });

    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const appliedEnvelope = remote.redis.messages[baselineRemoteMessages]!;

    await owner.service.handleEnvelope(appliedEnvelope);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);

    ownerMedia.applyConsumerTwccObservation.mockClear();
    const staleFeedbackBaselineRemote = remote.redis.messages.length;
    const staleFeedbackBaselineOwner = owner.redis.messages.length;
    const staleFeedbackPromise = remote.service.publish('node-a', {
      type: 'pipe:consumer:feedback',
      roomId: 'room-1',
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      ownerClaimedAt: CLAIMED_AT,
      ownerNodeId: 'node-a',
      remoteNodeId: 'node-b',
      consumerId: 'pipe-consumer:producer-1:node-b',
      producerId: 'producer-1',
      bindingEpoch: (appliedEnvelope.payload as { bindingEpoch?: string }).bindingEpoch,
      feedbackVersion: Math.max(0, (((appliedEnvelope.payload as { feedbackVersion?: number }).feedbackVersion) ?? 1) - 1),
      observation: {
        packetLoss: 0.01,
        delayVariationMs: 8,
        rtt: 20,
        timestamp: 1500
      }
    });
    await waitForMessageCount(remote.redis, staleFeedbackBaselineRemote + 1);
    await owner.service.handleEnvelope(remote.redis.messages[staleFeedbackBaselineRemote]!);
    await waitForMessageCount(owner.redis, staleFeedbackBaselineOwner + 1);
    await remote.service.handleEnvelope(owner.redis.messages[staleFeedbackBaselineOwner]!);
    await staleFeedbackPromise;

    expect(ownerMedia.applyConsumerTwccObservation).not.toHaveBeenCalled();
  });

  it('aggregates multi-subscriber remote feedback without collapsing entirely to the single worst observation', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    await remote.service.ensureRemoteConsumerFeed({
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-2'
    });
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;
    const healthy = {
      packetLoss: 0.02,
      delayVariationMs: 12,
      jitter: 8,
      rtt: 40,
      sendDeltaMs: 20,
      receiveDeltaMs: 23,
      timestamp: 1000
    } as const;
    const degraded = {
      packetLoss: 0.18,
      delayVariationMs: 64,
      jitter: 51,
      rtt: 122,
      sendDeltaMs: 20,
      receiveDeltaMs: 67,
      timestamp: 1100
    } as const;

    remoteMedia.emitConsumerTwccObservation({
      roomId: 'room-1',
      participantId: 'subscriber-a',
      consumerId: 'consumer-1',
      producerId: 'producer-1',
      transportId: 'transport-a',
      observation: healthy
    });
    remoteMedia.emitConsumerTwccObservation({
      roomId: 'room-1',
      participantId: 'subscriber-b',
      consumerId: 'consumer-2',
      producerId: 'producer-1',
      transportId: 'transport-b',
      observation: degraded
    });

    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);

    const aggregated = ownerMedia.applyConsumerTwccObservation.mock.calls.at(-1)?.[1];
    expect(aggregated).toBeDefined();
    expect(aggregated!.packetLoss).toBeCloseTo(0.14, 5);
    expect(aggregated!.delayVariationMs).toBeCloseTo(51, 5);
    expect(aggregated!.jitter).toBeCloseTo(40.25, 5);
    expect(aggregated!.rtt).toBeCloseTo(101.5, 5);
    expect(aggregated!.receiveDeltaMs).toBeCloseTo(56, 5);
    expect(aggregated!.packetLoss).toBeLessThan(degraded.packetLoss);
    expect(aggregated!.packetLoss).toBeGreaterThan(healthy.packetLoss);
  });

  it('ignores stale feed release messages after the same remote feed is reattached with a new binding epoch', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });

    const releaseBaseline = remote.redis.messages.length;
    const ownerReleaseBaseline = owner.redis.messages.length;
    const releasePromise = remote.service.releaseRemoteConsumerFeed('consumer-1');
    await waitForMessageCount(remote.redis, releaseBaseline + 1);
    const staleReleaseEnvelope = remote.redis.messages[releaseBaseline]!;
    const ownerReleaseTask = owner.service.handleEnvelope(staleReleaseEnvelope);
    await waitForMessageCount(owner.redis, ownerReleaseBaseline + 1);
    await remote.service.handleEnvelope(owner.redis.messages[ownerReleaseBaseline]!);
    await owner.service.handleEnvelope(remote.redis.messages[releaseBaseline + 1]!);
    await ownerReleaseTask;
    await waitForMessageCount(owner.redis, ownerReleaseBaseline + 2);
    await remote.service.handleEnvelope(owner.redis.messages[ownerReleaseBaseline + 1]!);
    await releasePromise;

    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });

    ownerMedia.unregisterConsumer.mockClear();

    await owner.service.handleEnvelope(staleReleaseEnvelope);

    expect(ownerMedia.unregisterConsumer).not.toHaveBeenCalled();
  });

  it('synchronizes remote producer state to the owner proxy', async () => {
    const ownerMedia = fakeMedia();
    const remote = createHarness('node-b', { advertiseIp: '' });
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const producer = ownerMedia.getProducer('producer-1')!;

    const publishPromise = remote.service.ensureRemoteProducerPublication({
      roomId: 'room-1',
      producer
    });
    await waitForMessageCount(remote.redis, 1);
    const publishRequest = remote.redis.messages[0]!;
    const ownerPublishTask = owner.service.handleEnvelope(publishRequest);
    await waitForMessageCount(owner.redis, 1);
    await remote.service.handleEnvelope(owner.redis.messages[0]!);
    await owner.service.handleEnvelope(remote.redis.messages[1]!);
    await waitForMessageCount(owner.redis, 2);
    await remote.service.handleEnvelope(owner.redis.messages[1]!);
    await owner.service.handleEnvelope(remote.redis.messages[2]!);
    await ownerPublishTask;
    await remote.service.handleEnvelope(owner.redis.messages[2]!);
    await publishPromise;
    const baselineRemoteMessages = remote.redis.messages.length;
    const baselineOwnerMessages = owner.redis.messages.length;

    const statePromise = remote.service.syncRemoteProducerState({
      roomId: 'room-1',
      producerId: producer.id,
      status: 'paused',
      priority: 3
    });
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await statePromise;

    expect(ownerMedia.setProducerPaused).toHaveBeenCalledWith('producer-1', true);
    expect(ownerMedia.setProducerPriority).toHaveBeenCalledWith('producer-1', 3);
  });

  it('propagates owner-authoritative producer state changes back to the origin producer', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = remoteMedia.getProducer('producer-1')!;
    await establishRemotePublication(owner, remote, producer);
    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    const statePromise = owner.service.syncOriginProducerState({
      roomId: 'room-1',
      producerId: producer.id,
      status: 'paused',
      priority: 5
    });
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await statePromise;

    expect(remoteMedia.setProducerPaused).toHaveBeenCalledWith('producer-1', true);
    expect(remoteMedia.setProducerPriority).toHaveBeenCalledWith('producer-1', 5);
  });

  it('propagates owner-authoritative consumer demand back to the origin pipe consumer', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = remoteMedia.getProducer('producer-1')!;
    await establishRemotePublication(owner, remote, producer);
    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    const statePromise = owner.service.syncOriginConsumerState({
      roomId: 'room-1',
      producerId: producer.id,
      status: 'live',
      priority: 5,
      preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
      preferredSvcLayers: { spatialLayerId: 1, temporalLayerId: 2, qualityLayerId: 1 }
    });
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await statePromise;

    expect(remoteMedia.setConsumerPaused).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b', false);
    expect(remoteMedia.setConsumerPriority).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b', 5);
    expect(remoteMedia.setConsumerPreferredLayers).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b', { spatialLayer: 2, temporalLayer: 2 });
    expect(remoteMedia.setConsumerPreferredSvcLayers).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b', {
      spatialLayerId: 1,
      temporalLayerId: 2,
      qualityLayerId: 1
    });
  });

  it('propagates owner-authoritative close to the origin producer and tears down the remote publication chain', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    const producer = remoteMedia.getProducer('producer-1')!;
    await establishRemotePublication(owner, remote, producer);
    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    const closePromise = owner.service.closeOriginProducer({
      roomId: 'room-1',
      producerId: producer.id,
      reason: 'producer_closed'
    });
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    const closeCommand = owner.redis.messages[baselineOwnerMessages]!;
    const remoteCloseTask = remote.service.handleEnvelope(closeCommand);
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    const publishRelease = remote.redis.messages[baselineRemoteMessages]!;
    const ownerReleaseTask = owner.service.handleEnvelope(publishRelease);
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 2);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 2);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
    await ownerReleaseTask;
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 3);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 2]!);
    await remoteCloseTask;
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 3);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 2]!);
    await closePromise;

    expect(remoteMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(ownerMedia.unregisterProducer).toHaveBeenCalledWith('producer-1');
    expect(remoteMedia.unregisterConsumer).toHaveBeenCalledWith('pipe-publisher:producer-1:node-b');
  });

  it('clears remote feed cache state on pipe close so release becomes a no-op and reattach can reuse the same transport id', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    expect(
      await establishRemoteConsumerFeed(owner, remote, {
        roomId: 'room-1',
        producerId: 'producer-1',
        consumerId: 'consumer-1'
      })
    ).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
    const baselineOwnerMessages = owner.redis.messages.length;
    const baselineRemoteMessages = remote.redis.messages.length;

    const closePromise = owner.service.publish('node-b', {
      type: 'pipe:close',
      roomId: 'room-1',
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      ownerClaimedAt: CLAIMED_AT,
      reason: 'manual'
    });
    await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
    await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
    await closePromise;

    const remoteMessagesBeforeRelease = remote.redis.messages.length;
    await remote.service.releaseRemoteConsumerFeed('consumer-1');
    expect(remote.redis.messages.length).toBe(remoteMessagesBeforeRelease);
    expect(remote.service.snapshot().activePipeTransports).toBe(0);

    expect(
      await establishRemoteConsumerFeed(owner, remote, {
        roomId: 'room-1',
        producerId: 'producer-1',
        consumerId: 'consumer-1'
      })
    ).toEqual({
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      proxyProducerId: 'producer-1'
    });
  });

  it('ignores stale pipe stats after close and clears per-pipe observability state', async () => {
    const ownerMedia = fakeMedia();
    const remoteMedia = fakeMedia();
    const owner = createHarness('node-a', { media: ownerMedia, advertiseIp: '' });
    const remote = createHarness('node-b', { media: remoteMedia, advertiseIp: '' });
    await establishRemoteConsumerFeed(owner, remote, {
      roomId: 'room-1',
      producerId: 'producer-1',
      consumerId: 'consumer-1'
    });
    (owner.metrics.clearPipeTransportMetrics as jest.Mock).mockClear();
    (remote.metrics.clearPipeTransportMetrics as jest.Mock).mockClear();
    (owner.metrics.updatePipeTransportMetrics as jest.Mock).mockClear();
    await closePipeAcrossNodes(owner, remote, {
      type: 'pipe:close',
      roomId: 'room-1',
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      ownerClaimedAt: CLAIMED_AT,
      reason: 'manual'
    });

    expect(owner.metrics.clearPipeTransportMetrics).toHaveBeenCalledWith('pipe:internal:room-1:node-a:node-b');
    expect(remote.metrics.clearPipeTransportMetrics).toHaveBeenCalledWith('pipe:internal:room-1:node-a:node-b');

    const staleStatsBaselineRemote = remote.redis.messages.length;
    const staleStatsBaselineOwner = owner.redis.messages.length;
    const staleStatsPromise = remote.service.publish('node-a', {
      type: 'pipe:stats',
      roomId: 'room-1',
      pipeTransportId: 'pipe:internal:room-1:node-a:node-b',
      ownerClaimedAt: CLAIMED_AT,
      active: false,
      rtpPackets: 0,
      rtpBytes: 0,
      rtcpPackets: 0,
      rtcpBytes: 0,
      droppedPackets: 0,
      backpressureEvents: 0,
      packetLoss: 0.45,
      jitterMs: 77,
      rttMs: 120
    });
    await waitForMessageCount(remote.redis, staleStatsBaselineRemote + 1);
    await owner.service.handleEnvelope(remote.redis.messages[staleStatsBaselineRemote]!);
    await waitForMessageCount(owner.redis, staleStatsBaselineOwner + 1);
    await remote.service.handleEnvelope(owner.redis.messages[staleStatsBaselineOwner]!);
    await staleStatsPromise;

    expect(owner.metrics.updatePipeTransportMetrics).not.toHaveBeenCalled();
  });
});

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function waitForMessageCount(redis: FakeRedisService, count: number, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now();
  while (redis.messages.length < count) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} Redis messages; saw ${redis.messages.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function errorResponse(error: unknown): Record<string, unknown> | undefined {
  if (error && typeof error === 'object' && 'getResponse' in error && typeof error.getResponse === 'function') {
    return error.getResponse() as Record<string, unknown>;
  }
  return undefined;
}

async function establishRemotePublication(
  owner: ReturnType<typeof createHarness>,
  remote: ReturnType<typeof createHarness>,
  producer: Producer
): Promise<{ pipeTransportId: string; proxyProducerId: string }> {
  const baselineOwnerMessages = owner.redis.messages.length;
  const baselineRemoteMessages = remote.redis.messages.length;
  const publishPromise = remote.service.ensureRemoteProducerPublication({
    roomId: 'room-1',
    producer
  });
  await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
  const publishRequest = remote.redis.messages[baselineRemoteMessages]!;
  const ownerPublishTask = owner.service.handleEnvelope(publishRequest);
  await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
  await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
  await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
  await waitForMessageCount(owner.redis, baselineOwnerMessages + 2);
  await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
  await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 2]!);
  await ownerPublishTask;
  await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 2]!);
  return publishPromise;
}

async function drainPublishedMessages(
  owner: ReturnType<typeof createHarness>,
  remote: ReturnType<typeof createHarness>,
  ownerMessageIndex: number,
  remoteMessageIndex: number
): Promise<void> {
  let delivered = true;
  while (delivered) {
    delivered = false;
    while (ownerMessageIndex < owner.redis.messages.length) {
      await remote.service.handleEnvelope(owner.redis.messages[ownerMessageIndex]!);
      ownerMessageIndex += 1;
      delivered = true;
    }
    while (remoteMessageIndex < remote.redis.messages.length) {
      await owner.service.handleEnvelope(remote.redis.messages[remoteMessageIndex]!);
      remoteMessageIndex += 1;
      delivered = true;
    }
  }
}

async function establishRemoteConsumerFeed(
  owner: ReturnType<typeof createHarness>,
  remote: ReturnType<typeof createHarness>,
  request: { roomId: string; producerId: string; consumerId: string }
): Promise<{ pipeTransportId: string; proxyProducerId: string }> {
  const baselineOwnerMessages = owner.redis.messages.length;
  const baselineRemoteMessages = remote.redis.messages.length;
  const feedPromise = remote.service.ensureRemoteConsumerFeed(request);
  await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
  const feedRequest = remote.redis.messages[baselineRemoteMessages]!;
  const ownerAttachTask = owner.service.handleEnvelope(feedRequest);
  await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
  await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
  await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 1]!);
  if (await hasMessageCount(owner.redis, baselineOwnerMessages + 2)) {
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
    await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages + 2]!);
    await ownerAttachTask;
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 2]!);
  } else {
    await ownerAttachTask;
    await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages + 1]!);
  }
  return feedPromise;
}

async function closePipeAcrossNodes(
  owner: ReturnType<typeof createHarness>,
  remote: ReturnType<typeof createHarness>,
  message: PipeCloseMessage
): Promise<void> {
  const baselineOwnerMessages = owner.redis.messages.length;
  const baselineRemoteMessages = remote.redis.messages.length;
  await (owner.service as unknown as { handleClose: (message: PipeCloseMessage) => Promise<void> }).handleClose(message);
  const publishPromise = owner.service.publish(remote.registry.localNodeId(), message);
  await waitForMessageCount(owner.redis, baselineOwnerMessages + 1);
  await remote.service.handleEnvelope(owner.redis.messages[baselineOwnerMessages]!);
  await waitForMessageCount(remote.redis, baselineRemoteMessages + 1);
  await owner.service.handleEnvelope(remote.redis.messages[baselineRemoteMessages]!);
  await publishPromise;
}

async function hasMessageCount(redis: FakeRedisService, count: number, timeoutMs = 25): Promise<boolean> {
  try {
    await waitForMessageCount(redis, count, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function durableHandler(redis: FakeRedisService, consumerKey: string) {
  const calls = redis.consumeDurable.mock.calls as unknown[][];
  const match = calls.find((call) => call[1] === consumerKey);
  if (!match) {
    throw new Error(`Durable consumer ${consumerKey} was not registered`);
  }
  return match[2] as unknown as (
    payload: PipeCoordinationEnvelope,
    meta: { stream: string; id: string; replayed: boolean; consumerKey: string }
  ) => Promise<void>;
}

function durableMeta(consumerKey: string, id: string) {
  return {
    stream: 'sfu:pipe-coordination',
    id,
    replayed: false,
    consumerKey
  };
}

function createHarness(
  nodeId: string,
  options: {
    enabled?: boolean;
    ownerNodeId?: string;
    ownerAvailable?: boolean;
    ownerUnavailableReason?: string;
    maxSetupRequestsPerMinute?: number;
    coordinationTimeoutMs?: number;
    coordinationMaxAttempts?: number;
    advertiseIp?: string;
    mediaWorkerMode?: 'in-process' | 'worker';
    nodeEnv?: string;
    media?: ReturnType<typeof fakeMedia>;
  } = {}
): {
  service: PipeCoordinatorService;
  pipe: PipeTransportService;
  redis: FakeRedisService;
  registry: ReturnType<typeof fakeRegistry>;
  metrics: ReturnType<typeof fakeMetrics>;
  media?: ReturnType<typeof fakeMedia>;
} {
  const config = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'pipe.enabled': options.enabled ?? true,
        'pipe.clusterSecret': 'test-pipe-cluster-secret-123456',
        'pipe.coordinationTimeoutMs': options.coordinationTimeoutMs ?? 5000,
        'pipe.coordinationMaxAttempts': options.coordinationMaxAttempts ?? 3,
        'pipe.maxSetupRequestsPerMinute': options.maxSetupRequestsPerMinute ?? 120,
        'pipe.advertiseIp': options.advertiseIp ?? '127.0.0.1',
        'mediaWorker.mode': options.mediaWorkerMode ?? 'in-process',
        nodeEnv: options.nodeEnv ?? 'development'
      };
      return values[key] ?? defaultValue;
    })
  };
  const registry = fakeRegistry(nodeId, options);
  const redis = new FakeRedisService();
  const pipe = new PipeTransportService(new PipeTransportManager());
  const metrics = fakeMetrics();
  const service = new PipeCoordinatorService(config as never, registry as never, redis as never, pipe, metrics as never, options.media as never);
  return { service, pipe, redis, registry, metrics, media: options.media };
}

function fakeRegistry(
  nodeId: string,
  options: {
    ownerNodeId?: string;
    ownerAvailable?: boolean;
    ownerUnavailableReason?: string;
  }
) {
  const ownerNodeId = options.ownerNodeId ?? 'node-a';
  const owner = (roomId: string) => ({
    roomId,
    nodeId: ownerNodeId,
    publicUrl: `http://${ownerNodeId}.example.test`,
    claimedAt: CLAIMED_AT,
    lastHeartbeatAt: '2026-06-16T00:00:00.000Z',
    expiresAt: '2026-06-16T00:00:30.000Z'
  });
  return {
    localNodeId: jest.fn(() => nodeId),
    getRoomOwner: jest.fn(async (roomId: string) => owner(roomId)),
    lookupRoomOwner: jest.fn(async (roomId: string) => ({
      roomId,
      owner: owner(roomId),
      local: ownerNodeId === nodeId,
      available: options.ownerAvailable ?? true,
      reason: options.ownerAvailable === false ? options.ownerUnavailableReason ?? 'owner_expired' : undefined
    }))
  };
}

function producerCreate(pipeTransportId: string, producerId: string): PipeProducerCreateMessage {
  return {
    type: 'pipe:producer:create',
    roomId: 'room-1',
    pipeTransportId,
    ownerClaimedAt: CLAIMED_AT,
    producerId,
    participantId: 'publisher',
    kind: 'video',
    rtpParameters: rtpParameters(1111)
  };
}

function rtcpMessage(): PipeRtcpMessage {
  return {
    type: 'pipe:rtcp',
    roomId: 'room-1',
    pipeTransportId: 'pipe-1',
    ownerClaimedAt: CLAIMED_AT,
    direction: 'remote-to-owner',
    feedbackKind: 'pli',
    packetBase64: Buffer.from('rtcp-packet').toString('base64')
  };
}

function rtpParameters(ssrc: number) {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-test', reducedSize: true }
  };
}

function fakeMedia(): {
  getProducer: jest.Mock<Producer | undefined, [string]>;
  ensurePipeTransport: jest.Mock<
    Promise<{ localEndpoint?: { nodeId: string; advertiseIp: string; port: number } }>,
    [
      {
        pipeTransportId: string;
        roomId: string;
        localNodeId: string;
        remoteNodeId: string;
        protocol: PipeTransportProtocol;
        listenPort?: number;
        advertisedIp?: string;
        peerToken?: string;
        remoteEndpoint?: { nodeId: string; advertiseIp: string; port: number };
      }
    ]
  >;
  registerPipeProducer: jest.Mock<Promise<void>, [Producer, string?]>;
  registerPipeConsumer: jest.Mock<Promise<void>, [Consumer, string?]>;
  unregisterProducer: jest.Mock<Promise<void>, [string]>;
  unregisterConsumer: jest.Mock<Promise<void>, [string]>;
  setProducerPaused: jest.Mock<Promise<void>, [string, boolean]>;
  setProducerPriority: jest.Mock<void, [string, number]>;
  setConsumerPaused: jest.Mock<Promise<void>, [string, boolean]>;
  setConsumerPreferredLayers: jest.Mock<Promise<void>, [string, { spatialLayer?: number; temporalLayer?: number }]>;
  setConsumerPreferredSvcLayers: jest.Mock<Promise<void>, [string, { spatialLayerId?: number; temporalLayerId?: number; qualityLayerId?: number }]>;
  setConsumerPriority: jest.Mock<void, [string, number]>;
  applyConsumerTwccObservation: jest.Mock<Promise<void>, [string, { packetLoss: number; delayVariationMs: number; jitter?: number; rtt?: number; sendDeltaMs?: number; receiveDeltaMs?: number; timestamp?: number }]>;
  onConsumerTwccObservation: jest.Mock<() => void, [(state: {
    roomId: string;
    participantId: string;
    consumerId: string;
    producerId: string;
    transportId: string;
    observation: {
      packetLoss: number;
      delayVariationMs: number;
      jitter?: number;
      rtt?: number;
      sendDeltaMs?: number;
      receiveDeltaMs?: number;
      timestamp?: number;
    };
  }) => void]>;
  emitConsumerTwccObservation: (state: {
    roomId: string;
    participantId: string;
    consumerId: string;
    producerId: string;
    transportId: string;
    observation: {
      packetLoss: number;
      delayVariationMs: number;
      jitter?: number;
      rtt?: number;
      sendDeltaMs?: number;
      receiveDeltaMs?: number;
      timestamp?: number;
    };
  }) => void;
  handlePipeRtcp: jest.Mock<Promise<{ forwarded: number }>, [string, Buffer, { roomId?: string }]>;
  closePipeTransport: jest.Mock<Promise<void>, [string]>;
} {
  const consumerTwccListeners = new Set<
    (state: {
      roomId: string;
      participantId: string;
      consumerId: string;
      producerId: string;
      transportId: string;
      observation: {
        packetLoss: number;
        delayVariationMs: number;
        jitter?: number;
        rtt?: number;
        sendDeltaMs?: number;
        receiveDeltaMs?: number;
        timestamp?: number;
      };
    }) => void
  >();
  return {
    getProducer: jest.fn((producerId: string) =>
      producerId === 'producer-1'
        ? ({
            id: 'producer-1',
            roomId: 'room-1',
            participantId: 'publisher',
            kind: 'video',
            transportId: 'transport-1',
            rtpParameters: rtpParameters(1111),
            status: 'live',
            createdAt: '2026-06-16T00:00:00.000Z'
          } satisfies Producer)
        : undefined
    ),
    ensurePipeTransport: jest.fn(
      async ({
        localNodeId,
        protocol,
        listenPort,
        advertisedIp
      }: {
        localNodeId: string;
        pipeTransportId: string;
        roomId: string;
        remoteNodeId: string;
        protocol: PipeTransportProtocol;
        listenPort?: number;
        advertisedIp?: string;
        peerToken?: string;
        remoteEndpoint?: { nodeId: string; advertiseIp: string; port: number };
      }) => ({
        localEndpoint:
          protocol === 'udp'
            ? {
                nodeId: localNodeId,
                advertiseIp: advertisedIp ?? '127.0.0.1',
                port: listenPort ?? 41000
              }
            : undefined
      })
    ),
    registerPipeProducer: jest.fn(async (_producer: Producer, _transportId?: string) => undefined),
    registerPipeConsumer: jest.fn(async (_consumer: Consumer, _transportId?: string) => undefined),
    unregisterProducer: jest.fn(async (_producerId: string) => undefined),
    unregisterConsumer: jest.fn(async (_consumerId: string) => undefined),
    setProducerPaused: jest.fn(async (_producerId: string, _paused: boolean) => undefined),
    setProducerPriority: jest.fn((_producerId: string, _priority: number) => undefined),
    setConsumerPaused: jest.fn(async (_consumerId: string, _paused: boolean) => undefined),
    setConsumerPreferredLayers: jest.fn(async (_consumerId: string, _preferredLayers: { spatialLayer?: number; temporalLayer?: number }) => undefined),
    setConsumerPreferredSvcLayers: jest.fn(
      async (_consumerId: string, _preferredSvcLayers: { spatialLayerId?: number; temporalLayerId?: number; qualityLayerId?: number }) => undefined
    ),
    setConsumerPriority: jest.fn((_consumerId: string, _priority: number) => undefined),
    applyConsumerTwccObservation: jest.fn(async (_consumerId: string, _observation) => undefined),
    onConsumerTwccObservation: jest.fn((listener) => {
      consumerTwccListeners.add(listener);
      return () => {
        consumerTwccListeners.delete(listener);
      };
    }),
    emitConsumerTwccObservation: (state) => {
      for (const listener of consumerTwccListeners) {
        listener(state);
      }
    },
    handlePipeRtcp: jest.fn(async (_pipeTransportId: string, _packet: Buffer, _options: { roomId?: string }) => ({ forwarded: 1 }))
    ,
    closePipeTransport: jest.fn(async (_pipeTransportId: string) => undefined)
  };
}

function fakeMetrics(): Record<string, unknown> {
  const metric: { inc: jest.Mock; set: jest.Mock; observe: jest.Mock; labels: jest.Mock } = {
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    labels: jest.fn()
  };
  metric.labels.mockReturnValue(metric);
  return {
    pipeSetupLatency: metric,
    pipeErrors: metric,
    pipeCreateRequests: metric,
    activePipeTransports: metric,
    pipeProducers: metric,
    pipeConsumers: metric,
    crossNodeSubscribers: metric,
    pipePacketLoss: metric,
    pipeTransportsCreated: metric,
    pipeTeardowns: metric,
    pipeCleanupFailures: metric,
    pipeRtcpPackets: metric,
    pipeRtcpBytes: metric,
    pipeCoordinationRetries: metric,
    pipeCoordinationTimeouts: metric,
    pipeUdpSetupSuccess: metric,
    pipeUdpSetupFailures: metric,
    pipeRemoteAttachFailures: metric,
    pipeRemotePublishFailures: metric,
    pipeWorkerModeRejected: metric,
    pipePeerAdmissionFailures: metric,
    pipeSignalingReroutes: metric,
    pipeRtcpForwarded: metric,
    pipeJitter: metric,
    pipeRtt: metric,
    refreshPipeTransportMetrics: jest.fn(),
    updatePipeTransportMetrics: jest.fn(),
    clearPipeTransportMetrics: jest.fn(),
    controlPlaneMessagesPublished: metric,
    controlPlanePublishFailures: metric,
    controlPlaneMessagesDelivered: metric,
    controlPlaneConsumeFailures: metric,
    controlPlaneReplayMessages: metric,
    controlPlaneDuplicateSuppressions: metric
  };
}

class FakeRedisService {
  readonly messages: PipeCoordinationEnvelope[] = [];
  readonly json = new Map<string, unknown>();
  publishDurable = jest.fn(async (_stream: string, payload: PipeCoordinationEnvelope): Promise<string> => {
    this.messages.push(payload);
    return `${this.messages.length}-0`;
  });
  consumeDurable = jest.fn(async (): Promise<void> => undefined);
  setJson = jest.fn(async (key: string, value: unknown): Promise<void> => {
    this.json.set(key, value);
  });
  getJson = jest.fn(async (key: string): Promise<unknown> => this.json.get(key) ?? null);
}

const CLAIMED_AT = '2026-06-16T00:00:00.000Z';
