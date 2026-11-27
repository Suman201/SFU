import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { IsIn, IsString, MinLength, MaxLength } from 'class-validator';
import type { BillingSource } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { BillingVersionDto, CustomerBillingDto, BillingHistoryQueryDto } from './billing.dto';
class SourceParams { @IsIn(['booking', 'payment', 'promotion']) source!: BillingSource; @IsString() @MinLength(1) @MaxLength(100) id!: string }
@Controller({ path: 'billing', version: '1' })
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get('profile') @Header('Cache-Control', 'private, no-store')
  profile(@CurrentUser() user: AuthenticatedUser) { return this.billing.profile(user); }
  @Put('profile') @Header('Cache-Control', 'private, no-store')
  save(@CurrentUser() user: AuthenticatedUser, @Body() input: CustomerBillingDto) { return this.billing.saveProfile(user, input); }
  @Post('profile/clear') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  clear(@CurrentUser() user: AuthenticatedUser, @Body() input: BillingVersionDto) { return this.billing.clearProfile(user, input.version); }
  @Get('history') @Header('Cache-Control', 'private, no-store')
  history(@CurrentUser() user: AuthenticatedUser, @Query() query: BillingHistoryQueryDto) { return this.billing.history(user, query); }
  @Get('purchases/:source/:id/refunds') @Header('Cache-Control', 'private, no-store')
  refunds(@CurrentUser() user: AuthenticatedUser, @Param() params: SourceParams, @Param('id') id: string, @Query('page') page?: string) { return this.billing.refunds(user, params.source, id, page); }
  @Get('purchases/promotion/:id/document-link') @Header('Cache-Control', 'private, no-store')
  promotionInvoice(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.billing.promotionDocument(user, id); }
  @Get('purchases/promotion/:id/credits/:creditId/link') @Header('Cache-Control', 'private, no-store')
  promotionCredit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('creditId') creditId: string) { return this.billing.promotionDocument(user, id, creditId); }
  @Get('purchases/:source/:id/document')
  async document(@CurrentUser() user: AuthenticatedUser, @Param() params: SourceParams, @Param('id') id: string, @Res({ passthrough: true }) response: { setHeader(key: string, value: string): void }) {
    return this.pdf(response, await this.billing.document(user, params.source, id));
  }
  @Get('purchases/booking/:id/credits/:creditId')
  async credit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('creditId') creditId: string, @Res({ passthrough: true }) response: { setHeader(key: string, value: string): void }) {
    return this.pdf(response, await this.billing.document(user, 'booking', id, creditId));
  }
  private pdf(response: { setHeader(key: string, value: string): void }, file: { bytes: Buffer; name: string }) {
    response.setHeader('Content-Type', 'application/pdf'); response.setHeader('Content-Disposition', `attachment; filename="${file.name}"`); response.setHeader('Cache-Control', 'private, no-store'); return new StreamableFile(file.bytes);
  }
}
