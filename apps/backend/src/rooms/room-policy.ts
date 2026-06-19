import type {
  Producer,
  ProducerKind,
  Room,
  RoomAutopilotAction,
  RoomAutopilotDecision,
  RoomAutopilotReasonCode,
  RoomAutopilotScope,
  RoomHealthState,
  RoomMediaProfile,
  RoomMediaProfileId,
  RtpParameters,
  RtpLayerSelection,
  RoomQualityState
} from '@native-sfu/contracts';
import type { ClusterNodeInfo } from '@native-sfu/contracts';
import type { RoomQualityRecommendation, RoomQualitySummaryState } from '@native-sfu/contracts';
import type { MediaWorkerPoolSnapshot } from '@native-sfu/nest-sfu';

const PROFILE_DEFINITIONS: Record<RoomMediaProfileId, Omit<RoomMediaProfile, 'updatedAt' | 'updatedByParticipantId'>> = {
  meeting: {
    id: 'meeting',
    label: 'Meeting',
    description: 'Balanced collaboration with moderate protection and high-quality camera defaults.',
    policy: {
      consumerPriorityWeights: { audio: 1.15, video: 1.1, screen: 1.35 },
      producerPriorityWeights: { audio: 1.2, video: 1.1, screen: 1.4 },
      bitrateFloorBps: { audio: 48_000, video: 300_000, screen: 500_000 },
      bitrateCeilingBps: { audio: 128_000, video: 2_500_000, screen: 3_200_000 },
      defaultLayerPreferences: {
        camera: { spatialLayer: 2, temporalLayer: 2 },
        screen: { spatialLayer: 2, temporalLayer: 1 },
        viewer: { spatialLayer: 2, temporalLayer: 1 }
      },
      screenSharePreference: 'balanced',
      congestionResponse: 'balanced',
      dynacastEnabled: true,
      admissionProtection: {
        join: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
        publish: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
        screenShare: { stable: 'allow', degraded: 'soft-throttle', critical: 'reject' }
      }
    }
  },
  webinar: {
    id: 'webinar',
    label: 'Webinar',
    description: 'Presenter-first profile that protects broadcast stability and favors screen detail.',
    policy: {
      consumerPriorityWeights: { audio: 1.25, video: 1.2, screen: 1.65 },
      producerPriorityWeights: { audio: 1.3, video: 1.2, screen: 1.75 },
      bitrateFloorBps: { audio: 64_000, video: 250_000, screen: 700_000 },
      bitrateCeilingBps: { audio: 128_000, video: 1_800_000, screen: 3_500_000 },
      defaultLayerPreferences: {
        camera: { spatialLayer: 1, temporalLayer: 2 },
        screen: { spatialLayer: 2, temporalLayer: 1 },
        viewer: { spatialLayer: 1, temporalLayer: 1 }
      },
      screenSharePreference: 'prefer-detail',
      congestionResponse: 'protective',
      dynacastEnabled: true,
      admissionProtection: {
        join: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
        publish: { stable: 'allow', degraded: 'soft-throttle', critical: 'reject' },
        screenShare: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' }
      }
    }
  },
  classroom: {
    id: 'classroom',
    label: 'Classroom',
    description: 'Teaching-oriented profile that keeps screen share strong while preserving discussion.',
    policy: {
      consumerPriorityWeights: { audio: 1.2, video: 1.15, screen: 1.55 },
      producerPriorityWeights: { audio: 1.2, video: 1.15, screen: 1.6 },
      bitrateFloorBps: { audio: 48_000, video: 300_000, screen: 650_000 },
      bitrateCeilingBps: { audio: 128_000, video: 2_200_000, screen: 3_200_000 },
      defaultLayerPreferences: {
        camera: { spatialLayer: 2, temporalLayer: 1 },
        screen: { spatialLayer: 2, temporalLayer: 1 },
        viewer: { spatialLayer: 1, temporalLayer: 1 }
      },
      screenSharePreference: 'prefer-detail',
      congestionResponse: 'balanced',
      dynacastEnabled: true,
      admissionProtection: {
        join: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
        publish: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' },
        screenShare: { stable: 'allow', degraded: 'warn', critical: 'warn' }
      }
    }
  },
  support: {
    id: 'support',
    label: 'Support',
    description: 'Low-latency support profile that prioritizes audio clarity and protects small-call stability.',
    policy: {
      consumerPriorityWeights: { audio: 1.35, video: 1.05, screen: 1.2 },
      producerPriorityWeights: { audio: 1.4, video: 1.05, screen: 1.15 },
      bitrateFloorBps: { audio: 64_000, video: 200_000, screen: 450_000 },
      bitrateCeilingBps: { audio: 128_000, video: 1_200_000, screen: 2_000_000 },
      defaultLayerPreferences: {
        camera: { spatialLayer: 1, temporalLayer: 1 },
        screen: { spatialLayer: 1, temporalLayer: 1 },
        viewer: { spatialLayer: 1, temporalLayer: 1 }
      },
      screenSharePreference: 'protect-room',
      congestionResponse: 'aggressive',
      dynacastEnabled: true,
      admissionProtection: {
        join: { stable: 'allow', degraded: 'soft-throttle', critical: 'reject' },
        publish: { stable: 'allow', degraded: 'soft-throttle', critical: 'reject' },
        screenShare: { stable: 'allow', degraded: 'warn', critical: 'soft-throttle' }
      }
    }
  }
};

export interface SummaryBuildInput {
  room: Room;
  quality: RoomQualityState;
  qualitySource: 'local-owner' | 'remote-signal-cache' | 'local-fallback';
  ownerAuthoritativeQuality: boolean;
  warnings: string[];
  node: ClusterNodeInfo;
  workers: MediaWorkerPoolSnapshot;
}

export function resolveRoomMediaProfile(
  profileId: RoomMediaProfileId | undefined,
  metadata: Pick<RoomMediaProfile, 'updatedAt' | 'updatedByParticipantId'> = {}
): RoomMediaProfile {
  const definition = PROFILE_DEFINITIONS[profileId ?? 'meeting'] ?? PROFILE_DEFINITIONS.meeting;
  return {
    ...definition,
    updatedAt: metadata.updatedAt,
    updatedByParticipantId: metadata.updatedByParticipantId
  };
}

export function defaultProducerPriority(profile: RoomMediaProfile, kind: ProducerKind): number {
  return clampPriority(profile.policy.producerPriorityWeights[kind]);
}

export function defaultConsumerPriority(profile: RoomMediaProfile, producerKind: ProducerKind): number {
  return clampPriority(profile.policy.consumerPriorityWeights[producerKind]);
}

export function defaultConsumerLayers(
  profile: RoomMediaProfile,
  producerKind: ProducerKind,
  options: { viewer?: boolean } = {}
): RtpLayerSelection | undefined {
  if (producerKind === 'audio') {
    return undefined;
  }
  if (options.viewer && profile.policy.defaultLayerPreferences.viewer) {
    return normalizeSelection(profile.policy.defaultLayerPreferences.viewer);
  }
  return normalizeSelection(
    producerKind === 'screen'
      ? profile.policy.defaultLayerPreferences.screen
      : profile.policy.defaultLayerPreferences.camera
  );
}

export function applyProfileBitratePolicy(
  profile: RoomMediaProfile,
  producerKind: ProducerKind,
  rtpParameters: RtpParameters
): RtpParameters {
  const floor = profile.policy.bitrateFloorBps[producerKind];
  const ceiling = profile.policy.bitrateCeilingBps[producerKind];
  if (floor === undefined && ceiling === undefined) {
    return rtpParameters;
  }

  const multiEncoding = rtpParameters.encodings.length > 1;
  let changed = false;
  const encodings = rtpParameters.encodings.map((encoding) => {
    let nextMaxBitrate = encoding.maxBitrate;
    if (nextMaxBitrate === undefined) {
      if (!multiEncoding) {
        nextMaxBitrate = ceiling ?? floor;
      }
    } else {
      if (!multiEncoding && floor !== undefined) {
        nextMaxBitrate = Math.max(nextMaxBitrate, floor);
      }
      if (ceiling !== undefined) {
        nextMaxBitrate = Math.min(nextMaxBitrate, ceiling);
      }
    }

    if (nextMaxBitrate === encoding.maxBitrate) {
      return encoding;
    }
    changed = true;
    return {
      ...encoding,
      maxBitrate: nextMaxBitrate
    };
  });

  if (!changed) {
    return rtpParameters;
  }

  return {
    ...rtpParameters,
    encodings
  };
}

export function buildRoomQualitySummary(input: SummaryBuildInput): RoomQualitySummaryState {
  const degradedConsumers = input.quality.consumers.filter((state) => isDegraded(state.score.reasons));
  const degradedProducers = input.quality.producers.filter((state) => isDegraded(state.score.reasons));
  const degradedTransports = input.quality.transports.filter((state) => isDegraded(state.score.reasons));
  const consumerStates = input.quality.consumers;
  const health = deriveRoomHealth(input, {
    degradedConsumers: degradedConsumers.length,
    degradedProducers: degradedProducers.length,
    degradedTransports: degradedTransports.length
  });
  const protections = {
    join: buildDecision('join', health, input.room.mediaProfile, input),
    publish: buildDecision('publish', health, input.room.mediaProfile, input),
    screenShare: buildDecision('screen-share', health, input.room.mediaProfile, input)
  };
  return {
    roomId: input.room.id,
    health,
    profile: input.room.mediaProfile,
    qualitySource: input.qualitySource,
    ownerAuthoritativeQuality: input.ownerAuthoritativeQuality,
    score: input.quality.score,
    congestionState: input.quality.congestionState,
    bitrate: {
      target: input.quality.targetBitrate,
      allocated: input.quality.allocatedBitrate,
      actual: input.quality.actualBitrate,
      maxAvailable: maxNumber(consumerStates.map((state) => state.bitrate.availableBitrate)),
      avgAvailable: averageNumber(consumerStates.map((state) => state.bitrate.availableBitrate)),
      maxRecommended: maxNumber(consumerStates.map((state) => state.bitrate.recommendedBitrate)),
      avgRecommended: averageNumber(consumerStates.map((state) => state.bitrate.recommendedBitrate))
    },
    participantCount: input.room.participants.length,
    admittedParticipantCount: input.room.participants.filter((participant) => participant.admitted).length,
    pendingParticipantCount: input.room.participants.filter((participant) => !participant.admitted).length,
    activeProducerCount: input.room.producers.filter((producer) => producer.status === 'live').length,
    activeScreenShareCount: input.room.producers.filter((producer) => producer.kind === 'screen' && producer.status === 'live').length,
    degradedConsumers: degradedConsumers.length,
    degradedProducers: degradedProducers.length,
    degradedTransports: degradedTransports.length,
    degradedEntityIds: {
      consumers: degradedConsumers.map((state) => state.consumerId),
      producers: degradedProducers.map((state) => state.producerId),
      transports: degradedTransports.map((state) => state.transportId)
    },
    protections,
    recommendations: buildRecommendations({ ...input, health, protections }),
    warnings: input.warnings,
    updatedAt: new Date().toISOString()
  };
}

export function recommendationCounts(summary: RoomQualitySummaryState): Record<string, number> {
  return summary.recommendations.reduce<Record<string, number>>((counts, recommendation) => {
    counts[recommendation.code] = (counts[recommendation.code] ?? 0) + 1;
    return counts;
  }, {});
}

export function actionForScope(profile: RoomMediaProfile, scope: RoomAutopilotScope, health: RoomHealthState): RoomAutopilotAction {
  const policy = scope === 'join'
    ? profile.policy.admissionProtection.join
    : scope === 'publish'
      ? profile.policy.admissionProtection.publish
      : profile.policy.admissionProtection.screenShare;
  return policy[health];
}

function buildDecision(
  scope: RoomAutopilotScope,
  health: RoomHealthState,
  profile: RoomMediaProfile,
  input: SummaryBuildInput
): RoomAutopilotDecision {
  const code = decisionCode(scope, health, input);
  return {
    scope,
    health,
    action: actionForScope(profile, scope, health),
    code,
    message: decisionMessage(scope, health, code, profile),
    triggeredBy: decisionTriggers(code),
    updatedAt: new Date().toISOString()
  };
}

function deriveRoomHealth(
  input: SummaryBuildInput,
  degraded: { degradedConsumers: number; degradedProducers: number; degradedTransports: number }
): RoomHealthState {
  const thresholds = healthThresholds(input.room.mediaProfile);
  if (
    input.node.draining
    || input.node.health === 'draining'
    || input.node.capacity.capacityScore >= 1
    || input.workers.overloadedWorkers > 0
    || input.workers.failedRooms.length > 0
    || input.quality.score.score < thresholds.criticalScore
    || (input.quality.congestionState === 'overuse' && thresholds.escalateOveruseToCritical)
  ) {
    return 'critical';
  }
  if (
    input.quality.congestionState === 'overuse'
    || input.quality.score.score < thresholds.degradedScore
    || degraded.degradedConsumers > 0
    || degraded.degradedProducers > 0
    || degraded.degradedTransports > 0
    || input.workers.drainingWorkers > 0
    || input.node.health !== 'healthy'
  ) {
    return 'degraded';
  }
  return 'stable';
}

function decisionCode(
  scope: RoomAutopilotScope,
  health: RoomHealthState,
  input: SummaryBuildInput
): RoomAutopilotReasonCode {
  if (input.node.draining || input.node.health === 'draining') {
    return 'node_draining';
  }
  if (input.node.capacity.capacityScore >= 1 || input.node.health === 'overloaded') {
    return 'node_overloaded';
  }
  if (input.workers.drainingWorkers > 0) {
    return 'worker_draining';
  }
  if (input.workers.overloadedWorkers > 0) {
    return 'worker_overloaded';
  }
  if (input.workers.readyWorkers === 0 && input.workers.workerCount > 0) {
    return 'worker_unavailable';
  }
  if (scope === 'screen-share' && input.room.mediaProfile.policy.screenSharePreference === 'protect-room' && health !== 'stable') {
    return 'screen_share_protected';
  }
  if (scope === 'publish' && health === 'critical') {
    return 'publisher_protected';
  }
  if (input.quality.congestionState === 'overuse') {
    return 'room_congestion';
  }
  if (health === 'critical') {
    return 'room_critical';
  }
  if (health === 'degraded') {
    return 'room_degraded';
  }
  return 'stable';
}

function decisionMessage(
  scope: RoomAutopilotScope,
  health: RoomHealthState,
  code: RoomAutopilotReasonCode,
  profile: RoomMediaProfile
): string {
  if (code === 'stable') {
    return `${capitalize(scope)} traffic is operating within the ${profile.label.toLowerCase()} profile.`;
  }
  if (code === 'screen_share_protected') {
    return `Screen sharing is being protected by the ${profile.label.toLowerCase()} profile while room quality is ${health}.`;
  }
  if (code === 'publisher_protected') {
    return `New publishers are being protected because the room is ${health}.`;
  }
  if (code === 'room_congestion') {
    return `Room congestion is high enough to change ${scope} handling.`;
  }
  return `${capitalize(scope)} handling is affected by ${code.replaceAll('_', ' ')}.`;
}

function decisionTriggers(code: RoomAutopilotReasonCode): Array<'room' | 'node' | 'worker' | 'profile'> {
  switch (code) {
    case 'node_draining':
    case 'node_overloaded':
      return ['node'];
    case 'worker_draining':
    case 'worker_overloaded':
    case 'worker_unavailable':
      return ['worker'];
    case 'screen_share_protected':
    case 'publisher_protected':
      return ['profile', 'room'];
    case 'room_congestion':
    case 'room_degraded':
    case 'room_critical':
      return ['room'];
    case 'profile_policy':
      return ['profile'];
    case 'stable':
    default:
      return ['room'];
  }
}

function buildRecommendations(input: SummaryBuildInput & {
  health: RoomHealthState;
  protections: RoomQualitySummaryState['protections'];
}): RoomQualityRecommendation[] {
  const recommendations: RoomQualityRecommendation[] = [];
  if (input.room.mediaProfile.policy.screenSharePreference !== 'protect-room' && input.protections.screenShare.action !== 'allow') {
    recommendations.push({
      code: 'reduce_screen_share_preference',
      severity: input.health === 'critical' ? 'critical' : 'warn',
      title: 'Reduce screen-share preference',
      detail: 'Screen-share priority is contributing to room protection. Switch to a more conservative profile or pause non-essential shares.',
      scope: 'screen-share',
      suggestedAction: input.protections.screenShare.action
    });
  }
  if (input.health !== 'stable') {
    recommendations.push({
      code: 'lower_room_target_quality',
      severity: input.health === 'critical' ? 'critical' : 'warn',
      title: 'Lower room target quality',
      detail: 'Current room score and congestion state suggest moving to lower default layers or a more protective profile.',
      scope: 'publish',
      suggestedAction: input.protections.publish.action
    });
  }
  if (input.protections.publish.action === 'soft-throttle' || input.protections.publish.action === 'reject') {
    recommendations.push({
      code: 'restrict_new_publishers',
      severity: input.protections.publish.action === 'reject' ? 'critical' : 'warn',
      title: 'Restrict new publishers',
      detail: 'Publisher admission should stay protected until transport quality recovers.',
      scope: 'publish',
      suggestedAction: input.protections.publish.action
    });
  }
  if (input.protections.join.action === 'soft-throttle' || input.protections.join.action === 'reject') {
    recommendations.push({
      code: 'throttle_new_joins',
      severity: input.protections.join.action === 'reject' ? 'critical' : 'warn',
      title: 'Throttle new joins',
      detail: 'New room joins should be slowed or manually admitted until the room stabilizes.',
      scope: 'join',
      suggestedAction: input.protections.join.action
    });
  }
  if (
    input.node.draining
    || input.node.capacity.capacityScore >= 1
    || input.workers.overloadedWorkers > 0
    || input.workers.drainingWorkers > 0
  ) {
    recommendations.push({
      code: 'drain_or_protect_node_admission',
      severity: 'critical',
      title: 'Protect node admission',
      detail: 'Node or worker pressure is affecting admission. Hold new room growth or drain the node before capacity worsens.',
      scope: 'join',
      suggestedAction: input.protections.join.action
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      code: 'monitor_room_stability',
      severity: 'info',
      title: 'Room is stable',
      detail: 'Current room score and worker pressure do not require protective changes.'
    });
  }
  return recommendations;
}

function normalizeSelection(selection: RtpLayerSelection | undefined): RtpLayerSelection | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    spatialLayer: selection.spatialLayer,
    temporalLayer: selection.temporalLayer
  };
}

function isDegraded(reasons: string[]): boolean {
  return reasons.some((reason) => reason !== 'stable' && reason !== 'recovered');
}

function clampPriority(priority: number | undefined): number {
  if (priority === undefined || Number.isNaN(priority) || !Number.isFinite(priority)) {
    return 1;
  }
  return Math.max(0.1, Math.min(10, priority));
}

function maxNumber(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((max, value) => Math.max(max, value), values[0] ?? 0);
}

function averageNumber(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function healthThresholds(profile: RoomMediaProfile): {
  degradedScore: number;
  criticalScore: number;
  escalateOveruseToCritical: boolean;
} {
  switch (profile.policy.congestionResponse) {
    case 'aggressive':
      return {
        degradedScore: 78,
        criticalScore: 58,
        escalateOveruseToCritical: true
      };
    case 'protective':
      return {
        degradedScore: 68,
        criticalScore: 50,
        escalateOveruseToCritical: false
      };
    case 'balanced':
    default:
      return {
        degradedScore: 72,
        criticalScore: 45,
        escalateOveruseToCritical: false
      };
  }
}

export function profileIds(): RoomMediaProfileId[] {
  return Object.keys(PROFILE_DEFINITIONS) as RoomMediaProfileId[];
}

export function profileDefinition(profileId: RoomMediaProfileId): Omit<RoomMediaProfile, 'updatedAt' | 'updatedByParticipantId'> {
  return PROFILE_DEFINITIONS[profileId];
}

export function producerKindsForRoom(room: Room): ProducerKind[] {
  return [...new Set(room.producers.map((producer) => producer.kind))];
}

export function prefersProtectedScreenShare(profile: RoomMediaProfile): boolean {
  return profile.policy.screenSharePreference === 'protect-room';
}

export function screenShareProducer(room: Room): Producer | undefined {
  return room.producers.find((producer) => producer.kind === 'screen' && producer.status === 'live');
}
