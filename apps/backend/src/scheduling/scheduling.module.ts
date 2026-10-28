import { GoogleCalendarService } from './google-calendar.service';
import {
  GoogleCalendarController,
  GoogleCalendarCallbackController,
} from './google-calendar.controller';
import {
  GoogleCalendarConnectionDocument,
  GoogleCalendarConnectionSchema,
  GoogleCalendarStateDocument,
  GoogleCalendarStateSchema,
  GoogleCalendarMappingDocument,
  GoogleCalendarMappingSchema,
} from './google-calendar.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { ClassCommunicationsService } from './class-communications.service';
import {
  CalendarNoticeDocument,
  CalendarNoticeSchema,
} from './calendar-notice.schema';
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    NotificationsModule,
    MongooseModule.forFeature([
      {
        name: GoogleCalendarConnectionDocument.name,
        schema: GoogleCalendarConnectionSchema,
      },
      {
        name: GoogleCalendarStateDocument.name,
        schema: GoogleCalendarStateSchema,
      },
      {
        name: GoogleCalendarMappingDocument.name,
        schema: GoogleCalendarMappingSchema,
      },
      { name: CalendarNoticeDocument.name, schema: CalendarNoticeSchema },
    ]),
  ],
  controllers: [
    CalendarController,
    GoogleCalendarController,
    GoogleCalendarCallbackController,
  ],
  providers: [
    CalendarService,
    ClassCommunicationsService,
    GoogleCalendarService,
  ],
})
export class SchedulingModule {}
