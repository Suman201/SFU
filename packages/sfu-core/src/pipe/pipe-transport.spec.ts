import { createPli, createReceiverReport, createSenderReport, parsePli, parseReceiverReport, parseRtcpCompound, parseSenderReport } from '../rtcp/rtcp-packet';
import { RtpPacket } from '../rtp/rtp-packet';
import { connectPipeTransports, PipeTransport, PipeTransportManager } from './pipe-transport';
import { createTransportWideCcFeedback, parseTransportWideCcFeedback } from '../twcc/twcc';

describe('PipeTransport', () => {
  it('forwards RTP across two internal node transports with SSRC mapping and sequence continuity', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    owner.createProducer({
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: rtpParameters(1111),
      ssrcMappings: [{ sourceSsrc: 1111, targetSsrc: 2222 }]
    });
    const received: RtpPacket[] = [];
    remote.on('rtp', (event) => received.push(RtpPacket.parse(event.packet)));

    expect(await owner.sendRtp('producer-1', rtpPacket(1111, 10, 9000))).toBe(true);

    expect(received.length).toBe(1);
    expect(received[0]?.ssrc).toBe(2222);
    expect(received[0]?.sequenceNumber).toBe(10);
    expect(received[0]?.timestamp).toBe(9000);
    expect(remote.snapshot().rtpPackets).toBe(1);
    expect(remote.snapshot().rtpBytes).toBeGreaterThan(12);
  });

  it('drops duplicate RTP packets at the receiving pipe replay window', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    owner.createProducer({ id: 'producer-1', participantId: 'publisher', rtpParameters: rtpParameters(1111) });
    let received = 0;
    remote.on('rtp', () => {
      received += 1;
    });

    const packet = rtpPacket(1111, 10, 9000);
    await owner.sendRtp('producer-1', packet);
    await owner.sendRtp('producer-1', packet);

    expect(received).toBe(1);
    expect(remote.snapshot().droppedPackets).toBe(1);
    expect(remote.snapshot().dropReasons.replay).toBe(1);
  });

  it('rewrites RTCP feedback SSRCs across the pipe', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    remote.createConsumer({ id: 'consumer-1', producerId: 'producer-1', participantId: 'viewer', rtpParameters: rtpParameters(2222) });
    const received: Buffer[] = [];
    owner.on('rtcp', (event) => received.push(event.packet));

    await remote.sendRtcp(createPli({ senderSsrc: 9000, mediaSsrc: 2222 }), {
      consumerId: 'consumer-1',
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });

    expect(received.length).toBe(1);
    expect(parsePliFromBuffer(received[0]!)?.mediaSsrc).toBe(1111);
  });

  it('infers RTCP SSRC mappings from the registered pipe consumer', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    remote.createConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'viewer',
      rtpParameters: rtpParameters(2222),
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    const received: Buffer[] = [];
    owner.on('rtcp', (event) => received.push(event.packet));

    await remote.sendRtcp(createPli({ senderSsrc: 9000, mediaSsrc: 2222 }), { consumerId: 'consumer-1' });

    expect(received.length).toBe(1);
    expect(parsePliFromBuffer(received[0]!)?.mediaSsrc).toBe(1111);
  });

  it('infers RTCP SSRC mappings from the registered pipe producer', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    owner.createProducer({
      id: 'producer-1',
      participantId: 'publisher',
      rtpParameters: rtpParameters(1111),
      ssrcMappings: [{ sourceSsrc: 1111, targetSsrc: 2222 }]
    });
    const received: Buffer[] = [];
    remote.on('rtcp', (event) => received.push(event.packet));

    await owner.sendRtcp(createPli({ senderSsrc: 9000, mediaSsrc: 1111 }), { producerId: 'producer-1' });

    expect(received.length).toBe(1);
    expect(parsePliFromBuffer(received[0]!)?.mediaSsrc).toBe(2222);
  });

  it('rewrites sender-report, receiver-report, and TWCC SSRCs across the pipe', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    remote.createConsumer({
      id: 'consumer-1',
      producerId: 'producer-1',
      participantId: 'viewer',
      rtpParameters: rtpParameters(2222),
      ssrcMappings: [{ sourceSsrc: 2222, targetSsrc: 1111 }]
    });
    const received: Buffer[] = [];
    owner.on('rtcp', (event) => received.push(event.packet));

    await remote.sendRtcp(
      createSenderReport({
        senderSsrc: 2222,
        ntpTimestamp: 1n,
        rtpTimestamp: 3333,
        packetCount: 4,
        octetCount: 5,
        reports: [{ ssrc: 2222, fractionLost: 0, packetsLost: 0, highestSequence: 10, jitter: 2, lastSenderReport: 0, delaySinceLastSenderReport: 0 }]
      }),
      { consumerId: 'consumer-1' }
    );
    await remote.sendRtcp(
      createReceiverReport({
        reporterSsrc: 2222,
        reports: [{ ssrc: 2222, fractionLost: 0, packetsLost: 0, highestSequence: 11, jitter: 3, lastSenderReport: 0, delaySinceLastSenderReport: 0 }]
      }),
      { consumerId: 'consumer-1' }
    );
    await remote.sendRtcp(
      createTransportWideCcFeedback({
        senderSsrc: 2222,
        mediaSsrc: 2222,
        feedbackPacketCount: 1,
        arrivals: [{ sequenceNumber: 10, arrivalTimeMs: 1000, size: 1200 }]
      }),
      { consumerId: 'consumer-1' }
    );

    expect(received.length).toBe(3);
    const senderReport = parseSenderReport(parseRtcpCompound(received[0]!)[0]!);
    const receiverReport = parseReceiverReport(parseRtcpCompound(received[1]!)[0]!);
    const twcc = parseTransportWideCcFeedback(parseRtcpCompound(received[2]!)[0]!);
    expect(senderReport?.senderSsrc).toBe(1111);
    expect(senderReport?.reports[0]?.ssrc).toBe(1111);
    expect(receiverReport?.reporterSsrc).toBe(1111);
    expect(receiverReport?.reports[0]?.ssrc).toBe(1111);
    expect(twcc?.senderSsrc).toBe(1111);
    expect(twcc?.mediaSsrc).toBe(1111);
  });

  it('reports backpressure instead of enqueueing beyond configured limits', async () => {
    const owner = new PipeTransport({ id: 'pipe-owner', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b', maxQueueBytes: 4 });
    const remote = new PipeTransport({ id: 'pipe-remote', roomId: 'room-1', localNodeId: 'node-b', remoteNodeId: 'node-a' });
    connectPipeTransports(owner, remote);
    owner.createProducer({ id: 'producer-1', participantId: 'publisher', rtpParameters: rtpParameters(1111) });

    expect(await owner.sendRtp('producer-1', rtpPacket(1111, 10, 9000))).toBe(false);

    expect(owner.snapshot().backpressureEvents).toBe(1);
    expect(owner.snapshot().dropReasons.backpressure).toBe(1);
    expect(remote.snapshot().rtpPackets).toBe(0);
  });

  it('cleans transports through the manager by room and explicit close', () => {
    const manager = new PipeTransportManager();
    const first = manager.createTransport({ id: 'pipe-a', roomId: 'room-1', localNodeId: 'node-a', remoteNodeId: 'node-b' });
    manager.createTransport({ id: 'pipe-b', roomId: 'room-2', localNodeId: 'node-a', remoteNodeId: 'node-c' });

    expect(manager.snapshots().length).toBe(2);
    manager.closeRoom('room-1');

    expect(first.snapshot().active).toBe(false);
    expect(manager.snapshots().map((snapshot) => snapshot.id)).toEqual(['pipe-b']);
    manager.closeTransport('pipe-b', 'node_left');
    expect(manager.snapshots().length).toBe(0);
  });
});

function rtpParameters(ssrc: number) {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, rtcpFeedback: ['nack pli'] }],
    encodings: [{ ssrc }],
    rtcp: { cname: 'pipe-test', reducedSize: true }
  };
}

function rtpPacket(ssrc: number, sequenceNumber: number, timestamp: number): Buffer {
  return new RtpPacket(2, false, false, false, 96, sequenceNumber, timestamp, ssrc, [], null, Buffer.from('pipe-media')).serialize();
}

function parsePliFromBuffer(packet: Buffer) {
  const parsed = parsePli({ version: 2, padding: false, count: packet[0]! & 0x1f, type: packet[1]! as 206, length: packet.readUInt16BE(2), payload: packet.subarray(4) });
  return parsed;
}
