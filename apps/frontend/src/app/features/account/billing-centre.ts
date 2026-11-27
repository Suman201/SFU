import { Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { formatPaymentMoney, type BillingHistory, type BillingPurchase, type BillingPurchaseStatus, type BillingRefundPage, type BillingSource, type CustomerBillingProfile } from '@native-sfu/contracts';
import { BillingApi, billingDocumentUrl } from '../../core/services/billing-api.service';
import { accountDate } from '../../core/services/account-api.service';
import { AuthService } from '../../core/services/auth.service';
import { paymentErrorMessage, saveBlob } from '../../core/services/payments.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
const STATUS: Record<BillingPurchaseStatus, string> = { paid: 'Paid', partially_refunded: 'Partially refunded', refunded: 'Refunded', refund_pending: 'Refund in progress', awaiting_payment: 'Awaiting payment', processing: 'Processing', cancelled: 'Cancelled', expired: 'Expired', failed: 'Failed', review: 'Needs review' };
@Component({ standalone: true, selector: 'sfu-billing-centre', imports: [FormsModule, RouterLink, Header, Footer], templateUrl: './billing-centre.html', styleUrls: ['../payments/payment-pages.scss', './account.scss'] })
export class BillingCentre implements OnInit {
  private readonly api = inject(BillingApi); protected readonly auth = inject(AuthService); private readonly confirm = inject(ConfirmDialogService);
  protected readonly profile = signal<CustomerBillingProfile | null>(null); protected readonly history = signal<BillingHistory | null>(null);
  protected readonly selected = signal<BillingPurchase | null>(null); protected readonly refunds = signal<BillingRefundPage | null>(null);
  protected readonly error = signal(''); protected readonly success = signal(''); protected readonly busy = signal(''); protected readonly loading = signal(true);
  protected name = ''; protected address = ''; protected countryCode = ''; protected vatNumber = '';
  protected filter = 'all'; protected selectedCurrency = ''; protected search = '';
  protected source: BillingSource | '' = '';
  private requestVersion = 0; private refundVersion = 0;
  constructor() { effect(() => { if (!this.auth.user()) { this.requestVersion++; this.refundVersion++; this.profile.set(null); this.history.set(null); this.refunds.set(null); this.selected.set(null); this.name = ''; this.address = ''; this.countryCode = ''; this.vatNumber = ''; } }); }
  ngOnInit(): void { void this.reloadProfile(); void this.loadHistory(1); }
  protected money(value: number, currency: string): string { return formatPaymentMoney(value, currency, this.profile()?.locale); }
  protected date(value: string): string { return accountDate(value, this.profile()?.locale, this.profile()?.timezone); }
  protected status(row: BillingPurchase): string { return row.status === 'paid' && row.amountMinor === 0 ? 'No charge' : STATUS[row.status] ?? row.status; }
  protected sourceName(row: BillingPurchase): string { return { booking: 'Booking', payment: 'Class payment', promotion: 'Promotion' }[row.source]; }
  protected purchasePath(row: BillingPurchase): string[] { return row.source === 'promotion' ? ['/teacher/promotions'] : row.source === 'booking' ? ['/bookings', row.recordId] : ['/payments', row.recordId]; }
  protected tone(row: BillingPurchase): string { return row.status === 'paid' ? 'success' : ['refunded', 'partially_refunded'].includes(row.status) ? 'info' : ['failed', 'review'].includes(row.status) ? 'danger' : ['processing', 'awaiting_payment', 'refund_pending'].includes(row.status) ? 'warning' : 'neutral'; }
  private apply(profile: CustomerBillingProfile): void { this.profile.set(profile); this.name = profile.name; this.address = profile.address; this.countryCode = profile.countryCode; this.vatNumber = profile.vatNumber; }
  protected async reloadProfile(): Promise<void> {
    const owner = this.auth.user()?.id;
    try { const profile = await firstValueFrom(this.api.profile()); if (owner === this.auth.user()?.id) this.apply(profile); }
    catch (error) { this.error.set(paymentErrorMessage(error, 'Saved billing details could not be loaded.')); }
  }
  protected async save(): Promise<void> {
    const profile = this.profile(); if (!profile || this.busy()) return;
    this.busy.set('profile'); this.error.set(''); this.success.set(''); const owner = this.auth.user()?.id;
    try { const updated = await firstValueFrom(this.api.save({ version: profile.version, name: this.name, address: this.address, countryCode: this.countryCode, vatNumber: this.vatNumber })); if (owner === this.auth.user()?.id) { this.apply(updated); this.success.set('Billing details saved for future bookings.'); } }
    catch (error) { this.error.set(paymentErrorMessage(error, 'Billing details could not be saved.')); } finally { this.busy.set(''); }
  }
  protected async clear(): Promise<void> {
    const profile = this.profile(); if (!profile || this.busy()) return;
    if (!await this.confirm.confirm({ title: 'Clear saved billing details?', message: 'Saved defaults will be cleared. Issued invoices and your purchase history stay available.', confirmLabel: 'Clear saved details', variant: 'warning' })) return;
    this.busy.set('profile'); this.error.set(''); this.success.set(''); const owner = this.auth.user()?.id;
    try { const updated = await firstValueFrom(this.api.clear(profile.version)); if (owner === this.auth.user()?.id) { this.apply(updated); this.success.set('Saved billing details cleared.'); } }
    catch (error) { this.error.set(paymentErrorMessage(error)); } finally { this.busy.set(''); }
  }
  protected async loadHistory(page = 1): Promise<void> {
    const version = ++this.requestVersion, owner = this.auth.user()?.id; this.loading.set(true); this.error.set('');
    try { const history = await firstValueFrom(this.api.history({ page, currency: this.selectedCurrency, status: this.filter, source: this.source, q: this.search.trim() })); if (version === this.requestVersion && owner === this.auth.user()?.id) this.history.set(history); }
    catch (error) { if (version === this.requestVersion) this.error.set(paymentErrorMessage(error, 'Billing history could not be loaded.')); }
    finally { if (version === this.requestVersion) this.loading.set(false); }
  }
  protected async showRefunds(row: BillingPurchase, page = 1): Promise<void> {
    this.selected.set(row); this.refunds.set(null); this.error.set(''); const version = ++this.refundVersion, owner = this.auth.user()?.id;
    try { const list = await firstValueFrom(this.api.refunds(row, page)); if (version === this.refundVersion && owner === this.auth.user()?.id) this.refunds.set(list); }
    catch (error) { if (version === this.refundVersion) this.error.set(paymentErrorMessage(error, 'Refund history could not be loaded.')); }
  }
  protected closeRefunds(): void { this.refundVersion++; this.selected.set(null); this.refunds.set(null); }
  protected async download(row: BillingPurchase, creditId?: string): Promise<void> {
    if (this.busy()) return; this.busy.set(row.id); this.error.set(''); const owner = this.auth.user()?.id;
    try {
      if (row.source === 'promotion') {
        const link = await firstValueFrom(this.api.documentLink(row, creditId));
        if (owner === this.auth.user()?.id) location.assign(billingDocumentUrl(link.url));
      } else {
        const file = await firstValueFrom(this.api.document(row, creditId));
        if (owner === this.auth.user()?.id) saveBlob(file, creditId ? `credit-note-${creditId}.pdf` : `${row.document?.kind ?? 'document'}-${row.recordId}.pdf`);
      }
    }
    catch (error) { this.error.set(paymentErrorMessage(error, 'The billing document could not be downloaded.')); } finally { this.busy.set(''); }
  }
}
