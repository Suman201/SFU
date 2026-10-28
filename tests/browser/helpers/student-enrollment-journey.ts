import { expect } from '@playwright/test';
import {
  createClassroomHarness,
  enterTeacherClassroom,
  waitJoined,
  draw,
  assertBoardsEqual,
} from './whiteboard-classroom';
import type { LocalUiStack } from './local-ui-stack';

export async function runStudentEnrollmentJourney(
  stack: LocalUiStack,
  teacherId: string,
) {
  const harness = await createClassroomHarness({ stack, enrollStudent: false });
  const { student, teacher, fixture, urlFor, studentTokens } = harness;
  try {
    const before = await student.request.get(
      `${stack.nodeAUrl}/api/v1/class-sessions/batches/${fixture.batchId}/current`,
      { headers: { Authorization: `Bearer ${studentTokens.accessToken}` } },
    );
    expect(before.status()).toBe(403);
    await student.goto(`${stack.frontendBaseUrl}/teachers?q=Alex%20Morgan`);
    await student.locator(`a[href='/teachers/${teacherId}']`).first().click();
    const row = student.locator(`.batch-row[data-batch-id='${fixture.batchId}']`);
    await row.getByRole('link', { name: 'View classes', exact: true }).click();
    await expect(student).toHaveURL(new RegExp('batchId=' + fixture.batchId));
    await expect(student.locator('.batch-card')).toHaveCount(1);
    await student.getByRole('button', { name: 'Enroll', exact: true }).click();
    await expect(
      student.getByRole('link', { name: 'Enrolled', exact: true }),
    ).toBeVisible();
    const enrolled = await student.request.get(
      `${stack.nodeAUrl}/api/v1/student-enrollments/me/batches`,
      { headers: { Authorization: `Bearer ${studentTokens.accessToken}` } },
    );
    expect(enrolled.status()).toBe(200);
    const payload = await enrolled.json();
    expect(
      (payload.data ?? payload).some(
        (b: any) => b.id === fixture.batchId && b.enrollmentStatus === 'active',
      ),
    ).toBe(true);
    await enterTeacherClassroom(teacher, urlFor('teacher'));
    await student.getByRole('link', { name: 'Enrolled', exact: true }).click();
    const enrolledRow = student.locator(`.enrolled-row[data-batch-id='${fixture.batchId}']`);
    await enrolledRow
      .getByRole('button', { name: 'Join', exact: true })
      .click();
    await expect(student).toHaveURL(/class-session\/student/);
    await student
      .getByRole('button', { name: 'Join Class', exact: true })
      .click();
    await waitJoined(student, 'student');
    await student.locator('.student-whiteboard-button').click();
    await expect(student.locator('sfu-whiteboard')).toBeVisible();
    await draw(teacher, 0);
    await assertBoardsEqual(teacher, student);
  } finally {
    await harness.close();
  }
}
