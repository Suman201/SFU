import { Injectable } from '@nestjs/common';
import type { IngestStatus } from '@native-sfu/contracts';
import type { IngestJobMongoDocument } from '../database/schemas';

const ACTIVE_STATUSES = new Set<IngestStatus>(['starting', 'live', 'restarting']);

@Injectable()
export class IngestSupervisorService {
  requestStart(job: IngestJobMongoDocument, at = new Date()): boolean {
    if (ACTIVE_STATUSES.has(job.status)) {
      return false;
    }
    job.status = 'starting';
    job.runtimeState = {
      ...(job.runtimeState ?? {}),
      lastStartedAt: at.toISOString()
    };
    return true;
  }

  requestStop(job: IngestJobMongoDocument, at = new Date()): boolean {
    if (job.status === 'stopped') {
      return false;
    }
    job.status = 'stopped';
    job.runtimeState = {
      ...(job.runtimeState ?? {}),
      lastStoppedAt: at.toISOString()
    };
    return true;
  }
}
