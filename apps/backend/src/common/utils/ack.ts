import type { Ack, AckResponse } from '@native-sfu/contracts';

export async function socketAck<T>(ack: Ack<T>, operation: () => Promise<T>): Promise<void> {
  try {
    ack({ ok: true, data: await operation() } as AckResponse<T>);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    ack({
      ok: false,
      error: {
        code: err.name || 'Error',
        message: err.message
      }
    });
  }
}
