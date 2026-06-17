import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormField, FormRoot, form as signalForm } from '@angular/forms/signals';

interface ChatMessage {
  id: number;
  author: string;
  role: 'Teacher' | 'Student';
  body: string;
  sentAt: string;
  mine?: boolean;
}

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

@Component({
  selector: 'sfu-session-chat',
  standalone: true,
  imports: [FormField, FormRoot],
  templateUrl: './session-chat.html',
  styleUrl: './session-chat.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class SessionChat {
  readonly currentUser = input('Teacher');
  readonly currentRole = input<'Teacher' | 'Student'>('Teacher');

  protected readonly dragOffset = signal<ChatPosition>({ x: 0, y: 0 });
  protected readonly dragging = signal(false);
  protected readonly collapsed = signal(false);
  protected readonly chatModel = signal<ChatComposerFormModel>({ message: '' });
  protected readonly chatForm = signalForm(this.chatModel);
  protected readonly messages = signal<ChatMessage[]>([
    {
      id: 1,
      author: 'Teacher',
      role: 'Teacher',
      body: 'Welcome everyone. We will begin in a moment.',
      sentAt: '10:00'
    },
    {
      id: 2,
      author: 'Student 1',
      role: 'Student',
      body: 'Ready for class.',
      sentAt: '10:01'
    }
  ]);

  protected readonly dragTransform = computed(() => {
    const offset = this.dragOffset();

    return `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  });

  protected readonly unreadCount = computed(() => (this.collapsed() ? this.messages().length : 0));

  private dragState: ChatDragState | null = null;
  private suppressNextToggle = false;

  protected toggleCollapsed(event?: Event): void {
    if (this.suppressNextToggle) {
      event?.preventDefault();
      event?.stopPropagation();
      this.suppressNextToggle = false;
      return;
    }

    this.collapsed.update((collapsed) => !collapsed);
  }

  protected startDrag(event: PointerEvent, chatElement: HTMLElement): void {
    if (event.button !== 0) {
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

  protected sendMessage(event?: Event): void {
    event?.preventDefault();
    this.chatForm().markAsTouched();

    const body = this.chatModel().message.trim();

    if (!body) {
      return;
    }

    const nextMessage: ChatMessage = {
      id: Date.now(),
      author: this.currentUser(),
      role: this.currentRole(),
      body,
      sentAt: this.currentTime(),
      mine: true
    };

    this.messages.update((messages) => [...messages, nextMessage]);
    this.chatModel.set({ message: '' });
    this.chatForm().reset();
  }

  private currentTime(): string {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date());
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
