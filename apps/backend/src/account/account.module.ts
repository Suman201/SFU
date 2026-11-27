import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { EmailModule } from '../notifications/email.module';
import { AccountController, AccountEmailConfirmationController } from './account.controller';
import { AccountService } from './account.service';
import { AccountEmailService } from './account-email.service';
import { AccountEmailJob, AccountEmailJobSchema } from './account-email.schema';
@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule, ProfilesModule, EmailModule, MongooseModule.forFeature([{ name: AccountEmailJob.name, schema: AccountEmailJobSchema }])],
  controllers: [AccountController, AccountEmailConfirmationController], providers: [AccountService, AccountEmailService], exports: [AccountService],
})
export class AccountModule {}
