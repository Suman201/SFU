import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { SupportIssueType, SupportRequest, SupportRequestDiagnostics } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { ClassSessionService } from '../../class-session/class-session.service';

@Component({
  selector: 'sfu-student-support',
  standalone: true,
  imports: [DatePipe, Footer, Header, ReactiveFormsModule, RouterLink],
  templateUrl: './student-support.html',
  styleUrl: './student-support.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentSupport implements OnInit {
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly classSessions = inject(ClassSessionService);

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly requests = signal<SupportRequest[]>([]);
  protected readonly total = signal(0);

  protected readonly form = this.formBuilder.nonNullable.group({
    issueType: ['class_issue' as SupportIssueType, Validators.required],
    subject: ['', [Validators.required, Validators.maxLength(180)]],
    message: ['', [Validators.required, Validators.maxLength(5000)]],
    includeDiagnostics: [true],
    batchId: [''],
    sessionId: [''],
    roomId: [''],
    recordingId: ['']
  });

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.form.patchValue({
      issueType: (params.get('issueType') as SupportIssueType | null) ?? 'class_issue',
      subject: params.get('subject') ?? '',
      batchId: params.get('batchId') ?? '',
      sessionId: params.get('sessionId') ?? '',
      roomId: params.get('roomId') ?? '',
      recordingId: params.get('recordingId') ?? ''
    });
    this.loadRequests();
  }

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const value = this.form.getRawValue();
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.classSessions
      .createSupportRequest({
        issueType: value.issueType,
        subject: value.subject.trim(),
        message: value.message.trim(),
        ...(value.batchId.trim() ? { batchId: value.batchId.trim() } : {}),
        ...(value.sessionId.trim() ? { sessionId: value.sessionId.trim() } : {}),
        ...(value.roomId.trim() ? { roomId: value.roomId.trim() } : {}),
        ...(value.recordingId.trim() ? { recordingId: value.recordingId.trim() } : {}),
        ...(value.includeDiagnostics ? { diagnostics: this.diagnostics() } : {})
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (request) => {
          this.success.set(`Support request ${request.requestId.slice(0, 8)} opened.`);
          this.form.patchValue({ subject: '', message: '' });
          this.loadRequests();
        },
        error: (error) => this.error.set(this.classSessions.errorMessage(error))
      });
  }

  protected loadRequests(): void {
    this.loading.set(true);
    this.error.set('');
    this.classSessions
      .listMySupportRequests({ limit: 20 })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.requests.set(response.items);
          this.total.set(response.total);
        },
        error: (error) => this.error.set(this.classSessions.errorMessage(error))
      });
  }

  protected statusLabel(status: string): string {
    return status.replace(/_/g, ' ');
  }

  protected issueLabel(issueType: string): string {
    return issueType.replace(/_/g, ' ');
  }

  protected contextLabel(request: SupportRequest): string {
    if (request.sessionTitle) return request.sessionTitle;
    if (request.batchName) return request.batchName;
    if (request.recordingId) return 'Recording issue';
    return 'General support';
  }

  protected latestCommentMessage(request: SupportRequest): string {
    return request.comments.at(-1)?.message ?? '';
  }

  protected trackByRequest(_index: number, request: SupportRequest): string {
    return request.requestId;
  }

  private diagnostics(): SupportRequestDiagnostics {
    return {
      userAgent: navigator.userAgent,
      route: window.location.href,
      timestamp: new Date().toISOString(),
      platform: navigator.platform || 'unknown'
    };
  }
}
