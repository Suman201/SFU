export type ChatMessageScope = 'private' | 'broadcast';
export type ChatDeliveryState = 'sent' | 'delivered' | 'read';
export type ChatAttachmentType = 'image' | 'pdf' | 'link';

export interface ChatAttachment {
  id: string;
  attachmentId?: string;
  type: ChatAttachmentType;
  fileName?: string;
  title?: string;
  mimeType?: string;
  size?: number;
  storageProvider?: 'local' | 's3';
  downloadUrl?: string;
  url?: string;
  dataUrl?: string;
  createdAt?: string;
}

export interface SendChatAttachment {
  id?: string;
  attachmentId?: string;
  type: ChatAttachmentType;
  fileName?: string;
  title?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  dataUrl?: string;
}

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
  attachments?: ChatAttachment[];
  shadowMuted: boolean;
  deliveryState?: ChatDeliveryState;
  deliveredAt?: string;
  readAt?: string;
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

export interface ChatReadReceiptEvent {
  sessionId: string;
  batchId?: string;
  roomId: string;
  channelId?: string;
  chatChannelId?: string;
  scope: ChatMessageScope;
  threadKey?: string;
  participantId?: string;
  userId: string;
  lastReadAt: string;
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
  attachments?: SendChatAttachment[];
}

export type SendChatMessageResponse = ChatMessage;

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
