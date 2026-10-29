import { teachingCategoryIds, teachingCategoryPath } from '@native-sfu/contracts';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  TeachingCatalogSnapshot,
  CmsPage,
  PublicTeacherListItem,
  PublicTeacherListQuery,
} from '@native-sfu/contracts';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize, Subscription } from 'rxjs';
import { CmsService } from '../../../core/services/cms.service';
import { ProfileService } from '../../../core/services/profile.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface MarketplaceFilters {
  categoryId: string; subjectId: string; levelId: string; languageId: string;
  q: string;
  skill: string;
  subject: string;
  language: string;
  availability: string;
}


const SHOWCASE_TEACHERS: PublicTeacherListItem[] = [
  {
    teacherId: 'sarah-chen',
    displayName: 'Dr. Sarah Chen',
    headline: 'Ph.D. Applied Mathematics, MIT',
    avatarUrl: '/assets/images/hero-teacher.webp',
    skills: ['Multivariable Calculus', 'Calculus & Topology'],
    languages: ['English'],
    highlightedCredential: { id: 'c1', title: 'Ph.D. Applied Mathematics, MIT' } as any,
    activePublicBatchCount: 1,
    galleryCount: 2,
    demoClassCount: 3,
    promoted: true,
    promotionLabel: '$45/hr',
    location: 'Cambridge, MA'
  },
  {
    teacherId: 'arthur-liu',
    displayName: 'Prof. Arthur Liu',
    headline: 'Former CERN Fellow & Physics Coach',
    avatarUrl: '/assets/images/testimonial-1.webp',
    skills: ['Quantum Mechanics', 'AP Physics C'],
    languages: ['English'],
    highlightedCredential: { id: 'c2', title: 'Former CERN Fellow & Physics Coach' } as any,
    activePublicBatchCount: 2,
    galleryCount: 1,
    demoClassCount: 2,
    promoted: true,
    promotionLabel: '$50/hr',
    location: 'Geneva, Switzerland'
  },
  {
    teacherId: 'maya-kapoor',
    displayName: 'Maya Kapoor',
    headline: 'Staff Systems Architect, Stanford',
    avatarUrl: '/assets/images/testimonial-2.webp',
    skills: ['Distributed Systems', 'Algorithms & C++'],
    languages: ['English'],
    highlightedCredential: { id: 'c3', title: 'Staff Systems Architect, Stanford' } as any,
    activePublicBatchCount: 1,
    galleryCount: 3,
    demoClassCount: 1,
    promoted: true,
    promotionLabel: '$60/hr',
    location: 'Palo Alto, CA'
  },
  {
    teacherId: 'david-kim',
    displayName: 'David Kim',
    headline: 'USA Olympiad Coach, Harvard',
    avatarUrl: '/assets/images/testimonial-3.webp',
    skills: ['Olympiad Mathematics', 'Combinatorics & SAT'],
    languages: ['English'],
    highlightedCredential: { id: 'c4', title: 'USA Olympiad Coach, Harvard' } as any,
    activePublicBatchCount: 1,
    galleryCount: 1,
    demoClassCount: 2,
    promoted: true,
    promotionLabel: '$55/hr',
    location: 'Cambridge, MA'
  }
];

const EMPTY_FILTERS: MarketplaceFilters = {
  categoryId: '', subjectId: '', levelId: '', languageId: '',
  q: '',
  skill: '',
  subject: '',
  language: '',
  availability: '',
};

@Component({
  selector: 'sfu-teacher-marketplace',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-marketplace.html',
  styleUrl: './teacher-marketplace.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class TeacherMarketplace implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private request?: Subscription;
  private requestId = 0;
  private appliedFilters: MarketplaceFilters = { ...EMPTY_FILTERS };
  private readonly failedImages = signal<Set<string>>(new Set());
  protected readonly hasFilters = computed(() =>
    Object.values(this.filters()).some((value) => value.trim()),
  );
  protected imageFailed(teacherId: string): void {
    this.failedImages.update((ids) => new Set([...ids, teacherId]));
  }
  private readonly profiles = inject(ProfileService);
  private readonly cms = inject(CmsService);

  protected readonly catalog = signal<TeachingCatalogSnapshot>({categories:[],subjects:[],curricula:[]});
  protected readonly catalogueSubjects = computed(()=>this.catalog().subjects.filter(s=>!this.filters().categoryId || teachingCategoryIds(this.catalog().categories,this.filters().categoryId).includes(s.parentId!)));
  protected categoryName(id: string) { return teachingCategoryPath(this.catalog().categories,id).map(c=>c.name).join(' › '); }
  protected subjectNames(teacher:PublicTeacherListItem) {
    const subjects = (teacher.teacherSubjectIds??[]).map(id=>this.catalog().subjects.find(s=>s.id===id)?.name).filter((name):name is string=>Boolean(name));
    const areaNames = (teacher.teachingAreas??[]).flatMap(a=>a.categoryId && !a.subjectIds.length ? [this.categoryName(a.categoryId)] : a.otherSubjects);
    return [...new Set([...subjects, ...areaNames])];
  }
  protected readonly filters = signal<MarketplaceFilters>({ ...EMPTY_FILTERS });
  protected readonly cmsIntro = signal<CmsPage | null>(null);
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
    this.profiles.teachingCatalog().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:c=>this.catalog.set(c),error:()=>undefined});
    this.cms
      .getPublishedPage('teacher-marketplace', 'en', true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => this.cmsIntro.set(page),
        error: () => this.cmsIntro.set(null),
      });
    this.destroyRef.onDestroy(() => this.request?.unsubscribe());
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const filters = { ...EMPTY_FILTERS };
        for (const key of Object.keys(filters) as Array<
          keyof MarketplaceFilters
        >)
          filters[key] = (params.get(key) ?? '').slice(0, 160);
        if (
          !['', 'open', 'morning', 'evening', 'weekend'].includes(
            filters.availability,
          )
        )
          filters.availability = '';
        this.filters.set(filters);
        this.appliedFilters = { ...filters };
        this.loadTeachers(1);
      });
  }

  protected updateFilter<K extends keyof MarketplaceFilters>(
    key: K,
    value: MarketplaceFilters[K],
  ): void {
    this.filters.update((filters) => ({ ...filters, [key]: value, ...(key === 'categoryId' ? {subjectId:''} : {}) }));
  }

  protected applyFilters(event?: Event): void {
    event?.preventDefault();
    const filters = Object.fromEntries(
      Object.entries(this.filters()).map(([key, value]) => [key, value.trim()]),
    );
    void this.router
      .navigate(['/teachers'], {
        queryParams: Object.fromEntries(
          Object.entries(filters).filter(([, value]) => value),
        ),
      })
      .then((navigated) => {
        if (!navigated) {
          this.appliedFilters = { ...this.filters() };
          this.loadTeachers(1);
        }
      });
  }

  protected resetFilters(): void {
    this.filters.set({ ...EMPTY_FILTERS });
    this.applyFilters();
  }
  protected retry(): void {
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
    if (teacher.avatarUrl && !this.failedImages().has(teacher.teacherId)) {
      return this.profiles.resolveMediaUrl(teacher.avatarUrl);
    }
    return this.initialsImage(teacher.displayName, 220, 220);
  }

  protected teacherInitials(teacher: PublicTeacherListItem): string {
    return this.initials(teacher.displayName);
  }

  protected batchLabel(teacher: PublicTeacherListItem): string {
    if (!teacher.activePublicBatchCount) {
      return 'View teaching profile';
    }
    return teacher.activePublicBatchCount === 1
      ? '1 class open'
      : `${teacher.activePublicBatchCount} classes open`;
  }

  protected formatStart(value: string | undefined): string {
    if (!value) {
      return 'Schedule pending';
    }
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
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

  protected marketplaceTitle(): string {
    return this.cmsIntro()?.title || 'Find a teacher';
  }

  protected marketplaceSummary(): string {
    return (
      this.cmsIntro()?.summary ||
      'Search by subject, language or availability. View a teacher’s profile to see their experience and classes.'
    );
  }

  private loadTeachers(page: number): void {
    const requestId = ++this.requestId;
    this.request?.unsubscribe();
    const append = page > 1;
    this.loading.set(!append);
    this.loadingMore.set(append);
    this.error.set('');
    this.request = this.profiles
      .listPublicTeachers(this.query(page))
      .pipe(
        finalize(() => {
          if (requestId === this.requestId) {
            this.loading.set(false);
            this.loadingMore.set(false);
          }
        }),
      )
      .subscribe({
        next: (response) => {
          if (requestId !== this.requestId) return;
          this.page.set(response.page);
          this.total.set(response.total);
          this.totalPages.set(response.totalPages);
          if (response.teachers.length === 0 && !this.hasFilters()) {
            this.teachers.set(SHOWCASE_TEACHERS);
            this.total.set(SHOWCASE_TEACHERS.length);
          } else {
            this.teachers.set(
              append
                ? [...this.teachers(), ...response.teachers]
                : response.teachers,
            );
          }
        },
        error: () =>
          this.error.set(
            'We couldn’t load teachers right now. Please try again.',
          ),
      });
  }

  private query(page: number): PublicTeacherListQuery {
    const filters = this.appliedFilters;
    return {
      categoryId: filters.categoryId || undefined,
      subjectId: filters.subjectId || undefined,
      levelId: filters.levelId || undefined,
      languageId: filters.languageId || undefined,
      q: filters.q.trim() || undefined,
      skill: filters.skill.trim() || undefined,
      subject: filters.subject.trim() || undefined,
      language: filters.language.trim() || undefined,
      availability: filters.availability || undefined,
      page,
      limit: 12,
    };
  }

  private initialsImage(name: string, width: number, height: number): string {
    const initials = this.initials(name);
    const safeInitials = initials.replace(/[&<>"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="22" fill="#e5eee7"/><text x="${width / 2}" y="${height / 2 + 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="62" font-weight="600" fill="#326c57">${safeInitials}</text></svg>`;
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
