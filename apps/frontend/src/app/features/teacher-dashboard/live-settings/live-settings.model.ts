import type {
  AnalyticsVisibility,
  LiveClassSettings,
  LiveClassSettingsPatch,
  RecordingVisibility,
  ScreenShareQualityLimit,
  StudentVideoQualityLimit
} from '@native-sfu/contracts';

export interface LiveSettingsForm {
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
  autoLowerHandAfterSpeakPermissionEnds: boolean;
  recordingEnabled: boolean;
  autoRecordOnStart: boolean;
  teacherManualRecordingControlEnabled: boolean;
  recordingVisibility: RecordingVisibility;
  presentThresholdMinutes: number;
  presentThresholdPercentage: number;
  lateJoinThresholdMinutes: number;
  countReconnects: boolean;
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

export type LiveSettingsFormKey = keyof LiveSettingsForm;
export type LiveSettingsFormValue = LiveSettingsForm[LiveSettingsFormKey];
type LiveSettingsPatchSection = keyof LiveClassSettingsPatch;

export interface LiveSettingsOption {
  value: string;
  label: string;
}

export interface LiveSettingsField {
  key: LiveSettingsFormKey;
  section: LiveSettingsPatchSection;
  settingKey: string;
  label: string;
  help: string;
  type: 'toggle' | 'number' | 'select' | 'text';
  min?: number;
  max?: number;
  suffix?: string;
  options?: readonly LiveSettingsOption[];
}

export interface LiveSettingsSection {
  title: string;
  description: string;
  fields: readonly LiveSettingsField[];
}

export const EMPTY_LIVE_SETTINGS_FORM: LiveSettingsForm = {
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
  autoLowerHandAfterSpeakPermissionEnds: true,
  recordingEnabled: true,
  autoRecordOnStart: false,
  teacherManualRecordingControlEnabled: true,
  recordingVisibility: 'enrolled_students',
  presentThresholdMinutes: 10,
  presentThresholdPercentage: 50,
  lateJoinThresholdMinutes: 10,
  countReconnects: true,
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

export const LIVE_SETTINGS_SECTIONS: readonly LiveSettingsSection[] = [
  {
    title: 'Student media',
    description: 'Default camera, microphone, and prejoin behavior.',
    fields: [
      field('studentsJoinMuted', 'media', 'studentsJoinMuted', 'Students join muted', 'New students enter with microphone paused.', 'toggle'),
      field('studentsJoinCameraOff', 'media', 'studentsJoinCameraOff', 'Students join camera off', 'New students enter with camera disabled.', 'toggle'),
      field('requirePrejoinDeviceCheck', 'media', 'requirePrejoinDeviceCheck', 'Require prejoin device check', 'Show the device preflight before entering class.', 'toggle'),
      field('allowStudentsToUnmuteSelf', 'media', 'allowStudentsToUnmuteSelf', 'Allow self unmute', 'Students can restore their microphone without teacher approval.', 'toggle'),
      field('allowStudentsToStartCameraSelf', 'media', 'allowStudentsToStartCameraSelf', 'Allow self camera', 'Students can restore their camera without teacher approval.', 'toggle')
    ]
  },
  {
    title: 'Chat',
    description: 'Private teacher-student chat, broadcasts, and attachments.',
    fields: [
      field('privateTeacherStudentChatEnabled', 'chat', 'privateTeacherStudentChatEnabled', 'Private chat', 'Keep each student conversation private with the teacher.', 'toggle'),
      field('teacherBroadcastEnabled', 'chat', 'teacherBroadcastEnabled', 'Teacher broadcast', 'Allow explicit announcements to all students.', 'toggle'),
      field('chatAttachmentsEnabled', 'chat', 'chatAttachmentsEnabled', 'Chat attachments', 'Allow file attachments in class chat.', 'toggle'),
      field('messageLengthLimit', 'chat', 'messageLengthLimit', 'Message length limit', 'Maximum characters per message.', 'number', { min: 100, max: 5000 })
    ]
  },
  {
    title: 'Whiteboard and speaking',
    description: 'Whiteboard sharing, student board control, hand raise, and live speakers.',
    fields: [
      field('whiteboardSharingEnabled', 'whiteboard', 'whiteboardSharingEnabled', 'Whiteboard sharing', 'Teacher can share the board as live media.', 'toggle'),
      field('studentWhiteboardControlEnabled', 'whiteboard', 'studentWhiteboardControlEnabled', 'Student whiteboard control', 'Teacher can grant a student interactive board access.', 'toggle'),
      field('maxActiveWhiteboardControllers', 'whiteboard', 'maxActiveWhiteboardControllers', 'Max board controllers', 'Maximum active student board controllers.', 'number', { min: 1, max: 5 }),
      field('handRaiseEnabled', 'speaking', 'handRaiseEnabled', 'Hand raise', 'Students can request permission to speak.', 'toggle'),
      field('maxActiveSpeakers', 'speaking', 'maxActiveSpeakers', 'Max active speakers', 'Maximum students allowed to speak at one time.', 'number', { min: 0, max: 12 }),
      field('autoLowerHandAfterSpeakPermissionEnds', 'speaking', 'autoLowerHandAfterSpeakPermissionEnds', 'Auto-lower hand', 'Lower a hand after speak permission ends.', 'toggle')
    ]
  },
  {
    title: 'Recording',
    description: 'Recording availability, teacher controls, visibility, and retention.',
    fields: [
      field('recordingEnabled', 'recording', 'recordingEnabled', 'Recording enabled', 'Allow class recordings for live sessions.', 'toggle'),
      field('autoRecordOnStart', 'recording', 'autoRecordOnStart', 'Auto-record on start', 'Begin recording when the teacher starts class.', 'toggle'),
      field('teacherManualRecordingControlEnabled', 'recording', 'teacherManualRecordingControlEnabled', 'Teacher recording control', 'Teacher can start or stop recording during class.', 'toggle'),
      field('recordingVisibility', 'recording', 'visibility', 'Recording visibility', 'Who can see recordings after class.', 'select', {
        options: [
          { value: 'teacher_only', label: 'Teacher only' },
          { value: 'enrolled_students', label: 'Enrolled students' },
          { value: 'hidden_until_published', label: 'Hidden until published' }
        ]
      }),
      field('recordingRetentionDays', 'recordingRetention', 'recordingRetentionDays', 'Retention', 'Days before recording archive policy applies.', 'number', { min: 1, max: 3650, suffix: 'days' }),
      field('allowTeacherPublishRecording', 'recordingRetention', 'allowTeacherPublishRecording', 'Teacher can publish', 'Teacher can publish hidden recordings.', 'toggle'),
      field('allowStudentsDownloadRecording', 'recordingRetention', 'allowStudentsDownloadRecording', 'Student downloads', 'Students can download available recordings.', 'toggle'),
      field('autoArchiveExpiredRecordings', 'recordingRetention', 'autoArchiveExpiredRecordings', 'Auto-archive expired', 'Archive recordings after retention expires.', 'toggle')
    ]
  },
  {
    title: 'Access and attendance',
    description: 'Waiting room, locking, reconnects, attendance rules, and export access.',
    fields: [
      field('waitingRoomEnabled', 'access', 'waitingRoomEnabled', 'Waiting room', 'Students wait until admitted.', 'toggle'),
      field('lockClassAfterTeacherStarts', 'access', 'lockClassAfterTeacherStarts', 'Lock after start', 'Prevent new student joins after teacher starts.', 'toggle'),
      field('allowEnrolledStudentReconnectAfterLock', 'access', 'allowEnrolledStudentReconnectAfterLock', 'Allow reconnect after lock', 'Already admitted enrolled students can rejoin a locked class.', 'toggle'),
      field('teacherReconnectGraceMessagingEnabled', 'access', 'teacherReconnectGraceMessagingEnabled', 'Teacher reconnect messaging', 'Show teacher reconnecting state during grace period.', 'toggle'),
      field('presentThresholdMinutes', 'attendance', 'presentThresholdMinutes', 'Present threshold', 'Minimum minutes required for present status.', 'number', { min: 1, max: 480, suffix: 'min' }),
      field('presentThresholdPercentage', 'attendance', 'presentThresholdPercentage', 'Present percentage', 'Minimum class percentage required for present status.', 'number', { min: 1, max: 100, suffix: '%' }),
      field('lateJoinThresholdMinutes', 'attendance', 'lateJoinThresholdMinutes', 'Late threshold', 'Minutes after start before a join is marked late.', 'number', { min: 0, max: 240, suffix: 'min' }),
      field('countReconnects', 'attendance', 'countReconnects', 'Count reconnects', 'Include reconnects in attendance analytics.', 'toggle'),
      field('teacherAttendanceExportEnabled', 'attendance', 'teacherAttendanceExportEnabled', 'Teacher attendance export', 'Teacher can download attendance.', 'toggle')
    ]
  },
  {
    title: 'Materials',
    description: 'Lesson materials, publishing windows, and file limits.',
    fields: [
      field('materialsEnabled', 'materials', 'materialsEnabled', 'Materials enabled', 'Allow lesson materials for sessions.', 'toggle'),
      field('teacherCanUploadMaterials', 'materials', 'teacherCanUploadMaterials', 'Teacher uploads', 'Teacher can upload class materials.', 'toggle'),
      field('studentsCanDownloadMaterials', 'materials', 'studentsCanDownloadMaterials', 'Student downloads', 'Students can download allowed materials.', 'toggle'),
      field('publishMaterialsBeforeClass', 'materials', 'publishMaterialsBeforeClass', 'Publish before class', 'Students can access materials before class starts.', 'toggle'),
      field('publishMaterialsAfterClass', 'materials', 'publishMaterialsAfterClass', 'Publish after class', 'Students can access materials after class ends.', 'toggle'),
      field('allowedMaterialTypesText', 'materials', 'allowedMaterialTypes', 'Allowed material types', 'Comma-separated material types.', 'text'),
      field('maxMaterialFileSizeMb', 'materials', 'maxMaterialFileSizeMb', 'Max file size', 'Maximum size per material upload.', 'number', { min: 1, max: 250, suffix: 'MB' })
    ]
  },
  {
    title: 'Notifications',
    description: 'Class reminders and live-session notification defaults.',
    fields: [
      field('classReminderEnabled', 'notifications', 'classReminderEnabled', 'Class reminders', 'Enable pre-class reminders.', 'toggle'),
      field('classReminderMinutesBefore', 'notifications', 'classReminderMinutesBefore', 'Reminder lead time', 'Minutes before class to send reminder.', 'number', { min: 1, max: 1440, suffix: 'min' }),
      field('notifyWhenTeacherStarts', 'notifications', 'notifyWhenTeacherStarts', 'Teacher start notice', 'Notify students when teacher starts class.', 'toggle'),
      field('notifyRecordingAvailable', 'notifications', 'notifyRecordingAvailable', 'Recording available notice', 'Notify when recording becomes available.', 'toggle'),
      field('notifyNewMaterialUploaded', 'notifications', 'notifyNewMaterialUploaded', 'New material notice', 'Notify students when new material is uploaded.', 'toggle'),
      field('notifyMissedClass', 'notifications', 'notifyMissedClass', 'Missed class notice', 'Notify students about missed classes.', 'toggle')
    ]
  },
  {
    title: 'Questions and student sharing',
    description: 'Question queue and student screen share controls.',
    fields: [
      field('questionQueueEnabled', 'questionQueue', 'questionQueueEnabled', 'Question queue', 'Students can submit questions during class.', 'toggle'),
      field('allowAnonymousQuestions', 'questionQueue', 'allowAnonymousQuestions', 'Anonymous questions', 'Students can ask without showing name.', 'toggle'),
      field('allowStudentUpvotes', 'questionQueue', 'allowStudentUpvotes', 'Student upvotes', 'Students can upvote questions.', 'toggle'),
      field('teacherCanMarkAnswered', 'questionQueue', 'teacherCanMarkAnswered', 'Mark answered', 'Teacher can mark questions as answered.', 'toggle'),
      field('maxOpenQuestionsPerStudent', 'questionQueue', 'maxOpenQuestionsPerStudent', 'Max open questions', 'Maximum unanswered questions per student.', 'number', { min: 1, max: 20 }),
      field('studentScreenShareEnabled', 'studentScreenShare', 'studentScreenShareEnabled', 'Student screen share', 'Allow students to share their screen.', 'toggle'),
      field('studentScreenShareRequiresApproval', 'studentScreenShare', 'studentScreenShareRequiresApproval', 'Require share approval', 'Teacher must approve student screen share.', 'toggle'),
      field('maxActiveStudentShares', 'studentScreenShare', 'maxActiveStudentShares', 'Max student shares', 'Maximum active student screen shares.', 'number', { min: 1, max: 5 })
    ]
  },
  {
    title: 'Analytics and inactivity',
    description: 'Engagement analytics, inactive detection, and visibility.',
    fields: [
      field('analyticsEnabled', 'advancedAnalytics', 'analyticsEnabled', 'Analytics enabled', 'Collect class-session analytics.', 'toggle'),
      field('trackEngagementEvents', 'advancedAnalytics', 'trackEngagementEvents', 'Track engagement', 'Track joins, leaves, and engagement events.', 'toggle'),
      field('trackMediaQuality', 'advancedAnalytics', 'trackMediaQuality', 'Track media quality', 'Track media quality metrics.', 'toggle'),
      field('trackChatParticipation', 'advancedAnalytics', 'trackChatParticipation', 'Track chat', 'Track chat participation.', 'toggle'),
      field('trackWhiteboardParticipation', 'advancedAnalytics', 'trackWhiteboardParticipation', 'Track whiteboard', 'Track whiteboard participation.', 'toggle'),
      field('trackQuestionParticipation', 'advancedAnalytics', 'trackQuestionParticipation', 'Track questions', 'Track question participation.', 'toggle'),
      field('analyticsVisibility', 'advancedAnalytics', 'analyticsVisibility', 'Analytics visibility', 'Who can view analytics.', 'select', {
        options: [
          { value: 'teacher_only', label: 'Teacher only' },
          { value: 'admin_and_teacher', label: 'Admin and teacher' },
          { value: 'admin_only', label: 'Admin only' }
        ]
      }),
      field('inactiveDetectionEnabled', 'inactiveDetection', 'inactiveDetectionEnabled', 'Inactive detection', 'Detect inactive students during class.', 'toggle'),
      field('inactiveAfterMinutes', 'inactiveDetection', 'inactiveAfterMinutes', 'Inactive after', 'Minutes before a student is considered inactive.', 'number', { min: 1, max: 240, suffix: 'min' }),
      field('countBackgroundTabAsInactive', 'inactiveDetection', 'countBackgroundTabAsInactive', 'Background tab inactive', 'Count background browser tab as inactive.', 'toggle'),
      field('countMutedNoCameraAsInactive', 'inactiveDetection', 'countMutedNoCameraAsInactive', 'Muted and camera off inactive', 'Count muted students with camera off as inactive.', 'toggle'),
      field('notifyTeacherOnInactiveStudents', 'inactiveDetection', 'notifyTeacherOnInactiveStudents', 'Notify teacher', 'Alert teacher when students are inactive.', 'toggle'),
      field('includeInactiveTimeInAttendance', 'inactiveDetection', 'includeInactiveTimeInAttendance', 'Include inactive time', 'Include inactive time in attendance duration.', 'toggle')
    ]
  },
  {
    title: 'Quality and exports',
    description: 'Bandwidth policy, network warnings, exports, and audit behavior.',
    fields: [
      field('adaptiveQualityEnabled', 'bandwidthPolicy', 'adaptiveQualityEnabled', 'Adaptive quality', 'Adjust quality based on network conditions.', 'toggle'),
      field('lowBandwidthModeEnabled', 'bandwidthPolicy', 'lowBandwidthModeEnabled', 'Low bandwidth mode', 'Prefer lower media bandwidth.', 'toggle'),
      field('maxStudentVideoQuality', 'bandwidthPolicy', 'maxStudentVideoQuality', 'Student video quality', 'Maximum student video quality.', 'select', {
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ]
      }),
      field('maxScreenShareQuality', 'bandwidthPolicy', 'maxScreenShareQuality', 'Screen share quality', 'Maximum screen share quality.', 'select', {
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ]
      }),
      field('disableStudentVideoOnPoorNetwork', 'bandwidthPolicy', 'disableStudentVideoOnPoorNetwork', 'Disable poor-network video', 'Disable student video when network is poor.', 'toggle'),
      field('preferAudioOnPoorNetwork', 'bandwidthPolicy', 'preferAudioOnPoorNetwork', 'Prefer audio on poor network', 'Keep audio prioritized when network degrades.', 'toggle'),
      field('showNetworkWarnings', 'bandwidthPolicy', 'showNetworkWarnings', 'Show network warnings', 'Show user-facing network warnings.', 'toggle'),
      field('exportControlsEnabled', 'exportControls', 'exportControlsEnabled', 'Export controls', 'Enable export policy controls.', 'toggle'),
      field('allowAttendanceExport', 'exportControls', 'allowAttendanceExport', 'Attendance export', 'Allow attendance export.', 'toggle'),
      field('allowChatExport', 'exportControls', 'allowChatExport', 'Chat export', 'Allow chat export.', 'toggle'),
      field('allowQuestionExport', 'exportControls', 'allowQuestionExport', 'Question export', 'Allow question export.', 'toggle'),
      field('allowRecordingDownload', 'exportControls', 'allowRecordingDownload', 'Recording download', 'Allow recording downloads.', 'toggle'),
      field('includePrivateChatInExports', 'exportControls', 'includePrivateChatInExports', 'Include private chat', 'Include private chat in exports.', 'toggle'),
      field('anonymizeStudentExports', 'exportControls', 'anonymizeStudentExports', 'Anonymize student exports', 'Remove student identity from exports.', 'toggle'),
      field('exportRetentionDays', 'exportControls', 'exportRetentionDays', 'Export retention', 'Days to retain generated exports.', 'number', { min: 1, max: 3650, suffix: 'days' }),
      field('requireExportAuditLog', 'exportControls', 'requireExportAuditLog', 'Require export audit log', 'Record export actions in audit logs.', 'toggle')
    ]
  }
];

export function liveSettingsFormFromSettings(settings: LiveClassSettings): LiveSettingsForm {
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
    autoLowerHandAfterSpeakPermissionEnds: settings.speaking.autoLowerHandAfterSpeakPermissionEnds,
    recordingEnabled: settings.recording.recordingEnabled,
    autoRecordOnStart: settings.recording.autoRecordOnStart,
    teacherManualRecordingControlEnabled: settings.recording.teacherManualRecordingControlEnabled,
    recordingVisibility: settings.recording.visibility,
    presentThresholdMinutes: settings.attendance.presentThresholdMinutes,
    presentThresholdPercentage: settings.attendance.presentThresholdPercentage,
    lateJoinThresholdMinutes: settings.attendance.lateJoinThresholdMinutes,
    countReconnects: settings.attendance.countReconnects,
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

export function liveSettingsPatchFromForm(form: LiveSettingsForm, includedKeys?: ReadonlySet<LiveSettingsFormKey>): LiveClassSettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {};

  for (const fieldConfig of LIVE_SETTINGS_SECTIONS.flatMap((section) => section.fields)) {
    if (includedKeys && !includedKeys.has(fieldConfig.key)) {
      continue;
    }
    const sectionPatch = patch[fieldConfig.section] ?? {};
    sectionPatch[fieldConfig.settingKey] = patchValue(form, fieldConfig);
    patch[fieldConfig.section] = sectionPatch;
  }

  return patch as LiveClassSettingsPatch;
}

export function liveSettingsOverrideKeysFromPatch(patch: LiveClassSettingsPatch): Set<LiveSettingsFormKey> {
  const keys = new Set<LiveSettingsFormKey>();

  for (const fieldConfig of LIVE_SETTINGS_SECTIONS.flatMap((section) => section.fields)) {
    const sectionPatch = patch[fieldConfig.section] as Record<string, unknown> | undefined;
    if (sectionPatch && Object.prototype.hasOwnProperty.call(sectionPatch, fieldConfig.settingKey)) {
      keys.add(fieldConfig.key);
    }
  }

  return keys;
}

function patchValue(form: LiveSettingsForm, fieldConfig: LiveSettingsField): unknown {
  if (fieldConfig.key === 'allowedMaterialTypesText') {
    return materialTypesFromText(form.allowedMaterialTypesText);
  }
  return form[fieldConfig.key];
}

function materialTypesFromText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function field(
  key: LiveSettingsFormKey,
  section: LiveSettingsPatchSection,
  settingKey: string,
  label: string,
  help: string,
  type: LiveSettingsField['type'],
  options: Partial<Pick<LiveSettingsField, 'min' | 'max' | 'suffix' | 'options'>> = {}
): LiveSettingsField {
  return {
    key,
    section,
    settingKey,
    label,
    help,
    type,
    ...options
  };
}
