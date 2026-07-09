export type SupportIssueType =
  | 'access'
  | 'class_issue'
  | 'recording_access'
  | 'recording_problem'
  | 'audio_video'
  | 'assignment'
  | 'other';

export type SupportRequestStatus = 'open' | 'in_review' | 'waiting_for_student' | 'resolved' | 'closed';

export interface SupportRequestDiagnostics {
  userAgent?: string;
  route?: string;
  timestamp?: string;
  microphonePermission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  cameraPermission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  browser?: string;
  platform?: string;
  classSessionStatus?: string;
  roomStatus?: 'active' | 'closed' | 'unknown';
  teacherConnectionState?: 'connected' | 'reconnecting' | 'absent' | 'not_started' | 'ended';
  recordingStatus?: string;
}

export interface CreateSupportRequestRequest {
  issueType: SupportIssueType;
  subject: string;
  message: string;
  batchId?: string;
  sessionId?: string;
  roomId?: string;
  recordingId?: string;
  diagnostics?: SupportRequestDiagnostics;
}

export interface SupportRequestComment {
  id: string;
  authorId: string;
  authorName: string;
  authorRoles: string[];
  message: string;
  createdAt: string;
  visibleToStudent: boolean;
}

export interface SupportRequest {
  id: string;
  requestId: string;
  studentId: string;
  studentName: string;
  studentEmail?: string;
  batchId?: string;
  batchName?: string;
  teacherId?: string;
  sessionId?: string;
  sessionTitle?: string;
  roomId?: string;
  recordingId?: string;
  issueType: SupportIssueType;
  status: SupportRequestStatus;
  subject: string;
  message: string;
  diagnostics?: SupportRequestDiagnostics;
  assignedToUserId?: string;
  assignedToName?: string;
  comments: SupportRequestComment[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  closedAt?: string;
}

export interface SupportRequestListQuery {
  page?: number;
  limit?: number;
  status?: SupportRequestStatus | 'all';
  issueType?: SupportIssueType | 'all';
  batchId?: string;
  sessionId?: string;
  studentId?: string;
  search?: string;
}

export interface SupportRequestListResponse {
  items: SupportRequest[];
  page: number;
  limit: number;
  total: number;
  summary: {
    open: number;
    inReview: number;
    waitingForStudent: number;
    resolved: number;
    closed: number;
  };
}

export interface UpdateSupportRequestRequest {
  status?: SupportRequestStatus;
  assignedToUserId?: string;
  assignedToName?: string;
  response?: string;
  internalNote?: string;
}
