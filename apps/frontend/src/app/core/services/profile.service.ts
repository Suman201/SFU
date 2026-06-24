import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type {
  LiveClassSettingsPatch,
  ProfileMediaUploadResponse,
  ProfileSettings,
  ProfileUser,
  PublicTeacherProfile,
  TeacherLiveClassSettingsResponse,
  UpdateMyProfileRequest,
  UpdateMySettingsRequest
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

  getMyProfile(): Observable<ProfileUser> {
    return this.http
      .get<ProfileUser | ApiEnvelope<ProfileUser>>(`${API_BASE_URL}/profile/me`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateMyProfile(request: UpdateMyProfileRequest): Observable<ProfileUser> {
    return this.http
      .patch<ProfileUser | ApiEnvelope<ProfileUser>>(`${API_BASE_URL}/profile/me`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getMySettings(): Observable<ProfileSettings> {
    return this.http
      .get<ProfileSettings | ApiEnvelope<ProfileSettings>>(`${API_BASE_URL}/profile/me/settings`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateMySettings(request: UpdateMySettingsRequest): Observable<ProfileSettings> {
    return this.http
      .patch<ProfileSettings | ApiEnvelope<ProfileSettings>>(`${API_BASE_URL}/profile/me/settings`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getTeacherLiveSettings(): Observable<TeacherLiveClassSettingsResponse> {
    return this.http
      .get<TeacherLiveClassSettingsResponse | ApiEnvelope<TeacherLiveClassSettingsResponse>>(`${API_BASE_URL}/teacher/live-settings`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  updateTeacherLiveSettings(request: LiveClassSettingsPatch): Observable<TeacherLiveClassSettingsResponse> {
    return this.http
      .patch<TeacherLiveClassSettingsResponse | ApiEnvelope<TeacherLiveClassSettingsResponse>>(`${API_BASE_URL}/teacher/live-settings`, request)
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
      .get<PublicTeacherProfile | ApiEnvelope<PublicTeacherProfile>>(`${API_BASE_URL}/teachers/${encodeURIComponent(teacherId)}/profile`)
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
      const payload = error.error as { message?: string | string[]; error?: string } | undefined;
      const message = payload?.message;
      if (Array.isArray(message)) {
        return message.join(', ');
      }
      return message || payload?.error || error.message || 'Profile request failed.';
    }
    return error instanceof Error ? error.message : 'Profile request failed.';
  }

  private uploadProfileMedia(kind: 'avatar' | 'cover', file: File): Observable<ProfileMediaUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http
      .post<ProfileMediaUploadResponse | ApiEnvelope<ProfileMediaUploadResponse>>(`${API_BASE_URL}/profile/me/${kind}`, formData)
      .pipe(map((response) => this.unwrapResponse(response)));
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
