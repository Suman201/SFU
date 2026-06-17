import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { MediaService } from '@native-sfu/nest-sfu';
import { PipeCoordinatorService } from '../cluster/pipe-coordinator.service';
import { NodeRegistryService } from '../cluster/node-registry.service';
import { MetricsService } from './metrics.service';

@Controller({ version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly media: MediaService,
    private readonly pipe: PipeCoordinatorService,
    private readonly cluster: NodeRegistryService
  ) {}

  @Get('/metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prometheus(): Promise<string> {
    await this.safeRefresh('cluster', async () => {
      const clusterSnapshot = await this.cluster.snapshot();
      this.metrics.refreshClusterSnapshot(clusterSnapshot);
    });
    await this.safeRefresh('pipe', async () => {
      const pipeSnapshot = this.pipe.snapshot();
      const pipeHealthSnapshot = this.pipe.healthSnapshot();
      this.metrics.refreshPipeSnapshot(pipeSnapshot, pipeHealthSnapshot);
    });
    await this.safeRefresh('media_workers', async () => {
      this.metrics.refreshMediaWorkerSnapshot(this.media.workerPoolSnapshot());
    });
    return this.metrics.text();
  }

  private async safeRefresh(component: 'cluster' | 'pipe' | 'media_workers', operation: () => Promise<void> | void): Promise<void> {
    try {
      await operation();
      this.metrics.markRefreshStatus(component, true);
    } catch {
      this.metrics.markRefreshStatus(component, false);
    }
  }
}
