import { Role, type Room, type RoomQualityState } from '@native-sfu/contracts';
import { applyProfileBitratePolicy, buildRoomQualitySummary, resolveRoomMediaProfile } from './room-policy';

describe('room-policy', () => {
  it('builds a stable room summary for a healthy meeting profile', () => {
    const summary = buildRoomQualitySummary({
      room: roomFixture(),
      quality: roomQualityFixture(),
      qualitySource: 'local-owner',
      ownerAuthoritativeQuality: true,
      warnings: [],
      node: {
        nodeId: 'node-a',
        publicUrl: 'https://node-a.example.test',
        health: 'healthy',
        draining: false,
        capacity: { capacityScore: 0.2 },
        lastHeartbeatAt: '2026-06-19T00:00:00.000Z',
        claimedRoomCount: 1
      } as never,
      workers: {
        mode: 'worker',
        workerCount: 1,
        readyWorkers: 1,
        healthyWorkers: 1,
        drainingWorkers: 0,
        overloadedWorkers: 0,
        activeRooms: 1,
        failedRooms: [],
        failures: [],
        workers: []
      }
    });

    expect(summary.health).toBe('stable');
    expect(summary.protections.join.action).toBe('allow');
    expect(summary.recommendations[0]?.code).toBe('monitor_room_stability');
  });

  it('recommends throttling and publisher protection when the room is under pressure', () => {
    const summary = buildRoomQualitySummary({
      room: roomFixture(resolveRoomMediaProfile('support')),
      quality: roomQualityFixture({
        score: {
          score: 38,
          level: 'critical',
          reasons: ['overuse', 'bandwidth_limited'],
          breakdown: {
            packetLossScore: 40,
            rttScore: 42,
            jitterScore: 41,
            congestionScore: 22,
            retransmissionScore: 35,
            allocationScore: 36
          },
          updatedAt: '2026-06-19T00:00:00.000Z'
        },
        congestionState: 'overuse'
      }),
      qualitySource: 'local-owner',
      ownerAuthoritativeQuality: true,
      warnings: ['owner_quality_signal_stale'],
      node: {
        nodeId: 'node-a',
        publicUrl: 'https://node-a.example.test',
        health: 'overloaded',
        draining: false,
        capacity: { capacityScore: 1 },
        lastHeartbeatAt: '2026-06-19T00:00:00.000Z',
        claimedRoomCount: 3
      } as never,
      workers: {
        mode: 'worker',
        workerCount: 2,
        readyWorkers: 1,
        healthyWorkers: 1,
        drainingWorkers: 0,
        overloadedWorkers: 1,
        activeRooms: 3,
        failedRooms: [],
        failures: [],
        workers: []
      }
    });

    expect(summary.health).toBe('critical');
    expect(summary.protections.join.action).toBe('reject');
    expect(summary.protections.publish.action).toBe('reject');
    const codes = summary.recommendations.map((item) => item.code);
    expect(codes).toContain('restrict_new_publishers');
    expect(codes).toContain('throttle_new_joins');
    expect(codes).toContain('drain_or_protect_node_admission');
  });

  it('treats aggressive congestion profiles as critical earlier during overuse', () => {
    const summary = buildRoomQualitySummary({
      room: roomFixture(resolveRoomMediaProfile('support')),
      quality: roomQualityFixture({
        score: {
          score: 62,
          level: 'fair',
          reasons: ['overuse', 'bandwidth_limited'],
          breakdown: {
            packetLossScore: 65,
            rttScore: 63,
            jitterScore: 61,
            congestionScore: 45,
            retransmissionScore: 60,
            allocationScore: 58
          },
          updatedAt: '2026-06-19T00:00:00.000Z'
        },
        congestionState: 'overuse'
      }),
      qualitySource: 'local-owner',
      ownerAuthoritativeQuality: true,
      warnings: [],
      node: {
        nodeId: 'node-a',
        publicUrl: 'https://node-a.example.test',
        health: 'healthy',
        draining: false,
        capacity: { capacityScore: 0.3 },
        lastHeartbeatAt: '2026-06-19T00:00:00.000Z',
        claimedRoomCount: 1
      } as never,
      workers: {
        mode: 'worker',
        workerCount: 1,
        readyWorkers: 1,
        healthyWorkers: 1,
        drainingWorkers: 0,
        overloadedWorkers: 0,
        activeRooms: 1,
        failedRooms: [],
        failures: [],
        workers: []
      }
    });

    expect(summary.health).toBe('critical');
    expect(summary.protections.join.action).toBe('reject');
  });

  it('caps single-encoding producer bitrate with the active room profile policy', () => {
    const normalized = applyProfileBitratePolicy(resolveRoomMediaProfile('support'), 'video', {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90_000 }],
      encodings: [{ ssrc: 1111, maxBitrate: 2_000_000 }],
      rtcp: { cname: 'room-policy', reducedSize: true }
    });

    expect(normalized.encodings[0]?.maxBitrate).toBe(1_200_000);
  });
});

function roomFixture(profile = resolveRoomMediaProfile('meeting')): Room {
  return {
    id: 'room-1',
    name: 'Ops Room',
    hostId: 'host-1',
    settings: {
      locked: false,
      waitingRoomEnabled: false,
      joinApprovalRequired: false,
      visibility: 'public',
      maxParticipants: 16,
      recordingEnabled: false,
      chatEnabled: true
    },
    mediaProfile: profile,
    participants: [
      {
        id: 'host-1',
        userId: 'user-1',
        displayName: 'Host',
        socketId: 'socket-1',
        role: Role.HOST,
        audioEnabled: true,
        videoEnabled: true,
        screenSharing: false,
        handRaised: false,
        admitted: true,
        permissions: {
          canPublishAudio: true,
          canPublishVideo: true,
          canShareScreen: true,
          canChat: true
        },
        joinedAt: '2026-06-19T00:00:00.000Z',
        lastSeenAt: '2026-06-19T00:00:00.000Z'
      }
    ],
    producers: [],
    consumers: [],
    createdAt: '2026-06-19T00:00:00.000Z'
  };
}

function roomQualityFixture(overrides: Partial<RoomQualityState> = {}): RoomQualityState {
  return {
    roomId: 'room-1',
    score: {
      score: 88,
      level: 'good',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 90,
        rttScore: 89,
        jitterScore: 91,
        congestionScore: 86,
        retransmissionScore: 88,
        allocationScore: 90
      },
      updatedAt: '2026-06-19T00:00:00.000Z'
    },
    consumers: [],
    producers: [],
    transports: [],
    targetBitrate: 1_500_000,
    allocatedBitrate: 1_300_000,
    actualBitrate: 1_250_000,
    congestionState: 'normal',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...overrides
  };
}
