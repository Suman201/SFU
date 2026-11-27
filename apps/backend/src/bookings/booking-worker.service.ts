import { BookingFinanceService } from '../payments/booking-finance.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BookingsService } from './bookings.service';
import { formatMoneyWithCode } from '@native-sfu/contracts';
import { EmailNotificationService } from '../notifications/email-notification.service';
import {
  BookingCreditNoteDocument,
  PaymentWebhookDocument,
} from './booking.schema';

@Injectable()
export class BookingWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingWorkerService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private readonly bookings: BookingsService,
    @InjectModel(PaymentWebhookDocument.name)
    private readonly events: Model<PaymentWebhookDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly audit: AuditLogsService,
    private readonly email: EmailNotificationService,
    @InjectModel(BookingCreditNoteDocument.name)
    private readonly credits: Model<BookingCreditNoteDocument>,
    private readonly finance: BookingFinanceService,
  ) {}
  async onModuleInit(): Promise<void> {
    if (!this.bookings.enabled && !this.bookings.gateway.enabled) return;
    const hello = await this.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw new Error(
        'Bookings require MongoDB transactions: configure a replica set or mongos.',
      );
    await Promise.all([
      this.bookings.orders.init(),
      this.bookings.refunds.init(),
      this.events.init(),
    ]);
    for (const [collection, names] of [
      [
        'booking_orders',
        ['studentId_1_requestId_1', 'stripeSessionId_1', 'paymentIntentId_1'],
      ],
      ['booking_refunds', ['orderId_1_requestId_1', 'stripeRefundId_1']],
      ['ledger_entries', ['key_1']],
      ['invoices', ['orderId_1']],
      ['student_enrollments', ['studentId_1_batchId_1']],
    ] as const) {
      const indexes = await this.connection
        .db!.collection(collection)
        .listIndexes()
        .toArray();
      if (
        names.some(
          (name) =>
            !indexes.some((index) => index.name === name && index.unique),
        )
      )
        throw new Error(
          'Run setup:bookings before enabling online bookings: required unique financial indexes are missing.',
        );
    }
    this.timer = setInterval(
      () => {
        void this.tick().catch(() =>
          this.logger.error(
            'Booking payment worker failed; durable jobs remain queued.',
          ),
        );
      },
      this.config.get<number>('BOOKING_WORKER_POLL_MS', 2000),
    );
    this.timer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
  async receive(raw: Buffer, signature: string) {
    let event: { id: string; type: string; objectId: string };
    try {
      event = this.bookings.gateway.verifyWebhook(raw, signature);
    } catch {
      throw new BadRequestException('Invalid payment signature.');
    }
    if (
      ![
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
        'refund.created',
        'refund.updated',
        'refund.failed',
        'charge.refunded',
        'charge.dispute.created',
        'charge.dispute.updated',
        'charge.dispute.closed',
        'charge.dispute.funds_withdrawn',
        'charge.dispute.funds_reinstated',
      ].includes(event.type)
    )
      return { received: true };
    try {
      await this.events.updateOne(
        { _id: event.id },
        {
          $setOnInsert: {
            eventType: event.type,
            objectId: event.objectId,
            status: 'received',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    // The durable inbox is committed before acknowledgement. Periodic workers recover restarts.
    void this.tick().catch(() =>
      this.logger.error('Payment event is queued for retry.'),
    );
    return { received: true };
  }
  async tick(): Promise<void> {
    if (this.busy || (!this.bookings.enabled && !this.bookings.gateway.enabled))
      return;
    this.busy = true;
    try {
      for (let i = 0; i < 20; i++) {
        const token = randomUUID();
        const event = await this.events.findOneAndUpdate(
          {
            status: { $in: ['received', 'processing'] },
            nextAttemptAt: { $lte: new Date() },
            $or: [
              { leaseUntil: { $exists: false } },
              { leaseUntil: { $lte: new Date() } },
            ],
          },
          {
            $set: {
              status: 'processing',
              leaseUntil: new Date(Date.now() + 120000),
              leaseToken: token,
            },
            $inc: { attempts: 1 },
          },
          { new: true, sort: { nextAttemptAt: 1 } },
        );
        if (!event) break;
        try {
          if (event.eventType.startsWith('checkout.session.')) {
            const remote = await this.bookings.gateway.retrieveCheckout(
              event.objectId,
            );
            await this.bookings.verifyPayment(remote);
            if (remote.status === 'expired') {
              const order = await this.bookings.orders.findOne({
                stripeSessionId: remote.id,
              });
              if (order) await this.bookings.reconcileOrder(order.id);
            }
          } else if (event.eventType.startsWith('charge.dispute.'))
            await this.finance.recordDispute(await this.bookings.gateway.retrieveDispute(event.objectId));
          else if (event.eventType.startsWith('refund.'))
            await this.bookings.syncRefund(
              await this.bookings.gateway.retrieveRefund(event.objectId),
            );
          else {
            for (const refund of await this.bookings.gateway.refundsForCharge(
              event.objectId,
            ))
              await this.bookings.syncRefund(refund);
          }
          await this.events.updateOne(
            { _id: event.id, leaseToken: token },
            {
              $set: { status: 'done' },
              $unset: { leaseUntil: '', leaseToken: '' },
            },
          );
        } catch {
          await this.events.updateOne(
            { _id: event.id, leaseToken: token },
            {
              $set: {
                status: 'received',
                nextAttemptAt: new Date(
                  Date.now() +
                    Math.min(3600000, 1000 * 2 ** Math.min(event.attempts, 12)),
                ),
              },
              $unset: { leaseUntil: '', leaseToken: '' },
            },
          );
          this.logger.warn(
            'Payment event could not be reconciled; retry scheduled.',
          );
        }
      }
      for (let i = 0; i < 10; i++) {
        const token = randomUUID();
        const order = await this.bookings.orders.findOneAndUpdate(
          {
            nextReconcileAt: { $lte: new Date() },
            $or: [
              { reconcileLeaseUntil: { $exists: false } },
              { reconcileLeaseUntil: { $lte: new Date() } },
            ],
          },
          {
            $set: {
              reconcileLeaseUntil: new Date(Date.now() + 120000),
              reconcileLeaseToken: token,
            },
          },
          { new: true, sort: { nextReconcileAt: 1 } },
        );
        if (!order) break;
        try {
          if (order.paidAt && order.paymentIntentId) {
            for (const dispute of await this.bookings.gateway.disputesFor(order.paymentIntentId)) await this.finance.recordDispute(dispute);
            for (const refund of await this.bookings.gateway.refundsFor(
              order.paymentIntentId,
            ))
              await this.bookings.syncRefund(refund);
            if (order.earningsPolicy && !order.gatewayFeeCurrency) {
              const fee = await this.bookings.gateway.fetchPaymentFee(order.paymentIntentId);
              if (fee) await this.finance.recordFee(order.id, fee);
            }
          } else await this.bookings.reconcileOrder(order.id);
          const current = await this.bookings.orders.findById(order.id);
          const settled =
            current &&
            (current.status === 'refunded' ||
              (!current.paidAt && current.capacityReleased));
          await this.bookings.orders.updateOne(
            { _id: order.id, reconcileLeaseToken: token },
            {
              ...(settled
                ? {}
                : {
                    $set: {
                      nextReconcileAt: new Date(
                        Date.now() + (current?.paidAt ? 6 * 3600000 : 60000),
                      ),
                    },
                  }),
              $unset: {
                reconcileLeaseUntil: '',
                reconcileLeaseToken: '',
                ...(settled ? { nextReconcileAt: '' } : {}),
              },
            },
          );
        } catch {
          await this.bookings.orders.updateOne(
            { _id: order.id, reconcileLeaseToken: token },
            {
              $set: { nextReconcileAt: new Date(Date.now() + 60000) },
              $unset: { reconcileLeaseUntil: '', reconcileLeaseToken: '' },
            },
          );
          this.logger.warn('Booking reconciliation is queued for retry.');
        }
      }
      for (let i = 0; i < 10; i++) {
        const token = randomUUID();
        const refund = await this.bookings.refunds.findOneAndUpdate(
          {
            status: { $in: ['queued', 'pending'] },
            nextAttemptAt: { $lte: new Date() },
            $or: [
              { leaseUntil: { $exists: false } },
              { leaseUntil: { $lte: new Date() } },
            ],
          },
          {
            $set: {
              leaseUntil: new Date(Date.now() + 120000),
              leaseToken: token,
            },
            $inc: { attempts: 1 },
          },
          { new: true, sort: { nextAttemptAt: 1 } },
        );
        if (!refund) break;
        try {
          const order = await this.bookings.orders.findById(refund.orderId);
          if (!order?.paymentIntentId)
            throw new Error('Verified payment is missing.');
          const remote = refund.stripeRefundId
            ? await this.bookings.gateway.retrieveRefund(refund.stripeRefundId)
            : await this.bookings.gateway.refund(
                order.paymentIntentId,
                refund.amountMinor,
                refund.id,
              );
          await this.bookings.syncRefund(remote);
          await this.bookings.refunds.updateOne(
            { _id: refund.id, leaseToken: token },
            {
              $set: { nextAttemptAt: new Date(Date.now() + 30000) },
              $unset: { leaseUntil: '', leaseToken: '' },
            },
          );
          await this.audit.record({
            actorId: 'payment-worker',
            action: 'booking.refund_reconciled',
            targetType: 'booking_order',
            targetId: order.id,
            metadata: {
              refundId: refund.id,
              status: remote.status,
              amountMinor: remote.amountMinor,
            },
          });
        } catch (error) {
          if (
            !refund.stripeRefundId &&
            this.bookings.gateway.isDefinitiveRefundRejection(error)
          ) {
            try {
              const order = await this.bookings.orders.findById(refund.orderId);
              if (!order?.paymentIntentId)
                throw new Error('Verified payment is missing.');
              // Check for a successful, lost-response refund before releasing the
              // local balance. Never infer financial failure from a network error.
              for (const remote of await this.bookings.gateway.refundsFor(
                order.paymentIntentId,
              ))
                await this.bookings.syncRefund(remote);
              await this.bookings.failUnsubmittedRefund(refund.id, token);
              this.logger.warn(
                'Payment provider rejected a refund; its failed request remains recorded.',
              );
              continue;
            } catch {
              /* Reconciliation failed; retain the lease/retry behavior below. */
            }
          }
          await this.bookings.refunds.updateOne(
            { _id: refund.id, leaseToken: token },
            {
              $set: {
                nextAttemptAt: new Date(
                  Date.now() +
                    Math.min(
                      3600000,
                      2000 * 2 ** Math.min(refund.attempts, 10),
                    ),
                ),
              },
              $unset: { leaseUntil: '', leaseToken: '' },
            },
          );
          this.logger.warn(
            'Refund could not be confirmed; original request retained for retry.',
          );
        }
      }
      if (this.config.get<boolean>('notifications.email.enabled', false)) {
        for (let i = 0; i < 10; i++) {
          const token = randomUUID();
          const credit = await this.credits.findOneAndUpdate(
            {
              emailStatus: 'pending',
              emailNextAttemptAt: { $lte: new Date() },
              $or: [
                { emailLeaseUntil: { $exists: false } },
                { emailLeaseUntil: { $lte: new Date() } },
              ],
            },
            {
              $set: {
                emailLeaseUntil: new Date(Date.now() + 120000),
                emailLeaseToken: token,
              },
              $inc: { emailAttempts: 1 },
            },
            { new: true },
          );
          if (!credit) break;
          try {
            const pdf = await this.bookings.billing.creditPdf(credit.id);
            const delivered = await this.email.sendEmail({
              to: credit.value.customer.email,
              replyTo: credit.value.seller.email,
              subject: 'Refund credit note ' + credit.value.number,
              text: `Your refund of ${formatMoneyWithCode({ amountMinor: credit.value.totals.totalMinor, currency: credit.value.currency })} is confirmed. The credit note for invoice ${credit.value.reference} is attached.`,
              attachments: [
                {
                  filename: credit.value.number + '.pdf',
                  content: pdf,
                  contentType: 'application/pdf',
                },
              ],
            });
            if (!delivered.delivered)
              throw new Error('Credit note email was not delivered.');
            await this.credits.updateOne(
              { _id: credit.id, emailLeaseToken: token },
              {
                $set: { emailStatus: 'sent' },
                $unset: { emailLeaseUntil: '', emailLeaseToken: '' },
              },
            );
          } catch {
            await this.credits.updateOne(
              { _id: credit.id, emailLeaseToken: token },
              {
                $set: {
                  emailNextAttemptAt: new Date(
                    Date.now() +
                      Math.min(
                        3600000,
                        30000 * 2 ** Math.min(credit.emailAttempts, 7),
                      ),
                  ),
                },
                $unset: { emailLeaseUntil: '', emailLeaseToken: '' },
              },
            );
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
