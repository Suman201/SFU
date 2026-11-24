import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { CurrenciesController } from './currencies.controller';
import { CurrenciesService } from './currencies.service';

@Module({ imports: [AuthModule, DatabaseModule, RedisModule], controllers: [CurrenciesController], providers: [CurrenciesService] })
export class CurrenciesModule {}
