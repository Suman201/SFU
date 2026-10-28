export type TeachingCatalogKind = 'category' | 'subject' | 'curriculum';
export type TeachingCatalogStatus = 'active' | 'archived';
export type CategoryAssessmentType =
  | 'knowledge_review'
  | 'spoken_sample'
  | 'portfolio_review'
  | 'practical_demonstration';
export interface CategoryAssessment {
  categoryId: string;
  categoryName: string;
  version: number;
  type: CategoryAssessmentType;
  instructions: string;
  subjects: string[];
}
export interface TutorAssessmentResponse {
  categoryId: string;
  response: string;
  evidenceUrl?: string;
}
export interface TutorAssessmentResult {
  categoryId: string;
  version: number;
  passed: boolean;
  notes: string;
}
export interface TeachingCatalogEntry {
  assessmentType?: CategoryAssessmentType;
  assessmentInstructions?: string;
  id: string;
  kind: TeachingCatalogKind;
  name: string;
  description: string;
  parentId?: string;
  countryCodes: string[];
  aliases: string[];
  status: TeachingCatalogStatus;
  sortOrder: number;
  version: number;
}
export interface TeachingCatalogWrite {
  assessmentType?: CategoryAssessmentType;
  assessmentInstructions?: string;
  name: string;
  description?: string;
  parentId?: string;
  countryCodes?: string[];
  aliases?: string[];
  status?: TeachingCatalogStatus;
  sortOrder?: number;
  version?: number;
}
export interface TeachingCatalogSnapshot {
  categories: TeachingCatalogEntry[];
  subjects: TeachingCatalogEntry[];
  curricula: TeachingCatalogEntry[];
}
export interface TeachingCatalogPage {
  items: TeachingCatalogEntry[];
  total: number;
  page: number;
  limit: number;
}
export const TEACHING_LEVELS = [
  'Primary',
  'Lower secondary',
  'Upper secondary',
  'University',
  'Adult learning',
  'All levels',
] as const;
export const EUROPEAN_MARKETS = [
  'AL',
  'AD',
  'AM',
  'AT',
  'AZ',
  'BY',
  'BE',
  'BA',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'GE',
  'DE',
  'GR',
  'HU',
  'IS',
  'IE',
  'IT',
  'XK',
  'LV',
  'LI',
  'LT',
  'LU',
  'MT',
  'MD',
  'MC',
  'ME',
  'NL',
  'MK',
  'NO',
  'PL',
  'PT',
  'RO',
  'RU',
  'KZ',
  'SM',
  'RS',
  'SK',
  'SI',
  'ES',
  'SE',
  'CH',
  'TR',
  'UA',
  'GB',
  'VA',
] as const;
export type TutorReviewStatus =
  | 'draft'
  | 'submitted'
  | 'changes_requested'
  | 'approved'
  | 'rejected';
export interface TutorApplication {
  teacherId: string;
  displayName: string;
  email: string;
  status: TutorReviewStatus;
  revision: number;
  submittedAt?: string;
  reviewedAt?: string;
  reviewNote?: string;
  requiredAssessments: CategoryAssessment[];
  assessmentResponses: TutorAssessmentResponse[];
  introVideoUploaded?: boolean;
  introVideoDurationSeconds?: number;
  introVideoUrl?: string;
  missing: string[];
  subjectIds: string[];
  curriculumIds: string[];
  teachingCountries: string[];
  learnerAgeGroups: string[];
  teachingLevels: string[];
  profile: {
    headline?: string;
    bio?: string;
    avatarUrl?: string;
    languages: string[];
    timezone?: string;
    availability?: string;
    credentials: Record<string, string>[];
    education: Record<string, string>[];
    experience: Record<string, string>[];
  };
}
export interface TutorReviewRequest {
  introVideoReviewed?: boolean;
  assessmentResults?: TutorAssessmentResult[];
  decision: 'approved' | 'changes_requested' | 'rejected';
  revision: number;
  note: string;
  identityChecked?: boolean;
  teachingSuitabilityChecked?: boolean;
  safeguardingChecked?: boolean;
}
