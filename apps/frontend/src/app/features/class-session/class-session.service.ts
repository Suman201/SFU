import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ChatHistoryResponse, ChatMessage, ChatMessageScope, ChatReadState, ChatThreadSummaryResponse } from '@native-sfu/contracts';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../../core/services/app-environment';

export type ClassSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type ClassroomRole = 'teacher' | 'student' | 'admin';

export interface ClassroomParticipant {
  id: string;
  userId: string;
  displayName: string;
  role: ClassroomRole;
}

export interface ClassroomPayload {
  sessionId: string;
  batchId: string;
  teacherId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: ClassSessionStatus;
  roomId: string;
  chatChannelId: string;
  whiteboardChannelId: string;
  channels: {
    chat: string;
    whiteboard: string;
  };
  role: ClassroomRole;
  canJoin: boolean;
  participants: ClassroomParticipant[];
  startedAt?: string;
  completedAt?: string;
}

export type ClassSessionChatMessage = ChatMessage;

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

@Injectable({ providedIn: 'root' })
export class ClassSessionService {
  private readonly http = inject(HttpClient);

  getCurrentForBatch(batchId: string): Observable<ClassroomPayload> {
    return this.http
      .get<ClassroomPayload | ApiEnvelope<ClassroomPayload>>(`${API_BASE_URL}/class-sessions/batches/${encodeURIComponent(batchId)}/current`)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getSession(sessionId: string, batchId?: string): Observable<ClassroomPayload> {
    const url = new URL(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}`);
    if (batchId) {
      url.searchParams.set('batchId', batchId);
    }
    return this.http.get<ClassroomPayload | ApiEnvelope<ClassroomPayload>>(url.toString()).pipe(map((response) => this.unwrapResponse(response)));
  }

  startSession(sessionId: string, batchId: string): Observable<ClassroomPayload> {
    return this.http
      .post<ClassroomPayload | ApiEnvelope<ClassroomPayload>>(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/start`, { batchId })
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  endSession(sessionId: string): Observable<ClassroomPayload> {
    return this.http
      .post<ClassroomPayload | ApiEnvelope<ClassroomPayload>>(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/end`, {})
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  joinSession(sessionId: string, batchId: string): Observable<ClassroomPayload> {
    return this.http
      .post<ClassroomPayload | ApiEnvelope<ClassroomPayload>>(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/join`, { batchId })
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  getChatHistory(
    sessionId: string,
    options: { batchId?: string; participantId?: string; scope?: ChatMessageScope; before?: string; limit?: number } = {}
  ): Observable<ChatHistoryResponse> {
    const url = new URL(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/chat`);
    if (options.batchId) {
      url.searchParams.set('batchId', options.batchId);
    }
    if (options.participantId) {
      url.searchParams.set('participantId', options.participantId);
    }
    if (options.scope) {
      url.searchParams.set('scope', options.scope);
    }
    if (options.before) {
      url.searchParams.set('before', options.before);
    }
    if (options.limit) {
      url.searchParams.set('limit', String(options.limit));
    }
    return this.http.get<ChatHistoryResponse | ApiEnvelope<ChatHistoryResponse>>(url.toString()).pipe(map((response) => this.unwrapResponse(response)));
  }

  getChatSummary(sessionId: string, options: { batchId?: string } = {}): Observable<ChatThreadSummaryResponse> {
    const url = new URL(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/chat/summary`);
    if (options.batchId) {
      url.searchParams.set('batchId', options.batchId);
    }
    return this.http
      .get<ChatThreadSummaryResponse | ApiEnvelope<ChatThreadSummaryResponse>>(url.toString())
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  markChatRead(
    sessionId: string,
    request: { batchId?: string; roomId: string; participantId?: string; scope?: ChatMessageScope; readAt?: string }
  ): Observable<ChatReadState> {
    return this.http
      .post<ChatReadState | ApiEnvelope<ChatReadState>>(`${API_BASE_URL}/class-sessions/${encodeURIComponent(sessionId)}/chat/read`, request)
      .pipe(map((response) => this.unwrapResponse(response)));
  }

  errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const backendMessage = this.backendMessage(error.error);
      if (backendMessage) return backendMessage;
      if (error.status === 0) return 'Unable to reach the server. Please check your connection and try again.';
      if (error.status === 409) return 'This class session is not open for joining yet.';
      if (error.status === 403) return 'You are not allowed to access this class session.';
      if (error.status === 404) return 'Class session not found.';
    }
    return 'Unable to load the class session right now.';
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

  private backendMessage(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    const body = error as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    if (Array.isArray(body.error)) return body.error.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    return '';
  }
}
