export type AdminClassSessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';

export interface AdminClassSessionAttendanceSummary {
  enrolled: number;
  present: number;
  absent: number;
  reconnects: number;
  averageDurationSeconds: number;
}

export interface AdminClassSessionReportRow {
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
  status: AdminClassSessionStatus;
  roomId?: string;
  attendance: AdminClassSessionAttendanceSummary;
}

export interface AdminClassSessionReportSummary {
  totalSessions: number;
  liveSessions: number;
  completedSessions: number;
  averageAttendancePercent: number;
}

export interface AdminClassSessionReportResponse {
  items: AdminClassSessionReportRow[];
  summary: AdminClassSessionReportSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminClassSessionReportQuery {
  status?: AdminClassSessionStatus | 'all';
  teacherId?: string;
  batchId?: string;
  courseId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

export type AdminEnrollmentStatus = 'active' | 'pending' | 'completed' | 'cancelled' | 'suspended';

export interface AdminEnrollmentAccessImpact {
  canAccessClassSessions: boolean;
  reason: string;
}

export interface AdminEnrollmentListItem {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  courseId?: string;
  batchId: string;
  batchName: string;
  teacherId?: string;
  status: AdminEnrollmentStatus;
  access: AdminEnrollmentAccessImpact;
  enrolledAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  suspendedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminEnrollmentDetail extends AdminEnrollmentListItem {
  createdBy?: string;
  updatedBy?: string;
}

export interface AdminEnrollmentSummary {
  totalEnrollments: number;
  activeEnrollments: number;
  suspendedEnrollments: number;
  recentlyAdded: number;
  lowEnrollmentBatches: number;
}

export interface AdminEnrollmentListResponse {
  items: AdminEnrollmentListItem[];
  summary: AdminEnrollmentSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminEnrollmentListQuery {
  courseId?: string;
  batchId?: string;
  studentId?: string;
  status?: AdminEnrollmentStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
}

export interface AdminCreateEnrollmentRequest {
  studentId: string;
  batchId: string;
  status?: AdminEnrollmentStatus;
}

export interface AdminUpdateEnrollmentRequest {
  status?: AdminEnrollmentStatus;
}

export type AdminUserRole = 'teacher' | 'student' | 'admin' | 'super_admin';
export type AdminUserStatus = 'active' | 'inactive' | 'suspended' | 'invited';
export type AdminUserSort = 'created_desc' | 'created_asc' | 'name_asc' | 'email_asc' | 'last_login_desc';

export interface AdminUserListItem {
  id: string;
  name: string;
  displayName?: string;
  email: string;
  phone?: string;
  roles: AdminUserRole[];
  primaryRole: AdminUserRole;
  status: AdminUserStatus;
  disabled: boolean;
  emailVerifiedAt?: string;
  lastLoginAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminUserDetail extends AdminUserListItem {
  permissions: string[];
}

export interface AdminUserSummary {
  totalUsers: number;
  teachers: number;
  students: number;
  admins: number;
  disabledUsers: number;
}

export interface AdminUserListQuery {
  role?: AdminUserRole | 'all';
  status?: AdminUserStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
  sort?: AdminUserSort;
}

export interface AdminUserListResponse {
  items: AdminUserListItem[];
  summary: AdminUserSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminUserUpdateRequest {
  name?: string;
  displayName?: string;
  phone?: string;
  roles?: AdminUserRole[];
  status?: AdminUserStatus;
  disabled?: boolean;
}

export interface AdminUserActionResponse {
  action: 'activated' | 'deactivated';
  user: AdminUserDetail;
}

export type AdminCourseStatus = 'active' | 'inactive' | 'completed' | 'cancelled';
export type AdminCourseSort = 'updated_desc' | 'updated_asc' | 'name_asc' | 'name_desc';
export type AdminBatchStatus = 'ACTIVE' | 'INACTIVE' | 'COMPLETED' | 'CANCELLED';
export type AdminBatchSort = 'updated_desc' | 'updated_asc' | 'name_asc' | 'name_desc' | 'start_asc' | 'start_desc';
export type AdminBatchWeekday = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export interface AdminBatchScheduleItem {
  id?: string;
  dayOfWeek: AdminBatchWeekday;
  startTime: string;
}

export interface AdminCourseSummary {
  totalCourses: number;
  activeCourses: number;
  inactiveCourses: number;
  archivedCourses: number;
}

export interface AdminCourseListItem {
  courseId: string;
  courseName: string;
  status: AdminCourseStatus;
  batchCount: number;
  activeBatchCount: number;
  activeStudentCount: number;
  teacherCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminCourseDetail extends AdminCourseListItem {
  batches: AdminBatchListItem[];
}

export interface AdminCourseListQuery {
  status?: AdminCourseStatus | 'all';
  search?: string;
  sort?: AdminCourseSort;
  page?: number;
  limit?: number;
}

export interface AdminCourseListResponse {
  items: AdminCourseListItem[];
  summary: AdminCourseSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminCourseUpdateRequest {
  courseName?: string;
}

export interface AdminBatchSummary {
  totalBatches: number;
  activeBatches: number;
  completedBatches: number;
  cancelledBatches: number;
  activeStudents: number;
}

export interface AdminBatchListItem {
  id: string;
  name: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  teacherEmail?: string;
  year: number;
  startDate: string;
  endDate: string;
  maxCapacity: number;
  enrolledCount: number;
  status: AdminBatchStatus;
  schedule: AdminBatchScheduleItem[];
  nextSessionAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminBatchSessionItem {
  id: string;
  batchId: string;
  title: string;
  sessionNumber: number;
  scheduledAt: string;
  durationMinutes: number;
  status: AdminClassSessionStatus;
  roomId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AdminBatchRosterItem {
  id: string;
  enrollmentId: string;
  userId: string;
  displayName: string;
  email: string;
  status: AdminEnrollmentStatus;
  joinedAt: string;
}

export interface AdminBatchDetail extends AdminBatchListItem {
  roster: AdminBatchRosterItem[];
  sessions: AdminBatchSessionItem[];
}

export interface AdminBatchListQuery {
  courseId?: string;
  teacherId?: string;
  status?: AdminBatchStatus | 'all';
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: AdminBatchSort;
  page?: number;
  limit?: number;
}

export interface AdminBatchListResponse {
  items: AdminBatchListItem[];
  summary: AdminBatchSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminBatchCreateRequest {
  name: string;
  teacherId: string;
  courseName?: string;
  year: number;
  maxCapacity: number;
  schedule: AdminBatchScheduleItem[];
}

export interface AdminBatchUpdateRequest {
  name?: string;
  courseId?: string;
  courseName?: string;
  teacherId?: string;
  year?: number;
  maxCapacity?: number;
  schedule?: AdminBatchScheduleItem[];
  status?: AdminBatchStatus;
}

export interface AdminBatchRosterResponse {
  batchId: string;
  items: AdminBatchRosterItem[];
  total: number;
}

export interface AdminBatchSessionListResponse {
  batchId: string;
  items: AdminBatchSessionItem[];
  total: number;
}

export type AdminRecordingStatus = 'starting' | 'recording' | 'stopping' | 'stopped' | 'failed' | 'expired';
export type AdminRecordingSort = 'started_desc' | 'started_asc' | 'retention_asc' | 'retention_desc' | 'duration_desc';
export type AdminRecordingPlayerMode = 'manifest' | 'video';

export interface AdminRecordingSummary {
  totalRecordings: number;
  processingRecordings: number;
  readyRecordings: number;
  failedRecordings: number;
  expiredRecordings: number;
  expiringSoonRecordings: number;
}

export interface AdminRecordingListItem {
  id: string;
  recordingId: string;
  sessionId?: string;
  batchId?: string;
  roomId: string;
  sessionTitle?: string;
  sessionNumber?: number;
  batchName?: string;
  courseId?: string;
  courseName?: string;
  teacherId?: string;
  status: AdminRecordingStatus;
  storageProvider: string;
  mimeType?: string;
  container?: string;
  size?: number;
  durationSeconds?: number;
  startedAt: string;
  stoppedAt?: string;
  retentionExpiresAt?: string;
  failureReason?: string;
  canPlayback: boolean;
  canDownload: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminRecordingDetail extends AdminRecordingListItem {
  scope: 'room' | 'participant' | 'screen';
  participantId?: string;
  startedBy?: string;
  stoppedBy?: string;
  consentRequired?: boolean;
  consentVersion?: string;
  trackCount: number;
}

export interface AdminRecordingListQuery {
  status?: AdminRecordingStatus | 'all';
  sessionId?: string;
  batchId?: string;
  courseId?: string;
  teacherId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: AdminRecordingSort;
  page?: number;
  limit?: number;
}

export interface AdminRecordingListResponse {
  items: AdminRecordingListItem[];
  summary: AdminRecordingSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminRecordingRetentionUpdateRequest {
  retentionExpiresAt: string;
}

export interface AdminRecordingPlaybackResponse {
  recordingId: string;
  status: AdminRecordingStatus;
  playerMode: AdminRecordingPlayerMode;
  playbackUrl?: string;
  mimeType?: string;
  container?: string;
  fileName?: string;
  message?: string;
}

export interface AdminAttendanceQuery {
  courseId?: string;
  batchId?: string;
  teacherId?: string;
  status?: AdminClassSessionStatus | 'all';
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

export interface AdminAttendanceSummary {
  totalSessions: number;
  completedSessions: number;
  totalEnrolledStudents: number;
  averageAttendanceRate: number;
  averageDurationSeconds: number;
  absentCount: number;
  lateJoinCount: number;
  earlyLeaveCount: number;
  reconnectCount: number;
}

export interface AdminAttendanceSessionRow {
  sessionId: string;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  teacherId: string;
  teacherName?: string;
  title: string;
  status: AdminClassSessionStatus;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  enrolled: number;
  present: number;
  absent: number;
  attendanceRate: number;
  averageDurationSeconds: number;
  reconnects: number;
  lateJoins: number;
  earlyLeaves: number;
}

export interface AdminAttendanceStudentRow {
  studentId: string;
  studentName: string;
  studentEmail?: string;
  batchId: string;
  batchName: string;
  courseId?: string;
  courseName?: string;
  sessionsEnrolled: number;
  sessionsAttended: number;
  absentCount: number;
  attendanceRate: number;
  averageDurationSeconds: number;
  reconnects: number;
  lastAttendedAt?: string;
}

export interface AdminAttendanceTrendPoint {
  date: string;
  sessions: number;
  attendanceRate: number;
  averageDurationSeconds: number;
  present: number;
  enrolled: number;
}

export interface AdminAttendanceSessionsResponse {
  items: AdminAttendanceSessionRow[];
  summary: AdminAttendanceSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminAttendanceStudentsResponse {
  items: AdminAttendanceStudentRow[];
  summary: AdminAttendanceSummary;
  page: number;
  limit: number;
  total: number;
}

export interface AdminAttendanceTrendsResponse {
  items: AdminAttendanceTrendPoint[];
  summary: AdminAttendanceSummary;
}
