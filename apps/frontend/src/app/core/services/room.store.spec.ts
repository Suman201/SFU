import type { Room, RoomIncidentState, RoomIncidentTimelineEvent, RoomQualitySummaryState, RoomSnapshotBundleSummary } from '@native-sfu/contracts';
import { RoomStore } from './room.store';

describe('RoomStore', () => {
  it('stores room quality summaries and clears them when the room changes', () => {
    const store = new RoomStore();
    const firstRoom = roomFixture('room-1', 'meeting');
    const secondRoom = roomFixture('room-2', 'webinar');
    const summary = summaryFixture('room-1', 'meeting');

    store.setRoom(firstRoom);
    store.applyRoomQualitySummary(summary);

    expect(store.roomQualitySummary()).toEqual(summary);

    store.setRoom(secondRoom);

    expect(store.room()?.id).toBe('room-2');
    expect(store.roomQualitySummary()).toBeNull();
  });

  it('clears the quality summary when the room media profile changes for the same room', () => {
    const store = new RoomStore();
    const meetingRoom = roomFixture('room-1', 'meeting');
    const webinarRoom = roomFixture('room-1', 'webinar');
    const summary = summaryFixture('room-1', 'meeting');

    store.setRoom(meetingRoom);
    store.applyRoomQualitySummary(summary);

    expect(store.roomQualitySummary()?.profile.id).toBe('meeting');

    store.setRoom(webinarRoom);

    expect(store.room()?.mediaProfile.id).toBe('webinar');
    expect(store.roomQualitySummary()).toBeNull();
  });

  it('stores and appends incident workflow state', () => {
    const store = new RoomStore();
    store.setRoom(roomFixture('room-1', 'meeting'));
    store.applyRoomIncidentState(incidentStateFixture('room-1'));
    store.appendRoomIncidentEvent(incidentEventFixture('event-1'));

    expect(store.roomIncidentState()?.status).toBe('critical');
    expect(store.room()?.incidentState?.status).toBe('critical');
    expect(store.roomIncidentTimeline()?.events.map((event) => event.id)).toEqual(['event-1']);
  });

  it('clears incident data when switching to a different room and appends snapshot history for the active room', () => {
    const store = new RoomStore();
    store.setRoom(roomFixture('room-1', 'meeting'));
    store.applyRoomIncidentState(incidentStateFixture('room-1'));
    store.appendRoomSnapshotBundle(snapshotBundleFixture('bundle-1', 'room-1'));

    expect(store.roomSnapshotHistory()?.bundles.length).toBe(1);
    expect(store.roomIncidentState()?.latestSnapshotId).toBe('bundle-1');

    store.setRoom(roomFixture('room-2', 'webinar'));

    expect(store.roomIncidentTimeline()).toBeNull();
    expect(store.roomSnapshotHistory()).toBeNull();
    expect(store.roomIncidentState()).toBeNull();
  });
});

function roomFixture(roomId: string, profileId: 'meeting' | 'webinar'): Room {
  return {
    id: roomId,
    name: 'Ops Room',
    hostId: 'host-1',
    settings: {
      locked: false,
      waitingRoomEnabled: false,
      joinApprovalRequired: false,
      visibility: 'public',
      maxParticipants: 12,
      recordingEnabled: false,
      chatEnabled: true
    },
    mediaProfile: {
      id: profileId,
      label: profileId,
      description: profileId,
      policy: {
        consumerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        producerPriorityWeights: { audio: 1, video: 1, screen: 1 },
        bitrateFloorBps: {},
        bitrateCeilingBps: {},
        defaultLayerPreferences: {},
        screenSharePreference: 'balanced',
        congestionResponse: 'balanced',
        dynacastEnabled: true,
        admissionProtection: {
          join: { stable: 'allow', degraded: 'warn', critical: 'reject' },
          publish: { stable: 'allow', degraded: 'warn', critical: 'reject' },
          screenShare: { stable: 'allow', degraded: 'warn', critical: 'reject' }
        }
      }
    },
    participants: [],
    producers: [],
    consumers: [],
    createdAt: '2026-06-19T00:00:00.000Z'
  };
}

function summaryFixture(roomId: string, profileId: 'meeting' | 'webinar'): RoomQualitySummaryState {
  return {
    roomId,
    health: 'stable',
    profile: roomFixture(roomId, profileId).mediaProfile,
    qualitySource: 'local-owner',
    ownerAuthoritativeQuality: true,
    score: {
      score: 90,
      level: 'excellent',
      reasons: ['stable'],
      breakdown: {
        packetLossScore: 90,
        rttScore: 90,
        jitterScore: 90,
        congestionScore: 90,
        retransmissionScore: 90,
        allocationScore: 90
      },
      updatedAt: '2026-06-19T00:00:00.000Z'
    },
    congestionState: 'normal',
    bitrate: {
      target: 1_000_000,
      allocated: 900_000,
      actual: 850_000,
      maxAvailable: 1_100_000,
      avgAvailable: 1_000_000,
      maxRecommended: 950_000,
      avgRecommended: 900_000
    },
    participantCount: 3,
    admittedParticipantCount: 3,
    pendingParticipantCount: 0,
    activeProducerCount: 1,
    activeScreenShareCount: 0,
    degradedConsumers: 0,
    degradedProducers: 0,
    degradedTransports: 0,
    degradedEntityIds: {
      consumers: [],
      producers: [],
      transports: []
    },
    protections: {
      join: {
        scope: 'join',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable joins',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      },
      publish: {
        scope: 'publish',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable publishers',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      },
      screenShare: {
        scope: 'screen-share',
        health: 'stable',
        action: 'allow',
        code: 'stable',
        message: 'Stable screen share',
        triggeredBy: ['room'],
        updatedAt: '2026-06-19T00:00:00.000Z'
      }
    },
    recommendations: [
      {
        code: 'monitor_room_stability',
        severity: 'info',
        title: 'Room is stable',
        detail: 'No action required.'
      }
    ],
    warnings: [],
    updatedAt: '2026-06-19T00:00:00.000Z'
  };
}

function incidentStateFixture(roomId: string): RoomIncidentState {
  return {
    roomId,
    status: 'critical',
    health: 'critical',
    protected: true,
    admissionsState: 'protected',
    publishingState: 'protected',
    underRecovery: true,
    activeAlerts: [
      {
        code: 'room_critical',
        severity: 'critical',
        title: 'Room critical',
        detail: 'The room needs operator attention.',
        firstTriggeredAt: '2026-06-19T00:00:00.000Z',
        lastTriggeredAt: '2026-06-19T00:00:00.000Z',
        occurrenceCount: 1
      }
    ],
    snapshotCount: 0,
    updatedAt: '2026-06-19T00:00:00.000Z'
  };
}

function incidentEventFixture(eventId: string): RoomIncidentTimelineEvent {
  return {
    id: eventId,
    roomId: 'room-1',
    type: 'room_failed',
    severity: 'critical',
    summary: 'Room media failed',
    createdAt: '2026-06-19T00:00:00.000Z'
  };
}

function snapshotBundleFixture(bundleId: string, roomId: string): RoomSnapshotBundleSummary {
  return {
    bundleId,
    roomId,
    generatedAt: '2026-06-19T00:00:00.000Z',
    triggerReason: 'manual_operator',
    automatic: false,
    health: 'critical',
    status: 'recovering',
    protected: true,
    underRecovery: true,
    degradedEntityCount: 3,
    warningCount: 2
  };
}
