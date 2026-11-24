import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  RawBodyRequest,
  Req,
  StreamableFile,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { BookingsService } from './bookings.service';
import { BookingWorkerService } from './booking-worker.service';
import {
  BookingCancellationDto,
  BookingRefundDto,
  BookingReserveDto,
  LessonOfferDto,
  LessonSlotDto,
} from './booking.dto';

@Controller({ path: 'bookings', version: '1' })
export class BookingsPublicController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly worker: BookingWorkerService,
  ) {}
  @Get('configuration') configuration() {
    return this.bookings.configuration();
  }
  @Get('teachers/:teacherId/catalogue') catalogue(
    @Param('teacherId') id: string,
  ) {
    return this.bookings.catalogue(id);
  }
  @Get('batches/:batchId') batch(@Param('batchId') id: string) {
    return this.bookings.batchCatalogue(id);
  }
  @Post('stripe/webhook')
  @HttpCode(200)
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (
      !request.rawBody ||
      typeof signature !== 'string' ||
      signature.length > 2048
    )
      throw new BadRequestException('A signed payment event is required.');
    try {
      return this.worker.receive(request.rawBody, signature);
    } catch {
      throw new BadRequestException('Invalid payment signature.');
    }
  }
}

@Controller({ path: 'bookings', version: '1' })
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}
  @Post('slots/:id/reserve') reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: BookingReserveDto,
  ) {
    return this.bookings.reserveSlot(user, id, body);
  }
  @Post('batches/:id/reserve') reserveBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: BookingReserveDto,
  ) {
    return this.bookings.reserveBatch(user, id, body);
  }
  @Get('orders') list(@CurrentUser() user: AuthenticatedUser) {
    return this.bookings.list(user);
  }
  @Get('orders/:id') get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.getOrder(user, id);
  }
  @Post('orders/:id/refresh-payment')
  async refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.bookings.ownedOrder(user, id, true);
    await this.bookings.reconcileOrder(id);
    return this.bookings.getOrder(user, id);
  }
  @Post('orders/:id/checkout') checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.checkout(user, id);
  }
  @Post('orders/:id/cancel') cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: BookingCancellationDto,
  ) {
    return this.bookings.cancel(user, id, body.requestId, body.reason);
  }
  @Get('orders/:id/invoice')
  async invoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res({ passthrough: true })
    response: { setHeader(key: string, value: string): void },
  ) {
    const order = await this.bookings.ownedOrder(user, id);
    if (
      order.studentId !== user.sub &&
      !user.roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN')
    )
      throw new ForbiddenException(
        'Billing document access is restricted to the purchaser.',
      );
    if (!order.invoiceId)
      throw new BadRequestException(
        'The verified payment invoice is not ready.',
      );
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="invoice-${id}.pdf"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(await this.bookings.billing.pdf(order.invoiceId));
  }
  @Get('orders/:id/credits/:creditId')
  async credit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('creditId') creditId: string,
    @Res({ passthrough: true })
    response: { setHeader(key: string, value: string): void },
  ) {
    const order = await this.bookings.ownedOrder(user, id);
    if (
      order.studentId !== user.sub &&
      !user.roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN')
    )
      throw new ForbiddenException(
        'Billing document access is restricted to the purchaser.',
      );
    if (
      !(await this.bookings.refunds.exists({
        orderId: id,
        creditNoteId: creditId,
        status: 'succeeded',
      }))
    )
      throw new BadRequestException('Credit note not found for this booking.');
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="credit-${id}.pdf"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(await this.bookings.billing.creditPdf(creditId));
  }
}

@Controller({ path: 'bookings/teacher', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TeacherBookingsController {
  constructor(private readonly bookings: BookingsService) {}
  @Get('availability') availability(@CurrentUser() user: AuthenticatedUser) {
    return this.bookings.teacherAvailability(user);
  }
  @Post('offers') offer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LessonOfferDto,
  ) {
    return this.bookings.saveOffer(user, body);
  }
  @Patch('offers/:id') edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: LessonOfferDto,
  ) {
    return this.bookings.saveOffer(user, body, id);
  }
  @Post('slots') slot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LessonSlotDto,
  ) {
    return this.bookings.publishSlot(user, body);
  }
  @Delete('slots/:id') withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.withdrawSlot(user, id);
  }
  @Get('orders') list(@CurrentUser() user: AuthenticatedUser) {
    return this.bookings.list(user, 'teacher');
  }
}

@Controller({ path: 'admin/bookings', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminBookingsController {
  constructor(private readonly bookings: BookingsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) {
    return this.bookings.list(user, 'admin');
  }
  @Post(':id/refunds') refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: BookingRefundDto,
  ) {
    return this.bookings.requestRefund(
      user,
      id,
      body.amountMinor,
      body.requestId,
      body.reason,
    );
  }
}
