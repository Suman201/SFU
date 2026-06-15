import {
  FullIntraRequest,
  NackFeedback,
  parseFir,
  parseNack,
  parsePli,
  parseReceiverReport,
  parseRemb,
  parseRtcpCompound,
  parseSenderReport,
  PictureLossIndication,
  ReceiverEstimatedMaximumBitrate,
  ReceiverReport,
  ReceiverReportPacket,
  SenderReport
} from './rtcp-packet';
import { parseTransportWideCcFeedback, type TransportWideCcFeedback } from '../twcc/twcc';

export interface RtcpFeedback {
  senderReports: SenderReport[];
  receiverReportPackets: ReceiverReportPacket[];
  receiverReports: ReceiverReport[];
  nacks: NackFeedback[];
  nackPacketIds: number[];
  plis: PictureLossIndication[];
  pliSsrcs: number[];
  firs: FullIntraRequest[];
  firSsrcs: number[];
  rembs: ReceiverEstimatedMaximumBitrate[];
  transportWideCc: TransportWideCcFeedback[];
}

export interface RtcpProcessorMetrics {
  onSenderReport?: (roomId: string, participantId: string, report: SenderReport) => void;
  onReceiverReport?: (roomId: string, participantId: string, report: ReceiverReport) => void;
  onNack?: (roomId: string, participantId: string, feedback: NackFeedback) => void;
  onPli?: (roomId: string, participantId: string, feedback: PictureLossIndication) => void;
  onFir?: (roomId: string, participantId: string, feedback: FullIntraRequest) => void;
  onRemb?: (roomId: string, participantId: string, feedback: ReceiverEstimatedMaximumBitrate) => void;
  onTwcc?: (roomId: string, participantId: string, feedback: TransportWideCcFeedback) => void;
}

export class RtcpProcessor {
  constructor(private readonly metrics: RtcpProcessorMetrics = {}) {}

  process(roomId: string, participantId: string, buffer: Buffer): RtcpFeedback {
    const feedback: RtcpFeedback = {
      senderReports: [],
      receiverReportPackets: [],
      receiverReports: [],
      nacks: [],
      nackPacketIds: [],
      plis: [],
      pliSsrcs: [],
      firs: [],
      firSsrcs: [],
      rembs: [],
      transportWideCc: []
    };
    for (const packet of parseRtcpCompound(buffer)) {
      const senderReport = parseSenderReport(packet);
      if (senderReport) {
        feedback.senderReports.push(senderReport);
        feedback.receiverReports.push(...senderReport.reports);
      }
      const receiverReport = parseReceiverReport(packet);
      if (receiverReport) {
        feedback.receiverReportPackets.push(receiverReport);
        feedback.receiverReports.push(...receiverReport.reports);
      }
      const nack = parseNack(packet);
      if (nack) {
        feedback.nacks.push(nack);
        feedback.nackPacketIds.push(...nack.lostPacketIds);
      }
      const pli = parsePli(packet);
      if (pli) {
        feedback.plis.push(pli);
        feedback.pliSsrcs.push(pli.mediaSsrc);
      }
      const fir = parseFir(packet);
      if (fir) {
        feedback.firs.push(fir);
        feedback.firSsrcs.push(...fir.entries.map((entry) => entry.ssrc));
      }
      const remb = parseRemb(packet);
      if (remb) {
        feedback.rembs.push(remb);
      }
      const twcc = parseTransportWideCcFeedback(packet);
      if (twcc) {
        feedback.transportWideCc.push(twcc);
      }
    }
    for (const report of feedback.senderReports) {
      this.metrics.onSenderReport?.(roomId, participantId, report);
    }
    for (const report of feedback.receiverReports) {
      this.metrics.onReceiverReport?.(roomId, participantId, report);
    }
    for (const nack of feedback.nacks) {
      this.metrics.onNack?.(roomId, participantId, nack);
    }
    for (const pli of feedback.plis) {
      this.metrics.onPli?.(roomId, participantId, pli);
    }
    for (const fir of feedback.firs) {
      this.metrics.onFir?.(roomId, participantId, fir);
    }
    for (const remb of feedback.rembs) {
      this.metrics.onRemb?.(roomId, participantId, remb);
    }
    for (const twcc of feedback.transportWideCc) {
      this.metrics.onTwcc?.(roomId, participantId, twcc);
    }
    return feedback;
  }
}
