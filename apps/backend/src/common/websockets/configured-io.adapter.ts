import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';

export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: ConfigService
  ) {
    super(app);
  }

  override createIOServer(port: number, options: Record<string, unknown> = {}): unknown {
    return super.createIOServer(port, {
      ...options,
      maxHttpBufferSize: this.config.get<number>('security.socketMaxPayloadBytes', 1_048_576),
      cors: {
        origin: this.config.get<string[]>('cors.allowedOrigins', ['http://localhost:4200']),
        credentials: true
      }
    });
  }
}
