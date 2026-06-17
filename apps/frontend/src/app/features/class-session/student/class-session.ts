import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { SessionChat } from '../session-chat/session-chat';

interface StudentSessionParticipant {
  id: string;
  name: string;
  role: 'Teacher' | 'Student';
  initials: string;
  speaking: boolean;
}

@Component({
  selector: 'sfu-student-class-session',
  standalone: true,
  imports: [SessionChat],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentClassSession {
  protected readonly participantsOpen = signal(false);

  protected readonly participants = signal<StudentSessionParticipant[]>([
    { id: 'teacher-1', name: 'Teacher', role: 'Teacher', initials: 'TR', speaking: true },
    { id: 'student-1', name: 'Student 1', role: 'Student', initials: 'S1', speaking: false },
    { id: 'student-2', name: 'Student 2', role: 'Student', initials: 'S2', speaking: false },
    { id: 'student-3', name: 'Student 3', role: 'Student', initials: 'S3', speaking: false },
    { id: 'student-4', name: 'Student 4', role: 'Student', initials: 'S4', speaking: false }
  ]);

  protected toggleParticipants(): void {
    this.participantsOpen.update((open) => !open);
  }

  protected closeParticipants(): void {
    this.participantsOpen.set(false);
  }
}
