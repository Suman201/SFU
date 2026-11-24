import { BadRequestException, Body, Controller, Get, NotFoundException, Patch, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_MONEY_MINOR, SUPPORTED_CURRENCIES, isCurrencyCode, quoteDisplayMoney, type CurrencyCode } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { CurrenciesService } from './currencies.service';

export class CurrencyPreferenceDto {
  @IsIn(SUPPORTED_CURRENCIES) currency!: CurrencyCode;
}
export class DisplayQuoteDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(MAX_MONEY_MINOR) amountMinor!: number;
  @IsIn(SUPPORTED_CURRENCIES) currency!: CurrencyCode;
  @IsIn(SUPPORTED_CURRENCIES) target!: CurrencyCode;
}
@Controller({ path: 'currencies', version: '1' })
export class CurrenciesController {
  constructor(private readonly currencies: CurrenciesService, @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>) {}
  @Get()
  catalogue() { return this.currencies.catalogue(); }

  @Get('quote')
  async quote(@Query() input: DisplayQuoteDto) {
    const rates = await this.currencies.rates();
    if (!rates) throw new ServiceUnavailableException('Reference conversion unavailable. Use the original currency.');
    try { return quoteDisplayMoney({ amountMinor: input.amountMinor, currency: input.currency }, input.target, rates); }
    catch { throw new BadRequestException('Reference conversion unavailable for this price or currency.'); }
  }
  @Get('preference')
  @UseGuards(JwtAuthGuard)
  async preference(@CurrentUser() actor: AuthenticatedUser) {
    const user = await this.users.findOne({ _id: actor.sub, deletedAt: { $exists: false } }).select('preferredCurrency').lean().exec();
    if (!user) throw new NotFoundException('User not found');
    return { currency: isCurrencyCode(user.preferredCurrency) ? user.preferredCurrency : null };
  }
  @Patch('preference')
  @UseGuards(JwtAuthGuard)
  async setPreference(@Body() input: CurrencyPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    const result = await this.users.updateOne({ _id: actor.sub, deletedAt: { $exists: false } }, { $set: { preferredCurrency: input.currency } }).exec();
    if (!result.matchedCount) throw new NotFoundException('User not found');
    return { currency: input.currency };
  }
}
