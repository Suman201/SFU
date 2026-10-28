import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createClassroomHarness,
  enterTeacherClassroom,
  board,
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
