import type { Consumer, Producer, ProducerKind } from '@native-sfu/contracts';
import { RtpPacket } from './rtp-packet';

export type RtpWriter = (packet: RtpPacket, consumer: Consumer) => Promise<void>;

export interface RtpRouterMetrics {
  onForwardedPacket?: (kind: ProducerKind) => void;
  onDroppedPacket?: (reason: 'unknown_ssrc' | 'producer_paused' | 'no_consumers') => void;
}

interface ProducerRoute {
  producer: Producer;
  paused: boolean;
  ssrcs: Set<number>;
}

interface ConsumerRoute {
  consumer: Consumer;
  paused: boolean;
  writer: RtpWriter;
}

export class RtpRouter {
  private readonly producers = new Map<string, ProducerRoute>();
  private readonly producerBySsrc = new Map<number, string>();
  private readonly consumers = new Map<string, ConsumerRoute>();
  private readonly consumersByProducer = new Map<string, Set<string>>();
  private readonly participantProducers = new Map<string, Set<string>>();
  private readonly participantConsumers = new Map<string, Set<string>>();

  constructor(private readonly metrics: RtpRouterMetrics = {}) {}

  addProducer(producer: Producer): void {
    const ssrcs = new Set(producer.rtpParameters.encodings.map((encoding) => encoding.ssrc));
    this.producers.set(producer.id, { producer, paused: producer.status === 'paused', ssrcs });
    this.addToSet(this.participantProducers, producer.participantId, producer.id);
    for (const ssrc of ssrcs) {
      this.producerBySsrc.set(ssrc, producer.id);
    }
  }

  removeProducer(producerId: string): void {
    const route = this.producers.get(producerId);
    if (!route) {
      return;
    }
    for (const ssrc of route.ssrcs) {
      this.producerBySsrc.delete(ssrc);
    }
    this.producers.delete(producerId);
    this.consumersByProducer.delete(producerId);
  }

  setProducerPaused(producerId: string, paused: boolean): void {
    const route = this.producers.get(producerId);
    if (route) {
      route.paused = paused;
    }
  }

  addConsumer(consumer: Consumer, writer: RtpWriter): void {
    this.consumers.set(consumer.id, { consumer, writer, paused: consumer.status === 'paused' });
    this.addToSet(this.consumersByProducer, consumer.producerId, consumer.id);
    this.addToSet(this.participantConsumers, consumer.participantId, consumer.id);
  }

  removeConsumer(consumerId: string): void {
    const route = this.consumers.get(consumerId);
    if (!route) {
      return;
    }
    this.consumers.delete(consumerId);
    this.consumersByProducer.get(route.consumer.producerId)?.delete(consumerId);
    this.participantConsumers.get(route.consumer.participantId)?.delete(consumerId);
  }

  setConsumerPaused(consumerId: string, paused: boolean): void {
    const route = this.consumers.get(consumerId);
    if (route) {
      route.paused = paused;
    }
  }

  async route(buffer: Buffer): Promise<number> {
    const packet = RtpPacket.parse(buffer);
    const producerId = this.producerBySsrc.get(packet.ssrc);
    if (!producerId) {
      this.metrics.onDroppedPacket?.('unknown_ssrc');
      return 0;
    }
    const producerRoute = this.producers.get(producerId);
    if (!producerRoute || producerRoute.paused) {
      this.metrics.onDroppedPacket?.('producer_paused');
      return 0;
    }
    const consumerIds = this.consumersByProducer.get(producerId);
    if (!consumerIds || consumerIds.size === 0) {
      this.metrics.onDroppedPacket?.('no_consumers');
      return 0;
    }
    let forwarded = 0;
    for (const consumerId of consumerIds) {
      const consumerRoute = this.consumers.get(consumerId);
      if (!consumerRoute || consumerRoute.paused || !this.layerMatches(packet, producerRoute.producer, consumerRoute.consumer)) {
        continue;
      }
      await consumerRoute.writer(packet, consumerRoute.consumer);
      this.metrics.onForwardedPacket?.(producerRoute.producer.kind);
      forwarded += 1;
    }
    return forwarded;
  }

  removeParticipant(participantId: string): void {
    for (const producerId of this.participantProducers.get(participantId) ?? []) {
      this.removeProducer(producerId);
    }
    for (const consumerId of this.participantConsumers.get(participantId) ?? []) {
      this.removeConsumer(consumerId);
    }
    this.participantProducers.delete(participantId);
    this.participantConsumers.delete(participantId);
  }

  removeRoom(roomId: string): void {
    for (const route of [...this.producers.values()]) {
      if (route.producer.roomId === roomId) {
        this.removeProducer(route.producer.id);
      }
    }
    for (const route of [...this.consumers.values()]) {
      if (route.consumer.roomId === roomId) {
        this.removeConsumer(route.consumer.id);
      }
    }
  }

  private layerMatches(packet: RtpPacket, producer: Producer, consumer: Consumer): boolean {
    if (producer.kind === 'audio' || !consumer.preferredLayer) {
      return true;
    }
    const encoding = producer.rtpParameters.encodings.find((item) => item.ssrc === packet.ssrc);
    return !encoding?.rid || encoding.rid === consumer.preferredLayer;
  }

  private addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
    const existing = map.get(key) ?? new Set<string>();
    existing.add(value);
    map.set(key, existing);
  }
}
