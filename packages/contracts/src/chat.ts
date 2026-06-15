export interface ChatMessage {
  id: string;
  senderId: string;
  roomId: string;
  recipientId?: string;
  message: string;
  shadowMuted: boolean;
  createdAt: string;
}

export interface SendChatMessageRequest {
  roomId: string;
  message: string;
  recipientId?: string;
}
