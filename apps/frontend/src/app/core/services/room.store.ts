import { Injectable, signal } from '@angular/core';
import type { ChatMessage, Consumer, Participant, Producer, Room } from '@native-sfu/contracts';

@Injectable({ providedIn: 'root' })
export class RoomStore {
  readonly room = signal<Room | null>(null);
  readonly localParticipantId = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly activeSpeakerId = signal<string | null>(null);
  readonly waitingCount = signal(0);

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

  addMessage(message: ChatMessage): void {
    this.messages.set([...this.messages(), message].slice(-200));
  }
}
