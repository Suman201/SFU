import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  invoiceTotals,
  type InvoiceInput,
  type InvoiceRecord,
  type InvoiceSettings,
} from '@native-sfu/contracts';
import {
  InvoiceDocument,
  InvoiceCounterDocument,
  InvoiceSettingsDocument,
  type InvoiceMongo,
} from './invoice.schema';
import {
  InvoiceWriteDto,
  InvoiceSettingsDto,
  InvoicePaymentDto,
  InvoiceVoidDto,
} from './invoice.dto';
import { renderInvoicePdf } from './invoice-pdf';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const DEFAULT_SETTINGS: InvoiceSettings = {
  version: 0,
  defaultCurrency: 'EUR',
  defaultTaxNote: 'No VAT charged.',
  seller: {
    name: 'Sapiovian Learning Ltd',
    email: 'billing@example.com',
    address: '12 Example Street\nDublin, D02 EX00\nIreland',
    countryCode: 'IE',
    vatNumber: '',
    registrationNumber: '',
    paymentInstructions:
      'Please quote the invoice number when making your payment.',
  },
};
@Injectable()
export class InvoicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoicesService.name);
  private emailTimer?: NodeJS.Timeout;
  private emailBusy = false;
  constructor(
    @InjectModel(InvoiceDocument.name)
    private readonly invoices: Model<InvoiceMongo>,
    @InjectModel(InvoiceSettingsDocument.name)
    private readonly config: Model<InvoiceSettingsDocument>,
    @InjectModel(InvoiceCounterDocument.name)
    private readonly counters: Model<InvoiceCounterDocument>,
    private readonly email: EmailNotificationService,
    private readonly audit: AuditLogsService,
    private readonly environment: ConfigService,
  ) {}
  private record(doc: InvoiceMongo): InvoiceRecord {
    return {
      id: doc.id,
      version: doc.version,
      status: doc.status as InvoiceRecord['status'],
      number: doc.number,
      ...doc.input,
      seller: doc.seller,
      totals: doc.totals,
      createdAt: doc.createdAt.toISOString(),
      issuedAt: doc.issuedAt?.toISOString(),
      paidAt: doc.paidAt?.toISOString(),
      paymentReference: doc.paymentReference,
      voidReason: doc.voidReason,
      emailAttempts: doc.emailAttempts,
      paymentEmail: doc.paymentEmail
        ? {
            status: doc.paymentEmail.status,
            attempts: doc.paymentEmail.attempts,
          }
        : undefined,
    };
  }
  private async doc(id: string) {
    const doc = await this.invoices.findById(id).exec();
    if (!doc) throw new NotFoundException('Invoice not found.');
    return doc;
  }
  private event(actor: AuthenticatedUser, action: string, doc: InvoiceMongo) {
    return this.audit.record({
      actor,
      action: `invoice.${action}`,
      resourceType: 'invoice',
      resourceId: doc.id,
      resourceLabel: doc.number || 'Draft invoice',
      metadata: {
        status: doc.status,
        currency: doc.input.currency,
        totalMinor: doc.totals.totalMinor,
      },
    });
  }
  async settings() {
    const record = await this.config
      .findOneAndUpdate(
        { _id: 'issuer' },
        { $setOnInsert: { value: DEFAULT_SETTINGS } },
        { upsert: true, new: true },
      )
      .exec();
    return record!.value;
  }
  private cleanParty<T extends InvoiceInput['customer']>(party: T): T {
    return Object.fromEntries(
      Object.entries(party).map(([k, v]) => [
        k,
        typeof v === 'string'
          ? ['name', 'vatNumber', 'registrationNumber'].includes(k)
            ? v.trim().replace(/\s+/g, ' ')
            : v.trim()
          : v,
      ]),
    ) as T;
  }
  async saveSettings(input: InvoiceSettingsDto, actor: AuthenticatedUser) {
    const current = await this.settings();
    if (current.version !== input.version)
      throw new ConflictException(
        'Invoice settings changed. Reload and try again.',
      );
    const value: InvoiceSettings = {
      ...input,
      seller: this.cleanParty(input.seller),
      version: input.version + 1,
    };
    this.requireParty(value.seller);
    if (value.seller.paymentInstructions.split('\n').length > 15)
      throw new BadRequestException(
        'Keep payment instructions to at most 15 lines.',
      );
    const saved = await this.config
      .findOneAndUpdate(
        { _id: 'issuer', 'value.version': input.version },
        { $set: { value } },
        { new: true },
      )
      .exec();
    if (!saved)
      throw new ConflictException(
        'Invoice settings changed. Reload and try again.',
      );
    await this.audit.record({
      actor,
      action: 'invoice.settings_updated',
      resourceType: 'invoice_settings',
    });
    return saved.value;
  }
  private requireParty(party: InvoiceInput['customer']) {
    if (
      party.name.trim().length < 2 ||
      party.address.trim().length < 5 ||
      party.address.split('\n').length > 8
    )
      throw new BadRequestException('Add the full billing name and address.');
  }
  private validDate(value: string) {
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    );
  }
  private payload(input: InvoiceWriteDto): InvoiceInput {
    if (
      ![input.invoiceDate, input.dueDate, input.supplyDate].every((value) =>
        this.validDate(value),
      )
    )
      throw new BadRequestException('Use valid invoice, due and supply dates.');
    if (input.dueDate < input.invoiceDate)
      throw new BadRequestException(
        'The due date cannot be before the invoice date.',
      );
    this.requireParty(input.customer);
    const value: InvoiceInput = {
      customer: this.cleanParty(input.customer),
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      supplyDate: input.supplyDate,
      currency: input.currency,
      lines: input.lines.map((line) => ({
        ...line,
        description: line.description.trim().replace(/\s+/g, ' '),
      })),
      taxNote: input.taxNote.trim(),
      notes: input.notes.trim(),
      reference: input.reference.trim().replace(/\s+/g, ' '),
    };
    if (
      value.notes.split('\n').length > 20 ||
      value.taxNote.split('\n').length > 12
    )
      throw new BadRequestException(
        'Keep notes to at most 20 lines and tax information to at most 12 lines.',
      );
    if (value.lines.some((line) => line.description.length < 2))
      throw new BadRequestException(
        'Add a useful description for each invoice item.',
      );
    try {
      invoiceTotals(value.lines);
    } catch {
      throw new BadRequestException(
        'Check invoice quantities, prices and tax rates.',
      );
    }
    return value;
  }
  async list(query: Record<string, string>) {
    const page = Math.max(
      1,
      Math.min(10000, Math.floor(Number(query.page) || 1)),
    );
    const limit = 25;
    const filter: Record<string, unknown> = {};
    if (['draft', 'issued', 'paid', 'void'].includes(query.status || ''))
      filter.status = query.status;
    if (query.q?.trim()) {
      const q = query.q
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { number: { $regex: q, $options: 'i' } },
        { 'input.customer.name': { $regex: q, $options: 'i' } },
        { 'input.customer.email': { $regex: q, $options: 'i' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.invoices
        .find(filter)
        .select('-pdf -voidPdf')
        .sort({ createdAt: -1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.invoices.countDocuments(filter).exec(),
    ]);
    return { items: items.map((doc) => this.record(doc)), total, page, limit };
  }
  async get(id: string) {
    return this.record(await this.doc(id));
  }
  async create(input: InvoiceWriteDto, actor: AuthenticatedUser) {
    const payload = this.payload(input);
    const settings = await this.settings();
    const doc = await this.invoices.create({
      input: payload,
      seller: settings.seller,
      totals: invoiceTotals(payload.lines),
      createdBy: actor.sub,
    });
    await this.event(actor, 'created', doc);
    return this.record(doc);
  }
  async update(id: string, input: InvoiceWriteDto, actor: AuthenticatedUser) {
    if (input.version === undefined)
      throw new BadRequestException(
        'The current draft version is required. Reload before saving.',
      );
    const payload = this.payload(input);
    const settings = await this.settings();
    const doc = await this.invoices
      .findOneAndUpdate(
        { _id: id, status: 'draft', version: input.version },
        {
          $set: {
            input: payload,
            seller: settings.seller,
            totals: invoiceTotals(payload.lines),
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .exec();
    if (!doc)
      throw new ConflictException(
        'Only the current draft can be edited. Reload the invoice.',
      );
    await this.event(actor, 'updated', doc);
    return this.record(doc);
  }
  async issue(id: string, version: number, actor: AuthenticatedUser) {
    const draft = await this.doc(id);
    if (draft.status !== 'draft' || draft.version !== version)
      throw new ConflictException('Only the current draft can be issued.');
    const settings = await this.settings();
    this.requireParty(settings.seller);
    if (
      draft.input.lines.some((line) => line.taxRateBps === 0) &&
      draft.input.taxNote.length < 4
    )
      throw new BadRequestException(
        'Explain the zero tax treatment in Tax information before issuing.',
      );
    if (draft.totals.taxMinor > 0 && !settings.seller.vatNumber)
      throw new BadRequestException(
        'Add the seller VAT/tax registration number in invoice settings before charging tax.',
      );
    const counter = await this.counters
      .findOneAndUpdate(
        { _id: draft.input.invoiceDate.slice(0, 4) },
        { $inc: { next: 1 } },
        { new: true, upsert: true },
      )
      .exec();
    const number = `INV-${draft.input.invoiceDate.slice(0, 4)}-${String(counter!.next).padStart(6, '0')}`;
    const issuedAt = new Date();
    const view = {
      ...this.record(draft),
      seller: settings.seller,
      status: 'issued' as const,
      number,
      issuedAt: issuedAt.toISOString(),
    };
    const pdf = await renderInvoicePdf(view);
    const doc = await this.invoices
      .findOneAndUpdate(
        { _id: id, status: 'draft', version },
        {
          $set: {
            number,
            seller: settings.seller,
            pdf,
            issuedAt,
            status: 'issued',
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .exec();
    if (!doc)
      throw new ConflictException('The draft changed. Reload before issuing.');
    await this.event(actor, 'issued', doc);
    return this.record(doc);
  }
  async pdf(id: string) {
    const doc = await this.doc(id);
    return {
      bytes:
        doc.status === 'void' && doc.voidPdf
          ? Buffer.from(doc.voidPdf)
          : doc.pdf
            ? Buffer.from(doc.pdf)
            : await renderInvoicePdf(this.record(doc)),
      name: `${doc.number || 'invoice-draft'}.pdf`,
    };
  }
  async paid(id: string, input: InvoicePaymentDto, actor: AuthenticatedUser) {
    if (
      !this.validDate(input.paidDate) ||
      input.paidDate > new Date().toISOString().slice(0, 10) ||
      input.reference.trim().length < 3
    )
      throw new BadRequestException('Add a valid payment date and reference.');
    const doc = await this.invoices
      .findOneAndUpdate(
        { _id: id, status: 'issued', version: input.version },
        {
          $set: {
            status: 'paid',
            paidAt: new Date(input.paidDate),
            paymentReference: input.reference.trim(),
            paymentEmail: {
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date(),
            },
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .exec();
    if (!doc)
      throw new ConflictException(
        'Only a current issued invoice can have a payment recorded.',
      );
    await this.event(actor, 'payment_recorded', doc);
    await this.processAutomaticEmails(id, actor).catch(() =>
      this.logger.error('Automatic invoice email is queued for retry.'),
    );
    return this.get(id);
  }
  async void(id: string, input: InvoiceVoidDto, actor: AuthenticatedUser) {
    if (input.reason.trim().length < 10)
      throw new BadRequestException(
        'Add a useful reason for voiding the invoice.',
      );
    const current = await this.doc(id);
    if (
      !['draft', 'issued'].includes(current.status) ||
      current.version !== input.version
    )
      throw new ConflictException(
        'Only an unpaid invoice can be voided. Reload the invoice.',
      );
    const voidPdf = await renderInvoicePdf({
      ...this.record(current),
      status: 'void',
      voidReason: input.reason.trim(),
    });
    const doc = await this.invoices
      .findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['draft', 'issued'] },
          version: input.version,
          $or: [
            { emailLeaseUntil: { $exists: false } },
            { emailLeaseUntil: { $lte: new Date() } },
          ],
        },
        {
          $set: { status: 'void', voidReason: input.reason.trim(), voidPdf },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .exec();
    if (!doc)
      throw new ConflictException(
        'The invoice changed or an email is being sent. Reload and try again.',
      );
    await this.event(actor, 'voided', doc);
    return this.record(doc);
  }
  async send(id: string, requestId: string, actor: AuthenticatedUser) {
    const now = new Date();
    await this.invoices
      .updateOne(
        { _id: id, emailLeaseUntil: { $lte: now } },
        {
          $set: {
            'emailAttempts.$[pending].status': 'failed',
            'emailAttempts.$[pending].completedAt': now.toISOString(),
          },
          $unset: { emailLeaseToken: '', emailLeaseUntil: '' },
        },
        { arrayFilters: [{ 'pending.status': 'sending' }] },
      )
      .exec();
    const current = await this.doc(id);
    if (!['issued', 'paid'].includes(current.status))
      throw new BadRequestException(
        'Issue the invoice before sending it. Voided invoices cannot be sent.',
      );
    if (
      current.emailAttempts.some((attempt) => attempt.requestId === requestId)
    )
      return this.record(current);
    const lease = randomUUID();
    const doc = await this.invoices
      .findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['issued', 'paid'] },
          'emailAttempts.requestId': { $ne: requestId },
          $or: [
            { emailLeaseUntil: { $exists: false } },
            { emailLeaseUntil: { $lte: now } },
          ],
        },
        {
          $set: {
            emailLeaseToken: lease,
            emailLeaseUntil: new Date(Date.now() + 120_000),
          },
          $push: {
            emailAttempts: {
              requestId,
              status: 'sending',
              at: now.toISOString(),
            },
          },
        },
        { new: true },
      )
      .exec();
    if (!doc)
      throw new ConflictException(
        'An invoice email is already being sent. Reload before trying again.',
      );
    let status: 'sent' | 'failed' | 'disabled' = 'failed';
    try {
      const amount = new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: doc.input.currency,
      }).format(doc.totals.totalMinor / 100);
      const delivered = await this.email.sendEmail({
        to: doc.input.customer.email,
        replyTo: doc.seller.email,
        subject: `Invoice ${doc.number} from ${doc.seller.name}`,
        text: `Hello ${doc.input.customer.name},\n\nPlease find invoice ${doc.number} attached.\nTotal: ${amount}\n${doc.status === 'paid' ? 'Payment recorded on ' + doc.paidAt?.toISOString().slice(0, 10) + '.' : 'Due date: ' + doc.input.dueDate}\n\n${doc.status === 'paid' ? 'Amount due: 0.00 ' + doc.input.currency : doc.seller.paymentInstructions}\n\n${doc.seller.name}`,
        attachments: [
          {
            filename: `${doc.number}.pdf`,
            content: Buffer.from(doc.pdf!),
            contentType: 'application/pdf',
          },
        ],
      });
      status =
        delivered.delivered > 0
          ? 'sent'
          : delivered.skipped > 0 && !delivered.errors.length
            ? 'disabled'
            : 'failed';
    } catch {
      status = 'failed';
    }
    const saved = await this.invoices
      .findOneAndUpdate(
        {
          _id: id,
          emailLeaseToken: lease,
          'emailAttempts.requestId': requestId,
        },
        {
          $set: {
            'emailAttempts.$.status': status,
            'emailAttempts.$.completedAt': new Date().toISOString(),
            ...(status === 'sent' && doc.status === 'paid'
              ? { 'paymentEmail.status': 'done' }
              : {}),
          },
          $unset: {
            emailLeaseToken: '',
            emailLeaseUntil: '',
            ...(status === 'sent' && doc.status === 'paid'
              ? { 'paymentEmail.leaseToken': '', 'paymentEmail.leaseUntil': '' }
              : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!saved)
      throw new ConflictException(
        'Email delivery is still being reconciled. Reload the invoice.',
      );
    await this.event(actor, `email_${status}`, saved);
    return this.record(saved);
  }
  onModuleInit() {
    this.emailTimer = setInterval(
      () =>
        void this.processAutomaticEmails().catch(() =>
          this.logger.error(
            'Automatic invoice email delivery will be retried.',
          ),
        ),
      this.environment.get<number>('invoices.emailPollMs', 30000),
    );
    this.emailTimer.unref();
  }
  onModuleDestroy() {
    if (this.emailTimer) clearInterval(this.emailTimer);
  }
  private async processAutomaticEmails(id?: string, actor?: AuthenticatedUser) {
    if (
      this.emailBusy ||
      !this.environment.get<boolean>('notifications.email.enabled', false)
    )
      return;
    this.emailBusy = true;
    try {
      const now = new Date();
      const eligibility = {
        $or: [
          {
            'paymentEmail.status': 'pending',
            'paymentEmail.nextAttemptAt': { $lte: now },
          },
          {
            'paymentEmail.status': 'processing',
            'paymentEmail.leaseUntil': { $lte: now },
          },
        ],
      };
      await this.invoices
        .updateMany(
          {
            status: 'paid',
            'paymentEmail.status': 'processing',
            'paymentEmail.leaseUntil': { $lte: now },
            'paymentEmail.attempts': { $gte: 6 },
          },
          {
            $set: { 'paymentEmail.status': 'failed' },
            $unset: {
              'paymentEmail.leaseToken': '',
              'paymentEmail.leaseUntil': '',
            },
          },
        )
        .exec();
      const candidates = await this.invoices
        .find({
          ...(id ? { _id: id } : {}),
          status: 'paid',
          'paymentEmail.attempts': { $lt: 6 },
          ...eligibility,
        })
        .select('_id')
        .limit(10)
        .exec();
      for (const candidate of candidates) {
        const token = randomUUID();
        const claimed = await this.invoices
          .findOneAndUpdate(
            {
              _id: candidate.id,
              status: 'paid',
              'paymentEmail.attempts': { $lt: 6 },
              ...eligibility,
            },
            {
              $set: {
                'paymentEmail.status': 'processing',
                'paymentEmail.leaseToken': token,
                'paymentEmail.leaseUntil': new Date(Date.now() + 120000),
              },
              $inc: { 'paymentEmail.attempts': 1 },
            },
            { new: true },
          )
          .exec();
        if (!claimed) continue;
        let sent = false;
        try {
          const result = await this.send(
            claimed.id,
            randomUUID(),
            actor || {
              sub: 'invoice-email-worker',
              tokenId: 'internal-invoice-email-worker',
              email: '',
              roles: [],
              permissions: [],
            },
          );
          sent = result.emailAttempts.at(-1)?.status === 'sent';
        } catch {
          sent = false;
        }
        await this.invoices
          .updateOne(
            {
              _id: claimed.id,
              'paymentEmail.status': 'processing',
              'paymentEmail.leaseToken': token,
            },
            {
              $set: {
                'paymentEmail.status': sent
                  ? 'done'
                  : claimed.paymentEmail!.attempts >= 6
                    ? 'failed'
                    : 'pending',
                'paymentEmail.nextAttemptAt': new Date(
                  Date.now() +
                    Math.min(
                      3600000,
                      30000 * 2 ** (claimed.paymentEmail!.attempts - 1),
                    ),
                ),
              },
              $unset: {
                'paymentEmail.leaseToken': '',
                'paymentEmail.leaseUntil': '',
              },
            },
          )
          .exec();
      }
    } finally {
      this.emailBusy = false;
    }
  }
}
