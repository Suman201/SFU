import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { NestSfuModule } from '@native-sfu/nest-sfu';
import { AuthModule } from './auth/auth.module';
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
      load: [appConfig],
      validate: validateConfig
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('RATE_LIMIT_TTL', 60_000),
          limit: config.get<number>('RATE_LIMIT_MAX', 120)
        }
      ]
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        autoIndex: config.get<string>('NODE_ENV') !== 'production',
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
          onForwardedRtpPacket: (kind) => metrics.forwardedRtpPackets.labels(kind).inc(),
          onDroppedRtpPacket: (reason) => metrics.droppedRtpPackets.labels(reason).inc(),
          onReceiverReport: (roomId, participantId, report) => {
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
export class AppModule {}
