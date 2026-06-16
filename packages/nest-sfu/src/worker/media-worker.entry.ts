import { MediaWorkerRunner } from './media-worker-runner';
import { serializeError } from './ipc';

try {
  new MediaWorkerRunner().start();
} catch (error) {
  if (process.send) {
    process.send({
      kind: 'event',
      event: {
        type: 'error',
        workerId: process.env.MEDIA_WORKER_ID ?? `media-worker-${process.pid}`,
        error: serializeError(error)
      }
    });
  }
  setTimeout(() => process.exit(1), 10).unref();
}
