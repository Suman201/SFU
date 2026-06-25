import 'reflect-metadata';
import helmet from 'helmet';
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildPublicRouteExclusions } from './bootstrap/public-routes';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { operationsTokenMatches } from './common/guards/operations-token.guard';
import { SuccessResponseInterceptor } from './common/interceptors/success-response.interceptor';
import { MetricsController } from './metrics/metrics.controller';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  const allowedOrigins = config.get<string[]>('cors.allowedOrigins', ['http://localhost:4200']);
  const nodeEnv = config.get<string>('app.nodeEnv', 'development');

  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: allowedOrigins,
    credentials: true
  });
  const metricsPath = config.get<string>('metrics.path', 'metrics');
  app.setGlobalPrefix('api', {
    exclude: buildPublicRouteExclusions(metricsPath)
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1'
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new BadRequestException(errors.map((error) => ({
        property: error.property,
        constraints: error.constraints ?? {},
        children: error.children ?? []
      })))
    })
  );
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost)));
  app.useGlobalInterceptors(new SuccessResponseInterceptor());

  if (config.get<boolean>('swagger.enabled', true)) {
    const swaggerPath = config.get<string>('swagger.path', 'api/docs');
    if (nodeEnv === 'production') {
      installSwaggerOperationsTokenProtection(app, swaggerPath, config.getOrThrow<string>('security.operationsToken'));
    }
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle(config.get<string>('swagger.title', 'EduConnect Live Backend API'))
        .setDescription('REST API for rooms, auth, recordings, and metrics.')
        .setVersion(config.get<string>('swagger.version', '0.1.0'))
        .addBearerAuth()
        .build()
    );
    SwaggerModule.setup(swaggerPath, app, document);
  }

  const port = config.get<number>('app.port', 3000);
  if (config.get<boolean>('metrics.enabled', true) && normalizeOperationalPath(metricsPath) !== 'metrics') {
    const metricsController = app.get(MetricsController, { strict: false });
    app.getHttpAdapter().getInstance().get(`/${normalizeOperationalPath(metricsPath)}`, async (
      req: { headers?: Record<string, string | string[] | undefined> },
      res: { status: (code: number) => { send: (body: string) => void }; setHeader: (name: string, value: string) => void; send: (body: string) => void }
    ) => {
      const configuredOperationsToken = config.get<string | undefined>('security.operationsToken')?.trim();
      const requestOperationsToken = normalizeHeaderValue(req.headers?.['x-operations-token']);
      if (configuredOperationsToken && !operationsTokenMatches(requestOperationsToken, configuredOperationsToken)) {
        res.status(401).send('Missing or invalid operations token');
        return;
      }
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(await metricsController.prometheus());
    });
  }
  await app.listen(port, '0.0.0.0');
}

void bootstrap();

function normalizeOperationalPath(path: string): string {
  const normalized = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : 'metrics';
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim();
  }
  return value?.trim();
}

function installSwaggerOperationsTokenProtection(
  app: {
    getHttpAdapter: () => {
      getInstance: () => {
        use: (handler: (
          req: { path?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
          res: { status: (code: number) => { send: (body: string) => void } },
          next: () => void
        ) => void) => void
      }
    }
  },
  swaggerPath: string,
  operationsToken: string
): void {
  const protectedPath = `/${normalizeOperationalPath(swaggerPath)}`;
  const protectedJsonPath = `${protectedPath}-json`;
  const protectedYamlPath = `${protectedPath}-yaml`;
  app.getHttpAdapter().getInstance().use((
    req: { path?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
    res: { status: (code: number) => { send: (body: string) => void } },
    next: () => void
  ) => {
    const requestPath = normalizeRequestPath(req.path ?? req.url ?? '/');
    if (
      requestPath === protectedPath ||
      requestPath.startsWith(`${protectedPath}/`) ||
      requestPath === protectedJsonPath ||
      requestPath === protectedYamlPath
    ) {
      const requestOperationsToken = normalizeHeaderValue(req.headers?.['x-operations-token']);
      if (!operationsTokenMatches(requestOperationsToken, operationsToken)) {
        res.status(401).send('Missing or invalid operations token');
        return;
      }
    }
    next();
  });
}

function normalizeRequestPath(path: string): string {
  const base = path.split('?')[0] ?? '/';
  return base.startsWith('/') ? base : `/${base}`;
}
