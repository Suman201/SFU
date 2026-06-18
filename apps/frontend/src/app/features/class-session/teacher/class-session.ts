import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { Whiteboard, type WhiteboardCursor } from '../../../shared/whiteboard/whiteboard';
import { SessionChat } from '../session-chat/session-chat';

interface SessionParticipant {
  id: string;
  name: string;
  initials: string;
  muted: boolean;
  cameraOff: boolean;
}

@Component({
  selector: 'sfu-teacher-class-session',
  standalone: true,
  imports: [SessionChat, Whiteboard],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherClassSession {
  private readonly minimumParticipantHeight = 220;
  private readonly minimumChatHeight = 240;
  private readonly dividerHeight = 10;
  private resizePointerId: number | null = null;
  private resizeHandle: HTMLElement | null = null;

  protected readonly participants = signal<SessionParticipant[]>([
    { id: 'student-1', name: 'Student 1', initials: 'S1', muted: false, cameraOff: false },
    { id: 'student-2', name: 'Student 2', initials: 'S2', muted: true, cameraOff: false },
    { id: 'student-3', name: 'Student 3', initials: 'S3', muted: false, cameraOff: true },
    { id: 'student-4', name: 'Student 4', initials: 'S4', muted: false, cameraOff: false }
  ]);

  protected readonly studentCursors = signal<WhiteboardCursor[]>([
    {
      participantId: 'student-1',
      displayName: 'Student 1',
      color: '#2563eb',
      position: { x: 260, y: 140 }
    },
    {
      participantId: 'student-3',
      displayName: 'Student 3',
      color: '#b94141',
      position: { x: 440, y: 270 }
    }
  ]);
  protected readonly chatCollapsed = signal(false);
  protected readonly sidebarSplitPercent = signal(50);
  protected readonly resizingSidebar = signal(false);
  protected readonly sidebarRows = computed(() =>
    this.chatCollapsed()
      ? 'minmax(0, 1fr) auto'
      : `minmax(${this.minimumParticipantHeight}px, ${this.sidebarSplitPercent()}fr) ${this.dividerHeight}px minmax(${this.minimumChatHeight}px, ${100 - this.sidebarSplitPercent()}fr)`
  );

  protected toggleMute(participantId: string): void {
    this.updateParticipant(participantId, (participant) => ({ ...participant, muted: !participant.muted }));
  }

  protected toggleCamera(participantId: string): void {
    this.updateParticipant(participantId, (participant) => ({ ...participant, cameraOff: !participant.cameraOff }));
  }

  protected startSidebarResize(event: PointerEvent, sidebar: HTMLElement, handle: HTMLElement): void {
    if (this.chatCollapsed() || event.button !== 0) {
      return;
    }

    this.resizePointerId = event.pointerId;
    this.resizeHandle = handle;
    this.resizingSidebar.set(true);
    handle.setPointerCapture(event.pointerId);
    this.applySidebarResize(event, sidebar);
    event.preventDefault();
  }

  protected resizeSidebar(event: PointerEvent, sidebar: HTMLElement): void {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    this.applySidebarResize(event, sidebar);
    event.preventDefault();
  }

  protected endSidebarResize(event: PointerEvent): void {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    if (this.resizeHandle?.hasPointerCapture(event.pointerId)) {
      this.resizeHandle.releasePointerCapture(event.pointerId);
    }

    this.resizePointerId = null;
    this.resizeHandle = null;
    this.resizingSidebar.set(false);
  }

  protected resizeSidebarWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }

    const direction = event.key === 'ArrowUp' ? -5 : 5;
    this.sidebarSplitPercent.update((value) => this.clampSplitPercent(value + direction));
    event.preventDefault();
  }

  private updateParticipant(participantId: string, update: (participant: SessionParticipant) => SessionParticipant): void {
    this.participants.update((participants) =>
      participants.map((participant) => (participant.id === participantId ? update(participant) : participant))
    );
  }

  private applySidebarResize(event: PointerEvent, sidebar: HTMLElement): void {
    const rect = sidebar.getBoundingClientRect();
    const usableHeight = rect.height - this.dividerHeight;
    const minimumTotal = this.minimumParticipantHeight + this.minimumChatHeight;

    if (usableHeight <= minimumTotal) {
      this.sidebarSplitPercent.set(50);
      return;
    }

    const pointerY = event.clientY - rect.top;
    const maximumParticipantHeight = usableHeight - this.minimumChatHeight;
    const clampedParticipantHeight = Math.min(Math.max(pointerY, this.minimumParticipantHeight), maximumParticipantHeight);
    this.sidebarSplitPercent.set(Math.round((clampedParticipantHeight / usableHeight) * 100));
  }

  private clampSplitPercent(value: number): number {
    return Math.min(72, Math.max(28, value));
  }
}
