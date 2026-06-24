import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  AnalyticsVisibility,
  LiveClassSettings,
  LiveClassSettingsPatch,
  ProfileBatchAssociation,
  ProfileCredential,
  ProfileExperience,
  ProfileSettings,
  ProfileSocialLink,
  ProfileThemePreference,
  ProfileUser,
  RecordingVisibility,
  ScreenShareQualityLimit,
  StudentVideoQualityLimit,
  UpdateMyProfileRequest,
  UpdateMySettingsRequest
} from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { ThemeService } from '../../../core/services/theme.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

type TeacherProfileTab = 'credentials' | 'experience' | 'links' | 'batches';

interface ProfileMetric {
  label: string;
  value: string;
}

interface ProfileTab {
  id: TeacherProfileTab;
  label: string;
}

interface TeacherProfileForm {
  displayName: string;
  phone: string;
  headline: string;
  bio: string;
  location: string;
  timezone: string;
  availability: string;
  languagesText: string;
  skillsText: string;
  credentialsText: string;
  educationText: string;
  experienceText: string;
  socialLinksText: string;
  publicProfileEnabled: boolean;
}

interface ProfileSettingsForm {
  theme: ProfileThemePreference;
  locale: string;
  notificationEmail: boolean;
  notificationClassReminders: boolean;
  notificationChatMessages: boolean;
  notificationAnnouncements: boolean;
  notificationRecordingReady: boolean;
  privacyShowEmail: boolean;
  privacyAllowTeacherMessages: boolean;
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

const PROFILE_TABS: ProfileTab[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'experience', label: 'Experience' },
  { id: 'links', label: 'Links' },
  { id: 'batches', label: 'Batches' }
];

const EMPTY_FORM: TeacherProfileForm = {
  displayName: '',
  phone: '',
  headline: '',
  bio: '',
  location: '',
  timezone: '',
  availability: '',
  languagesText: '',
  skillsText: '',
  credentialsText: '',
  educationText: '',
  experienceText: '',
  socialLinksText: '',
  publicProfileEnabled: false
};

const EMPTY_SETTINGS_FORM: ProfileSettingsForm = {
  theme: 'system',
  locale: 'en-US',
  notificationEmail: true,
  notificationClassReminders: true,
  notificationChatMessages: true,
  notificationAnnouncements: true,
  notificationRecordingReady: true,
  privacyShowEmail: false,
  privacyAllowTeacherMessages: true
};

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
  selector: 'sfu-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-profile.html',
  styleUrl: './teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherProfile implements OnInit {
  private readonly profiles = inject(ProfileService);
  private readonly theme = inject(ThemeService);

  protected readonly tabs = PROFILE_TABS;
  protected readonly activeTab = signal<TeacherProfileTab>('batches');
  protected readonly profile = signal<ProfileUser | null>(null);
  protected readonly form = signal<TeacherProfileForm>({ ...EMPTY_FORM });
  protected readonly settingsForm = signal<ProfileSettingsForm>({ ...EMPTY_SETTINGS_FORM });
  protected readonly liveSettingsForm = signal<LiveSettingsForm>({ ...EMPTY_LIVE_SETTINGS_FORM });
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly savingLiveSettings = signal(false);
  protected readonly uploadingField = signal<'avatar' | 'cover' | null>(null);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly editing = signal(false);

  protected readonly batches = computed(() => this.profile()?.batches ?? []);
  protected readonly totalStudents = computed(() => this.batches().reduce((total, batch) => total + (batch.enrolledCount ?? 0), 0));
  protected readonly metrics = computed<ProfileMetric[]>(() => {
    const profile = this.profile();
    return [
      { label: 'Batches', value: `${this.batches().length}` },
      { label: 'Active students', value: `${this.totalStudents()}` },
      { label: 'Skills', value: `${profile?.skills.length ?? 0}` },
      { label: 'Public profile', value: profile?.publicProfileEnabled ? 'Published' : 'Private' }
    ];
  });

  ngOnInit(): void {
    this.loadProfile();
    this.loadLiveSettings();
  }

  protected loadProfile(): void {
    this.loading.set(true);
    this.error.set('');
    this.profiles.getMyProfile().subscribe({
      next: (profile) => {
        this.profile.set(profile);
        this.form.set(this.formFromProfile(profile));
        this.settingsForm.set(this.settingsFormFromProfile(profile.settings));
        this.theme.setPreference(profile.settings.theme);
      },
      error: (error) => {
        this.error.set(this.profiles.errorMessage(error));
      },
      complete: () => this.loading.set(false)
    });
  }

  protected saveProfile(): void {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.updateMyProfile(this.updateRequest()).subscribe({
      next: (profile) => {
        this.profile.set(profile);
        this.form.set(this.formFromProfile(profile));
        this.editing.set(false);
        this.notice.set('Profile updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.saving.set(false)
    });
  }

  protected saveSettings(): void {
    if (this.savingSettings()) {
      return;
    }
    this.savingSettings.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.updateMySettings(this.settingsRequest()).subscribe({
      next: (settings) => {
        this.profile.update((profile) => (profile ? { ...profile, settings } : profile));
        this.settingsForm.set(this.settingsFormFromProfile(settings));
        this.theme.setPreference(settings.theme);
        this.notice.set('Settings updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.savingSettings.set(false)
    });
  }

  protected saveLiveSettings(): void {
    if (this.savingLiveSettings()) {
      return;
    }
    this.savingLiveSettings.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.updateTeacherLiveSettings(this.liveSettingsRequest()).subscribe({
      next: (response) => {
        this.liveSettingsForm.set(this.liveSettingsFormFromSettings(response.settings));
        this.notice.set('Live class defaults updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.savingLiveSettings.set(false)
    });
  }

  protected uploadAvatar(event: Event): void {
    this.uploadMedia(event, 'avatar');
  }

  protected uploadCover(event: Event): void {
    this.uploadMedia(event, 'cover');
  }

  protected selectTab(tab: TeacherProfileTab): void {
    this.activeTab.set(tab);
  }

  protected tabCount(tab: TeacherProfileTab): number {
    const profile = this.profile();
    switch (tab) {
      case 'credentials':
        return (profile?.credentials.length ?? 0) + (profile?.education.length ?? 0);
      case 'experience':
        return profile?.experience.length ?? 0;
      case 'links':
        return profile?.socialLinks.length ?? 0;
      case 'batches':
        return this.batches().length;
    }
  }

  protected updateForm<K extends keyof TeacherProfileForm>(key: K, value: TeacherProfileForm[K]): void {
    this.form.update((form) => ({ ...form, [key]: value }));
  }

  protected updateSettingsForm<K extends keyof ProfileSettingsForm>(key: K, value: ProfileSettingsForm[K]): void {
    this.settingsForm.update((form) => ({ ...form, [key]: value }));
  }

  protected updateLiveSettingsForm<K extends keyof LiveSettingsForm>(key: K, value: LiveSettingsForm[K]): void {
    this.liveSettingsForm.update((form) => ({ ...form, [key]: value }));
  }

  protected inputValue(event: Event): string {
    return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target.value : '';
  }

  protected selectValue(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  protected themeValue(event: Event): ProfileThemePreference {
    const value = this.selectValue(event);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  }

  protected checkedValue(event: Event): boolean {
    return event.target instanceof HTMLInputElement ? event.target.checked : false;
  }

  protected numberValue(event: Event, fallback = 0): number {
    const value = event.target instanceof HTMLInputElement ? Number(event.target.value) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
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

  protected profileImage(): string {
    const profile = this.profile();
    if (profile?.avatarUrl) {
      return this.profiles.resolveMediaUrl(profile.avatarUrl);
    }
    return this.initialsImage(profile?.displayName ?? 'Teacher', 320, 320);
  }

  protected coverImage(): string {
    const profile = this.profile();
    if (profile?.coverImageUrl) {
      return this.profiles.resolveMediaUrl(profile.coverImageUrl);
    }
    const title = profile?.headline || 'Native SFU teacher profile';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="420" viewBox="0 0 1440 420" role="img" aria-label="${title} cover image"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#458B73"/><stop offset=".55" stop-color="#F26076"/><stop offset="1" stop-color="#FF9760"/></linearGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="1"/></pattern></defs><rect width="1440" height="420" fill="url(#bg)"/><rect width="1440" height="420" fill="url(#grid)"/><path d="M0 310 420 120l420 124 600-214v390H0z" fill="#fff" opacity=".14"/><text x="72" y="116" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800" fill="#fff">${title}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  protected publicProfileLink(): string {
    return `/teachers/${encodeURIComponent(this.profile()?.id ?? '')}`;
  }

  protected batchFillLabel(batch: ProfileBatchAssociation): string {
    return `${batch.enrolledCount ?? 0}/${batch.capacity ?? 0} students`;
  }

  protected formatDate(value: string | undefined): string {
    if (!value) {
      return 'No start date';
    }
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(new Date(value));
  }

  protected credentialLabel(item: ProfileCredential): string {
    return [item.issuer, item.year].filter(Boolean).join(' - ') || 'Credential';
  }

  private loadLiveSettings(): void {
    this.profiles.getTeacherLiveSettings().subscribe({
      next: (response) => {
        this.liveSettingsForm.set(this.liveSettingsFormFromSettings(response.settings));
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error))
    });
  }

  private uploadMedia(event: Event, kind: 'avatar' | 'cover'): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }
    this.uploadingField.set(kind);
    this.error.set('');
    this.notice.set('');
    const request = kind === 'avatar' ? this.profiles.uploadProfileAvatar(file) : this.profiles.uploadProfileCover(file);
    request.subscribe({
      next: (response) => {
        this.profile.update((profile) => (profile ? { ...profile, [response.field]: response.url } : profile));
        this.notice.set(kind === 'avatar' ? 'Avatar updated.' : 'Cover image updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => {
        this.uploadingField.set(null);
        if (input) {
          input.value = '';
        }
      }
    });
  }

  private updateRequest(): UpdateMyProfileRequest {
    const form = this.form();
    return {
      displayName: form.displayName,
      phone: form.phone,
      headline: form.headline,
      bio: form.bio,
      location: form.location,
      timezone: form.timezone,
      availability: form.availability,
      languages: this.parseList(form.languagesText),
      skills: this.parseList(form.skillsText),
      credentials: this.parseCredentials(form.credentialsText),
      education: this.parseCredentials(form.educationText),
      experience: this.parseExperience(form.experienceText),
      socialLinks: this.parseSocialLinks(form.socialLinksText),
      publicProfileEnabled: form.publicProfileEnabled
    };
  }

  private settingsRequest(): UpdateMySettingsRequest {
    const form = this.settingsForm();
    return {
      theme: form.theme,
      locale: form.locale,
      notifications: {
        email: form.notificationEmail,
        classReminders: form.notificationClassReminders,
        chatMessages: form.notificationChatMessages,
        announcements: form.notificationAnnouncements,
        recordingReady: form.notificationRecordingReady
      },
      privacy: {
        showEmailOnPublicProfile: form.privacyShowEmail,
        allowTeacherMessages: form.privacyAllowTeacherMessages
      }
    };
  }

  private liveSettingsRequest(): LiveClassSettingsPatch {
    const form = this.liveSettingsForm();
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

  private formFromProfile(profile: ProfileUser): TeacherProfileForm {
    return {
      displayName: profile.displayName,
      phone: profile.phone ?? '',
      headline: profile.headline ?? '',
      bio: profile.bio ?? '',
      location: profile.location ?? '',
      timezone: profile.timezone ?? '',
      availability: profile.availability ?? '',
      languagesText: profile.languages.join(', '),
      skillsText: profile.skills.join(', '),
      credentialsText: this.serializeCredentials(profile.credentials),
      educationText: this.serializeCredentials(profile.education),
      experienceText: this.serializeExperience(profile.experience),
      socialLinksText: this.serializeSocialLinks(profile.socialLinks),
      publicProfileEnabled: Boolean(profile.publicProfileEnabled)
    };
  }

  private settingsFormFromProfile(settings: ProfileSettings): ProfileSettingsForm {
    return {
      theme: settings.theme,
      locale: settings.locale,
      notificationEmail: settings.notifications.email,
      notificationClassReminders: settings.notifications.classReminders,
      notificationChatMessages: settings.notifications.chatMessages,
      notificationAnnouncements: settings.notifications.announcements,
      notificationRecordingReady: settings.notifications.recordingReady,
      privacyShowEmail: settings.privacy.showEmailOnPublicProfile,
      privacyAllowTeacherMessages: settings.privacy.allowTeacherMessages
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

  private parseList(value: string): string[] {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseCredentials(value: string): ProfileCredential[] {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title = '', issuer = '', year = ''] = line.split('|').map((item) => item.trim());
        return { title, ...(issuer ? { issuer } : {}), ...(year ? { year } : {}) };
      })
      .filter((item) => Boolean(item.title));
  }

  private parseExperience(value: string): ProfileExperience[] {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [role = '', organization = '', period = '', summary = ''] = line.split('|').map((item) => item.trim());
        return { role, ...(organization ? { organization } : {}), ...(period ? { period } : {}), ...(summary ? { summary } : {}) };
      })
      .filter((item) => Boolean(item.role));
  }

  private parseSocialLinks(value: string): ProfileSocialLink[] {
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [label = '', url = ''] = line.split('|').map((item) => item.trim());
        return { label, url };
      })
      .filter((item) => Boolean(item.label && item.url));
  }

  private serializeCredentials(values: readonly ProfileCredential[]): string {
    return values.map((item) => [item.title, item.issuer, item.year].filter(Boolean).join(' | ')).join('\n');
  }

  private serializeExperience(values: readonly ProfileExperience[]): string {
    return values.map((item) => [item.role, item.organization, item.period, item.summary].filter(Boolean).join(' | ')).join('\n');
  }

  private serializeSocialLinks(values: readonly ProfileSocialLink[]): string {
    return values.map((item) => [item.label, item.url].filter(Boolean).join(' | ')).join('\n');
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
