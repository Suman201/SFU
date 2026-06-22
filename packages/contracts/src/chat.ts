export type ChatMessageScope = 'private' | 'broadcast';

export interface ChatMessage {
  id: string;
  sessionId?: string;
  batchId?: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  roomId: string;
  channelId?: string;
  chatChannelId?: string;
  recipientId?: string;
  scope: ChatMessageScope;
  threadKey?: string;
  message: string;
  shadowMuted: boolean;
  createdAt: string;
  deletedAt?: string;
}

export interface ChatReadState {
  id: string;
  sessionId: string;
  batchId?: string;
  roomId: string;
  channelId?: string;
  chatChannelId?: string;
  userId: string;
  participantId?: string;
  scope: ChatMessageScope;
  threadKey?: string;
  lastReadAt: string;
  updatedAt: string;
}

export interface MarkChatReadRequest {
  sessionId: string;
  roomId: string;
  participantId?: string;
  scope?: ChatMessageScope;
  readAt?: string;
}

export interface ChatThreadSummary {
  id: string;
  scope: ChatMessageScope;
  participantId?: string;
  participantName?: string;
  participantRole?: string;
  online?: boolean;
  threadKey?: string;
  lastReadAt?: string;
  lastMessage?: ChatMessage;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount: number;
}

export interface ChatThreadSummaryResponse {
  sessionId: string;
  roomId: string;
  threads: ChatThreadSummary[];
  broadcast?: ChatThreadSummary;
  studentThread?: ChatThreadSummary;
}

export interface SendChatMessageRequest {
  roomId: string;
  message: string;
  recipientId?: string;
  scope?: ChatMessageScope;
}

export interface ChatHistoryRequest {
  sessionId?: string;
  roomId?: string;
  channelId?: string;
  participantId?: string;
  scope?: ChatMessageScope;
  before?: string;
  limit?: number;
}

export interface ChatHistoryResponse {
  messages: ChatMessage[];
  nextBefore?: string;
}
