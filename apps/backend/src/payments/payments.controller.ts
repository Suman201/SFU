import { BookingFinanceService } from './booking-finance.service';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { PaymentListQuery } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { FinanceReportsService } from './finance-reports.service';
import { FinanceSettingsService } from './finance-settings.service';
import { InvalidWebhookSignatureError } from './gateways/payment-gateway';
import { LedgerService } from './ledger.service';
import { PaymentEventsService } from './payment-events.service';
import { AdoptBookingEarningsDto, CheckoutDto, FinanceSettingsDto, PayoutDecisionDto, PayoutRequestDto, ReconcilePayoutDto, RefundDto, TestCheckoutDto, TestDisputeDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';

type HeaderResponse = { setHeader: (key: string, value: string) => void };

function pdfResponse(res: HeaderResponse, file: { bytes: Buffer; name: string }): StreamableFile {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return new StreamableFile(file.bytes);
}

/** Student checkout, history and receipts. */
@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StudentPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('config')
  @Roles('STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN')
  config() {
    return this.payments.status();
  }

  @Post('checkout')
  @Roles('STUDENT')
  checkout(@Body() input: CheckoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.createCheckout(user, input.batchId);
  }

  @Get('me')
  @Roles('STUDENT')
  mine(@Query('page') page: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.listForStudent(user, Number(page) || 1);
  }

  @Get('me/:id')
  @Roles('STUDENT')
  one(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.getForStudent(user, id);
  }

  @Post('me/:id/cancel')
  @Roles('STUDENT')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.cancelCheckout(user, id);
  }

  @Get('me/:id/receipt')
  @Roles('STUDENT')
  async receipt(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: HeaderResponse) {
    return pdfResponse(res, await this.payments.receipt(id, user.sub));
  }
}

/** Signed gateway notifications. The route receives the raw body (see main.ts). */
@Controller('payments/webhooks')
@SkipThrottle()
export class PaymentWebhooksController {
  constructor(
    private readonly events: PaymentEventsService,
    private readonly payments: PaymentsService,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() request: { body?: unknown; headers: Record<string, string | string[] | undefined> }) {
    if (this.payments.gatewayId() !== 'stripe') throw new NotFoundException();
    if (!Buffer.isBuffer(request.body)) throw new BadRequestException('Webhook body must be raw JSON.');
    try {
      return await this.events.ingestWebhook(request.body, request.headers);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) throw new BadRequestException('Invalid webhook signature.');
      throw error;
    }
  }
}

/** Teacher earnings, transactions and payouts. */
@Controller('teacher/earnings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TeacherEarningsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get() summary(@CurrentUser() user: AuthenticatedUser) {
    return this.payouts.summary(user);
  }

  @Get('transactions') transactions(@Query('page') page: string | undefined, @Query('currency') currency: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.transactions(user, Number(page) || 1, currency);
  }

  @Get('payouts') list(@Query('page') page: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.listForTeacher(user, Number(page) || 1);
  }

  @Post('payouts') request(@Body() input: PayoutRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.request(user, input);
  }

  @Post('payouts/:id/cancel') cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.cancel(user, id);
  }

  @Post('payout-account/onboarding') onboarding(@CurrentUser() user: AuthenticatedUser) {
    return this.payouts.startOnboarding(user);
  }

  @Post('payout-account/refresh') refresh(@CurrentUser() user: AuthenticatedUser) {
    return this.payouts.refreshAccount(user);
  }
}

/** Finance administration. Settings changes are limited to super admins. */
@Controller('admin/finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminFinanceController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly settings: FinanceSettingsService,
    private readonly reports: FinanceReportsService,
    private readonly ledger: LedgerService,
    private readonly events: PaymentEventsService,
    private readonly bookingFinance: BookingFinanceService,
  ) {}

  @Get('overview') overview(@Query() query: Record<string, string>) {
    return this.reports.overview(query);
  }

  @Get('status') status() {
    return this.payments.status();
  }

  @Get('settings') getSettings() {
    return this.settings.get();
  }

  @Patch('settings')
  @Roles('SUPER_ADMIN')
  saveSettings(@Body() input: FinanceSettingsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.settings.update(input, actor);
  }

  @Get('payments') list(@Query() query: Record<string, string>) {
    return this.payments.adminList(query as unknown as PaymentListQuery);
  }

  @Get('payments.csv')
  async csv(@Query() query: Record<string, string>, @Res({ passthrough: true }) res: HeaderResponse) {
    const body = await this.reports.paymentsCsv(query as unknown as PaymentListQuery);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(Buffer.from(body, 'utf8'));
  }

  @Get('payments/:id') get(@Param('id') id: string) {
    return this.payments.adminGet(id);
  }

  @Get('payments/:id/receipt')
  async receipt(@Param('id') id: string, @Res({ passthrough: true }) res: HeaderResponse) {
    return pdfResponse(res, await this.payments.receipt(id));
  }

  @Post('payments/:id/refunds') refund(@Param('id') id: string, @Body() input: RefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createRefund(id, input, actor);
  }

  @Get('refunds') refunds(@Query() query: Record<string, string>) {
    return this.payments.listRefunds(query);
  }

  @Get('disputes') disputes(@Query() query: Record<string, string>) {
    return this.payments.listDisputes(query);
  }

  @Get('payouts') payoutList(@Query() query: Record<string, string>) {
    return this.payouts.list(query);
  }

  @Post('payouts/:id/approve') approve(@Param('id') id: string, @Body() input: PayoutDecisionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payouts.approve(id, input.note, actor);
  }

  @Post('payouts/:id/reject') reject(@Param('id') id: string, @Body() input: PayoutDecisionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payouts.reject(id, input.note ?? '', actor);
  }

  @Post('payouts/:id/reconcile')
  reconcilePayout(@Param('id') id: string, @Body() input: ReconcilePayoutDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payouts.reconcile(id, input.transferId, input.reason, actor);
  }

  @Get('teachers') teachers(@Query() query: Record<string, string>) {
    return this.reports.teachers(query);
  }

  @Get('ledger') ledgerEntries(@Query() query: Record<string, string>) {
    return this.ledger.list(query);
  }

  @Get('events') eventList(@Query() query: Record<string, string>) {
    return this.events.list(query);
  }

  @Post('events/:id/retry') retry(@Param('id') id: string) {
    return this.events.retry(id);
  }

  @Get('booking-earnings/legacy')
  legacyBookingEarnings(@Query('page') page?: string) { return this.bookingFinance.legacy(Number(page) || 1); }

  @Post('booking-earnings/:id/adopt')
  @Roles('SUPER_ADMIN')
  async adoptBookingEarnings(@Param('id') id: string, @Body() input: AdoptBookingEarningsDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookingFinance.adopt(id, input, actor);
    return this.reports.reconciliation();
  }

  @Post('booking-earnings/:id/repair')
  @Roles('SUPER_ADMIN')
  async repairBookingEarnings(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.bookingFinance.repairOrder(id, user);
    return this.reports.reconciliation();
  }

  @Get('reconciliation') reconciliation(@Query('bookingAfter') bookingAfter?: string) {
    return this.reports.reconciliation(bookingAfter);
  }

  @Post('reconciliation/repair')
  @Roles('SUPER_ADMIN')
  repair() {
    return this.reports.repair();
  }
}

/**
 * Development-only simulator for the test gateway. Disabled unless the test
 * gateway is configured outside production; it never moves money.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class TestGatewayController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly events: PaymentEventsService,
    private readonly config: ConfigService,
  ) {}

  private assertAvailable(): void {
    if (this.payments.gatewayId() !== 'test' || this.config.get<string>('app.nodeEnv') === 'production') throw new NotFoundException();
  }

  @Get('payments/test-gateway/:id')
  @Roles('STUDENT')
  async session(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    this.assertAvailable();
    return this.payments.getForStudent(user, id);
  }

  @Post('payments/test-gateway/:id/complete')
  @Roles('STUDENT')
  async complete(@Param('id') id: string, @Body() input: TestCheckoutDto, @CurrentUser() user: AuthenticatedUser) {
    this.assertAvailable();
    const payment = await this.payments.findForTestGateway(id);
    if (!payment || payment.studentId !== user.sub) throw new NotFoundException('Payment not found.');
    if (payment.status !== 'pending' || !payment.gatewaySessionId) throw new BadRequestException('This checkout is no longer open.');
    const eventId = `test_evt_${randomUUID().replace(/-/g, '')}`;
    if (input.outcome === 'decline') {
      await this.events.ingest('test', {
        kind: 'payment.failed',
        eventId,
        gatewayPaymentId: payment.gatewayPaymentId ?? `test_pi_${payment.id.replace(/-/g, '')}`,
        reason: 'Your card was declined (test).',
        paymentRef: payment.id,
      });
    } else {
      await this.events.ingest('test', {
        kind: 'checkout.completed',
        eventId,
        sessionId: payment.gatewaySessionId,
        gatewayPaymentId: `test_pi_${payment.id.replace(/-/g, '')}`,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        paid: true,
        paymentRef: payment.id,
      });
    }
    return this.payments.getForStudent(user, id);
  }

  @Post('admin/finance/test-gateway/payments/:id/dispute')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async dispute(@Param('id') id: string, @Body() input: TestDisputeDto) {
    this.assertAvailable();
    const payment = await this.payments.findForTestGateway(id);
    if (!payment?.gatewayPaymentId) throw new NotFoundException('Paid payment not found.');
    if (payment.gateway !== 'test') throw new ForbiddenException();
    await this.events.ingest('test', {
      kind: 'dispute.updated',
      eventId: `test_evt_${randomUUID().replace(/-/g, '')}`,
      gatewayDisputeId: `test_dp_${payment.id.replace(/-/g, '')}`,
      gatewayPaymentId: payment.gatewayPaymentId,
      amountMinor: payment.amountMinor - payment.refundedMinor,
      currency: payment.currency,
      feeMinor: 1500,
      reason: 'fraudulent',
      status: input.status,
      inquiry: false,
    });
    return this.payments.adminGet(id);
  }
}
