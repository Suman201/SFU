import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type {
  BatchLiveClassSettingsResponse,
  LiveClassSettings,
  LiveClassSettingsPatch,
  ProfileBatchAssociation,
  ProfileCredential,
  ProfileExperience,
  ProfileMediaUploadResponse,
  ProfileSocialLink,
  ProfileSettings,
  ProfileUser,
  PublicTeacherProfile,
  TeacherLiveClassSettingsResponse,
  UpdateMyProfileRequest,
  UpdateMySettingsRequest
} from '@native-sfu/contracts';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  StudentEnrollmentDocument,
  StudentEnrollmentMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { UpdateMyProfileDto } from './dto/profile.dto';

export interface ProfileMediaUploadFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

export interface ProfileMediaDownload {
  stream: ReadStream;
  mimeType: string;
  size: number;
}

const PROFILE_MEDIA_MIME_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

const PROFILE_MEDIA_MAX_SIZE_BYTES = 2 * 1024 * 1024;
export const SYSTEM_LIVE_CLASS_SETTINGS: LiveClassSettings = {
  media: {
    studentsJoinMuted: true,
    studentsJoinCameraOff: true,
    requirePrejoinDeviceCheck: true,
    allowStudentsToUnmuteSelf: true,
    allowStudentsToStartCameraSelf: true
  },
  chat: {
    privateTeacherStudentChatEnabled: true,
    teacherBroadcastEnabled: true,
    chatAttachmentsEnabled: true,
    messageLengthLimit: 2000
  },
  whiteboard: {
    whiteboardSharingEnabled: true,
    studentWhiteboardControlEnabled: true,
    maxActiveWhiteboardControllers: 1
  },
  speaking: {
    handRaiseEnabled: true,
    maxActiveSpeakers: 3,
    autoLowerHandAfterSpeakPermissionEnds: true
  },
  recording: {
    recordingEnabled: true,
    autoRecordOnStart: false,
    teacherManualRecordingControlEnabled: true,
    visibility: 'enrolled_students'
  },
  attendance: {
    presentThresholdMinutes: 10,
    presentThresholdPercentage: 50,
    lateJoinThresholdMinutes: 10,
    countReconnects: true,
    teacherAttendanceExportEnabled: true
  },
  access: {
    waitingRoomEnabled: false,
    lockClassAfterTeacherStarts: false,
    allowEnrolledStudentReconnectAfterLock: true,
    teacherReconnectGraceMessagingEnabled: true
  },
  materials: {
    materialsEnabled: true,
    teacherCanUploadMaterials: true,
    studentsCanDownloadMaterials: true,
    publishMaterialsBeforeClass: false,
    publishMaterialsAfterClass: true,
    allowedMaterialTypes: ['pdf', 'image', 'document', 'slides', 'link', 'file'],
    maxMaterialFileSizeMb: 10
  },
  notifications: {
    classReminderEnabled: true,
    classReminderMinutesBefore: 30,
    notifyWhenTeacherStarts: true,
    notifyRecordingAvailable: true,
    notifyNewMaterialUploaded: true,
    notifyMissedClass: false
  },
  questionQueue: {
    questionQueueEnabled: true,
    allowAnonymousQuestions: false,
    allowStudentUpvotes: true,
    teacherCanMarkAnswered: true,
    maxOpenQuestionsPerStudent: 3
  },
  recordingRetention: {
    recordingRetentionDays: 30,
    allowTeacherPublishRecording: false,
    allowStudentsDownloadRecording: true,
    autoArchiveExpiredRecordings: true
  },
  studentScreenShare: {
    studentScreenShareEnabled: false,
    studentScreenShareRequiresApproval: true,
    maxActiveStudentShares: 1
  },
  advancedAnalytics: {
    analyticsEnabled: true,
    trackEngagementEvents: true,
    trackMediaQuality: true,
    trackChatParticipation: true,
    trackWhiteboardParticipation: true,
    trackQuestionParticipation: true,
    analyticsVisibility: 'admin_and_teacher'
  },
  inactiveDetection: {
    inactiveDetectionEnabled: false,
    inactiveAfterMinutes: 10,
    countBackgroundTabAsInactive: true,
    countMutedNoCameraAsInactive: false,
    notifyTeacherOnInactiveStudents: true,
    includeInactiveTimeInAttendance: false
  },
  bandwidthPolicy: {
    adaptiveQualityEnabled: true,
    lowBandwidthModeEnabled: false,
    maxStudentVideoQuality: 'auto',
    maxScreenShareQuality: 'auto',
    disableStudentVideoOnPoorNetwork: false,
    preferAudioOnPoorNetwork: true,
    showNetworkWarnings: true
  },
  exportControls: {
    exportControlsEnabled: true,
    allowAttendanceExport: true,
    allowChatExport: false,
    allowQuestionExport: false,
    allowRecordingDownload: true,
    includePrivateChatInExports: false,
    anonymizeStudentExports: false,
    exportRetentionDays: 365,
    requireExportAuditLog: true
  }
};
const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  theme: 'system',
  locale: 'en-US',
  notifications: {
    email: true,
    classReminders: true,
    chatMessages: true,
    announcements: true,
    recordingReady: true
  },
  privacy: {
    showEmailOnPublicProfile: false,
    allowTeacherMessages: true
  },
  liveClassDefaults: SYSTEM_LIVE_CLASS_SETTINGS
};
const STUDENT_UPDATE_FIELDS = new Set<keyof UpdateMyProfileRequest>([
  'displayName',
  'phone',
  'avatarUrl',
  'location',
  'timezone',
  'languages',
  'learningGoals',
  'interests'
]);

@Injectable()
export class ProfilesService {
  constructor(
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name) private readonly enrollments: Model<StudentEnrollmentMongoDocument>,
    private readonly config: ConfigService
  ) {}

  async getMyProfile(user: AuthenticatedUser): Promise<ProfileUser> {
    const doc = await this.findActiveUser(user.sub);
    return this.toProfileUser(doc);
  }

  async updateMyProfile(user: AuthenticatedUser, request: UpdateMyProfileDto): Promise<ProfileUser> {
    const doc = await this.findActiveUser(user.sub);
    const roles = this.normalizedRoles(doc.roles);
    const isTeacher = this.isTeacherRole(roles);
    if (!isTeacher) {
      this.assertStudentUpdateOnly(request);
    }

    const update = this.profileUpdate(request, isTeacher);
    if (Object.keys(update).length) {
      Object.assign(doc, update);
      await doc.save();
    }
    return this.toProfileUser(doc);
  }

  async updateMySettings(user: AuthenticatedUser, request: UpdateMySettingsRequest): Promise<ProfileUser> {
    const doc = await this.findActiveUser(user.sub);
    const current = this.settings(doc.settings);
    const settings = this.normalizeSettings({
      theme: request.theme ?? current.theme,
      locale: request.locale ?? current.locale,
      notifications: { ...current.notifications, ...request.notifications },
      privacy: { ...current.privacy, ...request.privacy }
    });
    doc.settings = settings as UserMongoDocument['settings'];
    await doc.save();
    return this.toProfileUser(doc);
  }

  async getTeacherLiveSettings(user: AuthenticatedUser): Promise<TeacherLiveClassSettingsResponse> {
    const doc = await this.findActiveUser(user.sub);
    this.assertCanManageLiveSettings(doc);
    return {
      systemDefaults: this.cloneLiveSettings(SYSTEM_LIVE_CLASS_SETTINGS),
      settings: this.teacherLiveSettings(doc)
    };
  }

  async updateTeacherLiveSettings(user: AuthenticatedUser, request: LiveClassSettingsPatch): Promise<TeacherLiveClassSettingsResponse> {
    const doc = await this.findActiveUser(user.sub);
    this.assertCanManageLiveSettings(doc);
    const current = this.teacherLiveSettings(doc);
    const settings = this.resolveLiveSettings(current, this.normalizeLiveSettingsPatch(request));
    doc.settings = {
      ...this.settings(doc.settings),
      liveClassDefaults: settings
    } as UserMongoDocument['settings'];
    await doc.save();
    return {
      systemDefaults: this.cloneLiveSettings(SYSTEM_LIVE_CLASS_SETTINGS),
      settings
    };
  }

  async resolveBatchLiveSettings(batch: Pick<BatchMongoDocument, 'id' | 'teacherId' | 'liveSettingsOverrides'>): Promise<BatchLiveClassSettingsResponse> {
    const teacher = await this.users
      .findOne({ _id: batch.teacherId, deletedAt: { $exists: false }, disabled: false })
      .exec();
    const teacherDefaults = teacher ? this.teacherLiveSettings(teacher) : this.cloneLiveSettings(SYSTEM_LIVE_CLASS_SETTINGS);
    const overrides = this.normalizeLiveSettingsPatch(batch.liveSettingsOverrides);
    return {
      batchId: batch.id,
      teacherId: batch.teacherId,
      systemDefaults: this.cloneLiveSettings(SYSTEM_LIVE_CLASS_SETTINGS),
      teacherDefaults,
      overrides,
      resolved: this.resolveLiveSettings(teacherDefaults, overrides)
    };
  }

  async resolveLiveSessionSettings(teacherId: string, batchId: string): Promise<LiveClassSettings> {
    const batch = await this.batches
      .findOne({ _id: batchId, teacherId, deletedAt: { $exists: false } })
      .exec();
    if (!batch) {
      throw new NotFoundException('Batch not found');
    }
    return (await this.resolveBatchLiveSettings(batch)).resolved;
  }

  resolveLiveSettings(base: LiveClassSettings, patch: LiveClassSettingsPatch | undefined): LiveClassSettings {
    return this.normalizeLiveSettings({
      media: { ...base.media, ...patch?.media },
      chat: { ...base.chat, ...patch?.chat },
      whiteboard: { ...base.whiteboard, ...patch?.whiteboard },
      speaking: { ...base.speaking, ...patch?.speaking },
      recording: { ...base.recording, ...patch?.recording },
      attendance: { ...base.attendance, ...patch?.attendance },
      access: { ...base.access, ...patch?.access },
      materials: { ...base.materials, ...patch?.materials },
      notifications: { ...base.notifications, ...patch?.notifications },
      questionQueue: { ...base.questionQueue, ...patch?.questionQueue },
      recordingRetention: { ...base.recordingRetention, ...patch?.recordingRetention },
      studentScreenShare: { ...base.studentScreenShare, ...patch?.studentScreenShare },
      advancedAnalytics: { ...base.advancedAnalytics, ...patch?.advancedAnalytics },
      inactiveDetection: { ...base.inactiveDetection, ...patch?.inactiveDetection },
      bandwidthPolicy: { ...base.bandwidthPolicy, ...patch?.bandwidthPolicy },
      exportControls: { ...base.exportControls, ...patch?.exportControls }
    });
  }

  async getPublicTeacherProfile(teacherId: string): Promise<PublicTeacherProfile> {
    const teacher = await this.users
      .findOne({
        _id: teacherId,
        deletedAt: { $exists: false },
        disabled: false,
        status: 'active',
        roles: 'TEACHER',
        publicProfileEnabled: true
      })
      .exec();
    if (!teacher) {
      throw new NotFoundException('Teacher profile is not available.');
    }
    return {
      id: teacher.id,
      displayName: teacher.displayName || teacher.name || 'Teacher',
      ...(teacher.headline ? { headline: teacher.headline } : {}),
      ...(teacher.bio ? { bio: teacher.bio } : {}),
      ...(teacher.avatarUrl ? { avatarUrl: teacher.avatarUrl } : {}),
      ...(teacher.coverImageUrl ? { coverImageUrl: teacher.coverImageUrl } : {}),
      ...(teacher.location ? { location: teacher.location } : {}),
      ...(teacher.timezone ? { timezone: teacher.timezone } : {}),
      languages: this.stringArray(teacher.languages),
      skills: this.stringArray(teacher.skills),
      credentials: this.credentials(teacher.credentials),
      education: this.credentials(teacher.education),
      experience: this.experience(teacher.experience),
      socialLinks: this.socialLinks(teacher.socialLinks),
      ...(teacher.availability ? { availability: teacher.availability } : {}),
      batches: await this.teacherBatchAssociations(teacher.id, { publicOnly: true })
    };
  }

  async uploadProfileMedia(
    user: AuthenticatedUser,
    field: ProfileMediaUploadResponse['field'],
    file: ProfileMediaUploadFile | undefined
  ): Promise<ProfileMediaUploadResponse> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Profile image upload is empty.');
    }
    const mimeType = file.mimetype?.trim().toLowerCase();
    const extension = mimeType ? PROFILE_MEDIA_MIME_TYPES.get(mimeType) : undefined;
    if (!mimeType || !extension) {
      throw new BadRequestException('Only JPEG, PNG, GIF, and WebP profile images are allowed.');
    }
    if ((file.size ?? file.buffer.length) > this.profileMediaMaxFileSizeBytes()) {
      throw new BadRequestException('Profile images cannot exceed 2 MB.');
    }

    const doc = await this.findActiveUser(user.sub);
    if (field === 'coverImageUrl' && !this.isTeacherRole(this.normalizedRoles(doc.roles))) {
      throw new ForbiddenException('Only teacher profiles can use cover images.');
    }
    const directory = join(this.profileMediaStorageRoot(), this.safeStorageSegment(doc.id));
    await mkdir(directory, { recursive: true });
    const fileName = `${field}-${Date.now()}-${randomUUID()}.${extension}`;
    await writeFile(join(directory, fileName), file.buffer);
    const url = this.profileMediaUrl(doc.id, fileName);
    doc[field] = url;
    await doc.save();
    return { field, url };
  }

  async readProfileMedia(userId: string, fileName: string): Promise<ProfileMediaDownload> {
    const safeUserId = this.safeStorageSegment(userId);
    const safeFileName = this.safeStorageSegment(fileName);
    if (safeUserId !== userId || safeFileName !== fileName || !this.profileMediaMimeTypeForFile(fileName)) {
      throw new NotFoundException('Profile media not found.');
    }
    const path = join(this.profileMediaStorageRoot(), safeUserId, safeFileName);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch {
      throw new NotFoundException('Profile media not found.');
    }
    if (!fileStat.isFile()) {
      throw new NotFoundException('Profile media not found.');
    }
    return {
      stream: createReadStream(path),
      mimeType: this.profileMediaMimeTypeForFile(fileName) ?? 'application/octet-stream',
      size: fileStat.size
    };
  }

  private async toProfileUser(user: UserMongoDocument): Promise<ProfileUser> {
    const roles = this.normalizedRoles(user.roles);
    const primaryRole = this.isTeacherRole(roles) ? 'teacher' : 'student';
    return {
      id: user.id,
      email: user.email,
      ...(user.phone ? { phone: user.phone } : {}),
      roles,
      primaryRole,
      displayName: user.displayName || user.name || 'User',
      ...(user.headline ? { headline: user.headline } : {}),
      ...(user.bio ? { bio: user.bio } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      ...(user.coverImageUrl ? { coverImageUrl: user.coverImageUrl } : {}),
      ...(user.location ? { location: user.location } : {}),
      ...(user.timezone ? { timezone: user.timezone } : {}),
      languages: this.stringArray(user.languages),
      skills: primaryRole === 'teacher' ? this.stringArray(user.skills) : [],
      credentials: primaryRole === 'teacher' ? this.credentials(user.credentials) : [],
      education: primaryRole === 'teacher' ? this.credentials(user.education) : [],
      experience: primaryRole === 'teacher' ? this.experience(user.experience) : [],
      socialLinks: primaryRole === 'teacher' ? this.socialLinks(user.socialLinks) : [],
      ...(primaryRole === 'teacher' && user.availability ? { availability: user.availability } : {}),
      ...(primaryRole === 'teacher' ? { publicProfileEnabled: Boolean(user.publicProfileEnabled) } : {}),
      learningGoals: primaryRole === 'student' ? this.stringArray(user.learningGoals) : [],
      interests: primaryRole === 'student' ? this.stringArray(user.interests) : [],
      settings: this.settings(user.settings),
      batches:
        primaryRole === 'teacher'
          ? await this.teacherBatchAssociations(user.id, { publicOnly: false })
          : await this.studentBatchAssociations(user.id)
    };
  }

  private profileUpdate(request: UpdateMyProfileDto, isTeacher: boolean): Partial<UserDocument> {
    const update: Partial<UserDocument> = {};
    if (request.displayName !== undefined) {
      update.displayName = this.requiredTrim(request.displayName, 'Display name');
      update.name = update.displayName;
    }
    if (request.phone !== undefined) update.phone = this.optionalTrim(request.phone);
    if (request.avatarUrl !== undefined) update.avatarUrl = this.normalizeMediaUrl(request.avatarUrl, 'Avatar URL');
    if (request.location !== undefined) update.location = this.optionalTrim(request.location);
    if (request.timezone !== undefined) update.timezone = this.optionalTrim(request.timezone);
    if (request.languages !== undefined) update.languages = this.normalizeStringArray(request.languages, 12, 60);

    if (isTeacher) {
      if (request.headline !== undefined) update.headline = this.optionalTrim(request.headline);
      if (request.bio !== undefined) update.bio = this.optionalTrim(request.bio);
      if (request.coverImageUrl !== undefined) update.coverImageUrl = this.normalizeMediaUrl(request.coverImageUrl, 'Cover image URL');
      if (request.skills !== undefined) update.skills = this.normalizeStringArray(request.skills, 16, 80);
      if (request.credentials !== undefined) update.credentials = this.normalizeCredentials(request.credentials, 12);
      if (request.education !== undefined) update.education = this.normalizeCredentials(request.education, 8);
      if (request.experience !== undefined) update.experience = this.normalizeExperience(request.experience, 8);
      if (request.socialLinks !== undefined) update.socialLinks = this.normalizeSocialLinks(request.socialLinks, 8);
      if (request.availability !== undefined) update.availability = this.optionalTrim(request.availability);
      if (request.publicProfileEnabled !== undefined) update.publicProfileEnabled = Boolean(request.publicProfileEnabled);
      if (request.learningGoals !== undefined) update.learningGoals = this.normalizeStringArray(request.learningGoals, 8, 120);
      if (request.interests !== undefined) update.interests = this.normalizeStringArray(request.interests, 12, 80);
    } else {
      if (request.learningGoals !== undefined) update.learningGoals = this.normalizeStringArray(request.learningGoals, 8, 120);
      if (request.interests !== undefined) update.interests = this.normalizeStringArray(request.interests, 12, 80);
    }
    return update;
  }

  private assertStudentUpdateOnly(request: UpdateMyProfileDto): void {
    const blocked = Object.keys(request).filter((key) => !STUDENT_UPDATE_FIELDS.has(key as keyof UpdateMyProfileRequest));
    if (blocked.length) {
      throw new ForbiddenException('Student profiles cannot update teacher-only public profile fields.');
    }
  }

  private assertCanManageLiveSettings(user: UserMongoDocument): void {
    if (!this.isTeacherRole(this.normalizedRoles(user.roles))) {
      throw new ForbiddenException('Only teachers can update live class defaults.');
    }
  }

  private normalizeSettings(request: UpdateMySettingsRequest): ProfileSettings {
    const current = this.settings(request as Partial<ProfileSettings>);
    return {
      theme: request.theme === 'light' || request.theme === 'dark' || request.theme === 'system' ? request.theme : current.theme,
      locale: this.normalizeLocale(request.locale ?? current.locale),
      notifications: {
        email: this.booleanSetting(request.notifications?.email, current.notifications.email),
        classReminders: this.booleanSetting(request.notifications?.classReminders, current.notifications.classReminders),
        chatMessages: this.booleanSetting(request.notifications?.chatMessages, current.notifications.chatMessages),
        announcements: this.booleanSetting(request.notifications?.announcements, current.notifications.announcements),
        recordingReady: this.booleanSetting(request.notifications?.recordingReady, current.notifications.recordingReady)
      },
      privacy: {
        showEmailOnPublicProfile: this.booleanSetting(request.privacy?.showEmailOnPublicProfile, current.privacy.showEmailOnPublicProfile),
        allowTeacherMessages: this.booleanSetting(request.privacy?.allowTeacherMessages, current.privacy.allowTeacherMessages)
      },
      liveClassDefaults: request.liveClassDefaults
        ? this.resolveLiveSettings(current.liveClassDefaults ?? SYSTEM_LIVE_CLASS_SETTINGS, this.normalizeLiveSettingsPatch(request.liveClassDefaults))
        : current.liveClassDefaults
    };
  }

  private settings(value: unknown): ProfileSettings {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const notifications =
      record.notifications && typeof record.notifications === 'object'
        ? (record.notifications as Record<string, unknown>)
        : {};
    const privacy = record.privacy && typeof record.privacy === 'object' ? (record.privacy as Record<string, unknown>) : {};
    const theme = record.theme === 'light' || record.theme === 'dark' || record.theme === 'system' ? record.theme : DEFAULT_PROFILE_SETTINGS.theme;
    return {
      theme,
      locale: this.normalizeLocale(typeof record.locale === 'string' ? record.locale : DEFAULT_PROFILE_SETTINGS.locale),
      notifications: {
        email: this.booleanSetting(notifications.email, DEFAULT_PROFILE_SETTINGS.notifications.email),
        classReminders: this.booleanSetting(notifications.classReminders, DEFAULT_PROFILE_SETTINGS.notifications.classReminders),
        chatMessages: this.booleanSetting(notifications.chatMessages, DEFAULT_PROFILE_SETTINGS.notifications.chatMessages),
        announcements: this.booleanSetting(notifications.announcements, DEFAULT_PROFILE_SETTINGS.notifications.announcements),
        recordingReady: this.booleanSetting(notifications.recordingReady, DEFAULT_PROFILE_SETTINGS.notifications.recordingReady)
      },
      privacy: {
        showEmailOnPublicProfile: this.booleanSetting(privacy.showEmailOnPublicProfile, DEFAULT_PROFILE_SETTINGS.privacy.showEmailOnPublicProfile),
        allowTeacherMessages: this.booleanSetting(privacy.allowTeacherMessages, DEFAULT_PROFILE_SETTINGS.privacy.allowTeacherMessages)
      },
      liveClassDefaults: this.normalizeLiveSettings(record.liveClassDefaults)
    };
  }

  private teacherLiveSettings(user: Pick<UserMongoDocument, 'settings'>): LiveClassSettings {
    return this.settings(user.settings).liveClassDefaults ?? this.cloneLiveSettings(SYSTEM_LIVE_CLASS_SETTINGS);
  }

  private normalizeLiveSettings(value: unknown): LiveClassSettings {
    const record = this.unknownRecord(value);
    const media = this.unknownRecord(record.media);
    const chat = this.unknownRecord(record.chat);
    const whiteboard = this.unknownRecord(record.whiteboard);
    const speaking = this.unknownRecord(record.speaking);
    const recording = this.unknownRecord(record.recording);
    const attendance = this.unknownRecord(record.attendance);
    const access = this.unknownRecord(record.access);
    const materials = this.unknownRecord(record.materials);
    const notifications = this.unknownRecord(record.notifications);
    const questionQueue = this.unknownRecord(record.questionQueue);
    const recordingRetention = this.unknownRecord(record.recordingRetention);
    const studentScreenShare = this.unknownRecord(record.studentScreenShare);
    const advancedAnalytics = this.unknownRecord(record.advancedAnalytics);
    const inactiveDetection = this.unknownRecord(record.inactiveDetection);
    const bandwidthPolicy = this.unknownRecord(record.bandwidthPolicy);
    const exportControls = this.unknownRecord(record.exportControls);
    const recordingVisibility = this.recordingVisibility(recording.visibility ?? recording.recordingVisibility);
    const analyticsVisibility = this.analyticsVisibility(advancedAnalytics.analyticsVisibility);
    const maxStudentVideoQuality = this.studentVideoQualityLimit(bandwidthPolicy.maxStudentVideoQuality);
    const maxScreenShareQuality = this.screenShareQualityLimit(bandwidthPolicy.maxScreenShareQuality);
    return {
      media: {
        studentsJoinMuted: this.booleanSetting(media.studentsJoinMuted, SYSTEM_LIVE_CLASS_SETTINGS.media.studentsJoinMuted),
        studentsJoinCameraOff: this.booleanSetting(media.studentsJoinCameraOff, SYSTEM_LIVE_CLASS_SETTINGS.media.studentsJoinCameraOff),
        requirePrejoinDeviceCheck: this.booleanSetting(media.requirePrejoinDeviceCheck, SYSTEM_LIVE_CLASS_SETTINGS.media.requirePrejoinDeviceCheck),
        allowStudentsToUnmuteSelf: this.booleanSetting(media.allowStudentsToUnmuteSelf, SYSTEM_LIVE_CLASS_SETTINGS.media.allowStudentsToUnmuteSelf),
        allowStudentsToStartCameraSelf: this.booleanSetting(media.allowStudentsToStartCameraSelf, SYSTEM_LIVE_CLASS_SETTINGS.media.allowStudentsToStartCameraSelf)
      },
      chat: {
        privateTeacherStudentChatEnabled: this.booleanSetting(
          chat.privateTeacherStudentChatEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.chat.privateTeacherStudentChatEnabled
        ),
        teacherBroadcastEnabled: this.booleanSetting(chat.teacherBroadcastEnabled, SYSTEM_LIVE_CLASS_SETTINGS.chat.teacherBroadcastEnabled),
        chatAttachmentsEnabled: this.booleanSetting(chat.chatAttachmentsEnabled, SYSTEM_LIVE_CLASS_SETTINGS.chat.chatAttachmentsEnabled),
        messageLengthLimit: this.integerSetting(chat.messageLengthLimit, SYSTEM_LIVE_CLASS_SETTINGS.chat.messageLengthLimit, 200, 5000)
      },
      whiteboard: {
        whiteboardSharingEnabled: this.booleanSetting(whiteboard.whiteboardSharingEnabled, SYSTEM_LIVE_CLASS_SETTINGS.whiteboard.whiteboardSharingEnabled),
        studentWhiteboardControlEnabled: this.booleanSetting(
          whiteboard.studentWhiteboardControlEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.whiteboard.studentWhiteboardControlEnabled
        ),
        maxActiveWhiteboardControllers: this.integerSetting(
          whiteboard.maxActiveWhiteboardControllers,
          SYSTEM_LIVE_CLASS_SETTINGS.whiteboard.maxActiveWhiteboardControllers,
          1,
          5
        )
      },
      speaking: {
        handRaiseEnabled: this.booleanSetting(speaking.handRaiseEnabled, SYSTEM_LIVE_CLASS_SETTINGS.speaking.handRaiseEnabled),
        maxActiveSpeakers: this.integerSetting(speaking.maxActiveSpeakers, SYSTEM_LIVE_CLASS_SETTINGS.speaking.maxActiveSpeakers, 1, 10),
        autoLowerHandAfterSpeakPermissionEnds: this.booleanSetting(
          speaking.autoLowerHandAfterSpeakPermissionEnds,
          SYSTEM_LIVE_CLASS_SETTINGS.speaking.autoLowerHandAfterSpeakPermissionEnds
        )
      },
      recording: {
        recordingEnabled: this.booleanSetting(
          recording.recordingEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.recording.recordingEnabled,
          recording.enabled
        ),
        autoRecordOnStart: this.booleanSetting(recording.autoRecordOnStart, SYSTEM_LIVE_CLASS_SETTINGS.recording.autoRecordOnStart),
        teacherManualRecordingControlEnabled: this.booleanSetting(
          recording.teacherManualRecordingControlEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.recording.teacherManualRecordingControlEnabled,
          recording.teacherCanRecordManually
        ),
        visibility: recordingVisibility ?? SYSTEM_LIVE_CLASS_SETTINGS.recording.visibility
      },
      attendance: {
        presentThresholdMinutes: this.integerSetting(
          attendance.presentThresholdMinutes,
          SYSTEM_LIVE_CLASS_SETTINGS.attendance.presentThresholdMinutes,
          0,
          240
        ),
        presentThresholdPercentage: this.integerSetting(
          attendance.presentThresholdPercentage,
          SYSTEM_LIVE_CLASS_SETTINGS.attendance.presentThresholdPercentage,
          0,
          100
        ),
        lateJoinThresholdMinutes: this.integerSetting(
          attendance.lateJoinThresholdMinutes,
          SYSTEM_LIVE_CLASS_SETTINGS.attendance.lateJoinThresholdMinutes,
          0,
          120
        ),
        countReconnects: this.booleanSetting(attendance.countReconnects, SYSTEM_LIVE_CLASS_SETTINGS.attendance.countReconnects),
        teacherAttendanceExportEnabled: this.booleanSetting(
          attendance.teacherAttendanceExportEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.attendance.teacherAttendanceExportEnabled
        )
      },
      access: {
        waitingRoomEnabled: this.booleanSetting(access.waitingRoomEnabled, SYSTEM_LIVE_CLASS_SETTINGS.access.waitingRoomEnabled),
        lockClassAfterTeacherStarts: this.booleanSetting(access.lockClassAfterTeacherStarts, SYSTEM_LIVE_CLASS_SETTINGS.access.lockClassAfterTeacherStarts),
        allowEnrolledStudentReconnectAfterLock: this.booleanSetting(
          access.allowEnrolledStudentReconnectAfterLock,
          SYSTEM_LIVE_CLASS_SETTINGS.access.allowEnrolledStudentReconnectAfterLock
        ),
        teacherReconnectGraceMessagingEnabled: this.booleanSetting(
          access.teacherReconnectGraceMessagingEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.access.teacherReconnectGraceMessagingEnabled
        )
      },
      materials: {
        materialsEnabled: this.booleanSetting(materials.materialsEnabled, SYSTEM_LIVE_CLASS_SETTINGS.materials.materialsEnabled),
        teacherCanUploadMaterials: this.booleanSetting(
          materials.teacherCanUploadMaterials,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.teacherCanUploadMaterials
        ),
        studentsCanDownloadMaterials: this.booleanSetting(
          materials.studentsCanDownloadMaterials,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.studentsCanDownloadMaterials
        ),
        publishMaterialsBeforeClass: this.booleanSetting(
          materials.publishMaterialsBeforeClass,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.publishMaterialsBeforeClass
        ),
        publishMaterialsAfterClass: this.booleanSetting(
          materials.publishMaterialsAfterClass,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.publishMaterialsAfterClass
        ),
        allowedMaterialTypes: this.materialTypesSetting(
          materials.allowedMaterialTypes,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.allowedMaterialTypes
        ),
        maxMaterialFileSizeMb: this.integerSetting(
          materials.maxMaterialFileSizeMb,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.maxMaterialFileSizeMb,
          1,
          100
        )
      },
      notifications: {
        classReminderEnabled: this.booleanSetting(
          notifications.classReminderEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.classReminderEnabled
        ),
        classReminderMinutesBefore: this.integerSetting(
          notifications.classReminderMinutesBefore,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.classReminderMinutesBefore,
          0,
          1440
        ),
        notifyWhenTeacherStarts: this.booleanSetting(
          notifications.notifyWhenTeacherStarts,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.notifyWhenTeacherStarts
        ),
        notifyRecordingAvailable: this.booleanSetting(
          notifications.notifyRecordingAvailable,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.notifyRecordingAvailable
        ),
        notifyNewMaterialUploaded: this.booleanSetting(
          notifications.notifyNewMaterialUploaded,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.notifyNewMaterialUploaded
        ),
        notifyMissedClass: this.booleanSetting(notifications.notifyMissedClass, SYSTEM_LIVE_CLASS_SETTINGS.notifications.notifyMissedClass)
      },
      questionQueue: {
        questionQueueEnabled: this.booleanSetting(
          questionQueue.questionQueueEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.questionQueueEnabled
        ),
        allowAnonymousQuestions: this.booleanSetting(
          questionQueue.allowAnonymousQuestions,
          SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.allowAnonymousQuestions
        ),
        allowStudentUpvotes: this.booleanSetting(questionQueue.allowStudentUpvotes, SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.allowStudentUpvotes),
        teacherCanMarkAnswered: this.booleanSetting(
          questionQueue.teacherCanMarkAnswered,
          SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.teacherCanMarkAnswered
        ),
        maxOpenQuestionsPerStudent: this.integerSetting(
          questionQueue.maxOpenQuestionsPerStudent,
          SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.maxOpenQuestionsPerStudent,
          1,
          20
        )
      },
      recordingRetention: {
        recordingRetentionDays: this.integerSetting(
          recordingRetention.recordingRetentionDays,
          SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention.recordingRetentionDays,
          1,
          3650
        ),
        allowTeacherPublishRecording: this.booleanSetting(
          recordingRetention.allowTeacherPublishRecording,
          SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention.allowTeacherPublishRecording
        ),
        allowStudentsDownloadRecording: this.booleanSetting(
          recordingRetention.allowStudentsDownloadRecording,
          SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention.allowStudentsDownloadRecording
        ),
        autoArchiveExpiredRecordings: this.booleanSetting(
          recordingRetention.autoArchiveExpiredRecordings,
          SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention.autoArchiveExpiredRecordings
        )
      },
      studentScreenShare: {
        studentScreenShareEnabled: this.booleanSetting(
          studentScreenShare.studentScreenShareEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare.studentScreenShareEnabled
        ),
        studentScreenShareRequiresApproval: this.booleanSetting(
          studentScreenShare.studentScreenShareRequiresApproval,
          SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare.studentScreenShareRequiresApproval
        ),
        maxActiveStudentShares: this.integerSetting(
          studentScreenShare.maxActiveStudentShares,
          SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare.maxActiveStudentShares,
          1,
          4
        )
      },
      advancedAnalytics: {
        analyticsEnabled: this.booleanSetting(
          advancedAnalytics.analyticsEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.analyticsEnabled
        ),
        trackEngagementEvents: this.booleanSetting(
          advancedAnalytics.trackEngagementEvents,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.trackEngagementEvents
        ),
        trackMediaQuality: this.booleanSetting(
          advancedAnalytics.trackMediaQuality,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.trackMediaQuality
        ),
        trackChatParticipation: this.booleanSetting(
          advancedAnalytics.trackChatParticipation,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.trackChatParticipation
        ),
        trackWhiteboardParticipation: this.booleanSetting(
          advancedAnalytics.trackWhiteboardParticipation,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.trackWhiteboardParticipation
        ),
        trackQuestionParticipation: this.booleanSetting(
          advancedAnalytics.trackQuestionParticipation,
          SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.trackQuestionParticipation
        ),
        analyticsVisibility: analyticsVisibility ?? SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics.analyticsVisibility
      },
      inactiveDetection: {
        inactiveDetectionEnabled: this.booleanSetting(
          inactiveDetection.inactiveDetectionEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.inactiveDetectionEnabled
        ),
        inactiveAfterMinutes: this.integerSetting(
          inactiveDetection.inactiveAfterMinutes,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.inactiveAfterMinutes,
          1,
          240
        ),
        countBackgroundTabAsInactive: this.booleanSetting(
          inactiveDetection.countBackgroundTabAsInactive,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.countBackgroundTabAsInactive
        ),
        countMutedNoCameraAsInactive: this.booleanSetting(
          inactiveDetection.countMutedNoCameraAsInactive,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.countMutedNoCameraAsInactive
        ),
        notifyTeacherOnInactiveStudents: this.booleanSetting(
          inactiveDetection.notifyTeacherOnInactiveStudents,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.notifyTeacherOnInactiveStudents
        ),
        includeInactiveTimeInAttendance: this.booleanSetting(
          inactiveDetection.includeInactiveTimeInAttendance,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.includeInactiveTimeInAttendance
        )
      },
      bandwidthPolicy: {
        adaptiveQualityEnabled: this.booleanSetting(
          bandwidthPolicy.adaptiveQualityEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.adaptiveQualityEnabled
        ),
        lowBandwidthModeEnabled: this.booleanSetting(
          bandwidthPolicy.lowBandwidthModeEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.lowBandwidthModeEnabled
        ),
        maxStudentVideoQuality: maxStudentVideoQuality ?? SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.maxStudentVideoQuality,
        maxScreenShareQuality: maxScreenShareQuality ?? SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.maxScreenShareQuality,
        disableStudentVideoOnPoorNetwork: this.booleanSetting(
          bandwidthPolicy.disableStudentVideoOnPoorNetwork,
          SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.disableStudentVideoOnPoorNetwork
        ),
        preferAudioOnPoorNetwork: this.booleanSetting(
          bandwidthPolicy.preferAudioOnPoorNetwork,
          SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.preferAudioOnPoorNetwork
        ),
        showNetworkWarnings: this.booleanSetting(
          bandwidthPolicy.showNetworkWarnings,
          SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy.showNetworkWarnings
        )
      },
      exportControls: {
        exportControlsEnabled: this.booleanSetting(
          exportControls.exportControlsEnabled,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.exportControlsEnabled
        ),
        allowAttendanceExport: this.booleanSetting(
          exportControls.allowAttendanceExport,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.allowAttendanceExport
        ),
        allowChatExport: this.booleanSetting(exportControls.allowChatExport, SYSTEM_LIVE_CLASS_SETTINGS.exportControls.allowChatExport),
        allowQuestionExport: this.booleanSetting(exportControls.allowQuestionExport, SYSTEM_LIVE_CLASS_SETTINGS.exportControls.allowQuestionExport),
        allowRecordingDownload: this.booleanSetting(
          exportControls.allowRecordingDownload,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.allowRecordingDownload
        ),
        includePrivateChatInExports: this.booleanSetting(
          exportControls.includePrivateChatInExports,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.includePrivateChatInExports
        ),
        anonymizeStudentExports: this.booleanSetting(
          exportControls.anonymizeStudentExports,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.anonymizeStudentExports
        ),
        exportRetentionDays: this.integerSetting(
          exportControls.exportRetentionDays,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.exportRetentionDays,
          1,
          3650
        ),
        requireExportAuditLog: this.booleanSetting(
          exportControls.requireExportAuditLog,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.requireExportAuditLog
        )
      }
    };
  }

  normalizeLiveSettingsPatch(value: unknown): LiveClassSettingsPatch {
    const record = this.unknownRecord(value);
    const patch: LiveClassSettingsPatch = {};
    const maybeSet = <K extends keyof LiveClassSettingsPatch>(key: K, normalizer: (value: unknown) => NonNullable<LiveClassSettingsPatch[K]>): void => {
      if (record[key] !== undefined && record[key] !== null && typeof record[key] === 'object') {
        patch[key] = normalizer(record[key]) as LiveClassSettingsPatch[K];
      }
    };
    maybeSet('media', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.media, ['studentsJoinMuted', 'studentsJoinCameraOff', 'requirePrejoinDeviceCheck']);
      this.maybeBooleanAlias(normalized, 'allowStudentsToUnmuteSelf', source.allowStudentsToUnmuteSelf ?? source.allowStudentSelfUnmute);
      this.maybeBooleanAlias(normalized, 'allowStudentsToStartCameraSelf', source.allowStudentsToStartCameraSelf ?? source.allowStudentSelfCameraOn);
      return normalized;
    });
    maybeSet('chat', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.chat, [
        'teacherBroadcastEnabled',
        'chatAttachmentsEnabled'
      ]);
      this.maybeBooleanAlias(normalized, 'privateTeacherStudentChatEnabled', source.privateTeacherStudentChatEnabled ?? source.privateChatEnabled);
      if (source.messageLengthLimit !== undefined || source.chatMaxMessageLength !== undefined) {
        normalized.messageLengthLimit = this.integerSetting(source.messageLengthLimit ?? source.chatMaxMessageLength, SYSTEM_LIVE_CLASS_SETTINGS.chat.messageLengthLimit, 200, 5000);
      }
      return normalized;
    });
    maybeSet('whiteboard', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.whiteboard, [
        'whiteboardSharingEnabled',
        'studentWhiteboardControlEnabled'
      ]);
      if (source.maxActiveWhiteboardControllers !== undefined || source.maxWhiteboardControllers !== undefined) {
        normalized.maxActiveWhiteboardControllers = this.integerSetting(
          source.maxActiveWhiteboardControllers ?? source.maxWhiteboardControllers,
          SYSTEM_LIVE_CLASS_SETTINGS.whiteboard.maxActiveWhiteboardControllers,
          1,
          5
        );
      }
      return normalized;
    });
    maybeSet('speaking', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.speaking, ['handRaiseEnabled', 'autoLowerHandAfterSpeakPermissionEnds']);
      if (source.maxActiveSpeakers !== undefined) {
        normalized.maxActiveSpeakers = this.integerSetting(source.maxActiveSpeakers, SYSTEM_LIVE_CLASS_SETTINGS.speaking.maxActiveSpeakers, 1, 10);
      }
      return normalized;
    });
    maybeSet('recording', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.recording, ['recordingEnabled', 'autoRecordOnStart']);
      this.maybeBooleanAlias(normalized, 'teacherManualRecordingControlEnabled', source.teacherManualRecordingControlEnabled ?? source.teacherCanRecordManually);
      const visibility = this.recordingVisibility(source.visibility ?? source.recordingVisibility);
      if (visibility) {
        normalized.visibility = visibility;
      }
      return normalized;
    });
    maybeSet('attendance', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.attendance, ['countReconnects', 'teacherAttendanceExportEnabled']);
      if (source.presentThresholdMinutes !== undefined) {
        normalized.presentThresholdMinutes = this.integerSetting(source.presentThresholdMinutes, SYSTEM_LIVE_CLASS_SETTINGS.attendance.presentThresholdMinutes, 0, 240);
      }
      if (source.presentThresholdPercentage !== undefined || source.presentThresholdPercent !== undefined) {
        normalized.presentThresholdPercentage = this.integerSetting(source.presentThresholdPercentage ?? source.presentThresholdPercent, SYSTEM_LIVE_CLASS_SETTINGS.attendance.presentThresholdPercentage, 0, 100);
      }
      if (source.lateJoinThresholdMinutes !== undefined) {
        normalized.lateJoinThresholdMinutes = this.integerSetting(source.lateJoinThresholdMinutes, SYSTEM_LIVE_CLASS_SETTINGS.attendance.lateJoinThresholdMinutes, 0, 120);
      }
      this.maybeBooleanAlias(normalized, 'countReconnects', source.countReconnects ?? source.trackReconnectCount);
      return normalized;
    });
    maybeSet('access', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.access, ['waitingRoomEnabled', 'teacherReconnectGraceMessagingEnabled']);
      this.maybeBooleanAlias(normalized, 'lockClassAfterTeacherStarts', source.lockClassAfterTeacherStarts ?? source.lockClassAfterStart);
      this.maybeBooleanAlias(
        normalized,
        'allowEnrolledStudentReconnectAfterLock',
        source.allowEnrolledStudentReconnectAfterLock ?? source.allowReconnectWhenLocked
      );
      return normalized;
    });
    maybeSet('materials', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.materials, [
        'materialsEnabled',
        'teacherCanUploadMaterials',
        'studentsCanDownloadMaterials',
        'publishMaterialsBeforeClass',
        'publishMaterialsAfterClass'
      ]);
      if (source.allowedMaterialTypes !== undefined) {
        normalized.allowedMaterialTypes = this.materialTypesSetting(
          source.allowedMaterialTypes,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.allowedMaterialTypes
        );
      }
      if (source.maxMaterialFileSizeMb !== undefined) {
        normalized.maxMaterialFileSizeMb = this.integerSetting(
          source.maxMaterialFileSizeMb,
          SYSTEM_LIVE_CLASS_SETTINGS.materials.maxMaterialFileSizeMb,
          1,
          100
        );
      }
      return normalized;
    });
    maybeSet('notifications', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.notifications, [
        'classReminderEnabled',
        'notifyWhenTeacherStarts',
        'notifyRecordingAvailable',
        'notifyNewMaterialUploaded',
        'notifyMissedClass'
      ]);
      if (source.classReminderMinutesBefore !== undefined) {
        normalized.classReminderMinutesBefore = this.integerSetting(
          source.classReminderMinutesBefore,
          SYSTEM_LIVE_CLASS_SETTINGS.notifications.classReminderMinutesBefore,
          0,
          1440
        );
      }
      return normalized;
    });
    maybeSet('questionQueue', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.questionQueue, [
        'questionQueueEnabled',
        'allowAnonymousQuestions',
        'allowStudentUpvotes',
        'teacherCanMarkAnswered'
      ]);
      if (source.maxOpenQuestionsPerStudent !== undefined) {
        normalized.maxOpenQuestionsPerStudent = this.integerSetting(
          source.maxOpenQuestionsPerStudent,
          SYSTEM_LIVE_CLASS_SETTINGS.questionQueue.maxOpenQuestionsPerStudent,
          1,
          20
        );
      }
      return normalized;
    });
    maybeSet('recordingRetention', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention, [
        'allowTeacherPublishRecording',
        'allowStudentsDownloadRecording',
        'autoArchiveExpiredRecordings'
      ]);
      if (source.recordingRetentionDays !== undefined) {
        normalized.recordingRetentionDays = this.integerSetting(
          source.recordingRetentionDays,
          SYSTEM_LIVE_CLASS_SETTINGS.recordingRetention.recordingRetentionDays,
          1,
          3650
        );
      }
      return normalized;
    });
    maybeSet('studentScreenShare', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare, [
        'studentScreenShareEnabled',
        'studentScreenShareRequiresApproval'
      ]);
      if (source.maxActiveStudentShares !== undefined) {
        normalized.maxActiveStudentShares = this.integerSetting(
          source.maxActiveStudentShares,
          SYSTEM_LIVE_CLASS_SETTINGS.studentScreenShare.maxActiveStudentShares,
          1,
          4
        );
      }
      return normalized;
    });
    maybeSet('advancedAnalytics', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.advancedAnalytics, [
        'analyticsEnabled',
        'trackEngagementEvents',
        'trackMediaQuality',
        'trackChatParticipation',
        'trackWhiteboardParticipation',
        'trackQuestionParticipation'
      ]);
      const analyticsVisibility = this.analyticsVisibility(source.analyticsVisibility);
      if (analyticsVisibility) {
        normalized.analyticsVisibility = analyticsVisibility;
      }
      return normalized;
    });
    maybeSet('inactiveDetection', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection, [
        'inactiveDetectionEnabled',
        'countBackgroundTabAsInactive',
        'countMutedNoCameraAsInactive',
        'notifyTeacherOnInactiveStudents',
        'includeInactiveTimeInAttendance'
      ]);
      if (source.inactiveAfterMinutes !== undefined) {
        normalized.inactiveAfterMinutes = this.integerSetting(
          source.inactiveAfterMinutes,
          SYSTEM_LIVE_CLASS_SETTINGS.inactiveDetection.inactiveAfterMinutes,
          1,
          240
        );
      }
      return normalized;
    });
    maybeSet('bandwidthPolicy', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.bandwidthPolicy, [
        'adaptiveQualityEnabled',
        'lowBandwidthModeEnabled',
        'disableStudentVideoOnPoorNetwork',
        'preferAudioOnPoorNetwork',
        'showNetworkWarnings'
      ]);
      const maxStudentVideoQuality = this.studentVideoQualityLimit(source.maxStudentVideoQuality);
      if (maxStudentVideoQuality) {
        normalized.maxStudentVideoQuality = maxStudentVideoQuality;
      }
      const maxScreenShareQuality = this.screenShareQualityLimit(source.maxScreenShareQuality);
      if (maxScreenShareQuality) {
        normalized.maxScreenShareQuality = maxScreenShareQuality;
      }
      return normalized;
    });
    maybeSet('exportControls', (group) => {
      const source = this.unknownRecord(group);
      const normalized = this.liveSettingsGroupPatch(source, SYSTEM_LIVE_CLASS_SETTINGS.exportControls, [
        'exportControlsEnabled',
        'allowAttendanceExport',
        'allowChatExport',
        'allowQuestionExport',
        'allowRecordingDownload',
        'includePrivateChatInExports',
        'anonymizeStudentExports',
        'requireExportAuditLog'
      ]);
      if (source.exportRetentionDays !== undefined) {
        normalized.exportRetentionDays = this.integerSetting(
          source.exportRetentionDays,
          SYSTEM_LIVE_CLASS_SETTINGS.exportControls.exportRetentionDays,
          1,
          3650
        );
      }
      return normalized;
    });
    return patch;
  }

  private liveSettingsGroupPatch<T extends object, K extends keyof T>(value: unknown, fallback: T, keys: readonly K[]): Partial<T> {
    const source = this.unknownRecord(value);
    const patch: Partial<T> = {};
    for (const key of keys) {
      if (source[key as string] !== undefined) {
        patch[key] = this.booleanSetting(source[key as string], Boolean(fallback[key])) as T[K];
      }
    }
    return patch;
  }

  private integerSetting(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  private materialTypesSetting(value: unknown, fallback: string[]): string[] {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];
    const allowed = new Set(SYSTEM_LIVE_CLASS_SETTINGS.materials.allowedMaterialTypes);
    const normalized = rawValues
      .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
      .filter((entry): entry is string => Boolean(entry) && allowed.has(entry));
    return normalized.length ? Array.from(new Set(normalized)) : [...fallback];
  }

  private maybeBooleanAlias<T extends object, K extends keyof T>(patch: Partial<T>, key: K, value: unknown): void {
    if (typeof value === 'boolean') {
      patch[key] = value as T[K];
    }
  }

  private recordingVisibility(value: unknown): LiveClassSettings['recording']['visibility'] | undefined {
    return value === 'teacher_only' || value === 'enrolled_students' || value === 'hidden_until_published' ? value : undefined;
  }

  private analyticsVisibility(value: unknown): LiveClassSettings['advancedAnalytics']['analyticsVisibility'] | undefined {
    return value === 'teacher_only' || value === 'admin_and_teacher' || value === 'admin_only' ? value : undefined;
  }

  private studentVideoQualityLimit(value: unknown): LiveClassSettings['bandwidthPolicy']['maxStudentVideoQuality'] | undefined {
    return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
  }

  private screenShareQualityLimit(value: unknown): LiveClassSettings['bandwidthPolicy']['maxScreenShareQuality'] | undefined {
    return value === 'auto' || value === 'medium' || value === 'high' ? value : undefined;
  }

  private unknownRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private cloneLiveSettings(settings: LiveClassSettings): LiveClassSettings {
    return this.normalizeLiveSettings(settings);
  }

  private booleanSetting(value: unknown, fallback: boolean, aliasValue?: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    return typeof aliasValue === 'boolean' ? aliasValue : fallback;
  }

  private normalizeLocale(value: string | undefined): string {
    const trimmed = value?.trim();
    if (!trimmed) {
      return DEFAULT_PROFILE_SETTINGS.locale;
    }
    if (!/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8}){0,2}$/.test(trimmed)) {
      throw new BadRequestException('Locale must be a valid language tag.');
    }
    return trimmed.replace('_', '-');
  }

  private async teacherBatchAssociations(
    teacherId: string,
    options: { publicOnly: boolean }
  ): Promise<ProfileBatchAssociation[]> {
    const filter: Record<string, unknown> = { teacherId, deletedAt: { $exists: false } };
    if (options.publicOnly) {
      filter.status = 'ACTIVE';
    }
    const batches = await this.batches.find(filter).sort({ startDate: -1, name: 1 }).exec();
    return this.batchAssociationsFromBatches(batches);
  }

  private async studentBatchAssociations(studentId: string): Promise<ProfileBatchAssociation[]> {
    const enrollments = await this.enrollments
      .find({ studentId, status: 'active', deletedAt: { $exists: false } })
      .sort({ enrolledAt: -1, createdAt: -1 })
      .exec();
    if (!enrollments.length) {
      return [];
    }
    const batchIds = enrollments.map((enrollment) => enrollment.batchId);
    const batches = await this.batches.find({ _id: { $in: batchIds }, deletedAt: { $exists: false } }).exec();
    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
    const orderedBatches: BatchMongoDocument[] = [];
    for (const enrollment of enrollments) {
      const batch = batchMap.get(enrollment.batchId);
      if (batch) {
        orderedBatches.push(batch);
      }
    }
    return this.batchAssociationsFromBatches(orderedBatches);
  }

  private async batchAssociationsFromBatches(batches: BatchMongoDocument[]): Promise<ProfileBatchAssociation[]> {
    if (!batches.length) {
      return [];
    }
    const batchIds = batches.map((batch) => batch.id);
    const [scheduleMap, countMap, teacherMap] = await Promise.all([
      this.scheduleMap(batchIds),
      this.activeEnrollmentCountMap(batchIds),
      this.teacherNameMap(batches.map((batch) => batch.teacherId))
    ]);
    return batches.map((batch) => ({
      id: batch.id,
      title: batch.name,
      ...(batch.courseName ? { subject: batch.courseName } : {}),
      teacherId: batch.teacherId,
      teacherName: teacherMap.get(batch.teacherId) ?? 'Teacher',
      schedule: this.scheduleLabel(scheduleMap.get(batch.id) ?? []),
      enrolledCount: countMap.get(batch.id) ?? 0,
      capacity: batch.maxCapacity,
      startsAt: batch.startDate.toISOString(),
      status: batch.status
    }));
  }

  private async scheduleMap(batchIds: readonly string[]): Promise<Map<string, BatchScheduleMongoDocument[]>> {
    if (!batchIds.length) {
      return new Map();
    }
    const schedules = await this.schedules.find({ batchId: { $in: [...new Set(batchIds)] } }).sort({ dayOfWeek: 1, startTime: 1 }).exec();
    return schedules.reduce((map, schedule) => {
      const list = map.get(schedule.batchId) ?? [];
      list.push(schedule);
      map.set(schedule.batchId, list);
      return map;
    }, new Map<string, BatchScheduleMongoDocument[]>());
  }

  private async activeEnrollmentCountMap(batchIds: readonly string[]): Promise<Map<string, number>> {
    if (!batchIds.length) {
      return new Map();
    }
    const docs = await this.enrollments
      .find({ batchId: { $in: [...new Set(batchIds)] }, status: 'active', deletedAt: { $exists: false } })
      .select({ batchId: 1 })
      .exec();
    return docs.reduce((map, doc) => {
      map.set(doc.batchId, (map.get(doc.batchId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
  }

  private async teacherNameMap(teacherIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(teacherIds.filter(Boolean))];
    if (!ids.length) {
      return new Map();
    }
    const teachers = await this.users.find({ _id: { $in: ids }, deletedAt: { $exists: false } }).exec();
    return new Map(teachers.map((teacher) => [teacher.id, teacher.displayName || teacher.name || 'Teacher']));
  }

  private async findActiveUser(userId: string): Promise<UserMongoDocument> {
    const user = await this.users.findOne({ _id: userId, deletedAt: { $exists: false }, disabled: false, status: 'active' }).exec();
    if (!user) {
      throw new NotFoundException('Profile not found.');
    }
    return user;
  }

  private normalizedRoles(roles: readonly string[] | undefined): string[] {
    return [...new Set((roles?.length ? roles : ['STUDENT']).map((role) => role.trim().toUpperCase()).filter(Boolean))];
  }

  private isTeacherRole(roles: readonly string[]): boolean {
    return roles.includes('TEACHER') || roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  }

  private normalizeStringArray(values: readonly string[], maxItems: number, maxLength: number): string[] {
    return [
      ...new Set(
        values
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => value.slice(0, maxLength))
      )
    ].slice(0, maxItems);
  }

  private normalizeCredentials(values: readonly ProfileCredential[], maxItems: number): Array<Record<string, string>> {
    return values
      .map((item) => ({
        title: this.requiredTrim(item.title, 'Credential title'),
        ...(this.optionalTrim(item.issuer) ? { issuer: this.optionalTrim(item.issuer) } : {}),
        ...(this.optionalTrim(item.year) ? { year: this.optionalTrim(item.year) } : {})
      }))
      .slice(0, maxItems);
  }

  private normalizeExperience(values: readonly ProfileExperience[], maxItems: number): Array<Record<string, string>> {
    return values
      .map((item) => ({
        role: this.requiredTrim(item.role, 'Experience role'),
        ...(this.optionalTrim(item.organization) ? { organization: this.optionalTrim(item.organization) } : {}),
        ...(this.optionalTrim(item.period) ? { period: this.optionalTrim(item.period) } : {}),
        ...(this.optionalTrim(item.summary) ? { summary: this.optionalTrim(item.summary) } : {})
      }))
      .slice(0, maxItems);
  }

  private normalizeSocialLinks(values: readonly ProfileSocialLink[], maxItems: number): Array<Record<string, string>> {
    return values
      .map((item) => ({
        label: this.requiredTrim(item.label, 'Social link label'),
        url: this.normalizeExternalUrl(item.url, 'Social link URL')
      }))
      .slice(0, maxItems);
  }

  private normalizeMediaUrl(value: string, label: string): string | undefined {
    const trimmed = this.optionalTrim(value);
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith('/api/v1/profile/media/')) {
      return trimmed;
    }
    return this.normalizeExternalUrl(trimmed, label);
  }

  private normalizeExternalUrl(value: string, label: string): string {
    const trimmed = value.trim();
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new BadRequestException(`${label} must be a valid HTTP URL.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException(`${label} must be a valid HTTP URL.`);
    }
    return url.toString();
  }

  private credentials(values: unknown): ProfileCredential[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const result: ProfileCredential[] = [];
    for (const value of values) {
      const item = this.record(value);
      if (item.title) {
        result.push({
          title: item.title,
          ...(item.issuer ? { issuer: item.issuer } : {}),
          ...(item.year ? { year: item.year } : {})
        });
      }
    }
    return result;
  }

  private experience(values: unknown): ProfileExperience[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const result: ProfileExperience[] = [];
    for (const value of values) {
      const item = this.record(value);
      if (item.role) {
        result.push({
          role: item.role,
          ...(item.organization ? { organization: item.organization } : {}),
          ...(item.period ? { period: item.period } : {}),
          ...(item.summary ? { summary: item.summary } : {})
        });
      }
    }
    return result;
  }

  private socialLinks(values: unknown): ProfileSocialLink[] {
    if (!Array.isArray(values)) {
      return [];
    }
    const result: ProfileSocialLink[] = [];
    for (const value of values) {
      const item = this.record(value);
      if (item.label && item.url) {
        result.push({ label: item.label, url: item.url });
      }
    }
    return result;
  }

  private record(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') {
      return {};
    }
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((record, [key, item]) => {
      if (typeof item === 'string') {
        const cleaned = item.trim();
        if (cleaned) {
          record[key] = cleaned;
        }
      }
      return record;
    }, {});
  }

  private stringArray(values: unknown): string[] {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
  }

  private requiredTrim(value: string | undefined, label: string): string {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new BadRequestException(`${label} is required.`);
    }
    return trimmed;
  }

  private optionalTrim(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
  }

  private scheduleLabel(schedules: BatchScheduleMongoDocument[]): string {
    if (!schedules.length) {
      return 'Schedule to be announced';
    }
    return schedules.map((schedule) => `${this.titleCase(schedule.dayOfWeek)} at ${schedule.startTime}`).join(', ');
  }

  private titleCase(value: string): string {
    return value
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private profileMediaMaxFileSizeBytes(): number {
    return this.config.get<number>('profileMedia.maxFileSizeBytes', PROFILE_MEDIA_MAX_SIZE_BYTES);
  }

  private profileMediaStorageRoot(): string {
    return this.config.get<string>('profileMedia.localPath', './profile-media');
  }

  private profileMediaUrl(userId: string, fileName: string): string {
    return `/api/v1/profile/media/${encodeURIComponent(userId)}/${encodeURIComponent(fileName)}`;
  }

  private profileMediaMimeTypeForFile(fileName: string): string | undefined {
    const extension = fileName.split('.').pop()?.toLowerCase();
    for (const [mimeType, candidateExtension] of PROFILE_MEDIA_MIME_TYPES.entries()) {
      if (candidateExtension === extension) {
        return mimeType;
      }
    }
    return undefined;
  }

  private safeStorageSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180);
  }
}
