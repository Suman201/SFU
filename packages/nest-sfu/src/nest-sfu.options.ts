import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency, Type } from '@nestjs/common';
import type { ProducerKind } from '@native-sfu/contracts';
import type { ReceiverReport } from '@native-sfu/sfu-core';

export interface NestSfuMetricsHooks {
  onForwardedRtpPacket?: (kind: ProducerKind) => void;
  onDroppedRtpPacket?: (reason: 'unknown_ssrc' | 'producer_paused' | 'no_consumers') => void;
  onReceiverReport?: (roomId: string, participantId: string, report: ReceiverReport) => void;
}

export interface NestSfuOptions {
  turnSecret: string;
  turnUris: string[];
  hostCandidatePort?: number;
  hostCandidatePortRange?: {
    min: number;
    max: number;
  };
  includeLoopbackCandidates?: boolean;
  gatherInterfaces?: string[];
  iceRole?: 'controlling' | 'controlled';
  iceTaMs?: number;
  iceTransactionTimeoutMs?: number;
  consentIntervalMs?: number;
  consentTimeoutMs?: number;
  maxConsentFailures?: number;
  turnCredentialTtlSeconds?: number;
  metrics?: NestSfuMetricsHooks;
}

export interface NestSfuOptionsFactory {
  createNestSfuOptions(): Promise<NestSfuOptions> | NestSfuOptions;
}

export interface NestSfuAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useExisting?: Type<NestSfuOptionsFactory>;
  useClass?: Type<NestSfuOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<NestSfuOptions> | NestSfuOptions;
}
