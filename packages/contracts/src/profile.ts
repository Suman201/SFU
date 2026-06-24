import type { LiveClassSettings } from './live-settings.js';

export interface ProfileCredential {
  title: string;
  issuer?: string;
  year?: string;
}

export interface ProfileExperience {
  role: string;
  organization?: string;
  period?: string;
  summary?: string;
}

export interface ProfileSocialLink {
  label: string;
  url: string;
}

export interface ProfileBatchAssociation {
  id: string;
  title: string;
  subject?: string;
  teacherId?: string;
  teacherName?: string;
  schedule?: string;
  durationMinutes?: number;
  enrolledCount?: number;
  capacity?: number;
  startsAt?: string;
  status?: string;
}

export type ProfileThemePreference = 'system' | 'light' | 'dark';

export interface ProfileNotificationSettings {
  email: boolean;
  classReminders: boolean;
  chatMessages: boolean;
  announcements: boolean;
  recordingReady: boolean;
}

export interface ProfilePrivacySettings {
  showEmailOnPublicProfile: boolean;
  allowTeacherMessages: boolean;
}

export interface ProfileSettings {
  theme: ProfileThemePreference;
  locale: string;
  notifications: ProfileNotificationSettings;
  privacy: ProfilePrivacySettings;
  liveClassDefaults?: LiveClassSettings;
}

export interface ProfileUser {
  id: string;
  email: string;
  phone?: string;
  roles: string[];
  primaryRole: 'teacher' | 'student';
  displayName: string;
  headline?: string;
  bio?: string;
  avatarUrl?: string;
  coverImageUrl?: string;
  location?: string;
  timezone?: string;
  languages: string[];
  skills: string[];
  credentials: ProfileCredential[];
  education: ProfileCredential[];
  experience: ProfileExperience[];
  socialLinks: ProfileSocialLink[];
  availability?: string;
  publicProfileEnabled?: boolean;
  learningGoals: string[];
  interests: string[];
  settings: ProfileSettings;
  batches: ProfileBatchAssociation[];
}

export interface PublicTeacherProfile {
  id: string;
  displayName: string;
  headline?: string;
  bio?: string;
  avatarUrl?: string;
  coverImageUrl?: string;
  location?: string;
  timezone?: string;
  languages: string[];
  skills: string[];
  credentials: ProfileCredential[];
  education: ProfileCredential[];
  experience: ProfileExperience[];
  socialLinks: ProfileSocialLink[];
  availability?: string;
  batches: ProfileBatchAssociation[];
}

export interface UpdateMyProfileRequest {
  displayName?: string;
  phone?: string;
  headline?: string;
  bio?: string;
  avatarUrl?: string;
  coverImageUrl?: string;
  location?: string;
  timezone?: string;
  languages?: string[];
  skills?: string[];
  credentials?: ProfileCredential[];
  education?: ProfileCredential[];
  experience?: ProfileExperience[];
  socialLinks?: ProfileSocialLink[];
  availability?: string;
  publicProfileEnabled?: boolean;
  learningGoals?: string[];
  interests?: string[];
}

export interface UpdateMySettingsRequest {
  theme?: ProfileThemePreference;
  locale?: string;
  notifications?: Partial<ProfileNotificationSettings>;
  privacy?: Partial<ProfilePrivacySettings>;
  liveClassDefaults?: Partial<LiveClassSettings>;
}

export interface ProfileMediaUploadResponse {
  field: 'avatarUrl' | 'coverImageUrl';
  url: string;
}
