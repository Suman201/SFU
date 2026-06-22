import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { API_BASE_URL } from '../../core/services/app-environment';

export interface StudentBatch {
  id: string;
  title: string;
  subject: string;
  teacherId: string;
  teacherName: string;
  teacherTitle: string;
  schedule: string;
  durationMinutes: number;
  totalWeeks: number;
  enrolledCount: number;
  capacity: number;
  startsAt: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
}

export interface TeacherEducation {
  degree: string;
  institution: string;
  year: string;
}

export interface TeacherExperience {
  role: string;
  organization: string;
  period: string;
  summary: string;
}

export interface TeacherGalleryItem {
  id: string;
  title: string;
  caption: string;
}

export interface TeacherDemoClass {
  id: string;
  title: string;
  duration: string;
  level: string;
  summary: string;
}

export interface TeacherReview {
  id: string;
  student: string;
  rating: string;
  comment: string;
}

export interface TeacherAward {
  id: string;
  title: string;
  issuer: string;
  year: string;
}

export interface PublicTeacherProfile {
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
  education: TeacherEducation[];
  experiences: TeacherExperience[];
  gallery: TeacherGalleryItem[];
  demoClasses: TeacherDemoClass[];
  reviews: TeacherReview[];
  awards: TeacherAward[];
}

interface StudentEnrollmentState {
  enrolledBatchIds: string[];
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
}

const STORAGE_KEY = 'native-sfu-student-enrollments';

const BATCH_CATALOG: StudentBatch[] = [
  {
    id: 'batch-webrtc-foundation',
    title: 'WebRTC Foundations',
    subject: 'Native SFU architecture',
    teacherId: 'ananya-sen',
    teacherName: 'Ananya Sen',
    teacherTitle: 'Realtime systems mentor',
    schedule: 'Mondays at 18:00',
    durationMinutes: 60,
    totalWeeks: 8,
    enrolledCount: 18,
    capacity: 28,
    startsAt: '2026-06-22T18:00:00.000Z',
    level: 'Beginner'
  },
  {
    id: 'batch-media-routing',
    title: 'Media Routing Lab',
    subject: 'RTP, simulcast, and packet flow',
    teacherId: 'rahul-mehta',
    teacherName: 'Rahul Mehta',
    teacherTitle: 'SFU protocol instructor',
    schedule: 'Wednesdays at 19:30',
    durationMinutes: 75,
    totalWeeks: 10,
    enrolledCount: 14,
    capacity: 24,
    startsAt: '2026-06-24T19:30:00.000Z',
    level: 'Intermediate'
  },
  {
    id: 'batch-angular-classroom',
    title: 'Angular Classroom UI',
    subject: 'Realtime class experience design',
    teacherId: 'mira-kapoor',
    teacherName: 'Mira Kapoor',
    teacherTitle: 'Frontend systems coach',
    schedule: 'Fridays at 17:00',
    durationMinutes: 60,
    totalWeeks: 6,
    enrolledCount: 21,
    capacity: 32,
    startsAt: '2026-06-26T17:00:00.000Z',
    level: 'Intermediate'
  },
  {
    id: 'batch-scaling-sfu',
    title: 'Scaling SFU Clusters',
    subject: 'Workers, piping, and observability',
    teacherId: 'dev-arora',
    teacherName: 'Dev Arora',
    teacherTitle: 'Distributed media engineer',
    schedule: 'Saturdays at 11:00',
    durationMinutes: 90,
    totalWeeks: 12,
    enrolledCount: 16,
    capacity: 20,
    startsAt: '2026-06-27T11:00:00.000Z',
    level: 'Advanced'
  }
];

const TEACHER_PROFILES: PublicTeacherProfile[] = [
  {
    id: 'ananya-sen',
    name: 'Ananya Sen',
    title: 'Realtime systems mentor',
    specialization: 'Native WebRTC SFU architecture',
    bio: 'Ananya helps students build a practical foundation in realtime media systems, from signaling flow to browser-native publishing and subscription patterns.',
    email: 'ananya.sen@example.com',
    location: 'Kolkata, India',
    rating: '4.9',
    studentsTaught: 420,
    yearsExperience: 9,
    officeHours: 'Tuesday and Thursday, 18:00',
    education: [
      { degree: 'M.Tech in Distributed Systems', institution: 'Jadavpur University', year: '2016' },
      { degree: 'B.Tech in Computer Science', institution: 'Techno India University', year: '2014' }
    ],
    experiences: [
      {
        role: 'Senior Realtime Engineer',
        organization: 'LiveStack Labs',
        period: '2021 - Present',
        summary: 'Designed WebRTC classroom flows, browser publishing paths, and live media observability.'
      },
      {
        role: 'Platform Mentor',
        organization: 'Native SFU Academy',
        period: '2018 - 2021',
        summary: 'Coached engineering cohorts on signaling, transport setup, and SFU session lifecycle.'
      }
    ],
    gallery: [
      { id: 'ananya-workshop', title: 'SFU workshop board', caption: 'Packet flow mapping with a beginner cohort.' },
      { id: 'ananya-lab', title: 'Realtime lab review', caption: 'Student debugging session on stream publish paths.' },
      { id: 'ananya-studio', title: 'Teaching studio', caption: 'Live whiteboard walkthrough for media negotiation.' }
    ],
    demoClasses: [
      {
        id: 'ananya-demo-signaling',
        title: 'Build a WebRTC join flow',
        duration: '32 min',
        level: 'Beginner',
        summary: 'A practical walkthrough of room join, offer/answer exchange, and first media publish.'
      }
    ],
    reviews: [
      {
        id: 'ananya-review-1',
        student: 'Ishaan Roy',
        rating: '5.0',
        comment: 'Clear explanations and diagrams made SFU signaling finally click.'
      },
      {
        id: 'ananya-review-2',
        student: 'Priya Nair',
        rating: '4.9',
        comment: 'The class moved fast, but every lab felt grounded in production behavior.'
      }
    ],
    awards: [
      { id: 'ananya-award-1', title: 'Realtime Education Excellence', issuer: 'WebRTC India Forum', year: '2025' },
      { id: 'ananya-award-2', title: 'Top Mentor in Media Systems', issuer: 'Native SFU Academy', year: '2024' }
    ]
  },
  {
    id: 'rahul-mehta',
    name: 'Rahul Mehta',
    title: 'SFU protocol instructor',
    specialization: 'RTP, simulcast, and packet flow',
    bio: 'Rahul focuses on media routing internals, debugging packet paths, and helping students reason about SFU behavior under real network pressure.',
    email: 'rahul.mehta@example.com',
    location: 'Bengaluru, India',
    rating: '4.8',
    studentsTaught: 360,
    yearsExperience: 11,
    officeHours: 'Wednesday, 20:30',
    education: [
      { degree: 'M.S. in Network Engineering', institution: 'IIIT Bangalore', year: '2013' },
      { degree: 'B.E. in Electronics', institution: 'Mumbai University', year: '2011' }
    ],
    experiences: [
      {
        role: 'Media Protocol Architect',
        organization: 'PacketWorks',
        period: '2020 - Present',
        summary: 'Built RTP routing, simulcast adaptation, and packet inspection tooling for live products.'
      },
      {
        role: 'Video Infrastructure Engineer',
        organization: 'MeetGrid',
        period: '2015 - 2020',
        summary: 'Owned SFU transport debugging and quality tuning for multi-party sessions.'
      }
    ],
    gallery: [
      { id: 'rahul-routing', title: 'Routing topology', caption: 'Simulcast layer planning for classroom video.' },
      { id: 'rahul-packet', title: 'Packet trace lab', caption: 'Hands-on RTP header inspection exercise.' },
      { id: 'rahul-quality', title: 'Quality clinic', caption: 'Student review of bandwidth estimation behavior.' }
    ],
    demoClasses: [
      {
        id: 'rahul-demo-rtp',
        title: 'Reading RTP like a debugger',
        duration: '41 min',
        level: 'Intermediate',
        summary: 'A guided packet trace that connects RTP headers, SSRCs, and media quality decisions.'
      }
    ],
    reviews: [
      {
        id: 'rahul-review-1',
        student: 'Arjun Sethi',
        rating: '4.8',
        comment: 'Rahul makes low-level packet behavior feel approachable and testable.'
      },
      {
        id: 'rahul-review-2',
        student: 'Maya Fernandes',
        rating: '4.9',
        comment: 'The labs helped me debug media routes without guessing.'
      }
    ],
    awards: [
      { id: 'rahul-award-1', title: 'Protocol Mentor of the Year', issuer: 'Realtime Stack Guild', year: '2025' },
      { id: 'rahul-award-2', title: 'Applied RTP Teaching Award', issuer: 'Media Systems Circle', year: '2023' }
    ]
  },
  {
    id: 'mira-kapoor',
    name: 'Mira Kapoor',
    title: 'Frontend systems coach',
    specialization: 'Realtime classroom UI design',
    bio: 'Mira teaches students how to build polished realtime classroom interfaces with resilient state, accessible controls, and production-grade interaction patterns.',
    email: 'mira.kapoor@example.com',
    location: 'Pune, India',
    rating: '4.9',
    studentsTaught: 510,
    yearsExperience: 8,
    officeHours: 'Friday, 18:30',
    education: [
      { degree: 'M.Des in Interaction Design', institution: 'IDC School of Design', year: '2017' },
      { degree: 'B.Tech in Information Technology', institution: 'Pune University', year: '2013' }
    ],
    experiences: [
      {
        role: 'Principal Frontend Engineer',
        organization: 'ClassroomOS',
        period: '2022 - Present',
        summary: 'Leads Angular classroom UI, whiteboard interaction, chat, and live session controls.'
      },
      {
        role: 'Design Systems Engineer',
        organization: 'Northstar EdTech',
        period: '2017 - 2022',
        summary: 'Built accessible realtime learning surfaces and component systems for teachers.'
      }
    ],
    gallery: [
      { id: 'mira-dashboard', title: 'Class dashboard teardown', caption: 'Reviewing session state and participant control patterns.' },
      { id: 'mira-whiteboard', title: 'Whiteboard UX lab', caption: 'Design critique for premium collaboration controls.' },
      { id: 'mira-components', title: 'Component audit', caption: 'Student work review for resilient Angular UI.' }
    ],
    demoClasses: [
      {
        id: 'mira-demo-session-ui',
        title: 'Design a teacher session shell',
        duration: '36 min',
        level: 'Intermediate',
        summary: 'A practical lesson on layout, dark mode, chat docking, and participant control ergonomics.'
      }
    ],
    reviews: [
      {
        id: 'mira-review-1',
        student: 'Kabir Shah',
        rating: '5.0',
        comment: 'Her UI feedback is precise, practical, and immediately improves the product.'
      },
      {
        id: 'mira-review-2',
        student: 'Naina Dutta',
        rating: '4.9',
        comment: 'The sessions helped me think like a product engineer, not just a component author.'
      }
    ],
    awards: [
      { id: 'mira-award-1', title: 'Best Classroom UX Mentor', issuer: 'EdTech Design Council', year: '2025' },
      { id: 'mira-award-2', title: 'Frontend Teaching Fellow', issuer: 'Angular India Collective', year: '2024' }
    ]
  },
  {
    id: 'dev-arora',
    name: 'Dev Arora',
    title: 'Distributed media engineer',
    specialization: 'SFU clustering and observability',
    bio: 'Dev guides advanced students through scaling SFU clusters, worker orchestration, media piping, and operational visibility for live systems.',
    email: 'dev.arora@example.com',
    location: 'Hyderabad, India',
    rating: '4.7',
    studentsTaught: 290,
    yearsExperience: 12,
    officeHours: 'Saturday, 12:30',
    education: [
      { degree: 'M.Tech in Cloud Computing', institution: 'BITS Pilani', year: '2012' },
      { degree: 'B.Tech in Computer Engineering', institution: 'Osmania University', year: '2010' }
    ],
    experiences: [
      {
        role: 'Staff Distributed Systems Engineer',
        organization: 'StreamMesh',
        period: '2019 - Present',
        summary: 'Architected SFU worker pools, media piping, autoscaling, and observability for live classrooms.'
      },
      {
        role: 'Infrastructure Lead',
        organization: 'SignalPlane',
        period: '2014 - 2019',
        summary: 'Managed low-latency media infrastructure, tracing, and incident response practices.'
      }
    ],
    gallery: [
      { id: 'dev-cluster', title: 'Cluster planning wall', caption: 'Worker topology and regional failover planning.' },
      { id: 'dev-observe', title: 'Observability review', caption: 'Reading SFU metrics for session health.' },
      { id: 'dev-scale', title: 'Scaling lab', caption: 'Student simulation for worker pressure and piping.' }
    ],
    demoClasses: [
      {
        id: 'dev-demo-clusters',
        title: 'Scale a live SFU room',
        duration: '45 min',
        level: 'Advanced',
        summary: 'A focused demo on worker selection, piping decisions, and monitoring during a live spike.'
      }
    ],
    reviews: [
      {
        id: 'dev-review-1',
        student: 'Rohan Iyer',
        rating: '4.8',
        comment: 'Dev connects architecture choices to real failure modes in a very clear way.'
      },
      {
        id: 'dev-review-2',
        student: 'Sara Khan',
        rating: '4.7',
        comment: 'The observability sessions were dense, but incredibly useful for production work.'
      }
    ],
    awards: [
      { id: 'dev-award-1', title: 'Distributed Media Systems Award', issuer: 'Cloud Realtime Summit', year: '2025' },
      { id: 'dev-award-2', title: 'Operational Excellence Mentor', issuer: 'SFU Builders Network', year: '2024' }
    ]
  }
];

@Injectable({ providedIn: 'root' })
export class StudentEnrollmentStore {
  private readonly http = inject(HttpClient);
  private readonly state = signal<StudentEnrollmentState>(this.loadState());
  private readonly remoteAvailableBatches = signal<StudentBatch[] | null>(null);
  private readonly remoteEnrolledBatches = signal<StudentBatch[] | null>(null);
  private readonly loadingEnrolledBatchesSignal = signal(false);
  private readonly enrollmentActionBatchIdSignal = signal<string | null>(null);
  private readonly enrollmentErrorSignal = signal('');

  readonly loadingEnrolledBatches = this.loadingEnrolledBatchesSignal.asReadonly();
  readonly enrollmentActionBatchId = this.enrollmentActionBatchIdSignal.asReadonly();
  readonly enrollmentError = this.enrollmentErrorSignal.asReadonly();
  readonly batches = computed(() => [...(this.remoteAvailableBatches() ?? BATCH_CATALOG)].sort((left, right) => this.startTime(left) - this.startTime(right)));
  readonly teachers = computed(() => [...TEACHER_PROFILES].sort((left, right) => left.name.localeCompare(right.name)));
  readonly enrolledBatchIds = computed(() => new Set(this.remoteEnrolledBatches()?.map((batch) => batch.id) ?? this.state().enrolledBatchIds));
  readonly enrolledBatches = computed(() => this.remoteEnrolledBatches() ?? this.batches().filter((batch) => this.enrolledBatchIds().has(batch.id)));
  readonly availableBatches = computed(() => this.batches().filter((batch) => !this.enrolledBatchIds().has(batch.id)));

  constructor() {
    effect(() => this.persistState(this.state()));
  }

  enroll(batchId: string): void {
    if (this.enrollmentActionBatchIdSignal()) {
      return;
    }

    if (!this.batches().some((batch) => batch.id === batchId) || this.isEnrolled(batchId)) {
      return;
    }

    this.enrollmentActionBatchIdSignal.set(batchId);
    this.enrollmentErrorSignal.set('');
    this.http.post<StudentBatch | ApiEnvelope<StudentBatch>>(`${API_BASE_URL}/student-enrollments/me/batches/${encodeURIComponent(batchId)}`, {}).subscribe({
      next: (response) => {
        const batch = this.normalizeRemoteBatch(this.unwrapResponse(response));
        this.remoteEnrolledBatches.update((batches) => this.upsertBatch(batches ?? [], batch));
        this.state.update(() => ({ enrolledBatchIds: this.enrolledBatchIdsFromRemote() }));
        this.loadAvailableBatches();
        this.loadEnrolledBatches();
      },
      error: (error) => {
        this.enrollmentErrorSignal.set(this.errorMessage(error));
        this.enrollmentActionBatchIdSignal.set(null);
      },
      complete: () => this.enrollmentActionBatchIdSignal.set(null)
    });
  }

  loadAvailableBatches(): void {
    this.http.get<StudentBatch[] | ApiEnvelope<StudentBatch[]>>(`${API_BASE_URL}/student-enrollments/batches`).subscribe({
      next: (response) => {
        this.remoteAvailableBatches.set(this.unwrapResponse(response).map((batch) => this.normalizeRemoteBatch(batch)));
      },
      error: () => {
        this.remoteAvailableBatches.set(null);
      }
    });
  }

  loadEnrolledBatches(): void {
    this.loadingEnrolledBatchesSignal.set(true);
    this.http.get<StudentBatch[] | ApiEnvelope<StudentBatch[]>>(`${API_BASE_URL}/student-enrollments/me/batches`).subscribe({
      next: (response) => {
        const batches = this.unwrapResponse(response).map((batch) => this.normalizeRemoteBatch(batch));
        this.remoteEnrolledBatches.set(batches);
        this.state.update(() => ({ enrolledBatchIds: batches.map((batch) => batch.id) }));
      },
      error: () => {
        this.remoteEnrolledBatches.set(null);
        this.loadingEnrolledBatchesSignal.set(false);
      },
      complete: () => this.loadingEnrolledBatchesSignal.set(false)
    });
  }

  leave(batchId: string): void {
    if (this.enrollmentActionBatchIdSignal()) {
      return;
    }

    this.enrollmentActionBatchIdSignal.set(batchId);
    this.enrollmentErrorSignal.set('');
    this.http.delete<Record<string, unknown> | ApiEnvelope<Record<string, unknown>>>(`${API_BASE_URL}/student-enrollments/me/batches/${encodeURIComponent(batchId)}`).subscribe({
      next: () => {
        this.remoteEnrolledBatches.update((batches) => (batches ?? this.enrolledBatches()).filter((batch) => batch.id !== batchId));
        this.state.update(() => ({ enrolledBatchIds: this.enrolledBatchIdsFromRemote() }));
        this.loadAvailableBatches();
        this.loadEnrolledBatches();
      },
      error: (error) => {
        this.enrollmentErrorSignal.set(this.errorMessage(error));
        this.enrollmentActionBatchIdSignal.set(null);
      },
      complete: () => this.enrollmentActionBatchIdSignal.set(null)
    });
  }

  isEnrolled(batchId: string): boolean {
    return this.enrolledBatchIds().has(batchId);
  }

  enrollmentCount(batch: StudentBatch): number {
    const remoteIsAuthoritative = this.remoteAvailableBatches() !== null || this.remoteEnrolledBatches() !== null;
    return Math.min(batch.capacity, batch.enrolledCount + (!remoteIsAuthoritative && this.isEnrolled(batch.id) ? 1 : 0));
  }

  seatsLeft(batch: StudentBatch): number {
    return Math.max(0, batch.capacity - this.enrollmentCount(batch));
  }

  teacherById(teacherId: string): PublicTeacherProfile | null {
    return TEACHER_PROFILES.find((teacher) => teacher.id === teacherId) ?? null;
  }

  batchesByTeacher(teacherId: string): StudentBatch[] {
    return this.batches().filter((batch) => batch.teacherId === teacherId);
  }

  private startTime(batch: StudentBatch): number {
    return new Date(batch.startsAt).getTime();
  }

  private unwrapResponse<T>(response: T | ApiEnvelope<T>): T {
    if (response && typeof response === 'object' && 'data' in response) {
      const data = (response as ApiEnvelope<T>).data;
      if (data !== undefined && data !== null) {
        return data;
      }
    }
    return response as T;
  }

  private normalizeRemoteBatch(batch: StudentBatch): StudentBatch {
    return {
      ...batch,
      level: batch.level ?? 'Intermediate',
      teacherTitle: batch.teacherTitle ?? 'Class instructor',
      schedule: batch.schedule ?? 'Schedule to be announced'
    };
  }

  private upsertBatch(batches: StudentBatch[], batch: StudentBatch): StudentBatch[] {
    return [batch, ...batches.filter((item) => item.id !== batch.id)];
  }

  private enrolledBatchIdsFromRemote(): string[] {
    return this.remoteEnrolledBatches()?.map((batch) => batch.id) ?? this.state().enrolledBatchIds;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const backendMessage = this.backendMessage(error.error);
      if (backendMessage) return backendMessage;
      if (error.status === 0) return 'Unable to reach the server. Please check your connection and try again.';
      if (error.status === 401) return 'Please sign in with a student account to enroll.';
      if (error.status === 403) return 'Only student accounts can manage batch enrollments.';
      if (error.status === 404) return 'This batch is no longer available.';
      if (error.status === 409) return 'This batch is full or you are already enrolled.';
    }
    return 'Unable to update enrollment right now. Please try again.';
  }

  private backendMessage(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    const body = error as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    if (Array.isArray(body.error)) return body.error.map((item) => this.backendMessage(item) || String(item)).filter(Boolean).join(' ');
    return '';
  }

  private loadState(): StudentEnrollmentState {
    try {
      const storedState = localStorage.getItem(STORAGE_KEY);
      if (!storedState) {
        return { enrolledBatchIds: [] };
      }

      const parsed = JSON.parse(storedState) as StudentEnrollmentState;
      return Array.isArray(parsed.enrolledBatchIds) ? parsed : { enrolledBatchIds: [] };
    } catch {
      return { enrolledBatchIds: [] };
    }
  }

  private persistState(state: StudentEnrollmentState): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The student pages remain usable in memory if storage is unavailable.
    }
  }
}
