export type TeachingCatalogKind =
  | 'category'
  | 'subject'
  | 'curriculum'
  | 'level'
  | 'language';
export type TeachingCatalogStatus = 'active' | 'archived';
export type CategoryAssessmentType =
  | 'knowledge_review'
  | 'spoken_sample'
  | 'portfolio_review'
  | 'practical_demonstration';
export interface AssessmentContentApproval {
  version: number;
  reviewerId: string;
  expertise: string;
  notes: string;
  reviewedAt: string;
}
export type TutorVerificationKind =
  | 'identity'
  | 'qualification'
  | 'safeguarding';
export interface TutorVerificationDocument {
  id: string;
  kind: TutorVerificationKind;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  expiresAt: string;
  status: 'pending' | 'verified' | 'rejected';
  purgedAt?: string;
  fileAvailable?: boolean;
  reviewNote?: string;
  reviewedAt?: string;
  reviewerId?: string;
}
export interface TutorOnboardingNotice {
  id: string;
  status: TutorReviewStatus;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
}
export interface AcademicAssessmentTask {
  levelId: string;
  type: CategoryAssessmentType;
  instructions: string;
  rubric?: string;
}
export interface CategoryAssessment {
  rubric: string;
  contentApproved: boolean;
  levelId: string;
  levelName: string;
  taskVersion: string;
  categoryId: string;
  categoryName: string;
  version: number;
  type: CategoryAssessmentType;
  instructions: string;
  subjects: string[];
}
export interface TutorAssessmentResponse {
  levelId?: string;
  taskVersion?: string;
  categoryId: string;
  response: string;
  evidenceUrl?: string;
}
export interface TutorAssessmentResult {
  levelId?: string;
  taskVersion?: string;
  categoryId: string;
  version: number;
  passed: boolean;
  notes: string;
}
export interface TeachingCatalogEntry {
  assessmentApproval?: AssessmentContentApproval;
  assessmentApprovedVersion?: number;
  assessmentTasks?: AcademicAssessmentTask[];
  assessmentType?: CategoryAssessmentType;
  assessmentInstructions?: string;
  assessmentRubric?: string;
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
  assessmentTasks?: AcademicAssessmentTask[];
  assessmentType?: CategoryAssessmentType;
  assessmentInstructions?: string;
  assessmentRubric?: string;
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
  levels?: TeachingCatalogEntry[];
  languages?: TeachingCatalogEntry[];
}
/** One teaching area keeps its subjects, academic level and teaching languages together. */
export interface TeacherTeachingArea {
  categoryId?: string;
  subjectIds: string[];
  otherSubjects: string[];
  levelIds: string[];
  languageIds: string[];
}

/** Paths and descendant lookups are cycle-safe for older catalogue data. */
export function teachingCategoryPath(
  categories: TeachingCatalogEntry[],
  id: string,
): TeachingCatalogEntry[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const path: TeachingCatalogEntry[] = [];
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
export function teachingCategoryIds(
  categories: TeachingCatalogEntry[],
  id: string,
): string[] {
  return categories
    .filter((c) =>
      teachingCategoryPath(categories, c.id).some((p) => p.id === id),
    )
    .map((c) => c.id);
}
export function legacyTeachingAreas(
  profile: {
    teachingAreas?: TeacherTeachingArea[];
    teacherSubjectIds?: string[];
    languages?: string[];
  },
  catalog: TeachingCatalogSnapshot,
): TeacherTeachingArea[] {
  if (profile.teachingAreas !== undefined)
    return profile.teachingAreas.map((a) => ({
      ...a,
      subjectIds: [...a.subjectIds],
      otherSubjects: [...a.otherSubjects],
      levelIds: [...a.levelIds],
      languageIds: [...a.languageIds],
    }));
  const groups = new Map<string, string[]>();
  for (const id of profile.teacherSubjectIds ?? []) {
    const parent = catalog.subjects.find((s) => s.id === id)?.parentId;
    if (parent) groups.set(parent, [...(groups.get(parent) ?? []), id]);
  }
  const names = new Set((profile.languages ?? []).map((n) => n.toLowerCase()));
  const languageIds = (catalog.languages ?? [])
    .filter((l) =>
      [l.name, ...l.aliases].some((n) => names.has(n.toLowerCase())),
    )
    .map((l) => l.id);
  return [...groups].map(([categoryId, subjectIds]) => ({
    categoryId,
    subjectIds,
    otherSubjects: [],
    levelIds: [],
    languageIds: [...languageIds],
  }));
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
  verificationDocuments?: TutorVerificationDocument[];
  assessmentResponses: TutorAssessmentResponse[];
  introVideoUploaded?: boolean;
  introVideoDurationSeconds?: number;
  introVideoUrl?: string;
  missing: string[];
  subjectIds: string[];
  teachingAreas?: TeacherTeachingArea[];
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
