import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { StudentCompletedClassSessionListItem, StudentCompletedClassSessionListResponse } from '@native-sfu/contracts';
import { ClassSessionService } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

@Component({
  selector: 'sfu-student-completed-classes',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './completed-classes-list.html',
  styleUrl: './completed-classes-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentCompletedClassesList implements OnInit {
  private readonly classSessions = inject(ClassSessionService);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly response = signal<StudentCompletedClassSessionListResponse | null>(null);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.classSessions.listCompletedStudentSessions({ limit: 50 }).subscribe({
      next: (response) => {
        this.response.set(response);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(this.classSessions.errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  protected rows(): StudentCompletedClassSessionListItem[] {
    return this.response()?.items ?? [];
  }

  protected formatDate(value?: string): string {
    if (!value) return 'Not recorded';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected artifactLabel(row: StudentCompletedClassSessionListItem): string {
    const notes = row.notesPageCount ? `${row.notesPageCount} notes` : 'No notes';
    const materials = row.materialCount ? `${row.materialCount} materials` : 'No materials';
    return `${notes} · ${materials}`;
  }

  protected recordingLabel(row: StudentCompletedClassSessionListItem): string {
    if (!row.recordingStatus) return 'None';
    if (row.recordingStatus === 'stopped') return 'Ready';
    if (row.recordingStatus === 'failed') return 'Failed';
    return 'Processing';
  }

  protected attendanceLabel(row: StudentCompletedClassSessionListItem): string {
    if (row.attendance.status === 'present') return 'Present';
    if (row.attendance.status === 'absent') return 'Absent';
    return 'Unknown';
  }
}
