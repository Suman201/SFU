import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  invoiceTotals,
  isCurrencyCode,
  minorToMajor,
  type BookingBatchCatalogue,
  type BookingCatalogue,
  type BookingOrder,
  type BookingInvoiceSource,
  type LessonOffer,
  type LessonSlot,
} from '@native-sfu/contracts';
import { planClassSessions } from '../class-sessions/class-session-planner';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  StudentEnrollmentDocument,
  UserDocument,
  UserMongoDocument,
} from '../database/schemas';
import {
  BookingOrderDocument,
  BookingOrderMongo,
  BookingRefundDocument,
  BookingRefundMongo,
  LessonOfferDocument,
  LessonOfferMongo,
  LessonSlotDocument,
  LessonSlotMongo,
} from './booking.schema';
import {
  BookingReserveDto,
  LessonOfferDto,
  LessonSlotDto,
} from './booking.dto';
import { BookingCalendarService } from './booking-calendar.service';
import { BookingBillingService } from './booking-billing.service';
import {
  StripeGateway,
  VerifiedCheckout,
  VerifiedRefund,
} from './stripe.gateway';

const PENDING = ['awaiting_payment', 'processing'];
const systemActor = {
  sub: 'payment-worker',
  email: '',
  roles: ['ADMIN'],
  permissions: [],
  tokenId: '',
};

@Injectable()
export class BookingsService {
  constructor(
    @InjectModel(LessonOfferDocument.name)
    readonly offers: Model<LessonOfferMongo>,
    @InjectModel(LessonSlotDocument.name)
    readonly slots: Model<LessonSlotMongo>,
    @InjectModel(BookingOrderDocument.name)
    readonly orders: Model<BookingOrderMongo>,
    @InjectModel(BookingRefundDocument.name)
    readonly refunds: Model<BookingRefundMongo>,
    @InjectModel(UserDocument.name) readonly users: Model<UserMongoDocument>,
    @InjectModel(BatchDocument.name)
    readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name)
    readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name)
    readonly enrollments: Model<StudentEnrollmentDocument>,
    @InjectModel(ClassSessionDocument.name)
    readonly classes: Model<ClassSessionMongoDocument>,
    readonly calendar: BookingCalendarService,
    readonly billing: BookingBillingService,
    readonly gateway: StripeGateway,
    private readonly config: ConfigService,
    private readonly enrollmentService: StudentEnrollmentsService,
  ) {}
  get enabled(): boolean {
    return this.config.get<boolean>('BOOKINGS_ENABLED', false);
  }
  get noticeHours(): number {
    return this.config.get<number>('BOOKING_CANCELLATION_NOTICE_HOURS', 24);
  }
  configuration() {
    return {
      enabled: this.enabled,
      paymentsAvailable: this.enabled && this.gateway.enabled,
      chargeCurrencies: this.gateway.currencies,
      cancellationNoticeHours: this.noticeHours,
    };
  }
  private requireEnabled(): void {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Online bookings are not enabled yet.',
      );
  }
  private assertStudent(user: AuthenticatedUser): void {
    if (!user.roles.includes('STUDENT'))
      throw new ForbiddenException('A student account is required to book.');
  }
  private admin(user: AuthenticatedUser): boolean {
    return user.roles.some(
      (role) => role === 'ADMIN' || role === 'SUPER_ADMIN',
    );
  }
  private async teacher(id: string, session?: ClientSession) {
    const teacher = await this.users
      .findOne({
        _id: id,
        roles: 'TEACHER',
        status: 'active',
        disabled: { $ne: true },
        deletedAt: { $exists: false },
        publicProfileEnabled: true,
        tutorReviewStatus: 'approved',
      })
      .session(session ?? null);
    if (!teacher)
      throw new NotFoundException(
        'This teacher is not available for bookings.',
      );
    return teacher;
  }
  async catalogue(teacherId: string): Promise<BookingCatalogue> {
    const teacher = await this.teacher(teacherId);
    const offers = await this.offers
      .find({ teacherId, 'value.active': true })
      .sort({ 'value.durationMinutes': 1 })
      .lean();
    const slots = await this.slots
      .find({
        teacherId,
        offerId: { $in: offers.map((o) => o._id) },
        status: 'open',
        startsAt: {
          $gte: new Date(Date.now() + 3600000),
          $lte: new Date(Date.now() + 180 * 86400000),
        },
      })
      .sort({ startsAt: 1 })
      .limit(500)
      .lean();
    return {
      teacher: {
        id: teacher.id,
        name: teacher.displayName ?? teacher.name ?? 'Teacher',
        headline: teacher.headline ?? '',
        timezone: teacher.timezone ?? 'UTC',
      },
      offers: offers.map((o) => ({ id: o._id, ...o.value })),
      slots: slots.map((s) => this.slotView(s)),
      paymentsAvailable: this.enabled && this.gateway.enabled,
      cancellationNoticeHours: this.noticeHours,
    };
  }
  private slotView(slot: LessonSlotDocument): LessonSlot {
    return {
      id: slot._id,
      offerId: slot.offerId,
      teacherId: slot.teacherId,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      status: slot.status,
    };
  }
  async teacherAvailability(user: AuthenticatedUser) {
    await this.teacher(user.sub);
    const offers = await this.offers
      .find({ teacherId: user.sub })
      .sort({ createdAt: -1 })
      .lean();
    const slots = await this.slots
      .find({ teacherId: user.sub, endsAt: { $gte: new Date() } })
      .sort({ startsAt: 1 })
      .limit(500)
      .lean();
    return {
      ...this.configuration(),
      offers: offers.map((o) => ({ id: o._id, ...o.value })),
      slots: slots.map((s) => this.slotView(s)),
    };
  }
  async saveOffer(
    user: AuthenticatedUser,
    input: LessonOfferDto,
    offerId?: string,
  ): Promise<LessonOffer> {
    await this.teacher(user.sub);
    if (input.durationMinutes % 5)
      throw new BadRequestException(
        'Lesson duration must use five-minute increments.',
      );
    const taxRateBps = this.config.get<number>('BOOKING_TAX_RATE_BPS');
    if (taxRateBps === undefined)
      throw new ServiceUnavailableException(
        'The business must configure booking tax treatment first.',
      );
    const total = invoiceTotals([
      {
        quantityMilli: 1000,
        unitPriceMinor: input.amountMinor,
        taxRateBps,
        description: input.title,
      },
    ]);
    this.gateway.assertCurrency(input.currency, total.totalMinor);
    const value: Omit<LessonOffer, 'id'> = {
      teacherId: user.sub,
      title: input.title.trim(),
      description: input.description.trim(),
      durationMinutes: input.durationMinutes,
      price: { amountMinor: total.totalMinor, currency: input.currency },
      netMinor: input.amountMinor,
      taxRateBps,
      active: input.active,
      version: 0,
    };
    if (!offerId) {
      const created = await this.offers.create({ teacherId: user.sub, value });
      return { id: created.id, ...value };
    }
    if (input.version === undefined)
      throw new BadRequestException('The current offer version is required.');
    const existing = await this.offers.findOne({
      _id: offerId,
      teacherId: user.sub,
      'value.version': input.version,
    });
    if (!existing)
      throw new ConflictException('This offer changed. Reload before editing.');
    if (
      existing.value.durationMinutes !== input.durationMinutes &&
      (await this.slots.exists({
        offerId,
        status: { $in: ['open', 'held', 'booked'] },
      }))
    )
      throw new ConflictException(
        'Create a new offer to change duration after times have been published.',
      );
    value.version = input.version + 1;
    const saved = await this.offers.findOneAndUpdate(
      { _id: offerId, teacherId: user.sub, 'value.version': input.version },
      { $set: { value } },
      { new: true },
    );
    if (!saved)
      throw new ConflictException('This offer changed. Reload before editing.');
    return { id: saved.id, ...saved.value };
  }
  async publishSlot(user: AuthenticatedUser, input: LessonSlotDto) {
    this.requireEnabled();
    await this.teacher(user.sub);
    const start = new Date(input.startsAt);
    if (
      start.getTime() < Date.now() + 3600000 ||
      start.getTime() > Date.now() + 365 * 86400000 ||
      start.getTime() % 300000 !== 0
    )
      throw new BadRequestException(
        'Choose a five-minute boundary at least one hour ahead, within the next year.',
      );
    return this.calendar.withTeacherLock(user.sub, async (session) => {
      const offer = await this.offers
        .findOne({
          _id: input.offerId,
          teacherId: user.sub,
          'value.active': true,
        })
        .session(session);
      if (!offer) throw new NotFoundException('Active lesson offer not found.');
      const end = new Date(
        start.getTime() + offer.value.durationMinutes * 60000,
      );
      await this.calendar.assertFree(user.sub, start, end, session);
      const [slot] = await this.slots.create(
        [
          {
            teacherId: user.sub,
            offerId: offer.id,
            startsAt: start,
            endsAt: end,
            status: 'open',
          },
        ],
        { session },
      );
      return this.slotView(slot!);
    });
  }
  async withdrawSlot(user: AuthenticatedUser, id: string) {
    return this.calendar.withTeacherLock(user.sub, async (session) => {
      const slot = await this.slots.findOneAndUpdate(
        { _id: id, teacherId: user.sub, status: 'open' },
        { $set: { status: 'cancelled' } },
        { session, new: true },
      );
      if (!slot)
        throw new ConflictException(
          'Only an unreserved slot can be withdrawn. Cancel an existing booking through its order.',
        );
      return this.slotView(slot);
    });
  }
  async batchCatalogue(id: string): Promise<BookingBatchCatalogue> {
    const batch = await this.batches.findOne({
      _id: id,
      status: 'ACTIVE',
      isPrivateBooking: { $ne: true },
      deletedAt: { $exists: false },
      endDate: { $gt: new Date() },
    });
    if (!batch)
      throw new NotFoundException('This class is not open for booking.');
    const teacher = await this.teacher(batch.teacherId);
    if (!isCurrencyCode(batch.feeCurrency) || batch.feeMinor === undefined)
      throw new ConflictException(
        'The teacher must confirm this class price currency first.',
      );
    const taxRateBps = this.config.get<number>('BOOKING_TAX_RATE_BPS');
    if (taxRateBps === undefined)
      throw new ServiceUnavailableException(
        'Booking tax treatment is not configured.',
      );
    const total = invoiceTotals([
      {
        description: batch.name,
        quantityMilli: 1000,
        unitPriceMinor: batch.feeMinor,
        taxRateBps,
      },
    ]);
    const enrolled = await this.enrollments.countDocuments({
      batchId: id,
      status: 'active',
      deletedAt: { $exists: false },
    });
    const schedules = await this.schedules.find({ batchId: id });
    const planned = new Map(
      planClassSessions(batch, schedules).map((item) => [
        item.id,
        { ...item, status: 'scheduled' },
      ]),
    );
    for (const item of await this.classes.find({ batchId: id }))
      planned.set(item.id, { ...item.toObject(), id: item.id });
    const next = [...planned.values()]
      .filter(
        (item) => item.status === 'scheduled' && item.scheduledAt > new Date(),
      )
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];
    if (!next)
      throw new ConflictException(
        'This class has no upcoming scheduled lessons.',
      );
    return {
      id,
      title: batch.name,
      teacherId: teacher.id,
      teacherName: teacher.displayName ?? teacher.name ?? 'Teacher',
      price: { amountMinor: total.totalMinor, currency: batch.feeCurrency },
      startsAt: next.scheduledAt.toISOString(),
      endsAt: batch.endDate.toISOString(),
      placesAvailable: Math.max(
        0,
        batch.maxCapacity - enrolled - (batch.paymentReservedCount ?? 0),
      ),
      paymentsAvailable: this.enabled && this.gateway.enabled,
      cancellationNoticeHours: this.noticeHours,
    };
  }
  private async source(
    user: AuthenticatedUser,
    input: BookingReserveDto,
    orderId: string,
    title: string,
    start: Date,
    netMinor: number,
    taxRateBps: number,
    currency: BookingInvoiceSource['currency'],
  ): Promise<BookingInvoiceSource> {
    if (
      input.billing.name.trim().length < 2 ||
      input.billing.address.trim().length < 5 ||
      input.billing.address.split('\n').length > 8
    )
      throw new BadRequestException('Add the full billing name and address.');
    const settings = await this.billing.issuer();
    const taxNote = this.config.get<string>('BOOKING_TAX_NOTE', '').trim();
    if (taxRateBps === 0 && taxNote.length < 4)
      throw new ServiceUnavailableException(
        'The business must configure the zero-tax explanation before accepting bookings.',
      );
    if (taxRateBps > 0 && !settings.seller.vatNumber)
      throw new ServiceUnavailableException(
        'The business tax registration is missing.',
      );
    const totals = invoiceTotals([
      {
        description: title,
        quantityMilli: 1000,
        unitPriceMinor: netMinor,
        taxRateBps,
      },
    ]);
    if (input.expectedTotalMinor !== totals.totalMinor)
      throw new ConflictException(
        'The price changed. Reload and review the current total.',
      );
    this.gateway.assertCurrency(currency, totals.totalMinor);
    if (totals.totalMinor > 0 && !this.gateway.enabled)
      throw new ServiceUnavailableException(
        'Online payments are not configured.',
      );
    return {
      orderId,
      studentId: user.sub,
      billing: {
        ...input.billing,
        name: input.billing.name.trim(),
        address: input.billing.address.trim(),
        vatNumber: input.billing.vatNumber.trim(),
        email: user.email,
      },
      seller: structuredClone(settings.seller),
      title,
      startsAt: start.toISOString(),
      currency,
      netMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      taxRateBps,
      taxNote,
      paymentReference: '',
      paidAt: new Date(0),
    };
  }
  private sameRequest(
    existing: BookingOrderDocument,
    input: BookingReserveDto,
    resourceId: string,
  ): void {
    if (
      (existing.slotId ?? existing.batchId) !== resourceId ||
      existing.goal !== (input.goal?.trim() ?? '') ||
      existing.invoiceSource.billing.name !== input.billing.name.trim() ||
      existing.invoiceSource.billing.address !== input.billing.address.trim() ||
      existing.invoiceSource.billing.countryCode !==
        input.billing.countryCode ||
      existing.invoiceSource.billing.vatNumber !==
        input.billing.vatNumber.trim()
    )
      throw new ConflictException(
        'This request ID was already used for a different booking.',
      );
  }
  async reserveSlot(
    user: AuthenticatedUser,
    slotId: string,
    input: BookingReserveDto,
  ): Promise<BookingOrder> {
    this.requireEnabled();
    this.assertStudent(user);
    const previous = await this.orders.findOne({
      studentId: user.sub,
      requestId: input.requestId,
    });
    if (previous) {
      this.sameRequest(previous, input, slotId);
      return this.view(previous, user);
    }
    const available = await this.slots.findById(slotId);
    if (!available) throw new NotFoundException('Lesson time not found.');
    const offer = await this.offers.findOne({
      _id: available.offerId,
      'value.active': true,
    });
    if (!offer)
      throw new ConflictException('This lesson is no longer offered.');
    if (input.expectedOfferVersion !== offer.value.version)
      throw new ConflictException(
        'This offer changed. Reload before reserving.',
      );
    const teacher = await this.teacher(available.teacherId);
    const id = randomUUID();
    const invoiceSource = await this.source(
      user,
      input,
      id,
      offer.value.title,
      available.startsAt,
      offer.value.netMinor,
      offer.value.taxRateBps,
      offer.value.price.currency,
    );
    let order: BookingOrderMongo;
    try {
      order = await this.calendar.transaction(async (session) => {
        await this.calendar.lockTeacher(teacher.id, session);
        await this.calendar.lockStudent(user.sub, session);
        const student = await this.users
          .findOne({
            _id: user.sub,
            status: 'active',
            disabled: { $ne: true },
            deletedAt: { $exists: false },
          })
          .session(session);
        if (!student)
          throw new ForbiddenException('Student account unavailable.');
        const freshOffer = await this.offers
          .findOne({
            _id: offer.id,
            'value.active': true,
            'value.version': offer.value.version,
          })
          .session(session);
        if (!freshOffer)
          throw new ConflictException(
            'The lesson price changed. Reload the offers.',
          );
        const slot = await this.slots
          .findOne({
            _id: slotId,
            status: 'open',
            startsAt: { $gte: new Date(Date.now() + 3600000) },
          })
          .session(session);
        if (!slot)
          throw new ConflictException(
            'This time has already been reserved. Choose another time.',
          );
        if (
          slot.endsAt.getTime() - slot.startsAt.getTime() !==
          freshOffer.value.durationMinutes * 60000
        )
          throw new ConflictException(
            'This time no longer matches the published lesson duration. Choose another time.',
          );
        await this.calendar.assertFree(
          teacher.id,
          slot.startsAt,
          slot.endsAt,
          session,
          slot.id,
        );
        await this.calendar.assertStudentFree(
          user.sub,
          slot.startsAt,
          slot.endsAt,
          session,
        );
        if (
          await this.orders
            .exists({
              studentId: user.sub,
              kind: 'lesson',
              status: { $in: [...PENDING, 'confirmed'] },
              startsAt: { $lt: slot.endsAt },
              endsAt: { $gt: slot.startsAt },
            })
            .session(session)
        )
          throw new ConflictException(
            'You already have a booking or reservation at this time.',
          );
        await this.slots.updateOne(
          { _id: slot.id, status: 'open' },
          { $set: { status: 'held', orderId: id } },
          { session },
        );
        const [created] = await this.orders.create(
          [
            {
              _id: id,
              requestId: input.requestId,
              studentId: user.sub,
              studentName: student.displayName ?? student.name ?? 'Student',
              teacherId: teacher.id,
              teacherName: teacher.displayName ?? teacher.name ?? 'Teacher',
              title: offer.value.title,
              kind: 'lesson',
              slotId,
              offerId: offer.id,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              expiresAt: new Date(Date.now() + 45 * 60000),
              cancellationDeadline: new Date(
                slot.startsAt.getTime() - this.noticeHours * 3600000,
              ),
              invoiceSource,
              goal: input.goal?.trim() ?? '',
              status: 'awaiting_payment',
              nextReconcileAt: new Date(Date.now() + 60000),
            },
          ],
          { session },
        );
        return created!;
      });
    } catch (error) {
      const duplicate = await this.orders.findOne({
        studentId: user.sub,
        requestId: input.requestId,
      });
      if (duplicate) {
        this.sameRequest(duplicate, input, slotId);
        return this.view(duplicate, user);
      }
      throw error;
    }
    if (invoiceSource.totalMinor === 0) await this.confirmFree(order.id);
    return this.getOrder(user, order.id);
  }
  async reserveBatch(
    user: AuthenticatedUser,
    batchId: string,
    input: BookingReserveDto,
  ): Promise<BookingOrder> {
    this.requireEnabled();
    this.assertStudent(user);
    const previous = await this.orders.findOne({
      studentId: user.sub,
      requestId: input.requestId,
    });
    if (previous) {
      this.sameRequest(previous, input, batchId);
      return this.view(previous, user);
    }
    const summary = await this.batchCatalogue(batchId);
    const batch = await this.batches.findById(batchId);
    if (
      !batch ||
      !isCurrencyCode(batch.feeCurrency) ||
      batch.feeMinor === undefined
    )
      throw new ConflictException('Class price unavailable.');
    const id = randomUUID(),
      rate = this.config.getOrThrow<number>('BOOKING_TAX_RATE_BPS');
    const invoiceSource = await this.source(
      user,
      input,
      id,
      batch.name,
      new Date(summary.startsAt),
      batch.feeMinor,
      rate,
      batch.feeCurrency,
    );
    try {
      await this.calendar.transaction(async (session) => {
        await this.calendar.lockStudent(user.sub, session);
        const locked = await this.batches.findOneAndUpdate(
          {
            _id: batchId,
            status: 'ACTIVE',
            isPrivateBooking: { $ne: true },
            deletedAt: { $exists: false },
            feeMinor: batch.feeMinor,
            feeCurrency: batch.feeCurrency,
            $or: [
              { enrollmentLockUntil: { $exists: false } },
              { enrollmentLockUntil: { $lt: new Date() } },
            ],
          },
          { $inc: { paymentReservedCount: 1 } },
          { new: true, session },
        );
        if (!locked)
          throw new ConflictException(
            'This class changed or enrollment is being updated. Try again.',
          );
        const active = await this.enrollments
          .countDocuments({
            batchId,
            status: 'active',
            deletedAt: { $exists: false },
          })
          .session(session);
        if (active + (locked.paymentReservedCount ?? 0) + (await this.enrollmentService.countPaymentCheckoutHolds(batchId, session)) > locked.maxCapacity)
          throw new ConflictException('This class is full.');
        if (
          (await this.enrollments
            .exists({
              batchId,
              studentId: user.sub,
              status: 'active',
              deletedAt: { $exists: false },
            })
            .session(session)) ||
          (await this.orders
            .exists({
              batchId,
              studentId: user.sub,
              status: { $in: [...PENDING, 'confirmed'] },
            })
            .session(session))
        )
          throw new ConflictException(
            'You are already enrolled or have a reservation for this class.',
          );
        const student = await this.users.findById(user.sub).session(session);
        await this.orders.create(
          [
            {
              _id: id,
              requestId: input.requestId,
              studentId: user.sub,
              studentName: student?.displayName ?? student?.name ?? 'Student',
              teacherId: batch.teacherId,
              teacherName: summary.teacherName,
              title: batch.name,
              kind: 'batch',
              batchId,
              startsAt: new Date(summary.startsAt),
              endsAt: batch.endDate,
              expiresAt: new Date(Date.now() + 45 * 60000),
              cancellationDeadline: new Date(
                new Date(summary.startsAt).getTime() -
                  this.noticeHours * 3600000,
              ),
              invoiceSource,
              goal: input.goal?.trim() ?? '',
              status: 'awaiting_payment',
              nextReconcileAt: new Date(Date.now() + 60000),
            },
          ],
          { session },
        );
      });
    } catch (error) {
      const duplicate = await this.orders.findOne({
        studentId: user.sub,
        requestId: input.requestId,
      });
      if (duplicate) {
        this.sameRequest(duplicate, input, batchId);
        return this.view(duplicate, user);
      }
      throw error;
    }
    if (invoiceSource.totalMinor === 0) await this.confirmFree(id);
    return this.getOrder(user, id);
  }
  async checkout(user: AuthenticatedUser, id: string) {
    const order = await this.ownedOrder(user, id, true);
    if (order.status !== 'awaiting_payment')
      throw new ConflictException('This order cannot start another payment.');
    if (order.stripeSessionId) {
      await this.reconcileOrder(order.id);
      return this.getOrder(user, id);
    }
    if (
      !order.checkoutAttemptedAt &&
      order.expiresAt.getTime() < Date.now() + 31 * 60000
    )
      throw new ConflictException(
        'This reservation is too close to expiry. Cancel it and reserve again.',
      );
    const attempted = await this.orders.updateOne(
      { _id: id, status: 'awaiting_payment' },
      {
        $set: { checkoutAttemptedAt: order.checkoutAttemptedAt ?? new Date() },
      },
    );
    if (!attempted.matchedCount)
      throw new ConflictException(
        'This reservation was cancelled or changed before checkout started.',
      );
    let remote: VerifiedCheckout;
    try {
      remote = await this.gateway.createCheckout(order);
    } catch {
      throw new ServiceUnavailableException(
        'Checkout could not be confirmed. Retry this order; its payment request remains recoverable.',
      );
    }
    if (
      remote.orderId !== order.id ||
      remote.studentId !== user.sub ||
      remote.amountMinor !== order.invoiceSource.totalMinor ||
      remote.currency.toUpperCase() !== order.invoiceSource.currency ||
      remote.livemode !== this.gateway.live
    )
      throw new Error('Created checkout does not match the server order.');
    if (remote.url && new URL(remote.url).hostname !== 'checkout.stripe.com')
      throw new Error('Unexpected checkout destination.');
    // Persist even after cancellation: a lost create response must remain reconcilable.
    await this.orders.updateOne(
      { _id: id, stripeSessionId: { $exists: false } },
      {
        $set: {
          stripeSessionId: remote.id,
          ...(remote.url ? { checkoutUrl: remote.url } : {}),
          nextReconcileAt: new Date(Date.now() + 60000),
        },
      },
    );
    if ((await this.orders.findById(id))?.status === 'cancelled')
      await this.reconcileOrder(id);
    return this.getOrder(user, id);
  }
  async list(
    user: AuthenticatedUser,
    role: 'student' | 'teacher' | 'admin' = 'student',
  ): Promise<BookingOrder[]> {
    if (role === 'admin' && !this.admin(user))
      throw new ForbiddenException('Administrator access required.');
    if (role === 'teacher' && !user.roles.includes('TEACHER'))
      throw new ForbiddenException('Teacher access required.');
    const filter =
      role === 'admin'
        ? {}
        : role === 'teacher'
          ? { teacherId: user.sub }
          : { studentId: user.sub };
    const orders = await this.orders
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100);
    return Promise.all(orders.map((order) => this.view(order, user)));
  }
  async ownedOrder(
    user: AuthenticatedUser,
    id: string,
    studentOnly = false,
  ): Promise<BookingOrderMongo> {
    const order = await this.orders.findById(id);
    if (
      !order ||
      (order.studentId !== user.sub &&
        !this.admin(user) &&
        (studentOnly || order.teacherId !== user.sub))
    )
      throw new NotFoundException('Booking not found.');
    if (studentOnly && order.studentId !== user.sub)
      throw new ForbiddenException('Only the purchaser can start checkout.');
    return order;
  }
  async getOrder(user: AuthenticatedUser, id: string): Promise<BookingOrder> {
    return this.view(await this.ownedOrder(user, id), user);
  }
  async view(
    order: BookingOrderDocument,
    user: AuthenticatedUser,
    preloadedRefunds?: BookingRefundDocument[],
  ): Promise<BookingOrder> {
    const refunds =
      preloadedRefunds ??
      (await this.refunds
        .find({ orderId: order._id })
        .sort({ createdAt: 1 })
        .lean());
    const billingAccess = order.studentId === user.sub || this.admin(user);
    return {
      id: order._id,
      kind: order.kind,
      studentId: order.studentId,
      studentName: order.studentName,
      teacherId: order.teacherId,
      teacherName: order.teacherName,
      title: order.title,
      status: order.status,
      startsAt: order.startsAt.toISOString(),
      endsAt: order.endsAt.toISOString(),
      expiresAt: order.expiresAt.toISOString(),
      cancellationDeadline: order.cancellationDeadline.toISOString(),
      price: {
        amountMinor: order.invoiceSource.totalMinor,
        currency: order.invoiceSource.currency,
      },
      netMinor: order.invoiceSource.netMinor,
      taxMinor: order.invoiceSource.taxMinor,
      taxRateBps: order.invoiceSource.taxRateBps,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString(),
      cancelledAt: order.cancelledAt?.toISOString(),
      slotId: order.slotId,
      batchId: order.batchId,
      sessionId: order.sessionId,
      ...(billingAccess ? { invoiceId: order.invoiceId } : {}),
      ...(order.status === 'awaiting_payment' &&
      order.studentId === user.sub &&
      order.checkoutUrl
        ? { checkoutUrl: order.checkoutUrl }
        : {}),
      refundedMinor: order.refundedMinor,
      refundPendingMinor: order.refundPendingMinor,
      refunds: billingAccess
        ? refunds.map((refund) => ({
            id: refund._id,
            amountMinor: refund.amountMinor,
            currency: order.invoiceSource.currency,
            status: refund.status,
            reason: refund.reason,
            createdAt: refund.createdAt.toISOString(),
            creditNoteId: refund.creditNoteId,
            retryOfRefundId: refund.retryOfRefundId,
          }))
        : [],
      canCancel:
        ['awaiting_payment', 'processing', 'confirmed'].includes(
          order.status,
        ) &&
        (this.admin(user) ||
          user.sub === order.teacherId ||
          (user.sub === order.studentId &&
            (!order.paidAt || order.cancellationDeadline > new Date()))),
      cancellationReason: order.cancellationReason,
    };
  }
  private async release(
    order: BookingOrderMongo,
    session: ClientSession,
  ): Promise<void> {
    if (order.capacityReleased) return;
    if (order.kind === 'lesson')
      await this.slots.updateOne(
        { _id: order.slotId, orderId: order.id, status: 'held' },
        { $set: { status: 'open' }, $unset: { orderId: '' } },
        { session },
      );
    else
      await this.batches.updateOne(
        { _id: order.batchId, paymentReservedCount: { $gt: 0 } },
        { $inc: { paymentReservedCount: -1 } },
        { session },
      );
    order.capacityReleased = true;
  }
  private async cancelEntitlement(
    order: BookingOrderMongo,
    session: ClientSession,
    recordExternalRefund = false,
  ): Promise<void> {
    if (order.sessionId) {
      const lesson = await this.classes
        .findById(order.sessionId)
        .session(session);
      if (lesson?.status === 'live' && !recordExternalRefund)
        throw new ConflictException(
          'End the live lesson before cancelling or fully refunding it.',
        );
      await this.classes.updateOne(
        { _id: order.sessionId, status: 'scheduled' },
        { $set: { status: 'cancelled', cancelledAt: new Date() } },
        { session },
      );
    }
    await this.enrollments.updateMany(
      { paymentOrderId: order.id, status: 'active' },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          updatedBy: 'payment-worker',
        },
      },
      { session },
    );
    if (order.kind === 'lesson' && order.batchId)
      await this.batches.updateOne(
        { _id: order.batchId, isPrivateBooking: true },
        { $set: { status: 'CANCELLED' } },
        { session },
      );
    if (order.slotId)
      await this.slots.updateOne(
        { _id: order.slotId, orderId: order.id },
        { $set: { status: 'cancelled' } },
        { session },
      );
  }
  async cancel(
    user: AuthenticatedUser,
    id: string,
    requestId: string,
    reason: string,
  ): Promise<BookingOrder> {
    reason = reason.trim();
    if (reason.length < 5)
      throw new BadRequestException('Add a useful cancellation reason.');
    const initial = await this.ownedOrder(user, id);
    if (
      initial.status === 'cancelled' ||
      initial.status === 'refunded' ||
      initial.status === 'refund_pending'
    )
      return this.view(initial, user);
    if (
      initial.paidAt &&
      !this.admin(user) &&
      user.sub !== initial.teacherId &&
      initial.cancellationDeadline <= new Date()
    )
      throw new ConflictException(
        'The self-service cancellation deadline has passed. Contact the teacher or support.',
      );
    await this.calendar.transaction(async (session) => {
      const order = await this.orders.findById(id).session(session);
      if (!order) throw new NotFoundException('Booking not found.');
      await this.calendar.lockTeacher(order.teacherId, session);
      if (order.status === 'refunded' || order.status === 'refund_pending')
        return;
      if (
        ![
          'awaiting_payment',
          'processing',
          'confirmed',
          'payment_review',
          'expired',
          'cancelled',
        ].includes(order.status)
      )
        throw new ConflictException('This booking cannot be cancelled.');
      if (order.paidAt) {
        if (
          !this.admin(user) &&
          user.sub !== order.teacherId &&
          order.cancellationDeadline <= new Date()
        )
          throw new ConflictException(
            'The self-service cancellation deadline has passed. Contact the teacher or support.',
          );
        await this.cancelEntitlement(order, session);
        const amount =
          order.invoiceSource.totalMinor -
          order.refundedMinor -
          order.refundPendingMinor;
        if (amount > 0)
          await this.queueRefund(
            order,
            amount,
            requestId,
            reason,
            user.sub,
            session,
          );
        order.status =
          amount > 0
            ? 'refund_pending'
            : order.refundedMinor >= order.invoiceSource.totalMinor
              ? 'refunded'
              : 'cancelled';
      } else {
        order.status = 'cancelled';
        // A possibly-created checkout must be closed before releasing inventory.
        if (!order.checkoutAttemptedAt && !order.stripeSessionId)
          await this.release(order, session);
      }
      order.cancelledAt ??= new Date();
      order.cancellationReason = reason;
      order.nextReconcileAt = new Date();
      await order.save({ session });
    });
    return this.getOrder(user, id);
  }
  private async queueRefund(
    order: BookingOrderMongo,
    amount: number,
    requestId: string,
    reason: string,
    actorId: string,
    session: ClientSession,
    retryOfRefundId?: string,
  ) {
    const existing = await this.refunds
      .findOne({ orderId: order.id, requestId })
      .session(session);
    if (existing) {
      if (existing.amountMinor !== amount)
        throw new ConflictException(
          'Refund request ID already used for another amount.',
        );
      return existing;
    }
    if (
      !order.paymentIntentId ||
      !order.paidAt ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount >
        order.invoiceSource.totalMinor -
          order.refundedMinor -
          order.refundPendingMinor
    )
      throw new ConflictException(
        'Refund exceeds the remaining verified payment.',
      );
    const [refund] = await this.refunds.create(
      [
        {
          orderId: order.id,
          requestId,
          amountMinor: amount,
          currency: order.invoiceSource.currency,
          reason,
          actorId,
          retryOfRefundId,
          status: 'queued',
          nextAttemptAt: new Date(),
        },
      ],
      { session },
    );
    order.refundPendingMinor += amount;
    return refund!;
  }
  async requestRefund(
    user: AuthenticatedUser,
    id: string,
    amount: number,
    requestId: string,
    reason: string,
    retryOfRefundId?: string,
  ): Promise<BookingOrder> {
    reason = reason.trim();
    if (reason.length < 5)
      throw new BadRequestException('Add a useful refund reason.');
    if (!this.admin(user))
      throw new ForbiddenException(
        'Only administrators can issue partial or exceptional refunds.',
      );
    await this.calendar.transaction(async (session) => {
      const order = await this.orders.findById(id).session(session);
      if (!order) throw new NotFoundException('Booking not found.');
      await this.calendar.lockTeacher(order.teacherId, session);
      if (
        await this.refunds
          .exists({ orderId: id, requestId, amountMinor: amount })
          .session(session)
      )
        return;
      if (retryOfRefundId) {
        const original = await this.refunds
          .findOne({
            _id: retryOfRefundId,
            orderId: id,
            status: 'failed',
            amountMinor: amount,
          })
          .session(session);
        if (
          !original ||
          (await this.refunds
            .exists({
              orderId: id,
              retryOfRefundId,
              status: { $in: ['queued', 'pending', 'succeeded'] },
            })
            .session(session))
        )
          throw new ConflictException(
            'This refund already has an active or completed retry.',
          );
      }
      await this.queueRefund(
        order,
        amount,
        requestId,
        reason,
        user.sub,
        session,
        retryOfRefundId,
      );
      if (
        order.refundedMinor + order.refundPendingMinor >=
        order.invoiceSource.totalMinor
      ) {
        await this.cancelEntitlement(order, session);
        order.status = 'refund_pending';
        order.cancelledAt ??= new Date();
        order.cancellationReason = reason;
      }
      await order.save({ session });
    });
    return this.getOrder(user, id);
  }
  async confirmFree(id: string): Promise<void> {
    const order = await this.orders.findById(id);
    if (!order || order.invoiceSource.totalMinor !== 0)
      throw new Error('Only server-priced free orders can skip the gateway.');
    await this.fulfill(id, undefined);
  }
  async verifyPayment(remote: VerifiedCheckout): Promise<void> {
    const order = await this.orders.findOne({ stripeSessionId: remote.id });
    if (!order) {
      // Webhook can beat the checkout response. Server metadata locates only an existing order.
      const pending = await this.orders.findById(remote.orderId);
      if (
        !pending?.checkoutAttemptedAt ||
        pending.studentId !== remote.studentId
      )
        throw new Error('Checkout order is not ready.');
      await this.orders.updateOne(
        { _id: pending.id, stripeSessionId: { $exists: false } },
        { $set: { stripeSessionId: remote.id } },
      );
    }
    const current = order ?? (await this.orders.findById(remote.orderId));
    if (!current) throw new Error('Payment order not found.');
    if (
      current.id !== remote.orderId ||
      current.studentId !== remote.studentId ||
      current.invoiceSource.totalMinor !== remote.amountMinor ||
      current.invoiceSource.currency !== remote.currency.toUpperCase() ||
      remote.livemode !== this.gateway.live ||
      current.stripeSessionId !== remote.id
    ) {
      await this.orders.updateOne(
        { _id: current.id },
        {
          $set: {
            status: 'payment_review',
            reviewReason: 'Gateway session does not match the immutable order.',
          },
        },
      );
      return;
    }
    if (remote.failed) {
      await this.calendar.transaction(async (session) => {
        const failed = await this.orders.findById(current.id).session(session);
        if (!failed || failed.paidAt) return;
        await this.release(failed, session);
        failed.status = 'expired';
        await failed.save({ session });
      });
    } else if (remote.paid && remote.paymentIntentId)
      await this.fulfill(current.id, remote);
    else if (remote.status === 'complete')
      await this.orders.updateOne(
        { _id: current.id, status: 'awaiting_payment' },
        { $set: { status: 'processing' } },
      );
  }
  private async fulfill(id: string, remote?: VerifiedCheckout): Promise<void> {
    await this.calendar.transaction(async (session) => {
      const order = await this.orders.findById(id).session(session);
      if (!order || order.paidAt) return;
      await this.calendar.lockTeacher(order.teacherId, session);
      await this.calendar.lockStudent(order.studentId, session);
      const late =
        !PENDING.includes(order.status) ||
        (order.kind === 'lesson' ? order.startsAt : order.endsAt) <= new Date();
      const source = {
        ...order.invoiceSource,
        paidAt: remote?.paidAt ?? new Date(),
        paymentReference: remote?.paymentIntentId ?? 'free-' + id,
      };
      order.invoiceSource = source;
      order.paymentIntentId = remote?.paymentIntentId;
      order.paidAt = source.paidAt;
      order.invoiceId = await this.billing.invoice(source, session);
      const teacherAvailable = await this.users
        .exists({
          _id: order.teacherId,
          roles: 'TEACHER',
          status: 'active',
          disabled: { $ne: true },
          deletedAt: { $exists: false },
          tutorReviewStatus: 'approved',
        })
        .session(session);
      const studentAvailable = await this.users
        .exists({
          _id: order.studentId,
          roles: 'STUDENT',
          status: 'active',
          disabled: { $ne: true },
          deletedAt: { $exists: false },
        })
        .session(session);
      let canFulfill = !late && Boolean(teacherAvailable && studentAvailable);
      if (order.kind === 'lesson') {
        const slot = await this.slots
          .findOne({ _id: order.slotId, status: 'held', orderId: id })
          .session(session);
        if (!slot || order.capacityReleased) canFulfill = false;
      } else {
        const batch = await this.batches
          .findOne({
            _id: order.batchId,
            status: 'ACTIVE',
            deletedAt: { $exists: false },
          })
          .session(session);
        if (!batch || order.capacityReleased) canFulfill = false;
      }
      if (canFulfill) {
        if (order.kind === 'lesson') {
          const batchId = 'booking-' + id,
            sessionId = 'lesson-' + id;
          await this.batches.create(
            [
              {
                _id: batchId,
                name: `${order.title.slice(0, 70)} · ${id}`,
                teacherId: order.teacherId,
                year: order.startsAt.getUTCFullYear(),
                startDate: order.startsAt,
                endDate: order.endsAt,
                maxCapacity: 1,
                feeAmount: minorToMajor(source.netMinor, source.currency),
                feeMinor: source.netMinor,
                feeCurrency: source.currency,
                status: 'ACTIVE',
                isPrivateBooking: true,
                bookingOrderId: id,
                scheduleTimezone: 'UTC',
              },
            ],
            { session },
          );
          await this.classes.create(
            [
              {
                _id: sessionId,
                batchId,
                teacherId: order.teacherId,
                title: order.title,
                sessionNumber: 1,
                scheduledAt: order.startsAt,
                durationMinutes:
                  (order.endsAt.getTime() - order.startsAt.getTime()) / 60000,
                status: 'scheduled',
                ...this.calendar.channelIds(sessionId),
              },
            ],
            { session },
          );
          await this.slots.updateOne(
            { _id: order.slotId, status: 'held', orderId: id },
            { $set: { status: 'booked' } },
            { session },
          );
          order.batchId = batchId;
          order.sessionId = sessionId;
          order.capacityReleased = true;
        } else await this.release(order, session);
        if (
          await this.enrollments
            .exists({
              studentId: order.studentId,
              batchId: order.batchId,
              status: 'active',
              deletedAt: { $exists: false },
            })
            .session(session)
        )
          canFulfill = false;
        else
          await this.enrollments.create(
            [
              {
                studentId: order.studentId,
                studentName: order.studentName,
                studentEmail: source.billing.email,
                batchId: order.batchId,
                batchName: order.title,
                teacherId: order.teacherId,
                status: 'active',
                enrolledAt: new Date(),
                createdBy: 'verified-payment',
                paymentOrderId: id,
              },
            ],
            { session },
          );
      }
      if (canFulfill) order.status = 'confirmed';
      else {
        await this.release(order, session);
        order.status = source.totalMinor > 0 ? 'refund_pending' : 'cancelled';
        order.cancelledAt ??= new Date();
        order.cancellationReason =
          'Payment arrived after the reservation became unavailable.';
        if (source.totalMinor > 0)
          await this.queueRefund(
            order,
            source.totalMinor,
            'automatic-unavailable-' + id,
            order.cancellationReason,
            systemActor.sub,
            session,
          );
      }
      await order.save({ session });
    });
  }
  async reconcileOrder(id: string): Promise<void> {
    let order = await this.orders.findById(id);
    if (!order || order.paidAt || order.capacityReleased) return;
    if (!order.stripeSessionId && order.checkoutAttemptedAt) {
      const recovered = await this.gateway.recoverCheckout(order);
      if (!recovered) {
        await this.orders.updateOne(
          { _id: id },
          { $unset: { checkoutAttemptedAt: '' } },
        );
      } else
        await this.orders.updateOne(
          { _id: id, stripeSessionId: { $exists: false } },
          {
            $set: {
              stripeSessionId: recovered.id,
              ...(recovered.url ? { checkoutUrl: recovered.url } : {}),
            },
          },
        );
      order = (await this.orders.findById(id))!;
    }
    if (order.stripeSessionId) {
      let remote = await this.gateway.retrieveCheckout(order.stripeSessionId);
      if (remote.paid || remote.status === 'complete') {
        await this.verifyPayment(remote);
        return;
      }
      if (order.status === 'cancelled' || order.expiresAt <= new Date()) {
        if (remote.status === 'open') {
          await this.gateway.expireCheckout(remote.id);
          remote = await this.gateway.retrieveCheckout(remote.id);
        }
        if (remote.paid) {
          await this.verifyPayment(remote);
          return;
        }
        if (remote.status !== 'expired') return;
      } else return;
    } else if (order.expiresAt > new Date() && order.status !== 'cancelled')
      return;
    await this.calendar.transaction(async (session) => {
      const current = await this.orders.findById(id).session(session);
      if (!current || current.paidAt || current.capacityReleased) return;
      await this.calendar.lockTeacher(current.teacherId, session);
      await this.release(current, session);
      if (current.status !== 'cancelled') current.status = 'expired';
      await current.save({ session });
    });
  }
  async failUnsubmittedRefund(id: string, leaseToken: string): Promise<void> {
    await this.calendar.transaction(async (session) => {
      const refund = await this.refunds
        .findOne({
          _id: id,
          leaseToken,
          status: 'queued',
          stripeRefundId: { $exists: false },
        })
        .session(session);
      if (!refund) return;
      const order = await this.orders.findById(refund.orderId).session(session);
      if (!order) throw new Error('Refund order not found.');
      await this.calendar.lockTeacher(order.teacherId, session);
      refund.status = 'failed';
      refund.leaseToken = undefined;
      refund.leaseUntil = undefined;
      await refund.save({ session });
      const pending = await this.refunds
        .find({ orderId: order.id, status: { $in: ['queued', 'pending'] } })
        .session(session);
      order.refundPendingMinor = pending.reduce(
        (sum, item) => sum + item.amountMinor,
        0,
      );
      if (order.status === 'refund_pending' && order.refundPendingMinor === 0)
        order.status =
          order.refundedMinor >= order.invoiceSource.totalMinor
            ? 'refunded'
            : order.cancelledAt
              ? 'cancelled'
              : 'confirmed';
      await order.save({ session });
    });
  }
  async syncRefund(remote: VerifiedRefund): Promise<void> {
    await this.calendar.transaction(async (session) => {
      const order = await this.orders
        .findOne({ paymentIntentId: remote.paymentIntentId })
        .session(session);
      if (!order) return;
      await this.calendar.lockTeacher(order.teacherId, session);
      if (
        remote.currency.toUpperCase() !== order.invoiceSource.currency ||
        !Number.isSafeInteger(remote.amountMinor) ||
        remote.amountMinor < 1 ||
        remote.amountMinor > order.invoiceSource.totalMinor
      )
        throw new Error('Refund does not match the original payment.');
      let refund = await this.refunds
        .findOne({ stripeRefundId: remote.id })
        .session(session);
      if (!refund && remote.requestId)
        refund = await this.refunds
          .findOne({ _id: remote.requestId, orderId: order.id })
          .session(session);
      if (
        refund &&
        (refund.amountMinor !== remote.amountMinor ||
          refund.currency !== order.invoiceSource.currency)
      )
        throw new Error('Refund amount does not match the saved request.');
      if (!refund) {
        const [created] = await this.refunds.create(
          [
            {
              orderId: order.id,
              requestId: 'external-' + remote.id,
              amountMinor: remote.amountMinor,
              currency: order.invoiceSource.currency,
              reason: 'Refund recorded by the payment provider.',
              actorId: 'stripe',
              status: 'pending',
              stripeRefundId: remote.id,
            },
          ],
          { session },
        );
        refund = created!;
      }
      if (refund.status === 'succeeded') return;
      refund.stripeRefundId = remote.id;
      refund.status =
        remote.status === 'succeeded'
          ? 'succeeded'
          : remote.status === 'failed'
            ? 'failed'
            : 'pending';
      await refund.save({ session });
      const all = await this.refunds
        .find({ orderId: order.id })
        .session(session);
      order.refundedMinor = all
        .filter((item) => item.status === 'succeeded')
        .reduce((sum, item) => sum + item.amountMinor, 0);
      if (order.refundedMinor > order.invoiceSource.totalMinor)
        throw new Error('Verified refunds exceed the original payment.');
      // Provider refunds can arrive outside the app. Retain their truth and release
      // unsent local requests that no longer fit the remaining refundable balance.
      let available =
        order.invoiceSource.totalMinor -
        all
          .filter(
            (item) =>
              item.status === 'succeeded' ||
              item.status === 'pending' ||
              (item.status === 'queued' && item.attempts > 0),
          )
          .reduce((sum, item) => sum + item.amountMinor, 0);
      for (const item of all.filter(
        (item) => item.status === 'queued' && item.attempts === 0,
      )) {
        if (item.amountMinor > available) {
          item.status = 'failed';
          await item.save({ session });
        } else available -= item.amountMinor;
      }
      order.refundPendingMinor = all
        .filter((item) => item.status === 'queued' || item.status === 'pending')
        .reduce((sum, item) => sum + item.amountMinor, 0);
      if (refund.status === 'succeeded')
        refund.creditNoteId = await this.billing.credit(order, refund, session);
      if (order.refundedMinor >= order.invoiceSource.totalMinor) {
        await this.cancelEntitlement(order, session, true);
        order.status = 'refunded';
      } else if (order.status === 'refund_pending' && !order.refundPendingMinor)
        order.status = order.cancelledAt ? 'cancelled' : 'confirmed';
      await refund.save({ session });
      await order.save({ session });
    });
  }
}
