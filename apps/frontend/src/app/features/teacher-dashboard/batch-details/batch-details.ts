import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form as signalForm, maxLength, required } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AnalyticsVisibility,
  BatchLiveClassSettingsResponse,
  LiveClassSettings,
  LiveClassSettingsPatch,
  RecordingVisibility,
  ScreenShareQualityLimit,
  StudentVideoQualityLimit
} from '@native-sfu/contracts';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import {
  TeacherDashboardStore,
  type TeacherBatch,
  type TeacherBatchSchedule,
  type TeacherBatchStudent,
  type TeacherBatchStudentStatus,
  type TeacherSession,
  type TeacherSessionStatus
} from '../teacher-dashboard.store';

interface WeekdayOption {
  value: number;
  label: string;
}

interface MessageFormModel {
  message: string;
}

interface LiveSettingsForm {
  studentsJoinMuted: boolean;
  studentsJoinCameraOff: boolean;
  requirePrejoinDeviceCheck: boolean;
  allowStudentsToUnmuteSelf: boolean;
  allowStudentsToStartCameraSelf: boolean;
  privateTeacherStudentChatEnabled: boolean;
  teacherBroadcastEnabled: boolean;
  chatAttachmentsEnabled: boolean;
  messageLengthLimit: number;
  whiteboardSharingEnabled: boolean;
  studentWhiteboardControlEnabled: boolean;
  maxActiveWhiteboardControllers: number;
  handRaiseEnabled: boolean;
  maxActiveSpeakers: number;
  recordingEnabled: boolean;
  autoRecordOnStart: boolean;
  teacherManualRecordingControlEnabled: boolean;
  recordingVisibility: RecordingVisibility;
  presentThresholdMinutes: number;
  presentThresholdPercentage: number;
  lateJoinThresholdMinutes: number;
  teacherAttendanceExportEnabled: boolean;
  waitingRoomEnabled: boolean;
  lockClassAfterTeacherStarts: boolean;
  allowEnrolledStudentReconnectAfterLock: boolean;
  teacherReconnectGraceMessagingEnabled: boolean;
  materialsEnabled: boolean;
  teacherCanUploadMaterials: boolean;
  studentsCanDownloadMaterials: boolean;
  publishMaterialsBeforeClass: boolean;
  publishMaterialsAfterClass: boolean;
  allowedMaterialTypesText: string;
  maxMaterialFileSizeMb: number;
  classReminderEnabled: boolean;
  classReminderMinutesBefore: number;
  notifyWhenTeacherStarts: boolean;
  notifyRecordingAvailable: boolean;
  notifyNewMaterialUploaded: boolean;
  notifyMissedClass: boolean;
  questionQueueEnabled: boolean;
  allowAnonymousQuestions: boolean;
  allowStudentUpvotes: boolean;
  teacherCanMarkAnswered: boolean;
  maxOpenQuestionsPerStudent: number;
  recordingRetentionDays: number;
  allowTeacherPublishRecording: boolean;
  allowStudentsDownloadRecording: boolean;
  autoArchiveExpiredRecordings: boolean;
  studentScreenShareEnabled: boolean;
  studentScreenShareRequiresApproval: boolean;
  maxActiveStudentShares: number;
  analyticsEnabled: boolean;
  trackEngagementEvents: boolean;
  trackMediaQuality: boolean;
  trackChatParticipation: boolean;
  trackWhiteboardParticipation: boolean;
  trackQuestionParticipation: boolean;
  analyticsVisibility: AnalyticsVisibility;
  inactiveDetectionEnabled: boolean;
  inactiveAfterMinutes: number;
  countBackgroundTabAsInactive: boolean;
  countMutedNoCameraAsInactive: boolean;
  notifyTeacherOnInactiveStudents: boolean;
  includeInactiveTimeInAttendance: boolean;
  adaptiveQualityEnabled: boolean;
  lowBandwidthModeEnabled: boolean;
  maxStudentVideoQuality: StudentVideoQualityLimit;
  maxScreenShareQuality: ScreenShareQualityLimit;
  disableStudentVideoOnPoorNetwork: boolean;
  preferAudioOnPoorNetwork: boolean;
  showNetworkWarnings: boolean;
  exportControlsEnabled: boolean;
  allowAttendanceExport: boolean;
  allowChatExport: boolean;
  allowQuestionExport: boolean;
  allowRecordingDownload: boolean;
  includePrivateChatInExports: boolean;
  anonymizeStudentExports: boolean;
  exportRetentionDays: number;
  requireExportAuditLog: boolean;
}

const EMPTY_LIVE_SETTINGS_FORM: LiveSettingsForm = {
  studentsJoinMuted: true,
  studentsJoinCameraOff: true,
  requirePrejoinDeviceCheck: true,
  allowStudentsToUnmuteSelf: true,
  allowStudentsToStartCameraSelf: true,
  privateTeacherStudentChatEnabled: true,
  teacherBroadcastEnabled: true,
  chatAttachmentsEnabled: true,
  messageLengthLimit: 2000,
  whiteboardSharingEnabled: true,
  studentWhiteboardControlEnabled: true,
  maxActiveWhiteboardControllers: 1,
  handRaiseEnabled: true,
  maxActiveSpeakers: 3,
  recordingEnabled: true,
  autoRecordOnStart: false,
  teacherManualRecordingControlEnabled: true,
  recordingVisibility: 'enrolled_students',
  presentThresholdMinutes: 10,
  presentThresholdPercentage: 50,
  lateJoinThresholdMinutes: 10,
  teacherAttendanceExportEnabled: true,
  waitingRoomEnabled: false,
  lockClassAfterTeacherStarts: false,
  allowEnrolledStudentReconnectAfterLock: true,
  teacherReconnectGraceMessagingEnabled: true,
  materialsEnabled: true,
  teacherCanUploadMaterials: true,
  studentsCanDownloadMaterials: true,
  publishMaterialsBeforeClass: false,
  publishMaterialsAfterClass: true,
  allowedMaterialTypesText: 'pdf, image, document, slides, link, file',
  maxMaterialFileSizeMb: 10,
  classReminderEnabled: true,
  classReminderMinutesBefore: 30,
  notifyWhenTeacherStarts: true,
  notifyRecordingAvailable: true,
  notifyNewMaterialUploaded: true,
  notifyMissedClass: false,
  questionQueueEnabled: true,
  allowAnonymousQuestions: false,
  allowStudentUpvotes: true,
  teacherCanMarkAnswered: true,
  maxOpenQuestionsPerStudent: 3,
  recordingRetentionDays: 30,
  allowTeacherPublishRecording: false,
  allowStudentsDownloadRecording: true,
  autoArchiveExpiredRecordings: true,
  studentScreenShareEnabled: false,
  studentScreenShareRequiresApproval: true,
  maxActiveStudentShares: 1,
  analyticsEnabled: true,
  trackEngagementEvents: true,
  trackMediaQuality: true,
  trackChatParticipation: true,
  trackWhiteboardParticipation: true,
  trackQuestionParticipation: true,
  analyticsVisibility: 'admin_and_teacher',
  inactiveDetectionEnabled: false,
  inactiveAfterMinutes: 10,
  countBackgroundTabAsInactive: true,
  countMutedNoCameraAsInactive: false,
  notifyTeacherOnInactiveStudents: true,
  includeInactiveTimeInAttendance: false,
  adaptiveQualityEnabled: true,
  lowBandwidthModeEnabled: false,
  maxStudentVideoQuality: 'auto',
  maxScreenShareQuality: 'auto',
  disableStudentVideoOnPoorNetwork: false,
  preferAudioOnPoorNetwork: true,
  showNetworkWarnings: true,
  exportControlsEnabled: true,
  allowAttendanceExport: true,
  allowChatExport: false,
  allowQuestionExport: false,
  allowRecordingDownload: true,
  includePrivateChatInExports: false,
  anonymizeStudentExports: false,
  exportRetentionDays: 365,
  requireExportAuditLog: true
};

@Component({
  selector: 'sfu-batch-details',
  standalone: true,
  imports: [Footer, FormField, FormRoot, Header, RouterLink],
  templateUrl: './batch-details.html',
  styleUrl: './batch-details.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class BatchDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly dashboard = inject(TeacherDashboardStore);

  private readonly paramMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected readonly weekdays: WeekdayOption[] = [
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
    { value: 0, label: 'Sunday' }
  ];
  protected readonly batchId = computed(() => this.paramMap().get('batchId') ?? '');
  protected readonly batch = computed(() => this.dashboard.batches().find((item) => item.id === this.batchId()) ?? null);
  protected readonly sessions = computed(() => this.batch()?.sessions ?? []);
  protected readonly students = computed(() => this.batch()?.students ?? []);
  protected readonly nextSession = computed(() => {
    const batch = this.batch();
    return batch ? this.dashboard.nextSession(batch) : null;
  });
  protected readonly completedCount = computed(() => this.sessions().filter((session) => session.status === 'completed').length);
  protected readonly averageAttendance = computed(() => {
    const batch = this.batch();
    return batch ? this.dashboard.averageAttendance(batch) : null;
  });
  protected readonly averageAttendanceLabel = computed(() => {
    const averageAttendance = this.averageAttendance();
    return averageAttendance === null ? 'N/A' : `${averageAttendance}%`;
  });
  protected readonly openStudentMenuId = signal<string | null>(null);
  protected readonly openSessionMenuId = signal<string | null>(null);
  protected readonly openSessionMenuPosition = signal<'above' | 'below'>('below');
  protected readonly messageTargetId = signal<string | null>(null);
  protected readonly actionNotice = signal('');
  protected readonly actionError = signal('');
  protected readonly liveSettings = signal<BatchLiveClassSettingsResponse | null>(null);
  protected readonly liveSettingsForm = signal<LiveSettingsForm>({ ...EMPTY_LIVE_SETTINGS_FORM });
  protected readonly liveSettingsLoading = signal(false);
  protected readonly liveSettingsSaving = signal(false);
  protected readonly liveSettingsResetting = signal(false);
  protected readonly sessionActionLoadingId = this.dashboard.sessionActionLoadingId;
  protected readonly messageModel = signal<MessageFormModel>({ message: '' });
  protected readonly messageForm = signalForm(this.messageModel, (path) => {
    required(path.message);
    maxLength(path.message, 500);
  });
  protected readonly messageTarget = computed(() => {
    const targetId = this.messageTargetId();
    return targetId ? this.students().find((student) => student.id === targetId) ?? null : null;
  });
  protected readonly hasLiveSettingsOverrides = computed(() => {
    const overrides = this.liveSettings()?.overrides;
    return Boolean(
      overrides &&
        (Object.keys(overrides.media ?? {}).length ||
          Object.keys(overrides.chat ?? {}).length ||
          Object.keys(overrides.whiteboard ?? {}).length ||
          Object.keys(overrides.speaking ?? {}).length ||
          Object.keys(overrides.recording ?? {}).length ||
          Object.keys(overrides.attendance ?? {}).length ||
          Object.keys(overrides.access ?? {}).length ||
          Object.keys(overrides.materials ?? {}).length ||
          Object.keys(overrides.notifications ?? {}).length ||
          Object.keys(overrides.questionQueue ?? {}).length ||
          Object.keys(overrides.recordingRetention ?? {}).length ||
          Object.keys(overrides.studentScreenShare ?? {}).length ||
          Object.keys(overrides.advancedAnalytics ?? {}).length ||
          Object.keys(overrides.inactiveDetection ?? {}).length ||
          Object.keys(overrides.bandwidthPolicy ?? {}).length ||
          Object.keys(overrides.exportControls ?? {}).length)
    );
  });

  private loadedLiveSettingsBatchId = '';

  constructor() {
    this.dashboard.loadBatches();
    effect(() => {
      const batchId = this.batchId();
      if (batchId && batchId !== this.loadedLiveSettingsBatchId) {
        this.loadedLiveSettingsBatchId = batchId;
        this.loadBatchLiveSettings(batchId);
      }
    });
  }

  protected async startSession(session: TeacherSession): Promise<void> {
    this.actionError.set('');
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected async openSession(session: TeacherSession): Promise<void> {
    await this.router.navigate(['/class-session/teacher'], {
      queryParams: {
        batchId: session.batchId,
        sessionId: session.id
      }
    });
  }

  protected startNextSession(batch: TeacherBatch): void {
    const nextSession = this.dashboard.nextSession(batch);
    if (nextSession) {
      void this.startSession(nextSession);
    }
  }

  protected completeSession(session: TeacherSession): void {
    this.actionError.set('');
    this.dashboard.completeSession(session).subscribe({
      next: () => {
        this.actionNotice.set(`Session ${session.sessionNumber} has ended.`);
      },
      error: () => {
        this.actionError.set(this.dashboard.error());
      }
    });
  }

  protected batchProgress(batch: TeacherBatch): number {
    if (!batch.sessions.length) {
      return 0;
    }
    const completed = batch.sessions.filter((session) => session.status === 'completed').length;
    return Math.round((completed / batch.sessions.length) * 100);
  }

  protected statusLabel(status: TeacherSessionStatus): string {
    if (status === 'live') {
      return 'Live now';
    }
    return status[0]!.toUpperCase() + status.slice(1);
  }

  protected studentStatusLabel(status: TeacherBatchStudentStatus): string {
    return status[0]!.toUpperCase() + status.slice(1);
  }

  protected studentStatusTone(status: TeacherBatchStudentStatus): string {
    if (status === 'active') {
      return 'success';
    }
    if (status === 'blocked' || status === 'paused' || status === 'suspended') {
      return 'danger';
    }
    return 'warning';
  }

  protected attendanceLabel(value: number): string {
    return `${Math.round(value)}%`;
  }

  protected weekdayLabel(value: number): string {
    return this.weekdays.find((weekday) => weekday.value === value)?.label ?? 'Weekly';
  }

  protected updateLiveSettingsForm<K extends keyof LiveSettingsForm>(key: K, value: LiveSettingsForm[K]): void {
    this.liveSettingsForm.update((form) => ({ ...form, [key]: value }));
  }

  protected liveSettingOverridden(key: keyof LiveSettingsForm): boolean {
    const inherited = this.inheritedLiveSettingsForm();
    return inherited ? this.liveSettingsForm()[key] !== inherited[key] : false;
  }

  protected liveSettingInheritanceLabel(key: keyof LiveSettingsForm): string {
    const inherited = this.inheritedLiveSettingsForm();
    if (!inherited) {
      return 'Loading inherited value';
    }
    const value = this.liveSettingValueLabel(inherited[key]);
    return this.liveSettingOverridden(key) ? `Override. Inherited ${value}` : `Inherited ${value}`;
  }

  protected resetLiveSettingField<K extends keyof LiveSettingsForm>(key: K, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const inherited = this.inheritedLiveSettingsForm();
    if (!inherited) {
      return;
    }
    this.updateLiveSettingsForm(key, inherited[key]);
  }

  protected checkedValue(event: Event): boolean {
    return event.target instanceof HTMLInputElement ? event.target.checked : false;
  }

  protected inputValue(event: Event): string {
    return event.target instanceof HTMLInputElement ? event.target.value : '';
  }

  protected numberValue(event: Event, fallback = 0): number {
    const value = event.target instanceof HTMLInputElement ? Number(event.target.value) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  }

  protected selectValue(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  protected recordingVisibilityValue(event: Event): RecordingVisibility {
    const value = this.selectValue(event);
    if (value === 'teacher_only' || value === 'enrolled_students' || value === 'hidden_until_published') {
      return value;
    }
    return 'enrolled_students';
  }

  protected analyticsVisibilityValue(event: Event): AnalyticsVisibility {
    const value = this.selectValue(event);
    return value === 'teacher_only' || value === 'admin_and_teacher' || value === 'admin_only' ? value : 'admin_and_teacher';
  }

  protected studentVideoQualityValue(event: Event): StudentVideoQualityLimit {
    const value = this.selectValue(event);
    return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : 'auto';
  }

  protected screenShareQualityValue(event: Event): ScreenShareQualityLimit {
    const value = this.selectValue(event);
    return value === 'auto' || value === 'medium' || value === 'high' ? value : 'auto';
  }

  private inheritedLiveSettingsForm(): LiveSettingsForm | null {
    const defaults = this.liveSettings()?.teacherDefaults;
    return defaults ? this.liveSettingsFormFromSettings(defaults) : null;
  }

  private liveSettingValueLabel(value: LiveSettingsForm[keyof LiveSettingsForm]): string {
    if (typeof value === 'boolean') {
      return value ? 'on' : 'off';
    }
    return `${value}`;
  }

  protected saveBatchLiveSettings(): void {
    const batchId = this.batchId();
    if (!batchId || this.liveSettingsSaving()) {
      return;
    }

    this.liveSettingsSaving.set(true);
    this.actionError.set('');
    this.actionNotice.set('');
    this.dashboard.updateBatchLiveSettings(batchId, this.liveSettingsRequest()).subscribe({
      next: (response) => {
        this.liveSettings.set(response);
        this.liveSettingsForm.set(this.liveSettingsFormFromSettings(response.resolved));
        this.actionNotice.set('Batch live settings updated.');
      },
      error: () => this.actionError.set(this.dashboard.error() || 'Unable to update batch live settings.'),
      complete: () => this.liveSettingsSaving.set(false)
    });
  }

  protected resetBatchLiveSettings(): void {
    const batchId = this.batchId();
    if (!batchId || this.liveSettingsResetting()) {
      return;
    }

    this.liveSettingsResetting.set(true);
    this.actionError.set('');
    this.actionNotice.set('');
    this.dashboard.resetBatchLiveSettings(batchId).subscribe({
      next: (response) => {
        this.liveSettings.set(response);
        this.liveSettingsForm.set(this.liveSettingsFormFromSettings(response.resolved));
        this.actionNotice.set('Batch now inherits teacher live settings.');
      },
      error: () => this.actionError.set(this.dashboard.error() || 'Unable to reset batch live settings.'),
      complete: () => this.liveSettingsResetting.set(false)
    });
  }

  protected scheduleLabel(schedule: TeacherBatchSchedule[]): string {
    return schedule.map((item) => `${this.dayLabel(item.dayOfWeek)} at ${item.startTime}`).join(', ');
  }

  private dayLabel(value: TeacherBatchSchedule['dayOfWeek']): string {
    return value[0] + value.slice(1).toLowerCase();
  }

  protected formatDateTime(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(value));
  }

  protected trackSession(_index: number, session: TeacherSession): string {
    return session.id;
  }

  protected trackStudent(_index: number, student: TeacherBatchStudent): string {
    return student.id;
  }

  protected toggleStudentMenu(studentId: string): void {
    this.openStudentMenuId.update((openId) => (openId === studentId ? null : studentId));
  }

  protected toggleSessionMenu(sessionId: string, event: MouseEvent): void {
    const button = event.currentTarget as HTMLElement | null;
    const openId = this.openSessionMenuId();

    if (openId === sessionId) {
      this.openSessionMenuId.set(null);
      return;
    }

    const preferredDirection: 'above' | 'below' = (() => {
      if (!button) {
        return 'below';
      }
      const rect = button.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      return spaceBelow < 200 && spaceAbove > spaceBelow ? 'above' : 'below';
    })();

    this.openSessionMenuPosition.set(preferredDirection);
    this.openSessionMenuId.set(sessionId);
  }

  protected closeSessionMenu(): void {
    this.openSessionMenuId.set(null);
    this.openSessionMenuPosition.set('below');
  }

  protected async rescheduleSession(session: TeacherSession): Promise<void> {
    this.closeSessionMenu();
    await this.router.navigate([`/teacher/dashboard/batches`, session.batchId], {
      queryParams: { action: 'reschedule', sessionId: session.id }
    });
  }

  protected cancelSession(session: TeacherSession): void {
    this.closeSessionMenu();
    this.dashboard.cancelSession(session.id);
    this.actionNotice.set(`Session ${session.sessionNumber} has been cancelled.`);
  }

  protected sessionActionItems(session: TeacherSession): Array<{ label: string; handler: (session: TeacherSession) => void | Promise<void> }> {
    const actions = [] as Array<{ label: string; handler: (session: TeacherSession) => void | Promise<void> }>;

    if (session.status === 'live') {
      actions.push({ label: 'Open', handler: async (session) => {
        this.closeSessionMenu();
        await this.openSession(session);
      }});
      actions.push({ label: 'Complete', handler: (session) => {
        this.completeSession(session);
        this.closeSessionMenu();
      }});
      actions.push({ label: 'Cancel', handler: (session) => this.cancelSession(session) });
    }

    if (session.status === 'scheduled') {
      actions.push({ label: 'Start session', handler: async (session) => {
        await this.startSession(session);
        this.closeSessionMenu();
      }});
      actions.push({ label: 'Reschedule', handler: async (session) => this.rescheduleSession(session) });
      actions.push({ label: 'Cancel', handler: (session) => this.cancelSession(session) });
    }

    return actions;
  }

  protected closeStudentMenu(): void {
    this.openStudentMenuId.set(null);
  }

  protected openMessageComposer(student: TeacherBatchStudent): void {
    this.messageTargetId.set(student.id);
    this.messageModel.set({ message: '' });
    this.messageForm().reset();
    this.closeStudentMenu();
  }

  protected cancelMessage(): void {
    this.messageTargetId.set(null);
    this.messageModel.set({ message: '' });
    this.messageForm().reset();
  }

  protected submitMessage(event?: Event): void {
    event?.preventDefault();
    this.messageForm().markAsTouched();
    const target = this.messageTarget();
    const message = this.messageModel().message.trim();

    if (!target || !message || this.messageForm().invalid()) {
      return;
    }

    this.actionNotice.set(`Message queued for ${target.displayName}.`);
    this.cancelMessage();
  }

  protected suspendStudent(student: TeacherBatchStudent): void {
    this.dashboard.updateStudentStatus(this.batchId(), student.id, 'suspended');
    this.actionNotice.set(`${student.displayName} has been suspended.`);
    this.closeStudentMenu();
  }

  protected blockStudent(student: TeacherBatchStudent): void {
    this.dashboard.updateStudentStatus(this.batchId(), student.id, 'blocked');
    this.actionNotice.set(`${student.displayName} has been blocked.`);
    this.closeStudentMenu();
  }

  protected async copyProfileLink(student: TeacherBatchStudent): Promise<void> {
    const profileLink = `${globalThis.location.origin}/teacher/dashboard/batches/${this.batchId()}?studentId=${encodeURIComponent(student.id)}`;
    this.closeStudentMenu();

    try {
      await globalThis.navigator.clipboard.writeText(profileLink);
      this.actionNotice.set(`Profile link copied for ${student.displayName}.`);
    } catch {
      this.actionNotice.set(profileLink);
    }
  }

  private loadBatchLiveSettings(batchId: string): void {
    this.liveSettingsLoading.set(true);
    this.dashboard.getBatchLiveSettings(batchId).subscribe({
      next: (response) => {
        this.liveSettings.set(response);
        this.liveSettingsForm.set(this.liveSettingsFormFromSettings(response.resolved));
      },
      error: () => this.actionError.set(this.dashboard.error() || 'Unable to load batch live settings.'),
      complete: () => this.liveSettingsLoading.set(false)
    });
  }

  private liveSettingsRequest(): LiveClassSettingsPatch {
    const form = this.liveSettingsForm();
    const base = this.liveSettings()?.teacherDefaults;
    if (!base) {
      return this.liveSettingsPatchFromForm(form);
    }

    const patch: LiveClassSettingsPatch = {};
    const media: NonNullable<LiveClassSettingsPatch['media']> = {};
    if (form.studentsJoinMuted !== base.media.studentsJoinMuted) media.studentsJoinMuted = form.studentsJoinMuted;
    if (form.studentsJoinCameraOff !== base.media.studentsJoinCameraOff) media.studentsJoinCameraOff = form.studentsJoinCameraOff;
    if (form.requirePrejoinDeviceCheck !== base.media.requirePrejoinDeviceCheck) media.requirePrejoinDeviceCheck = form.requirePrejoinDeviceCheck;
    if (form.allowStudentsToUnmuteSelf !== base.media.allowStudentsToUnmuteSelf) media.allowStudentsToUnmuteSelf = form.allowStudentsToUnmuteSelf;
    if (form.allowStudentsToStartCameraSelf !== base.media.allowStudentsToStartCameraSelf) media.allowStudentsToStartCameraSelf = form.allowStudentsToStartCameraSelf;
    if (Object.keys(media).length) patch.media = media;

    const chat: NonNullable<LiveClassSettingsPatch['chat']> = {};
    if (form.privateTeacherStudentChatEnabled !== base.chat.privateTeacherStudentChatEnabled) chat.privateTeacherStudentChatEnabled = form.privateTeacherStudentChatEnabled;
    if (form.teacherBroadcastEnabled !== base.chat.teacherBroadcastEnabled) chat.teacherBroadcastEnabled = form.teacherBroadcastEnabled;
    if (form.chatAttachmentsEnabled !== base.chat.chatAttachmentsEnabled) chat.chatAttachmentsEnabled = form.chatAttachmentsEnabled;
    if (form.messageLengthLimit !== base.chat.messageLengthLimit) chat.messageLengthLimit = form.messageLengthLimit;
    if (Object.keys(chat).length) patch.chat = chat;

    const whiteboard: NonNullable<LiveClassSettingsPatch['whiteboard']> = {};
    if (form.whiteboardSharingEnabled !== base.whiteboard.whiteboardSharingEnabled) whiteboard.whiteboardSharingEnabled = form.whiteboardSharingEnabled;
    if (form.studentWhiteboardControlEnabled !== base.whiteboard.studentWhiteboardControlEnabled) whiteboard.studentWhiteboardControlEnabled = form.studentWhiteboardControlEnabled;
    if (form.maxActiveWhiteboardControllers !== base.whiteboard.maxActiveWhiteboardControllers) {
      whiteboard.maxActiveWhiteboardControllers = form.maxActiveWhiteboardControllers;
    }
    if (Object.keys(whiteboard).length) patch.whiteboard = whiteboard;

    const speaking: NonNullable<LiveClassSettingsPatch['speaking']> = {};
    if (form.handRaiseEnabled !== base.speaking.handRaiseEnabled) speaking.handRaiseEnabled = form.handRaiseEnabled;
    if (form.maxActiveSpeakers !== base.speaking.maxActiveSpeakers) speaking.maxActiveSpeakers = form.maxActiveSpeakers;
    if (Object.keys(speaking).length) patch.speaking = speaking;

    const recording: NonNullable<LiveClassSettingsPatch['recording']> = {};
    if (form.recordingEnabled !== base.recording.recordingEnabled) recording.recordingEnabled = form.recordingEnabled;
    if (form.autoRecordOnStart !== base.recording.autoRecordOnStart) recording.autoRecordOnStart = form.autoRecordOnStart;
    if (form.teacherManualRecordingControlEnabled !== base.recording.teacherManualRecordingControlEnabled) {
      recording.teacherManualRecordingControlEnabled = form.teacherManualRecordingControlEnabled;
    }
    if (form.recordingVisibility !== base.recording.visibility) recording.visibility = form.recordingVisibility;
    if (Object.keys(recording).length) patch.recording = recording;

    const attendance: NonNullable<LiveClassSettingsPatch['attendance']> = {};
    if (form.presentThresholdMinutes !== base.attendance.presentThresholdMinutes) attendance.presentThresholdMinutes = form.presentThresholdMinutes;
    if (form.presentThresholdPercentage !== base.attendance.presentThresholdPercentage) attendance.presentThresholdPercentage = form.presentThresholdPercentage;
    if (form.lateJoinThresholdMinutes !== base.attendance.lateJoinThresholdMinutes) attendance.lateJoinThresholdMinutes = form.lateJoinThresholdMinutes;
    if (form.teacherAttendanceExportEnabled !== base.attendance.teacherAttendanceExportEnabled) attendance.teacherAttendanceExportEnabled = form.teacherAttendanceExportEnabled;
    if (Object.keys(attendance).length) patch.attendance = attendance;

    const access: NonNullable<LiveClassSettingsPatch['access']> = {};
    if (form.waitingRoomEnabled !== base.access.waitingRoomEnabled) access.waitingRoomEnabled = form.waitingRoomEnabled;
    if (form.lockClassAfterTeacherStarts !== base.access.lockClassAfterTeacherStarts) access.lockClassAfterTeacherStarts = form.lockClassAfterTeacherStarts;
    if (form.allowEnrolledStudentReconnectAfterLock !== base.access.allowEnrolledStudentReconnectAfterLock) {
      access.allowEnrolledStudentReconnectAfterLock = form.allowEnrolledStudentReconnectAfterLock;
    }
    if (form.teacherReconnectGraceMessagingEnabled !== base.access.teacherReconnectGraceMessagingEnabled) {
      access.teacherReconnectGraceMessagingEnabled = form.teacherReconnectGraceMessagingEnabled;
    }
    if (Object.keys(access).length) patch.access = access;

    const materialTypes = this.materialTypesFromText(form.allowedMaterialTypesText);
    const materials: NonNullable<LiveClassSettingsPatch['materials']> = {};
    if (form.materialsEnabled !== base.materials.materialsEnabled) materials.materialsEnabled = form.materialsEnabled;
    if (form.teacherCanUploadMaterials !== base.materials.teacherCanUploadMaterials) materials.teacherCanUploadMaterials = form.teacherCanUploadMaterials;
    if (form.studentsCanDownloadMaterials !== base.materials.studentsCanDownloadMaterials) materials.studentsCanDownloadMaterials = form.studentsCanDownloadMaterials;
    if (form.publishMaterialsBeforeClass !== base.materials.publishMaterialsBeforeClass) materials.publishMaterialsBeforeClass = form.publishMaterialsBeforeClass;
    if (form.publishMaterialsAfterClass !== base.materials.publishMaterialsAfterClass) materials.publishMaterialsAfterClass = form.publishMaterialsAfterClass;
    if (!this.sameStringList(materialTypes, base.materials.allowedMaterialTypes)) materials.allowedMaterialTypes = materialTypes;
    if (form.maxMaterialFileSizeMb !== base.materials.maxMaterialFileSizeMb) materials.maxMaterialFileSizeMb = form.maxMaterialFileSizeMb;
    if (Object.keys(materials).length) patch.materials = materials;

    const notifications: NonNullable<LiveClassSettingsPatch['notifications']> = {};
    if (form.classReminderEnabled !== base.notifications.classReminderEnabled) notifications.classReminderEnabled = form.classReminderEnabled;
    if (form.classReminderMinutesBefore !== base.notifications.classReminderMinutesBefore) notifications.classReminderMinutesBefore = form.classReminderMinutesBefore;
    if (form.notifyWhenTeacherStarts !== base.notifications.notifyWhenTeacherStarts) notifications.notifyWhenTeacherStarts = form.notifyWhenTeacherStarts;
    if (form.notifyRecordingAvailable !== base.notifications.notifyRecordingAvailable) notifications.notifyRecordingAvailable = form.notifyRecordingAvailable;
    if (form.notifyNewMaterialUploaded !== base.notifications.notifyNewMaterialUploaded) notifications.notifyNewMaterialUploaded = form.notifyNewMaterialUploaded;
    if (form.notifyMissedClass !== base.notifications.notifyMissedClass) notifications.notifyMissedClass = form.notifyMissedClass;
    if (Object.keys(notifications).length) patch.notifications = notifications;

    const questionQueue: NonNullable<LiveClassSettingsPatch['questionQueue']> = {};
    if (form.questionQueueEnabled !== base.questionQueue.questionQueueEnabled) questionQueue.questionQueueEnabled = form.questionQueueEnabled;
    if (form.allowAnonymousQuestions !== base.questionQueue.allowAnonymousQuestions) questionQueue.allowAnonymousQuestions = form.allowAnonymousQuestions;
    if (form.allowStudentUpvotes !== base.questionQueue.allowStudentUpvotes) questionQueue.allowStudentUpvotes = form.allowStudentUpvotes;
    if (form.teacherCanMarkAnswered !== base.questionQueue.teacherCanMarkAnswered) questionQueue.teacherCanMarkAnswered = form.teacherCanMarkAnswered;
    if (form.maxOpenQuestionsPerStudent !== base.questionQueue.maxOpenQuestionsPerStudent) {
      questionQueue.maxOpenQuestionsPerStudent = form.maxOpenQuestionsPerStudent;
    }
    if (Object.keys(questionQueue).length) patch.questionQueue = questionQueue;

    const recordingRetention: NonNullable<LiveClassSettingsPatch['recordingRetention']> = {};
    if (form.recordingRetentionDays !== base.recordingRetention.recordingRetentionDays) recordingRetention.recordingRetentionDays = form.recordingRetentionDays;
    if (form.allowTeacherPublishRecording !== base.recordingRetention.allowTeacherPublishRecording) {
      recordingRetention.allowTeacherPublishRecording = form.allowTeacherPublishRecording;
    }
    if (form.allowStudentsDownloadRecording !== base.recordingRetention.allowStudentsDownloadRecording) {
      recordingRetention.allowStudentsDownloadRecording = form.allowStudentsDownloadRecording;
    }
    if (form.autoArchiveExpiredRecordings !== base.recordingRetention.autoArchiveExpiredRecordings) {
      recordingRetention.autoArchiveExpiredRecordings = form.autoArchiveExpiredRecordings;
    }
    if (Object.keys(recordingRetention).length) patch.recordingRetention = recordingRetention;

    const studentScreenShare: NonNullable<LiveClassSettingsPatch['studentScreenShare']> = {};
    if (form.studentScreenShareEnabled !== base.studentScreenShare.studentScreenShareEnabled) {
      studentScreenShare.studentScreenShareEnabled = form.studentScreenShareEnabled;
    }
    if (form.studentScreenShareRequiresApproval !== base.studentScreenShare.studentScreenShareRequiresApproval) {
      studentScreenShare.studentScreenShareRequiresApproval = form.studentScreenShareRequiresApproval;
    }
    if (form.maxActiveStudentShares !== base.studentScreenShare.maxActiveStudentShares) {
      studentScreenShare.maxActiveStudentShares = form.maxActiveStudentShares;
    }
    if (Object.keys(studentScreenShare).length) patch.studentScreenShare = studentScreenShare;

    const advancedAnalytics: NonNullable<LiveClassSettingsPatch['advancedAnalytics']> = {};
    if (form.analyticsEnabled !== base.advancedAnalytics.analyticsEnabled) advancedAnalytics.analyticsEnabled = form.analyticsEnabled;
    if (form.trackEngagementEvents !== base.advancedAnalytics.trackEngagementEvents) advancedAnalytics.trackEngagementEvents = form.trackEngagementEvents;
    if (form.trackMediaQuality !== base.advancedAnalytics.trackMediaQuality) advancedAnalytics.trackMediaQuality = form.trackMediaQuality;
    if (form.trackChatParticipation !== base.advancedAnalytics.trackChatParticipation) advancedAnalytics.trackChatParticipation = form.trackChatParticipation;
    if (form.trackWhiteboardParticipation !== base.advancedAnalytics.trackWhiteboardParticipation) {
      advancedAnalytics.trackWhiteboardParticipation = form.trackWhiteboardParticipation;
    }
    if (form.trackQuestionParticipation !== base.advancedAnalytics.trackQuestionParticipation) {
      advancedAnalytics.trackQuestionParticipation = form.trackQuestionParticipation;
    }
    if (form.analyticsVisibility !== base.advancedAnalytics.analyticsVisibility) advancedAnalytics.analyticsVisibility = form.analyticsVisibility;
    if (Object.keys(advancedAnalytics).length) patch.advancedAnalytics = advancedAnalytics;

    const inactiveDetection: NonNullable<LiveClassSettingsPatch['inactiveDetection']> = {};
    if (form.inactiveDetectionEnabled !== base.inactiveDetection.inactiveDetectionEnabled) inactiveDetection.inactiveDetectionEnabled = form.inactiveDetectionEnabled;
    if (form.inactiveAfterMinutes !== base.inactiveDetection.inactiveAfterMinutes) inactiveDetection.inactiveAfterMinutes = form.inactiveAfterMinutes;
    if (form.countBackgroundTabAsInactive !== base.inactiveDetection.countBackgroundTabAsInactive) {
      inactiveDetection.countBackgroundTabAsInactive = form.countBackgroundTabAsInactive;
    }
    if (form.countMutedNoCameraAsInactive !== base.inactiveDetection.countMutedNoCameraAsInactive) {
      inactiveDetection.countMutedNoCameraAsInactive = form.countMutedNoCameraAsInactive;
    }
    if (form.notifyTeacherOnInactiveStudents !== base.inactiveDetection.notifyTeacherOnInactiveStudents) {
      inactiveDetection.notifyTeacherOnInactiveStudents = form.notifyTeacherOnInactiveStudents;
    }
    if (form.includeInactiveTimeInAttendance !== base.inactiveDetection.includeInactiveTimeInAttendance) {
      inactiveDetection.includeInactiveTimeInAttendance = form.includeInactiveTimeInAttendance;
    }
    if (Object.keys(inactiveDetection).length) patch.inactiveDetection = inactiveDetection;

    const bandwidthPolicy: NonNullable<LiveClassSettingsPatch['bandwidthPolicy']> = {};
    if (form.adaptiveQualityEnabled !== base.bandwidthPolicy.adaptiveQualityEnabled) bandwidthPolicy.adaptiveQualityEnabled = form.adaptiveQualityEnabled;
    if (form.lowBandwidthModeEnabled !== base.bandwidthPolicy.lowBandwidthModeEnabled) bandwidthPolicy.lowBandwidthModeEnabled = form.lowBandwidthModeEnabled;
    if (form.maxStudentVideoQuality !== base.bandwidthPolicy.maxStudentVideoQuality) bandwidthPolicy.maxStudentVideoQuality = form.maxStudentVideoQuality;
    if (form.maxScreenShareQuality !== base.bandwidthPolicy.maxScreenShareQuality) bandwidthPolicy.maxScreenShareQuality = form.maxScreenShareQuality;
    if (form.disableStudentVideoOnPoorNetwork !== base.bandwidthPolicy.disableStudentVideoOnPoorNetwork) {
      bandwidthPolicy.disableStudentVideoOnPoorNetwork = form.disableStudentVideoOnPoorNetwork;
    }
    if (form.preferAudioOnPoorNetwork !== base.bandwidthPolicy.preferAudioOnPoorNetwork) bandwidthPolicy.preferAudioOnPoorNetwork = form.preferAudioOnPoorNetwork;
    if (form.showNetworkWarnings !== base.bandwidthPolicy.showNetworkWarnings) bandwidthPolicy.showNetworkWarnings = form.showNetworkWarnings;
    if (Object.keys(bandwidthPolicy).length) patch.bandwidthPolicy = bandwidthPolicy;

    const exportControls: NonNullable<LiveClassSettingsPatch['exportControls']> = {};
    if (form.exportControlsEnabled !== base.exportControls.exportControlsEnabled) exportControls.exportControlsEnabled = form.exportControlsEnabled;
    if (form.allowAttendanceExport !== base.exportControls.allowAttendanceExport) exportControls.allowAttendanceExport = form.allowAttendanceExport;
    if (form.allowChatExport !== base.exportControls.allowChatExport) exportControls.allowChatExport = form.allowChatExport;
    if (form.allowQuestionExport !== base.exportControls.allowQuestionExport) exportControls.allowQuestionExport = form.allowQuestionExport;
    if (form.allowRecordingDownload !== base.exportControls.allowRecordingDownload) exportControls.allowRecordingDownload = form.allowRecordingDownload;
    if (form.includePrivateChatInExports !== base.exportControls.includePrivateChatInExports) {
      exportControls.includePrivateChatInExports = form.includePrivateChatInExports;
    }
    if (form.anonymizeStudentExports !== base.exportControls.anonymizeStudentExports) exportControls.anonymizeStudentExports = form.anonymizeStudentExports;
    if (form.exportRetentionDays !== base.exportControls.exportRetentionDays) exportControls.exportRetentionDays = form.exportRetentionDays;
    if (form.requireExportAuditLog !== base.exportControls.requireExportAuditLog) exportControls.requireExportAuditLog = form.requireExportAuditLog;
    if (Object.keys(exportControls).length) patch.exportControls = exportControls;

    return patch;
  }

  private liveSettingsPatchFromForm(form: LiveSettingsForm): LiveClassSettingsPatch {
    return {
      media: {
        studentsJoinMuted: form.studentsJoinMuted,
        studentsJoinCameraOff: form.studentsJoinCameraOff,
        requirePrejoinDeviceCheck: form.requirePrejoinDeviceCheck,
        allowStudentsToUnmuteSelf: form.allowStudentsToUnmuteSelf,
        allowStudentsToStartCameraSelf: form.allowStudentsToStartCameraSelf
      },
      chat: {
        privateTeacherStudentChatEnabled: form.privateTeacherStudentChatEnabled,
        teacherBroadcastEnabled: form.teacherBroadcastEnabled,
        chatAttachmentsEnabled: form.chatAttachmentsEnabled,
        messageLengthLimit: form.messageLengthLimit
      },
      whiteboard: {
        whiteboardSharingEnabled: form.whiteboardSharingEnabled,
        studentWhiteboardControlEnabled: form.studentWhiteboardControlEnabled,
        maxActiveWhiteboardControllers: form.maxActiveWhiteboardControllers
      },
      speaking: {
        handRaiseEnabled: form.handRaiseEnabled,
        maxActiveSpeakers: form.maxActiveSpeakers
      },
      recording: {
        recordingEnabled: form.recordingEnabled,
        autoRecordOnStart: form.autoRecordOnStart,
        teacherManualRecordingControlEnabled: form.teacherManualRecordingControlEnabled,
        visibility: form.recordingVisibility
      },
      attendance: {
        presentThresholdMinutes: form.presentThresholdMinutes,
        presentThresholdPercentage: form.presentThresholdPercentage,
        lateJoinThresholdMinutes: form.lateJoinThresholdMinutes,
        teacherAttendanceExportEnabled: form.teacherAttendanceExportEnabled
      },
      access: {
        waitingRoomEnabled: form.waitingRoomEnabled,
        lockClassAfterTeacherStarts: form.lockClassAfterTeacherStarts,
        allowEnrolledStudentReconnectAfterLock: form.allowEnrolledStudentReconnectAfterLock,
        teacherReconnectGraceMessagingEnabled: form.teacherReconnectGraceMessagingEnabled
      },
      materials: {
        materialsEnabled: form.materialsEnabled,
        teacherCanUploadMaterials: form.teacherCanUploadMaterials,
        studentsCanDownloadMaterials: form.studentsCanDownloadMaterials,
        publishMaterialsBeforeClass: form.publishMaterialsBeforeClass,
        publishMaterialsAfterClass: form.publishMaterialsAfterClass,
        allowedMaterialTypes: this.materialTypesFromText(form.allowedMaterialTypesText),
        maxMaterialFileSizeMb: form.maxMaterialFileSizeMb
      },
      notifications: {
        classReminderEnabled: form.classReminderEnabled,
        classReminderMinutesBefore: form.classReminderMinutesBefore,
        notifyWhenTeacherStarts: form.notifyWhenTeacherStarts,
        notifyRecordingAvailable: form.notifyRecordingAvailable,
        notifyNewMaterialUploaded: form.notifyNewMaterialUploaded,
        notifyMissedClass: form.notifyMissedClass
      },
      questionQueue: {
        questionQueueEnabled: form.questionQueueEnabled,
        allowAnonymousQuestions: form.allowAnonymousQuestions,
        allowStudentUpvotes: form.allowStudentUpvotes,
        teacherCanMarkAnswered: form.teacherCanMarkAnswered,
        maxOpenQuestionsPerStudent: form.maxOpenQuestionsPerStudent
      },
      recordingRetention: {
        recordingRetentionDays: form.recordingRetentionDays,
        allowTeacherPublishRecording: form.allowTeacherPublishRecording,
        allowStudentsDownloadRecording: form.allowStudentsDownloadRecording,
        autoArchiveExpiredRecordings: form.autoArchiveExpiredRecordings
      },
      studentScreenShare: {
        studentScreenShareEnabled: form.studentScreenShareEnabled,
        studentScreenShareRequiresApproval: form.studentScreenShareRequiresApproval,
        maxActiveStudentShares: form.maxActiveStudentShares
      },
      advancedAnalytics: {
        analyticsEnabled: form.analyticsEnabled,
        trackEngagementEvents: form.trackEngagementEvents,
        trackMediaQuality: form.trackMediaQuality,
        trackChatParticipation: form.trackChatParticipation,
        trackWhiteboardParticipation: form.trackWhiteboardParticipation,
        trackQuestionParticipation: form.trackQuestionParticipation,
        analyticsVisibility: form.analyticsVisibility
      },
      inactiveDetection: {
        inactiveDetectionEnabled: form.inactiveDetectionEnabled,
        inactiveAfterMinutes: form.inactiveAfterMinutes,
        countBackgroundTabAsInactive: form.countBackgroundTabAsInactive,
        countMutedNoCameraAsInactive: form.countMutedNoCameraAsInactive,
        notifyTeacherOnInactiveStudents: form.notifyTeacherOnInactiveStudents,
        includeInactiveTimeInAttendance: form.includeInactiveTimeInAttendance
      },
      bandwidthPolicy: {
        adaptiveQualityEnabled: form.adaptiveQualityEnabled,
        lowBandwidthModeEnabled: form.lowBandwidthModeEnabled,
        maxStudentVideoQuality: form.maxStudentVideoQuality,
        maxScreenShareQuality: form.maxScreenShareQuality,
        disableStudentVideoOnPoorNetwork: form.disableStudentVideoOnPoorNetwork,
        preferAudioOnPoorNetwork: form.preferAudioOnPoorNetwork,
        showNetworkWarnings: form.showNetworkWarnings
      },
      exportControls: {
        exportControlsEnabled: form.exportControlsEnabled,
        allowAttendanceExport: form.allowAttendanceExport,
        allowChatExport: form.allowChatExport,
        allowQuestionExport: form.allowQuestionExport,
        allowRecordingDownload: form.allowRecordingDownload,
        includePrivateChatInExports: form.includePrivateChatInExports,
        anonymizeStudentExports: form.anonymizeStudentExports,
        exportRetentionDays: form.exportRetentionDays,
        requireExportAuditLog: form.requireExportAuditLog
      }
    };
  }

  private liveSettingsFormFromSettings(settings: LiveClassSettings): LiveSettingsForm {
    return {
      studentsJoinMuted: settings.media.studentsJoinMuted,
      studentsJoinCameraOff: settings.media.studentsJoinCameraOff,
      requirePrejoinDeviceCheck: settings.media.requirePrejoinDeviceCheck,
      allowStudentsToUnmuteSelf: settings.media.allowStudentsToUnmuteSelf,
      allowStudentsToStartCameraSelf: settings.media.allowStudentsToStartCameraSelf,
      privateTeacherStudentChatEnabled: settings.chat.privateTeacherStudentChatEnabled,
      teacherBroadcastEnabled: settings.chat.teacherBroadcastEnabled,
      chatAttachmentsEnabled: settings.chat.chatAttachmentsEnabled,
      messageLengthLimit: settings.chat.messageLengthLimit,
      whiteboardSharingEnabled: settings.whiteboard.whiteboardSharingEnabled,
      studentWhiteboardControlEnabled: settings.whiteboard.studentWhiteboardControlEnabled,
      maxActiveWhiteboardControllers: settings.whiteboard.maxActiveWhiteboardControllers,
      handRaiseEnabled: settings.speaking.handRaiseEnabled,
      maxActiveSpeakers: settings.speaking.maxActiveSpeakers,
      recordingEnabled: settings.recording.recordingEnabled,
      autoRecordOnStart: settings.recording.autoRecordOnStart,
      teacherManualRecordingControlEnabled: settings.recording.teacherManualRecordingControlEnabled,
      recordingVisibility: settings.recording.visibility,
      presentThresholdMinutes: settings.attendance.presentThresholdMinutes,
      presentThresholdPercentage: settings.attendance.presentThresholdPercentage,
      lateJoinThresholdMinutes: settings.attendance.lateJoinThresholdMinutes,
      teacherAttendanceExportEnabled: settings.attendance.teacherAttendanceExportEnabled,
      waitingRoomEnabled: settings.access.waitingRoomEnabled,
      lockClassAfterTeacherStarts: settings.access.lockClassAfterTeacherStarts,
      allowEnrolledStudentReconnectAfterLock: settings.access.allowEnrolledStudentReconnectAfterLock,
      teacherReconnectGraceMessagingEnabled: settings.access.teacherReconnectGraceMessagingEnabled,
      materialsEnabled: settings.materials.materialsEnabled,
      teacherCanUploadMaterials: settings.materials.teacherCanUploadMaterials,
      studentsCanDownloadMaterials: settings.materials.studentsCanDownloadMaterials,
      publishMaterialsBeforeClass: settings.materials.publishMaterialsBeforeClass,
      publishMaterialsAfterClass: settings.materials.publishMaterialsAfterClass,
      allowedMaterialTypesText: settings.materials.allowedMaterialTypes.join(', '),
      maxMaterialFileSizeMb: settings.materials.maxMaterialFileSizeMb,
      classReminderEnabled: settings.notifications.classReminderEnabled,
      classReminderMinutesBefore: settings.notifications.classReminderMinutesBefore,
      notifyWhenTeacherStarts: settings.notifications.notifyWhenTeacherStarts,
      notifyRecordingAvailable: settings.notifications.notifyRecordingAvailable,
      notifyNewMaterialUploaded: settings.notifications.notifyNewMaterialUploaded,
      notifyMissedClass: settings.notifications.notifyMissedClass,
      questionQueueEnabled: settings.questionQueue.questionQueueEnabled,
      allowAnonymousQuestions: settings.questionQueue.allowAnonymousQuestions,
      allowStudentUpvotes: settings.questionQueue.allowStudentUpvotes,
      teacherCanMarkAnswered: settings.questionQueue.teacherCanMarkAnswered,
      maxOpenQuestionsPerStudent: settings.questionQueue.maxOpenQuestionsPerStudent,
      recordingRetentionDays: settings.recordingRetention.recordingRetentionDays,
      allowTeacherPublishRecording: settings.recordingRetention.allowTeacherPublishRecording,
      allowStudentsDownloadRecording: settings.recordingRetention.allowStudentsDownloadRecording,
      autoArchiveExpiredRecordings: settings.recordingRetention.autoArchiveExpiredRecordings,
      studentScreenShareEnabled: settings.studentScreenShare.studentScreenShareEnabled,
      studentScreenShareRequiresApproval: settings.studentScreenShare.studentScreenShareRequiresApproval,
      maxActiveStudentShares: settings.studentScreenShare.maxActiveStudentShares,
      analyticsEnabled: settings.advancedAnalytics.analyticsEnabled,
      trackEngagementEvents: settings.advancedAnalytics.trackEngagementEvents,
      trackMediaQuality: settings.advancedAnalytics.trackMediaQuality,
      trackChatParticipation: settings.advancedAnalytics.trackChatParticipation,
      trackWhiteboardParticipation: settings.advancedAnalytics.trackWhiteboardParticipation,
      trackQuestionParticipation: settings.advancedAnalytics.trackQuestionParticipation,
      analyticsVisibility: settings.advancedAnalytics.analyticsVisibility,
      inactiveDetectionEnabled: settings.inactiveDetection.inactiveDetectionEnabled,
      inactiveAfterMinutes: settings.inactiveDetection.inactiveAfterMinutes,
      countBackgroundTabAsInactive: settings.inactiveDetection.countBackgroundTabAsInactive,
      countMutedNoCameraAsInactive: settings.inactiveDetection.countMutedNoCameraAsInactive,
      notifyTeacherOnInactiveStudents: settings.inactiveDetection.notifyTeacherOnInactiveStudents,
      includeInactiveTimeInAttendance: settings.inactiveDetection.includeInactiveTimeInAttendance,
      adaptiveQualityEnabled: settings.bandwidthPolicy.adaptiveQualityEnabled,
      lowBandwidthModeEnabled: settings.bandwidthPolicy.lowBandwidthModeEnabled,
      maxStudentVideoQuality: settings.bandwidthPolicy.maxStudentVideoQuality,
      maxScreenShareQuality: settings.bandwidthPolicy.maxScreenShareQuality,
      disableStudentVideoOnPoorNetwork: settings.bandwidthPolicy.disableStudentVideoOnPoorNetwork,
      preferAudioOnPoorNetwork: settings.bandwidthPolicy.preferAudioOnPoorNetwork,
      showNetworkWarnings: settings.bandwidthPolicy.showNetworkWarnings,
      exportControlsEnabled: settings.exportControls.exportControlsEnabled,
      allowAttendanceExport: settings.exportControls.allowAttendanceExport,
      allowChatExport: settings.exportControls.allowChatExport,
      allowQuestionExport: settings.exportControls.allowQuestionExport,
      allowRecordingDownload: settings.exportControls.allowRecordingDownload,
      includePrivateChatInExports: settings.exportControls.includePrivateChatInExports,
      anonymizeStudentExports: settings.exportControls.anonymizeStudentExports,
      exportRetentionDays: settings.exportControls.exportRetentionDays,
      requireExportAuditLog: settings.exportControls.requireExportAuditLog
    };
  }

  private materialTypesFromText(value: string): string[] {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  private sameStringList(left: string[], right: string[]): boolean {
    return left.join('|') === right.join('|');
  }
}
