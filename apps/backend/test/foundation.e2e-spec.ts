import { BadRequestException, Body, Controller, Get, INestApplication, Post, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { LoginDto } from '../src/auth/dto/auth.dto';

@Controller('auth')
class TestAuthController {
  @Post('login')
  login(@Body() _body: LoginDto) {
    return { ok: true };
  }
}

@Controller('health')
class TestHealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }

  @Get('db')
  db() {
    return { status: 'ok', info: { mongodb: { status: 'up' } } };
  }

  @Get('redis')
  redis() {
    return { status: 'ok', info: { redis: { status: 'up' } } };
  }
}

@Controller()
class TestMetricsController {
  @Get('metrics')
  metrics() {
    return '# HELP nodejs_version_info Node.js version info\n';
  }
}

describe('Phase 1 foundation integration (e2e)', () => {
  let app: INestApplication;
  let swaggerDocument: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestAuthController, TestHealthController, TestMetricsController]
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'metrics', method: RequestMethod.GET },
        { path: 'health', method: RequestMethod.GET },
        { path: 'health/db', method: RequestMethod.GET },
        { path: 'health/redis', method: RequestMethod.GET }
      ]
    });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new BadRequestException(errors.map((error) => ({
        property: error.property,
        constraints: error.constraints ?? {}
      })))
    }));
    swaggerDocument = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('EduConnect Live Backend API').setVersion('0.1.0').addBearerAuth().build()
    );
    SwaggerModule.setup('api/docs', app, swaggerDocument);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts the Nest application and creates Swagger metadata', () => {
    expect(app.getHttpAdapter()).toBeDefined();
    expect(swaggerDocument.info.title).toBe('EduConnect Live Backend API');
    expect(swaggerDocument.components?.securitySchemes?.bearer).toBeDefined();
  });

  it('keeps health and metrics routes outside the API prefix contract', () => {
    const health = new TestHealthController();
    const metrics = new TestMetricsController();
    const dbHealth = health.db();
    const redisHealth = health.redis();

    expect(health.health()).toEqual({ status: 'ok' });
    expect(dbHealth.info.mongodb.status).toBe('up');
    expect(redisHealth.info.redis.status).toBe('up');
    expect(metrics.metrics()).toContain('nodejs_version_info');
  });

  it('formats validation errors with the global exception filter contract', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new BadRequestException(errors.map((error) => ({
        property: error.property,
        constraints: error.constraints ?? {}
      })))
    });
    const exception = await pipe.transform(
      { email: 'bad', password: 'short', unexpected: true },
      { type: 'body', metatype: LoginDto }
    ).catch((error: unknown) => error);
    const response = { statusCode: 0, body: undefined as unknown };
    const filter = new GlobalExceptionFilter({
      httpAdapter: {
        reply: (_res: unknown, body: unknown, statusCode: number) => {
          response.statusCode = statusCode;
          response.body = body;
        }
      }
    } as never);

    filter.catch(exception, {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/api/v1/auth/login', id: 'test-request-id', header: () => 'test-request-id' }),
        getResponse: () => ({})
      })
    } as never);

    expect(response.statusCode).toBe(400);
    const body = response.body as any;
    expect(body.success).toBe(false);
    expect(body.message).toBe('Validation failed');
    expect(body.statusCode).toBe(400);
    expect(body.path).toBe('/api/v1/auth/login');
    expect(body.requestId).toBe('test-request-id');
  });
});
