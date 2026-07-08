import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  Assignment,
  AssignmentSubmission,
  ChatMessage,
  ClassSessionMaterial,
  Recording,
  RecordingPlaybackProgressEvent,
  StudentCompletedClassDetailResponse,
  WhiteboardMemoryState
} from '@native-sfu/contracts';
import { ClassSessionService } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { Whiteboard } from '../../../shared/whiteboard/whiteboard';

@Component({
  selector: 'sfu-student-completed-class-detail',
  standalone: true,
  imports: [Footer, Header, RouterLink, Whiteboard],
  templateUrl: './completed-class-detail.html',
  styleUrl: './completed-class-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentCompletedClassDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly classSessions = inject(ClassSessionService);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly sendError = signal('');
  protected readonly sending = signal(false);
  protected readonly draft = signal('');
  protected readonly detail = signal<StudentCompletedClassDetailResponse | null>(null);
  protected readonly assignments = signal<Array<Assignment & { submission?: AssignmentSubmission }>>([]);
  protected readonly assignmentsError = signal('');
  protected readonly whiteboardState = signal<WhiteboardMemoryState | null>(null);
  protected readonly whiteboardError = signal('');
  protected readonly privateMessages = computed(() => this.detail()?.privateThread.messages ?? []);

  private sessionId = '';
  private batchId = '';
  private readonly lastRecordingHeartbeat = new Map<string, number>();

  ngOnInit(): void {
    this.sessionId = this.route.snapshot.paramMap.get('sessionId') ?? '';
    this.batchId = this.route.snapshot.queryParamMap.get('batchId') ?? '';
    this.load();
  }

  protected load(): void {
    if (!this.sessionId) {
      this.error.set('Class session not found.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.classSessions.getCompletedStudentSessionDetail(this.sessionId, this.batchId).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.loading.set(false);
        this.loadAssignments(detail.session.batchId);
        this.loadWhiteboardState(detail.session.batchId);
      },
      error: (error) => {
        this.error.set(this.classSessions.errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  private loadWhiteboardState(batchId: string): void {
    this.whiteboardError.set('');
    this.classSessions.getWhiteboardMemory(this.sessionId, { batchId: this.batchId || batchId }).subscribe({
      next: (state) => this.whiteboardState.set(state),
      error: (error) => {
        this.whiteboardState.set(null);
        this.whiteboardError.set(this.classSessions.errorMessage(error));
      }
    });
  }

  protected updateDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected sendQuestion(event: Event): void {
    event.preventDefault();
    const message = this.draft().trim();
    if (!message || !this.detail()) {
      return;
    }
    this.sending.set(true);
    this.sendError.set('');
    this.classSessions.sendPostClassQuestion(this.sessionId, { batchId: this.batchId || this.detail()!.session.batchId, message }).subscribe({
      next: (sent) => {
        this.detail.update((current) => {
          if (!current) return current;
          return {
            ...current,
            privateThread: {
              ...current.privateThread,
              messages: [...current.privateThread.messages, sent]
            }
          };
        });
        this.draft.set('');
        this.sending.set(false);
      },
      error: (error) => {
        this.sendError.set(this.classSessions.errorMessage(error));
        this.sending.set(false);
      }
    });
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

  protected durationLabel(seconds: number): string {
    if (!seconds) return '0 min';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  }

  protected recordingLabel(recording: Recording): string {
    if (recording.status === 'stopped') return 'Ready';
    if (recording.status === 'failed') return 'Failed';
    return 'Processing';
  }

  protected recordingHref(recording: Recording): string {
    return recording.playbackUrl ?? recording.downloadUrl ?? recording.url ?? '#';
  }

  protected isVideoRecording(recording: Recording): boolean {
    return Boolean(this.recordingHref(recording) !== '#' && (recording.mimeType?.startsWith('video/') || recording.playbackUrl));
  }

  protected recordingProgressLabel(recording: Recording): string {
    const progress = recording.playbackProgress;
    if (!progress) return 'Not started';
    if (progress.completedAt || progress.completionPercent >= 90) return 'Watched';
    if (progress.completionPercent > 0 || progress.lastPlayedAt) return `In progress · ${progress.completionPercent}%`;
    return 'Not started';
  }

  protected recordingProgressTone(recording: Recording): string {
    const progress = recording.playbackProgress;
    if (progress?.completedAt || (progress?.completionPercent ?? 0) >= 90) return 'watched';
    if ((progress?.completionPercent ?? 0) > 0 || progress?.lastPlayedAt) return 'progress';
    return 'empty';
  }

  protected onRecordingOpen(recording: Recording): void {
    this.sendRecordingProgress(recording, 'play');
  }

  protected onRecordingMediaEvent(recording: Recording, eventName: RecordingPlaybackProgressEvent, event: Event): void {
    const media = event.target instanceof HTMLMediaElement ? event.target : undefined;
    this.sendRecordingProgress(recording, eventName, media);
  }

  protected onRecordingTimeUpdate(recording: Recording, event: Event): void {
    const recordingId = recording.recordingId ?? recording.id;
    const now = Date.now();
    const last = this.lastRecordingHeartbeat.get(recordingId) ?? 0;
    if (now - last < 20_000) {
      return;
    }
    this.lastRecordingHeartbeat.set(recordingId, now);
    const media = event.target instanceof HTMLMediaElement ? event.target : undefined;
    this.sendRecordingProgress(recording, 'heartbeat', media);
  }

  protected materialHref(material: ClassSessionMaterial): string {
    return material.url ?? material.downloadUrl ?? '#';
  }

  protected assignmentStatus(assignment: Assignment & { submission?: AssignmentSubmission }): string {
    return (assignment.submission?.status ?? 'assigned').replace(/_/g, ' ');
  }

  protected messageAuthor(message: ChatMessage): string {
    return message.senderRole === 'student' ? 'You' : message.senderName;
  }

  private loadAssignments(batchId: string): void {
    this.assignmentsError.set('');
    this.classSessions.listStudentAssignments({ batchId, sessionId: this.sessionId }).subscribe({
      next: (response) => this.assignments.set(response.items),
      error: (error) => this.assignmentsError.set(this.classSessions.errorMessage(error))
    });
  }

  private sendRecordingProgress(recording: Recording, eventName: RecordingPlaybackProgressEvent, media?: HTMLMediaElement): void {
    const recordingId = recording.recordingId ?? recording.id;
    const detail = this.detail();
    if (!recordingId || !detail || recording.status !== 'stopped') {
      return;
    }
    const positionSeconds = this.finiteSeconds(media?.currentTime);
    const durationSeconds = this.finiteSeconds(media?.duration) ?? this.finiteSeconds(recording.durationSeconds);
    this.classSessions
      .updateRecordingPlaybackProgress(recordingId, {
        sessionId: this.sessionId,
        batchId: this.batchId || detail.session.batchId,
        event: eventName,
        positionSeconds,
        durationSeconds,
        watchedSeconds: positionSeconds,
        completed: eventName === 'ended'
      })
      .subscribe({
        next: (playbackProgress) => {
          this.detail.update((current) => {
            if (!current) return current;
            return {
              ...current,
              recordings: current.recordings.map((item) =>
                (item.recordingId ?? item.id) === playbackProgress.recordingId ? { ...item, playbackProgress } : item
              )
            };
          });
        },
        error: () => undefined
      });
  }

  private finiteSeconds(value?: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return Math.round(value);
  }
}
