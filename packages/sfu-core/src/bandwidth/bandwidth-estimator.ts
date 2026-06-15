export interface BandwidthSample {
  timestamp: number;
  bytes: number;
  rtt: number;
  packetLoss: number;
}

export class BandwidthEstimator {
  private readonly samples = new Map<string, BandwidthSample[]>();

  addSample(participantId: string, sample: BandwidthSample): number {
    const samples = [...(this.samples.get(participantId) ?? []), sample].slice(-20);
    this.samples.set(participantId, samples);
    if (samples.length < 2) {
      return 0;
    }
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const elapsedSeconds = Math.max((last.timestamp - first.timestamp) / 1000, 1);
    const bytes = samples.reduce((sum, item) => sum + item.bytes, 0);
    const lossPenalty = Math.max(0.2, 1 - last.packetLoss * 2);
    const rttPenalty = last.rtt > 300 ? 0.75 : 1;
    return Math.floor((bytes * 8 * lossPenalty * rttPenalty) / elapsedSeconds);
  }
}
