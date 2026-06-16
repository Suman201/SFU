import type {
  Consumer,
  PipeAckMessage,
  PipeCoordinationEnvelope,
  PipeCreateMessage,
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
      consumerId: 'consumer-1'
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
    expect(media.registerPipeConsumer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
    const remotePipeProducer = remote.media?.registerPipeProducer.mock.calls[0]?.[0];
    expect(remotePipeProducer?.id).toBe('producer-1');
    expect(remotePipeProducer?.roomId).toBe('room-1');
    expect(remotePipeProducer?.transportId).toBe('pipe:internal:room-1:node-a:node-b');
    expect(remote.media?.registerPipeProducer.mock.calls[0]?.[1]).toBe('pipe:internal:room-1:node-a:node-b');
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
  return { service, pipe, redis, registry, media: options.media };
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

function producerClose(pipeTransportId: string, producerId: string): PipeProducerCloseMessage {
  return {
    type: 'pipe:producer:close',
    roomId: 'room-1',
    pipeTransportId,
    ownerClaimedAt: CLAIMED_AT,
    producerId,
    reason: 'producer_closed'
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
  registerPipeProducer: jest.Mock<Promise<void>, [Producer, string?]>;
  registerPipeConsumer: jest.Mock<Promise<void>, [Consumer, string?]>;
  unregisterProducer: jest.Mock<Promise<void>, [string]>;
  unregisterConsumer: jest.Mock<Promise<void>, [string]>;
  setProducerPaused: jest.Mock<Promise<void>, [string, boolean]>;
  setProducerPriority: jest.Mock<void, [string, number]>;
  handlePipeRtcp: jest.Mock<Promise<{ forwarded: number }>, [string, Buffer, { roomId?: string }]>;
  closePipeTransport: jest.Mock<Promise<void>, [string]>;
} {
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
    registerPipeProducer: jest.fn(async (_producer: Producer, _transportId?: string) => undefined),
    registerPipeConsumer: jest.fn(async (_consumer: Consumer, _transportId?: string) => undefined),
    unregisterProducer: jest.fn(async (_producerId: string) => undefined),
    unregisterConsumer: jest.fn(async (_consumerId: string) => undefined),
    setProducerPaused: jest.fn(async (_producerId: string, _paused: boolean) => undefined),
    setProducerPriority: jest.fn((_producerId: string, _priority: number) => undefined),
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
