export type AssignmentSubmissionType = 'text' | 'file' | 'link';
export type AssignmentStatus = 'published' | 'archived';
export type AssignmentSubmissionStatus = 'assigned' | 'viewed' | 'submitted' | 'late' | 'reviewed' | 'returned' | 'completed';
export type AssignmentAttachmentType = 'file' | 'link' | 'material';

export interface AssignmentAttachment {
  id: string;
  type: AssignmentAttachmentType;
  title: string;
  url?: string;
  materialId?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  storageProvider?: 'local' | 's3';
  downloadUrl?: string;
  createdAt?: string;
}

export interface AssignmentLinkAttachmentRequest {
  title: string;
  url: string;
}

export interface AssignmentMaterialLinkRequest {
  materialId: string;
  title?: string;
}

export interface AssignmentSubmissionLinkRequest {
  title: string;
  url: string;
}

export interface AssignmentSubmissionSummary {
  assigned: number;
  viewed: number;
  submitted: number;
  late: number;
  reviewed: number;
  returned: number;
  completed: number;
}

export interface Assignment {
  id: string;
  assignmentId: string;
  batchId: string;
  batchName?: string;
  sessionId?: string;
  sessionTitle?: string;
  teacherId: string;
  title: string;
  instructions: string;
  dueAt?: string;
  attachments: AssignmentAttachment[];
  allowedSubmissionTypes: AssignmentSubmissionType[];
  status: AssignmentStatus;
  submissionSummary?: AssignmentSubmissionSummary;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AssignmentSubmission {
  id: string;
  submissionId: string;
  assignmentId: string;
  batchId: string;
  sessionId?: string;
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  text?: string;
  links: AssignmentAttachment[];
  files: AssignmentAttachment[];
  status: AssignmentSubmissionStatus;
  viewedAt?: string;
  submittedAt?: string;
  reviewedAt?: string;
  returnedAt?: string;
  completedAt?: string;
  feedback?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateAssignmentRequest {
  batchId: string;
  sessionId?: string;
  title: string;
  instructions: string;
  dueAt?: string;
  allowedSubmissionTypes: AssignmentSubmissionType[];
  links?: AssignmentLinkAttachmentRequest[];
  materialLinks?: AssignmentMaterialLinkRequest[];
}

export interface UpdateAssignmentRequest {
  title?: string;
  instructions?: string;
  dueAt?: string | null;
  allowedSubmissionTypes?: AssignmentSubmissionType[];
  links?: AssignmentLinkAttachmentRequest[];
  materialLinks?: AssignmentMaterialLinkRequest[];
  status?: AssignmentStatus;
}

export interface TeacherAssignmentListResponse {
  items: Assignment[];
}

export interface StudentAssignmentListResponse {
  items: Array<Assignment & { submission?: AssignmentSubmission }>;
}

export interface AssignmentDetailResponse {
  assignment: Assignment;
  submission?: AssignmentSubmission;
}

export interface AssignmentSubmissionListResponse {
  assignment: Assignment;
  submissions: AssignmentSubmission[];
}

export interface SubmitAssignmentRequest {
  text?: string;
  links?: AssignmentSubmissionLinkRequest[];
}

export interface ReviewAssignmentSubmissionRequest {
  status: Extract<AssignmentSubmissionStatus, 'reviewed' | 'returned' | 'completed'>;
  feedback?: string;
}
