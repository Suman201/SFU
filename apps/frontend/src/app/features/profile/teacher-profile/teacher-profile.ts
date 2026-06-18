import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { TeacherDashboardStore, type TeacherBatch } from '../../teacher-dashboard/teacher-dashboard.store';

type TeacherProfileTab = 'gallery' | 'demo' | 'reviews' | 'awards' | 'batches';

interface ProfileMetric {
  label: string;
  value: string;
}

interface ProfileTab {
  id: TeacherProfileTab;
  label: string;
}

interface TeacherSelfProfile {
  id: string;
  name: string;
  title: string;
  specialization: string;
  bio: string;
  email: string;
  location: string;
  rating: string;
  studentsTaught: number;
  yearsExperience: number;
  officeHours: string;
  education: { degree: string; institution: string; year: string }[];
  experiences: { role: string; organization: string; period: string; summary: string }[];
  gallery: { id: string; title: string; caption: string }[];
  demoClasses: { id: string; title: string; duration: string; level: string; summary: string }[];
  reviews: { id: string; student: string; rating: string; comment: string }[];
  awards: { id: string; title: string; issuer: string; year: string }[];
}

interface TeacherVisualPalette {
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
}

const PROFILE_TABS: ProfileTab[] = [
  { id: 'gallery', label: 'Gallery' },
  { id: 'demo', label: 'Demo class' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'awards', label: 'Awards' },
  { id: 'batches', label: 'Batches' }
];

const PROFILE: TeacherSelfProfile = {
  id: 'teacher-host',
  name: 'Teacher Host',
  title: 'Realtime classroom host',
  specialization: 'Realtime WebRTC classrooms',
  bio: 'Teacher Host designs practical live classes for students learning SFU workflows, whiteboard collaboration, media controls, and production-ready classroom operations.',
  email: 'teacher@example.com',
  location: 'Kolkata, India',
  rating: '4.9',
  studentsTaught: 520,
  yearsExperience: 10,
  officeHours: 'Tuesday and Thursday, 18:00',
  education: [
    { degree: 'M.Tech in Distributed Systems', institution: 'Jadavpur University', year: '2016' },
    { degree: 'B.Tech in Computer Science', institution: 'Techno India University', year: '2014' }
  ],
  experiences: [
    {
      role: 'Lead Classroom Architect',
      organization: 'Native SFU Academy',
      period: '2022 - Present',
      summary: 'Owns the teaching workflow for live class sessions, whiteboard collaboration, and teacher controls.'
    },
    {
      role: 'Realtime Systems Mentor',
      organization: 'LiveStack Labs',
      period: '2017 - 2022',
      summary: 'Mentored cohorts on WebRTC publishing, subscription flow, SFU routing, and session reliability.'
    }
  ],
  gallery: [
    { id: 'host-gallery-whiteboard', title: 'Whiteboard critique', caption: 'Reviewing student diagrams during a live SFU session.' },
    { id: 'host-gallery-session', title: 'Live class cockpit', caption: 'Teacher controls, participants, and chat arranged for smooth hosting.' },
    { id: 'host-gallery-lab', title: 'Realtime lab', caption: 'Hands-on debugging of signaling and media state transitions.' }
  ],
  demoClasses: [
    {
      id: 'host-demo-classroom',
      title: 'Host a production-ready live class',
      duration: '38 min',
      level: 'Intermediate',
      summary: 'A walkthrough of starting a session, managing students, using the whiteboard, and keeping class flow stable.'
    }
  ],
  reviews: [
    {
      id: 'host-review-1',
      student: 'Aarav Sharma',
      rating: '5.0',
      comment: 'The classes are structured, practical, and easy to connect with real product work.'
    },
    {
      id: 'host-review-2',
      student: 'Mia Patel',
      rating: '4.9',
      comment: 'The teacher explains live class systems with clear examples and strong hands-on exercises.'
    }
  ],
  awards: [
    { id: 'host-award-1', title: 'Realtime Teaching Excellence', issuer: 'Native SFU Academy', year: '2025' },
    { id: 'host-award-2', title: 'Top WebRTC Classroom Mentor', issuer: 'Media Systems Circle', year: '2024' }
  ]
};

const VISUAL_PALETTE: TeacherVisualPalette = {
  primary: '#1d4ed8',
  secondary: '#0f766e',
  accent: '#f59e0b',
  ink: '#f8fafc'
};

@Component({
  selector: 'sfu-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-profile.html',
  styleUrl: './teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherProfile {
  private readonly dashboard = inject(TeacherDashboardStore);

  protected readonly profile = PROFILE;
  protected readonly tabs = PROFILE_TABS;
  protected readonly activeTab = signal<TeacherProfileTab>('batches');
  protected readonly batches = computed(() => this.dashboard.batches());
  protected readonly totalStudents = computed(() => this.batches().reduce((total, batch) => total + batch.students.length, 0));
  protected readonly totalSessions = computed(() => this.batches().reduce((total, batch) => total + batch.sessions.length, 0));
  protected readonly metrics = computed<ProfileMetric[]>(() => [
    { label: 'Hosted batches', value: `${this.batches().length}` },
    { label: 'Sessions planned', value: `${this.totalSessions()}` },
    { label: 'Active students', value: `${this.totalStudents()}` },
    { label: 'Public rating', value: this.profile.rating }
  ]);

  protected selectTab(tab: TeacherProfileTab): void {
    this.activeTab.set(tab);
  }

  protected tabCount(tab: TeacherProfileTab): number {
    switch (tab) {
      case 'gallery':
        return this.profile.gallery.length;
      case 'demo':
        return this.profile.demoClasses.length;
      case 'reviews':
        return this.profile.reviews.length;
      case 'awards':
        return this.profile.awards.length;
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

  protected profileImage(): string {
    const initials = this.initials(this.profile.name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="${this.profile.name} profile image"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${VISUAL_PALETTE.primary}"/><stop offset="1" stop-color="${VISUAL_PALETTE.secondary}"/></linearGradient></defs><rect width="320" height="320" rx="88" fill="url(#g)"/><path d="M34 230 288 84v204H34z" fill="${VISUAL_PALETTE.accent}" opacity=".22"/><path d="M58 58h204v204H58z" fill="none" stroke="${VISUAL_PALETTE.ink}" stroke-opacity=".25" stroke-width="2"/><text x="160" y="178" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="800" fill="${VISUAL_PALETTE.ink}">${initials}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  protected coverImage(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="420" viewBox="0 0 1440 420" role="img" aria-label="${this.profile.name} cover image"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${VISUAL_PALETTE.primary}"/><stop offset=".6" stop-color="${VISUAL_PALETTE.secondary}"/><stop offset="1" stop-color="${VISUAL_PALETTE.accent}"/></linearGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="${VISUAL_PALETTE.ink}" stroke-opacity=".1" stroke-width="1"/></pattern></defs><rect width="1440" height="420" fill="url(#bg)"/><rect width="1440" height="420" fill="url(#grid)"/><path d="M0 306 386 146l454 98 600-208v384H0z" fill="${VISUAL_PALETTE.ink}" opacity=".12"/><path d="M858 58h426v128H858z" fill="${VISUAL_PALETTE.ink}" opacity=".1"/><path d="M980 224h280v72H980z" fill="${VISUAL_PALETTE.ink}" opacity=".12"/><text x="72" y="116" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="800" fill="${VISUAL_PALETTE.ink}" opacity=".92">${this.profile.specialization}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  protected nextSessionLabel(batch: TeacherBatch): string {
    const session = this.dashboard.nextSession(batch);
    return session ? this.formatDate(session.scheduledAt) : 'No upcoming session';
  }

  protected attendanceLabel(batch: TeacherBatch): string {
    const attendance = this.dashboard.averageAttendance(batch);
    return attendance === null ? 'No attendance yet' : `${attendance}% avg attendance`;
  }

  protected batchFillLabel(batch: TeacherBatch): string {
    return `${batch.students.length}/${batch.capacity} students`;
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }
}
