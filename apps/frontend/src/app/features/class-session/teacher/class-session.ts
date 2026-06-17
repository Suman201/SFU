import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
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
  imports: [  SessionChat, Whiteboard],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherClassSession {
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

  protected toggleMute(participantId: string): void {
    this.updateParticipant(participantId, (participant) => ({ ...participant, muted: !participant.muted }));
  }

  protected toggleCamera(participantId: string): void {
    this.updateParticipant(participantId, (participant) => ({ ...participant, cameraOff: !participant.cameraOff }));
  }

  private updateParticipant(participantId: string, update: (participant: SessionParticipant) => SessionParticipant): void {
    this.participants.update((participants) =>
      participants.map((participant) => (participant.id === participantId ? update(participant) : participant))
    );
  }
}
