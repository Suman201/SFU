import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import type {
  BookingBatchCatalogue,
  BookingCatalogue,
  BookingOrder,
  BookingOrderRequest,
  LessonOffer,
  LessonSlot,
} from '@native-sfu/contracts';
import { QUIET_ERROR } from '@sapiovian/error-ui';
import { API_BASE_URL } from './app-environment';

interface Envelope<T> {
  data: T;
}
export interface TeacherAvailability {
  enabled: boolean;
  paymentsAvailable: boolean;
  chargeCurrencies: string[];
  cancellationNoticeHours: number;
  offers: LessonOffer[];
  slots: LessonSlot[];
}
export interface OfferInput {
  title: string;
  description: string;
  durationMinutes: number;
  amountMinor: number;
  currency: string;
  active: boolean;
  version?: number;
}
@Injectable({ providedIn: 'root' })
export class BookingsApi {
  private readonly http = inject(HttpClient);
  private readonly root = API_BASE_URL + '/bookings';
  private unwrap<T>(body: T | Envelope<T>): T {
    return body && typeof body === 'object' && 'data' in body
      ? (body as Envelope<T>).data
      : (body as T);
  }
  catalogue(id: string) {
    return this.http
      .get<
        BookingCatalogue | Envelope<BookingCatalogue>
      >(`${this.root}/teachers/${encodeURIComponent(id)}/catalogue`)
      .pipe(map((body) => this.unwrap(body)));
  }
  batch(id: string) {
    return this.http
      .get<
        BookingBatchCatalogue | Envelope<BookingBatchCatalogue>
      >(`${this.root}/batches/${encodeURIComponent(id)}`)
      .pipe(map((body) => this.unwrap(body)));
  }
  reserve(id: string, body: BookingOrderRequest, batch = false) {
    return this.http
      .post<
        BookingOrder | Envelope<BookingOrder>
      >(`${this.root}/${batch ? 'batches' : 'slots'}/${encodeURIComponent(id)}/reserve`, body)
      .pipe(map((result) => this.unwrap(result)));
  }
  orders(teacher = false) {
    return this.http
      .get<
        BookingOrder[] | Envelope<BookingOrder[]>
      >(`${this.root}/${teacher ? 'teacher/' : ''}orders`)
      .pipe(map((body) => this.unwrap(body)));
  }
  order(id: string, quiet = false) {
    return this.http
      .get<
        BookingOrder | Envelope<BookingOrder>
      >(`${this.root}/orders/${encodeURIComponent(id)}`, { context: new HttpContext().set(QUIET_ERROR, quiet) })
      .pipe(map((body) => this.unwrap(body)));
  }
  refreshPayment(id: string) {
    return this.http
      .post<
        BookingOrder | Envelope<BookingOrder>
      >(`${this.root}/orders/${encodeURIComponent(id)}/refresh-payment`, {})
      .pipe(map((body) => this.unwrap(body)));
  }
  checkout(id: string) {
    return this.http
      .post<
        BookingOrder | Envelope<BookingOrder>
      >(`${this.root}/orders/${encodeURIComponent(id)}/checkout`, {})
      .pipe(map((body) => this.unwrap(body)));
  }
  cancel(id: string, reason: string, requestId: string) {
    return this.http
      .post<
        BookingOrder | Envelope<BookingOrder>
      >(`${this.root}/orders/${encodeURIComponent(id)}/cancel`, { reason, requestId })
      .pipe(map((body) => this.unwrap(body)));
  }
  availability() {
    return this.http
      .get<
        TeacherAvailability | Envelope<TeacherAvailability>
      >(`${this.root}/teacher/availability`)
      .pipe(map((body) => this.unwrap(body)));
  }
  saveOffer(input: OfferInput, id?: string) {
    const url = `${this.root}/teacher/offers${id ? '/' + encodeURIComponent(id) : ''}`;
    return (
      id
        ? this.http.patch<LessonOffer | Envelope<LessonOffer>>(url, input)
        : this.http.post<LessonOffer | Envelope<LessonOffer>>(url, input)
    ).pipe(map((body) => this.unwrap(body)));
  }
  publishSlot(offerId: string, startsAt: string) {
    return this.http.post(`${this.root}/teacher/slots`, { offerId, startsAt });
  }
  withdrawSlot(id: string) {
    return this.http.delete(
      `${this.root}/teacher/slots/${encodeURIComponent(id)}`,
    );
  }
  document(orderId: string, creditId?: string) {
    return this.http.get(
      `${this.root}/orders/${encodeURIComponent(orderId)}/${creditId ? 'credits/' + encodeURIComponent(creditId) : 'invoice'}`,
      { responseType: 'blob' },
    );
  }
}
