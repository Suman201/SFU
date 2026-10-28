import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { finalize, type Observable } from 'rxjs';
import {
  INVOICE_CURRENCIES,
  invoiceTotals,
  invoicePostalAddress,
  type InvoiceInput,
  type InvoicePage,
  type InvoiceRecord,
  type InvoiceSettings,
  type InvoiceTotals,
} from '@native-sfu/contracts';
import { InvoicesApi } from '../../core/services/invoices-api.service';
type EditorLine = {
  description: string;
  quantity: number;
  price: number;
  tax: number;
};
type Editor = Omit<InvoiceInput, 'lines'> & { lines: EditorLine[] };
@Component({
  selector: 'sfu-invoices',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe],
  templateUrl: './invoices.html',
  styleUrl: './invoices.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class InvoicesAdmin {
  private readonly api = inject(InvoicesApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroy = inject(DestroyRef);
  protected readonly mode = signal<'list' | 'detail' | 'editor' | 'settings'>(
    'list',
  );
  protected readonly data = signal<InvoicePage>({
    items: [],
    total: 0,
    page: 1,
    limit: 25,
  });
  protected readonly detail = signal<InvoiceRecord | null>(null);
  protected readonly busy = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly action = signal<'payment' | 'void' | null>(null);
  protected readonly currencies = INVOICE_CURRENCIES;
  protected readonly postalAddress = invoicePostalAddress;
  protected status = 'all';
  protected search = '';
  protected settingsForm: InvoiceSettings | null = null;
  private settings: InvoiceSettings | null = null;
  protected form: Editor = this.blank();
  private editingId?: string;
  private editingVersion?: number;
  protected paymentDate = this.today();
  protected paymentReference = '';
  protected voidReason = '';
  private pollBusy = false;
  constructor() {
    const timer = setInterval(() => {
      const current = this.detail();
      if (
        this.mode() !== 'detail' ||
        !current ||
        this.busy() ||
        this.pollBusy ||
        !(
          ['pending', 'processing'].includes(
            current.paymentEmail?.status || '',
          ) || current.emailAttempts.at(-1)?.status === 'sending'
        )
      )
        return;
      this.pollBusy = true;
      this.api
        .get(current.id)
        .pipe(
          takeUntilDestroyed(this.destroy),
          finalize(() => (this.pollBusy = false)),
        )
        .subscribe({
          next: (value) => {
            if (
              !this.busy() &&
              this.mode() === 'detail' &&
              this.detail()?.id === value.id &&
              value.version >= this.detail()!.version
            ) {
              const previous = this.detail()?.paymentEmail?.status;
              this.detail.set(value);
              if (
                ['pending', 'processing'].includes(previous || '') &&
                value.paymentEmail?.status === 'done'
              )
                this.notice.set(
                  'Payment recorded and invoice emailed to ' +
                    value.customer.email +
                    '.',
                );
              if (value.paymentEmail?.status === 'failed') {
                this.notice.set('');
                this.error.set(
                  'Automatic invoice email could not be delivered. Check email settings and retry.',
                );
              }
            }
          },
          error: () => undefined,
        });
    }, 3000);
    this.destroy.onDestroy(() => clearInterval(timer));

    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        const id = params.get('id');
        this.error.set('');
        if (id) {
          this.loadDetail(id);
        } else {
          this.mode.set('list');
          this.load();
        }
      });
    this.api
      .settings()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (value) => (this.settings = value),
        error: () => undefined,
      });
  }
  protected today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  private blank(): Editor {
    const due = new Date();
    due.setDate(due.getDate() + 14);
    return {
      customer: {
        name: 'Jamie Taylor',
        email: 'jamie@example.com',
        address: '24 Example Road\nBerlin, 10115\nGermany',
        countryCode: 'DE',
        vatNumber: '',
      },
      invoiceDate: this.today(),
      dueDate: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`,
      supplyDate: this.today(),
      currency: 'EUR',
      lines: [{ description: 'Online lesson', quantity: 1, price: 28, tax: 0 }],
      taxNote: 'No VAT charged.',
      notes: 'Thank you for learning with Sapiovian.',
      reference: '',
    };
  }
  protected load(page = 1) {
    this.loading.set(true);
    this.api
      .list(page, this.status, this.search)
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (value) => this.data.set(value),
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  private loadDetail(id: string) {
    this.mode.set('detail');
    this.loading.set(true);
    this.detail.set(null);
    this.api
      .get(id)
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (value) => {
          this.detail.set(value);
          this.action.set(null);
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected create() {
    this.error.set('');
    this.notice.set('');
    this.editingId = undefined;
    this.editingVersion = undefined;
    this.form = this.blank();
    if (this.settings) {
      this.form.currency = this.settings.defaultCurrency;
      this.form.taxNote = this.settings.defaultTaxNote;
    }
    this.mode.set('editor');
  }
  protected edit() {
    const value = this.detail();
    if (!value) return;
    this.form = {
      customer: { ...value.customer },
      invoiceDate: value.invoiceDate,
      dueDate: value.dueDate,
      supplyDate: value.supplyDate,
      currency: value.currency,
      lines: value.lines.map((line) => ({
        description: line.description,
        quantity: line.quantityMilli / 1000,
        price: line.unitPriceMinor / 100,
        tax: line.taxRateBps / 100,
      })),
      taxNote: value.taxNote,
      notes: value.notes,
      reference: value.reference,
    };
    this.editingId = value.id;
    this.editingVersion = value.version;
    this.mode.set('editor');
    this.error.set('');
  }
  protected back() {
    this.error.set('');
    this.action.set(null);
    if (this.route.snapshot.paramMap.get('id'))
      void this.router.navigate(['/invoices']);
    else {
      this.mode.set('list');
      this.load();
    }
  }
  protected payload(): InvoiceInput {
    return {
      ...this.form,
      customer: {
        ...this.form.customer,
        countryCode: this.form.customer.countryCode.toUpperCase(),
      },
      lines: this.form.lines.map((line) => ({
        description: line.description,
        quantityMilli: Math.round(Number(line.quantity) * 1000),
        unitPriceMinor: Math.round(Number(line.price) * 100),
        taxRateBps: Math.round(Number(line.tax) * 100),
      })),
    };
  }
  protected totals(): InvoiceTotals | null {
    try {
      return invoiceTotals(this.payload().lines);
    } catch {
      return null;
    }
  }
  protected addLine() {
    if (this.form.lines.length < 50)
      this.form.lines.push({ description: '', quantity: 1, price: 0, tax: 0 });
  }
  protected removeLine(index: number) {
    if (this.form.lines.length > 1) this.form.lines.splice(index, 1);
  }
  protected money(amount: number, currency = this.form.currency) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
    }).format(amount / 100);
  }
  protected save(event: SubmitEvent) {
    event.preventDefault();
    if (
      this.busy() ||
      !(event.target as HTMLFormElement).reportValidity() ||
      !this.totals()
    )
      return;
    this.run(
      this.api.save(this.payload(), this.editingId, this.editingVersion),
      'Draft saved.',
    );
  }
  private run(
    request: Observable<InvoiceRecord>,
    message: string | ((record: InvoiceRecord) => string),
  ) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    request
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.busy.set(false)),
      )
      .subscribe({
        next: (value) => {
          this.detail.set(value);
          this.mode.set('detail');
          this.action.set(null);
          this.notice.set(
            typeof message === 'function' ? message(value) : message,
          );
          if (this.route.snapshot.paramMap.get('id') !== value.id)
            void this.router.navigate(['/invoices', value.id]);
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected issue() {
    const value = this.detail();
    if (value)
      this.run(
        this.api.action(value.id, 'issue', { version: value.version }),
        'Invoice issued. You can download it or send it by email.',
      );
  }
  protected send() {
    const value = this.detail();
    if (!value || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    this.api
      .action(value.id, 'email', { requestId: crypto.randomUUID() })
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.busy.set(false)),
      )
      .subscribe({
        next: (record) => {
          this.detail.set(record);
          const status = record.emailAttempts.at(-1)?.status;
          if (status === 'sent')
            this.notice.set(
              'Invoice emailed to ' + record.customer.email + '.',
            );
          else if (status === 'disabled')
            this.error.set(
              'Email is disabled. Configure the email service, then try again.',
            );
          else if (status === 'sending')
            this.notice.set(
              'Invoice email is being sent. Refresh to check delivery.',
            );
          else
            this.error.set(
              'The invoice email could not be delivered. Check the email service and try again.',
            );
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected emailLabel(value: InvoiceRecord) {
    if (value.paymentEmail?.status === 'pending')
      return value.paymentEmail.attempts > 0 ? 'Retry queued' : 'Queued';
    if (value.paymentEmail?.status === 'processing') return 'Sending';
    const last = value.emailAttempts.at(-1);
    return last
      ? {
          sent: 'Sent',
          failed: 'Failed',
          disabled: 'Email disabled',
          sending: 'Sending',
        }[last.status]
      : 'Not sent';
  }
  protected download() {
    const value = this.detail();
    if (!value || this.busy()) return;
    this.busy.set(true);
    this.api
      .pdf(value.id)
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.busy.set(false)),
      )
      .subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${value.number || 'invoice-draft'}.pdf`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        error: () =>
          this.error.set('The PDF could not be downloaded. Try again.'),
      });
  }
  protected recordPayment(event: SubmitEvent) {
    event.preventDefault();
    const value = this.detail();
    if (!value || !(event.target as HTMLFormElement).reportValidity()) return;
    this.run(
      this.api.action(value.id, 'payment', {
        version: value.version,
        paidDate: this.paymentDate,
        reference: this.paymentReference,
      }),
      (record) =>
        record.emailAttempts.at(-1)?.status === 'sent'
          ? 'Payment recorded and invoice emailed.'
          : 'Payment recorded. The invoice email is queued for delivery.',
    );
  }
  protected voidInvoice(event: SubmitEvent) {
    event.preventDefault();
    const value = this.detail();
    if (!value || !(event.target as HTMLFormElement).reportValidity()) return;
    this.run(
      this.api.action(value.id, 'void', {
        version: value.version,
        reason: this.voidReason,
      }),
      'Invoice voided. Its number is retained.',
    );
  }
  protected openSettings() {
    this.error.set('');
    this.loading.set(true);
    this.api
      .settings()
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (value) => {
          this.settings = value;
          this.settingsForm = structuredClone(value);
          this.mode.set('settings');
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected saveSettings(event: SubmitEvent) {
    event.preventDefault();
    if (
      !this.settingsForm ||
      this.busy() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    this.busy.set(true);
    const value = {
      ...this.settingsForm,
      seller: {
        ...this.settingsForm.seller,
        countryCode: this.settingsForm.seller.countryCode.toUpperCase(),
      },
    };
    this.api
      .saveSettings(value)
      .pipe(
        takeUntilDestroyed(this.destroy),
        finalize(() => this.busy.set(false)),
      )
      .subscribe({
        next: (record) => {
          this.settings = record;
          this.settingsForm = structuredClone(record);
          this.notice.set(
            'Invoice settings saved. Issued invoices keep their original seller details.',
          );
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
}
