import { parseNack, parsePli, parseReceiverReports, parseRtcpCompound, ReceiverReport } from './rtcp-packet';

export interface RtcpFeedback {
  receiverReports: ReceiverReport[];
  nackPacketIds: number[];
  pliSsrcs: number[];
}

export interface RtcpProcessorMetrics {
  onReceiverReport?: (roomId: string, participantId: string, report: ReceiverReport) => void;
}

export class RtcpProcessor {
  constructor(private readonly metrics: RtcpProcessorMetrics = {}) {}

  process(roomId: string, participantId: string, buffer: Buffer): RtcpFeedback {
    const feedback: RtcpFeedback = {
      receiverReports: [],
      nackPacketIds: [],
      pliSsrcs: []
    };
    for (const packet of parseRtcpCompound(buffer)) {
      feedback.receiverReports.push(...parseReceiverReports(packet));
      const nack = parseNack(packet);
      if (nack) {
        feedback.nackPacketIds.push(...nack.lostPacketIds);
      }
      const pli = parsePli(packet);
      if (pli) {
        feedback.pliSsrcs.push(pli.mediaSsrc);
      }
    }
    for (const report of feedback.receiverReports) {
      this.metrics.onReceiverReport?.(roomId, participantId, report);
    }
    return feedback;
  }
}
