export type RecordingVisibility = 'teacher_only' | 'enrolled_students' | 'hidden_until_published';
export type AnalyticsVisibility = 'teacher_only' | 'admin_and_teacher' | 'admin_only';
export type StudentVideoQualityLimit = 'auto' | 'low' | 'medium' | 'high';
export type ScreenShareQualityLimit = 'auto' | 'medium' | 'high';

export interface LiveClassMediaSettings {
  studentsJoinMuted: boolean;
  studentsJoinCameraOff: boolean;
  requirePrejoinDeviceCheck: boolean;
  allowStudentsToUnmuteSelf: boolean;
  allowStudentsToStartCameraSelf: boolean;
}

export interface LiveClassChatSettings {
  privateTeacherStudentChatEnabled: boolean;
  teacherBroadcastEnabled: boolean;
  chatAttachmentsEnabled: boolean;
  messageLengthLimit: number;
}

export interface LiveClassWhiteboardSettings {
  whiteboardSharingEnabled: boolean;
  studentWhiteboardControlEnabled: boolean;
  maxActiveWhiteboardControllers: number;
}

export interface LiveClassSpeakingSettings {
  handRaiseEnabled: boolean;
  maxActiveSpeakers: number;
  autoLowerHandAfterSpeakPermissionEnds: boolean;
}

export interface LiveClassRecordingSettings {
  recordingEnabled: boolean;
  autoRecordOnStart: boolean;
  teacherManualRecordingControlEnabled: boolean;
  visibility: RecordingVisibility;
}

export interface LiveClassAttendanceSettings {
  presentThresholdMinutes: number;
  presentThresholdPercentage: number;
  lateJoinThresholdMinutes: number;
  countReconnects: boolean;
  teacherAttendanceExportEnabled: boolean;
}

export interface LiveClassAccessSettings {
  waitingRoomEnabled: boolean;
  lockClassAfterTeacherStarts: boolean;
  allowEnrolledStudentReconnectAfterLock: boolean;
  teacherReconnectGraceMessagingEnabled: boolean;
}

export interface LiveClassMaterialSettings {
  materialsEnabled: boolean;
  teacherCanUploadMaterials: boolean;
  studentsCanDownloadMaterials: boolean;
  publishMaterialsBeforeClass: boolean;
  publishMaterialsAfterClass: boolean;
  allowedMaterialTypes: string[];
  maxMaterialFileSizeMb: number;
}

export interface LiveClassNotificationSettings {
  classReminderEnabled: boolean;
  classReminderMinutesBefore: number;
  notifyWhenTeacherStarts: boolean;
  notifyRecordingAvailable: boolean;
  notifyNewMaterialUploaded: boolean;
  notifyMissedClass: boolean;
}

export interface LiveClassQuestionQueueSettings {
  questionQueueEnabled: boolean;
  allowAnonymousQuestions: boolean;
  allowStudentUpvotes: boolean;
  teacherCanMarkAnswered: boolean;
  maxOpenQuestionsPerStudent: number;
}

export interface LiveClassRecordingRetentionSettings {
  recordingRetentionDays: number;
  allowTeacherPublishRecording: boolean;
  allowStudentsDownloadRecording: boolean;
  autoArchiveExpiredRecordings: boolean;
}

export interface LiveClassStudentScreenShareSettings {
  studentScreenShareEnabled: boolean;
  studentScreenShareRequiresApproval: boolean;
  maxActiveStudentShares: number;
}

export interface LiveClassAdvancedAnalyticsSettings {
  analyticsEnabled: boolean;
  trackEngagementEvents: boolean;
  trackMediaQuality: boolean;
  trackChatParticipation: boolean;
  trackWhiteboardParticipation: boolean;
  trackQuestionParticipation: boolean;
  analyticsVisibility: AnalyticsVisibility;
}

export interface LiveClassInactiveDetectionSettings {
  inactiveDetectionEnabled: boolean;
  inactiveAfterMinutes: number;
  countBackgroundTabAsInactive: boolean;
  countMutedNoCameraAsInactive: boolean;
  notifyTeacherOnInactiveStudents: boolean;
  includeInactiveTimeInAttendance: boolean;
}

export interface LiveClassBandwidthPolicySettings {
  adaptiveQualityEnabled: boolean;
  lowBandwidthModeEnabled: boolean;
  maxStudentVideoQuality: StudentVideoQualityLimit;
  maxScreenShareQuality: ScreenShareQualityLimit;
  disableStudentVideoOnPoorNetwork: boolean;
  preferAudioOnPoorNetwork: boolean;
  showNetworkWarnings: boolean;
}

export interface LiveClassExportControlSettings {
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

export interface LiveClassSettings {
  media: LiveClassMediaSettings;
  chat: LiveClassChatSettings;
  whiteboard: LiveClassWhiteboardSettings;
  speaking: LiveClassSpeakingSettings;
  recording: LiveClassRecordingSettings;
  attendance: LiveClassAttendanceSettings;
  access: LiveClassAccessSettings;
  materials: LiveClassMaterialSettings;
  notifications: LiveClassNotificationSettings;
  questionQueue: LiveClassQuestionQueueSettings;
  recordingRetention: LiveClassRecordingRetentionSettings;
  studentScreenShare: LiveClassStudentScreenShareSettings;
  advancedAnalytics: LiveClassAdvancedAnalyticsSettings;
  inactiveDetection: LiveClassInactiveDetectionSettings;
  bandwidthPolicy: LiveClassBandwidthPolicySettings;
  exportControls: LiveClassExportControlSettings;
}

export type LiveClassSettingsPatch = {
  media?: Partial<LiveClassMediaSettings>;
  chat?: Partial<LiveClassChatSettings>;
  whiteboard?: Partial<LiveClassWhiteboardSettings>;
  speaking?: Partial<LiveClassSpeakingSettings>;
  recording?: Partial<LiveClassRecordingSettings>;
  attendance?: Partial<LiveClassAttendanceSettings>;
  access?: Partial<LiveClassAccessSettings>;
  materials?: Partial<LiveClassMaterialSettings>;
  notifications?: Partial<LiveClassNotificationSettings>;
  questionQueue?: Partial<LiveClassQuestionQueueSettings>;
  recordingRetention?: Partial<LiveClassRecordingRetentionSettings>;
  studentScreenShare?: Partial<LiveClassStudentScreenShareSettings>;
  advancedAnalytics?: Partial<LiveClassAdvancedAnalyticsSettings>;
  inactiveDetection?: Partial<LiveClassInactiveDetectionSettings>;
  bandwidthPolicy?: Partial<LiveClassBandwidthPolicySettings>;
  exportControls?: Partial<LiveClassExportControlSettings>;
};

export interface TeacherLiveClassSettingsResponse {
  systemDefaults: LiveClassSettings;
  settings: LiveClassSettings;
}

export interface BatchLiveClassSettingsResponse {
  batchId: string;
  teacherId: string;
  systemDefaults: LiveClassSettings;
  teacherDefaults: LiveClassSettings;
  overrides: LiveClassSettingsPatch;
  resolved: LiveClassSettings;
}
