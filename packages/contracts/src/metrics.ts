export interface NetworkQuality {
  bitrate: number;
  packetLoss: number;
  rtt: number;
  jitter: number;
  score: 1 | 2 | 3 | 4 | 5;
}

export interface RoomAnalytics {
  activeUsers: number;
  joinDurationMs: number;
  audioLevel: number;
  videoQuality: NetworkQuality;
}
