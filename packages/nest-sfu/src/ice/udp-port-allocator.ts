export class UdpPortAllocator {
  private readonly used = new Set<number>();
  private next: number;

  constructor(
    private readonly min: number,
    private readonly max: number
  ) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 65535 || min > max) {
      throw new Error(`Invalid UDP port range ${min}-${max}`);
    }
    this.next = min;
  }

  acquire(): number {
    const capacity = this.max - this.min + 1;
    for (let attempt = 0; attempt < capacity; attempt += 1) {
      const candidate = this.next;
      this.next = this.next >= this.max ? this.min : this.next + 1;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
    throw new Error(`No UDP ports available in range ${this.min}-${this.max}`);
  }

  release(port: number): void {
    this.used.delete(port);
  }
}
