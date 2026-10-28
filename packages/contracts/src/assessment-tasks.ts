import {
  teachingCategoryPath,
  type TeacherTeachingArea,
  type TeachingCatalogSnapshot,
  type CategoryAssessment,
} from './teaching-catalog.js';

/** Category overrides inherit down the tree; level guidance supplies a usable default. */
export function resolveTeachingAssessments(
  catalog: TeachingCatalogSnapshot,
  areas: TeacherTeachingArea[],
): CategoryAssessment[] {
  const result: CategoryAssessment[] = [];
  for (const area of areas) {
    if (!area.categoryId) continue;
    const path = teachingCategoryPath(catalog.categories, area.categoryId);
    const category = path.at(-1);
    if (!category) continue;
    for (const level of (catalog.levels ?? []).filter((l) =>
      area.levelIds.includes(l.id),
    )) {
      const source = [...path]
        .reverse()
        .find((c) => c.assessmentTasks?.some((t) => t.levelId === level.id));
      const task = source?.assessmentTasks?.find((t) => t.levelId === level.id);
      result.push({
        categoryId: category.id,
        categoryName: path.map((c) => c.name).join(' › '),
        levelId: level.id,
        levelName: level.name,
        version: category.version,
        taskVersion: [
          category.id,
          category.version,
          source?.id ?? category.id,
          source?.version ?? category.version,
          level.id,
          level.version,
        ].join(':'),
        type: task?.type ?? category.assessmentType ?? 'knowledge_review',
        contentApproved: task
          ? (source?.assessmentApproval?.version ??
              source?.assessmentApprovedVersion) === source?.version
          : (category.assessmentApproval?.version ??
              category.assessmentApprovedVersion) === category.version &&
            (level.assessmentApproval?.version ??
              level.assessmentApprovedVersion) === level.version,
        rubric: task
          ? task.rubric || source?.assessmentRubric || DEFAULT_ASSESSMENT_RUBRIC
          : [
              category.assessmentRubric || DEFAULT_ASSESSMENT_RUBRIC,
              level.assessmentRubric,
            ]
              .filter(Boolean)
              .join('\n\n'),
        instructions:
          task?.instructions ??
          [
            category.assessmentInstructions,
            level.assessmentInstructions ||
              `Demonstrate how you teach this subject at ${level.name} level, with an appropriate worked example and a check of learner understanding.`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        subjects: catalog.subjects
          .filter((s) => area.subjectIds.includes(s.id))
          .map((s) => s.name),
      });
    }
  }
  return result;
}

export const DEFAULT_ASSESSMENT_RUBRIC =
  'Review subject accuracy and evidence, suitability for the selected academic stage, clarity of explanation, response to misconceptions, and whether the proposed learner task checks independent understanding. Record reasons and request a demonstration when the evidence is insufficient.';
