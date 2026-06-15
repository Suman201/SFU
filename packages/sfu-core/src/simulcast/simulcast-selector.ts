export type SimulcastLayer = 'low' | 'medium' | 'high';

export interface NetworkEstimate {
  availableBitrate: number;
  packetLoss: number;
  rtt: number;
}

export class SimulcastSelector {
  selectLayer(estimate: NetworkEstimate): SimulcastLayer {
    if (estimate.packetLoss > 0.08 || estimate.rtt > 450 || estimate.availableBitrate < 350_000) {
      return 'low';
    }
    if (estimate.packetLoss > 0.03 || estimate.rtt > 250 || estimate.availableBitrate < 1_200_000) {
      return 'medium';
    }
    return 'high';
  }
}
