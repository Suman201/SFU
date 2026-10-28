import type {
  TeachingCatalogSnapshot,
  TutorApplication,
  TutorOnboardingNotice,
  TutorVerificationDocument,
  TutorVerificationKind,
} from '@native-sfu/contracts';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type {
  CreateTeacherPublicContentRequest,
  LiveClassSettingsPatch,
  ProfileMediaUploadResponse,
  ProfileSettings,
  ProfileUser,
  PublicTeacherListQuery,
  PublicTeacherListResponse,
  PublicTeacherProfile,
  TeacherPromotion,
  TeacherPromotionListResponse,
  TeacherPromotionRequest,
  TeacherPublicContentItem,
  TeacherPublicContentListResponse,
  TeacherLiveClassSettingsResponse,
  UpdateTeacherPublicContentRequest,
  UpdateMyProfileRequest,
  UpdateMySettingsRequest,
} from '@native-sfu/contracts';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from './app-environment';

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  constructor(private readonly http: HttpClient) {}

  tutorNotices() {
    return this.http
      .get<
        TutorOnboardingNotice[] | ApiEnvelope<TutorOnboardingNotice[]>
      >(`${API_BASE_URL}/tutor-application/notices`)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  readTutorNotice(id: string) {
    return this.http.post(
      `${API_BASE_URL}/tutor-application/notices/${encodeURIComponent(id)}/read`,
      {},
    );
  }
  uploadVerificationDocument(kind: TutorVerificationKind, file: File) {
    const data = new FormData();
    data.append('file', file);
    return this.http
      .post<
        TutorVerificationDocument | ApiEnvelope<TutorVerificationDocument>
      >(`${API_BASE_URL}/tutor-application/me/verification-documents/${kind}`, data)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  downloadVerificationDocument(id: string) {
    return this.http.get(
      `${API_BASE_URL}/tutor-application/me/verification-documents/${encodeURIComponent(id)}`,
      { responseType: 'blob' },
    );
  }
  removeVerificationDocument(id: string) {
    return this.http.delete(
      `${API_BASE_URL}/tutor-application/me/verification-documents/${encodeURIComponent(id)}`,
    );
  }
  uploadIntroVideo(file: File) {
    const data = new FormData();
    data.append('file', file);
    return this.http
      .post<
        | { introVideoUploaded: boolean; introVideoDurationSeconds: number }
        | ApiEnvelope<{
            introVideoUploaded: boolean;
            introVideoDurationSeconds: number;
          }>
      >(`${API_BASE_URL}/tutor-application/me/introduction-video`, data)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  previewIntroVideo() {
    return this.http.get(
      `${API_BASE_URL}/tutor-application/me/introduction-video`,
      { responseType: 'blob' },
    );
  }
  removeIntroVideo() {
    return this.http.delete(
      `${API_BASE_URL}/tutor-application/me/introduction-video`,
    );
  }
  teachingCatalog(): Observable<TeachingCatalogSnapshot> {
    return this.http
      .get<
        TeachingCatalogSnapshot | ApiEnvelope<TeachingCatalogSnapshot>
      >(`${API_BASE_URL}/teaching-catalog`)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  tutorApplication(): Observable<TutorApplication> {
    return this.http
      .get<
        TutorApplication | ApiEnvelope<TutorApplication>
      >(`${API_BASE_URL}/tutor-application/me`)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  submitTutorApplication(body: {
    revision: number;
    adultTutorConfirmed: boolean;
    codeOfConductAccepted: boolean;
    safeguardingAccepted: boolean;
  }): Observable<TutorApplication> {
    return this.http
      .post<
        TutorApplication | ApiEnvelope<TutorApplication>
      >(`${API_BASE_URL}/tutor-application/submit`, body)
      .pipe(map((r) => this.unwrapResponse(r)));
  }
  getMyProfile(): Observable<ProfileUser> {
    return this.http
      .get<ProfileUser | ApiEnvelope<ProfileUser>>(`${API_BASE_URL}/profile/me`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateMyProfile(request: UpdateMyProfileRequest): Observable<ProfileUser> {
    return this.http
      .patch<
        ProfileUser | ApiEnvelope<ProfileUser>
      >(`${API_BASE_URL}/profile/me`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getMySettings(): Observable<ProfileSettings> {
    return this.http
      .get<
        ProfileSettings | ApiEnvelope<ProfileSettings>
      >(`${API_BASE_URL}/profile/me/settings`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateMySettings(
    request: UpdateMySettingsRequest,
  ): Observable<ProfileSettings> {
    return this.http
      .patch<
        ProfileSettings | ApiEnvelope<ProfileSettings>
      >(`${API_BASE_URL}/profile/me/settings`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getTeacherLiveSettings(): Observable<TeacherLiveClassSettingsResponse> {
    return this.http
      .get<
        | TeacherLiveClassSettingsResponse
        | ApiEnvelope<TeacherLiveClassSettingsResponse>
      >(`${API_BASE_URL}/teacher/live-settings`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateTeacherLiveSettings(
    request: LiveClassSettingsPatch,
  ): Observable<TeacherLiveClassSettingsResponse> {
    return this.http
      .patch<
        | TeacherLiveClassSettingsResponse
        | ApiEnvelope<TeacherLiveClassSettingsResponse>
      >(`${API_BASE_URL}/teacher/live-settings`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  uploadProfileAvatar(file: File): Observable<ProfileMediaUploadResponse> {
    return this.uploadProfileMedia('avatar', file);
  }

  uploadProfileCover(file: File): Observable<ProfileMediaUploadResponse> {
    return this.uploadProfileMedia('cover', file);
  }

  getPublicTeacherProfile(teacherId: string): Observable<PublicTeacherProfile> {
    return this.http
      .get<
        PublicTeacherProfile | ApiEnvelope<PublicTeacherProfile>
      >(`${API_BASE_URL}/teachers/${encodeURIComponent(teacherId)}/profile`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  listPublicTeachers(
    query: PublicTeacherListQuery = {},
  ): Observable<PublicTeacherListResponse> {
    const params = this.publicTeacherListParams(query);
    return this.http
      .get<
        PublicTeacherListResponse | ApiEnvelope<PublicTeacherListResponse>
      >(`${API_BASE_URL}/teachers`, { params })
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  listMyPromotions(): Observable<TeacherPromotionListResponse> {
    return this.http
      .get<
        TeacherPromotionListResponse | ApiEnvelope<TeacherPromotionListResponse>
      >(`${API_BASE_URL}/teachers/me/promotions`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  requestMyPromotion(
    request: TeacherPromotionRequest,
  ): Observable<TeacherPromotion> {
    return this.http
      .post<
        TeacherPromotion | ApiEnvelope<TeacherPromotion>
      >(`${API_BASE_URL}/teachers/me/promotions/request`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  listMyPublicContent(): Observable<TeacherPublicContentListResponse> {
    return this.http
      .get<
        | TeacherPublicContentListResponse
        | ApiEnvelope<TeacherPublicContentListResponse>
      >(`${API_BASE_URL}/profile/me/public-content`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  createMyPublicContent(
    request: CreateTeacherPublicContentRequest,
  ): Observable<TeacherPublicContentItem> {
    return this.http
      .post<
        TeacherPublicContentItem | ApiEnvelope<TeacherPublicContentItem>
      >(`${API_BASE_URL}/profile/me/public-content`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateMyPublicContent(
    contentId: string,
    request: UpdateTeacherPublicContentRequest,
  ): Observable<TeacherPublicContentItem> {
    return this.http
      .patch<
        TeacherPublicContentItem | ApiEnvelope<TeacherPublicContentItem>
      >(`${API_BASE_URL}/profile/me/public-content/${encodeURIComponent(contentId)}`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  publishMyPublicContent(
    contentId: string,
  ): Observable<TeacherPublicContentItem> {
    return this.http
      .post<
        TeacherPublicContentItem | ApiEnvelope<TeacherPublicContentItem>
      >(`${API_BASE_URL}/profile/me/public-content/${encodeURIComponent(contentId)}/publish`, {})
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  unpublishMyPublicContent(
    contentId: string,
  ): Observable<TeacherPublicContentItem> {
    return this.http
      .post<
        TeacherPublicContentItem | ApiEnvelope<TeacherPublicContentItem>
      >(`${API_BASE_URL}/profile/me/public-content/${encodeURIComponent(contentId)}/unpublish`, {})
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  deleteMyPublicContent(
    contentId: string,
  ): Observable<{ contentId: string; deleted: true }> {
    return this.http
      .delete<
        | { contentId: string; deleted: true }
        | ApiEnvelope<{ contentId: string; deleted: true }>
      >(`${API_BASE_URL}/profile/me/public-content/${encodeURIComponent(contentId)}`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  uploadPublicContentMedia(
    contentId: string,
    file: File,
  ): Observable<TeacherPublicContentItem> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http
      .post<
        TeacherPublicContentItem | ApiEnvelope<TeacherPublicContentItem>
      >(`${API_BASE_URL}/profile/me/public-content/${encodeURIComponent(contentId)}/file`, formData)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  resolveMediaUrl(value: string | undefined): string {
    if (!value) {
      return '';
    }
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) {
      return value;
    }
    const apiOrigin = new URL(API_BASE_URL).origin;
    return `${apiOrigin}${value.startsWith('/') ? value : `/${value}`}`;
  }

  errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const payload = error.error as
        | { message?: string | string[]; error?: string }
        | undefined;
      const message = payload?.message;
      if (Array.isArray(message)) {
        return message.join(', ');
      }
      return (
        message || payload?.error || error.message || 'Profile request failed.'
      );
    }
    return error instanceof Error ? error.message : 'Profile request failed.';
  }

  private uploadProfileMedia(
    kind: 'avatar' | 'cover',
    file: File,
  ): Observable<ProfileMediaUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http
      .post<
        ProfileMediaUploadResponse | ApiEnvelope<ProfileMediaUploadResponse>
      >(`${API_BASE_URL}/profile/me/${kind}`, formData)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  private publicTeacherListParams(
    query: PublicTeacherListQuery,
  ): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      params[key] = String(value);
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
}
