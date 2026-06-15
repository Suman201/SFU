import { createHash } from 'crypto';
import type { IceCandidate } from '@native-sfu/contracts';
import type { IceCandidatePair, LocalIceCandidate, RemoteIceCandidate } from './ice.types';

const TYPE_PREFERENCE: Record<IceCandidate['type'], number> = {
  host: 126,
  prflx: 110,
  srflx: 100,
  relay: 0
};

export function computeCandidatePriority(candidate: Pick<IceCandidate, 'type' | 'component'>, localPreference = 65535): number {
  return (TYPE_PREFERENCE[candidate.type] << 24) + (localPreference << 8) + (256 - candidate.component);
}

export function computeCandidateFoundation(candidate: Pick<IceCandidate, 'type' | 'protocol' | 'ip'>, baseAddress = candidate.ip): string {
  return createHash('sha1').update(`${candidate.type}|${candidate.protocol}|${baseAddress}`).digest('hex').slice(0, 8);
}

export function computeCandidatePairPriority(localPriority: number, remotePriority: number, controlling: boolean): bigint {
  const g = BigInt(controlling ? localPriority : remotePriority);
  const d = BigInt(controlling ? remotePriority : localPriority);
  const min = g < d ? g : d;
  const max = g > d ? g : d;
  return (1n << 32n) * min + 2n * max + (g > d ? 1n : 0n);
}

export function pairId(local: LocalIceCandidate, remote: RemoteIceCandidate): string {
  return `${local.foundation}:${local.ip}:${local.port}:${remote.foundation}:${remote.ip}:${remote.port}:${local.component}`;
}

export function createCandidatePair(local: LocalIceCandidate, remote: RemoteIceCandidate, controlling: boolean): IceCandidatePair {
  return {
    id: pairId(local, remote),
    local,
    remote,
    priority: computeCandidatePairPriority(local.priority, remote.priority, controlling),
    state: 'waiting',
    nominated: false,
    failures: 0
  };
}

export function isCompatiblePair(local: IceCandidate, remote: IceCandidate): boolean {
  return local.component === remote.component && local.protocol === remote.protocol;
}
