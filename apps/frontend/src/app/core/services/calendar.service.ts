import { QUIET_ERROR } from '@sapiovian/error-ui';
import { HttpContext, HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import type {
  CalendarClass,
  CalendarChangeRequest,
  ClassNotice,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
const unwrap = <T>(r: T | { data: T }): T =>
  r && typeof r === 'object' && 'data' in r
    ? (r as { data: T }).data
    : (r as T);
@Injectable({ providedIn: 'root' })
export class CalendarApi {
  private readonly http = inject(HttpClient);
  list(from: string, to: string, quiet = false) {
    return this.http
      .get<
        CalendarClass[] | { data: CalendarClass[] }
      >(`${API_BASE_URL}/calendar/classes`, { params: { from, to }, context: new HttpContext().set(QUIET_ERROR, quiet) })
      .pipe(map(unwrap));
  }
  change(item: CalendarClass, request: CalendarChangeRequest) {
    return this.http.patch(
      `${API_BASE_URL}/calendar/batches/${encodeURIComponent(item.batchId)}/classes/${encodeURIComponent(item.id)}`,
      request,
    );
  }
  notices(quiet = true) {
    return this.http
      .get<
        ClassNotice[] | { data: ClassNotice[] }
      >(`${API_BASE_URL}/calendar/notices`, { context: new HttpContext().set(QUIET_ERROR, quiet) })
      .pipe(map(unwrap));
  }
  read(id: string) {
    return this.http.post(`${API_BASE_URL}/calendar/notices/${id}/read`, {});
  }
  preference() {
    return this.http
      .get<
        { timeZone?: string } | { data: { timeZone?: string } }
      >(`${API_BASE_URL}/calendar/preferences`)
      .pipe(map(unwrap));
  }
  googleStatus() {
    return this.http
      .get<
        | {
            configured: boolean;
            status: string;
            lastSyncAt?: string;
            message: string;
          }
        | {
            data: {
              configured: boolean;
              status: string;
              lastSyncAt?: string;
              message: string;
            };
          }
      >(`${API_BASE_URL}/calendar/google`)
      .pipe(map(unwrap));
  }
  connectGoogle() {
    return this.http
      .post<
        { url: string } | { data: { url: string } }
      >(`${API_BASE_URL}/calendar/google/connect`, {})
      .pipe(map(unwrap));
  }
  disconnectGoogle() {
    return this.http.delete(`${API_BASE_URL}/calendar/google`);
  }
  syncGoogle() {
    return this.http.post(`${API_BASE_URL}/calendar/google/sync`, {});
  }
  saveZone(timeZone: string) {
    return this.http.patch(`${API_BASE_URL}/calendar/preferences`, {
      timeZone,
    });
  }
}
