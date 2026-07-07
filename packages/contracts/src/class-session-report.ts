import type { AssignmentSubmissionSummary } from './assignments.js';
import type { ClassSessionTimelineEvent } from './class-session-timeline.js';
import type { ClassSessionMaterial } from './materials.js';
import type { Recording } from './recordings.js';
import type { WhiteboardMemorySummary } from './whiteboard-memory.js';

export type ClassSessionReportAudience = 'teacher' | 'admin' | 'student';
export type ClassSessionReportStatus = 'completed';

export interface ClassSessionReportMetadata {
  sessionId: string;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  teacherEmail?: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMinutes: number;
  status: ClassSessionReportStatus;
  roomId?: string;
  chatChannelId?: string;
  whiteboardChannelId?: string;
}

export interface ClassSessionReportAttendanceSummary {
  enrolled: number;
  present: number;
  absent: number;
  attendanceRate: number;
  averageDurationSeconds: number;
  reconnects: number;
  lateJoins: number;
  earlyLeaves: number;
  source: 'snapshot' | 'inferred' | 'none';
}

export interface ClassSessionReportParticipationSummary {
  joins: number;
  leaves: number;
  reconnects: number;
  handRaises: number;
  allowedSpeaks: number;
  revokedSpeaks: number;
  mutedMics: number;
  stoppedCameras: number;
}

export interface ClassSessionReportBroadcastSummary {
  count: number;
  latestAt?: string;
  latestPreview?: string;
}

export interface ClassSessionReportWhiteboardSummary {
  available: boolean;
  snapshotVersion?: number;
  updatedAt?: string;
  summary?: WhiteboardMemorySummary;
}

export interface ClassSessionReportArtifactSummary {
  recordings: Recording[];
  materials: ClassSessionMaterial[];
  whiteboard: ClassSessionReportWhiteboardSummary;
}

export interface ClassSessionReportAssignmentSummary {
  total: number;
  published: number;
  archived: number;
  submissions: AssignmentSubmissionSummary;
}

export interface ClassSessionReportQnaSummary {
  threads: number;
  withQuestions: number;
  unanswered: number;
  unreadForTeacher: number;
  latestAt?: string;
}

export interface ClassSessionReportIncidentSummary {
  total: number;
  support: number;
  media: number;
  moderation: number;
  latest: ClassSessionTimelineEvent[];
}

export interface ClassSessionReport {
  audience: ClassSessionReportAudience;
  generatedAt: string;
  session: ClassSessionReportMetadata;
  attendance: ClassSessionReportAttendanceSummary;
  participation: ClassSessionReportParticipationSummary;
  broadcasts: ClassSessionReportBroadcastSummary;
  artifacts: ClassSessionReportArtifactSummary;
  assignments: ClassSessionReportAssignmentSummary;
  qna: ClassSessionReportQnaSummary;
  incidents: ClassSessionReportIncidentSummary;
}
