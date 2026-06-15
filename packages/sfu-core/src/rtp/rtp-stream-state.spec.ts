import { RtpPacket } from './rtp-packet';
import { RtpSourceStreamState } from './rtp-stream-state';

describe('RtpSourceStreamState', () => {
  it('validates payload type and SSRC', () => {
    const state = new RtpSourceStreamState({ ssrc: 1111, allowedPayloadTypes: [96] });

    expect(state.accept(packet(2222, 96, 1)).dropReason).toBe('invalid_ssrc');
    expect(state.accept(packet(1111, 97, 1)).dropReason).toBe('invalid_payload_type');
  });

  it('buffers reordered packets and releases them in sequence', () => {
    const state = new RtpSourceStreamState({ ssrc: 1111, allowedPayloadTypes: [96] });

    expect(state.accept(packet(1111, 96, 10)).packets.map((item) => item.sequenceNumber)).toEqual([10]);
    const buffered = state.accept(packet(1111, 96, 12));
    expect(buffered.buffered).toBe(true);
    expect(buffered.packets).toEqual([]);
    expect(state.accept(packet(1111, 96, 11)).packets.map((item) => item.sequenceNumber)).toEqual([11, 12]);
  });

  it('drops duplicate and late packets', () => {
    const state = new RtpSourceStreamState({ ssrc: 1111, allowedPayloadTypes: [96] });

    state.accept(packet(1111, 96, 10));
    state.accept(packet(1111, 96, 11));

    expect(state.accept(packet(1111, 96, 11)).dropReason).toBe('duplicate_packet');
    expect(state.accept(packet(1111, 96, 9)).dropReason).toBe('late_packet');
  });

  it('detects stream restarts on large sequence jumps', () => {
    const state = new RtpSourceStreamState({ ssrc: 1111, allowedPayloadTypes: [96], restartSequenceGap: 100 });

    state.accept(packet(1111, 96, 10));
    const restarted = state.accept(packet(1111, 96, 1000));

    expect(restarted.restarted).toBe(true);
    expect(restarted.packets.map((item) => item.sequenceNumber)).toEqual([1000]);
    expect(state.snapshot().restartCount).toBe(1);
  });
});

function packet(ssrc: number, payloadType: number, sequenceNumber: number): RtpPacket {
  return RtpPacket.parse(rawPacket(ssrc, payloadType, sequenceNumber, sequenceNumber * 3000));
}

function rawPacket(ssrc: number, payloadType: number, sequenceNumber: number, timestamp: number): Buffer {
  const payload = Buffer.from('state');
  const packetBuffer = Buffer.alloc(12 + payload.length);
  packetBuffer[0] = 0x80;
  packetBuffer[1] = payloadType;
  packetBuffer.writeUInt16BE(sequenceNumber, 2);
  packetBuffer.writeUInt32BE(timestamp >>> 0, 4);
  packetBuffer.writeUInt32BE(ssrc >>> 0, 8);
  payload.copy(packetBuffer, 12);
  return packetBuffer;
}
