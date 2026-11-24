import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StudentEnrollmentsModule } from '../student-enrollments/student-enrollments.module';
import { FinanceReportsService } from './finance-reports.service';
import { FinanceSettingsService } from './finance-settings.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from './gateways/payment-gateway';
import { StripeGateway } from './gateways/stripe.gateway';
import { TestGateway } from './gateways/test.gateway';
import { UnconfiguredGateway } from './gateways/unconfigured.gateway';
import { LedgerService } from './ledger.service';
import { PaymentEventsService } from './payment-events.service';
import { PAYMENT_MODELS } from './payment.schemas';
import { AdminFinanceController, PaymentWebhooksController, StudentPaymentsController, TeacherEarningsController, TestGatewayController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';

function createGateway(config: ConfigService): PaymentGateway {
  const gateway = config.get<'stripe' | 'test'>('payments.gateway', 'test');
  const webUrl = config.get<string>('payments.webUrl', 'http://localhost:4200');
  if (gateway === 'stripe') {
    const secretKey = config.get<string>('payments.stripe.secretKey');
    const webhookSecret = config.get<string>('payments.stripe.webhookSecret') ?? '';
    if (!secretKey) {
      if (config.get<boolean>('payments.enabled', false)) new Logger('PaymentsModule').warn('Stripe is selected but STRIPE_SECRET_KEY is missing; payments are unavailable.');
      return new UnconfiguredGateway('stripe');
    }
    return new StripeGateway(secretKey, webhookSecret, config.get<boolean>('payments.stripe.connectEnabled', true));
  }
  if (config.get<string>('app.nodeEnv') === 'production') return new UnconfiguredGateway('test');
  return new TestGateway(webUrl);
}

@Module({
  imports: [AuthModule, DatabaseModule, AuditLogsModule, NotificationsModule, InvoicesModule, StudentEnrollmentsModule, MongooseModule.forFeature(PAYMENT_MODELS)],
  controllers: [StudentPaymentsController, PaymentWebhooksController, TeacherEarningsController, AdminFinanceController, TestGatewayController],
  providers: [
    { provide: PAYMENT_GATEWAY, inject: [ConfigService], useFactory: createGateway },
    FinanceSettingsService,
    LedgerService,
    PaymentsService,
    PayoutsService,
    PaymentEventsService,
    FinanceReportsService,
  ],
  exports: [PaymentsService, LedgerService, FinanceSettingsService],
})
export class PaymentsModule {}
