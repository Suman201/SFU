import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { CmsPage, CmsPageListQuery, CmsPageListResponse, ContactSubmissionAck, CreateContactSubmissionRequest } from '@native-sfu/contracts';
import { Observable, catchError, map, throwError } from 'rxjs';
import { API_BASE_URL } from './app-environment';

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

@Injectable({ providedIn: 'root' })
export class CmsService {
  constructor(private readonly http: HttpClient) {}

  getPublishedPage(slug: string, locale = 'en'): Observable<CmsPage> {
    return this.http
      .get<CmsPage | ApiEnvelope<CmsPage>>(`${API_BASE_URL}/cms/pages/${encodeURIComponent(slug)}`, {
        params: locale ? new HttpParams().set('locale', locale) : undefined
      })
      .pipe(
        map((response) => this.unwrap(response)),
        catchError((error) => throwError(() => this.toError(error)))
      );
  }

  listPublishedPages(query: CmsPageListQuery = {}): Observable<CmsPageListResponse> {
    return this.http
      .get<CmsPageListResponse | ApiEnvelope<CmsPageListResponse>>(`${API_BASE_URL}/cms/pages`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrap(response)),
        catchError((error) => throwError(() => this.toError(error)))
      );
  }

  submitContactSubmission(request: CreateContactSubmissionRequest): Observable<ContactSubmissionAck> {
    return this.http.post<ContactSubmissionAck | ApiEnvelope<ContactSubmissionAck>>(`${API_BASE_URL}/contact/submissions`, request).pipe(
      map((response) => this.unwrap(response)),
      catchError((error) => throwError(() => this.toError(error)))
    );
  }

  private toParams(query: object): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query) as Array<[string, unknown]>) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return params;
  }

  private unwrap<T>(response: T | ApiEnvelope<T>): T {
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as ApiEnvelope<T>).data;
      if (data !== undefined && data !== null) {
        return data;
      }
    }
    return response as T;
  }

  private toError(error: unknown): Error {
    if (error instanceof HttpErrorResponse && error.status === 404) {
      return new Error('CMS page not published.');
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error('CMS content could not be loaded.');
  }
}
