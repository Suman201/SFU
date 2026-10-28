import { approveFixtureContent } from './tutor-launch-acceptance';
import { expect, type Page } from '@playwright/test';
import path from 'node:path';
type Api = (
  method: string,
  url: string,
  token: string | undefined,
  data?: any,
  expected?: number,
) => Promise<any>;
export async function exerciseLevelAssessments(
  api: Api,
  page: Page,
  adminPage: Page,
  teacherId: string,
  teacherToken: string,
  adminToken: string,
  screens: string,
) {
  let catalog = await api('GET', '/teaching-catalog', undefined);
  const subject = catalog.subjects.find((s: any) => s.name === 'Algebra');
  const category = catalog.categories.find(
    (c: any) => c.id === subject.parentId,
  );
  const primary = catalog.levels.find((l: any) => l.name === 'Primary school');
  const university = catalog.levels.find(
    (l: any) => l.name === 'University – undergraduate',
  );
  const english = catalog.languages.find((l: any) => l.name === 'English');
  await api('PATCH', '/profile/me', teacherToken, {
    teachingAreas: [
      {
        categoryId: category.id,
        subjectIds: [subject.id],
        levelIds: [primary.id, university.id],
        languageIds: [english.id],
        otherSubjects: [],
      },
    ],
    assessmentResponses: [],
  });
  const original = await api('GET', '/tutor-application/me', teacherToken);
  expect(original.requiredAssessments).toHaveLength(2);
  expect(original.requiredAssessments[0].instructions).not.toBe(
    original.requiredAssessments[1].instructions,
  );
  const example =
    'I demonstrate a correct worked example, explain the assumptions and a common misconception, then ask the learner to solve a new problem independently and explain each step to check their understanding.';
  await api('PATCH', '/profile/me', teacherToken, {
    assessmentResponses: original.requiredAssessments.map((t: any) => ({
      categoryId: t.categoryId,
      levelId: t.levelId,
      taskVersion: t.taskVersion,
      response: example,
    })),
  });
  const primaryTask =
    'Use physical fraction strips to explain equivalent fractions to a primary-school learner. Give a correct worked example and an age-appropriate check of understanding.';
  const universityTask =
    'Derive a result about linear transformations for an undergraduate learner. State assumptions, provide a rigorous proof and design a conceptual problem that tests understanding.';
  await adminPage.goto('http://127.0.0.1:4465/teaching-catalog');
  await adminPage
    .getByRole('searchbox', { name: 'Search catalogue' })
    .fill(category.name);
  await adminPage.getByRole('button', { name: 'Search', exact: true }).click();
  await adminPage
    .getByRole('button', { name: 'Edit ' + category.name, exact: true })
    .click();
  const taskCases = [
    [primary, primaryTask],
    [university, universityTask],
  ];
  for (const [index, [level, text]] of taskCases.entries()) {
    await adminPage
      .getByRole('button', { name: 'Add level-specific task' })
      .click();
    await expect(
      adminPage.getByLabel('Task academic level', { exact: true }),
    ).toHaveCount(index + 1);
    await adminPage
      .getByLabel('Task academic level', { exact: true })
      .nth(index)
      .selectOption(level.id);
    await adminPage
      .getByLabel('Task instructions', { exact: true })
      .nth(index)
      .fill(text);
  }
  await adminPage.locator('.catalog-editor').screenshot({
    path: path.join(screens, 'admin-level-assessment-tasks.png'),
  });
  await adminPage
    .getByRole('button', { name: 'Save category', exact: true })
    .click();
  await expect(adminPage.getByRole('status')).toContainText('Catalogue saved.');
  let application = await api('GET', '/tutor-application/me', teacherToken);
  expect(
    application.missing.filter((m: string) =>
      m.includes('teaching assessment'),
    ),
  ).toHaveLength(2);
  const submit = (app: any, expected = 201) =>
    api(
      'POST',
      '/tutor-application/submit',
      teacherToken,
      {
        revision: app.revision,
        adultTutorConfirmed: true,
        codeOfConductAccepted: true,
        safeguardingAccepted: true,
      },
      expected,
    );
  await submit(application, 400);
  expect(
    application.requiredAssessments.every((task: any) => !task.contentApproved),
  ).toBe(true);
  await adminPage
    .getByRole('button', {
      name: 'Review assessment content ' + category.name,
      exact: true,
    })
    .click();
  const review = adminPage.getByRole('region', {
    name: 'Expert assessment content review',
  });
  await review
    .getByLabel('Reviewer expertise', { exact: true })
    .fill(
      'Synthetic acceptance fixture: mathematics teacher and curriculum reviewer.',
    );
  await review
    .getByLabel('Content review findings', { exact: true })
    .fill(
      'Synthetic task instructions, academic stages and rubric reviewed for this test.',
    );
  await review.getByRole('checkbox').check();
  await review.screenshot({
    path: path.join(screens, 'admin-expert-content-review.png'),
  });
  await review
    .getByRole('button', { name: 'Record expert approval', exact: true })
    .click();
  await expect(review).toHaveCount(0);
  const publicCatalog = await api('GET', '/teaching-catalog', undefined);
  const publicEntry = publicCatalog.categories.find(
    (entry: any) => entry.id === category.id,
  );
  expect(publicEntry.assessmentApprovedVersion).toBe(publicEntry.version);
  expect(publicEntry.assessmentApproval).toBeUndefined();
  await adminPage
    .getByRole('button', { name: 'Check onboarding readiness', exact: true })
    .click();
  await expect(
    adminPage.getByRole('region', { name: 'Onboarding readiness report' }),
  ).toContainText('Encrypted verification storage: Passed');
  await approveFixtureContent(api, adminToken);
  await page.reload();
  await page.getByRole('button', { name: '5 Teaching assessment' }).click();
  await expect(page.getByText(primaryTask, { exact: true })).toBeVisible();
  await expect(page.getByText(universityTask, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This task has changed' }),
  ).toHaveCount(2);
  for (const [i, t] of application.requiredAssessments.entries()) {
    await page
      .locator(`[data-assessment-key='${t.categoryId}:${t.levelId}']`)
      .getByLabel('Your teaching response', { exact: true })
      .fill(example + ' My example is appropriate for ' + t.levelName + '.');
  }
  await page.locator('.edit-panel').screenshot({
    path: path.join(screens, 'teacher-level-assessments.png'),
    style: 'sfu-header{visibility:hidden!important}',
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Profile updated.' }),
  ).toBeVisible();
  application = await api('GET', '/tutor-application/me', teacherToken);
  expect(application.missing).toEqual([]);
  const submitted = await submit(application);
  const decision = {
    decision: 'approved',
    revision: submitted.revision,
    note: 'Primary and undergraduate tasks reviewed independently.',
    introVideoReviewed: true,
    identityChecked: true,
    teachingSuitabilityChecked: true,
    safeguardingChecked: true,
    assessmentResults: submitted.requiredAssessments.map((t: any) => ({
      categoryId: t.categoryId,
      levelId: t.levelId,
      taskVersion: t.taskVersion,
      version: t.version,
      passed: true,
      notes: 'Teaching example is appropriate to the academic level.',
    })),
  };
  await api(
    'POST',
    `/admin/tutor-applications/${teacherId}/review`,
    adminToken,
    { ...decision, assessmentResults: decision.assessmentResults.slice(0, 1) },
    400,
  );
  await api(
    'POST',
    `/admin/tutor-applications/${teacherId}/review`,
    adminToken,
    {
      ...decision,
      assessmentResults: decision.assessmentResults.map((t: any) => ({
        ...t,
        taskVersion: 'outdated-task',
      })),
    },
    400,
  );
  await api(
    'POST',
    `/admin/tutor-applications/${teacherId}/review`,
    adminToken,
    decision,
    201,
  );
  await api(
    'POST',
    '/admin/teaching-catalog/category',
    adminToken,
    {
      name: 'Invalid task fixture',
      assessmentTasks: [
        {
          levelId: '000000000000000000000000',
          type: 'knowledge_review',
          instructions: primaryTask,
        },
      ],
    },
    400,
  );
}
