import {
  resolveTeachingAssessments,
  type TeachingCatalogEntry,
  type TeachingCatalogSnapshot,
  type TeacherTeachingArea,
} from '@native-sfu/contracts';
const entry = (
  id: string,
  name: string,
  kind: TeachingCatalogEntry['kind'],
  parentId?: string,
): TeachingCatalogEntry => ({
  id,
  name,
  kind,
  ...(parentId ? { parentId } : {}),
  status: 'active',
  version: 0,
  sortOrder: 0,
  aliases: [],
  countryCodes: [],
  description: '',
});
function fixture() {
  const parent = {
    ...entry('root', 'Mathematics', 'category'),
    assessmentInstructions: 'Explain a mathematical concept correctly.',
  };
  const category = {
    ...entry('algebra', 'Algebra', 'category', 'root'),
    assessmentInstructions: 'Give a worked algebra example.',
  };
  const primary = {
    ...entry('primary', 'Primary school', 'level'),
    assessmentInstructions:
      'Use concrete objects and a primary-school activity.',
  };
  const university = {
    ...entry('university', 'University', 'level'),
    assessmentInstructions:
      'Use precise definitions and a rigorous derivation.',
  };
  const catalog: TeachingCatalogSnapshot = {
    categories: [parent, category],
    subjects: [entry('equations', 'Equations', 'subject', 'algebra')],
    curricula: [],
    levels: [primary, university],
  };
  const areas: TeacherTeachingArea[] = [
    {
      categoryId: 'algebra',
      subjectIds: ['equations'],
      otherSubjects: [],
      levelIds: ['primary', 'university'],
      languageIds: [],
    },
  ];
  return { catalog, areas, parent, category, primary, university };
}
describe('Academic-level teaching assessments', () => {
  it('produces separate, different tasks for primary and university in the same subject', () => {
    const { catalog, areas } = fixture();
    const tasks = resolveTeachingAssessments(catalog, areas);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.instructions).toContain('concrete objects');
    expect(tasks[1]!.instructions).toContain('rigorous derivation');
    expect(tasks[0]!.levelId).not.toBe(tasks[1]!.levelId);
    expect(tasks[0]!.taskVersion).not.toBe(tasks[1]!.taskVersion);
  });
  it('inherits a parent override only for its matching academic level', () => {
    const { catalog, areas, parent } = fixture();
    parent.assessmentTasks = [
      {
        levelId: 'primary',
        type: 'practical_demonstration',
        instructions: 'Explain fractions using physical objects.',
      },
    ];
    const tasks = resolveTeachingAssessments(catalog, areas);
    expect(tasks[0]!.instructions).toBe(
      'Explain fractions using physical objects.',
    );
    expect(tasks[0]!.type).toBe('practical_demonstration');
    expect(tasks[1]!.instructions).toContain('rigorous derivation');
  });
  it('uses a child override before a parent override', () => {
    const { catalog, areas, parent, category } = fixture();
    parent.assessmentTasks = [
      {
        levelId: 'primary',
        type: 'knowledge_review',
        instructions: 'Parent task.',
      },
    ];
    category.assessmentTasks = [
      {
        levelId: 'primary',
        type: 'portfolio_review',
        instructions: 'Child task.',
      },
    ];
    expect(resolveTeachingAssessments(catalog, areas)[0]!.instructions).toBe(
      'Child task.',
    );
  });
  it('changes task versions when the level or inherited instructions change', () => {
    const { catalog, areas, parent, primary } = fixture();
    parent.assessmentTasks = [
      {
        levelId: 'primary',
        type: 'knowledge_review',
        instructions: 'Parent task.',
      },
    ];
    const first = resolveTeachingAssessments(catalog, areas)[0]!.taskVersion;
    primary.version++;
    const second = resolveTeachingAssessments(catalog, areas)[0]!.taskVersion;
    parent.version++;
    const third = resolveTeachingAssessments(catalog, areas)[0]!.taskVersion;
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
  });
  it('skips unlisted subjects and unselected academic levels', () => {
    const { catalog, areas } = fixture();
    areas[0]!.levelIds = ['primary'];
    areas.push({
      subjectIds: [],
      otherSubjects: ['New subject'],
      levelIds: ['university'],
      languageIds: [],
    });
    const tasks = resolveTeachingAssessments(catalog, areas);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.levelId).toBe('primary');
  });
});
