import { TeachingAreasSummary } from '../../../shared/teaching-areas/teaching-areas-summary';
import type { TeachingCatalogSnapshot } from '@native-sfu/contracts';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { finalize, Subscription } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  ProfileBatchAssociation,
  ProfileCredential,
  PublicTeacherProfile as PublicTeacherProfileData,
  TeacherPublicContentItem,
} from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { Footer } from '../../../shared/footer/footer';
import { formatBatchFee } from '../../../shared/formatting/batch-fee';
import { Header } from '../../../shared/header/header';

type TeacherProfileTab =
  | 'gallery'
  | 'demos'
  | 'credentials'
  | 'experience'
  | 'links'
  | 'batches';

interface TeacherProfileTabItem {
  id: TeacherProfileTab;
  label: string;
}

const PROFILE_TABS: TeacherProfileTabItem[] = [
  { id: 'batches', label: 'Classes' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'demos', label: 'Demo classes' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'experience', label: 'Experience' },
  { id: 'links', label: 'Links' },
];

@Component({
  selector: 'sfu-public-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink, TeachingAreasSummary],
  templateUrl: './public-teacher-profile.html',
  styleUrl: './public-teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class PublicTeacherProfile implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private profileRequest?: Subscription;
  private readonly route = inject(ActivatedRoute);
  private readonly profiles = inject(ProfileService);
  private readonly paramMap = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });

  protected readonly teacherId = computed(
    () => this.paramMap().get('teacherId') ?? '',
  );
  protected readonly teacher = signal<PublicTeacherProfileData | null>(null);
  protected readonly catalog = signal<TeachingCatalogSnapshot>({
    categories: [],
    subjects: [],
    curricula: [],
  });
  protected introVideoUrl(id: string) {
    return this.profiles.resolveMediaUrl(
      '/api/v1/teachers/' + encodeURIComponent(id) + '/introduction-video',
    );
  }
  protected subjectNames(ids: string[] = []) {
    return ids
      .map((id) => this.catalog().subjects.find((s) => s.id === id)?.name)
      .filter(Boolean);
  }
  protected curriculumNames(ids: string[] = []) {
    return ids
      .map((id) => this.catalog().curricula.find((s) => s.id === id)?.name)
      .filter(Boolean);
  }
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly activeTab = signal<TeacherProfileTab>('batches');
  protected readonly visibleTabs = computed(() => {
    const teacher = this.teacher();
    return PROFILE_TABS.filter(
      (tab) =>
        tab.id === 'batches' || (teacher && this.tabCount(teacher, tab.id) > 0),
    );
  });
  protected readonly totalCapacity = computed(
    () =>
      this.teacher()?.batches.reduce(
        (total, batch) => total + (batch.capacity ?? 0),
        0,
      ) ?? 0,
  );
  protected readonly totalEnrolled = computed(
    () =>
      this.teacher()?.batches.reduce(
        (total, batch) => total + (batch.enrolledCount ?? 0),
        0,
      ) ?? 0,
  );

  ngOnInit(): void {
    this.profiles
      .teachingCatalog()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.catalog.set(c), error: () => undefined });
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.activeTab.set('batches');
        this.loadTeacher();
      });
    this.destroyRef.onDestroy(() => this.profileRequest?.unsubscribe());
  }

  protected loadTeacher(): void {
    const teacherId = this.teacherId();
    if (!teacherId) {
      this.error.set('Teacher profile is not available.');
      return;
    }
    this.profileRequest?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.profileRequest = this.profiles
      .getPublicTeacherProfile(teacherId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (profile) => this.teacher.set(profile),
        error: (error) => {
          this.teacher.set(null);
          this.error.set(this.profiles.errorMessage(error));
        },
      });
  }

  protected selectTab(tab: TeacherProfileTab): void {
    this.activeTab.set(tab);
  }

  protected tabCount(
    teacher: PublicTeacherProfileData,
    tab: TeacherProfileTab,
  ): number {
    switch (tab) {
      case 'credentials':
        return teacher.credentials.length + teacher.education.length;
      case 'gallery':
        return teacher.gallery.length;
      case 'demos':
        return teacher.demoClasses.length;
      case 'experience':
        return teacher.experience.length;
      case 'links':
        return teacher.socialLinks.length;
      case 'batches':
        return teacher.batches.length;
    }
  }

  protected profileImage(teacher: PublicTeacherProfileData): string {
    if (teacher.avatarUrl) {
      return this.profiles.resolveMediaUrl(teacher.avatarUrl);
    }
    return this.initialsImage(teacher.displayName, 320, 320);
  }

  protected coverImage(teacher: PublicTeacherProfileData): string {
    if (teacher.coverImageUrl) {
      return this.profiles.resolveMediaUrl(teacher.coverImageUrl);
    }
    return '';
  }

  protected formatStart(value: string | undefined): string {
    if (!value) {
      return 'Starts soon';
    }
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  }

  protected seatsLabel(batch: ProfileBatchAssociation): string {
    const capacity = batch.capacity ?? 0;
    const enrolled = batch.enrolledCount ?? 0;
    const seatsLeft = Math.max(0, capacity - enrolled);
    return seatsLeft === 1 ? '1 seat left' : `${seatsLeft} seats left`;
  }

  protected feeLabel(value: number | null | undefined): string {
    return formatBatchFee(value);
  }

  protected credentialLabel(item: ProfileCredential): string {
    return [item.issuer, item.year].filter(Boolean).join(' - ') || 'Credential';
  }

  protected publicContentUrl(item: TeacherPublicContentItem): string {
    return this.profiles.resolveMediaUrl(
      item.externalUrl || item.publicUrl || item.thumbnailUrl,
    );
  }

  protected contentIcon(item: TeacherPublicContentItem): string {
    switch (item.mediaType) {
      case 'video':
        return 'VID';
      case 'pdf':
        return 'PDF';
      case 'document':
        return 'DOC';
      case 'slides':
        return 'SLD';
      case 'link':
        return 'URL';
      default:
        return 'IMG';
    }
  }

  private initialsImage(name: string, width: number, height: number): string {
    const initials = this.initials(name).replace(/[&<>"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="20" fill="#e5eee7"/><text x="${width / 2}" y="${height / 2 + 30}" text-anchor="middle" font-family="Arial, sans-serif" font-size="84" font-weight="600" fill="#326c57">${initials}</text></svg>`;
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
