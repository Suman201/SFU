import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import type {
  InvoiceInput,
  InvoicePage,
  InvoiceRecord,
  InvoiceSettings,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
@Injectable({ providedIn: 'root' })
export class InvoicesApi {
  private readonly http = inject(HttpClient);
  private readonly base = API_BASE_URL + '/admin/invoices';
  private unwrap<T>(value: T | { data: T }): T {
    return (value as { data: T }).data ?? (value as T);
  }
  list(page: number, status: string, q: string) {
    return this.http
      .get<
        InvoicePage | { data: InvoicePage }
      >(this.base, { params: { page, status, q } })
      .pipe(map((value) => this.unwrap(value)));
  }
  get(id: string) {
    return this.http
      .get<InvoiceRecord | { data: InvoiceRecord }>(`${this.base}/${id}`)
      .pipe(map((value) => this.unwrap(value)));
  }
  settings() {
    return this.http
      .get<InvoiceSettings | { data: InvoiceSettings }>(this.base + '/settings')
      .pipe(map((value) => this.unwrap(value)));
  }
  saveSettings(value: InvoiceSettings) {
    return this.http
      .patch<
        InvoiceSettings | { data: InvoiceSettings }
      >(this.base + '/settings', value)
      .pipe(map((value) => this.unwrap(value)));
  }
  save(input: InvoiceInput, id?: string, version?: number) {
    const body = { ...input, ...(id ? { version } : {}) };
    return (
      id
        ? this.http.patch<InvoiceRecord | { data: InvoiceRecord }>(
            `${this.base}/${id}`,
            body,
          )
        : this.http.post<InvoiceRecord | { data: InvoiceRecord }>(
            this.base,
            body,
          )
    ).pipe(map((value) => this.unwrap(value)));
  }
  action(id: string, action: string, body: object) {
    return this.http
      .post<
        InvoiceRecord | { data: InvoiceRecord }
      >(`${this.base}/${id}/${action}`, body)
      .pipe(map((value) => this.unwrap(value)));
  }
  pdf(id: string) {
    return this.http.get(`${this.base}/${id}/pdf`, { responseType: 'blob' });
  }
  error(error: any) {
    const message = error?.error?.message;
    return Array.isArray(message)
      ? message.join(' ')
      : typeof message === 'string'
        ? message
        : 'The request could not be completed. Please try again.';
  }
}
