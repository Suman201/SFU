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
          onDroppedPacket: (reason) => options.metrics?.onDroppedRtpPacket?.(reason)
        })
    },
    {
      provide: RtcpProcessor,
      inject: [NEST_SFU_OPTIONS],
      useFactory: (options: NestSfuOptions) =>
        new RtcpProcessor({
          onReceiverReport: (roomId, participantId, report) => options.metrics?.onReceiverReport?.(roomId, participantId, report)
        })
    },
    { provide: SimulcastSelector, useFactory: () => new SimulcastSelector() },
    { provide: BandwidthEstimator, useFactory: () => new BandwidthEstimator() },
    { provide: AudioLevelObserver, useFactory: () => new AudioLevelObserver() }
  ];
}
