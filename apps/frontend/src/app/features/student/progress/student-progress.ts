import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { StudentProgressBatchSummary, StudentProgressResponse, StudentProgressReviewSignal } from '@native-sfu/contracts';
import { ClassSessionService } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface ProgressMetric {
  label: string;
  value: string;
  hint: string;
  tone: 'green' | 'rose' | 'coral' | 'amber';
}

@Component({
  selector: 'sfu-student-progress',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './student-progress.html',
  styleUrl: './student-progress.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentProgress implements OnInit {
  private readonly classSessions = inject(ClassSessionService);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly progress = signal<StudentProgressResponse | null>(null);

  protected readonly metrics = computed<ProgressMetric[]>(() => {
    const summary = this.progress()?.summary;
    if (!summary) return [];
    return [
      {
        label: 'Attendance',
        value: summary.completedClasses ? `${summary.attendanceRate}%` : 'N/A',
        hint: `${summary.attendedClasses} present · ${summary.missedClasses} missed`,
        tone: summary.completedClasses && summary.attendanceRate < 75 ? 'amber' : 'green'
      },
      {
        label: 'Classes',
        value: `${summary.completedClasses}`,
        hint: `${summary.upcomingClasses} upcoming · ${summary.liveClasses} live`,
        tone: summary.liveClasses ? 'coral' : 'green'
      },
      {
        label: 'Assignments',
        value: `${summary.assignmentsDue}`,
        hint: `${summary.assignmentsSubmitted} submitted · ${summary.assignmentsOverdue} overdue`,
        tone: summary.assignmentsOverdue ? 'rose' : summary.assignmentsDue ? 'amber' : 'green'
      },
      {
        label: 'Recordings',
        value: summary.recordingsReady ? `${summary.recordingsWatched}/${summary.recordingsReady}` : '0',
        hint: summary.recordingsReady
          ? `${summary.recordingsUnwatched} unwatched · ${this.durationLabel(summary.recordingWatchSeconds)} watched`
          : 'No published review recordings',
        tone: summary.recordingsUnwatched ? 'amber' : summary.recordingsReady ? 'green' : 'amber'
      },
      {
        label: 'Participation',
        value: `${summary.handRaises + summary.allowedSpeakingTurns + summary.questionsAsked}`,
        hint: `${summary.questionsAsked} Q&A · ${summary.allowedSpeakingTurns} speaking turns`,
        tone: 'coral'
      },
      {
        label: 'Open Q&A',
        value: `${summary.unansweredQuestions}`,
        hint: 'Private teacher follow-ups',
        tone: summary.unansweredQuestions ? 'amber' : 'green'
      }
    ];
  });

  protected readonly batches = computed(() => this.progress()?.batches ?? []);
  protected readonly signals = computed(() => this.progress()?.reviewSignals ?? []);
  protected readonly availabilityNotes = computed(() => {
    const availability = this.progress()?.availability;
    if (!availability) return [];
    return Object.entries(availability)
      .filter(([, note]) => note.reason)
      .map(([key, note]) => ({ key, ...note }));
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.classSessions.getStudentProgress().subscribe({
      next: (response) => {
        this.progress.set(response);
        this.loading.set(false);
      },
      error: (error) => {
        this.progress.set(null);
        this.error.set(this.classSessions.errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  protected signalTone(signal: StudentProgressReviewSignal): string {
    if (signal.severity === 'needs_attention') return 'danger';
    if (signal.severity === 'watch') return 'warning';
    return 'info';
  }

  protected signalTypeLabel(signal: StudentProgressReviewSignal): string {
    return signal.type.replace(/_/g, ' ');
  }

  protected signalSourceCount(signal: StudentProgressReviewSignal): number {
    return signal.sourceRecords?.length ?? signal.sourceSessionIds?.length ?? signal.sourceAssignmentIds?.length ?? 0;
  }

  protected attendanceLabel(batch: StudentProgressBatchSummary): string {
    if (!batch.completedClasses) return 'No completed classes';
    return `${batch.attendanceRate}% attendance`;
  }

  protected durationLabel(seconds: number): string {
    if (!seconds) return '0m';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
  }

  protected formatDate(value?: string): string {
    if (!value) return 'Not recorded';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }
}
