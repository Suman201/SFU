import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormField, FormRoot, form as signalForm } from '@angular/forms/signals';
import type { ChatMessage, ChatMessageScope, ChatThreadSummary, ChatThreadSummaryResponse, SendChatMessageRequest } from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { ClassSessionService } from '../class-session.service';

interface ChatPosition {
  x: number;
  y: number;
}

interface ChatDragState {
  pointerId: number;
  originX: number;
  originY: number;
  offsetX: number;
  offsetY: number;
}

interface ChatComposerFormModel {
  message: string;
}

type ChatDeliveryState = 'sending' | 'sent' | 'failed';

type UiChatMessage = ChatMessage & {
  deliveryState?: ChatDeliveryState;
  failedRequest?: SendChatMessageRequest;
  localOnly?: boolean;
};

export interface ChatThreadParticipant {
  id: string;
  name: string;
  initials?: string;
  role?: string;
}

@Component({
  selector: 'sfu-session-chat',
  standalone: true,
  imports: [FormField, FormRoot],
  templateUrl: './session-chat.html',
  styleUrl: './session-chat.scss',
  host: {
    '[class.docked-host]': 'docked()'
  },
  changeDetection: ChangeDetectionStrategy.Eager
})
export class SessionChat {
  private readonly auth = inject(AuthService);
  private readonly classSessions = inject(ClassSessionService);
  private readonly socket = inject(SocketService);
  private readonly store = inject(RoomStore);
  private readonly realtimeSocket = this.socket.connect();
  private readonly socketDisposers: Array<() => void> = [];
  private loadedContextKey = '';
  private loadedSummaryContextKey = '';
  private lastMarkedReadKeys = new Set<string>();

  readonly currentUser = input('Teacher');
  readonly currentRole = input<'Teacher' | 'Student'>('Teacher');
  readonly sessionId = input('');
  readonly batchId = input('');
  readonly roomId = input('');
  readonly live = input(false);
  readonly joined = input(false);
  readonly docked = input(false);
  readonly collapsed = input<boolean | null>(null);
  readonly threadParticipants = input<ChatThreadParticipant[]>([]);
  readonly collapsedChange = output<boolean>();

  protected readonly dragOffset = signal<ChatPosition>({ x: 0, y: 0 });
  protected readonly dragging = signal(false);
  protected readonly internalCollapsed = signal(false);
  protected readonly chatModel = signal<ChatComposerFormModel>({ message: '' });
  protected readonly chatForm = signalForm(this.chatModel);
  protected readonly messages = signal<UiChatMessage[]>([]);
  protected readonly chatSummary = signal<ChatThreadSummaryResponse | null>(null);
  protected readonly loadingHistory = signal(false);
  protected readonly sending = signal(false);
  protected readonly socketConnected = signal(this.realtimeSocket.connected);
  protected readonly chatError = signal('');
  protected readonly nextBefore = signal<string | null>(null);
  protected readonly chatMode = signal<ChatMessageScope>('private');
  protected readonly selectedThreadParticipantId = signal('');

  protected readonly dragTransform = computed(() => {
    if (this.docked()) {
      return 'none';
    }

    const offset = this.dragOffset();

    return `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  });

  protected readonly isCollapsed = computed(() => this.collapsed() ?? this.internalCollapsed());
  protected readonly isTeacherChat = computed(() => this.currentRole() === 'Teacher');
  protected readonly selectedThreadParticipant = computed(() => {
    const selectedId = this.selectedThreadParticipantId();
    return this.threadParticipants().find((participant) => participant.id === selectedId) ?? null;
  });
  protected readonly activeRecipientId = computed(() => (this.isTeacherChat() && this.chatMode() === 'private' ? this.selectedThreadParticipantId() : ''));
  protected readonly visibleMessages = computed(() => this.messages().filter((message) => this.messageBelongsToActiveView(message)));
  protected readonly threadSummaryMap = computed(() => new Map(this.chatSummary()?.threads.map((thread) => [thread.participantId ?? thread.id, thread]) ?? []));
  protected readonly broadcastSummary = computed(() => this.chatSummary()?.broadcast ?? null);
  protected readonly totalUnreadCount = computed(() => (this.chatSummary()?.threads ?? []).reduce((total, thread) => total + thread.unreadCount, 0));
  protected readonly unreadCount = computed(() => (this.isCollapsed() ? this.totalUnreadCount() : 0));
  protected readonly canSend = computed(() => {
    if (!this.live() || !this.joined() || !this.socketConnected() || this.sending() || !this.roomId()) {
      return false;
    }
    return !this.isTeacherChat() || this.chatMode() === 'broadcast' || Boolean(this.activeRecipientId());
  });
  protected readonly composerPlaceholder = computed(() => {
    if (!this.isTeacherChat()) return 'Message teacher';
    if (this.chatMode() === 'broadcast') return 'Broadcast announcement';
    const participant = this.selectedThreadParticipant();
    return participant ? `Message ${participant.name}` : 'Select a student';
  });
  protected readonly headerEyebrow = computed(() => {
    if (!this.isTeacherChat()) return 'Private teacher thread';
    return this.chatMode() === 'broadcast' ? 'Teacher announcement' : 'Private student thread';
  });
  protected readonly headerTitle = computed(() => {
    if (!this.isTeacherChat()) return 'Teacher chat';
    if (this.chatMode() === 'broadcast') return 'Broadcast';
    return this.selectedThreadParticipant()?.name ?? 'Select student';
  });
  protected readonly composerDisabledReason = computed(() => {
    if (!this.live()) return 'Chat opens when the session is live.';
    if (!this.joined()) return 'Join the classroom before sending chat.';
    if (!this.socketConnected()) return 'Reconnecting to chat.';
    if (this.sending()) return 'Sending message.';
    if (this.isTeacherChat() && this.chatMode() === 'private' && !this.activeRecipientId()) return 'Select a student thread.';
    return '';
  });

  private dragState: ChatDragState | null = null;
  private suppressNextToggle = false;

  constructor() {
    effect(() => {
      this.syncTeacherThreadSelection();
    });
    effect(() => {
      this.sessionId();
      this.batchId();
      this.roomId();
      this.joined();
      this.chatMode();
      this.activeRecipientId();
      this.loadHistoryForCurrentContext();
      this.loadChatSummary();
    });
    effect(() => {
      this.isCollapsed();
      this.visibleMessages();
      this.markActiveViewRead();
    });
  }

  ngOnInit(): void {
    this.bindSocketEvents();
  }

  ngOnDestroy(): void {
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
  }

  protected toggleCollapsed(event?: Event): void {
    if (this.suppressNextToggle) {
      event?.preventDefault();
      event?.stopPropagation();
      this.suppressNextToggle = false;
      return;
    }

    const nextCollapsed = !this.isCollapsed();
    this.internalCollapsed.set(nextCollapsed);
    this.collapsedChange.emit(nextCollapsed);
    if (!nextCollapsed) {
      queueMicrotask(() => this.markActiveViewRead(true));
    }
  }

  protected startDrag(event: PointerEvent, chatElement: HTMLElement): void {
    if (this.docked() || event.button !== 0) {
      return;
    }

    const offset = this.dragOffset();
    this.dragState = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y
    };
    this.dragging.set(true);
    chatElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  protected drag(event: PointerEvent, chatElement: HTMLElement): void {
    const dragState = this.dragState;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.originX;
    const deltaY = event.clientY - dragState.originY;
    const movedFarEnough = Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4;

    if (movedFarEnough) {
      this.suppressNextToggle = true;
    }

    this.dragOffset.set(
      this.clampOffset(chatElement, {
        x: dragState.offsetX + deltaX,
        y: dragState.offsetY + deltaY
      })
    );
  }

  protected endDrag(event: PointerEvent, chatElement: HTMLElement): void {
    const dragState = this.dragState;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (chatElement.hasPointerCapture(event.pointerId)) {
      chatElement.releasePointerCapture(event.pointerId);
    }

    this.dragState = null;
    this.dragging.set(false);
  }

  protected selectPrivateThread(participantId: string): void {
    this.chatMode.set('private');
    this.selectedThreadParticipantId.set(participantId);
    this.loadHistoryForCurrentContext(true);
    queueMicrotask(() => this.markActiveViewRead(true));
  }

  protected selectBroadcast(): void {
    this.chatMode.set('broadcast');
    this.loadHistoryForCurrentContext(true);
    queueMicrotask(() => this.markActiveViewRead(true));
  }

  protected sendMessage(event?: Event): void {
    event?.preventDefault();
    this.chatForm().markAsTouched();

    const body = this.chatModel().message.trim();

    if (!body || !this.canSend()) {
      return;
    }

    const request: SendChatMessageRequest = {
      roomId: this.roomId(),
      message: body,
      scope: this.isTeacherChat() ? this.chatMode() : 'private'
    };
    if (this.isTeacherChat() && this.chatMode() === 'private') {
      request.recipientId = this.activeRecipientId();
    }
    this.sendChatRequest(request);
  }

  protected retryMessage(message: UiChatMessage): void {
    if (!message.failedRequest || !this.canSend()) {
      return;
    }
    this.messages.update((messages) => messages.filter((item) => item.id !== message.id));
    this.sendChatRequest(message.failedRequest);
  }

  protected deliveryLabel(message: UiChatMessage): string {
    if (!this.isMine(message)) return '';
    if (message.deliveryState === 'sending') return 'Sending';
    if (message.deliveryState === 'failed') return 'Failed';
    return 'Sent';
  }

  protected threadUnread(participant: ChatThreadParticipant): number {
    return this.threadSummaryMap().get(participant.id)?.unreadCount ?? 0;
  }

  protected threadPreview(participant: ChatThreadParticipant): string {
    return this.threadSummaryMap().get(participant.id)?.lastMessagePreview ?? 'No messages yet';
  }

  protected threadOnline(participant: ChatThreadParticipant): boolean {
    return this.threadSummaryMap().get(participant.id)?.online ?? true;
  }

  protected broadcastUnread(): number {
    return this.broadcastSummary()?.unreadCount ?? 0;
  }

  protected broadcastPreview(): string {
    return this.broadcastSummary()?.lastMessagePreview ?? 'No announcements yet';
  }

  private sendChatRequest(request: SendChatMessageRequest): void {
    const body = request.message.trim();
    const tempId = this.localMessageId();
    const optimisticMessage = this.optimisticMessage(tempId, request, body);
    this.upsertMessages([optimisticMessage]);
    this.chatModel.set({ message: '' });
    this.chatForm().reset();
    this.sending.set(true);
    this.chatError.set('');
    this.socket
      .emitAck('chat:send', request)
      .then((message) => {
        this.reconcileLocalEcho(message, tempId);
        this.messages.update((messages) => messages.filter((item) => item.id !== tempId));
        this.upsertMessages([{ ...message, deliveryState: 'sent' }]);
        this.loadChatSummary(true);
      })
      .catch((error: unknown) => {
        this.messages.update((messages) =>
          messages.map((message) =>
            message.id === tempId
              ? {
                  ...message,
                  deliveryState: 'failed',
                  failedRequest: request
                }
              : message
          )
        );
        this.chatError.set(error instanceof Error ? error.message : 'Unable to send chat message.');
      })
      .finally(() => {
        this.sending.set(false);
      });
  }

  protected senderName(message: ChatMessage): string {
    return message.senderName || this.currentUser();
  }

  protected senderRole(message: ChatMessage): string {
    const role = message.senderRole?.toLowerCase();
    if (role === 'teacher' || role === 'host' || role === 'co_host') return 'Teacher';
    if (role === 'admin') return 'Admin';
    return 'Student';
  }

  protected messageTime(message: ChatMessage): string {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(message.createdAt));
  }

  protected isMine(message: ChatMessage): boolean {
    const localParticipantId = this.store.localParticipantId();
    const userId = this.auth.user()?.id;
    return Boolean(message.senderId && (message.senderId === localParticipantId || message.senderId === userId));
  }

  protected isAnnouncement(message: ChatMessage): boolean {
    return message.scope === 'broadcast';
  }

  private bindSocketEvents(): void {
    const handleMessage = (message: ChatMessage) => {
      if (message.roomId !== this.roomId()) {
        return;
      }
      if (!this.messageIsRelevantToCurrentUser(message)) {
        return;
      }
      this.reconcileLocalEcho(message);
      this.upsertMessages([{ ...message, deliveryState: this.isMine(message) ? 'sent' : undefined }]);
      this.loadChatSummary(true);
      queueMicrotask(() => this.markActiveViewRead());
    };
    const handleConnect = () => {
      this.socketConnected.set(true);
      this.loadChatSummary(true);
      this.loadHistoryForCurrentContext(true);
    };
    const handleDisconnect = () => {
      this.socketConnected.set(false);
    };

    this.socket.on('chat:message', handleMessage);
    this.realtimeSocket.on('connect', handleConnect);
    this.realtimeSocket.on('disconnect', handleDisconnect);
    this.socketDisposers.push(() => {
      this.socket.off('chat:message', handleMessage);
      this.realtimeSocket.off('connect', handleConnect);
      this.realtimeSocket.off('disconnect', handleDisconnect);
    });
  }

  private loadHistoryForCurrentContext(force = false): void {
    const sessionId = this.sessionId();
    const batchId = this.batchId();
    const roomId = this.roomId();
    if (!sessionId || !roomId || !this.joined()) {
      return;
    }
    const scope = this.isTeacherChat() ? this.chatMode() : undefined;
    const participantId = this.isTeacherChat() && scope === 'private' ? this.activeRecipientId() : undefined;
    if (this.isTeacherChat() && scope === 'private' && !participantId) {
      return;
    }
    const contextKey = `${sessionId}:${batchId}:${roomId}:${this.currentRole()}:${scope ?? 'student'}:${participantId ?? ''}`;
    if (!force && this.loadedContextKey === contextKey) {
      return;
    }
    this.loadedContextKey = contextKey;
    this.loadingHistory.set(true);
    this.chatError.set('');
    this.classSessions.getChatHistory(sessionId, { batchId, participantId, scope, limit: 80 }).subscribe({
      next: (history) => {
        this.upsertMessages(history.messages.map((message) => ({ ...message, deliveryState: this.isMine(message) ? 'sent' : undefined })));
        this.nextBefore.set(history.nextBefore ?? null);
        this.loadingHistory.set(false);
        this.markActiveViewRead();
      },
      error: (error) => {
        this.chatError.set(this.classSessions.errorMessage(error));
        this.loadingHistory.set(false);
      }
    });
  }

  private loadChatSummary(force = false): void {
    const sessionId = this.sessionId();
    const batchId = this.batchId();
    const roomId = this.roomId();
    if (!sessionId || !roomId || !this.joined()) {
      return;
    }
    const contextKey = `${sessionId}:${batchId}:${roomId}`;
    if (!force && this.loadedSummaryContextKey === contextKey) {
      return;
    }
    this.loadedSummaryContextKey = contextKey;
    this.classSessions.getChatSummary(sessionId, { batchId }).subscribe({
      next: (summary) => {
        this.chatSummary.set(summary);
        const summaryMessages = summary.threads.flatMap((thread) => (thread.lastMessage ? [thread.lastMessage] : []));
        this.upsertMessages(summaryMessages.map((message) => ({ ...message, deliveryState: this.isMine(message) ? 'sent' : undefined })));
      },
      error: () => undefined
    });
  }

  private markActiveViewRead(force = false): void {
    const sessionId = this.sessionId();
    const batchId = this.batchId();
    const roomId = this.roomId();
    if (!sessionId || !roomId || !this.joined() || this.isCollapsed() || !this.visibleMessages().length) {
      return;
    }

    if (!this.isTeacherChat()) {
      this.markRead('private', undefined, force);
      this.markRead('broadcast', undefined, force);
      return;
    }

    if (this.chatMode() === 'broadcast') {
      this.markRead('broadcast', undefined, force);
      return;
    }

    const participantId = this.activeRecipientId();
    if (participantId) {
      this.markRead('private', participantId, force);
    }
  }

  private markRead(scope: ChatMessageScope, participantId: string | undefined, force = false): void {
    const sessionId = this.sessionId();
    const batchId = this.batchId();
    const roomId = this.roomId();
    const latestReadAt = this.latestReadAtFor(scope, participantId);
    if (!sessionId || !roomId || !latestReadAt) {
      return;
    }
    const key = `${sessionId}:${roomId}:${scope}:${participantId ?? 'self'}:${latestReadAt}`;
    if (!force && this.lastMarkedReadKeys.has(key)) {
      return;
    }
    this.classSessions.markChatRead(sessionId, { batchId, roomId, participantId, scope, readAt: latestReadAt }).subscribe({
      next: () => {
        this.lastMarkedReadKeys.add(key);
        this.loadChatSummary(true);
      },
      error: () => {
        this.lastMarkedReadKeys.delete(key);
      }
    });
  }

  private latestReadAtFor(scope: ChatMessageScope, participantId: string | undefined): string {
    const messages = this.messages()
      .filter((message) => message.scope === scope && !message.localOnly)
      .filter((message) => {
        if (scope === 'broadcast') return true;
        if (!this.isTeacherChat()) return true;
        return Boolean(participantId && (message.senderId === participantId || message.recipientId === participantId));
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return messages[0]?.createdAt ?? '';
  }

  private upsertMessages(nextMessages: readonly UiChatMessage[]): void {
    if (!nextMessages.length) {
      return;
    }
    this.messages.update((currentMessages) => {
      const byId = new Map(currentMessages.map((message) => [message.id, message]));
      for (const message of nextMessages) {
        if (!message.localOnly && this.isMine(message)) {
          const matchingLocal = this.findMatchingLocalMessage([...byId.values()], message);
          if (matchingLocal) {
            byId.delete(matchingLocal.id);
          }
        }
        const current = byId.get(message.id);
        byId.set(message.id, {
          ...current,
          ...message,
          deliveryState: message.deliveryState ?? current?.deliveryState,
          failedRequest: message.failedRequest ?? current?.failedRequest
        });
      }
      return [...byId.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    });
  }

  private optimisticMessage(id: string, request: SendChatMessageRequest, body: string): UiChatMessage {
    const now = new Date().toISOString();
    return {
      id,
      sessionId: this.sessionId(),
      batchId: this.batchId(),
      roomId: request.roomId,
      senderId: this.store.localParticipantId() ?? this.auth.user()?.id ?? 'local',
      senderName: this.currentUser(),
      senderRole: this.isTeacherChat() ? 'teacher' : 'student',
      ...(request.recipientId ? { recipientId: request.recipientId } : {}),
      scope: request.scope ?? 'private',
      message: body,
      shadowMuted: false,
      createdAt: now,
      deliveryState: 'sending',
      localOnly: true
    };
  }

  private localMessageId(): string {
    const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `local-${randomId}`;
  }

  private reconcileLocalEcho(message: ChatMessage, preferredTempId?: string): void {
    if (!this.isMine(message)) {
      return;
    }
    this.messages.update((messages) => {
      const matchingLocal = this.findMatchingLocalMessage(messages, message, preferredTempId);
      return matchingLocal ? messages.filter((item) => item.id !== matchingLocal.id) : messages;
    });
  }

  private findMatchingLocalMessage(messages: readonly UiChatMessage[], message: ChatMessage, preferredTempId?: string): UiChatMessage | undefined {
    return messages.find((item) => {
      if (!item.localOnly) return false;
      if (preferredTempId && item.id === preferredTempId) return true;
      if (item.deliveryState === 'failed') {
        return (
          item.message === message.message &&
          item.scope === message.scope &&
          this.recipientsMatchLoosely(item, message) &&
          Math.abs(Date.parse(message.createdAt) - Date.parse(item.createdAt)) < 120_000
        );
      }
      return (
        item.message === message.message &&
        item.scope === message.scope &&
        this.recipientsMatchLoosely(item, message) &&
        Math.abs(Date.parse(message.createdAt) - Date.parse(item.createdAt)) < 30_000
      );
    });
  }

  private recipientsMatchLoosely(local: UiChatMessage, persisted: ChatMessage): boolean {
    if (!local.recipientId || !persisted.recipientId) {
      return true;
    }
    return local.recipientId === persisted.recipientId;
  }

  private syncTeacherThreadSelection(): void {
    if (!this.isTeacherChat()) {
      this.selectedThreadParticipantId.set('');
      this.chatMode.set('private');
      return;
    }

    const participants = this.threadParticipants();
    const selectedId = this.selectedThreadParticipantId();
    if (participants.some((participant) => participant.id === selectedId)) {
      return;
    }
    this.selectedThreadParticipantId.set(participants[0]?.id ?? '');
  }

  private messageBelongsToActiveView(message: ChatMessage): boolean {
    if (message.scope === 'broadcast') {
      return !this.isTeacherChat() || this.chatMode() === 'broadcast';
    }

    if (!this.isTeacherChat()) {
      const localParticipantId = this.store.localParticipantId();
      return Boolean(localParticipantId && (message.senderId === localParticipantId || message.recipientId === localParticipantId));
    }

    if (this.chatMode() !== 'private') {
      return false;
    }
    const participantId = this.activeRecipientId();
    return Boolean(participantId && (message.senderId === participantId || message.recipientId === participantId));
  }

  private messageIsRelevantToCurrentUser(message: ChatMessage): boolean {
    if (message.scope === 'broadcast') {
      return true;
    }

    const localParticipantId = this.store.localParticipantId();
    if (localParticipantId && (message.senderId === localParticipantId || message.recipientId === localParticipantId)) {
      return true;
    }

    if (!this.isTeacherChat()) {
      return false;
    }

    return this.threadParticipants().some((participant) => message.senderId === participant.id || message.recipientId === participant.id);
  }

  private clampOffset(chatElement: HTMLElement, nextOffset: ChatPosition): ChatPosition {
    const margin = 12;
    const currentOffset = this.dragOffset();
    const rect = chatElement.getBoundingClientRect();
    const deltaX = nextOffset.x - currentOffset.x;
    const deltaY = nextOffset.y - currentOffset.y;
    let x = nextOffset.x;
    let y = nextOffset.y;

    const nextLeft = rect.left + deltaX;
    const nextRight = rect.right + deltaX;
    const nextTop = rect.top + deltaY;
    const nextBottom = rect.bottom + deltaY;
    const maxRight = window.innerWidth - margin;
    const maxBottom = window.innerHeight - margin;

    if (nextLeft < margin) {
      x += margin - nextLeft;
    }

    if (nextRight > maxRight) {
      x -= nextRight - maxRight;
    }

    if (nextTop < margin) {
      y += margin - nextTop;
    }

    if (nextBottom > maxBottom) {
      y -= nextBottom - maxBottom;
    }

    return {
      x: Math.round(x),
      y: Math.round(y)
    };
  }
}
