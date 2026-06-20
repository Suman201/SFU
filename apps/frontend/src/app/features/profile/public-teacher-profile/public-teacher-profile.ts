import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { StudentEnrollmentStore, type PublicTeacherProfile as TeacherProfile, type StudentBatch } from '../../student/student-enrollment.store';

type TeacherProfileTab = 'gallery' | 'demo' | 'reviews' | 'awards' | 'batches';

interface TeacherProfileTabItem {
  id: TeacherProfileTab;
  label: string;
}

interface TeacherVisualPalette {
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
}

const PROFILE_TABS: TeacherProfileTabItem[] = [
  { id: 'gallery', label: 'Gallery' },
  { id: 'demo', label: 'Demo class' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'awards', label: 'Awards' },
  { id: 'batches', label: 'Batches' }
];

const DEFAULT_VISUAL_PALETTE: TeacherVisualPalette = { primary: '#061b44', secondary: '#0f5bf1', accent: '#14924f', ink: '#eff6ff' };

const VISUAL_PALETTES: Record<string, TeacherVisualPalette> = {
  'ananya-sen': DEFAULT_VISUAL_PALETTE,
  'rahul-mehta': { primary: '#08295f', secondary: '#14924f', accent: '#17b8d5', ink: '#f8fbff' },
  'mira-kapoor': { primary: '#0f5bf1', secondary: '#061b44', accent: '#ffbf30', ink: '#f8fbff' },
  'dev-arora': { primary: '#061b44', secondary: '#087a43', accent: '#ff8f2c', ink: '#f8fafc' }
};

@Component({
  selector: 'sfu-public-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './public-teacher-profile.html',
  styleUrl: './public-teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class PublicTeacherProfile {
  private readonly route = inject(ActivatedRoute);
  protected readonly enrollment = inject(StudentEnrollmentStore);

  private readonly paramMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected readonly teacherId = computed(() => this.paramMap().get('teacherId') ?? '');
  protected readonly teacher = computed(() => this.enrollment.teacherById(this.teacherId()));
  protected readonly batches = computed(() => this.enrollment.batchesByTeacher(this.teacherId()));
  protected readonly totalCapacity = computed(() => this.batches().reduce((total, batch) => total + batch.capacity, 0));
  protected readonly totalEnrolled = computed(() => this.batches().reduce((total, batch) => total + this.enrollment.enrollmentCount(batch), 0));
  protected readonly activeTab = signal<TeacherProfileTab>('batches');
  protected readonly tabs = PROFILE_TABS;

  protected selectTab(tab: TeacherProfileTab): void {
    this.activeTab.set(tab);
  }

  protected tabCount(teacher: TeacherProfile, tab: TeacherProfileTab): number {
    switch (tab) {
      case 'gallery':
        return teacher.gallery.length;
      case 'demo':
        return teacher.demoClasses.length;
      case 'reviews':
        return teacher.reviews.length;
      case 'awards':
        return teacher.awards.length;
      case 'batches':
        return this.batches().length;
    }
  }

  protected initials(name: string): string {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected seatsLabel(batch: StudentBatch): string {
    const seatsLeft = this.enrollment.seatsLeft(batch);
    return seatsLeft === 1 ? '1 seat left' : `${seatsLeft} seats left`;
  }

  protected isEnrolled(batch: StudentBatch): boolean {
    return this.enrollment.isEnrolled(batch.id);
  }

  protected enroll(batch: StudentBatch): void {
    this.enrollment.enroll(batch.id);
  }

  protected profileImage(teacher: TeacherProfile): string {
    const palette = this.palette(teacher.id);
    const initials = this.initials(teacher.name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="${teacher.name} profile image"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${palette.primary}"/><stop offset="1" stop-color="${palette.secondary}"/></linearGradient></defs><rect width="320" height="320" rx="88" fill="url(#g)"/><path d="M32 228 288 84v204H32z" fill="${palette.accent}" opacity=".2"/><path d="M58 58h204v204H58z" fill="none" stroke="${palette.ink}" stroke-opacity=".25" stroke-width="2"/><text x="160" y="178" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="800" fill="${palette.ink}">${initials}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  protected coverImage(teacher: TeacherProfile): string {
    const palette = this.palette(teacher.id);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="420" viewBox="0 0 1440 420" role="img" aria-label="${teacher.name} cover image"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${palette.primary}"/><stop offset=".58" stop-color="${palette.secondary}"/><stop offset="1" stop-color="${palette.accent}"/></linearGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="${palette.ink}" stroke-opacity=".1" stroke-width="1"/></pattern></defs><rect width="1440" height="420" fill="url(#bg)"/><rect width="1440" height="420" fill="url(#grid)"/><path d="M0 310 420 120l420 124 600-214v390H0z" fill="${palette.ink}" opacity=".12"/><path d="M860 58h424v128H860z" fill="${palette.ink}" opacity=".1"/><path d="M980 224h280v72H980z" fill="${palette.ink}" opacity=".12"/><text x="72" y="116" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="800" fill="${palette.ink}" opacity=".92">${teacher.specialization}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  protected formatStart(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  private palette(teacherId: string): TeacherVisualPalette {
    return VISUAL_PALETTES[teacherId] ?? DEFAULT_VISUAL_PALETTE;
  }
}
