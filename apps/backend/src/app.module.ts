import { randomUUID } from 'node:crypto';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { NestSfuModule } from '@native-sfu/nest-sfu';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { appConfig } from './config/app.config';
import { validateConfig } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MediaApiModule } from './media/media-api.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsService } from './metrics/metrics.service';
import { RedisModule } from './redis/redis.module';
import { RecordingsModule } from './recordings/recordings.module';
import { RoomsModule } from './rooms/rooms.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      load: [appConfig],
      validate: validateConfig
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('app.nodeEnv') === 'production' ? 'info' : 'debug',
          transport: config.get<string>('app.nodeEnv') === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
          genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
          customProps: (request) => ({ requestId: String((request as { id?: string | number }).id ?? '') }),
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']
        }
      })
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('security.rateLimitTtl', 60),
          limit: config.get<number>('security.rateLimitMax', 120)
        }
      ]
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('database.uri'),
        autoIndex: config.get<string>('app.nodeEnv') !== 'production',
        serverSelectionTimeoutMS: 10_000
      })
    }),
    DatabaseModule,
    RedisModule,
    MetricsModule,
    NestSfuModule.forRootAsync({
      imports: [ConfigModule, MetricsModule],
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) => ({
        turnSecret: config.getOrThrow<string>('TURN_SECRET'),
        turnUris: config.get<string[]>('turn.uris') ?? [],
        hostCandidatePortRange: { min: 40000, max: 40100 },
        turnCredentialTtlSeconds: 3600,
        metrics: {
          onForwardedRtpPacket: (kind: string) => metrics.forwardedRtpPackets.labels(kind).inc(),
          onDroppedRtpPacket: (reason: string) => metrics.droppedRtpPackets.labels(reason).inc(),
          onReceiverReport: (roomId: string, participantId: string, report: { fractionLost: number; jitter: number }) => {
            metrics.packetLoss.labels(roomId, participantId).set(report.fractionLost);
            metrics.jitter.labels(roomId, participantId).set(report.jitter);
          }
        }
      })
    }),
    AuthModule,
    RoomsModule,
    MediaApiModule,
    RecordingsModule,
    HealthModule
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
