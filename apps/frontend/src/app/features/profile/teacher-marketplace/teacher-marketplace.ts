import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PublicTeacherListItem, PublicTeacherListQuery } from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface MarketplaceFilters {
  q: string;
  skill: string;
  subject: string;
  language: string;
  availability: string;
}

const EMPTY_FILTERS: MarketplaceFilters = {
  q: '',
  skill: '',
  subject: '',
  language: '',
  availability: ''
};

@Component({
  selector: 'sfu-teacher-marketplace',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-marketplace.html',
  styleUrl: './teacher-marketplace.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherMarketplace implements OnInit {
  private readonly profiles = inject(ProfileService);

  protected readonly filters = signal<MarketplaceFilters>({ ...EMPTY_FILTERS });
  protected readonly teachers = signal<PublicTeacherListItem[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal('');
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly totalPages = signal(0);
  protected readonly hasResults = computed(() => this.teachers().length > 0);
  protected readonly hasMore = computed(() => this.page() < this.totalPages());

  ngOnInit(): void {
    this.loadTeachers(1);
  }

  protected updateFilter<K extends keyof MarketplaceFilters>(key: K, value: MarketplaceFilters[K]): void {
    this.filters.update((filters) => ({ ...filters, [key]: value }));
  }

  protected applyFilters(): void {
    this.loadTeachers(1);
  }

  protected resetFilters(): void {
    this.filters.set({ ...EMPTY_FILTERS });
    this.loadTeachers(1);
  }

  protected loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) {
      return;
    }
    this.loadTeachers(this.page() + 1);
  }

  protected inputValue(event: Event): string {
    return event.target instanceof HTMLInputElement ? event.target.value : '';
  }

  protected selectValue(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  protected profileImage(teacher: PublicTeacherListItem): string {
    if (teacher.avatarUrl) {
      return this.profiles.resolveMediaUrl(teacher.avatarUrl);
    }
    return this.initialsImage(teacher.displayName, 220, 220);
  }

  protected teacherInitials(teacher: PublicTeacherListItem): string {
    return this.initials(teacher.displayName);
  }

  protected batchLabel(teacher: PublicTeacherListItem): string {
    if (!teacher.activePublicBatchCount) {
      return 'No open batches';
    }
    return teacher.activePublicBatchCount === 1 ? '1 open batch' : `${teacher.activePublicBatchCount} open batches`;
  }

  protected formatStart(value: string | undefined): string {
    if (!value) {
      return 'Schedule pending';
    }
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected trustLabel(teacher: PublicTeacherListItem): string {
    if (teacher.highlightedCredential?.title) {
      return teacher.highlightedCredential.title;
    }
    const primarySkill = teacher.skills[0];
    if (primarySkill) {
      return primarySkill;
    }
    return 'Published profile';
  }

  private loadTeachers(page: number): void {
    const append = page > 1;
    append ? this.loadingMore.set(true) : this.loading.set(true);
    this.error.set('');
    this.profiles.listPublicTeachers(this.query(page)).subscribe({
      next: (response) => {
        this.page.set(response.page);
        this.total.set(response.total);
        this.totalPages.set(response.totalPages);
        this.teachers.set(append ? [...this.teachers(), ...response.teachers] : response.teachers);
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    });
  }

  private query(page: number): PublicTeacherListQuery {
    const filters = this.filters();
    return {
      q: filters.q.trim() || undefined,
      skill: filters.skill.trim() || undefined,
      subject: filters.subject.trim() || undefined,
      language: filters.language.trim() || undefined,
      availability: filters.availability || undefined,
      page,
      limit: 12
    };
  }

  private initialsImage(name: string, width: number, height: number): string {
    const initials = this.initials(name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${name} profile image"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#458B73"/><stop offset="1" stop-color="#F26076"/></linearGradient></defs><rect width="${width}" height="${height}" rx="64" fill="url(#g)"/><text x="${width / 2}" y="${height / 2 + 22}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="62" font-weight="800" fill="#fff">${initials}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  private initials(name: string): string {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
}
