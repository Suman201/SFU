export interface PipeTransportSnapshotLike {
  roomId: string;
  localNodeId: string;
  remoteNodeId: string;
  active: boolean;
}

export interface PipeTransportRtcpSendOptions {
  producerId?: string;
  consumerId?: string;
}

export interface PipeTransportAdapter {
  hasTransport(id: string): boolean;
  snapshot(id: string): PipeTransportSnapshotLike | undefined;
  sendRtp(transportId: string, producerId: string, packet: Buffer): Promise<boolean>;
  sendRtcp(transportId: string, packet: Buffer, options?: PipeTransportRtcpSendOptions): Promise<boolean>;
}
