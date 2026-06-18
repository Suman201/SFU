import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { NestSfuModule } from '@native-sfu/nest-sfu';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { appConfig } from './config/app.config';
import { validateConfig } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MediaApiModule } from './media/media-api.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsService } from './metrics/metrics.service';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';
import { ClusterModule } from './cluster/cluster.module';
import { PermissionsModule } from './permissions/permissions.module';
import { RbacModule } from './rbac/rbac.module';
import { RolesModule } from './roles/roles.module';
import { SessionsModule } from './sessions/sessions.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        `.env.${process.env.NODE_ENV ?? 'development'}.local`,
        `.env.${process.env.NODE_ENV ?? 'development'}`,
        '.env.local',
        '.env',
        `../../.env.${process.env.NODE_ENV ?? 'development'}`,
        '../../.env'
      ],
      load: [appConfig],
      validate: validateConfig
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('app.nodeEnv') === 'production' ? 'info' : 'debug',
          transport: config.get<string>('app.nodeEnv') === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
          genReqId: (request: IncomingMessage) => request.headers['x-request-id']?.toString() ?? randomUUID(),
          customProps: (request: IncomingMessage) => ({ requestId: String((request as { id?: string | number }).id ?? '') }),
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
    ClusterModule,
    NestSfuModule.forRootAsync({
      imports: [ConfigModule, MetricsModule],
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) => ({
        turnSecret: config.getOrThrow<string>('TURN_SECRET'),
        turnUris: config.get<string[]>('turn.uris') ?? [],
        mediaWorkerMode: config.get<'in-process' | 'worker'>('mediaWorker.mode', 'in-process'),
        mediaWorkerCount: config.get<number>('mediaWorker.count', 1),
        mediaWorkerRequestTimeoutMs: config.get<number>('mediaWorker.requestTimeoutMs', 5000),
        mediaWorkerStartupTimeoutMs: config.get<number>('mediaWorker.startupTimeoutMs', 10000),
        mediaWorkerHeartbeatIntervalMs: config.get<number>('mediaWorker.heartbeatIntervalMs', 2000),
        mediaWorkerHeartbeatTimeoutMs: config.get<number>('mediaWorker.heartbeatTimeoutMs', 6000),
        mediaWorkerRestartBackoffMs: config.get<number>('mediaWorker.restartBackoffMs', 1000),
        mediaWorkerDrainTimeoutMs: config.get<number>('mediaWorker.drainTimeoutMs', 30000),
        mediaWorkerMaxRoomsPerWorker: config.get<number>('mediaWorker.maxRoomsPerWorker', 100),
        mediaWorkerMaxTransportsPerWorker: config.get<number>('mediaWorker.maxTransportsPerWorker', 500),
        mediaWorkerMaxInFlightRequestsPerWorker: config.get<number>('mediaWorker.maxInFlightRequestsPerWorker', 1000),
        mediaWorkerSoftIpcLatencyMs: config.get<number>('mediaWorker.softIpcLatencyMs', 100),
        mediaWorkerHardIpcLatencyMs: config.get<number>('mediaWorker.hardIpcLatencyMs', 1000),
        mediaWorkerSoftMemoryLimitBytes: config.get<number | undefined>('mediaWorker.softMemoryLimitBytes'),
        mediaWorkerHardMemoryLimitBytes: config.get<number | undefined>('mediaWorker.hardMemoryLimitBytes'),
        mediaWorkerSoftRtpPacketRate: config.get<number>('mediaWorker.softRtpPacketRate', 50000),
        mediaWorkerSoftRtcpPacketRate: config.get<number>('mediaWorker.softRtcpPacketRate', 5000),
        hostCandidatePortRange: config.get<{ min: number; max: number }>('mediaWorker.hostCandidatePortRange', { min: 40000, max: 40100 }),
        turnCredentialTtlSeconds: 3600,
        enablePipeTransport: config.get<boolean>('pipe.enabled', false),
        pipePortRange: config.get<{ min: number; max: number }>('pipe.portRange'),
        pipeAdvertiseIp: config.get<string>('pipe.advertiseIp'),
        metrics: {
          onForwardedRtpPacket: (kind) => metrics.forwardedRtpPackets.labels(kind).inc(),
          onDroppedRtpPacket: (reason) => metrics.droppedRtpPackets.labels(reason).inc(),
          onPipeRtpPacket: (direction, bytes) => {
            metrics.pipeRtpPackets.labels(direction).inc();
            metrics.pipeRtpBytes.labels(direction).inc(bytes);
          },
          onPipeRtcpPacket: (direction, bytes) => {
            metrics.pipeRtcpPackets.labels(direction).inc();
            metrics.pipeRtcpBytes.labels(direction).inc(bytes);
          },
          onPipeBackpressure: (transportId) => metrics.pipeBackpressureEvents.labels(transportId).inc(),
          onPipeDrop: (reason) => metrics.pipeErrors.labels(reason).inc(),
          onMediaWorkerIpcRequest: (operation, status, durationMs) => {
            metrics.mediaWorkerIpcRequests.labels(operation, status).inc();
            metrics.mediaWorkerIpcLatency.labels(operation).observe(durationMs);
          },
          onMediaWorkerCrash: (workerId, reason) => {
            metrics.mediaWorkerCrashes.labels(workerId, reason).inc();
          },
          onMediaWorkerRestart: (workerId, reason) => {
            metrics.mediaWorkerRestarts.labels(workerId, reason).inc();
          },
          onMediaWorkerDrain: (workerId, state) => {
            metrics.mediaWorkerDrains.labels(workerId, state).inc();
          },
          onReceiverReport: (roomId, participantId, report) => {
            metrics.packetLoss.labels(roomId, participantId).set(report.fractionLost);
            metrics.jitter.labels(roomId, participantId).set(report.jitter);
          }
        }
      })
    }),
    AuditLogsModule,
    RbacModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PermissionsModule,
    SessionsModule,
    RoomsModule,
    MediaApiModule,
    HealthModule
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
