export interface RtpHeaderExtension {
  profile: number;
  value: Buffer;
}

export class RtpPacket {
  constructor(
    readonly version: number,
    readonly padding: boolean,
    readonly extension: boolean,
    readonly marker: boolean,
    readonly payloadType: number,
    readonly sequenceNumber: number,
    readonly timestamp: number,
    readonly ssrc: number,
    readonly csrc: number[],
    readonly headerExtension: RtpHeaderExtension | null,
    readonly payload: Buffer
  ) {}

  static parse(buffer: Buffer): RtpPacket {
    if (buffer.length < 12) {
      throw new Error('RTP packet too short');
    }
    const first = buffer[0]!;
    const second = buffer[1]!;
    const version = first >> 6;
    if (version !== 2) {
      throw new Error(`Unsupported RTP version ${version}`);
    }
    const padding = Boolean(first & 0x20);
    const extension = Boolean(first & 0x10);
    const csrcCount = first & 0x0f;
    const marker = Boolean(second & 0x80);
    const payloadType = second & 0x7f;
    const sequenceNumber = buffer.readUInt16BE(2);
    const timestamp = buffer.readUInt32BE(4);
    const ssrc = buffer.readUInt32BE(8);
    let offset = 12;
    const csrc: number[] = [];
    for (let index = 0; index < csrcCount; index += 1) {
      csrc.push(buffer.readUInt32BE(offset));
      offset += 4;
    }
    let headerExtension: RtpHeaderExtension | null = null;
    if (extension) {
      const profile = buffer.readUInt16BE(offset);
      const extensionLengthWords = buffer.readUInt16BE(offset + 2);
      offset += 4;
      const extensionLength = extensionLengthWords * 4;
      headerExtension = {
        profile,
        value: buffer.subarray(offset, offset + extensionLength)
      };
      offset += extensionLength;
    }
    const payloadEnd = padding ? buffer.length - buffer[buffer.length - 1]! : buffer.length;
    if (payloadEnd < offset) {
      throw new Error('RTP padding exceeds payload bounds');
    }
    return new RtpPacket(version, padding, extension, marker, payloadType, sequenceNumber, timestamp, ssrc, csrc, headerExtension, buffer.subarray(offset, payloadEnd));
  }

  serialize(): Buffer {
    const extensionLength = this.headerExtension ? 4 + this.headerExtension.value.length : 0;
    const csrcLength = this.csrc.length * 4;
    const buffer = Buffer.alloc(12 + csrcLength + extensionLength + this.payload.length);
    buffer[0] = (this.version << 6) | (this.padding ? 0x20 : 0) | (this.headerExtension ? 0x10 : 0) | this.csrc.length;
    buffer[1] = (this.marker ? 0x80 : 0) | this.payloadType;
    buffer.writeUInt16BE(this.sequenceNumber, 2);
    buffer.writeUInt32BE(this.timestamp, 4);
    buffer.writeUInt32BE(this.ssrc, 8);
    let offset = 12;
    for (const csrc of this.csrc) {
      buffer.writeUInt32BE(csrc, offset);
      offset += 4;
    }
    if (this.headerExtension) {
      buffer.writeUInt16BE(this.headerExtension.profile, offset);
      buffer.writeUInt16BE(Math.ceil(this.headerExtension.value.length / 4), offset + 2);
      offset += 4;
      this.headerExtension.value.copy(buffer, offset);
      offset += this.headerExtension.value.length;
    }
    this.payload.copy(buffer, offset);
    return buffer;
  }
}
