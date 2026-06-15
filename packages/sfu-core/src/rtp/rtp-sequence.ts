export const RTP_SEQUENCE_MODULO = 0x1_0000;
export const RTP_TIMESTAMP_MODULO = 0x1_0000_0000;

export function normalizeSequenceNumber(value: number): number {
  return value & 0xffff;
}

export function normalizeTimestamp(value: number): number {
  return value >>> 0;
}

export function addSequenceNumber(value: number, delta: number): number {
  return normalizeSequenceNumber(value + delta);
}

export function addTimestamp(value: number, delta: number): number {
  return normalizeTimestamp(value + delta);
}

export function sequenceDelta(current: number, base: number): number {
  const delta = (normalizeSequenceNumber(current) - normalizeSequenceNumber(base) + RTP_SEQUENCE_MODULO) % RTP_SEQUENCE_MODULO;
  return delta > 0x7fff ? delta - RTP_SEQUENCE_MODULO : delta;
}

export function sequenceDistance(from: number, to: number): number {
  return (normalizeSequenceNumber(to) - normalizeSequenceNumber(from) + RTP_SEQUENCE_MODULO) % RTP_SEQUENCE_MODULO;
}

export function timestampDistance(from: number, to: number): number {
  return (normalizeTimestamp(to) - normalizeTimestamp(from) + RTP_TIMESTAMP_MODULO) % RTP_TIMESTAMP_MODULO;
}
