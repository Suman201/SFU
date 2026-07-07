export type ClassLibraryArtifactType =
  | 'session'
  | 'recording'
  | 'material'
  | 'whiteboard'
  | 'assignment'
  | 'announcement'
  | 'qna';

export interface ClassLibrarySearchQuery {
  q?: string;
  courseId?: string;
  batchId?: string;
  teacherId?: string;
  dateFrom?: string;
  dateTo?: string;
  artifactType?: ClassLibraryArtifactType | 'all';
  status?: string;
  page?: number;
  limit?: number;
}

export interface ClassLibrarySearchResult {
  id: string;
  artifactType: ClassLibraryArtifactType;
  title: string;
  description?: string;
  excerpt?: string;
  sessionId?: string;
  batchId?: string;
  batchName?: string;
  courseId?: string;
  courseName?: string;
  teacherId?: string;
  status?: string;
  detailUrl?: string;
  targetUrl?: string;
  createdAt: string;
  updatedAt?: string;
  scheduledAt?: string;
  completedAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ClassLibrarySearchResponse {
  items: ClassLibrarySearchResult[];
  page: number;
  limit: number;
  total: number;
  query: ClassLibrarySearchQuery;
}
