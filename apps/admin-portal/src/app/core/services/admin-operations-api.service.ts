import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { QUIET_ERROR } from '@sapiovian/error-ui';
import type {
  AdminBookingDetail,
  AdminBookingPage,
  AdminBookingQuery,
  AdminFinanceReport,
  AdminStaffMember,
  AdminStaffRole,
  AdminStaffRoleInput,
  AdminWhiteboardReview,
  AdminWhiteboardVersionPreview,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
@Injectable({ providedIn: 'root' })
export class AdminOperationsApi {
  private readonly http = inject(HttpClient);
  private readonly root = API_BASE_URL + '/admin';
  private unwrap<T>(body: T | { data: T }): T {
    return body && typeof body === 'object' && 'data' in body
      ? body.data
      : (body as T);
  }
  private params(query: object) {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null && value !== '')
        params = params.set(key, String(value));
    return params;
  }
  private get<T>(path: string, query: object = {}, quiet = false) {
    return this.http
      .get<
        T | { data: T }
      >(this.root + path, { params: this.params(query), context: new HttpContext().set(QUIET_ERROR, quiet) })
      .pipe(map((body) => this.unwrap(body)));
  }
  private post<T>(path: string, body: object) {
    return this.http
      .post<T | { data: T }>(this.root + path, body)
      .pipe(map((result) => this.unwrap(result)));
  }
  bookings(query: AdminBookingQuery) {
    return this.get<AdminBookingPage>('/bookings', query);
  }
  booking(id: string, quiet = false) {
    return this.get<AdminBookingDetail>(
      '/bookings/' + encodeURIComponent(id),
      {},
      quiet,
    );
  }
  reconcile(id: string, reason: string) {
    return this.post<AdminBookingDetail>(
      '/bookings/' + encodeURIComponent(id) + '/reconcile',
      { reason },
    );
  }
  refund(id: string, amountMinor: number, reason: string, requestId: string) {
    return this.post('/bookings/' + encodeURIComponent(id) + '/refunds', {
      amountMinor,
      reason,
      requestId,
    });
  }
  retryRefund(id: string, refundId: string, reason: string, requestId: string) {
    return this.post<AdminBookingDetail>(
      '/bookings/' +
        encodeURIComponent(id) +
        '/refunds/' +
        encodeURIComponent(refundId) +
        '/retry',
      { reason, requestId },
    );
  }
  bookingsCsv(query: AdminBookingQuery) {
    return this.http.get(this.root + '/bookings/export.csv', {
      params: this.params(query),
      responseType: 'blob',
    });
  }
  billingDocument(id: string, creditId?: string) {
    return this.http.get(
      API_BASE_URL +
        '/bookings/orders/' +
        encodeURIComponent(id) +
        (creditId ? '/credits/' + encodeURIComponent(creditId) : '/invoice'),
      { responseType: 'blob' },
    );
  }
  finance(dateFrom: string, dateTo: string) {
    return this.get<AdminFinanceReport>('/bookings/finance', {
      dateFrom,
      dateTo,
    });
  }
  roles() {
    return this.get<AdminStaffRole[]>('/staff/roles');
  }
  permissions() {
    return this.get<string[]>('/staff/permissions');
  }
  saveRole(body: AdminStaffRoleInput, id?: string) {
    return (
      id
        ? this.http.patch<AdminStaffRole | { data: AdminStaffRole }>(
            this.root + '/staff/roles/' + encodeURIComponent(id),
            body,
          )
        : this.http.post<AdminStaffRole | { data: AdminStaffRole }>(
            this.root + '/staff/roles',
            body,
          )
    ).pipe(map((result) => this.unwrap(result)));
  }
  deleteRole(id: string) {
    return this.http.delete(
      this.root + '/staff/roles/' + encodeURIComponent(id),
    );
  }
  staff(search: string, page: number) {
    return this.get<{
      items: AdminStaffMember[];
      total: number;
      page: number;
      limit: number;
    }>('/staff/members', { search, page });
  }
  assignRole(
    id: string,
    roleId: string | null,
    expectedRoleId: string | null,
    reason: string,
  ) {
    return this.post('/staff/members/' + encodeURIComponent(id) + '/role', {
      roleId,
      expectedRoleId,
      reason,
    });
  }
  whiteboards(search: string, page: number) {
    return this.get<{
      items: Array<{
        sessionId: string;
        batchId: string;
        title: string;
        teacherId: string;
        status: string;
        pageCount: number;
        elementCount: number;
        updatedAt: string;
      }>;
      total: number;
      page: number;
      limit: number;
    }>('/whiteboards', { search, page });
  }
  whiteboard(id: string) {
    return this.get<AdminWhiteboardReview>(
      '/whiteboards/' + encodeURIComponent(id),
    );
  }
  boardVersion(id: string, versionId: string) {
    return this.get<AdminWhiteboardVersionPreview>(
      '/whiteboards/' +
        encodeURIComponent(id) +
        '/versions/' +
        encodeURIComponent(versionId),
    );
  }
  restoreBoard(
    id: string,
    versionId: string,
    body: {
      expectedSnapshotVersion: number;
      expectedLastOperationSeq: number;
      reason: string;
    },
  ) {
    return this.post<AdminWhiteboardReview>(
      '/whiteboards/' +
        encodeURIComponent(id) +
        '/versions/' +
        encodeURIComponent(versionId) +
        '/restore',
      body,
    );
  }
  boardJson(id: string, versionId?: string) {
    return this.http.get(
      this.root + '/whiteboards/' + encodeURIComponent(id) + '/export',
      { params: this.params({ versionId }), responseType: 'blob' },
    );
  }
}
export function adminOperationError(error: unknown): string {
  const value = error as {
    error?: { message?: string | string[] };
    message?: string;
  };
  const message = value?.error?.message;
  return typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.join(' ')
      : (value?.message ?? 'The request failed. Refresh and try again.');
}
export function saveAdminBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
