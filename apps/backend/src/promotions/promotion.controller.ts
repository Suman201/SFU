import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Put, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { PromotionPlan, PromotionEventKind } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PromotionCommerceService } from './promotion-commerce.service';
import { PromotionAnalyticsService } from './promotion-analytics.service';
class PlanDto implements Omit<PromotionPlan, 'id'> {
  @IsInt() @Min(0) revision!: number;
  @IsString() @MinLength(3) @MaxLength(100) name!: string;
  @IsIn(['marketplace_featured', 'search_boost', 'profile_badge']) placement!: PromotionPlan['placement'];
  @IsInt() @Min(1) @Max(99999999) amountMinor!: number;
  @IsIn(['USD','EUR','GBP','INR','JPY']) currency!: PromotionPlan['currency'];
  @IsInt() @Min(1) @Max(90) durationDays!: number;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() autoApprove!: boolean;
  @IsBoolean() automaticTax!: boolean;
  @IsOptional() @IsString() @MaxLength(64) taxCode?: string;
}
class OrderDto { @IsUUID() requestId!: string; @IsUUID() planId!: string; @IsInt() @Min(1) revision!: number; @IsInt() @Min(1) expectedAmountMinor!: number; @IsISO8601() startsAt!: string; }
class RefundDto { @IsUUID() requestId!: string; @IsString() @MinLength(5) @MaxLength(500) reason!: string; }
class EventDto { @IsString() @MaxLength(1500) token!: string; @IsIn(['impression','profile_click','demo_open','booking_click']) kind!: PromotionEventKind; }
class ReportQuery { @IsOptional() @IsString() @MaxLength(10) from?: string; @IsOptional() @IsString() @MaxLength(10) to?: string; }
class ListQuery { @IsOptional() @IsString() @MaxLength(5) page?: string; }
function page(input: ListQuery): number { const p = Number(input.page ?? 1); if (!Number.isInteger(p) || p < 1 || p > 10000) throw new BadRequestException('Choose a valid page.'); return p; }
@Controller({ path: 'teacher/promotion-commerce', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard) @Roles('TEACHER')
export class TeacherPromotionCommerceController {
  constructor(private readonly commerce: PromotionCommerceService, private readonly analytics: PromotionAnalyticsService) {}
  @Header('Cache-Control', 'private, no-store') @Get('plans') plans() { return this.commerce.listPlans(); }
  @Header('Cache-Control', 'private, no-store') @Get('orders') list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListQuery) { return this.commerce.list(user, page(q)); }
  @Post('orders') @Throttle({ default: { limit: 10, ttl: 60000 } }) create(@CurrentUser() user: AuthenticatedUser, @Body() input: OrderDto) { return this.commerce.create(user, input); }
  @Post('orders/:id/checkout') checkout(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.commerce.checkout(id, user); }
  @Post('orders/:id/reconcile') reconcile(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.commerce.reconcile(id, user); }
  @Header('Cache-Control', 'private, no-store') @Get('orders/:id/document') document(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.commerce.document(id, user); }
  @Header('Cache-Control', 'private, no-store') @Get('orders/:id/credit') credit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.commerce.document(id, user, true); }
  @Header('Cache-Control', 'private, no-store') @Get('analytics/:id') report(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query() q: ReportQuery) { return this.analytics.report(id, q.from, q.to, user.sub); }
}
@Controller({ path: 'admin/promotion-commerce', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard) @Roles('ADMIN', 'SUPER_ADMIN')
export class AdminPromotionCommerceController {
  constructor(private readonly commerce: PromotionCommerceService, private readonly analytics: PromotionAnalyticsService) {}
  @Header('Cache-Control', 'private, no-store') @Get('plans') plans() { return this.commerce.listPlans(true); }
  @Put('plans/:id') save(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() input: PlanDto) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Choose a valid plan id.'); return this.commerce.savePlan(id, { ...input, id }, user); }
  @Header('Cache-Control', 'private, no-store') @Get('orders') list(@Query() q: ListQuery) { return this.commerce.list(undefined, page(q)); }
  @Post('orders/:id/reconcile') reconcile(@Param('id') id: string) { return this.commerce.reconcile(id); }
  @Post('orders/:id/refund') refund(@Param('id') id: string, @Body() input: RefundDto, @CurrentUser() actor: AuthenticatedUser) { return this.commerce.requestRefund(id, input, actor); }
  @Header('Cache-Control', 'private, no-store') @Get('orders/:id/document') document(@Param('id') id: string) { return this.commerce.document(id); }
  @Header('Cache-Control', 'private, no-store') @Get('orders/:id/credit') credit(@Param('id') id: string) { return this.commerce.document(id, undefined, true); }
  @Header('Cache-Control', 'private, no-store') @Get('analytics/:id') report(@Param('id') id: string, @Query() q: ReportQuery) { return this.analytics.report(id, q.from, q.to); }
}
@Controller({ path: 'promotion-commerce', version: '1' })
export class PublicPromotionCommerceController {
  constructor(private readonly commerce: PromotionCommerceService, private readonly analytics: PromotionAnalyticsService) {}
  @Post('events') @HttpCode(200) @Throttle({ default: { limit: 120, ttl: 60000 } }) event(@Body() input: EventDto) { return this.analytics.record(input.token, input.kind); }
  @Post('stripe/webhook') @HttpCode(200) webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) { if (!req.rawBody || !signature || signature.length > 2048) throw new BadRequestException('A signed payment event is required.'); return this.commerce.webhook(req.rawBody, signature); }
}
