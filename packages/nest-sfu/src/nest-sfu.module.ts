import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { AudioLevelObserver, BandwidthEstimator, RtcpProcessor, RtpRouter, SimulcastSelector } from '@native-sfu/sfu-core';
import { DtlsService } from './dtls.service';
import { IceService } from './ice.service';
import { MediaService } from './media.service';
import { NestSfuAsyncOptions, NestSfuOptions, NestSfuOptionsFactory } from './nest-sfu.options';
import { SrtpService } from './srtp.service';
import { NEST_SFU_OPTIONS } from './tokens';
import { UdpPortAllocator } from './ice/udp-port-allocator';

const exportedProviders = [MediaService, IceService, DtlsService, SrtpService, RtpRouter, RtcpProcessor, SimulcastSelector, BandwidthEstimator, AudioLevelObserver];

@Global()
@Module({})
export class NestSfuModule {
  static forRoot(options: NestSfuOptions): DynamicModule {
    return {
      module: NestSfuModule,
      providers: [optionsProvider(options), ...coreProviders()],
      exports: exportedProviders
    };
  }

  static forRootAsync(options: NestSfuAsyncOptions): DynamicModule {
    return {
      module: NestSfuModule,
      imports: options.imports ?? [],
      providers: [...asyncOptionsProviders(options), ...coreProviders()],
      exports: exportedProviders
    };
  }
}

function optionsProvider(options: NestSfuOptions): Provider {
  return {
    provide: NEST_SFU_OPTIONS,
    useValue: options
  };
}

function asyncOptionsProviders(options: NestSfuAsyncOptions): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: NEST_SFU_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? []
      }
    ];
  }
  const inject = options.useExisting ?? options.useClass;
  if (!inject) {
    throw new Error('NestSfuModule.forRootAsync requires useFactory, useClass, or useExisting');
  }
  const providers: Provider[] = [
    {
      provide: NEST_SFU_OPTIONS,
      useFactory: async (factory: NestSfuOptionsFactory) => factory.createNestSfuOptions(),
      inject: [inject]
    }
  ];
  if (options.useClass) {
    providers.push({ provide: options.useClass, useClass: options.useClass });
  }
  return providers;
}

function coreProviders(): Provider[] {
  return [
    MediaService,
    IceService,
    DtlsService,
    SrtpService,
    {
      provide: UdpPortAllocator,
      inject: [NEST_SFU_OPTIONS],
      useFactory: (options: NestSfuOptions) => {
        const range = options.hostCandidatePortRange ?? {
          min: options.hostCandidatePort ?? 40000,
          max: options.hostCandidatePort ?? 40000
        };
        return new UdpPortAllocator(range.min, range.max);
      }
    },
    {
      provide: RtpRouter,
      inject: [NEST_SFU_OPTIONS],
      useFactory: (options: NestSfuOptions) =>
        new RtpRouter({
          onForwardedPacket: (kind) => options.metrics?.onForwardedRtpPacket?.(kind),
          onDroppedPacket: (reason) => options.metrics?.onDroppedRtpPacket?.(reason),
          onBufferedPacket: (ssrc, sequenceNumber) => options.metrics?.onBufferedRtpPacket?.(ssrc, sequenceNumber),
          onStreamRestart: (producerId, ssrc) => options.metrics?.onRtpStreamRestart?.(producerId, ssrc),
          onForwardedRtcpPacket: (kind, direction) => options.metrics?.onForwardedRtcpPacket?.(kind, direction),
          onDroppedRtcpPacket: (reason) => options.metrics?.onDroppedRtcpPacket?.(reason),
          onRetransmittedPacket: (kind) => options.metrics?.onRetransmittedRtpPacket?.(kind),
          onRetransmissionMiss: (ssrc, sequenceNumber) => options.metrics?.onRetransmissionMiss?.(ssrc, sequenceNumber),
          onKeyframeRequestForwarded: (producerId, feedbackKind) => options.metrics?.onKeyframeRequestForwarded?.(producerId, feedbackKind),
          onKeyframeRequestCoalesced: (producerId, feedbackKind) => options.metrics?.onKeyframeRequestCoalesced?.(producerId, feedbackKind),
          onTwccPacketArrival: (id, sequenceNumber, direction) => options.metrics?.onTwccPacketArrival?.(id, sequenceNumber, direction),
          onTwccFeedback: (consumerId, feedback) => options.metrics?.onTwccFeedback?.(consumerId, feedback),
          onBandwidthEstimate: (id, estimate) => options.metrics?.onBandwidthEstimate?.(id, estimate),
          onPacingQueueDepth: (snapshot) => options.metrics?.onPacingQueueDepth?.(snapshot),
          onKeyframeDetected: (producerId, ssrc, codec) => options.metrics?.onKeyframeDetected?.(producerId, ssrc, codec),
          onKeyframeGateOpened: (consumerId, producerId) => options.metrics?.onKeyframeGateOpened?.(consumerId, producerId),
          onKeyframeGateDropped: (consumerId, producerId) => options.metrics?.onKeyframeGateDropped?.(consumerId, producerId),
          onProducerLayerActive: (producerId, layer) => options.metrics?.onProducerLayerActive?.(producerId, layer),
          onConsumerLayersChanged: (consumerId, layers) => options.metrics?.onConsumerLayersChanged?.(consumerId, layers),
          onLayerSwitch: (consumerId, producerId, from, to) => options.metrics?.onLayerSwitch?.(consumerId, producerId, from, to),
          onLayerSwitchFailed: (consumerId, producerId, target, reason) => options.metrics?.onLayerSwitchFailed?.(consumerId, producerId, target, reason),
          retransmissionCacheSize: options.rtpRetransmissionCacheSize,
          keyframeRequestIntervalMs: options.keyframeRequestIntervalMs,
          maxReorderPackets: options.maxRtpReorderPackets,
          restartSequenceGap: options.rtpRestartSequenceGap,
          duplicateWindowSize: options.rtpDuplicateWindowSize,
          enableTwcc: options.enableTwcc,
          enablePacing: options.enablePacing,
          enableJoinKeyframeGate: options.enableJoinKeyframeGate,
          enableAdaptiveLayerSelection: options.enableAdaptiveLayerSelection,
          defaultPacingBitrateBps: options.defaultPacingBitrateBps,
          maxPacingQueueBytes: options.maxPacingQueueBytes,
          twccFeedbackIntervalMs: options.twccFeedbackIntervalMs
        })
    },
    {
      provide: RtcpProcessor,
      inject: [NEST_SFU_OPTIONS],
      useFactory: (options: NestSfuOptions) =>
        new RtcpProcessor({
          onSenderReport: (roomId, participantId, report) => options.metrics?.onSenderReport?.(roomId, participantId, report),
          onReceiverReport: (roomId, participantId, report) => options.metrics?.onReceiverReport?.(roomId, participantId, report),
          onNack: (roomId, participantId, feedback) => options.metrics?.onNack?.(roomId, participantId, feedback),
          onPli: (roomId, participantId, feedback) => options.metrics?.onPli?.(roomId, participantId, feedback),
          onFir: (roomId, participantId, feedback) => options.metrics?.onFir?.(roomId, participantId, feedback),
          onRemb: (roomId, participantId, feedback) => options.metrics?.onRemb?.(roomId, participantId, feedback),
          onTwcc: (roomId, participantId, feedback) => options.metrics?.onTwcc?.(roomId, participantId, feedback)
        })
    },
    { provide: SimulcastSelector, useFactory: () => new SimulcastSelector() },
    { provide: BandwidthEstimator, useFactory: () => new BandwidthEstimator() },
    { provide: AudioLevelObserver, useFactory: () => new AudioLevelObserver() }
  ];
}
