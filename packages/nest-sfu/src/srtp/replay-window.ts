export class ReplayProtectionError extends Error {
  constructor(message = 'SRTP replay check failed') {
    super(message);
  }
}

export class ReplayWindow {
  private maxIndex = -1n;
  private window = 0n;

  constructor(private readonly size = 64) {}

  check(index: bigint): void {
    if (index < 0n) {
      throw new ReplayProtectionError('Replay index must be non-negative');
    }
    if (this.maxIndex < 0n) {
      return;
    }
    if (index > this.maxIndex) {
      return;
    }
    const delta = this.maxIndex - index;
    if (delta >= BigInt(this.size)) {
      throw new ReplayProtectionError('Packet is outside the replay window');
    }
    if (this.window & (1n << delta)) {
      throw new ReplayProtectionError('Packet has already been authenticated');
    }
  }

  accept(index: bigint): void {
    this.check(index);
    if (index > this.maxIndex) {
      const shift = index - this.maxIndex;
      this.window = shift >= BigInt(this.size) ? 1n : ((this.window << shift) | 1n) & this.mask;
      this.maxIndex = index;
      return;
    }
    this.window |= 1n << (this.maxIndex - index);
  }

  private get mask(): bigint {
    return (1n << BigInt(this.size)) - 1n;
  }
}
