export type ClassSessionTimelineCategory =
  | 'lifecycle'
  | 'attendance'
  | 'moderation'
  | 'media'
  | 'chat'
  | 'whiteboard'
  | 'materials'
  | 'recording'
  | 'support';

export type ClassSessionTimelineVisibility = 'full' | 'student_safe';
export type ClassSessionTimelineEventVisibility = 'full' | 'student_safe' | 'actor_only';

export interface ClassSessionTimelineActor {
  id?: string;
  name?: string;
  email?: string;
  roles: string[];
}

export interface ClassSessionTimelineTarget {
  id?: string;
  userId?: string;
  name?: string;
  role?: string;
  type?: string;
}

export interface ClassSessionTimelineSource {
  collection: string;
  id: string;
}

export interface ClassSessionTimelineEvent {
  id: string;
  sessionId: string;
  batchId?: string;
  roomId?: string;
  eventType: string;
  category: ClassSessionTimelineCategory;
  summary: string;
  actor?: ClassSessionTimelineActor;
  target?: ClassSessionTimelineTarget;
  source?: ClassSessionTimelineSource;
  visibility: ClassSessionTimelineEventVisibility;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ClassSessionTimelineResponse {
  sessionId: string;
  batchId?: string;
  visibility: ClassSessionTimelineVisibility;
  items: ClassSessionTimelineEvent[];
  limit: number;
  hasMore: boolean;
  nextBefore?: string;
}

export interface ClassSessionTimelineQuery {
  batchId?: string;
  before?: string;
  limit?: number;
  category?: ClassSessionTimelineCategory | 'all';
}
