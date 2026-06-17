import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { buildPublicRouteExclusions } from '../src/bootstrap/public-routes';

@Controller('health')
class HealthRoutesController {
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return { status: 'ready' };
  }
}

@Controller()
class MetricsRoutesController {
  @Get('metrics')
  metrics() {
    return '# HELP sfu_test_metric Test metric\n';
  }
}

describe('Bootstrap public route exclusions (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthRoutesController, MetricsRoutesController]
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', {
      exclude: buildPublicRouteExclusions('metrics')
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps /health/live outside the API prefix', async () => {
    const routes = collectRoutePaths(app);

    expect(routes).toContain('/health/live');
    expect(routes).not.toContain('/api/health/live');
  });

  it('keeps /health/ready outside the API prefix', async () => {
    const routes = collectRoutePaths(app);

    expect(routes).toContain('/health/ready');
    expect(routes).not.toContain('/api/health/ready');
  });

  it('keeps /metrics outside the API prefix', async () => {
    const routes = collectRoutePaths(app);

    expect(routes).toContain('/metrics');
    expect(routes).not.toContain('/api/metrics');
  });
});

function collectRoutePaths(app: INestApplication): string[] {
  const httpApp = app.getHttpAdapter().getInstance() as {
    router?: { stack?: Array<{ route?: { path?: string | string[] }; handle?: { stack?: unknown[] } }> };
    _router?: { stack?: Array<{ route?: { path?: string | string[] }; handle?: { stack?: unknown[] } }> };
  };
  const routes = new Set<string>();

  const visit = (stack: Array<{ route?: { path?: string | string[] }; handle?: { stack?: unknown[] } }> | undefined) => {
    for (const layer of stack ?? []) {
      const routePath = layer.route?.path;
      if (Array.isArray(routePath)) {
        for (const path of routePath) {
          routes.add(normalizePath(path));
        }
      } else if (typeof routePath === 'string') {
        routes.add(normalizePath(routePath));
      }
      if (Array.isArray(layer.handle?.stack)) {
        visit(layer.handle.stack as Array<{ route?: { path?: string | string[] }; handle?: { stack?: unknown[] } }>);
      }
    }
  };

  visit(httpApp.router?.stack ?? httpApp._router?.stack);
  return [...routes];
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
