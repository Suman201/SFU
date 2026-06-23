import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminRecordingDetail, AdminRecordingPlaybackResponse, AdminRecordingStatus } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-recording-detail',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './recording-detail.html',
  styleUrl: './recording-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class RecordingDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly recording = signal<AdminRecordingDetail | null>(null);
  protected readonly playback = signal<AdminRecordingPlaybackResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly downloading = signal(false);
  protected readonly loadingPlayback = signal(false);
  protected readonly archiving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');

  protected readonly retentionForm = this.formBuilder.nonNullable.group({
    retentionExpiresAt: ['', Validators.required]
  });

  ngOnInit(): void {
    this.load();
  }

  protected loadPlayback(): void {
    const recording = this.recording();
    if (!recording || this.loadingPlayback()) {
      return;
    }
    this.loadingPlayback.set(true);
    this.error.set('');
    this.api
      .getRecordingPlayback(recording.recordingId)
      .pipe(finalize(() => this.loadingPlayback.set(false)))
      .subscribe({
        next: (playback) => this.playback.set(playback),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected download(): void {
    const recording = this.recording();
    if (!recording || this.downloading()) {
      return;
    }
    this.downloading.set(true);
    this.error.set('');
    this.api
      .downloadRecording(recording.recordingId)
      .pipe(finalize(() => this.downloading.set(false)))
      .subscribe({
        next: (blob) => this.saveBlob(blob, `${recording.sessionTitle || recording.recordingId}-recording.json`),
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected saveRetention(): void {
    const recording = this.recording();
    if (!recording || this.retentionForm.invalid || this.saving()) {
      this.retentionForm.markAllAsTouched();
      return;
    }
    const value = this.retentionForm.controls.retentionExpiresAt.value;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateRecordingRetention(recording.recordingId, { retentionExpiresAt: new Date(value).toISOString() })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.recording.set(updated);
          this.patchRetention(updated);
          this.success.set('Retention updated.');
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected archive(): void {
    const recording = this.recording();
    if (!recording || this.archiving() || !confirm('Expire this recording now? Physical storage will not be deleted.')) {
      return;
    }
    this.archiving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .archiveRecording(recording.recordingId)
      .pipe(finalize(() => this.archiving.set(false)))
      .subscribe({
        next: (updated) => {
          this.recording.set(updated);
          this.patchRetention(updated);
          this.playback.set(null);
          this.success.set('Recording expired.');
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected statusClass(status: AdminRecordingStatus): string {
    return `status-${status}`;
  }

  protected duration(seconds?: number): string {
    if (seconds === undefined) return 'Unknown';
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
  }

  protected size(bytes?: number): string {
    if (bytes === undefined) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / 104857.6) / 10} MB`;
  }

  private load(): void {
    const recordingId = this.route.snapshot.paramMap.get('recordingId');
    if (!recordingId) {
      this.error.set('Recording id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getRecording(recordingId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (recording) => {
          this.recording.set(recording);
          this.patchRetention(recording);
          if (recording.canPlayback) {
            this.loadPlayback();
          }
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private patchRetention(recording: AdminRecordingDetail): void {
    this.retentionForm.reset({
      retentionExpiresAt: recording.retentionExpiresAt ? recording.retentionExpiresAt.slice(0, 16) : ''
    });
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const safe = fileName.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'recording.json';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safe;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
