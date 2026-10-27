import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { board, assertBoardsEqual, draw, pointerStroke, renameBoardPage } from './whiteboard-classroom';

/** Drives classroom permissions and student-attempt actions through their rendered UI. */
export async function runStudentTurnAcceptance(teacher: Page, student: Page, testInfo: TestInfo) {
  const teacherBoard = teacher.locator('sfu-whiteboard');
  const studentBoard = student.locator('sfu-whiteboard');
  const banner = teacher.locator('[aria-label="Active whiteboard controller"]');
  const evidence: Array<Record<string, unknown>> = [];
  const active = async (page: Page) => { const snapshot = await board(page); return snapshot.pages.find((item: any) => item.id === snapshot.activePageId)!; };
  const attempt = () => teacher.locator('sfu-teacher-class-session').evaluate((element) => (window as any).ng.getComponent(element).studentWhiteboardAttempt());
  const allElements = async (page: Page) => (await board(page)).pages.flatMap((item: any) => item.elements);
  const ensureStudentBoard = async () => { if (!await studentBoard.isVisible()) await student.locator('.student-whiteboard-button').click(); await expect(studentBoard).toBeVisible(); };
  const revoke = async () => {
    if (await banner.getByRole('button', { name: 'Revoke', exact: true }).isVisible()) await banner.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(banner.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await ensureStudentBoard();
  };
  const grant = async (mode: string) => {
    await teacher.locator('[aria-label="Whiteboard permission level"]').getByRole('combobox').selectOption(mode);
    await teacher.getByRole('button', { name: /^Allow .+ to control the whiteboard$/ }).click();
    await ensureStudentBoard();
    await expect.poll(() => student.locator('sfu-student-class-session').evaluate((element) => (window as any).ng.getComponent(element).whiteboardPermissionLevel())).toBe(mode);
    if (mode !== 'view_only') await expect(studentBoard.getByRole('button', { name: /^Pen:/ })).toBeEnabled();
    await assertBoardsEqual(teacher, student);
  };
  const point = async (page: Page, x: number, y: number) => {
    const canvas = page.locator('canvas.whiteboard-canvas'); await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('No visible classroom canvas');
    return { x: bounds.x + x, y: bounds.y + y };
  };
  const addText = async (page: Page, text: string, x = 260, y = 120) => {
    const root = page.locator('sfu-whiteboard');
    await root.getByRole('button', { name: 'Text', exact: true }).click();
    const position = await point(page, x, y); await page.mouse.click(position.x, position.y);
    await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).fill(text);
    await root.locator('.text-editor-actions').getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(async () => (await active(page)).elements.some((element: any) => element.text === text)).toBe(true);
  };
  const preserve = async (baseline: any[]) => {
    const elements = await allElements(teacher);
    for (const element of baseline) expect(elements.find((candidate: any) => candidate.id === element.id)).toEqual(element);
    await assertBoardsEqual(teacher, student);
  };

  try {
    await test.step('student turn fixture starts with teacher-authored content', async () => {
      for (const label of ['Exit presentation mode', 'Close math tools']) {
        const close = teacherBoard.getByRole('button', { name: label, exact: true }); if (await close.isVisible()) await close.click();
      }
      await revoke();
      const unlock = teacher.getByRole('button', { name: 'Unlock board', exact: true });
      if (await unlock.isVisible()) await unlock.click();
      await teacherBoard.getByRole('button', { name: 'Add board page', exact: true }).click();
      await renameBoardPage(teacher, 'Student turn acceptance');
      await teacherBoard.getByRole('button', { name: 'Pen settings', exact: true }).click();
      await teacherBoard.locator('.pen-style-grid button').filter({ has: teacher.locator('strong', { hasText: /^Solid$/ }) }).click();
      await teacherBoard.getByRole('button', { name: 'Pen settings', exact: true }).click();
      await draw(teacher, 0); await assertBoardsEqual(teacher, student);
    });
    const teacherBaseline = structuredClone((await active(teacher)).elements);
    const permittedPageId = (await board(teacher)).activePageId;

    await test.step('draw permission restricts tools and Keep retains the student stroke', async () => {
      const before = await allElements(teacher);
      await grant('draw');
      await expect(studentBoard.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
      await expect(studentBoard.getByRole('button', { name: 'Select and move', exact: true })).toBeDisabled();
      await draw(student, 2);
      await expect.poll(async () => (await allElements(teacher)).length).toBe(before.length + 1);
      await assertBoardsEqual(teacher, student);
      const added = (await allElements(teacher)).filter((item: any) => !before.some((previous: any) => previous.id === item.id));
      await expect(banner.getByRole('button', { name: 'Keep', exact: true })).toBeEnabled();
      await banner.getByRole('button', { name: 'Keep', exact: true }).click();
      await expect.poll(async () => (await attempt()).status).toBe('kept');
      await revoke(); await preserve([...teacherBaseline, ...added]);
      evidence.push({ feature: 'draw permission and Keep', retainedStudentIds: added.map((item: any) => item.id) });
    });

    await test.step('annotate allows text and Clear removes only that turn', async () => {
      const baseline = structuredClone(await allElements(teacher));
      await grant('annotate');
      await expect(studentBoard.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
      await addText(student, 'Student annotation to clear');
      await expect.poll(async () => (await allElements(teacher)).length).toBe(baseline.length + 1);
      await assertBoardsEqual(teacher, student);
      const added = (await allElements(teacher)).find((item: any) => item.text === 'Student annotation to clear');
      await expect(banner.getByRole('button', { name: 'Clear', exact: true })).toBeEnabled();
      await banner.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect.poll(async () => (await attempt()).status).toBe('cleared');
      await expect.poll(async () => (await allElements(teacher)).some((item: any) => item.id === added.id)).toBe(false);
      await preserve(baseline); await revoke();
      evidence.push({ feature: 'annotate permission and Clear', removedStudentId: added.id, preservedObjects: baseline.length });
    });

    await test.step('current-page edit permits removal and prevents editing another page', async () => {
      await addText(teacher, 'Disposable teacher object', 320, 250);
      await assertBoardsEqual(teacher, student);
      const disposable = (await active(teacher)).elements.find((item: any) => item.text === 'Disposable teacher object');
      await grant('current_page_edit');
      await expect(studentBoard.getByRole('button', { name: 'Select and move', exact: true })).toBeEnabled();
      await studentBoard.getByRole('button', { name: 'Select and move', exact: true }).click();
      const p = await point(student, disposable.position.x + 8, disposable.position.y + 8);
      await student.mouse.click(p.x, p.y); await student.keyboard.press('Delete');
      await expect.poll(async () => (await allElements(teacher)).some((item: any) => item.id === disposable.id)).toBe(false);
      await preserve(teacherBaseline);
      await teacherBoard.getByRole('button', { name: 'Add board page', exact: true }).click();
      await assertBoardsEqual(teacher, student);
      await expect(studentBoard.getByRole('button', { name: /^Pen:/ })).toHaveCount(0);
      const readOnlyElements = await allElements(student); await pointerStroke(student, 1);
      expect(await allElements(student)).toEqual(readOnlyElements);
      await teacherBoard.locator('.page-tab-list').getByRole('button', { name: 'Student turn acceptance', exact: true }).click();
      await expect.poll(async () => (await board(student)).activePageId).toBe(permittedPageId);
      await expect(studentBoard.getByRole('button', { name: /^Pen:/ })).toBeEnabled();
      await revoke(); await assertBoardsEqual(teacher, student);
      evidence.push({ feature: 'current-page edit and page restriction', permittedPageId, removedDisposableId: disposable.id });
    });

    await test.step('view-only grant cannot add whiteboard content', async () => {
      await grant('view_only');
      await expect(studentBoard.getByRole('button', { name: /^Pen:/ })).toHaveCount(0);
      const before = await allElements(student); await pointerStroke(student, 1);
      expect(await allElements(student)).toEqual(before); await revoke();
      evidence.push({ feature: 'view-only grant', unchangedObjects: before.length });
    });

    await test.step('Save attempt persists a shared PDF that the student can download', async () => {
      await grant('annotate');
      await addText(student, 'Saved student classroom attempt', 260, 300);
      await expect.poll(async () => (await active(teacher)).elements.some((item: any) => item.text === 'Saved student classroom attempt')).toBe(true);
      await preserve(teacherBaseline);
      await banner.getByRole('button', { name: 'Save attempt', exact: true }).click();
      await expect.poll(async () => (await attempt()).status, { timeout: 45_000 }).toBe('saved');
      await revoke();
      const teacherMaterials = teacher.locator('sfu-session-materials');
      await teacherMaterials.getByRole('button', { name: 'Refresh', exact: true }).click();
      const teacherMaterial = teacherMaterials.locator('.material-row').filter({ hasText: /whiteboard[\s_-]+attempt/i }).first();
      await expect(teacherMaterial).toBeVisible({ timeout: 20_000 });
      await expect(teacherMaterial.locator('.shared-pill')).toHaveText('Live');
      const materialTitle = await teacherMaterial.locator('.material-copy strong').innerText();
      await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
      await student.getByRole('button', { name: 'Open class materials', exact: true }).click();
      const studentMaterials = student.locator('#student-session-materials sfu-session-materials');
      await studentMaterials.getByRole('button', { name: 'Refresh', exact: true }).click();
      const studentMaterial = studentMaterials.locator('.material-row').filter({ hasText: materialTitle });
      await expect(studentMaterial).toBeVisible({ timeout: 20_000 });
      const [download] = await Promise.all([
        student.waitForEvent('download'),
        studentMaterial.getByRole('button', { name: 'Save', exact: true }).click()
      ]);
      expect(download.suggestedFilename()).toMatch(/whiteboard[\s_-]+attempt.*\.pdf$/i);
      const file = testInfo.outputPath('student-saved-whiteboard-attempt.pdf');
      await download.saveAs(file);
      const bytes = await readFile(file);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(1000);
      await student.locator('#student-session-materials').getByRole('button', { name: 'Close materials', exact: true }).click();
      await ensureStudentBoard(); await preserve(teacherBaseline);
      evidence.push({ feature: 'Save attempt shared material', materialTitle, bytes: bytes.length, file });
    });
  } finally {
    await writeFile(testInfo.outputPath('whiteboard-student-turn-evidence.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('whiteboard-student-turn-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  }
}
