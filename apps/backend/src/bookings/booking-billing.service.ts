import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import {
  invoiceTotals,
  type BookingInvoiceSource,
  type InvoiceRecord,
  type InvoiceSettings,
} from '@native-sfu/contracts';
import {
  InvoiceCounterDocument,
  InvoiceDocument,
  InvoiceSettingsDocument,
} from '../invoices/invoice.schema';
import { renderInvoicePdf } from '../invoices/invoice-pdf';
import {
  BookingCreditNoteDocument,
  BookingOrderDocument,
  BookingRefundDocument,
} from './booking.schema';

@Injectable()
export class BookingBillingService {
  constructor(
    @InjectModel(InvoiceDocument.name)
    private readonly invoices: Model<InvoiceDocument>,
    @InjectModel(InvoiceSettingsDocument.name)
    private readonly settings: Model<InvoiceSettingsDocument>,
    @InjectModel(InvoiceCounterDocument.name)
    private readonly counters: Model<InvoiceCounterDocument>,
    @InjectModel(BookingCreditNoteDocument.name)
    private readonly credits: Model<BookingCreditNoteDocument>,
  ) {}
  async issuer(): Promise<InvoiceSettings> {
    const record = await this.settings.findById('issuer').lean();
    const value = record?.value;
    if (
      !value ||
      value.version < 1 ||
      value.seller.name.trim().length < 2 ||
      value.seller.address.trim().length < 5 ||
      !value.seller.email ||
      /@example\.(com|org|net)$/.test(value.seller.email)
    )
      throw new ServiceUnavailableException(
        'The business must configure its invoice issuer before accepting bookings.',
      );
    return value;
  }
  async invoice(
    source: BookingInvoiceSource,
    session: ClientSession,
  ): Promise<string> {
    const id = 'booking-' + source.orderId;
    if (await this.invoices.exists({ _id: id }).session(session)) return id;
    const year = source.paidAt.getUTCFullYear().toString();
    const count = await this.counters.findOneAndUpdate(
      { _id: year },
      { $inc: { next: 1 } },
      { upsert: true, new: true, session },
    );
    const date = source.paidAt.toISOString().slice(0, 10);
    const input = {
      customer: source.billing,
      invoiceDate: date,
      dueDate: date,
      supplyDate: source.startsAt.slice(0, 10),
      currency: source.currency,
      lines: [
        {
          description: source.title,
          quantityMilli: 1000,
          unitPriceMinor: source.netMinor,
          taxRateBps: source.taxRateBps,
        },
      ],
      taxNote: source.taxNote,
      notes: '',
      reference: source.orderId,
    };
    const totals = invoiceTotals(input.lines);
    if (
      totals.totalMinor !== source.totalMinor ||
      totals.taxMinor !== source.taxMinor
    )
      throw new Error('Order and invoice totals do not match.');
    const number = `INV-${year}-${String(count!.next).padStart(6, '0')}`;
    const pdf = await renderInvoicePdf({
      ...input,
      id,
      version: 1,
      status: 'paid',
      seller: source.seller,
      totals,
      number,
      createdAt: source.paidAt.toISOString(),
      issuedAt: source.paidAt.toISOString(),
      paidAt: source.paidAt.toISOString(),
      paymentReference: source.paymentReference,
      emailAttempts: [],
    });
    await this.invoices.create(
      [
        {
          _id: id,
          pdf,
          orderId: source.orderId,
          input,
          seller: source.seller,
          totals,
          status: 'paid',
          version: 1,
          number,
          createdBy: source.studentId,
          issuedAt: source.paidAt,
          paidAt: source.paidAt,
          paymentReference: source.paymentReference,
          paymentEmail: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
          emailAttempts: [],
        },
      ],
      { session },
    );
    return id;
  }
  async credit(
    order: BookingOrderDocument,
    refund: BookingRefundDocument,
    session: ClientSession,
  ): Promise<string> {
    const id = 'refund-' + refund._id;
    if (await this.credits.exists({ _id: id }).session(session)) return id;
    const original = await this.invoices
      .findById(order.invoiceId)
      .session(session)
      .lean();
    if (!original) throw new Error('Paid invoice not ready for credit note.');
    const year = new Date().getUTCFullYear().toString();
    const count = await this.counters.findOneAndUpdate(
      { _id: 'CN-' + year },
      { $inc: { next: 1 } },
      { new: true, upsert: true, session },
    );
    const previous = await this.credits
      .find({ orderId: order._id })
      .session(session)
      .lean();
    const taxAlready = previous.reduce(
      (sum, note) => sum + note.value.totals.taxMinor,
      0,
    );
    const priorGross = previous.reduce(
      (sum, note) => sum + note.value.totals.totalMinor,
      0,
    );
    // Round the cumulative tax credit, then subtract prior credits; final refund closes exactly.
    const cumulative =
      BigInt(priorGross + refund.amountMinor) *
      BigInt(original.totals.taxMinor);
    const divisor = BigInt(original.totals.totalMinor || 1);
    const taxMinor =
      Number((cumulative * 2n + divisor) / (divisor * 2n)) - taxAlready;
    const netMinor = refund.amountMinor - taxMinor;
    const date = new Date().toISOString().slice(0, 10);
    const value: InvoiceRecord = {
      ...original.input,
      id,
      version: 1,
      status: 'paid',
      seller: original.seller,
      number: `CN-${year}-${String(count!.next).padStart(6, '0')}`,
      createdAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      emailAttempts: [],
      invoiceDate: date,
      dueDate: date,
      reference: original.number ?? order.invoiceId ?? '',
      notes: refund.reason,
      lines: [
        {
          description: `Refund — ${order.title}`,
          quantityMilli: 1000,
          unitPriceMinor: netMinor,
          taxRateBps: order.invoiceSource.taxRateBps,
        },
      ],
      totals: {
        subtotalMinor: netMinor,
        taxMinor,
        totalMinor: refund.amountMinor,
        lines: [{ netMinor, taxMinor, totalMinor: refund.amountMinor }],
        taxes: [
          { rateBps: order.invoiceSource.taxRateBps, netMinor, taxMinor },
        ],
      },
    };
    await this.credits.create(
      [{ _id: id, orderId: order._id, invoiceId: order.invoiceId, value }],
      { session },
    );
    return id;
  }
  async pdf(invoiceId: string): Promise<Buffer> {
    const invoice = await this.invoices.findById(invoiceId);
    if (!invoice) throw new Error('Invoice not found.');
    if (invoice.pdf) return Buffer.from(invoice.pdf);
    const value: InvoiceRecord = {
      ...invoice.input,
      id: invoice._id,
      version: invoice.version,
      status: 'paid',
      seller: invoice.seller,
      totals: invoice.totals,
      number: invoice.number,
      createdAt: invoice.createdAt.toISOString(),
      paidAt: invoice.paidAt?.toISOString(),
      paymentReference: invoice.paymentReference,
      issuedAt: invoice.issuedAt?.toISOString(),
      emailAttempts: [],
    };
    const bytes = await renderInvoicePdf(value);
    await this.invoices.updateOne(
      { _id: invoiceId, pdf: { $exists: false } },
      { $set: { pdf: bytes } },
    );
    return bytes;
  }
  async creditPdf(id: string): Promise<Buffer> {
    const credit = await this.credits.findById(id);
    if (!credit) throw new Error('Credit note not found.');
    if (credit.pdf) return Buffer.from(credit.pdf);
    const bytes = await renderInvoicePdf(credit.value, 'credit_note');
    await this.credits.updateOne(
      { _id: id, pdf: { $exists: false } },
      { $set: { pdf: bytes } },
    );
    return bytes;
  }
}
