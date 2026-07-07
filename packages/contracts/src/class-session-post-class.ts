import type { Assignment } from './assignments.js';
import type { ChatMessage, ChatThreadSummary } from './chat.js';
import type { ClassSessionReport } from './class-session-report.js';
import type { ClassSessionMaterial } from './materials.js';
import type { Recording } from './recordings.js';
import type { StudentCompletedClassWhiteboardSummary } from './student-class-history.js';

export interface ClassSessionPostClassThreadWorkflow {
  studentId: string;
  threadKey: string;
  important: boolean;
  answered: boolean;
  followUp: boolean;
  updatedAt?: string;
  updatedByUserId?: string;
}

export interface ClassSessionPostClassQuestionThread {
  summary: ChatThreadSummary;
  workflow: ClassSessionPostClassThreadWorkflow;
}

export interface ClassSessionPostClassWorkspace {
  generatedAt: string;
  session: ClassSessionReport['session'];
  report: ClassSessionReport;
  qna: {
    threads: ClassSessionPostClassQuestionThread[];
  };
  materials: ClassSessionMaterial[];
  recordings: Recording[];
  whiteboard: StudentCompletedClassWhiteboardSummary;
  assignments: Assignment[];
}

export interface UpdatePostClassQuestionStateRequest {
  batchId?: string;
  participantId: string;
  important?: boolean;
  answered?: boolean;
  followUp?: boolean;
}

export interface CreatePostClassAnnouncementRequest {
  batchId?: string;
  message: string;
  sourceParticipantId?: string;
}

export interface PostClassArtifactPublishRequest {
  batchId?: string;
}

export type PostClassAnnouncementResponse = ChatMessage;
