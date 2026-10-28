import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import type {
  TeachingCatalogEntry,
  TeachingCatalogKind,
  TeachingCatalogPage,
  TeachingCatalogSnapshot,
  TeachingCatalogWrite,
  TutorApplication,
  TutorReviewRequest,
} from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
@Injectable({ providedIn: 'root' })
export class TeachingCatalogApi {
  private readonly http = inject(HttpClient);
  private unwrap<T>(response: T | { data: T }): T {
    return response && typeof response === 'object' && 'data' in response
      ? response.data
      : (response as T);
  }
  introVideo(id: string) {
    return this.http.get(
      `${API_BASE_URL}/admin/tutor-applications/${id}/introduction-video`,
      { responseType: 'blob' },
    );
  }
  snapshot() {
    return this.http
      .get<
        TeachingCatalogSnapshot | { data: TeachingCatalogSnapshot }
      >(`${API_BASE_URL}/teaching-catalog`)
      .pipe(map((r) => this.unwrap(r)));
  }
  list(params: Record<string, string>) {
    return this.http
      .get<
        TeachingCatalogPage | { data: TeachingCatalogPage }
      >(`${API_BASE_URL}/admin/teaching-catalog`, { params })
      .pipe(map((r) => this.unwrap(r)));
  }
  save(
    kind: TeachingCatalogKind,
    id: string | null,
    body: TeachingCatalogWrite,
  ) {
    const url = `${API_BASE_URL}/admin/teaching-catalog/${kind}${id ? '/' + id : ''}`;
    return (
      id
        ? this.http.patch<
            TeachingCatalogEntry | { data: TeachingCatalogEntry }
          >(url, body)
        : this.http.post<TeachingCatalogEntry | { data: TeachingCatalogEntry }>(
            url,
            body,
          )
    ).pipe(map((r) => this.unwrap(r)));
  }
  starter() {
    return this.http.post(`${API_BASE_URL}/admin/teaching-catalog/starter`, {});
  }
  applications(status: string, page: number) {
    return this.http
      .get<
        | { items: Partial<TutorApplication>[]; total: number }
        | { data: { items: Partial<TutorApplication>[]; total: number } }
      >(`${API_BASE_URL}/admin/tutor-applications`, { params: { status, page: String(page) } })
      .pipe(map((r) => this.unwrap(r)));
  }
  application(id: string) {
    return this.http
      .get<
        TutorApplication | { data: TutorApplication }
      >(`${API_BASE_URL}/admin/tutor-applications/${id}`)
      .pipe(map((r) => this.unwrap(r)));
  }
  review(id: string, body: TutorReviewRequest) {
    return this.http
      .post<
        TutorApplication | { data: TutorApplication }
      >(`${API_BASE_URL}/admin/tutor-applications/${id}/review`, body)
      .pipe(map((r) => this.unwrap(r)));
  }
  error(error: any): string {
    const message = error?.error?.message;
    return typeof message === 'string'
      ? message
      : 'The request could not be completed. Check your entries and try again.';
  }
}
