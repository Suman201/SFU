import type {
  Consumer,
  ConsumerLayerEvent,
  ConsumerLayerState,
  ConsumerQualityState,
  IceCandidate,
  Producer,
  ProducerDynacastEvent,
  ProducerLayerState,
  ProducerQualityState,
  RoomQualityState,
  RtpLayerSelection,
  RtpParameters,
  SvcLayerSelection,
  TransportOptions,
  TransportQualityState
} from '@native-sfu/contracts';
import type { RtcpFeedback } from '@native-sfu/sfu-core';
import type { MediaPacketBridgeCounters } from '../media/media-packet-bridge';

export type MediaWorkerMode = 'in-process' | 'worker';
export type MediaWorkerStatus = 'starting' | 'ready' | 'draining' | 'overloaded' | 'unhealthy' | 'exited';

export interface MediaWorkerErrorShape {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  status?: number;
}

export interface MediaWorkerHealth {
  workerId: string;
  pid?: number;
  status?: MediaWorkerStatus;
  healthy: boolean;
  ready: boolean;
  draining?: boolean;
  overloaded?: boolean;
  capacityScore?: number;
  startedAt: string;
  lastHeartbeatAt?: string;
  lastError?: string;
  restarts: number;
  crashes: number;
  uptimeMs?: number;
  activeRooms: number;
  activeTransports: number;
  activeProducers: number;
  activeConsumers: number;
  rtpPackets: number;
  rtcpPackets: number;
  rtpPacketRate?: number;
  rtcpPacketRate?: number;
  inflightRequests: number;
  queueDepth: number;
  averageIpcLatencyMs: number;
  ipcTimeouts: number;
  roomLimit?: number;
  transportLimit?: number;
  inflightLimit?: number;
  memory?: NodeJS.MemoryUsage;
  cpu?: NodeJS.CpuUsage;
}

export interface MediaWorkerRoomFailureEvent {
  roomId: string;
  workerId: string;
  reason: 'worker_crashed' | 'worker_drained_forced' | 'worker_unhealthy' | 'worker_overloaded';
  message: string;
  failedAt: string;
  affectedTransports: string[];
  affectedProducers: string[];
  affectedConsumers: string[];
  recoverable: boolean;
}

export interface MediaWorkerPoolSnapshot {
  mode: MediaWorkerMode;
  workerCount: number;
  healthyWorkers: number;
  readyWorkers: number;
  drainingWorkers: number;
  overloadedWorkers: number;
  activeRooms: number;
  failedRooms: string[];
  failures: MediaWorkerRoomFailureEvent[];
  workers: MediaWorkerHealth[];
}

export type MediaWorkerRequestCommand =
  | { type: 'createWebRtcTransport'; roomId: string; participantId: string }
  | { type: 'ensurePipeTransport'; pipeTransportId: string; roomId: string; localNodeId: string; remoteNodeId: string }
  | { type: 'closePipeTransport'; pipeTransportId: string }
  | { type: 'assertTransportOwner'; transportId: string; participantId: string }
  | { type: 'addRemoteCandidate'; transportId: string; participantId: string; candidate: IceCandidate }
  | { type: 'setRemoteIceParameters'; transportId: string; participantId: string; parameters: TransportOptions['iceParameters'] }
  | { type: 'setRemoteDtlsParameters'; transportId: string; participantId: string; parameters: TransportOptions['dtlsParameters'] }
  | { type: 'restartIce'; transportId: string; participantId: string }
  | { type: 'bindProducer'; transportId: string; participantId: string; rtpParameters: RtpParameters }
  | { type: 'registerProducer'; producer: Producer }
  | { type: 'unregisterProducer'; producerId: string }
  | { type: 'setProducerPaused'; producerId: string; paused: boolean }
  | { type: 'setProducerPriority'; producerId: string; priority: number }
  | { type: 'registerConsumer'; consumer: Consumer }
  | { type: 'registerPipeProducer'; producer: Producer; pipeTransportId?: string }
  | { type: 'registerPipeConsumer'; consumer: Consumer; pipeTransportId?: string }
  | { type: 'handleRtcp'; transportId: string; participantId: string; packet: Buffer }
  | { type: 'handlePipeRtp'; pipeTransportId: string; producerId?: string; packet: Buffer }
  | { type: 'handlePipeRtcp'; pipeTransportId: string; packet: Buffer; options?: { roomId?: string; sourceParticipantId?: string } }
  | { type: 'unregisterConsumer'; consumerId: string }
  | { type: 'setConsumerPaused'; consumerId: string; paused: boolean }
  | { type: 'setConsumerPreferredLayers'; consumerId: string; preferredLayers: RtpLayerSelection }
  | { type: 'setConsumerPreferredSvcLayers'; consumerId: string; preferredSvcLayers: SvcLayerSelection }
  | { type: 'setConsumerPriority'; consumerId: string; priority: number }
  | { type: 'consumerLayerState'; consumerId: string }
  | { type: 'consumerQualityState'; consumerId: string }
  | { type: 'producerQualityState'; producerId: string }
  | { type: 'transportQualityState'; transportId: string }
  | { type: 'roomQualityState'; roomId: string }
  | { type: 'producerLayerState'; producerId: string }
  | { type: 'mediaCounters'; transportId: string; participantId: string }
  | { type: 'adaptiveTransportMetrics' }
  | { type: 'waitForMediaIdle'; transportId: string; participantId: string; timeoutMs?: number }
  | { type: 'closeParticipantTransports'; participantId: string }
  | { type: 'closeRoom'; roomId: string }
  | { type: 'workerHealth' }
  | { type: 'shutdown' };

export type MediaWorkerCommandResult =
  | TransportOptions
  | void
  | number
  | { feedback: RtcpFeedback; forwarded: number }
  | ConsumerLayerState
  | ProducerLayerState
  | ConsumerQualityState
  | ProducerQualityState
  | TransportQualityState
  | RoomQualityState
  | MediaPacketBridgeCounters
  | MediaWorkerHealth
  | Record<string, unknown>
  | undefined;

export interface MediaWorkerRequest {
  kind: 'request';
  id: string;
  command: MediaWorkerRequestCommand;
  createdAt: number;
}

export interface MediaWorkerResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  data?: MediaWorkerCommandResult;
  error?: MediaWorkerErrorShape;
  durationMs: number;
}

export type MediaWorkerEventPayload =
  | { type: 'ready'; workerId: string; pid: number; health: MediaWorkerHealth }
  | { type: 'health'; workerId: string; health: MediaWorkerHealth }
  | { type: 'error'; workerId: string; error: MediaWorkerErrorShape }
  | { type: 'pipe-rtp'; pipeTransportId: string; roomId: string; producerId: string; packet: Buffer }
  | { type: 'pipe-rtcp'; pipeTransportId: string; roomId: string; packet: Buffer; producerId?: string; consumerId?: string }
  | { type: 'consumer-layer'; event: ConsumerLayerEvent }
  | { type: 'producer-dynacast'; event: ProducerDynacastEvent }
  | { type: 'consumer-score'; state: ConsumerQualityState }
  | { type: 'producer-score'; state: ProducerQualityState }
  | { type: 'transport-quality'; state: TransportQualityState }
  | { type: 'room-quality'; state: RoomQualityState };

export interface MediaWorkerEvent {
  kind: 'event';
  event: MediaWorkerEventPayload;
}

export type MediaWorkerMessage = MediaWorkerRequest | MediaWorkerResponse | MediaWorkerEvent;

export function serializeError(error: unknown): MediaWorkerErrorShape {
  if (error instanceof Error) {
    const maybeStatus = error as Error & { status?: number; code?: string };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: maybeStatus.code,
      status: maybeStatus.status
    };
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown worker error'
  };
}

export function isMediaWorkerMessage(message: unknown): message is MediaWorkerMessage {
  return Boolean(message && typeof message === 'object' && 'kind' in message);
}
