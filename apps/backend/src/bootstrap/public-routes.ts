import { RequestMethod } from '@nestjs/common';

export interface PublicRouteExclusion {
  path: string;
  method: RequestMethod;
}

export function buildPublicRouteExclusions(metricsPath = 'metrics'): PublicRouteExclusion[] {
  const normalizedMetricsPath = normalizeRoutePath(metricsPath);
  const exclusions: PublicRouteExclusion[] = [
    { path: 'health', method: RequestMethod.GET },
    { path: 'health/live', method: RequestMethod.GET },
    { path: 'health/ready', method: RequestMethod.GET },
    { path: 'health/db', method: RequestMethod.GET },
    { path: 'health/redis', method: RequestMethod.GET },
    { path: 'metrics', method: RequestMethod.GET }
  ];
  if (normalizedMetricsPath !== 'metrics') {
    exclusions.push({ path: normalizedMetricsPath, method: RequestMethod.GET });
  }
  return exclusions;
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : 'metrics';
}
