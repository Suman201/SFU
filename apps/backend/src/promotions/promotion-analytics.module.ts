import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseModule } from '../database/database.module';
import { PromotionAnalyticsDaily, PromotionAnalyticsDailySchema, PromotionAnalyticsEvent, PromotionAnalyticsEventSchema } from './promotion.schema';
import { PromotionAnalyticsService } from './promotion-analytics.service';
@Module({ imports: [DatabaseModule, MongooseModule.forFeature([{ name: PromotionAnalyticsDaily.name, schema: PromotionAnalyticsDailySchema }, { name: PromotionAnalyticsEvent.name, schema: PromotionAnalyticsEventSchema }])], providers: [PromotionAnalyticsService], exports: [PromotionAnalyticsService] })
export class PromotionAnalyticsModule {}
