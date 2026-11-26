import { MongooseModule } from '@nestjs/mongoose';
import { SocialAuthFlow, SocialAuthFlowSchema } from './social-auth.schema';
import { SocialOAuthClient } from './social-oauth.client';
import { SocialAuthService } from './social-auth.service';
import { SocialAuthController } from './social-auth.controller';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [JwtModule.register({}), MongooseModule.forFeature([{ name: SocialAuthFlow.name, schema: SocialAuthFlowSchema }]), DatabaseModule, AuditLogsModule],
  controllers: [AuthController, SocialAuthController],
  providers: [AuthService, JwtAuthGuard, SocialOAuthClient, SocialAuthService],
  exports: [AuthService, JwtAuthGuard]
})
export class AuthModule {}
