import { EventEmitter } from 'node:events';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { MediaIngestSupervisorSnapshot, MediaProbeResult } from '@native-sfu/media-ingest';
import type { IngestRuntimeState } from '@native-sfu/contracts';
import { IngestPolicyService } from './ingest-policy.service';
import { IngestService } from './ingest.service';
import { IngestSupervisorService } from './ingest-supervisor.service';

describe('IngestService', () => {
  it('creates an ingest job with normalized source and default control-plane state', async () => {
    const harness = createHarness();
    harness.ingests.create.mockImplementation(async (payload: Record<string, unknown>) => ingestDoc(payload));

    const result = await harness.service.createAdminIngest(adminUser(), {
      name: '  Marketing pre-roll  ',
      displayName: '  System Ingest  ',
      sourceType: 'hls',
      sourceUrl: '  https://media.example.test/live/index.m3u8  ',
      auth: {
        bearerTokenSecretRef: '  vault://media/bearer  ',
        headers: [{ name: 'x-origin-token', valueSecretRef: 'vault://media/header-token' }]
      },
      restartPolicy: {
        mode: 'on_failure',
        maxAttempts: 5,
        initialBackoffMs: 1000
      }
    });

    const persisted = harness.ingests.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persisted.name).toBe('Marketing pre-roll');
    expect(persisted.displayName).toBe('System Ingest');
    expect(persisted.sourceUrl).toBe('https://media.example.test/live/index.m3u8');
    expect(persisted.transportProtocol).toBe('trusted-rtp-local');
    expect(persisted.status).toBe('idle');
    expect(result.sourceType).toBe('hls');
    expect(result.transportProtocol).toBe('trusted-rtp-local');
  });

  it('rejects ingest sources outside the configured allowlist', async () => {
    const harness = createHarness({ INGEST_ALLOWED_SOURCE_HOSTS: 'allowed.example.test' });

    let thrown: unknown;
    try {
      await harness.service.createAdminIngest(adminUser(), {
        sourceType: 'hls',
        sourceUrl: 'https://blocked.example.test/live/index.m3u8'
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('attaches an ingest job to a room and delegates live startup when requested', async () => {
    const harness = createHarness();
    const doc = ingestDoc({ status: 'idle', roomId: undefined });
    harness.ingests.findById.mockReturnValue(query(doc));
    harness.rooms.findOne.mockReturnValue(query(roomDoc()));
    const startedJob = ingestJob({ roomId: 'room-1', status: 'live' });
    (jest.spyOn as any)(harness.service, 'startAttachedRuntime').mockResolvedValue(startedJob);

    const result = await harness.service.attachAdminIngest(adminUser(), 'ingest-1', 'room-1', {
      displayName: 'Room Ingest',
      startIfStopped: true
    });

    expect(doc.roomId).toBe('room-1');
    expect(doc.displayName).toBe('Room Ingest');
    expect(doc.save).toHaveBeenCalled();
    expect(result.roomId).toBe('room-1');
    expect(result.status).toBe('live');
  });

  it('rejects attaching an ingest job to a different room while already attached', async () => {
    const harness = createHarness();
    harness.ingests.findById.mockReturnValue(query(ingestDoc({ roomId: 'room-a' })));
    harness.rooms.findOne.mockReturnValue(query(roomDoc({ id: 'room-b' })));

    let thrown: unknown;
    try {
      await harness.service.attachAdminIngest(adminUser(), 'ingest-1', 'room-b', {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
  });

  it('starts an attached ingest by provisioning a room participant, transport, and producers', async () => {
    const harness = createHarness();
    const doc = ingestDoc({ roomId: 'room-1', status: 'idle' });
    const probe = probeResult({ hasAudio: true, hasVideo: true });
    const supervisor = new FakeSupervisor(doc.id, probe);
    harness.ingests.findById.mockReturnValue(query(doc));
    harness.roomsService.createIngestParticipant.mockResolvedValue({ id: 'ingest-participant-1' });
    harness.ingestTransports.createTransport.mockResolvedValue(trustedTransport());
    harness.roomsService.createIngestProducer
      .mockResolvedValueOnce({ id: 'producer-video-1', kind: 'video' })
      .mockResolvedValueOnce({ id: 'producer-audio-1', kind: 'audio' });
    (jest.spyOn as any)(harness.service, 'probeSource').mockResolvedValue(probe);
    (jest.spyOn as any)(harness.service, 'createSupervisor').mockReturnValue(supervisor);

    const result = await harness.service.startAdminIngest(adminUser(), doc.id);

    const ownerAssertionCall = harness.nodeRegistry.assertLocalRoomOwner.mock.calls[0] as unknown[];
    expect(ownerAssertionCall[0]).toBe('room-1');
    const participantCreateCall = harness.roomsService.createIngestParticipant.mock.calls[0] as unknown[];
    expect(participantCreateCall[0]).toEqual({
      roomId: 'room-1',
      displayName: 'System Ingest'
    });
    const transportCreateCall = harness.ingestTransports.createTransport.mock.calls[0] as unknown[];
    expect(transportCreateCall[0]).toEqual({
      roomId: 'room-1',
      participantId: 'ingest-participant-1'
    });
    expect(harness.roomsService.createIngestProducer).toHaveBeenCalledTimes(2);
    const videoCreate = harness.roomsService.createIngestProducer.mock.calls[0]?.[0];
    const audioCreate = harness.roomsService.createIngestProducer.mock.calls[1]?.[0];
    expect(videoCreate.roomId).toBe('room-1');
    expect(videoCreate.participantId).toBe('ingest-participant-1');
    expect(videoCreate.transportId).toBe('transport-1');
    expect(videoCreate.kind).toBe('video');
    expect(audioCreate.roomId).toBe('room-1');
    expect(audioCreate.participantId).toBe('ingest-participant-1');
    expect(audioCreate.transportId).toBe('transport-1');
    expect(audioCreate.kind).toBe('audio');
    expect(result.status).toBe('live');
    expect(result.participantId).toBe('ingest-participant-1');
    expect(result.runtime?.participantId).toBe('ingest-participant-1');
    expect(result.runtime?.transportProtocol).toBe('trusted-rtp-local');
    expect(result.runtime?.listenAddress).toBe('127.0.0.1');
    expect(result.runtime?.rtpPort).toBe(5004);
    expect(result.runtime?.rtcpPort).toBe(5005);
    expect(result.runtime?.processId).toBe(4242);
  });

  it('routes an attached ingest start request to the current room owner when the owner is remote', async () => {
    const harness = createHarness();
    const doc = ingestDoc({ roomId: 'room-1', status: 'idle' });
    const ownerStartedJob = ingestJob({ roomId: 'room-1', status: 'live', nodeId: 'node-b', participantId: 'ingest-participant-remote' });
    harness.ingests.findById.mockReturnValue(query(doc));
    harness.nodeRegistry.lookupRoomOwner.mockResolvedValue(ownerLookup(false, 'node-b'));
    (jest.spyOn as any)(harness.service, 'dispatchCoordinationCommand').mockResolvedValue(ownerStartedJob);

    const result = await harness.service.startAdminIngest(adminUser(), doc.id);

    expect(result.status).toBe('live');
    expect(result.nodeId).toBe('node-b');
    expect(result.participantId).toBe('ingest-participant-remote');
    expect(harness.nodeRegistry.assertLocalRoomOwner).not.toHaveBeenCalled();
    expect(harness.roomsService.createIngestParticipant).not.toHaveBeenCalled();
  });

  it('routes detach to the current room owner when the owner is remote', async () => {
    const harness = createHarness();
    const doc = ingestDoc({ roomId: 'room-1', status: 'live', participantId: 'ingest-participant-1', nodeId: 'node-b' });
    const detachedJob = ingestJob({ status: 'stopped' });
    harness.ingests.findById.mockReturnValue(query(doc));
    harness.nodeRegistry.lookupRoomOwner.mockResolvedValue(ownerLookup(false, 'node-b'));
    (jest.spyOn as any)(harness.service, 'dispatchCoordinationCommand').mockResolvedValue(detachedJob);

    const result = await harness.service.detachAdminIngest(adminUser(), doc.id, 'room-1');

    expect(result.status).toBe('stopped');
    expect(harness.ingestTransports.closeTransport).not.toHaveBeenCalled();
    expect(harness.roomsService.removeIngestParticipant).not.toHaveBeenCalled();
  });

  it('routes an attached ingest stop request to the current room owner when the owner is remote', async () => {
    const harness = createHarness();
    const doc = ingestDoc({ roomId: 'room-1', status: 'live', participantId: 'ingest-participant-1', nodeId: 'node-b' });
    const stoppedJob = ingestJob({ roomId: 'room-1', status: 'stopped' });
    harness.ingests.findById.mockReturnValue(query(doc));
    harness.nodeRegistry.lookupRoomOwner.mockResolvedValue(ownerLookup(false, 'node-b'));
    (jest.spyOn as any)(harness.service, 'dispatchCoordinationCommand').mockResolvedValue(stoppedJob);

    const result = await harness.service.stopAdminIngest(adminUser(), doc.id);

    expect(result.status).toBe('stopped');
    expect(harness.nodeRegistry.assertLocalRoomOwner).not.toHaveBeenCalled();
    expect(harness.ingestTransports.closeTransport).not.toHaveBeenCalled();
    expect(harness.roomsService.removeIngestParticipant).not.toHaveBeenCalled();
  });

  it('detaches an active room ingest and tears down the runtime-owned participant state', async () => {
    const harness = createHarness();
    const doc = ingestDoc({
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      nodeId: 'node-a',
      status: 'live',
      runtimeState: {
        participantId: 'ingest-participant-1',
        transportProtocol: 'trusted-rtp-local',
        listenAddress: '127.0.0.1',
        rtpPort: 5004,
        rtcpPort: 5005
      } satisfies IngestRuntimeState
    });
    const supervisor = new FakeSupervisor(doc.id, probeResult({ hasAudio: true, hasVideo: true }));
    const stopSpy = jest.spyOn(supervisor, 'stop');
    harness.ingests.findById.mockReturnValue(query(doc));
    (harness.service as any).runtimes.set(doc.id, {
      jobId: doc.id,
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      transport: trustedTransport(),
      producerIds: ['producer-video-1', 'producer-audio-1'],
      supervisor,
      stopping: false,
      closingRoom: false
    });

    const result = await harness.service.detachAdminIngest(adminUser(), doc.id, 'room-1');

    expect(stopSpy).toHaveBeenCalled();
    const closeTransportCall = harness.ingestTransports.closeTransport.mock.calls[0] as unknown[];
    expect(closeTransportCall[0]).toBe('transport-1');
    const removeParticipantCall = harness.roomsService.removeIngestParticipant.mock.calls[0] as unknown[];
    expect(removeParticipantCall[0]).toBe('room-1');
    expect(removeParticipantCall[1]).toBe('ingest-participant-1');
    expect(result.roomId).toBeUndefined();
    expect(result.participantId).toBeUndefined();
    expect(result.status).toBe('stopped');
    expect(result.runtime?.lastStoppedAt).toBeDefined();
  });

  it('cleans up attached ingest runtimes when the room closes without double-removing the participant', async () => {
    const harness = createHarness();
    const doc = ingestDoc({
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      nodeId: 'node-a',
      status: 'live'
    });
    const supervisor = new FakeSupervisor(doc.id, probeResult({ hasAudio: true, hasVideo: false }));
    const stopSpy = jest.spyOn(supervisor, 'stop');
    harness.ingests.find.mockReturnValue(query([doc]));
    (harness.service as any).runtimes.set(doc.id, {
      jobId: doc.id,
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      transport: trustedTransport(),
      producerIds: ['producer-audio-1'],
      supervisor,
      stopping: false,
      closingRoom: false
    });

    await harness.emitRoomClosed('room-1');

    expect(stopSpy).toHaveBeenCalled();
    const roomCloseTransportCall = harness.ingestTransports.closeTransport.mock.calls[0] as unknown[];
    expect(roomCloseTransportCall[0]).toBe('transport-1');
    expect(harness.roomsService.removeIngestParticipant).not.toHaveBeenCalled();
    expect(doc.roomId).toBeUndefined();
    expect(doc.participantId).toBeUndefined();
    expect(doc.status).toBe('stopped');
  });

  it('re-homes a live attached ingest when room ownership moves away from the local node', async () => {
    const harness = createHarness();
    const doc = ingestDoc({
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      nodeId: 'node-a',
      status: 'live'
    });
    const supervisor = new FakeSupervisor(doc.id, probeResult({ hasAudio: true, hasVideo: true }));
    const stopSpy = jest.spyOn(supervisor, 'stop');
    harness.ingests.find.mockReturnValue(query([doc]));
    harness.nodeRegistry.lookupRoomOwner.mockResolvedValue(ownerLookup(false, 'node-b'));
    (harness.service as any).runtimes.set(doc.id, {
      jobId: doc.id,
      roomId: 'room-1',
      participantId: 'ingest-participant-1',
      transport: trustedTransport(),
      producerIds: ['producer-video-1', 'producer-audio-1'],
      supervisor,
      stopping: false,
      closingRoom: false
    });

    await (harness.service as any).reconcileRoomOwnership('room-1');

    expect(stopSpy).toHaveBeenCalled();
    expect(harness.ingestTransports.closeTransport).toHaveBeenCalled();
    const handoffRemoveCall = harness.roomsService.removeIngestParticipant.mock.calls[0] as unknown[];
    expect(handoffRemoveCall[0]).toBe('room-1');
    expect(handoffRemoveCall[1]).toBe('ingest-participant-1');
    expect(doc.status).toBe('restarting');
    expect(doc.nodeId).toBeUndefined();
    expect(doc.participantId).toBeUndefined();
  });

  it('resumes an attached ingest on the local node when room ownership becomes local again', async () => {
    const harness = createHarness();
    const doc = ingestDoc({
      roomId: 'room-1',
      participantId: undefined,
      nodeId: undefined,
      status: 'restarting'
    });
    harness.ingests.find.mockReturnValue(query([doc]));
    harness.nodeRegistry.lookupRoomOwner.mockResolvedValue(ownerLookup(true, 'node-a'));
    const restartedJob = ingestJob({ roomId: 'room-1', status: 'live', nodeId: 'node-a', participantId: 'ingest-participant-2' });
    (jest.spyOn as any)(harness.service, 'startAttachedRuntime').mockResolvedValue(restartedJob);

    await (harness.service as any).reconcileRoomOwnership('room-1');

    expect((harness.service as any).startAttachedRuntime).toHaveBeenCalledWith(doc);
  });

  it('combines detached and search filters without dropping either constraint', async () => {
    const harness = createHarness();
    harness.ingests.find.mockReturnValue(chain([]));
    const counts = [query(0), query(0), query(0), query(0), query(0), query(0), query(0), query(0), query(0), query(0)];
    harness.ingests.countDocuments.mockImplementation(() => counts.shift() ?? query(0));

    await harness.service.listAdminIngests(adminUser(), {
      attached: 'detached',
      search: 'promo'
    });

    const listFilter = harness.ingests.find.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(listFilter.$and).toBeDefined();
    expect(Array.isArray(listFilter.$and)).toBe(true);
    const andConditions = listFilter.$and as Array<Record<string, unknown>>;
    expect(andConditions.some((entry) => '$or' in entry)).toBe(true);
    expect(andConditions.some((entry) => JSON.stringify(entry).includes('roomId'))).toBe(true);
  });

  it('registers distributed coordination listeners on module init', async () => {
    const harness = createHarness();
    harness.ingests.find.mockReturnValue(query([]));

    await harness.service.onModuleInit();

    const consumeCall = harness.redis.consumeDurable.mock.calls[0] as unknown[];
    expect(consumeCall[0]).toBe('sfu:ingest-coordination');
    expect(consumeCall[1]).toBe('ingest-coordination:node-a');
    expect(typeof consumeCall[2]).toBe('function');

    const subscribeCall = harness.redis.subscribe.mock.calls[0] as unknown[];
    expect(subscribeCall[0]).toBe('sfu:room-owner-events');
    expect(typeof subscribeCall[1]).toBe('function');
  });
});

function createHarness(config: Record<string, string | number> = {}) {
  const ingests = {
    create: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn()
  };
  const rooms = {
    findOne: jest.fn()
  };
  let roomClosedListener: ((roomId: string) => void | Promise<void>) | undefined;
  const roomsService = {
    onRoomClosed: jest.fn((listener: (roomId: string) => void | Promise<void>) => {
      roomClosedListener = listener;
      return jest.fn();
    }),
    createIngestParticipant: jest.fn(),
    createIngestProducer: jest.fn(),
    removeIngestParticipant: jest.fn(async () => undefined)
  };
  const ingestTransports = {
    createTransport: jest.fn(),
    closeTransport: jest.fn(async () => undefined)
  };
  const redis = {
    publishDurable: jest.fn(async () => '1-0'),
    consumeDurable: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined)
  };
  const nodeRegistry = {
    assertLocalRoomOwner: jest.fn(async () => undefined),
    lookupRoomOwner: jest.fn(async () => ownerLookup(true, 'node-a')),
    localNodeId: jest.fn(() => 'node-a')
  };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => (key in config ? config[key] : fallback))
  };
  const policy = new IngestPolicyService(configService as never);
  const supervisor = new IngestSupervisorService();
  const service = new IngestService(
    ingests as never,
    rooms as never,
    policy,
    supervisor,
    roomsService as never,
    ingestTransports as never,
    redis as never,
    nodeRegistry as never,
    configService as never
  );

  return {
    service,
    ingests,
    rooms,
    roomsService,
    ingestTransports,
    redis,
    nodeRegistry,
    configService,
    emitRoomClosed: async (roomId: string) => {
      roomClosedListener?.(roomId);
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
}

function adminUser() {
  return { sub: 'admin-1', email: 'admin@example.test', roles: ['ADMIN'], permissions: [], tokenId: 'token-1' };
}

function ingestDoc(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'ingest-1',
    _id: 'ingest-1',
    name: 'Marketing pre-roll',
    displayName: 'System Ingest',
    sourceType: 'hls',
    sourceUrl: 'https://media.example.test/live/index.m3u8',
    transportProtocol: 'trusted-rtp-local',
    status: 'idle',
    auth: undefined,
    restartPolicy: undefined,
    runtimeState: undefined,
    roomId: undefined,
    participantId: undefined,
    nodeId: undefined,
    createdAt: new Date('2026-07-08T12:00:00.000Z'),
    updatedAt: new Date('2026-07-08T12:00:00.000Z'),
    save: jest.fn(async function (this: Record<string, unknown>) {
      return this;
    }),
    ...overrides
  };
}

function roomDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    _id: 'room-1',
    name: 'Operations Room',
    closedAt: undefined,
    ...overrides
  };
}

function ingestJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ingest-1',
    sourceType: 'hls',
    sourceUrl: 'https://media.example.test/live/index.m3u8',
    transportProtocol: 'trusted-rtp-local',
    status: 'starting',
    createdAt: '2026-07-08T12:00:00.000Z',
    updatedAt: '2026-07-08T12:00:00.000Z',
    ...overrides
  };
}

function trustedTransport() {
  return {
    id: 'transport-1',
    roomId: 'room-1',
    participantId: 'ingest-participant-1',
    protocol: 'trusted-rtp-local' as const,
    listenAddress: '127.0.0.1',
    rtpPort: 5004,
    rtcpPort: 5005,
    allowPrivateAddresses: true
  };
}

function probeResult(overrides: Partial<MediaProbeResult> = {}): MediaProbeResult {
  return {
    formatName: 'hls',
    durationSeconds: 60,
    bitrateBps: 1_500_000,
    hasAudio: true,
    hasVideo: true,
    streams: [
      { index: 0, kind: 'video', codec: 'h264', bitrateBps: 1_200_000, width: 1280, height: 720 },
      { index: 1, kind: 'audio', codec: 'opus', bitrateBps: 96_000, sampleRate: 48_000, channels: 2 }
    ],
    raw: {},
    ...overrides
  };
}

function query<T>(value: T) {
  return { exec: jest.fn(async () => value) };
}

function ownerLookup(local: boolean, ownerNodeId: string) {
  return {
    roomId: 'room-1',
    local,
    available: true,
    owner: {
      roomId: 'room-1',
      nodeId: ownerNodeId,
      publicUrl: `http://${ownerNodeId}.example.test`,
      claimedAt: '2026-07-08T12:00:00.000Z',
      lastHeartbeatAt: '2026-07-08T12:00:10.000Z',
      expiresAt: '2026-07-08T12:01:00.000Z'
    }
  };
}

function chain<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn(async () => value)
  };
}

class FakeSupervisor extends EventEmitter {
  private snapshotValue: MediaIngestSupervisorSnapshot;

  constructor(ingestId: string, probe: MediaProbeResult) {
    super();
    this.snapshotValue = {
      ingestId,
      state: 'starting',
      restartCount: 0,
      probe,
      runner: {
        ingestId,
        probe,
        command: {
          executable: 'ffmpeg',
          args: ['-f', 'lavfi']
        },
        health: {
          state: 'starting',
          pid: 4242,
          healthy: true,
          stale: false,
          progressCount: 0
        }
      },
      metrics: {
        starts: 1,
        liveTransitions: 0,
        restarts: 0,
        cleanStops: 0,
        failures: 0,
        lastStartAt: '2026-07-08T12:05:00.000Z'
      }
    };
  }

  async start(): Promise<void> {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: 'live',
      runner: this.snapshotValue.runner
        ? {
            ...this.snapshotValue.runner,
            health: {
              ...this.snapshotValue.runner.health,
              state: 'live',
              progressCount: 1
            }
          }
        : undefined,
      metrics: {
        ...this.snapshotValue.metrics,
        liveTransitions: 1
      }
    };
    this.emit('state', 'live', this.snapshot());
  }

  async stop(): Promise<void> {
    this.snapshotValue = {
      ...this.snapshotValue,
      state: 'stopped',
      runner: this.snapshotValue.runner
        ? {
            ...this.snapshotValue.runner,
            health: {
              ...this.snapshotValue.runner.health,
              state: 'stopped'
            }
          }
        : undefined,
      metrics: {
        ...this.snapshotValue.metrics,
        cleanStops: this.snapshotValue.metrics.cleanStops + 1,
        lastStopAt: '2026-07-08T12:06:00.000Z'
      }
    };
    this.emit('state', 'stopped', this.snapshot());
  }

  async waitForState(state: MediaIngestSupervisorSnapshot['state']): Promise<MediaIngestSupervisorSnapshot> {
    if (this.snapshotValue.state !== state) {
      this.snapshotValue = {
        ...this.snapshotValue,
        state
      };
    }
    return this.snapshot();
  }

  snapshot(): MediaIngestSupervisorSnapshot {
    return structuredClone(this.snapshotValue);
  }
}
