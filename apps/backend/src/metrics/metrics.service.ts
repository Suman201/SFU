import { Injectable, OnModuleInit } from '@nestjs/common';
import client, { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();
  readonly activeRooms = new Gauge({ name: 'sfu_active_rooms', help: 'Current active rooms' });
  readonly activeParticipants = new Gauge({ name: 'sfu_active_participants', help: 'Current active participants', labelNames: ['roomId'] });
  readonly activeTransports = new Gauge({ name: 'sfu_active_transports', help: 'Current active media transports' });
  readonly activeProducers = new Gauge({ name: 'sfu_active_producers', help: 'Current active producers', labelNames: ['kind'] });
  readonly activeConsumers = new Gauge({ name: 'sfu_active_consumers', help: 'Current active consumers' });
  readonly forwardedRtpPackets = new Counter({ name: 'sfu_forwarded_rtp_packets_total', help: 'Forwarded RTP packets', labelNames: ['kind'] });
  readonly droppedRtpPackets = new Counter({ name: 'sfu_dropped_rtp_packets_total', help: 'Dropped RTP packets', labelNames: ['reason'] });
  readonly roomJoinDuration = new Histogram({
    name: 'sfu_room_join_duration_ms',
    help: 'Room join duration in milliseconds',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
  });
  readonly packetLoss = new Gauge({ name: 'sfu_packet_loss_ratio', help: 'Packet loss ratio by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly rtt = new Gauge({ name: 'sfu_rtt_ms', help: 'RTT in milliseconds by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly jitter = new Gauge({ name: 'sfu_jitter_ms', help: 'Jitter in milliseconds by room and participant', labelNames: ['roomId', 'participantId'] });
  readonly bandwidth = new Gauge({ name: 'sfu_bandwidth_bps', help: 'Estimated bandwidth in bits per second', labelNames: ['roomId', 'participantId', 'direction'] });

  onModuleInit(): void {
    this.registry.setDefaultLabels({ service: 'native-webrtc-sfu' });
    client.collectDefaultMetrics({ register: this.registry });
    [
      this.activeRooms,
      this.activeParticipants,
      this.activeTransports,
      this.activeProducers,
      this.activeConsumers,
      this.forwardedRtpPackets,
      this.droppedRtpPackets,
      this.roomJoinDuration,
      this.packetLoss,
      this.rtt,
      this.jitter,
      this.bandwidth
    ].forEach((metric) => this.registry.registerMetric(metric as never));
  }

  async text(): Promise<string> {
    return this.registry.metrics();
  }
}
