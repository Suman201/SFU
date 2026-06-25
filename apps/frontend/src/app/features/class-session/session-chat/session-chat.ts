import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormField, FormRoot, form as signalForm } from '@angular/forms/signals';
import type {
  ChatAttachment,
  ChatDeliveryState as PersistedChatDeliveryState,
  ChatMessage,
  ChatMessageScope,
  ChatReadReceiptEvent,
  ChatReadState,
  ChatThreadSummary,
  ChatThreadSummaryResponse,
  SendChatAttachment,
  SendChatMessageRequest
} from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { ClassSessionService } from '../class-session.service';
import { firstValueFrom } from 'rxjs';

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

const CHAT_ATTACHMENT_MAX_COUNT = 3;
const CHAT_ATTACHMENT_MAX_SIZE_BYTES = 2 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CHAT_ATTACHMENT_FILE_MIME_TYPES = new Set([...CHAT_ATTACHMENT_IMAGE_MIME_TYPES, 'application/pdf']);
const CHAT_ENDED_MESSAGE = 'Class ended. Chat is now read-only.';

type PendingChatAttachment = ChatAttachment & { id: string };
type ChatDeliveryState = PersistedChatDeliveryState | 'sending' | 'failed';

type ChatMessageCore = Omit<ChatMessage, 'deliveryState'>;

type UiChatMessage = ChatMessageCore & {
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
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly realtimeSocket = this.socket.connect();
  private readonly socketDisposers: Array<() => void> = [];
  private readonly viewportDisposers: Array<() => void> = [];
  private loadedContextKey = '';
  private loadedSummaryContextKey = '';
  private lastMarkedReadKeys = new Set<string>();
  private viewportFrame = 0;
  private linkDialogReturnFocus: HTMLElement | null = null;

  @ViewChild('linkUrlInput') private readonly linkUrlInput?: ElementRef<HTMLInputElement>;

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
  readonly privateChatEnabled = input(true);
  readonly broadcastChatEnabled = input(true);
  readonly chatAttachmentsEnabled = input(true);
  readonly maxMessageLength = input(2000);
  readonly collapsedChange = output<boolean>();

  protected readonly dragOffset = signal<ChatPosition>({ x: 0, y: 0 });
  protected readonly dragging = signal(false);
  protected readonly internalCollapsed = signal(false);
  protected readonly chatModel = signal<ChatComposerFormModel>({ message: '' });
  protected readonly chatForm = signalForm(this.chatModel);
  protected readonly messages = signal<UiChatMessage[]>([]);
  protected readonly pendingAttachments = signal<PendingChatAttachment[]>([]);
  protected readonly chatSummary = signal<ChatThreadSummaryResponse | null>(null);
  protected readonly loadingHistory = signal(false);
  protected readonly sending = signal(false);
  protected readonly uploadingAttachments = signal(0);
  protected readonly socketConnected = signal(this.realtimeSocket.connected);
  protected readonly chatError = signal('');
  protected readonly linkDialogOpen = signal(false);
  protected readonly linkDraft = signal('');
  protected readonly linkDialogError = signal('');
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
  protected readonly privateThreadKeys = computed(
    () =>
      new Set(
        (this.chatSummary()?.threads ?? [])
          .filter((thread) => thread.scope === 'private' && thread.threadKey)
          .map((thread) => thread.threadKey as string)
      )
  );
  protected readonly broadcastSummary = computed(() => this.chatSummary()?.broadcast ?? null);
  protected readonly totalUnreadCount = computed(() => (this.chatSummary()?.threads ?? []).reduce((total, thread) => total + thread.unreadCount, 0));
  protected readonly unreadCount = computed(() => (this.isCollapsed() ? this.totalUnreadCount() : 0));
  protected readonly composerHasContent = computed(() => Boolean(this.chatModel().message.trim() || this.pendingAttachments().length));
  protected readonly activeChatScope = computed<ChatMessageScope>(() => (this.isTeacherChat() ? this.chatMode() : 'private'));
  protected readonly canSend = computed(() => {
    if (!this.live() || !this.joined() || !this.socketConnected() || this.sending() || this.uploadingAttachments() > 0 || !this.roomId()) {
      return false;
    }
    const scope = this.activeChatScope();
    if (scope === 'private' && !this.privateChatEnabled()) {
      return false;
    }
    if (scope === 'broadcast' && !this.broadcastChatEnabled()) {
      return false;
    }
    if (this.pendingAttachments().length && !this.chatAttachmentsEnabled()) {
      return false;
    }
    if (this.chatModel().message.trim().length > this.maxMessageLength()) {
      return false;
    }
    return !this.isTeacherChat() || this.chatMode() === 'broadcast' || Boolean(this.activeRecipientId());
  });
  protected readonly canAttachToComposer = computed(() => this.canSend() && this.chatAttachmentsEnabled());
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
    if (this.uploadingAttachments() > 0) return 'Uploading attachment.';
    if (this.sending()) return 'Sending message.';
    if (this.activeChatScope() === 'private' && !this.privateChatEnabled()) return 'Private teacher-student chat is disabled for this class.';
    if (this.activeChatScope() === 'broadcast' && !this.broadcastChatEnabled()) return 'Teacher broadcast chat is disabled for this class.';
    if (this.pendingAttachments().length && !this.chatAttachmentsEnabled()) return 'Chat attachments are disabled for this class.';
    if (this.chatModel().message.trim().length > this.maxMessageLength()) return `Message limit is ${this.maxMessageLength()} characters.`;
    if (this.isTeacherChat() && this.chatMode() === 'private' && !this.activeRecipientId()) return 'Select a student thread.';
    return '';
  });

  private dragState: ChatDragState | null = null;
  private suppressNextToggle = false;
  private readonly attachmentBlobUrls: string[] = [];

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
    effect(() => {
      if (!this.live()) {
        this.handleTerminalChatState();
      }
    });
  }

  ngOnInit(): void {
    this.bindSocketEvents();
    this.bindViewportEvents();
  }

  ngOnDestroy(): void {
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
    for (const url of this.attachmentBlobUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
    for (const dispose of this.viewportDisposers.splice(0)) {
      dispose();
    }
    if (this.viewportFrame) {
      window.cancelAnimationFrame(this.viewportFrame);
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected closeLinkDialogOnEscape(event: Event): void {
    if (!this.linkDialogOpen()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancelLinkAttachment();
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
    if (this.docked() || event.button !== 0 || this.isMobileTouchSheet(event)) {
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
    if (!this.privateChatEnabled()) {
      this.chatError.set('Private teacher-student chat is disabled for this class.');
      return;
    }
    this.chatMode.set('private');
    this.selectedThreadParticipantId.set(participantId);
    this.loadHistoryForCurrentContext(true);
    queueMicrotask(() => this.markActiveViewRead(true));
  }

  protected selectBroadcast(): void {
    if (!this.broadcastChatEnabled()) {
      this.chatError.set('Teacher broadcast chat is disabled for this class.');
      return;
    }
    this.chatMode.set('broadcast');
    this.loadHistoryForCurrentContext(true);
    queueMicrotask(() => this.markActiveViewRead(true));
  }

  protected sendMessage(event?: Event): void {
    event?.preventDefault();
    this.chatForm().markAsTouched();

    const body = this.chatModel().message.trim();
    const attachments = this.pendingAttachments().map((attachment) => this.pendingAttachmentToRequest(attachment));

    if ((!body && !attachments.length) || !this.canSend()) {
      if (body.length > this.maxMessageLength()) {
        this.chatError.set(`Message limit is ${this.maxMessageLength()} characters.`);
      }
      return;
    }

    const request: SendChatMessageRequest = {
      roomId: this.roomId(),
      message: body,
      scope: this.isTeacherChat() ? this.chatMode() : 'private'
    };
    if (attachments.length) {
      request.attachments = attachments;
    }
    if (this.isTeacherChat() && this.chatMode() === 'private') {
      request.recipientId = this.activeRecipientId();
    }
    this.sendChatRequest(request);
  }

  protected attachFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!this.chatAttachmentsEnabled()) {
      this.chatError.set('Chat attachments are disabled for this class.');
      return;
    }
    const remainingSlots = CHAT_ATTACHMENT_MAX_COUNT - this.pendingAttachments().length - this.uploadingAttachments();
    if (remainingSlots <= 0) {
      this.chatError.set(`You can attach up to ${CHAT_ATTACHMENT_MAX_COUNT} items.`);
      return;
    }
    if (files.length > remainingSlots) {
      this.chatError.set(`You can attach up to ${CHAT_ATTACHMENT_MAX_COUNT} items.`);
    }
    for (const file of files.slice(0, remainingSlots)) {
      void this.addFileAttachment(file);
    }
  }

  protected addLinkAttachment(): void {
    if (!this.chatAttachmentsEnabled()) {
      this.chatError.set('Chat attachments are disabled for this class.');
      return;
    }
    if (!this.canAddAttachment()) {
      return;
    }
    this.linkDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.linkDraft.set('');
    this.linkDialogError.set('');
    this.linkDialogOpen.set(true);
    window.setTimeout(() => this.linkUrlInput?.nativeElement.focus());
  }

  protected updateLinkDraft(event: Event): void {
    this.linkDraft.set((event.target as HTMLInputElement | null)?.value ?? '');
  }

  protected cancelLinkAttachment(): void {
    this.linkDialogOpen.set(false);
    this.linkDraft.set('');
    this.linkDialogError.set('');
    this.restoreLinkDialogFocus();
  }

  protected confirmLinkAttachment(event?: Event): void {
    event?.preventDefault();
    if (!this.linkDialogOpen()) {
      return;
    }
    const rawUrl = this.linkDraft().trim();
    if (!rawUrl) {
      this.linkDialogError.set('Enter a link to attach.');
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.linkDialogError.set('Enter a valid link.');
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      this.linkDialogError.set('Links must use http or https.');
      return;
    }
    if (!this.canAddAttachment()) {
      return;
    }
    this.pendingAttachments.update((attachments) => [
      ...attachments,
      {
        id: this.localMessageId(),
        type: 'link',
        title: url.hostname,
        url: url.toString()
      }
    ]);
    this.chatError.set('');
    this.cancelLinkAttachment();
  }

  protected removePendingAttachment(id: string): void {
    this.pendingAttachments.update((attachments) => attachments.filter((attachment) => attachment.id !== id));
  }

  protected openAttachment(event: Event, attachment: ChatAttachment | PendingChatAttachment): void {
    if (attachment.type === 'link') {
      return;
    }
    event.preventDefault();
    const attachmentId = attachment.attachmentId ?? attachment.id;
    const sessionId = this.sessionId();
    if (!sessionId || !attachmentId) {
      this.chatError.set('Attachment is not available yet.');
      return;
    }
    firstValueFrom(this.classSessions.downloadChatAttachment(sessionId, attachmentId, { batchId: this.batchId() }))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        this.attachmentBlobUrls.push(url);
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          const link = document.createElement('a');
          link.href = url;
          link.download = this.attachmentDownloadName(attachment) ?? 'class-chat-attachment';
          link.click();
        }
      })
      .catch((error: unknown) => {
        this.chatError.set(this.classSessions.errorMessage(error));
      });
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
    if (message.deliveryState === 'read') return 'Read';
    if (message.deliveryState === 'delivered') return 'Delivered';
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
    this.pendingAttachments.set([]);
    this.chatForm().reset();
    this.sending.set(true);
    this.chatError.set('');
    this.socket
      .emitAck('chat:send', request)
      .then((message) => {
        this.reconcileLocalEcho(message, tempId);
        this.messages.update((messages) => messages.filter((item) => item.id !== tempId));
        this.upsertMessages([{ ...message, deliveryState: message.deliveryState ?? 'sent' }]);
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

  private handleTerminalChatState(): void {
    const hadPendingWork = this.sending() || this.uploadingAttachments() > 0 || this.pendingAttachments().length > 0;
    this.sending.set(false);
    this.uploadingAttachments.set(0);
    this.pendingAttachments.set([]);
    this.messages.update((messages) =>
      messages.map((message) =>
        message.deliveryState === 'sending'
          ? {
              ...message,
              deliveryState: 'failed',
              failedRequest: message.failedRequest
            }
          : message
      )
    );
    if (hadPendingWork) {
      this.chatError.set(CHAT_ENDED_MESSAGE);
    }
  }

  private async addFileAttachment(file: File): Promise<void> {
    if (!this.canAddAttachment()) {
      return;
    }
    if (!CHAT_ATTACHMENT_FILE_MIME_TYPES.has(file.type)) {
      this.chatError.set('Only PDF, JPEG, PNG, GIF, and WebP attachments are allowed.');
      return;
    }
    if (file.size > CHAT_ATTACHMENT_MAX_SIZE_BYTES) {
      this.chatError.set('Attachments cannot exceed 2 MB.');
      return;
    }
    const sessionId = this.sessionId();
    if (!sessionId) {
      this.chatError.set('Join the classroom before attaching files.');
      return;
    }
    this.uploadingAttachments.update((count) => count + 1);
    try {
      const uploaded = await firstValueFrom(this.classSessions.uploadChatAttachments(sessionId, [file], { batchId: this.batchId() }));
      const attachment = uploaded[0];
      if (!attachment) {
        throw new Error('No attachment returned');
      }
      if (!this.live()) {
        this.chatError.set(CHAT_ENDED_MESSAGE);
        return;
      }
      this.pendingAttachments.update((attachments) => [
        ...attachments,
        {
          ...attachment,
          id: attachment.id || attachment.attachmentId || this.localMessageId()
        }
      ]);
      this.chatError.set('');
    } catch (error: unknown) {
      this.chatError.set(this.classSessions.errorMessage(error));
    } finally {
      this.uploadingAttachments.update((count) => Math.max(0, count - 1));
    }
  }

  private canAddAttachment(): boolean {
    if (!this.chatAttachmentsEnabled()) {
      this.chatError.set('Chat attachments are disabled for this class.');
      return false;
    }
    if (this.pendingAttachments().length + this.uploadingAttachments() >= CHAT_ATTACHMENT_MAX_COUNT) {
      this.chatError.set(`You can attach up to ${CHAT_ATTACHMENT_MAX_COUNT} items.`);
      return false;
    }
    return true;
  }

  private restoreLinkDialogFocus(): void {
    const target = this.linkDialogReturnFocus;
    this.linkDialogReturnFocus = null;
    window.setTimeout(() => {
      if (target?.isConnected) {
        target.focus();
      }
    });
  }

  private pendingAttachmentToRequest(attachment: PendingChatAttachment): SendChatAttachment {
    return {
      id: attachment.id,
      ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
      type: attachment.type,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.title ? { title: attachment.title } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      ...(attachment.url ? { url: attachment.url } : {})
    };
  }

  protected senderName(message: ChatMessageCore): string {
    return message.senderName || this.currentUser();
  }

  protected senderRole(message: ChatMessageCore): string {
    const role = message.senderRole?.toLowerCase();
    if (role === 'teacher' || role === 'host' || role === 'co_host') return 'Teacher';
    if (role === 'admin') return 'Admin';
    return 'Student';
  }

  protected messageTime(message: ChatMessageCore): string {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(message.createdAt));
  }

  protected isMine(message: ChatMessageCore): boolean {
    const localParticipantId = this.store.localParticipantId();
    const userId = this.auth.user()?.id;
    return Boolean(message.senderId && (message.senderId === localParticipantId || message.senderId === userId));
  }

  protected isAnnouncement(message: ChatMessageCore): boolean {
    return message.scope === 'broadcast';
  }

  protected attachmentTitle(attachment: ChatAttachment | PendingChatAttachment): string {
    return attachment.title || attachment.fileName || attachment.url || 'Attachment';
  }

  protected attachmentDetail(attachment: ChatAttachment | PendingChatAttachment): string {
    if (attachment.type === 'link' && attachment.url) {
      return this.linkHost(attachment.url);
    }
    const parts = [attachment.mimeType ?? (attachment.type === 'pdf' ? 'PDF' : attachment.type), this.formatAttachmentSize(attachment.size)];
    return parts.filter(Boolean).join(' · ');
  }

  protected attachmentHref(attachment: ChatAttachment | PendingChatAttachment): string {
    return attachment.type === 'link' ? attachment.url || '#' : '#';
  }

  protected attachmentDownloadName(attachment: ChatAttachment | PendingChatAttachment): string | null {
    return attachment.type === 'link' ? null : attachment.fileName || attachment.title || 'class-chat-attachment';
  }

  protected isImageAttachment(attachment: ChatAttachment | PendingChatAttachment): boolean {
    return attachment.type === 'image' && Boolean(attachment.dataUrl || attachment.url);
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
      this.upsertMessages([{ ...message, deliveryState: this.isMine(message) ? message.deliveryState ?? 'sent' : undefined }]);
      this.loadChatSummary(true);
      queueMicrotask(() => this.markActiveViewRead());
    };
    const handleRead = (receipt: ChatReadReceiptEvent) => {
      if (receipt.sessionId !== this.sessionId() || receipt.roomId !== this.roomId()) {
        return;
      }
      this.applyReadReceipt(receipt);
      this.loadChatSummary(true);
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
    this.socket.on('chat:read', handleRead);
    this.realtimeSocket.on('connect', handleConnect);
    this.realtimeSocket.on('disconnect', handleDisconnect);
    this.socketDisposers.push(() => {
      this.socket.off('chat:message', handleMessage);
      this.socket.off('chat:read', handleRead);
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
        this.upsertMessages(history.messages.map((message) => ({ ...message, deliveryState: this.isMine(message) ? message.deliveryState ?? 'sent' : undefined })));
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
        this.upsertMessages(summaryMessages.map((message) => ({ ...message, deliveryState: this.isMine(message) ? message.deliveryState ?? 'sent' : undefined })));
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
    this.socket
      .emitAck('chat:mark-read', { sessionId, roomId, participantId, scope, readAt: latestReadAt })
      .then((state: ChatReadState) => {
        this.lastMarkedReadKeys.add(key);
        this.applyReadReceipt(state);
        this.loadChatSummary(true);
      })
      .catch(() => {
        this.lastMarkedReadKeys.delete(key);
      });
  }

  private latestReadAtFor(scope: ChatMessageScope, participantId: string | undefined): string {
    const messages = this.messages()
      .filter((message) => message.scope === scope && !message.localOnly)
      .filter((message) => {
        if (scope === 'broadcast') return true;
        if (!this.isTeacherChat()) return true;
        return this.messageMatchesTeacherThread(message, participantId);
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
          deliveryState: this.mergeDeliveryState(current?.deliveryState, message.deliveryState),
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
      ...(request.attachments?.length
        ? {
            attachments: request.attachments.map((attachment, index) => ({
              id: `${id}-attachment-${index}`,
              type: attachment.type,
              ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
              ...(attachment.title ? { title: attachment.title } : {}),
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
              ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
              ...(attachment.id ? { attachmentId: attachment.attachmentId ?? attachment.id } : {}),
              ...(attachment.url ? { url: attachment.url } : {}),
              createdAt: now
            }))
          }
        : {}),
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

  private applyReadReceipt(receipt: Pick<ChatReadReceiptEvent, 'scope' | 'threadKey' | 'participantId' | 'userId' | 'lastReadAt'>): void {
    if (receipt.scope !== 'private') {
      return;
    }
    if (receipt.userId === this.auth.user()?.id) {
      return;
    }
    const lastReadTime = Date.parse(receipt.lastReadAt);
    if (Number.isNaN(lastReadTime)) {
      return;
    }
    this.messages.update((messages) =>
      messages.map((message) => {
        if (!this.isMine(message) || message.localOnly || message.scope !== 'private' || !this.messageMatchesReadReceipt(message, receipt)) {
          return message;
        }
        const messageTime = Date.parse(message.createdAt);
        if (Number.isNaN(messageTime) || messageTime > lastReadTime) {
          return message;
        }
        return {
          ...message,
          deliveryState: 'read',
          readAt: receipt.lastReadAt
        };
      })
    );
  }

  private messageMatchesReadReceipt(
    message: ChatMessageCore,
    receipt: Pick<ChatReadReceiptEvent, 'threadKey' | 'participantId'>
  ): boolean {
    if (receipt.threadKey && message.threadKey) {
      return receipt.threadKey === message.threadKey;
    }
    if (!receipt.participantId) {
      return false;
    }
    return message.senderId === receipt.participantId || message.recipientId === receipt.participantId;
  }

  private mergeDeliveryState(current: ChatDeliveryState | undefined, incoming: ChatDeliveryState | undefined): ChatDeliveryState | undefined {
    if (!incoming) {
      return current;
    }
    if (!current || current === 'sending' || current === 'failed') {
      return incoming;
    }
    const rank: Record<Exclude<ChatDeliveryState, 'sending' | 'failed'>, number> = {
      sent: 1,
      delivered: 2,
      read: 3
    };
    if (incoming === 'sending' || incoming === 'failed') {
      return current;
    }
    return rank[incoming] >= rank[current] ? incoming : current;
  }

  private findMatchingLocalMessage(messages: readonly UiChatMessage[], message: ChatMessageCore, preferredTempId?: string): UiChatMessage | undefined {
    return messages.find((item) => {
      if (!item.localOnly) return false;
      if (preferredTempId && item.id === preferredTempId) return true;
      if (item.deliveryState === 'failed') {
        return (
          item.message === message.message &&
          item.scope === message.scope &&
          this.attachmentsMatchLoosely(item, message) &&
          this.recipientsMatchLoosely(item, message) &&
          Math.abs(Date.parse(message.createdAt) - Date.parse(item.createdAt)) < 120_000
        );
      }
      return (
        item.message === message.message &&
        item.scope === message.scope &&
        this.attachmentsMatchLoosely(item, message) &&
        this.recipientsMatchLoosely(item, message) &&
        Math.abs(Date.parse(message.createdAt) - Date.parse(item.createdAt)) < 30_000
      );
    });
  }

  private attachmentsMatchLoosely(local: UiChatMessage, persisted: ChatMessageCore): boolean {
    const localAttachments = local.attachments ?? [];
    const persistedAttachments = persisted.attachments ?? [];
    if (!localAttachments.length && !persistedAttachments.length) {
      return true;
    }
    if (localAttachments.length !== persistedAttachments.length) {
      return false;
    }
    return localAttachments.every((attachment, index) => {
      const persistedAttachment = persistedAttachments[index];
      return (
        attachment.type === persistedAttachment?.type &&
        (attachment.attachmentId || attachment.id || '') ===
          (persistedAttachment.attachmentId || persistedAttachment.id || '') &&
        (attachment.url || '') === (persistedAttachment.url || '') &&
        (attachment.fileName || attachment.title || '') === (persistedAttachment.fileName || persistedAttachment.title || '')
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

  private messageBelongsToActiveView(message: ChatMessageCore): boolean {
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
    return this.messageMatchesTeacherThread(message, participantId);
  }

  private messageIsRelevantToCurrentUser(message: ChatMessageCore): boolean {
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

    if (message.threadKey && this.privateThreadKeys().has(message.threadKey)) {
      return true;
    }
    return this.threadParticipants().some((participant) => message.senderId === participant.id || message.recipientId === participant.id);
  }

  private messageMatchesTeacherThread(message: ChatMessageCore, participantId: string | undefined): boolean {
    if (!participantId) {
      return false;
    }
    const summary = this.threadSummaryMap().get(participantId);
    if (summary?.threadKey && message.threadKey === summary.threadKey) {
      return true;
    }
    return message.senderId === participantId || message.recipientId === participantId;
  }

  private formatAttachmentSize(size: number | undefined): string {
    if (!size) {
      return '';
    }
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${Math.round(size / 1024)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  private linkHost(value: string): string {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
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
    const viewport = window.visualViewport;
    const minLeft = (viewport?.offsetLeft ?? 0) + margin;
    const minTop = (viewport?.offsetTop ?? 0) + margin;
    const maxRight = (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - margin;
    const maxBottom = (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - margin;

    if (nextLeft < minLeft) {
      x += minLeft - nextLeft;
    }

    if (nextRight > maxRight) {
      x -= nextRight - maxRight;
    }

    if (nextTop < minTop) {
      y += minTop - nextTop;
    }

    if (nextBottom > maxBottom) {
      y -= nextBottom - maxBottom;
    }

    return {
      x: Math.round(x),
      y: Math.round(y)
    };
  }

  private bindViewportEvents(): void {
    const schedule = () => this.scheduleViewportUpdate();
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    this.viewportDisposers.push(() => window.removeEventListener('resize', schedule));
    this.viewportDisposers.push(() => window.removeEventListener('orientationchange', schedule));
    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', schedule);
      viewport.addEventListener('scroll', schedule);
      this.viewportDisposers.push(() => viewport.removeEventListener('resize', schedule));
      this.viewportDisposers.push(() => viewport.removeEventListener('scroll', schedule));
    }
    this.scheduleViewportUpdate();
  }

  private scheduleViewportUpdate(): void {
    if (this.viewportFrame) {
      window.cancelAnimationFrame(this.viewportFrame);
    }
    this.viewportFrame = window.requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.updateKeyboardOffset();
      this.reclampFloatingChat();
    });
  }

  private updateKeyboardOffset(): void {
    const viewport = window.visualViewport;
    const keyboardOffset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    this.hostElement.nativeElement.style.setProperty('--chat-keyboard-offset', `${keyboardOffset}px`);
  }

  private reclampFloatingChat(): void {
    if (this.docked()) {
      this.dragOffset.set({ x: 0, y: 0 });
      return;
    }
    const chatElement = this.hostElement.nativeElement.querySelector<HTMLElement>('.session-chat');
    if (!chatElement) {
      return;
    }
    this.dragOffset.set(this.clampOffset(chatElement, this.dragOffset()));
  }

  private isMobileTouchSheet(event: PointerEvent): boolean {
    return event.pointerType === 'touch' && window.matchMedia('(max-width: 720px)').matches;
  }
}
