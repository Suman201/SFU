import { Injectable, signal } from '@angular/core';
import type { ChatMessage, Consumer, ConsumerLayerEvent, ConsumerQualityState, Participant, Producer, ProducerDynacastEvent, ProducerQualityState, Room, RoomQualityState } from '@native-sfu/contracts';

@Injectable({ providedIn: 'root' })
export class RoomStore {
  readonly room = signal<Room | null>(null);
  readonly localParticipantId = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly activeSpeakerId = signal<string | null>(null);
  readonly waitingCount = signal(0);
  readonly roomQuality = signal<RoomQualityState | null>(null);

  setRoom(room: Room): void {
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

  addMessage(message: ChatMessage): void {
    this.messages.set([...this.messages(), message].slice(-200));
  }
}
