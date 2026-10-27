import type { WhiteboardMemoryPage } from './whiteboard-memory';

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export type WhiteboardPermissionLevel = 'view_only' | 'draw' | 'annotate' | 'current_page_edit';

export const WHITEBOARD_PERMISSION_LEVELS: readonly WhiteboardPermissionLevel[] = [
  'view_only',
  'draw',
  'annotate',
  'current_page_edit'
];

export interface WhiteboardElement {
  id: string;
  type: string;
}

export interface WhiteboardCursor {
  participantId: string;
  displayName: string;
  color: string;
  position: WhiteboardPoint;
}

export type WhiteboardCommand =
  | { type: 'page-upsert'; page: Omit<WhiteboardMemoryPage, 'elements'>; pageId?: string }
  | { type: 'page-delete'; pageId: string }
  | { type: 'page-select'; pageId: string }
  | {
      type: 'upsert';
      elementIndex?: number;
      element: WhiteboardElement;
      pageId?: string;
    }
  | {
      type: 'delete';
      elementId: string;
      pageId?: string;
    }
  | {
      type: 'clear';
      pageId?: string;
    };
