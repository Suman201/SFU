import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Model } from 'mongoose';
import {
  isCurrencyCode,
  type AdminBookingDetail,
  type AdminBookingPage,
  type AdminFinanceReport,
  type AdminFinanceCurrency,
  type AdminFinanceDay,
} from '@native-sfu/contracts';
import { BookingsService } from './bookings.service';
import {
  BookingCreditNoteDocument,
  BookingOrderDocument,
  BookingRefundDocument,
} from './booking.schema';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export class AdminBookingQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([10, 25, 50, 100]) limit =
    25;
  @IsOptional() @IsString() @MaxLength(150) search?: string;
  @IsOptional()
  @IsIn([
    'all',
    'awaiting_payment',
    'processing',
    'confirmed',
    'expired',
    'cancelled',
    'refund_pending',
    'refunded',
    'payment_review',
  ])
  status?: string;
  @IsOptional() @IsIn(['lesson', 'batch', 'all']) kind?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateTo?: string;
  @IsOptional()
  @IsIn(['queued', 'pending', 'failed', 'succeeded'])
  refundStatus?: string;
}
export class AdminOperationDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
export class RetryRefundDto extends AdminOperationDto {
  @IsUUID() requestId!: string;
}
export class FinanceQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateTo?: string;
}
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function date(value: string): Date {
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new BadRequestException('Enter a valid calendar date.');
  return parsed;
}
function range(from?: string, to?: string, financial = false) {
  const endLabel =
    to ?? (financial ? new Date().toISOString().slice(0, 10) : undefined);
  const startLabel =
    from ??
    (financial
      ? new Date(date(endLabel!).getTime() - 29 * 86400000)
          .toISOString()
          .slice(0, 10)
      : undefined);
  const start = startLabel ? date(startLabel) : undefined,
    end = endLabel ? new Date(date(endLabel).getTime() + 86400000) : undefined;
  if (
    start &&
    end &&
    (start >= end ||
      (financial && end.getTime() - start.getTime() > 366 * 86400000))
  )
    throw new BadRequestException(
      'Choose an ordered date range of at most 366 days.',
    );
  return { start, end, dateFrom: startLabel, dateTo: endLabel };
}
@Injectable()
export class AdminBookingOperationsService {
  constructor(
    private readonly bookings: BookingsService,
    @InjectModel(BookingCreditNoteDocument.name)
    private readonly credits: Model<BookingCreditNoteDocument>,
    private readonly audit: AuditLogsService,
  ) {}
  private admin(user: AuthenticatedUser) {
    if (!user.roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN'))
      throw new ForbiddenException('Administrator access required.');
  }
  private async filter(query: AdminBookingQueryDto) {
    const filter: Record<string, unknown> = {};
    const dates = range(query.dateFrom, query.dateTo);
    if (dates.start || dates.end)
      filter.createdAt = {
        ...(dates.start ? { $gte: dates.start } : {}),
        ...(dates.end ? { $lt: dates.end } : {}),
      };
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.kind && query.kind !== 'all') filter.kind = query.kind;
    if (query.currency) {
      if (!isCurrencyCode(query.currency))
        throw new BadRequestException('Unsupported currency.');
      filter['invoiceSource.currency'] = query.currency;
    }
    if (query.search?.trim()) {
      const q = escapeRegex(query.search.trim());
      filter.$or = [
        '_id',
        'title',
        'studentName',
        'teacherName',
        'studentId',
        'teacherId',
        'invoiceId',
        'paymentIntentId',
      ].map((field) => ({ [field]: { $regex: q, $options: 'i' } }));
    }
    if (query.refundStatus)
      filter._id = {
        $in: await this.bookings.refunds.distinct('orderId', {
          status: query.refundStatus,
        }),
      };
    return filter;
  }
  async detail(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AdminBookingDetail> {
    this.admin(user);
    const order = await this.bookings.ownedOrder(user, id);
    return this.present(user, order);
  }
  private async present(
    user: AuthenticatedUser,
    order: BookingOrderDocument,
    refunds?: BookingRefundDocument[],
  ): Promise<AdminBookingDetail> {
    const result = await this.bookings.view(order, user, refunds);
    return {
      ...result,
      reviewReason: order.reviewReason,
      reconciliationDueAt: order.nextReconcileAt?.toISOString(),
      providerSessionId: order.stripeSessionId,
      providerPaymentId: order.paymentIntentId,
      ...(order.paymentIntentId
        ? {
            providerDashboardUrl: `https://dashboard.stripe.com/${this.bookings.gateway.live ? '' : 'test/'}payments/${encodeURIComponent(order.paymentIntentId)}`,
          }
        : {}),
    };
  }
  async list(
    user: AuthenticatedUser,
    query: AdminBookingQueryDto,
  ): Promise<AdminBookingPage> {
    this.admin(user);
    const filter = await this.filter(query);
    const [orders, total] = await Promise.all([
      this.bookings.orders
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.bookings.orders.countDocuments(filter),
    ]);
    const refunds = await this.bookings.refunds
      .find({ orderId: { $in: orders.map((order) => order.id) } })
      .sort({ createdAt: 1 })
      .lean();
    const items = await Promise.all(
      orders.map((order) =>
        this.present(
          user,
          order,
          refunds.filter((refund) => refund.orderId === order.id),
        ),
      ),
    );
    return { items, page: query.page, limit: query.limit, total };
  }
  async recheck(user: AuthenticatedUser, id: string, reason: string) {
    this.admin(user);
    if (reason.trim().length < 5)
      throw new BadRequestException('Add a reconciliation reason.');
    const order = await this.bookings.ownedOrder(user, id);
    try {
      if (order.stripeSessionId) {
        const remote = await this.bookings.gateway.retrieveCheckout(
          order.stripeSessionId,
        );
        // An administrator may request fresh verification, never override the agreed amount.
        if (
          order.status === 'payment_review' &&
          remote.orderId === order.id &&
          remote.studentId === order.studentId &&
          remote.amountMinor === order.invoiceSource.totalMinor &&
          remote.currency.toUpperCase() === order.invoiceSource.currency &&
          remote.livemode === this.bookings.gateway.live
        ) {
          await this.bookings.orders.updateOne(
            {
              _id: id,
              status: 'payment_review',
              paidAt: { $exists: false },
              cancelledAt: { $exists: false },
            },
            {
              $set: { status: 'awaiting_payment' },
              $unset: { reviewReason: '' },
            },
          );
        }
        await this.bookings.verifyPayment(remote);
      } else await this.bookings.reconcileOrder(id);
      const current = await this.bookings.orders.findById(id);
      if (current?.paidAt && current.paymentIntentId)
        for (const refund of await this.bookings.gateway.refundsFor(
          current.paymentIntentId,
        ))
          await this.bookings.syncRefund(refund);
      await this.bookings.orders.updateOne(
        { _id: id },
        { $set: { nextReconcileAt: new Date() } },
      );
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ServiceUnavailableException(
        'The payment provider could not be reached. No manual payment confirmation was applied.',
      );
    }
    await this.audit.record({
      actor: user,
      action: 'admin.booking.reconciled',
      targetType: 'booking_order',
      targetId: id,
      metadata: { reason: reason.trim() },
    });
    return this.detail(user, id);
  }
  async retryRefund(
    user: AuthenticatedUser,
    id: string,
    refundId: string,
    body: RetryRefundDto,
  ) {
    this.admin(user);
    const refund = await this.bookings.refunds.findOne({
      _id: refundId,
      orderId: id,
      status: 'failed',
    });
    if (!refund)
      throw new ConflictException(
        'Only a failed refund can be retried as a new request. Recheck pending refunds instead.',
      );
    await this.bookings.requestRefund(
      user,
      id,
      refund.amountMinor,
      body.requestId,
      body.reason.trim(),
      refund.retryOfRefundId ?? refund.id,
    );
    await this.audit.record({
      actor: user,
      action: 'admin.booking.refund_retried',
      targetType: 'booking_order',
      targetId: id,
      metadata: {
        previousRefundId: refundId,
        requestId: body.requestId,
        reason: body.reason.trim(),
      },
    });
    return this.detail(user, id);
  }
  async csv(user: AuthenticatedUser, query: AdminBookingQueryDto) {
    this.admin(user);
    const filter = await this.filter(query);
    if ((await this.bookings.orders.countDocuments(filter)) > 10000)
      throw new BadRequestException(
        'Narrow the filters to export at most 10,000 bookings.',
      );
    const orders = await this.bookings.orders
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(10000);
    const cell = (value: unknown) =>
      '"' +
      String(value ?? '')
        .replace(/^[\s]*[=+@\-\t\r]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const rows = orders.map((order) =>
      [
        order.id,
        order.createdAt.toISOString(),
        order.studentName,
        order.teacherName,
        order.title,
        order.status,
        order.invoiceSource.currency,
        order.invoiceSource.totalMinor,
        order.refundedMinor,
        order.refundPendingMinor,
      ]
        .map(cell)
        .join(','),
    );
    await this.audit.record({
      actor: user,
      action: 'admin.booking.exported',
      targetType: 'booking_order',
      metadata: { rows: rows.length },
    });
    return (
      'order_id,created_at,student,teacher,title,status,currency,total_minor,refunded_minor,pending_refund_minor\r\n' +
      rows.join('\r\n')
    );
  }
  async finance(
    user: AuthenticatedUser,
    query: FinanceQueryDto,
  ): Promise<AdminFinanceReport> {
    this.admin(user);
    const period = range(query.dateFrom, query.dateTo, true);
    const bounds = { $gte: period.start!, $lt: period.end! };
    const [paid, credits, created, cancelled, pending, failed, reviews] =
      await Promise.all([
        this.bookings.orders.aggregate([
          { $match: { paidAt: bounds } },
          {
            $group: {
              _id: {
                currency: '$invoiceSource.currency',
                day: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$paidAt',
                    timezone: 'UTC',
                  },
                },
              },
              count: { $sum: 1 },
              amount: { $sum: '$invoiceSource.totalMinor' },
            },
          },
        ]),
        this.credits.aggregate([
          { $match: { createdAt: bounds } },
          {
            $group: {
              _id: {
                currency: '$value.currency',
                day: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$createdAt',
                    timezone: 'UTC',
                  },
                },
              },
              count: { $sum: 1 },
              amount: { $sum: '$value.totals.totalMinor' },
            },
          },
        ]),
        this.bookings.orders.aggregate([
          { $match: { createdAt: bounds } },
          {
            $group: {
              _id: {
                currency: '$invoiceSource.currency',
                day: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$createdAt',
                    timezone: 'UTC',
                  },
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
        this.bookings.orders.aggregate([
          { $match: { cancelledAt: bounds } },
          {
            $group: {
              _id: {
                currency: '$invoiceSource.currency',
                day: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$cancelledAt',
                    timezone: 'UTC',
                  },
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
        this.bookings.refunds.aggregate([
          { $match: { status: { $in: ['queued', 'pending'] } } },
          { $group: { _id: '$currency', amount: { $sum: '$amountMinor' } } },
        ]),
        this.bookings.refunds.aggregate([
          { $match: { status: 'failed' } },
          { $set: { retryRoot: { $ifNull: ['$retryOfRefundId', '$_id'] } } },
          {
            $lookup: {
              from: 'booking_refunds',
              let: { root: '$retryRoot', order: '$orderId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$orderId', '$$order'] },
                        { $eq: ['$retryOfRefundId', '$$root'] },
                        {
                          $in: ['$status', ['queued', 'pending', 'succeeded']],
                        },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: 'activeRetry',
            },
          },
          { $match: { 'activeRetry.0': { $exists: false } } },
          { $group: { _id: { currency: '$currency', root: '$retryRoot' } } },
          { $group: { _id: '$_id.currency', count: { $sum: 1 } } },
        ]),
        this.bookings.orders.countDocuments({ status: 'payment_review' }),
      ]);
    const currencies = new Map<string, AdminFinanceCurrency>();
    const days = new Map<string, AdminFinanceDay>();
    const currency = (code: string) => {
      if (!isCurrencyCode(code))
        throw new ConflictException(
          'A financial record has an unsupported currency.',
        );
      let item = currencies.get(code);
      if (!item) {
        item = {
          currency: code,
          paidBookings: 0,
          collectedMinor: 0,
          refundedMinor: 0,
          netCollectedMinor: 0,
          confirmedRefunds: 0,
          pendingRefundMinor: 0,
          failedRefunds: 0,
        };
        currencies.set(code, item);
      }
      return item;
    };
    const day = (code: string, label: string) => {
      currency(code);
      const key = code + ':' + label;
      let item = days.get(key);
      if (!item) {
        item = {
          currency: code as AdminFinanceDay['currency'],
          date: label,
          createdBookings: 0,
          paidBookings: 0,
          cancellations: 0,
          collectedMinor: 0,
          refundedMinor: 0,
          netCollectedMinor: 0,
        };
        days.set(key, item);
      }
      return item;
    };
    for (const row of paid) {
      const c = currency(row._id.currency),
        d = day(row._id.currency, row._id.day);
      c.paidBookings += row.count;
      c.collectedMinor += row.amount;
      d.paidBookings += row.count;
      d.collectedMinor += row.amount;
    }
    for (const row of credits) {
      const c = currency(row._id.currency),
        d = day(row._id.currency, row._id.day);
      c.confirmedRefunds += row.count;
      c.refundedMinor += row.amount;
      d.refundedMinor += row.amount;
    }
    for (const row of created)
      day(row._id.currency, row._id.day).createdBookings += row.count;
    for (const row of cancelled)
      day(row._id.currency, row._id.day).cancellations += row.count;
    for (const row of pending)
      currency(row._id).pendingRefundMinor = row.amount;
    for (const row of failed) currency(row._id).failedRefunds = row.count;
    for (const item of currencies.values()) {
      item.netCollectedMinor = item.collectedMinor - item.refundedMinor;
      for (const value of [
        item.collectedMinor,
        item.refundedMinor,
        item.netCollectedMinor,
        item.pendingRefundMinor,
      ])
        if (!Number.isSafeInteger(value))
          throw new ConflictException(
            'Report totals exceed the supported range. Choose a shorter date range.',
          );
    }
    for (const item of days.values())
      item.netCollectedMinor = item.collectedMinor - item.refundedMinor;
    return {
      dateFrom: period.dateFrom!,
      dateTo: period.dateTo!,
      generatedAt: new Date().toISOString(),
      currencies: [...currencies.values()].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
      days: [...days.values()].sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency),
      ),
      totals: {
        createdBookings: created.reduce((sum, row) => sum + row.count, 0),
        paidBookings: paid.reduce((sum, row) => sum + row.count, 0),
        cancellations: cancelled.reduce((sum, row) => sum + row.count, 0),
        paymentReviews: reviews,
      },
      basis:
        'UTC cash activity from verified booking payments and confirmed refund credit notes, including tax. Net collected is collected less refunded; processor fees and currency conversion are excluded. Pending/failed refunds and payment reviews are current outstanding balances, not date-filtered.',
    };
  }
}
