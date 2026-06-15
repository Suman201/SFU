import { PacketPacingQueue } from './pacing-queue';

describe('PacketPacingQueue', () => {
  it('sends packets through a rate-controlled queue and reports depth', async () => {
    const snapshots: number[] = [];
    const sent: string[] = [];
    const queue = new PacketPacingQueue({
      id: 'consumer:1',
      targetBitrateBps: 1_000_000,
      maxQueueBytes: 10_000,
      setTimeout: (handler) => handler(),
      onQueueDepth: (snapshot) => snapshots.push(snapshot.queuedPackets)
    });

    await Promise.all([
      queue.enqueue(1000, async () => {
        sent.push('a');
      }),
      queue.enqueue(1000, async () => {
        sent.push('b');
      })
    ]);

    expect(sent).toEqual(['a', 'b']);
    expect(queue.snapshot().sentPackets).toBe(2);
    expect(snapshots).toContain(1);
  });

  it('rejects packets that exceed the queue byte budget', async () => {
    const queue = new PacketPacingQueue({ id: 'consumer:1', targetBitrateBps: 1_000_000, maxQueueBytes: 1 });

    let error: Error | undefined;
    try {
      await queue.enqueue(2, async () => undefined);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(/exceeded/);
    expect(queue.snapshot().droppedPackets).toBe(1);
  });
});
