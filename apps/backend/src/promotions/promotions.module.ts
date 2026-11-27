import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseModule } from '../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { PromotionCommerceService } from './promotion-commerce.service';
import { PromotionStripeGateway } from './promotion-stripe.gateway';
import { PROMOTION_MODELS } from './promotion.schema';
import { PromotionAnalyticsModule } from './promotion-analytics.module';
import { AdminPromotionCommerceController, PublicPromotionCommerceController, TeacherPromotionCommerceController } from './promotion.controller';
@Module({ imports: [DatabaseModule, AuditLogsModule, AuthModule, PaymentsModule, PromotionAnalyticsModule, MongooseModule.forFeature(PROMOTION_MODELS)], providers: [PromotionCommerceService, PromotionStripeGateway], exports: [PromotionStripeGateway], controllers: [AdminPromotionCommerceController, PublicPromotionCommerceController, TeacherPromotionCommerceController] })
export class PromotionsModule {}
