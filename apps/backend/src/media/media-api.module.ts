import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperationsTokenGuard } from '../common/guards/operations-token.guard';
import { EventsModule } from '../events/events.module';
import { RoomsModule } from '../rooms/rooms.module';
import { MediaController } from './media.controller';

@Module({
  imports: [AuthModule, RoomsModule, EventsModule],
  controllers: [MediaController],
  providers: [OperationsTokenGuard]
})
export class MediaApiModule {}
