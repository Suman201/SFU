import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';
import { map } from 'rxjs';
import type { CmsMedia, CmsMediaPage } from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
@Injectable({ providedIn: 'root' })
export class CmsMediaApi {
  private readonly http = inject(HttpClient); private readonly root = API_BASE_URL + '/admin/cms/media';
  private options() { return { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400, 403, 404, 409, 413, 429, 503]) }; }
  list(page: number, q: string, archived: boolean) { return this.http.get<{ data: CmsMediaPage }>(this.root, { ...this.options(), params: { page, q, archived } }).pipe(map(r => r.data)); }
  file(id: string) { return this.http.get(this.root + '/' + encodeURIComponent(id) + '/file', { ...this.options(), responseType: 'blob' }); }
  upload(file: File, title: string, altText: string) { const body = new FormData(); body.append('file', file); body.append('title', title); body.append('altText', altText); return this.http.post<{ data: CmsMedia }>(this.root, body, this.options()).pipe(map(r => r.data)); }
  update(row: CmsMedia, input: { title?: string; altText?: string; archived?: boolean }) { return this.http.patch<{ data: CmsMedia }>(this.root + '/' + encodeURIComponent(row.id), { revision: row.revision, ...input }, this.options()).pipe(map(r => r.data)); }
}
