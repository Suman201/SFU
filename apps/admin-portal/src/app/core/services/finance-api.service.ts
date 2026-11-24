import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type {
  AdminPaymentRecord,
  CreateRefundRequest,
  DisputeRecord,
  FinanceOverview,
  FinanceSettings,
  FinanceSettingsUpdate,
  GatewayEventRecord,
  LedgerEntryRecord,
  PageResult,
  PaymentGatewayStatus,
  PayoutRecord,
  ReconciliationReport,
  RefundRecord,
  TeacherFinanceRow,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';

type Envelope<T> = T | { success?: boolean; data: T };
type Params = Record<string, string | number | undefined>;

function unwrap<T>(value: Envelope<T>): T {
  return value && typeof value === 'object' && 'data' in (value as object) ? (value as { data: T }).data : (value as T);
}

function clean(params: Params): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== '' && value !== 'all')) as Record<string, string | number>;
}

export function financeError(error: unknown, fallback = 'The request failed. Please try again.'): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body?.message[0] : body?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (error.status === 403) return 'Your role cannot perform this action.';
  }
  return fallback;
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

@Injectable({ providedIn: 'root' })
export class FinanceApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${API_BASE_URL}/admin/finance`;

  status(): Observable<PaymentGatewayStatus> {
    return this.http.get<Envelope<PaymentGatewayStatus>>(`${this.base}/status`).pipe(map(unwrap));
  }

  overview(params: Params): Observable<FinanceOverview> {
    return this.http.get<Envelope<FinanceOverview>>(`${this.base}/overview`, { params: clean(params) }).pipe(map(unwrap));
  }

  settings(): Observable<FinanceSettings> {
    return this.http.get<Envelope<FinanceSettings>>(`${this.base}/settings`).pipe(map(unwrap));
  }

  saveSettings(input: FinanceSettingsUpdate): Observable<FinanceSettings> {
    return this.http.patch<Envelope<FinanceSettings>>(`${this.base}/settings`, input).pipe(map(unwrap));
  }

  payments(params: Params): Observable<PageResult<AdminPaymentRecord>> {
    return this.http.get<Envelope<PageResult<AdminPaymentRecord>>>(`${this.base}/payments`, { params: clean(params) }).pipe(map(unwrap));
  }

  paymentsCsv(params: Params): Observable<Blob> {
    return this.http.get(`${this.base}/payments.csv`, { params: clean(params), responseType: 'blob' });
  }

  payment(id: string): Observable<AdminPaymentRecord> {
    return this.http.get<Envelope<AdminPaymentRecord>>(`${this.base}/payments/${encodeURIComponent(id)}`).pipe(map(unwrap));
  }

  receipt(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/payments/${encodeURIComponent(id)}/receipt`, { responseType: 'blob' });
  }

  refund(id: string, input: CreateRefundRequest): Observable<RefundRecord> {
    return this.http.post<Envelope<RefundRecord>>(`${this.base}/payments/${encodeURIComponent(id)}/refunds`, input).pipe(map(unwrap));
  }

  testDispute(id: string, status: 'needs_response' | 'won' | 'lost'): Observable<AdminPaymentRecord> {
    return this.http.post<Envelope<AdminPaymentRecord>>(`${this.base}/test-gateway/payments/${encodeURIComponent(id)}/dispute`, { status }).pipe(map(unwrap));
  }

  refunds(params: Params): Observable<PageResult<RefundRecord>> {
    return this.http.get<Envelope<PageResult<RefundRecord>>>(`${this.base}/refunds`, { params: clean(params) }).pipe(map(unwrap));
  }

  disputes(params: Params): Observable<PageResult<DisputeRecord>> {
    return this.http.get<Envelope<PageResult<DisputeRecord>>>(`${this.base}/disputes`, { params: clean(params) }).pipe(map(unwrap));
  }

  payouts(params: Params): Observable<PageResult<PayoutRecord>> {
    return this.http.get<Envelope<PageResult<PayoutRecord>>>(`${this.base}/payouts`, { params: clean(params) }).pipe(map(unwrap));
  }

  approvePayout(id: string, note?: string): Observable<PayoutRecord> {
    return this.http.post<Envelope<PayoutRecord>>(`${this.base}/payouts/${encodeURIComponent(id)}/approve`, { note }).pipe(map(unwrap));
  }

  rejectPayout(id: string, note: string): Observable<PayoutRecord> {
    return this.http.post<Envelope<PayoutRecord>>(`${this.base}/payouts/${encodeURIComponent(id)}/reject`, { note }).pipe(map(unwrap));
  }

  teachers(params: Params): Observable<TeacherFinanceRow[]> {
    return this.http.get<Envelope<TeacherFinanceRow[]>>(`${this.base}/teachers`, { params: clean(params) }).pipe(map(unwrap));
  }

  ledger(params: Params): Observable<PageResult<LedgerEntryRecord>> {
    return this.http.get<Envelope<PageResult<LedgerEntryRecord>>>(`${this.base}/ledger`, { params: clean(params) }).pipe(map(unwrap));
  }

  events(params: Params): Observable<PageResult<GatewayEventRecord>> {
    return this.http.get<Envelope<PageResult<GatewayEventRecord>>>(`${this.base}/events`, { params: clean(params) }).pipe(map(unwrap));
  }

  retryEvent(id: string): Observable<GatewayEventRecord> {
    return this.http.post<Envelope<GatewayEventRecord>>(`${this.base}/events/${encodeURIComponent(id)}/retry`, {}).pipe(map(unwrap));
  }

  reconciliation(): Observable<ReconciliationReport> {
    return this.http.get<Envelope<ReconciliationReport>>(`${this.base}/reconciliation`).pipe(map(unwrap));
  }

  repair(): Observable<ReconciliationReport> {
    return this.http.post<Envelope<ReconciliationReport>>(`${this.base}/reconciliation/repair`, {}).pipe(map(unwrap));
  }
}
