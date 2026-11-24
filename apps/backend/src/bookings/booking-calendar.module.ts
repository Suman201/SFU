import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseModule } from '../database/database.module';
import {
  BookingCalendarLockDocument,
  BookingCalendarLockSchema,
  LessonSlotDocument,
  LessonSlotSchema,
} from './booking.schema';
import { BookingCalendarService } from './booking-calendar.service';
@Module({
  imports: [
    DatabaseModule,
    MongooseModule.forFeature([
      {
        name: BookingCalendarLockDocument.name,
        schema: BookingCalendarLockSchema,
      },
      { name: LessonSlotDocument.name, schema: LessonSlotSchema },
    ]),
  ],
  providers: [BookingCalendarService],
  exports: [BookingCalendarService],
})
export class BookingCalendarModule {}
