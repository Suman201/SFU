import { allocatePriorityBudget } from './priority-allocator';

describe('priority allocator', () => {
  it('allocates residual transport budget by priority and health', () => {
    const allocations = allocatePriorityBudget(
      [
        {
          id: 'low-priority',
          roomId: 'room-1',
          transportId: 'transport-1',
          kind: 'video',
          paused: false,
          priority: 1,
          desiredBitrate: 1_200_000,
          minBitrate: 150_000,
          maxBitrate: 1_200_000,
          healthScore: 90
        },
        {
          id: 'high-priority',
          roomId: 'room-1',
          transportId: 'transport-1',
          kind: 'video',
          paused: false,
          priority: 6,
          desiredBitrate: 1_200_000,
          minBitrate: 150_000,
          maxBitrate: 1_200_000,
          healthScore: 90
        }
      ],
      1_200_000,
      { now: 1000 }
    );

    expect(allocations.get('high-priority')!.allocatedBitrate).toBeGreaterThan(allocations.get('low-priority')!.allocatedBitrate);
    expect(allocations.get('low-priority')!.allocatedBitrate).toBeGreaterThanOrEqual(150_000);
  });

  it('reserves audio and base video before video upgrades', () => {
    const allocations = allocatePriorityBudget(
      [
        {
          id: 'audio',
          roomId: 'room-1',
          transportId: 'transport-1',
          kind: 'audio',
          paused: false,
          priority: 1,
          desiredBitrate: 64_000,
          minBitrate: 48_000,
          maxBitrate: 96_000,
          healthScore: 100
        },
        {
          id: 'video',
          roomId: 'room-1',
          transportId: 'transport-1',
          kind: 'video',
          paused: false,
          priority: 1,
          desiredBitrate: 2_500_000,
          minBitrate: 150_000,
          maxBitrate: 2_500_000,
          healthScore: 100
        }
      ],
      220_000,
      { now: 1000 }
    );

    expect(allocations.get('audio')!.allocatedBitrate).toBeGreaterThanOrEqual(48_000);
    expect(allocations.get('video')!.allocatedBitrate).toBeGreaterThanOrEqual(150_000);
    expect(allocations.get('video')!.reason).toBe('bandwidth');
  });
});
