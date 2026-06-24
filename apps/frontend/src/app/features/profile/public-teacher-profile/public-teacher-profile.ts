import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ProfileBatchAssociation, ProfileCredential, PublicTeacherProfile as PublicTeacherProfileData } from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

type TeacherProfileTab = 'credentials' | 'experience' | 'links' | 'batches';

interface TeacherProfileTabItem {
  id: TeacherProfileTab;
  label: string;
}

const PROFILE_TABS: TeacherProfileTabItem[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'experience', label: 'Experience' },
  { id: 'links', label: 'Links' },
  { id: 'batches', label: 'Batches' }
];

@Component({
  selector: 'sfu-public-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './public-teacher-profile.html',
  styleUrl: './public-teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class PublicTeacherProfile implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly profiles = inject(ProfileService);
  private readonly paramMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  protected readonly teacherId = computed(() => this.paramMap().get('teacherId') ?? '');
  protected readonly teacher = signal<PublicTeacherProfileData | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly activeTab = signal<TeacherProfileTab>('batches');
  protected readonly tabs = PROFILE_TABS;
  protected readonly totalCapacity = computed(() => this.teacher()?.batches.reduce((total, batch) => total + (batch.capacity ?? 0), 0) ?? 0);
  protected readonly totalEnrolled = computed(() => this.teacher()?.batches.reduce((total, batch) => total + (batch.enrolledCount ?? 0), 0) ?? 0);

  ngOnInit(): void {
    this.loadTeacher();
  }

  protected loadTeacher(): void {
    const teacherId = this.teacherId();
    if (!teacherId) {
      this.error.set('Teacher profile is not available.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.profiles.getPublicTeacherProfile(teacherId).subscribe({
      next: (profile) => this.teacher.set(profile),
      error: (error) => {
        this.teacher.set(null);
        this.error.set(this.profiles.errorMessage(error));
      },
      complete: () => this.loading.set(false)
    });
  }

  protected selectTab(tab: TeacherProfileTab): void {
    this.activeTab.set(tab);
  }

  protected tabCount(teacher: PublicTeacherProfileData, tab: TeacherProfileTab): number {
    switch (tab) {
      case 'credentials':
        return teacher.credentials.length + teacher.education.length;
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
    const title = teacher.headline || 'Native SFU teacher';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="420" viewBox="0 0 1440 420" role="img" aria-label="${title} cover image"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#458B73"/><stop offset=".55" stop-color="#F26076"/><stop offset="1" stop-color="#FF9760"/></linearGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="1"/></pattern></defs><rect width="1440" height="420" fill="url(#bg)"/><rect width="1440" height="420" fill="url(#grid)"/><path d="M0 310 420 120l420 124 600-214v390H0z" fill="#fff" opacity=".14"/><text x="72" y="116" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800" fill="#fff">${title}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected seatsLabel(batch: ProfileBatchAssociation): string {
    const capacity = batch.capacity ?? 0;
    const enrolled = batch.enrolledCount ?? 0;
    const seatsLeft = Math.max(0, capacity - enrolled);
    return seatsLeft === 1 ? '1 seat left' : `${seatsLeft} seats left`;
  }

  protected credentialLabel(item: ProfileCredential): string {
    return [item.issuer, item.year].filter(Boolean).join(' - ') || 'Credential';
  }

  private initialsImage(name: string, width: number, height: number): string {
    const initials = this.initials(name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${name} profile image"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#458B73"/><stop offset="1" stop-color="#F26076"/></linearGradient></defs><rect width="${width}" height="${height}" rx="88" fill="url(#g)"/><text x="${width / 2}" y="${height / 2 + 30}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="800" fill="#fff">${initials}</text></svg>`;
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
