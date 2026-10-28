import { approveFixtureContent } from './tutor-launch-acceptance';
import { resolveTeachingAssessments } from '@native-sfu/contracts';
import { expect, type Page } from '@playwright/test';

type Api = (
  method: string,
  url: string,
  token: string | undefined,
  data?: any,
  expected?: number,
) => Promise<any>;
/** Runs against the same real backend and isolated database as tutor onboarding. */
export async function exerciseFlexibleTeachingCatalog(
  api: Api,
  page: Page,
  adminPage: Page,
  teacherId: string,
  teacherToken: string,
  adminToken: string,
  studentToken: string,
) {
  const create = (kind: string, data: any) =>
    api('POST', '/admin/teaching-catalog/' + kind, adminToken, data, 201);
  const root = await create('category', { name: 'Acceptance sciences' });
  const child = await create('category', {
    name: 'Applied physics',
    parentId: root.id,
  });
  const leaf = await create('category', {
    name: 'Specialist quantum practice',
    parentId: child.id,
  });
  const subject = await create('subject', {
    name: 'Quantum laboratory methods',
    parentId: leaf.id,
  });
  await api(
    'PATCH',
    '/admin/teaching-catalog/category/' + root.id,
    adminToken,
    { name: root.name, version: root.version, parentId: leaf.id },
    400,
  );
  await api(
    'PATCH',
    '/admin/teaching-catalog/category/' + child.id,
    adminToken,
    { name: child.name, version: child.version, parentId: child.id },
    400,
  );
  await api(
    'PATCH',
    '/admin/teaching-catalog/category/' + root.id,
    adminToken,
    { name: root.name, version: root.version, status: 'archived' },
    409,
  );
  await approveFixtureContent(api, adminToken);
  const catalog = await api('GET', '/teaching-catalog', undefined);
  const english = catalog.languages.find((l: any) => l.name === 'English');
  const french = catalog.languages.find((l: any) => l.name === 'French');
  const primary = catalog.levels.find((l: any) => l.name === 'Primary school');
  const university = catalog.levels.find(
    (l: any) => l.name === 'University – undergraduate',
  );
  const sourceCategories = catalog.categories.filter((c: any) =>
    catalog.subjects.some((s: any) => s.parentId === c.id),
  );
  const areas = sourceCategories.map((c: any) => ({
    categoryId: c.id,
    subjectIds: catalog.subjects
      .filter((s: any) => s.parentId === c.id)
      .map((s: any) => s.id),
    otherSubjects: [],
    levelIds: [c.id === leaf.id ? university.id : primary.id],
    languageIds: [c.id === leaf.id ? french.id : english.id],
  }));
  expect(areas.length).toBeGreaterThan(8);
  expect(areas.flatMap((a: any) => a.subjectIds).length).toBeGreaterThan(268);
  const example =
    'I begin with the learner’s existing understanding, demonstrate a worked example, discuss a common misconception, and ask the learner to explain a new example in their own words to check understanding.';
  const responses = resolveTeachingAssessments(catalog, areas).map((a) => ({
    categoryId: a.categoryId,
    levelId: a.levelId,
    taskVersion: a.taskVersion,
    response: example.repeat(25).slice(0, 4000),
  }));
  await api(
    'PATCH',
    '/profile/me',
    studentToken,
    { teachingAreas: areas },
    403,
  );
  await api(
    'PATCH',
    '/profile/me',
    teacherToken,
    {
      teachingAreas: [{ ...areas[0], levelIds: ['000000000000000000000000'] }],
    },
    400,
  );
  await api(
    'PATCH',
    '/profile/me',
    teacherToken,
    {
      teachingAreas: [
        {
          ...areas[0],
          categoryId: leaf.id,
          subjectIds: [areas[0].subjectIds[0]],
        },
      ],
    },
    400,
  );
  expect(
    Buffer.byteLength(
      JSON.stringify({ teachingAreas: areas, assessmentResponses: responses }),
    ),
  ).toBeGreaterThan(100 * 1024);
  await api('PATCH', '/profile/me', teacherToken, {
    teachingAreas: areas,
    assessmentResponses: responses,
  });
  await page.reload();
  await page.getByRole('button', { name: '2 Subjects & learners' }).click();
  await expect(page.locator('.area-card')).toHaveCount(areas.length);
  await page
    .getByLabel('Teaching category', { exact: true })
    .selectOption('other');
  await page
    .getByRole('button', { name: 'Add teaching area', exact: false })
    .click();
  const other = page.locator('.area-card').last();
  await other
    .getByLabel('Other subject names')
    .fill('Specialist ceramic restoration\nMuseum object care');
  await other
    .getByRole('checkbox', { name: 'University – undergraduate', exact: true })
    .check();
  await other.getByLabel('Find teaching languages').fill('French');
  await other.getByRole('checkbox', { name: 'French', exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Profile updated.' }),
  ).toBeVisible();
  let app = await api('GET', '/tutor-application/me', teacherToken);
  expect(app.teachingAreas).toHaveLength(areas.length + 1);
  expect(app.requiredAssessments).toHaveLength(areas.length);
  expect(app.missing).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: '2 Subjects & learners' }).click();
  await page.locator('.area-card').last().locator('summary').click();
  await expect(page.getByLabel('Other subject names')).toHaveValue(
    'Specialist ceramic restoration\nMuseum object care',
  );
  const submit = async () => {
    app = await api('GET', '/tutor-application/me', teacherToken);
    return api(
      'POST',
      '/tutor-application/submit',
      teacherToken,
      {
        revision: app.revision,
        adultTutorConfirmed: true,
        codeOfConductAccepted: true,
        safeguardingAccepted: true,
      },
      201,
    );
  };
  const review = async (submitted: any, changes: any = {}) =>
    api(
      'POST',
      '/admin/tutor-applications/' + teacherId + '/review',
      adminToken,
      {
        decision: 'approved',
        revision: submitted.revision,
        note: 'Teaching areas, introduction and experience reviewed.',
        introVideoReviewed: true,
        identityChecked: true,
        teachingSuitabilityChecked: true,
        safeguardingChecked: true,
        assessmentResults: submitted.requiredAssessments.map((a: any) => ({
          categoryId: a.categoryId,
          levelId: a.levelId,
          taskVersion: a.taskVersion,
          version: a.version,
          passed: true,
          notes: 'Relevant teaching example reviewed.',
        })),
        ...changes,
      },
      changes.teachingSuitabilityChecked === false ? 400 : 201,
    );
  const submitted = await submit();
  await adminPage.goto('http://127.0.0.1:4465/tutor-applications');
  await adminPage.getByRole('button', { name: 'Review Alex Morgan' }).click();
  await expect(
    adminPage.getByText('Specialist ceramic restoration, Museum object care', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    adminPage.getByText('No preset assessment applies.', { exact: false }),
  ).toBeVisible();
  await review(submitted);
  const find = async (
    categoryId: string,
    levelId: string,
    languageId: string,
  ) =>
    api(
      'GET',
      `/teachers?categoryId=${categoryId}&levelId=${levelId}&languageId=${languageId}`,
      undefined,
    );
  expect(
    (await find(root.id, university.id, french.id)).teachers.map(
      (t: any) => t.teacherId,
    ),
  ).toContain(teacherId);
  expect(
    (await find(leaf.id, primary.id, english.id)).teachers.map(
      (t: any) => t.teacherId,
    ),
  ).not.toContain(teacherId);
  expect(
    (await find(root.id, university.id, english.id)).teachers.map(
      (t: any) => t.teacherId,
    ),
  ).not.toContain(teacherId);
  const publicProfile = await api(
    'GET',
    `/teachers/${teacherId}/profile`,
    undefined,
  );
  expect(publicProfile.teachingAreas).toHaveLength(areas.length + 1);
  expect(
    (
      await api('GET', '/teachers?q=ceramic%20restoration', undefined)
    ).teachers.map((t: any) => t.teacherId),
  ).toContain(teacherId);
  // Other-only onboarding skips preset tasks, while approval still requires a reviewer.
  const otherArea = app.teachingAreas.find((a: any) => !a.categoryId);
  await api('PATCH', '/profile/me', teacherToken, {
    teachingAreas: [otherArea],
    assessmentResponses: [],
  });
  const onlyOther = await api('GET', '/tutor-application/me', teacherToken);
  expect(onlyOther.requiredAssessments).toEqual([]);
  expect(onlyOther.missing).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: '5 Teaching assessment' }).click();
  await expect(
    page.getByText(
      'No preset assessment is required for your Other subjects.',
      { exact: false },
    ),
  ).toBeVisible();
  const otherSubmitted = await submit();
  await review(otherSubmitted, { teachingSuitabilityChecked: false });
  await review(otherSubmitted);
  // Admins can manage academic levels and teaching languages through the same catalogue UI.
  await adminPage.goto('http://127.0.0.1:4465/teaching-catalog');
  await adminPage
    .getByRole('button', { name: 'Teaching languages', exact: true })
    .click();
  await adminPage
    .getByRole('button', { name: 'Add language', exact: true })
    .click();
  await adminPage
    .getByLabel('Name', { exact: true })
    .fill('Acceptance teaching language');
  await adminPage
    .getByRole('button', { name: 'Save language', exact: true })
    .click();
  await expect(adminPage.getByRole('status')).toContainText('Catalogue saved.');
  await adminPage
    .getByRole('button', { name: 'Academic levels', exact: true })
    .click();
  await expect(
    adminPage.getByRole('cell', { name: 'Primary school', exact: true }),
  ).toBeVisible();
}
