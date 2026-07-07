import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ClassLibraryArtifactType, ClassLibrarySearchQuery, ClassLibrarySearchResult } from '@native-sfu/contracts';
import { AdminApiService } from '../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-class-library',
  standalone: true,
  imports: [DatePipe, RouterLink, TitleCasePipe],
  templateUrl: './class-library.html',
  styleUrl: './class-library.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AdminClassLibrary implements OnInit {
  private readonly api = inject(AdminApiService);

  protected readonly q = signal('');
  protected readonly artifactType = signal<ClassLibraryArtifactType | 'all'>('all');
  protected readonly courseId = signal('');
  protected readonly batchId = signal('');
  protected readonly teacherId = signal('');
  protected readonly status = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);
  protected readonly results = signal<ClassLibrarySearchResult[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly artifactTypes: Array<{ value: ClassLibraryArtifactType | 'all'; label: string }> = [
    { value: 'all', label: 'All artifacts' },
    { value: 'session', label: 'Sessions' },
    { value: 'recording', label: 'Recordings' },
    { value: 'material', label: 'Materials' },
    { value: 'whiteboard', label: 'Whiteboards' },
    { value: 'assignment', label: 'Assignments' },
    { value: 'announcement', label: 'Announcements' },
    { value: 'qna', label: 'Q&A status' }
  ];

  ngOnInit(): void {
    this.search();
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.page.set(1);
    this.search();
  }

  protected clearFilters(): void {
    this.q.set('');
    this.artifactType.set('all');
    this.courseId.set('');
    this.batchId.set('');
    this.teacherId.set('');
    this.status.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.page.set(1);
    this.search();
  }

  protected nextPage(): void {
    if (this.page() * this.limit() >= this.total()) {
      return;
    }
    this.page.update((page) => page + 1);
    this.search();
  }

  protected previousPage(): void {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((page) => page - 1);
    this.search();
  }

  protected updateText(field: 'q' | 'courseId' | 'batchId' | 'teacherId' | 'status' | 'dateFrom' | 'dateTo', event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    switch (field) {
      case 'q':
        this.q.set(value);
        break;
      case 'courseId':
        this.courseId.set(value);
        break;
      case 'batchId':
        this.batchId.set(value);
        break;
      case 'teacherId':
        this.teacherId.set(value);
        break;
      case 'status':
        this.status.set(value);
        break;
      case 'dateFrom':
        this.dateFrom.set(value);
        break;
      case 'dateTo':
        this.dateTo.set(value);
        break;
    }
  }

  protected updateArtifactType(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : 'all';
    this.artifactType.set(value as ClassLibraryArtifactType | 'all');
  }

  protected resultDate(result: ClassLibrarySearchResult): string {
    return result.completedAt ?? result.updatedAt ?? result.scheduledAt ?? result.createdAt;
  }

  protected typeLabel(type: ClassLibraryArtifactType): string {
    return this.artifactTypes.find((item) => item.value === type)?.label.replace(/s$/, '') ?? type;
  }

  protected hasMore(): boolean {
    return this.page() * this.limit() < this.total();
  }

  private search(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.searchClassLibrary(this.query()).subscribe({
      next: (response) => {
        this.results.set(response.items);
        this.total.set(response.total);
      },
      error: (error) => {
        this.results.set([]);
        this.total.set(0);
        this.error.set(this.api.apiErrorMessage(error));
      },
      complete: () => this.loading.set(false)
    });
  }

  private query(): ClassLibrarySearchQuery {
    return {
      q: this.q(),
      artifactType: this.artifactType(),
      courseId: this.courseId(),
      batchId: this.batchId(),
      teacherId: this.teacherId(),
      status: this.status(),
      dateFrom: this.dateFrom(),
      dateTo: this.dateTo(),
      page: this.page(),
      limit: this.limit()
    };
  }
}
