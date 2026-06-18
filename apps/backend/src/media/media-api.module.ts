import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { MediaController } from './media.controller';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [OperationsTokenGuard]
})
export class MediaApiModule {}
