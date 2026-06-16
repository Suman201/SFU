import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaController } from './media.controller';

@Module({
  imports: [AuthModule],
  controllers: [MediaController]
})
export class MediaApiModule {}
