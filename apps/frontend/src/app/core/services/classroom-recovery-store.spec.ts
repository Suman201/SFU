import { ClassroomRecoveryStore } from './classroom-recovery-store';

describe('ClassroomRecoveryStore durable lesson work', () => {
  const store = new ClassroomRecoveryStore();
  let prefix: string;
  beforeEach(() => { prefix = `test:${crypto.randomUUID()}:`; });
  afterEach(async () => { for (const entry of await store.list(prefix)) await store.remove(entry.key); });
  it('recovers exact whiteboard work through a new store instance', async () => {
    const board = { pages: [{ id: 'lesson', elements: [{ points: [0, 10, 20], text: 'Lesson' }] }] };
    await store.put(`${prefix}teacher:session`, board);
    expect(await new ClassroomRecoveryStore().get(`${prefix}teacher:session`)).toEqual(board);
  });
  it('keeps account prefixes isolated when finding pending work', async () => {
    await store.put(`${prefix}teacher:one`, 'teacher');
    await store.put(`${prefix}student:one`, 'student');
    expect((await store.list(`${prefix}student:`)).map((entry) => entry.value)).toEqual(['student']);
  });
  it('preserves binary recording chunks and removes acknowledged work', async () => {
    const key = `${prefix}chunk:0`;
    await store.put(key, new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' }));
    const saved = await new ClassroomRecoveryStore().get<Blob>(key);
    expect(Array.from(new Uint8Array(await saved!.arrayBuffer()))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    await store.remove(key);
    expect(await store.get(key)).toBeUndefined();
  });
});
