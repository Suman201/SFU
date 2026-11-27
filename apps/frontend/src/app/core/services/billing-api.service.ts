import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';
import { map } from 'rxjs';
import type { BillingDocumentLink, BillingHistory, BillingPurchase, BillingRefundPage, BillingSource, CustomerBillingProfile, CustomerBillingUpdate } from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
export function billingDocumentUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['invoice.stripe.com', 'pay.stripe.com', 'checkout.stripe.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('The billing document address is invalid.');
  return url.href;
}
@Injectable({ providedIn: 'root' })
export class BillingApi {
  private readonly http = inject(HttpClient); private readonly root = API_BASE_URL + '/billing';
  private options() { return { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400, 401, 403, 404, 409, 503]) }; }
  profile() { return this.http.get<{ data: CustomerBillingProfile }>(this.root + '/profile', this.options()).pipe(map(r => r.data)); }
  save(input: CustomerBillingUpdate) { return this.http.put<{ data: CustomerBillingProfile }>(this.root + '/profile', input, this.options()).pipe(map(r => r.data)); }
  clear(version: number) { return this.http.post<{ data: CustomerBillingProfile }>(this.root + '/profile/clear', { version }, this.options()).pipe(map(r => r.data)); }
  history(query: { page: number; status: string; currency: string; q: string; source?: BillingSource | '' }) {
    return this.http.get<{ data: BillingHistory }>(this.root + '/history', { ...this.options(), params: { page: query.page, status: query.status, ...(query.source ? { source: query.source } : {}), ...(query.currency ? { currency: query.currency } : {}), ...(query.q ? { q: query.q } : {}) } }).pipe(map(r => r.data));
  }
  refunds(row: BillingPurchase, page = 1) { return this.http.get<{ data: BillingRefundPage }>(this.purchase(row) + '/refunds', { ...this.options(), params: { page } }).pipe(map(r => r.data)); }
  document(row: BillingPurchase, creditId?: string) { return this.http.get(this.purchase(row) + (creditId ? '/credits/' + encodeURIComponent(creditId) : '/document'), { ...this.options(), responseType: 'blob' }); }
  documentLink(row: BillingPurchase, creditId?: string) { return this.http.get<{ data: BillingDocumentLink }>(this.purchase(row) + (creditId ? '/credits/' + encodeURIComponent(creditId) + '/link' : '/document-link'), this.options()).pipe(map(r => r.data)); }
  private purchase(row: BillingPurchase) { return this.root + '/purchases/' + row.source + '/' + encodeURIComponent(row.recordId); }
}
