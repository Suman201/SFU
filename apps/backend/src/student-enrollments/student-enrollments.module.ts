import { MongooseModule } from '@nestjs/mongoose';
import { PaymentDocument, PaymentSchema } from '../payments/payment.schemas';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../database/database.module';
import { AdminEnrollmentsController } from './admin-enrollments.controller';
import { StudentEnrollmentsController } from './student-enrollments.controller';
import { StudentEnrollmentsService } from './student-enrollments.service';

@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule, MongooseModule.forFeature([{ name: PaymentDocument.name, schema: PaymentSchema }])],
  controllers: [StudentEnrollmentsController, AdminEnrollmentsController],
  providers: [StudentEnrollmentsService],
  exports: [StudentEnrollmentsService]
})
export class StudentEnrollmentsModule {}
