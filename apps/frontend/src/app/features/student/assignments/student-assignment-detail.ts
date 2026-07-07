import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { Assignment, AssignmentAttachment, AssignmentSubmission } from '@native-sfu/contracts';
import { ClassSessionService } from '../../class-session/class-session.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

@Component({
  selector: 'sfu-student-assignment-detail',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './student-assignment-detail.html',
  styleUrl: './student-assignment-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentAssignmentDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly classSessions = inject(ClassSessionService);

  protected readonly assignment = signal<Assignment | null>(null);
  protected readonly submission = signal<AssignmentSubmission | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly text = signal('');
  protected readonly linkTitle = signal('');
  protected readonly linkUrl = signal('');
  protected readonly files = signal<File[]>([]);

  private assignmentId = '';

  ngOnInit(): void {
    this.assignmentId = this.route.snapshot.paramMap.get('assignmentId') ?? '';
    this.load();
  }

  protected load(): void {
    if (!this.assignmentId) {
      this.error.set('Assignment not found.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.classSessions.getStudentAssignment(this.assignmentId).subscribe({
      next: (detail) => {
        this.assignment.set(detail.assignment);
        this.submission.set(detail.submission ?? null);
        this.text.set(detail.submission?.text ?? '');
      },
      error: (error) => this.error.set(this.classSessions.errorMessage(error)),
      complete: () => this.loading.set(false)
    });
    this.classSessions.markAssignmentViewed(this.assignmentId).subscribe({ error: () => undefined });
  }

  protected updateText(event: Event): void {
    this.text.set(event.target instanceof HTMLTextAreaElement ? event.target.value : '');
  }

  protected updateLinkTitle(event: Event): void {
    this.linkTitle.set(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected updateLinkUrl(event: Event): void {
    this.linkUrl.set(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected updateFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.files.set(Array.from(input.files ?? []));
  }

  protected canUse(type: 'text' | 'file' | 'link'): boolean {
    return this.assignment()?.allowedSubmissionTypes.includes(type) ?? false;
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const assignment = this.assignment();
    if (!assignment || this.saving()) {
      return;
    }
    const linkTitle = this.linkTitle().trim();
    const linkUrl = this.linkUrl().trim();
    const links = linkTitle && linkUrl ? [{ title: linkTitle, url: linkUrl }] : [];
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    this.classSessions
      .submitAssignment(assignment.assignmentId, { text: this.text().trim(), links }, this.files())
      .subscribe({
        next: (submission) => {
          this.submission.set(submission);
          this.notice.set('Assignment submitted.');
          this.linkTitle.set('');
          this.linkUrl.set('');
          this.files.set([]);
        },
        error: (error) => this.error.set(this.classSessions.errorMessage(error)),
        complete: () => this.saving.set(false)
      });
  }

  protected formatDate(value?: string): string {
    if (!value) return 'No due date';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected attachmentHref(attachment: AssignmentAttachment): string {
    return attachment.url ?? attachment.downloadUrl ?? '#';
  }

  protected statusLabel(): string {
    return (this.submission()?.status ?? 'assigned').replace(/_/g, ' ');
  }
}
