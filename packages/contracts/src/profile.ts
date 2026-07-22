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
  feeAmount?: number;
  startsAt?: string;
  status?: string;
}

export type TeacherPublicContentItemType = 'gallery' | 'demo_class';
export type TeacherPublicContentMediaType = 'image' | 'video' | 'pdf' | 'document' | 'slides' | 'link';
export type TeacherPublicContentPublishStatus = 'draft' | 'published' | 'unpublished';
export type TeacherPromotionStatus = 'requested' | 'scheduled' | 'active' | 'paused' | 'expired' | 'cancelled' | 'rejected';
export type TeacherPromotionPlacement = 'marketplace_featured' | 'search_boost' | 'profile_badge';
export type TeacherPromotionBillingStatus = 'not_required' | 'pending' | 'paid' | 'failed' | 'refunded' | 'manual';

export interface TeacherPublicContentItem {
  contentId: string;
  teacherId: string;
  itemType: TeacherPublicContentItemType;
  title: string;
  description?: string;
  mediaType: TeacherPublicContentMediaType;
  thumbnailUrl?: string;
  publicUrl?: string;
  externalUrl?: string;
  tags: string[];
  topics: string[];
  sortOrder: number;
  publishStatus: TeacherPublicContentPublishStatus;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeacherPublicContentListResponse {
  items: TeacherPublicContentItem[];
}

export interface PublicTeacherListItem {
  teacherId: string;
  displayName: string;
  headline?: string;
  avatarUrl?: string;
  location?: string;
  timezone?: string;
  availability?: string;
  skills: string[];
  languages: string[];
  highlightedCredential?: ProfileCredential;
  activePublicBatchCount: number;
  nextPublicBatchStartAt?: string;
  galleryCount: number;
  demoClassCount: number;
  promoted: boolean;
  promotionPlacement?: TeacherPromotionPlacement;
  promotionLabel?: string;
}

export interface PublicTeacherListQuery {
  q?: string;
  skill?: string;
  topic?: string;
  subject?: string;
  language?: string;
  availability?: string;
  page?: number;
  limit?: number;
}

export interface PublicTeacherListResponse {
  teachers: PublicTeacherListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface TeacherPromotion {
  promotionId: string;
  teacherId: string;
  teacherName?: string;
  status: TeacherPromotionStatus;
  placement: TeacherPromotionPlacement;
  startsAt: string;
  endsAt: string;
  requestedByUserId: string;
  approvedByUserId?: string;
  cancelledByUserId?: string;
  billingStatus: TeacherPromotionBillingStatus;
  paymentReference?: string;
  reason?: string;
  adminNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeacherPromotionRequest {
  placement: TeacherPromotionPlacement;
  startsAt: string;
  endsAt: string;
  reason?: string;
  paymentReference?: string;
}

export interface AdminTeacherPromotionUpdateRequest {
  startsAt?: string;
  endsAt?: string;
  billingStatus?: TeacherPromotionBillingStatus;
  paymentReference?: string;
  adminNote?: string;
  reason?: string;
}

export interface TeacherPromotionListQuery {
  status?: TeacherPromotionStatus | 'all';
  placement?: TeacherPromotionPlacement | 'all';
  teacherId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface TeacherPromotionListResponse {
  items: TeacherPromotion[];
  page: number;
  limit: number;
  total: number;
}

export interface CreateTeacherPublicContentRequest {
  itemType: TeacherPublicContentItemType;
  title: string;
  description?: string;
  mediaType: TeacherPublicContentMediaType;
  externalUrl?: string;
  tags?: string[];
  topics?: string[];
  sortOrder?: number;
}

export interface UpdateTeacherPublicContentRequest {
  title?: string;
  description?: string;
  mediaType?: TeacherPublicContentMediaType;
  externalUrl?: string;
  tags?: string[];
  topics?: string[];
  sortOrder?: number;
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
  gallery: TeacherPublicContentItem[];
  demoClasses: TeacherPublicContentItem[];
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
