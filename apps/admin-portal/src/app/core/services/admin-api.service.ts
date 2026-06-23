import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type {
  AdminAttendanceQuery,
  AdminAttendanceSessionsResponse,
  AdminAttendanceStudentsResponse,
  AdminAttendanceSummary,
  AdminAttendanceTrendsResponse,
  AdminClassSessionReportQuery,
  AdminClassSessionReportResponse,
  AdminClassSessionReportRow,
  AdminBatchCreateRequest,
  AdminBatchDetail,
  AdminBatchListQuery,
  AdminBatchListResponse,
  AdminBatchRosterResponse,
  AdminBatchSessionListResponse,
  AdminBatchUpdateRequest,
  AdminCreateEnrollmentRequest,
  AdminCourseDetail,
  AdminCourseListQuery,
  AdminCourseListResponse,
  AdminCourseUpdateRequest,
  AdminEnrollmentDetail,
  AdminEnrollmentListQuery,
  AdminEnrollmentListResponse,
  AdminRecordingDetail,
  AdminRecordingListQuery,
  AdminRecordingListResponse,
  AdminRecordingPlaybackResponse,
  AdminRecordingRetentionUpdateRequest,
  AdminUpdateEnrollmentRequest,
  AdminUserActionResponse,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserUpdateRequest
} from '@native-sfu/contracts';
import { Observable, catchError, map, throwError } from 'rxjs';
import { API_BASE_URL } from './app-environment';

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

@Injectable({ providedIn: 'root' })
export class AdminApiService {
  constructor(private readonly http: HttpClient) {}

  getAttendanceSummary(query: AdminAttendanceQuery): Observable<AdminAttendanceSummary> {
    return this.http
      .get<AdminAttendanceSummary | ApiEnvelope<AdminAttendanceSummary>>(`${API_BASE_URL}/admin/attendance/summary`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listAttendanceSessions(query: AdminAttendanceQuery): Observable<AdminAttendanceSessionsResponse> {
    return this.http
      .get<AdminAttendanceSessionsResponse | ApiEnvelope<AdminAttendanceSessionsResponse>>(`${API_BASE_URL}/admin/attendance/sessions`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listAttendanceStudents(query: AdminAttendanceQuery): Observable<AdminAttendanceStudentsResponse> {
    return this.http
      .get<AdminAttendanceStudentsResponse | ApiEnvelope<AdminAttendanceStudentsResponse>>(`${API_BASE_URL}/admin/attendance/students`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getAttendanceTrends(query: AdminAttendanceQuery): Observable<AdminAttendanceTrendsResponse> {
    return this.http
      .get<AdminAttendanceTrendsResponse | ApiEnvelope<AdminAttendanceTrendsResponse>>(`${API_BASE_URL}/admin/attendance/trends`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  exportAttendanceCsv(query: AdminAttendanceQuery): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/admin/attendance/export.csv`, {
        params: this.toParams(query),
        responseType: 'blob'
      })
      .pipe(catchError((error) => throwError(() => this.toApiError(error))));
  }

  listClassSessions(query: AdminClassSessionReportQuery): Observable<AdminClassSessionReportResponse> {
    return this.http
      .get<AdminClassSessionReportResponse | ApiEnvelope<AdminClassSessionReportResponse>>(`${API_BASE_URL}/admin/class-sessions`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getClassSession(sessionId: string): Observable<AdminClassSessionReportRow> {
    return this.http
      .get<AdminClassSessionReportRow | ApiEnvelope<AdminClassSessionReportRow>>(
        `${API_BASE_URL}/admin/class-sessions/${encodeURIComponent(sessionId)}`
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  downloadAttendance(sessionId: string): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/admin/class-sessions/${encodeURIComponent(sessionId)}/attendance.csv`, { responseType: 'blob' })
      .pipe(catchError((error) => throwError(() => this.toApiError(error))));
  }

  listEnrollments(query: AdminEnrollmentListQuery): Observable<AdminEnrollmentListResponse> {
    return this.http
      .get<AdminEnrollmentListResponse | ApiEnvelope<AdminEnrollmentListResponse>>(`${API_BASE_URL}/admin/enrollments`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getEnrollment(enrollmentId: string): Observable<AdminEnrollmentDetail> {
    return this.http
      .get<AdminEnrollmentDetail | ApiEnvelope<AdminEnrollmentDetail>>(`${API_BASE_URL}/admin/enrollments/${encodeURIComponent(enrollmentId)}`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  createEnrollment(request: AdminCreateEnrollmentRequest): Observable<AdminEnrollmentDetail> {
    return this.http.post<AdminEnrollmentDetail | ApiEnvelope<AdminEnrollmentDetail>>(`${API_BASE_URL}/admin/enrollments`, request).pipe(
      map((response) => this.unwrapResponse(response)),
      catchError((error) => throwError(() => this.toApiError(error)))
    );
  }

  updateEnrollment(enrollmentId: string, request: AdminUpdateEnrollmentRequest): Observable<AdminEnrollmentDetail> {
    return this.http
      .patch<AdminEnrollmentDetail | ApiEnvelope<AdminEnrollmentDetail>>(
        `${API_BASE_URL}/admin/enrollments/${encodeURIComponent(enrollmentId)}`,
        request
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  transitionEnrollment(enrollmentId: string, action: 'cancel' | 'suspend' | 'reactivate' | 'complete'): Observable<AdminEnrollmentDetail> {
    return this.http
      .patch<AdminEnrollmentDetail | ApiEnvelope<AdminEnrollmentDetail>>(
        `${API_BASE_URL}/admin/enrollments/${encodeURIComponent(enrollmentId)}/${action}`,
        {}
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listUsers(query: AdminUserListQuery): Observable<AdminUserListResponse> {
    return this.http
      .get<AdminUserListResponse | ApiEnvelope<AdminUserListResponse>>(`${API_BASE_URL}/admin/users`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getUser(userId: string): Observable<AdminUserDetail> {
    return this.http
      .get<AdminUserDetail | ApiEnvelope<AdminUserDetail>>(`${API_BASE_URL}/admin/users/${encodeURIComponent(userId)}`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  updateUser(userId: string, request: AdminUserUpdateRequest): Observable<AdminUserDetail> {
    return this.http
      .patch<AdminUserDetail | ApiEnvelope<AdminUserDetail>>(`${API_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, request)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  activateUser(userId: string): Observable<AdminUserActionResponse> {
    return this.http
      .post<AdminUserActionResponse | ApiEnvelope<AdminUserActionResponse>>(
        `${API_BASE_URL}/admin/users/${encodeURIComponent(userId)}/activate`,
        {}
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  deactivateUser(userId: string): Observable<AdminUserActionResponse> {
    return this.http
      .post<AdminUserActionResponse | ApiEnvelope<AdminUserActionResponse>>(
        `${API_BASE_URL}/admin/users/${encodeURIComponent(userId)}/deactivate`,
        {}
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listCourses(query: AdminCourseListQuery): Observable<AdminCourseListResponse> {
    return this.http
      .get<AdminCourseListResponse | ApiEnvelope<AdminCourseListResponse>>(`${API_BASE_URL}/admin/courses`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getCourse(courseId: string): Observable<AdminCourseDetail> {
    return this.http
      .get<AdminCourseDetail | ApiEnvelope<AdminCourseDetail>>(`${API_BASE_URL}/admin/courses/${encodeURIComponent(courseId)}`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  updateCourse(courseId: string, request: AdminCourseUpdateRequest): Observable<AdminCourseDetail> {
    return this.http
      .patch<AdminCourseDetail | ApiEnvelope<AdminCourseDetail>>(`${API_BASE_URL}/admin/courses/${encodeURIComponent(courseId)}`, request)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listBatches(query: AdminBatchListQuery): Observable<AdminBatchListResponse> {
    return this.http
      .get<AdminBatchListResponse | ApiEnvelope<AdminBatchListResponse>>(`${API_BASE_URL}/admin/batches`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getBatch(batchId: string): Observable<AdminBatchDetail> {
    return this.http
      .get<AdminBatchDetail | ApiEnvelope<AdminBatchDetail>>(`${API_BASE_URL}/admin/batches/${encodeURIComponent(batchId)}`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  createBatch(courseId: string, request: AdminBatchCreateRequest): Observable<AdminBatchDetail> {
    return this.http
      .post<AdminBatchDetail | ApiEnvelope<AdminBatchDetail>>(`${API_BASE_URL}/admin/courses/${encodeURIComponent(courseId)}/batches`, request)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  updateBatch(batchId: string, request: AdminBatchUpdateRequest): Observable<AdminBatchDetail> {
    return this.http
      .patch<AdminBatchDetail | ApiEnvelope<AdminBatchDetail>>(`${API_BASE_URL}/admin/batches/${encodeURIComponent(batchId)}`, request)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  transitionBatch(batchId: string, action: 'activate' | 'pause' | 'complete' | 'cancel'): Observable<AdminBatchDetail> {
    return this.http
      .post<AdminBatchDetail | ApiEnvelope<AdminBatchDetail>>(`${API_BASE_URL}/admin/batches/${encodeURIComponent(batchId)}/${action}`, {})
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getBatchRoster(batchId: string): Observable<AdminBatchRosterResponse> {
    return this.http
      .get<AdminBatchRosterResponse | ApiEnvelope<AdminBatchRosterResponse>>(`${API_BASE_URL}/admin/batches/${encodeURIComponent(batchId)}/roster`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getBatchSessions(batchId: string): Observable<AdminBatchSessionListResponse> {
    return this.http
      .get<AdminBatchSessionListResponse | ApiEnvelope<AdminBatchSessionListResponse>>(
        `${API_BASE_URL}/admin/batches/${encodeURIComponent(batchId)}/sessions`
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  listRecordings(query: AdminRecordingListQuery): Observable<AdminRecordingListResponse> {
    return this.http
      .get<AdminRecordingListResponse | ApiEnvelope<AdminRecordingListResponse>>(`${API_BASE_URL}/admin/recordings`, {
        params: this.toParams(query)
      })
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getRecording(recordingId: string): Observable<AdminRecordingDetail> {
    return this.http
      .get<AdminRecordingDetail | ApiEnvelope<AdminRecordingDetail>>(`${API_BASE_URL}/admin/recordings/${encodeURIComponent(recordingId)}`)
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  getRecordingPlayback(recordingId: string): Observable<AdminRecordingPlaybackResponse> {
    return this.http
      .get<AdminRecordingPlaybackResponse | ApiEnvelope<AdminRecordingPlaybackResponse>>(
        `${API_BASE_URL}/admin/recordings/${encodeURIComponent(recordingId)}/playback`
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  downloadRecording(recordingId: string): Observable<Blob> {
    return this.http
      .get(`${API_BASE_URL}/admin/recordings/${encodeURIComponent(recordingId)}/download`, { responseType: 'blob' })
      .pipe(catchError((error) => throwError(() => this.toApiError(error))));
  }

  updateRecordingRetention(recordingId: string, request: AdminRecordingRetentionUpdateRequest): Observable<AdminRecordingDetail> {
    return this.http
      .patch<AdminRecordingDetail | ApiEnvelope<AdminRecordingDetail>>(
        `${API_BASE_URL}/admin/recordings/${encodeURIComponent(recordingId)}/retention`,
        request
      )
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  archiveRecording(recordingId: string): Observable<AdminRecordingDetail> {
    return this.http
      .post<AdminRecordingDetail | ApiEnvelope<AdminRecordingDetail>>(`${API_BASE_URL}/admin/recordings/${encodeURIComponent(recordingId)}/archive`, {})
      .pipe(
        map((response) => this.unwrapResponse(response)),
        catchError((error) => throwError(() => this.toApiError(error)))
      );
  }

  saveAttendanceCsv(session: AdminClassSessionReportRow): void {
    this.downloadAttendance(session.sessionId).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = this.attendanceFileName(session);
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: () => undefined
    });
  }

  apiErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed. Please try again.';
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

  private unwrapResponse<T>(response: T | ApiEnvelope<T>): T {
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as ApiEnvelope<T>).data;
      if (data !== undefined && data !== null) {
        return data;
      }
    }
    return response as T;
  }

  private attendanceFileName(session: AdminClassSessionReportRow): string {
    const safeTitle = `${session.batchName}-${session.sessionNumber}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    return `${safeTitle || 'class-session'}-attendance.csv`;
  }

  private toApiError(error: unknown): Error {
    if (error instanceof Error && !(error instanceof HttpErrorResponse)) {
      return error;
    }
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return new Error('Could not reach the backend. Check the API URL and try again.');
      }
      if (error.status === 401 || error.status === 403) {
        return new Error('You are not allowed to access this admin resource.');
      }
      const message = this.extractBackendMessage(error.error);
      return new Error(message || 'The admin request failed. Please try again.');
    }
    return new Error('The admin request failed. Please try again.');
  }

  private extractBackendMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return '';
    }
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string') {
      return value.message;
    }
    if (Array.isArray(value.message)) {
      return value.message.join(' ');
    }
    if (typeof value.error === 'string') {
      return value.error;
    }
    return '';
  }
}
