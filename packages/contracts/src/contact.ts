export const CONTACT_SUBMISSION_CATEGORIES = [
  'general',
  'sales',
  'support',
  'partnership',
  'teacher_interest',
  'student_interest',
  'technical_issue'
] as const;
export type ContactSubmissionCategory = (typeof CONTACT_SUBMISSION_CATEGORIES)[number];

export const CONTACT_SUBMISSION_STATUSES = ['new', 'open', 'replied', 'waiting_for_user', 'resolved', 'archived', 'spam'] as const;
export type ContactSubmissionStatus = (typeof CONTACT_SUBMISSION_STATUSES)[number];

export const CONTACT_SUBMISSION_PRIORITIES = ['low', 'normal', 'high'] as const;
export type ContactSubmissionPriority = (typeof CONTACT_SUBMISSION_PRIORITIES)[number];

export const CONTACT_REPLY_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type ContactReplyDeliveryStatus = (typeof CONTACT_REPLY_DELIVERY_STATUSES)[number];

export interface ContactSubmissionReply {
  replyId: string;
  adminUserId: string;
  adminName?: string;
  message: string;
  sentAt: string;
  deliveryStatus: ContactReplyDeliveryStatus;
  deliveryError?: string;
}

export interface ContactSubmission {
  id: string;
  submissionId: string;
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  category: ContactSubmissionCategory;
  status: ContactSubmissionStatus;
  priority: ContactSubmissionPriority;
  assignedToUserId?: string;
  assignedToName?: string;
  sourcePageSlug?: string;
  userId?: string;
  userAgent?: string;
  ipHash?: string;
  replies: ContactSubmissionReply[];
  internalNotes?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateContactSubmissionRequest {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  category?: ContactSubmissionCategory;
  sourcePageSlug?: string;
}

export interface ContactSubmissionAck {
  submissionId: string;
  status: ContactSubmissionStatus;
  createdAt: string;
}

export interface ContactSubmissionListQuery {
  page?: number;
  limit?: number;
  status?: ContactSubmissionStatus | 'all';
  category?: ContactSubmissionCategory | 'all';
  priority?: ContactSubmissionPriority | 'all';
  assignedToUserId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ContactSubmissionListResponse {
  items: ContactSubmission[];
  page: number;
  limit: number;
  total: number;
  summary: {
    new: number;
    open: number;
    replied: number;
    waitingForUser: number;
    resolved: number;
    archived: number;
    spam: number;
  };
}

export interface UpdateContactSubmissionRequest {
  status?: ContactSubmissionStatus;
  priority?: ContactSubmissionPriority;
  assignedToUserId?: string;
  assignedToName?: string;
  internalNotes?: string;
}

export interface ReplyToContactSubmissionRequest {
  message: string;
}
