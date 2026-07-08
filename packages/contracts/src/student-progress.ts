import type { StudentClassAttendanceSource, StudentClassAttendanceStatus } from './student-class-history.js';

export interface StudentProgressAvailability {
  available: boolean;
  source: 'snapshot' | 'inferred' | 'mixed' | 'activity' | 'metadata' | 'progress' | 'not_tracked' | 'none';
  reason?: string;
}

export interface StudentProgressAttendancePoint {
  sessionId: string;
  title: string;
  scheduledAt: string;
  completedAt?: string;
  status: StudentClassAttendanceStatus;
  totalDurationSeconds: number;
  reconnectCount: number;
  source: StudentClassAttendanceSource;
}

export interface StudentProgressAssignmentSummary {
  total: number;
  due: number;
  submitted: number;
  reviewed: number;
  overdue: number;
  missing: number;
}

export interface StudentProgressRecordingSummary {
  ready: number;
  processing: number;
  failed: number;
  watched?: number;
  unwatched?: number;
  totalWatchedSeconds?: number;
  completionRate?: number;
  watchTrackingAvailable: boolean;
  usage: StudentProgressAvailability;
}

export interface StudentProgressParticipationSummary {
  handRaises: number;
  allowedSpeakingTurns: number;
  questionsAsked: number;
  answeredQuestions: number;
  unansweredQuestions: number;
  qnaThreads: number;
}

export interface StudentProgressBatchSummary {
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  enrollmentStatus?: string;
  completedClasses: number;
  attendedClasses: number;
  missedClasses: number;
  unknownAttendanceClasses: number;
  liveClasses: number;
  upcomingClasses: number;
  attendanceRate: number;
  attendanceSource: StudentProgressAvailability['source'];
  assignments: StudentProgressAssignmentSummary;
  recordings: StudentProgressRecordingSummary;
  participation: StudentProgressParticipationSummary;
  topicTags?: string[];
  recentAttendance: StudentProgressAttendancePoint[];
  sourceSessionIds: string[];
  sourceAssignmentIds: string[];
  sourceRecordingIds?: string[];
  sourceMaterialIds?: string[];
  sourceWhiteboardPageIds?: string[];
}

export interface StudentProgressSummary {
  enrolledBatches: number;
  activeBatches: number;
  completedClasses: number;
  attendedClasses: number;
  missedClasses: number;
  unknownAttendanceClasses: number;
  liveClasses: number;
  upcomingClasses: number;
  attendanceRate: number;
  assignmentsDue: number;
  assignmentsSubmitted: number;
  assignmentsReviewed: number;
  assignmentsOverdue: number;
  assignmentsMissing: number;
  recordingsReady: number;
  recordingsWatched: number;
  recordingsUnwatched: number;
  recordingWatchSeconds: number;
  recordingCompletionRate: number;
  handRaises: number;
  allowedSpeakingTurns: number;
  questionsAsked: number;
  unansweredQuestions: number;
}

export type ReviewRecommendationType =
  | 'missed_class'
  | 'overdue_assignment'
  | 'low_recording_completion'
  | 'unanswered_question'
  | 'low_participation'
  | 'tagged_topic_review'
  | 'weak_assignment_area'
  | 'attendance'
  | 'assignment'
  | 'participation'
  | 'qna'
  | 'recording';

export type ReviewRecommendationSeverity = 'info' | 'watch' | 'needs_attention';
export type RecommendationConfidence = 'low' | 'medium' | 'high';

export interface RecommendationSource {
  kind: 'session' | 'assignment' | 'recording' | 'material' | 'whiteboard' | 'qna' | 'attendance' | 'participation';
  id: string;
  label?: string;
  batchId?: string;
  sessionId?: string;
}

export interface StudentReviewRecommendation {
  id: string;
  type: ReviewRecommendationType;
  severity: ReviewRecommendationSeverity;
  confidence: RecommendationConfidence;
  batchId?: string;
  batchName?: string;
  sessionId?: string;
  assignmentId?: string;
  recordingId?: string;
  materialId?: string;
  topic?: string;
  tag?: string;
  label: string;
  explanation: string;
  detail: string;
  sourceRecords: RecommendationSource[];
  generatedAt: string;
  sourceSessionIds?: string[];
  sourceAssignmentIds?: string[];
  sourceRecordingIds?: string[];
  sourceMaterialIds?: string[];
  sourceWhiteboardPageIds?: string[];
}

export interface StudentProgressReviewSignal extends StudentReviewRecommendation {
  /** Deprecated broad category consumers can infer from `type`; retained for older UI compatibility. */
  category?: 'attendance' | 'assignment' | 'participation' | 'qna' | 'recording' | 'topic';
}

export interface LegacyStudentProgressReviewSignal {
  type: 'attendance' | 'assignment' | 'participation' | 'qna' | 'recording';
  severity: 'info' | 'watch' | 'needs_attention';
  batchId?: string;
  batchName?: string;
  label: string;
  detail: string;
  sourceSessionIds?: string[];
  sourceAssignmentIds?: string[];
}

export interface StudentProgressResponse {
  generatedAt: string;
  studentId: string;
  summary: StudentProgressSummary;
  batches: StudentProgressBatchSummary[];
  reviewSignals: StudentProgressReviewSignal[];
  availability: {
    attendance: StudentProgressAvailability;
    assignments: StudentProgressAvailability;
    recordings: StudentProgressAvailability;
    participation: StudentProgressAvailability;
    qna: StudentProgressAvailability;
  };
}
