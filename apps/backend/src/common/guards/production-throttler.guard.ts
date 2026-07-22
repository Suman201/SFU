import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
  getOptionsToken,
  getStorageToken
} from '@nestjs/throttler';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class ProductionThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly metrics: MetricsService
  ) {
    super(options, storage, reflector);
  }

  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return Promise.resolve(true);
    }
    return super.canActivate(context);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    const controller = context.getClass().name || 'unknown';
    const handler = context.getHandler().name || 'unknown';
    this.metrics.rateLimitRejections.labels('http', `${controller}.${handler}`).inc();
    await super.throwThrottlingException(context, detail);
  }
}
