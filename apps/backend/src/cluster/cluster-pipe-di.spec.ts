import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MediaService, NestSfuModule, PipeTransportService } from '@native-sfu/nest-sfu';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { ClusterModule } from './cluster.module';
import { PipeCoordinatorService } from './pipe-coordinator.service';

describe('ClusterModule pipe transport DI', () => {
  it('shares the injected PipeTransportService between the coordinator and media services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              app: { nodeEnv: 'test', publicUrl: 'http://127.0.0.1:3000' },
              cluster: {
                publicUrl: 'http://127.0.0.1:3000',
                heartbeatIntervalMs: 5000,
                ttlMs: 15000,
                preferLocalNode: true,
                maxRooms: 1000,
                maxTransports: 5000
              },
              pipe: {
                enabled: true,
                clusterSecret: 'test-pipe-cluster-secret-123456',
                advertiseIp: '127.0.0.1',
                portRange: { min: 41000, max: 41010 },
                coordinationTimeoutMs: 5000,
                coordinationMaxAttempts: 3,
                maxSetupRequestsPerMinute: 120
              },
              mediaWorker: {
                mode: 'in-process'
              }
            })
          ]
        }),
        NestSfuModule.forRoot({
          turnSecret: 'test-turn-secret-1234567890',
          turnUris: [],
          mediaWorkerMode: 'in-process',
          enablePipeTransport: true,
          pipeAdvertiseIp: '127.0.0.1',
          pipePortRange: { min: 41000, max: 41010 },
          hostCandidatePortRange: { min: 40000, max: 40010 }
        }),
        ClusterModule
      ]
    })
      .overrideProvider(RedisService)
      .useValue({
        raw: {
          sadd: jest.fn(),
          set: jest.fn(),
          smembers: jest.fn(async () => []),
          srem: jest.fn()
        },
        publishDurable: jest.fn(),
        consumeDurable: jest.fn(),
        setJson: jest.fn(),
        getJson: jest.fn(),
        publish: jest.fn()
      })
      .overrideProvider(MetricsService)
      .useValue({})
      .compile();

    const coordinator = moduleRef.get(PipeCoordinatorService);
    const media = moduleRef.get(MediaService);
    const pipe = moduleRef.get(PipeTransportService);

    expect((coordinator as unknown as { pipe: PipeTransportService }).pipe).toBe(pipe);
    expect((media as unknown as { pipe: PipeTransportService }).pipe).toBe(pipe);

    await moduleRef.close();
  });
});
