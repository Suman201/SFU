import 'reflect-metadata';
import helmet from 'helmet';
import { BadRequestException, RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  const allowedOrigins = config.get<string[]>('cors.allowedOrigins', ['http://localhost:4200']);

  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: allowedOrigins,
    credentials: true
  });
  app.setGlobalPrefix('api', {
    exclude: [
      { path: config.get<string>('metrics.path', 'metrics'), method: RequestMethod.GET },
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/db', method: RequestMethod.GET },
      { path: 'health/redis', method: RequestMethod.GET }
    ]
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

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(config.get<string>('swagger.title', 'EduConnect Live Backend API'))
      .setDescription('REST API for rooms, auth, recordings, and metrics.')
      .setVersion(config.get<string>('swagger.version', '0.1.0'))
      .addBearerAuth()
      .build()
  );
  SwaggerModule.setup(config.get<string>('swagger.path', 'api/docs'), app, document);

  const port = config.get<number>('app.port', 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
