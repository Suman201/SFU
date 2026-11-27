import { DesktopDistributionController } from './desktop-distribution.controller';
import { DesktopDistributionService } from './desktop-distribution.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RecordingsModule } from '../recordings/recordings.module';
import { DesktopController } from './desktop.controller';
import { DesktopService } from './desktop.service';

@Module({
  imports: [AuthModule, DatabaseModule, RecordingsModule],
  controllers: [DesktopController, DesktopDistributionController],
  providers: [DesktopService, DesktopDistributionService]
})
export class DesktopModule {}
