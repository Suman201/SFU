import { Injectable, signal } from '@angular/core';
import type {
  ChatMessage,
  Consumer,
  ConsumerLayerEvent,
  ConsumerQualityState,
  Participant,
  Producer,
  ProducerDynacastEvent,
  ProducerQualityState,
  Room,
  RoomIncidentState,
  RoomIncidentTimelineEvent,
  RoomIncidentTimelineState,
  RoomQualityState,
  RoomQualitySummaryState,
  RoomSnapshotBundleSummary,
  RoomSnapshotHistoryState
} from '@native-sfu/contracts';

@Injectable({ providedIn: 'root' })
export class RoomStore {
  readonly room = signal<Room | null>(null);
  readonly localParticipantId = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly activeSpeakerId = signal<string | null>(null);
  readonly waitingCount = signal(0);
  readonly roomQuality = signal<RoomQualityState | null>(null);
  readonly roomQualitySummary = signal<RoomQualitySummaryState | null>(null);
  readonly roomIncidentState = signal<RoomIncidentState | null>(null);
  readonly roomIncidentTimeline = signal<RoomIncidentTimelineState | null>(null);
  readonly roomSnapshotHistory = signal<RoomSnapshotHistoryState | null>(null);

  setRoom(room: Room): void {
    const previousRoom = this.room();
    if (previousRoom?.id !== room.id) {
      this.roomQuality.set(null);
      this.roomQualitySummary.set(null);
      this.roomIncidentState.set(room.incidentState ?? null);
      this.roomIncidentTimeline.set(null);
      this.roomSnapshotHistory.set(null);
    } else if (previousRoom.mediaProfile.id !== room.mediaProfile.id) {
      this.roomQualitySummary.set(null);
      this.roomIncidentState.set(room.incidentState ?? this.roomIncidentState());
    } else if (room.incidentState) {
      this.roomIncidentState.set(room.incidentState);
    }
    this.room.set(room);
  }

  setLocalParticipant(participantId: string): void {
    this.localParticipantId.set(participantId);
  }

  upsertParticipant(participant: Participant): void {
    const room = this.room();
    if (!room) {
      return;
    }
    const participants = room.participants.filter((item) => item.id !== participant.id);
    this.room.set({ ...room, participants: [...participants, participant] });
  }

  patchParticipant(participantId: string, patch: Partial<Participant>): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      participants: room.participants.map((participant) => (participant.id === participantId ? { ...participant, ...patch } : participant))
    });
  }

  removeParticipant(participantId: string): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      participants: room.participants.filter((participant) => participant.id !== participantId),
      producers: room.producers.filter((producer) => producer.participantId !== participantId),
      consumers: room.consumers.filter((consumer) => consumer.participantId !== participantId)
    });
  }

  upsertProducer(producer: Producer): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({ ...room, producers: [...room.producers.filter((item) => item.id !== producer.id), producer] });
  }

  applyProducerDynacast(event: ProducerDynacastEvent): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      producers: room.producers.map((producer) => (producer.id === event.producerId ? { ...producer, dynacast: event.state } : producer))
    });
  }

  applyProducerQuality(state: ProducerQualityState): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      producers: room.producers.map((producer) => (producer.id === state.producerId ? { ...producer, quality: state } : producer))
    });
  }

  removeProducer(producerId: string): void {
    const room = this.room();
    if (room) {
      this.room.set({ ...room, producers: room.producers.filter((producer) => producer.id !== producerId) });
    }
  }

  upsertConsumer(consumer: Consumer): void {
    const room = this.room();
    if (room) {
      this.room.set({ ...room, consumers: [...room.consumers.filter((item) => item.id !== consumer.id), consumer] });
    }
  }

  applyConsumerLayerEvent(event: ConsumerLayerEvent): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      consumers: room.consumers.map((consumer) =>
        consumer.id === event.consumerId
          ? {
              ...consumer,
              preferredLayers: event.preferredLayers ?? consumer.preferredLayers,
              currentLayers: event.currentLayers ?? consumer.currentLayers,
              targetLayers: event.targetLayers ?? consumer.targetLayers,
              preferredSvcLayers: event.preferredSvcLayers ?? consumer.preferredSvcLayers,
              currentSvcLayers: event.currentSvcLayers ?? consumer.currentSvcLayers,
              targetSvcLayers: event.targetSvcLayers ?? consumer.targetSvcLayers,
              layerState: {
                roomId: event.roomId,
                participantId: event.participantId,
                consumerId: event.consumerId,
                producerId: event.producerId,
                preferredLayers: event.preferredLayers ?? consumer.preferredLayers,
                currentLayers: event.currentLayers ?? consumer.currentLayers,
                targetLayers: event.targetLayers ?? consumer.targetLayers,
                preferredSvcLayers: event.preferredSvcLayers ?? consumer.preferredSvcLayers,
                currentSvcLayers: event.currentSvcLayers ?? consumer.currentSvcLayers,
                targetSvcLayers: event.targetSvcLayers ?? consumer.targetSvcLayers,
                switchedAt: event.timestamp,
                switchReason: event.reason === 'missing_keyframe' || event.reason === 'missing_layer' ? 'unknown' : event.reason
              }
            }
          : consumer
      )
    });
  }

  applyConsumerQuality(state: ConsumerQualityState): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      consumers: room.consumers.map((consumer) => (consumer.id === state.consumerId ? { ...consumer, quality: state } : consumer))
    });
  }

  applyRoomQuality(state: RoomQualityState): void {
    this.roomQuality.set(state);
  }

  applyRoomQualitySummary(state: RoomQualitySummaryState): void {
    this.roomQualitySummary.set(state);
  }

  applyRoomIncidentState(state: RoomIncidentState): void {
    this.roomIncidentState.set(state);
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      incidentState: state
    });
  }

  applyRoomIncidentTimeline(state: RoomIncidentTimelineState): void {
    this.roomIncidentTimeline.set(state);
  }

  appendRoomIncidentEvent(event: RoomIncidentTimelineEvent): void {
    const current = this.roomIncidentTimeline();
    const events = [event, ...(current?.events ?? []).filter((entry) => entry.id !== event.id)].slice(0, 50);
    this.roomIncidentTimeline.set({
      roomId: event.roomId,
      events,
      updatedAt: new Date().toISOString()
    });
  }

  applyRoomSnapshotHistory(state: RoomSnapshotHistoryState): void {
    this.roomSnapshotHistory.set(state);
  }

  appendRoomSnapshotBundle(summary: RoomSnapshotBundleSummary): void {
    const current = this.roomSnapshotHistory();
    const bundles = [summary, ...(current?.bundles ?? []).filter((entry) => entry.bundleId !== summary.bundleId)].slice(0, 20);
    this.roomSnapshotHistory.set({
      roomId: summary.roomId,
      bundles,
      updatedAt: new Date().toISOString()
    });
    const incidentState = this.roomIncidentState();
    if (incidentState && incidentState.roomId === summary.roomId) {
      this.roomIncidentState.set({
        ...incidentState,
        snapshotCount: Math.max(incidentState.snapshotCount + 1, bundles.length),
        latestSnapshotId: summary.bundleId,
        updatedAt: new Date().toISOString()
      });
    }
  }

  applyRoomOwner(owner: Room['owner']): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.room.set({
      ...room,
      owner
    });
  }

  addMessage(message: ChatMessage): void {
    this.messages.set([...this.messages(), message].slice(-200));
  }
}
