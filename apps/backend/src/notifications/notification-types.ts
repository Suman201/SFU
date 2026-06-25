export type NotificationPurpose =
  | 'class_reminder'
  | 'chat_message'
  | 'announcement'
  | 'recording_ready'
  | 'enrollment_update'
  | 'security_notice';

export type NotificationChannel = 'email' | 'push';

export interface NotificationDeliveryResult {
  channel: NotificationChannel;
  attempted: number;
  delivered: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface NotificationDeliverySummary {
  userId?: string;
  purpose: NotificationPurpose;
  results: NotificationDeliveryResult[];
}

export interface EmailMessageInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

export interface PushMessageInput {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}
