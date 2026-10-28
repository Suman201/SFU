import { DestroyRef } from '@angular/core';
import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { finalize } from 'rxjs';
import type {
  TutorApplication,
  TeachingCatalogSnapshot,
  TutorReviewRequest,
} from '@native-sfu/contracts';
import { TeachingCatalogApi } from '../../core/services/teaching-catalog-api.service';
@Component({
  selector: 'sfu-tutor-applications',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './tutor-applications.html',
  styleUrl: './teaching-catalog.scss',
})
export class TutorApplicationsAdmin implements OnInit {
  protected readonly videoPreview = signal('');
  private readonly destroyRef = inject(DestroyRef);
  private clearPreview() {
    if (this.videoPreview()) URL.revokeObjectURL(this.videoPreview());
    this.videoPreview.set('');
  }
  protected previewVideo() {
    const id = this.detail()?.teacherId;
    if (!id) return;
    this.api.introVideo(id).subscribe({
      next: (blob) => {
        this.clearPreview();
        this.videoPreview.set(URL.createObjectURL(blob));
      },
      error: (e) => this.error.set(this.api.error(e)),
    });
  }
  protected readonly api = inject(TeachingCatalogApi);
  protected readonly rows = signal<Partial<TutorApplication>[]>([]);
  protected readonly detail = signal<TutorApplication | null>(null);
  protected readonly catalog = signal<TeachingCatalogSnapshot>({
    categories: [],
    subjects: [],
    curricula: [],
  });
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected status = 'submitted';
  protected videoReviewed = false;
  protected results: import('@native-sfu/contracts').TutorAssessmentResult[] =
    [];
  protected note = '';
  protected identity = false;
  protected teaching = false;
  protected safeguarding = false;
  ngOnInit() {
    this.destroyRef.onDestroy(() => this.clearPreview());
    this.load();
    this.api.snapshot().subscribe({
      next: (c) => this.catalog.set(c),
      error: (e) => this.error.set(this.api.error(e)),
    });
  }
  protected countryName(code: string) {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  }
  protected subjectNames(ids: string[]) {
    return ids
      .map(
        (id) =>
          this.catalog().subjects.find((s) => s.id === id)?.name ||
          'Archived subject',
      )
      .join(', ');
  }
  protected curriculumNames(ids: string[]) {
    return (
      ids
        .map(
          (id) =>
            this.catalog().curricula.find((s) => s.id === id)?.name ||
            'Archived curriculum',
        )
        .join(', ') || 'Not specified'
    );
  }
  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api
      .applications(this.status, this.page())
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (r) => {
          this.rows.set(r.items);
          this.total.set(r.total);
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected filter() {
    this.page.set(1);
    this.detail.set(null);
    this.load();
  }
  protected goPage(delta: number) {
    this.page.update((p) => p + delta);
    this.load();
  }
  protected open(id: string) {
    this.clearPreview();
    this.error.set('');
    this.note = '';
    this.identity = false;
    this.teaching = false;
    this.safeguarding = false;
    this.loading.set(true);
    this.api
      .application(id)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (d) => {
          this.detail.set(d);
          this.videoReviewed = false;
          this.results = d.requiredAssessments.map((c) => ({
            categoryId: c.categoryId,
            version: c.version,
            passed: false,
            notes: '',
          }));
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected allAssessmentsPassed() {
    return (
      this.results.length === this.detail()?.requiredAssessments.length &&
      this.results.every((r) => r.passed && r.notes.trim().length >= 10)
    );
  }
  protected assessmentResponse(id: string) {
    return this.detail()?.assessmentResponses.find((r) => r.categoryId === id);
  }
  protected review(decision: TutorReviewRequest['decision']) {
    const current = this.detail();
    if (!current || this.saving() || this.note.trim().length < 10) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .review(current.teacherId, {
        decision,
        revision: current.revision,
        note: this.note,
        introVideoReviewed: this.videoReviewed,
        assessmentResults: this.results,
        identityChecked: this.identity,
        teachingSuitabilityChecked: this.teaching,
        safeguardingChecked: this.safeguarding,
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (d) => {
          this.detail.set(d);
          this.load();
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
}
