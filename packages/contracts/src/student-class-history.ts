import type { ChatHistoryResponse, ChatMessage, ChatThreadSummaryResponse } from './chat.js';
import type { ClassSessionMaterial } from './materials.js';
import type { Recording } from './recordings.js';
import type { WhiteboardMemorySummary } from './whiteboard-memory.js';

export type StudentClassAttendanceStatus = 'present' | 'absent' | 'unknown';
export type StudentClassAttendanceSource = 'snapshot' | 'inferred' | 'none';

export interface StudentClassAttendanceSummary {
  status: StudentClassAttendanceStatus;
  firstJoinAt?: string;
  lastLeaveAt?: string;
  totalDurationSeconds: number;
  reconnectCount: number;
  source: StudentClassAttendanceSource;
}

export interface StudentCompletedClassSessionListItem {
  sessionId: string;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMinutes: number;
  status: 'completed';
  recordingAvailable: boolean;
  recordingStatus?: Recording['status'];
  materialCount: number;
  notesAvailable: boolean;
  notesPageCount: number;
  qnaUnreadCount: number;
  qnaLastMessageAt?: string;
  attendance: StudentClassAttendanceSummary;
}

export interface StudentCompletedClassSessionListResponse {
  items: StudentCompletedClassSessionListItem[];
  page: number;
  limit: number;
  total: number;
}

export interface StudentCompletedClassWhiteboardSummary {
  available: boolean;
  snapshotVersion?: number;
  updatedAt?: string;
  publishedAt?: string;
  publishedByUserId?: string;
  unpublishedAt?: string;
  summary?: WhiteboardMemorySummary;
}

export interface StudentCompletedClassDetailResponse {
  session: StudentCompletedClassSessionListItem;
  recordings: Recording[];
  materials: ClassSessionMaterial[];
  whiteboard: StudentCompletedClassWhiteboardSummary;
  announcements: ChatMessage[];
  privateThread: ChatHistoryResponse;
  chatSummary?: ChatThreadSummaryResponse;
  attendance: StudentClassAttendanceSummary;
}

export interface SendPostClassQuestionRequest {
  batchId?: string;
  recipientId?: string;
  message: string;
}
