import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createClassroomHarness,
  enterStudentClassroom,
  enterTeacherClassroom,
  assertBoardsEqual,
  board,
  draw,
} from './helpers/whiteboard-classroom';

// Captures the real classroom component with an explicitly illustrative lesson.
// Regenerate for a UI release using SFU_UI_EVIDENCE_DIR; never writes production data.
test('capture the actual whiteboard for the classroom preview', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const h = await createClassroomHarness({
    frontendPort: 4464,
    backendPort: 3364,
  });
  try {
    await h.teacher.setViewportSize({ width: 1420, height: 900 });
    await h.teacherContext.addInitScript(() =>
      localStorage.setItem('native-sfu.theme', 'light'),
    );
    await enterTeacherClassroom(h.teacher, h.urlFor('teacher'));
    await h.teacher.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'light'),
    );
    await h.teacher.locator('sfu-whiteboard').evaluate((element) => {
      const text = (
        id: string,
        value: string,
        x: number,
        y: number,
        size = 24,
        color = '#21362d',
      ) => ({
        id,
        type: 'text',
        text: value,
        color,
        fontSize: size,
        position: { x, y },
      });
      const rectangles = Array.from({ length: 8 }, (_, index) => ({
        id: `quarter-${index}`,
        type: 'shape',
        shape: 'rectangle',
        from: { x: 70 + (index % 4) * 100, y: index < 4 ? 225 : 345 },
        to: { x: 170 + (index % 4) * 100, y: index < 4 ? 285 : 405 },
        width: 2,
        strokeColor: '#326c57',
        fillColor:
          index < 2 || (index >= 4 && index < 7) ? '#b9d7c7' : '#ffffff',
      }));
      (window as any).ng
        .getComponent(element)
        .importBoardState({
          schemaVersion: 1,
          activePageId: 'fractions',
          pages: [
            {
              id: 'fractions',
              title: 'Equivalent fractions',
              order: 0,
              template: 'blank',
              view: { zoom: 1, panX: 0, panY: 0 },
              elements: [
                text('title', 'Adding fractions', 70, 65, 34),
                text('question', 'How much is 1/2 + 1/4?', 70, 125, 25),
                text('label1', '1/2 = 2/4', 510, 240, 25),
                text('label2', '2/4 + 1/4 = 3/4', 510, 360, 25),
                text(
                  'note',
                  'Use the same denominator, then add the numerators.',
                  70,
                  470,
                  20,
                  '#5d6c64',
                ),
                ...rectangles,
              ],
            },
          ],
        });
    });
    await expect
      .poll(async () => (await board(h.teacher)).pages[0].elements.length)
      .toBe(13);
    const destination =
      process.env.SFU_UI_EVIDENCE_DIR ?? testInfo.outputPath('ui-evidence');
    await mkdir(destination, { recursive: true });
    await h.teacher
      .locator('sfu-whiteboard')
      .screenshot({ path: path.join(destination, 'classroom-source.png') });
  } finally {
    await h.close();
  }
});

test('phone whiteboard keeps drawing, history, math and slides reachable', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const h = await createClassroomHarness({ frontendPort: 4464, backendPort: 3364 });
  try {
    await enterTeacherClassroom(h.teacher, h.urlFor('teacher'));
    await enterStudentClassroom(h.student, h.urlFor('student'));
    await h.teacher.setViewportSize({ width: 390, height: 844 });
    const root = h.teacher.locator('sfu-whiteboard');
    const tools = root.getByRole('group', { name: 'Drawing and history' });
    await tools.scrollIntoViewIfNeeded();
    for (const name of ['Writing Pen', 'Eraser', 'Text', 'Select and move', 'Undo', 'Redo']) {
      await expect(tools.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 0.95 });
    }
    const toolbar = (await root.locator('.whiteboard-toolbar').boundingBox())!;
    expect(toolbar.height).toBeLessThan(125);
    for (const name of ['Previous page', 'Add new blank slide', 'Math Grid', 'Slide Deck & Manager']) {
      await expect(root.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 0.95 });
    }

    await draw(h.teacher, 0);
    await assertBoardsEqual(h.teacher, h.student);
    await tools.getByRole('button', { name: 'Undo', exact: true }).click();
    await assertBoardsEqual(h.teacher, h.student);
    expect((await board(h.teacher)).pages[0].elements).toHaveLength(0);
    await tools.getByRole('button', { name: 'Redo', exact: true }).click();
    await assertBoardsEqual(h.teacher, h.student);
    expect((await board(h.teacher)).pages[0].elements).toHaveLength(1);

    await root.getByRole('button', { name: 'Open math tools', exact: true }).click();
    await expect(root.getByRole('dialog', { name: 'Math tools', exact: true })).toBeInViewport();
    await root.getByRole('button', { name: 'Close math tools', exact: true }).click();

    await root.getByRole('button', { name: 'Add new blank slide', exact: true }).click();
    const trigger = root.getByRole('button', { name: 'Slide Deck & Manager', exact: true });
    await trigger.click();
    const deck = root.getByRole('dialog', { name: 'Slide Deck', exact: true });
    await expect(deck.locator('button[aria-current="page"]')).toHaveCount(1);
    await deck.locator('button.page-card').first().press('Enter');
    await expect(deck).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const snapshot = await board(h.teacher);
    expect(snapshot.activePageId).toBe(snapshot.pages[0].id);

    const destination = process.env.SFU_UI_EVIDENCE_DIR ?? testInfo.outputPath('ui-evidence');
    await mkdir(destination, { recursive: true });
    await root.screenshot({ path: path.join(destination, 'whiteboard-phone.png') });
  } finally {
    await h.close();
  }
});
