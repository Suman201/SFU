import type { AssignmentSubmissionSummary } from './assignments.js';
import type { RecommendationConfidence, RecommendationSource, ReviewRecommendationSeverity, ReviewRecommendationType } from './student-progress.js';

export interface TeacherAnalyticsQuery {
  batchId?: string;
  courseId?: string;
  studentId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface TeacherAnalyticsAvailability {
  available: boolean;
  source: 'snapshot' | 'inferred' | 'activity' | 'metadata' | 'progress' | 'not_tracked';
  reason?: string;
}

export interface TeacherAnalyticsAttendanceSummary {
  enrolledSlots: number;
  present: number;
  absent: number;
  attendanceRate: number;
  missedClasses: number;
  lateJoins: number;
  reconnects: number;
  averageDurationSeconds: number;
  source: 'snapshot' | 'inferred' | 'mixed' | 'none';
}

export interface TeacherAnalyticsParticipationSummary {
  handRaises: number;
  allowedSpeakingTurns: number;
  revokedSpeakingTurns: number;
  questionsAsked: number;
  qnaThreads: number;
  unansweredQuestions: number;
}

export interface TeacherAnalyticsAssignmentSummary {
  total: number;
  published: number;
  archived: number;
  due: number;
  overdue: number;
  missing: number;
  submissions: AssignmentSubmissionSummary;
}

export interface TeacherAnalyticsRecordingSummary {
  total: number;
  ready: number;
  failed: number;
  active: number;
  watched?: number;
  unwatched?: number;
  averageCompletionPercent?: number;
  totalWatchedSeconds?: number;
  usage: TeacherAnalyticsAvailability;
}

export interface TeacherAnalyticsMaterialSummary {
  total: number;
  shared: number;
  published: number;
  downloads: number;
  views?: number;
  usage: TeacherAnalyticsAvailability;
}

export type TeacherAnalyticsRiskLevel = 'low' | 'medium' | 'high';

export interface TeacherAnalyticsRiskIndicator {
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  batchId: string;
  batchName: string;
  riskLevel: TeacherAnalyticsRiskLevel;
  reasons: string[];
  sourceSessionIds: string[];
  sourceAssignmentIds: string[];
}

export interface TeacherWeakTopicSignal {
  id: string;
  type: ReviewRecommendationType;
  severity: ReviewRecommendationSeverity;
  confidence: RecommendationConfidence;
  label: string;
  explanation: string;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  topic?: string;
  tag?: string;
  affectedStudentCount: number;
  sourceRecords: RecommendationSource[];
  sourceSessionIds: string[];
  sourceAssignmentIds: string[];
  sourceRecordingIds?: string[];
  sourceMaterialIds?: string[];
  sourceWhiteboardPageIds?: string[];
  generatedAt: string;
}

export interface TeacherAnalyticsBatchSummary {
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  enrolledStudents: number;
  totalSessions: number;
  completedSessions: number;
  liveSessions: number;
  upcomingSessions: number;
  attendance: TeacherAnalyticsAttendanceSummary;
  participation: TeacherAnalyticsParticipationSummary;
  assignments: TeacherAnalyticsAssignmentSummary;
  recordings: TeacherAnalyticsRecordingSummary;
  materials: TeacherAnalyticsMaterialSummary;
  riskIndicators: TeacherAnalyticsRiskIndicator[];
  weakTopicSignals: TeacherWeakTopicSignal[];
  sourceSessionIds: string[];
  sourceAssignmentIds: string[];
}

export interface TeacherAnalyticsSummary {
  batchCount: number;
  enrolledStudents: number;
  totalSessions: number;
  completedSessions: number;
  liveSessions: number;
  upcomingSessions: number;
  attendanceRate: number;
  missedClasses: number;
  lateJoins: number;
  reconnects: number;
  handRaises: number;
  allowedSpeakingTurns: number;
  questionsAsked: number;
  unansweredQuestions: number;
  assignmentsDue: number;
  assignmentsSubmitted: number;
  assignmentsReviewed: number;
  assignmentsOverdue: number;
  assignmentsMissing: number;
  recordingsReady: number;
  materialDownloads: number;
  riskStudents: number;
  weakTopicSignals: number;
}

export interface TeacherAnalyticsResponse {
  generatedAt: string;
  query: TeacherAnalyticsQuery;
  audience: 'teacher' | 'admin';
  summary: TeacherAnalyticsSummary;
  batches: TeacherAnalyticsBatchSummary[];
  risks: TeacherAnalyticsRiskIndicator[];
  weakTopicSignals: TeacherWeakTopicSignal[];
  availability: {
    attendance: TeacherAnalyticsAvailability;
    participation: TeacherAnalyticsAvailability;
    qna: TeacherAnalyticsAvailability;
    assignments: TeacherAnalyticsAvailability;
    recordings: TeacherAnalyticsAvailability;
    materials: TeacherAnalyticsAvailability;
  };
}
