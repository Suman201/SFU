import { BadRequestException } from '@nestjs/common';
import {
  teachingCategoryIds,
  type TeacherTeachingArea,
  type TeachingCatalogSnapshot,
} from '@native-sfu/contracts';

export function normalizeTeachingAreas(
  areas: TeacherTeachingArea[],
  catalog: TeachingCatalogSnapshot,
  previous: TeacherTeachingArea[] = [],
): TeacherTeachingArea[] {
  const seen = new Set<string>();
  return areas.map((area) => {
    const key = area.categoryId || 'other';
    if (seen.has(key))
      throw new BadRequestException(
        'Use one teaching area per category. Choose all its relevant subjects, levels and languages together.',
      );
    seen.add(key);
    const old = previous.find((a) => a.categoryId === area.categoryId);
    const categories = new Set(catalog.categories.map((c) => c.id));
    if (area.categoryId && !categories.has(area.categoryId) && !old)
      throw new BadRequestException('Choose an active category.');
    const descendantIds = area.categoryId
      ? teachingCategoryIds(catalog.categories, area.categoryId)
      : [];
    const allowedSubjects = new Set(
      catalog.subjects
        .filter((s) => descendantIds.includes(s.parentId!))
        .map((s) => s.id),
    );
    const allowedLevels = new Set((catalog.levels ?? []).map((l) => l.id));
    const allowedLanguages = new Set(
      (catalog.languages ?? []).map((l) => l.id),
    );
    // A retired selection can remain in a draft so it can be reviewed and removed.
    // Submission calls this without previous selections, requiring active entries.
    for (const [values, allowed, retained] of [
      [area.subjectIds, allowedSubjects, old?.subjectIds ?? []],
      [area.levelIds, allowedLevels, old?.levelIds ?? []],
      [area.languageIds, allowedLanguages, old?.languageIds ?? []],
    ] as const) {
      if (values.some((id) => !allowed.has(id) && !retained.includes(id)))
        throw new BadRequestException(
          'Choose active subjects, academic levels and teaching languages for this category.',
        );
    }
    if (!area.categoryId && area.subjectIds.length)
      throw new BadRequestException('Catalogue subjects need a category.');
    if (area.categoryId && area.otherSubjects.length)
      throw new BadRequestException(
        'Use Other / subject not listed for custom subjects.',
      );
    const names = area.otherSubjects.map((name) =>
      name.trim().replace(/\s+/g, ' '),
    );
    if (names.some((name) => !name || name.length > 100))
      throw new BadRequestException(
        'Enter a subject name between 1 and 100 characters.',
      );
    const uniqueNames = [
      ...new Map(
        names.map((name) => [name.normalize('NFKC').toLowerCase(), name]),
      ).values(),
    ];
    return {
      ...(area.categoryId ? { categoryId: area.categoryId } : {}),
      subjectIds: [...new Set(area.subjectIds)],
      otherSubjects: uniqueNames,
      levelIds: [...new Set(area.levelIds)],
      languageIds: [...new Set(area.languageIds)],
    };
  });
}
