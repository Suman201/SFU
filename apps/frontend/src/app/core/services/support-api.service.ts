import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';
import { map } from 'rxjs';
import type { CreateSupportRequestRequest, SupportRequest, SupportRequestListResponse, SupportRequestStatus } from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
import { AuthService } from './auth.service';
@Injectable({ providedIn: 'root' })
export class SupportApi {
  private readonly http = inject(HttpClient); private readonly auth = inject(AuthService);
  private root() { return API_BASE_URL + (this.auth.role() === 'teacher' ? '/teacher/support/requests' : '/support/requests'); }
  private options() { return { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400, 401, 403, 404, 409, 429]) }; }
  list(page: number, view: 'mine' | 'class', status: string, search: string) { return this.http.get<{ data: SupportRequestListResponse }>(this.root(), { ...this.options(), params: { page, view, status, search } }).pipe(map(r => r.data)); }
  get(id: string) { return this.http.get<{ data: SupportRequest }>(this.root() + '/' + encodeURIComponent(id), this.options()).pipe(map(r => r.data)); }
  create(input: CreateSupportRequestRequest) { return this.http.post<{ data: SupportRequest }>(this.root(), input, this.options()).pipe(map(r => r.data)); }
  reply(row: SupportRequest, message: string, status?: SupportRequestStatus) { return this.http.post<{ data: SupportRequest }>(this.root() + '/' + encodeURIComponent(row.requestId) + '/replies', { ...(message.trim() ? { message: message.trim() } : {}), ...(status ? { status } : {}), expectedUpdatedAt: row.updatedAt }, this.options()).pipe(map(r => r.data)); }
}
