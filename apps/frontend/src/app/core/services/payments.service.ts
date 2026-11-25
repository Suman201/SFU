import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type {
  CheckoutResponse,
  PageResult,
  PaymentGatewayStatus,
  PayoutAccountStatus,
  PayoutRecord,
  PayoutRequestInput,
  StudentPaymentRecord,
  TeacherEarningsLine,
  TeacherEarningsSummary,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
import { isDesktopSession } from './desktop-bridge';

type Envelope<T> = T | { success?: boolean; data: T };

function unwrap<T>(value: Envelope<T>): T {
  return value && typeof value === 'object' && 'data' in (value as object) ? (value as { data: T }).data : (value as T);
}

export function paymentErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body?.message[0] : body?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (error.status === 0) return 'You appear to be offline. Check your connection and try again.';
  }
  return fallback;
}

/** Random idempotency key so a retried request is never applied twice. */
export function requestKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

@Injectable({ providedIn: 'root' })
export class PaymentsApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${API_BASE_URL}/payments`;
  private readonly earnings = `${API_BASE_URL}/teacher/earnings`;

  config(): Observable<PaymentGatewayStatus> {
    return this.http.get<Envelope<PaymentGatewayStatus>>(`${this.base}/config`).pipe(map(unwrap));
  }

  checkout(batchId: string): Observable<CheckoutResponse> {
    return this.http.post<Envelope<CheckoutResponse>>(`${this.base}/checkout`, { batchId }).pipe(map(unwrap));
  }

  mine(page = 1): Observable<PageResult<StudentPaymentRecord>> {
    return this.http.get<Envelope<PageResult<StudentPaymentRecord>>>(`${this.base}/me`, { params: { page } }).pipe(map(unwrap));
  }

  one(id: string): Observable<StudentPaymentRecord> {
    return this.http.get<Envelope<StudentPaymentRecord>>(`${this.base}/me/${encodeURIComponent(id)}`).pipe(map(unwrap));
  }

  cancel(id: string): Observable<StudentPaymentRecord> {
    return this.http.post<Envelope<StudentPaymentRecord>>(`${this.base}/me/${encodeURIComponent(id)}/cancel`, {}).pipe(map(unwrap));
  }

  receipt(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/me/${encodeURIComponent(id)}/receipt`, { responseType: 'blob' });
  }

  testComplete(id: string, outcome: 'succeed' | 'decline'): Observable<StudentPaymentRecord> {
    return this.http.post<Envelope<StudentPaymentRecord>>(`${this.base}/test-gateway/${encodeURIComponent(id)}/complete`, { outcome }).pipe(map(unwrap));
  }

  earningsSummary(): Observable<TeacherEarningsSummary> {
    return this.http.get<Envelope<TeacherEarningsSummary>>(this.earnings).pipe(map(unwrap));
  }

  earningsTransactions(page = 1): Observable<PageResult<TeacherEarningsLine>> {
    return this.http.get<Envelope<PageResult<TeacherEarningsLine>>>(`${this.earnings}/transactions`, { params: { page } }).pipe(map(unwrap));
  }

  payouts(page = 1): Observable<PageResult<PayoutRecord>> {
    return this.http.get<Envelope<PageResult<PayoutRecord>>>(`${this.earnings}/payouts`, { params: { page } }).pipe(map(unwrap));
  }

  requestPayout(input: PayoutRequestInput): Observable<PayoutRecord> {
    return this.http.post<Envelope<PayoutRecord>>(`${this.earnings}/payouts`, input).pipe(map(unwrap));
  }

  cancelPayout(id: string): Observable<PayoutRecord> {
    return this.http.post<Envelope<PayoutRecord>>(`${this.earnings}/payouts/${encodeURIComponent(id)}/cancel`, {}).pipe(map(unwrap));
  }

  startPayoutSetup(): Observable<{ url: string }> {
    return this.http.post<Envelope<{ url: string }>>(`${this.earnings}/payout-account/onboarding`, {}).pipe(map(unwrap));
  }

  refreshPayoutAccount(): Observable<PayoutAccountStatus> {
    return this.http.post<Envelope<PayoutAccountStatus>>(`${this.earnings}/payout-account/refresh`, {}).pipe(map(unwrap));
  }
}

/** Sends the browser to a hosted checkout or onboarding page; desktop opens it in the system browser. */
export function openHostedPage(url: string): void {
  const target = new URL(url, window.location.origin);
  if (isDesktopSession() && window.classroomDesktop && target.origin !== window.location.origin) {
    void window.classroomDesktop.openExternal(target.href);
    return;
  }
  window.location.assign(target.href);
}

export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
