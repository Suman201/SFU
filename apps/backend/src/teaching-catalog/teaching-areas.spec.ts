import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  type TeachingCatalogSnapshot,
  type TeachingCatalogEntry,
  type TeacherTeachingArea,
  teachingCategoryPath,
} from '@native-sfu/contracts';
import { UpdateMyProfileDto } from '../profiles/dto/profile.dto';
import { ReviewTutorDto } from './catalog.dto';
import { normalizeTeachingAreas } from './teaching-areas';
const id = (n: number) => n.toString(16).padStart(24, '0');
const entry = (
  n: number,
  kind: TeachingCatalogEntry['kind'],
  parentId?: string,
): TeachingCatalogEntry => ({
  id: id(n),
  kind,
  name: String(n),
  description: '',
  aliases: [],
  countryCodes: [],
  status: 'active',
  sortOrder: 0,
  version: 0,
  ...(parentId ? { parentId } : {}),
});
const catalog: TeachingCatalogSnapshot = {
  categories: [entry(1, 'category'), entry(2, 'category', id(1))],
  subjects: [entry(3, 'subject', id(2))],
  curricula: [],
  levels: [entry(4, 'level')],
  languages: [entry(5, 'language')],
};
const area = (
  changes: Partial<TeacherTeachingArea> = {},
): TeacherTeachingArea => ({
  categoryId: id(1),
  subjectIds: [id(3)],
  otherSubjects: [],
  levelIds: [id(4)],
  languageIds: [id(5)],
  ...changes,
});
describe('Flexible teaching areas', () => {
  it('accepts a subject from a descendant category and keeps levels and languages together', () => {
    expect(normalizeTeachingAreas([area()], catalog)).toEqual([area()]);
    expect(
      teachingCategoryPath(catalog.categories, id(2)).map((c) => c.id),
    ).toEqual([id(1), id(2)]);
  });
  it('permits Other without catalogue subjects and normalizes repeated names', () => {
    const other = area({
      categoryId: undefined,
      subjectIds: [],
      otherSubjects: ['  Specialist   mentoring ', 'specialist mentoring'],
    });
    expect(normalizeTeachingAreas([other], catalog)[0]!.otherSubjects).toEqual([
      'specialist mentoring',
    ]);
  });
  it('rejects subjects attached to the wrong category and unknown level/language IDs', () => {
    for (const change of [
      { subjectIds: [id(10)] },
      { levelIds: [id(10)] },
      { languageIds: [id(10)] },
      { categoryId: undefined },
      { otherSubjects: ['unlisted'] },
    ])
      expect(() => normalizeTeachingAreas([area(change)], catalog)).toThrow(
        BadRequestException,
      );
  });
  it('retains retired selections only in an existing draft', () => {
    const old = area({ levelIds: [id(10)] });
    expect(normalizeTeachingAreas([old], catalog, [old])).toEqual([old]);
    expect(() => normalizeTeachingAreas([old], catalog)).toThrow(
      BadRequestException,
    );
  });
  it('rejects repeated categories and blank Other subject names', () => {
    expect(() => normalizeTeachingAreas([area(), area()], catalog)).toThrow(
      BadRequestException,
    );
    expect(() =>
      normalizeTeachingAreas(
        [
          area({
            categoryId: undefined,
            subjectIds: [],
            otherSubjects: ['   '],
          }),
        ],
        catalog,
      ),
    ).toThrow(BadRequestException);
  });
  it('validates hundreds of subject selections and more than eight category responses', async () => {
    const responses = Array.from({ length: 30 }, (_, i) => ({
      categoryId: id(i + 1),
      response: 'A meaningful teaching example.',
    }));
    const dto = plainToInstance(UpdateMyProfileDto, {
      teacherSubjectIds: Array.from({ length: 500 }, (_, i) => id(i + 1)),
      assessmentResponses: responses,
      teachingAreas: Array.from({ length: 30 }, (_, i) =>
        area({ categoryId: id(i + 1) }),
      ),
    });
    expect(await validate(dto)).toEqual([]);
    const review = plainToInstance(ReviewTutorDto, {
      decision: 'approved',
      revision: 1,
      note: 'All teaching areas reviewed.',
      assessmentResults: responses.map((r) => ({
        categoryId: r.categoryId,
        version: 0,
        passed: true,
        notes: 'Teaching evidence reviewed.',
      })),
    });
    expect(await validate(review)).toEqual([]);
  });
  it('still rejects malformed IDs and null teaching areas', async () => {
    for (const data of [
      { teachingAreas: null },
      { teacherSubjectIds: ['invalid'] },
      { assessmentResponses: null },
    ])
      expect(
        (await validate(plainToInstance(UpdateMyProfileDto, data))).length,
      ).toBeGreaterThan(0);
  });
});
