import type { PriorityAllocationState, ProducerKind } from '@native-sfu/contracts';

export interface PriorityAllocationCandidate {
  id: string;
  transportId: string;
  roomId: string;
  kind: ProducerKind;
  paused: boolean;
  priority: number;
  desiredBitrate: number;
  minBitrate: number;
  maxBitrate: number;
  healthScore: number;
  starvedSince?: number;
}

export interface PriorityAllocatorOptions {
  now?: number;
  minEffectivePriority?: number;
  maxSingleConsumerShare?: number;
}

export interface PriorityAllocationResult extends PriorityAllocationState {
  consumerId: string;
  roomId: string;
  transportId: string;
}

export function allocatePriorityBudget(
  candidates: PriorityAllocationCandidate[],
  budgetBitrate: number,
  options: PriorityAllocatorOptions = {}
): Map<string, PriorityAllocationResult> {
  const now = options.now ?? Date.now();
  const live = candidates.filter((candidate) => !candidate.paused);
  const results = new Map<string, PriorityAllocationResult>();
  for (const candidate of candidates) {
    results.set(candidate.id, emptyAllocation(candidate, now, candidate.paused ? 'paused' : 'bandwidth'));
  }
  if (live.length === 0) {
    return results;
  }
  const budget = Math.max(0, Math.floor(budgetBitrate));
  const allocated = new Map<string, number>();
  let remaining = budget;
  const reserveGroups = [
    live.filter((candidate) => candidate.kind === 'audio'),
    live.filter((candidate) => candidate.kind !== 'audio')
  ];
  for (const group of reserveGroups) {
    for (const candidate of group.sort((left, right) => allocationWeight(right, now, options) - allocationWeight(left, now, options))) {
      const floor = clampBitrate(candidate.minBitrate, 0, candidate.maxBitrate);
      const amount = Math.min(floor, remaining);
      allocated.set(candidate.id, (allocated.get(candidate.id) ?? 0) + amount);
      remaining -= amount;
      if (remaining <= 0) {
        break;
      }
    }
  }
  if (remaining > 0) {
    const upgradeCandidates = live.filter((candidate) => (allocated.get(candidate.id) ?? 0) < candidate.maxBitrate);
    const totalWeight = upgradeCandidates.reduce((sum, candidate) => sum + allocationWeight(candidate, now, options), 0);
    for (const candidate of upgradeCandidates) {
      const current = allocated.get(candidate.id) ?? 0;
      const desired = Math.max(candidate.desiredBitrate, candidate.minBitrate);
      const cap = Math.min(candidate.maxBitrate, desired);
      if (cap <= current || totalWeight <= 0) {
        continue;
      }
      const singleCap = live.length > 1 && candidate.kind !== 'screen' ? Math.floor(budget * (options.maxSingleConsumerShare ?? 0.6)) : budget;
      const share = Math.floor(remaining * (allocationWeight(candidate, now, options) / totalWeight));
      const amount = Math.max(0, Math.min(cap - current, share, Math.max(0, singleCap - current)));
      allocated.set(candidate.id, current + amount);
    }
    const used = [...allocated.values()].reduce((sum, value) => sum + value, 0);
    remaining = Math.max(0, budget - used);
  }
  if (remaining > 0) {
    const byUtility = live
      .filter((candidate) => (allocated.get(candidate.id) ?? 0) < Math.min(candidate.maxBitrate, Math.max(candidate.desiredBitrate, candidate.minBitrate)))
      .sort((left, right) => allocationWeight(right, now, options) - allocationWeight(left, now, options));
    for (const candidate of byUtility) {
      const current = allocated.get(candidate.id) ?? 0;
      const cap = Math.min(candidate.maxBitrate, Math.max(candidate.desiredBitrate, candidate.minBitrate));
      const amount = Math.min(cap - current, remaining);
      allocated.set(candidate.id, current + amount);
      remaining -= amount;
      if (remaining <= 0) {
        break;
      }
    }
  }
  for (const candidate of live) {
    const assigned = Math.max(0, Math.floor(allocated.get(candidate.id) ?? 0));
    const minBitrate = clampBitrate(candidate.minBitrate, 0, candidate.maxBitrate);
    const desiredBitrate = Math.max(minBitrate, candidate.desiredBitrate);
    const starvationPrevented = assigned >= minBitrate && assigned < desiredBitrate && Boolean(candidate.starvedSince);
    const reason =
      assigned < minBitrate
        ? 'starvation'
        : assigned < desiredBitrate
          ? budget < desiredBitrate
            ? 'bandwidth'
            : 'congestion'
          : 'preferred';
    results.set(candidate.id, {
      consumerId: candidate.id,
      roomId: candidate.roomId,
      transportId: candidate.transportId,
      priority: normalizePriority(candidate.priority),
      desiredBitrate,
      allocatedBitrate: assigned,
      minBitrate,
      maxBitrate: candidate.maxBitrate,
      fairShareBitrate: live.length === 0 ? 0 : Math.floor(budget / live.length),
      starvationPrevented,
      reason,
      updatedAt: new Date(now).toISOString()
    });
  }
  return results;
}

export function normalizePriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) {
    return 1;
  }
  return Math.max(0.1, Math.min(10, priority));
}

function emptyAllocation(candidate: PriorityAllocationCandidate, now: number, reason: PriorityAllocationState['reason']): PriorityAllocationResult {
  return {
    consumerId: candidate.id,
    roomId: candidate.roomId,
    transportId: candidate.transportId,
    priority: normalizePriority(candidate.priority),
    desiredBitrate: Math.max(0, candidate.desiredBitrate),
    allocatedBitrate: 0,
    minBitrate: Math.max(0, candidate.minBitrate),
    maxBitrate: Math.max(0, candidate.maxBitrate),
    fairShareBitrate: 0,
    starvationPrevented: false,
    reason,
    updatedAt: new Date(now).toISOString()
  };
}

function allocationWeight(candidate: PriorityAllocationCandidate, now: number, options: PriorityAllocatorOptions): number {
  const priority = Math.max(options.minEffectivePriority ?? 0.35, normalizePriority(candidate.priority));
  const kindWeight = candidate.kind === 'screen' ? 1.8 : candidate.kind === 'audio' ? 10 : 1;
  const health = Math.max(0.25, Math.min(1, candidate.healthScore / 100));
  const starvationBoost = candidate.starvedSince === undefined ? 1 : 1 + Math.min(1.5, Math.max(0, now - candidate.starvedSince) / 15000);
  const demand = Math.max(1, candidate.desiredBitrate - candidate.minBitrate);
  return Math.sqrt(priority) * kindWeight * health * starvationBoost * Math.log2(2 + demand / 150_000);
}

function clampBitrate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}
