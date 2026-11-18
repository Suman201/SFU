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
    await expect.poll(async () => (await h.teacher.locator('.whiteboard-surface').boundingBox())?.height ?? 0).toBeGreaterThan(400);
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
    const tools = root.getByRole('group', { name: 'Whiteboard tools', exact: true });
    await tools.scrollIntoViewIfNeeded();
    for (const name of ['Writing Pen', 'Highlighter', 'Eraser', 'Text', 'Pan', 'Select and move', 'Undo', 'Redo', 'Insert', 'Board tools']) {
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

test('tablet teachers can switch tools, write with a resting hand and navigate without adding ink', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const h = await createClassroomHarness({ frontendPort: 4464, backendPort: 3364,
    teacherDevice: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
  const { teacher, student } = h;
  const root = teacher.locator('sfu-whiteboard');
  const button = (name: string) => root.getByRole('button', { name, exact: true });
  const canvas = root.locator('canvas.whiteboard-canvas');
  const input = await h.teacherContext.newCDPSession(teacher);
  const touch = (id: number, x: number, y: number) => ({ id, x, y, radiusX: 6, radiusY: 6 });
  const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
    input.send('Input.dispatchMouseEvent', { type, pointerType: 'pen', x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, force: type === 'mouseReleased' ? 0 : 0.6 });
  try {
    await enterTeacherClassroom(teacher, h.urlFor('teacher'));
    await enterStudentClassroom(student, h.urlFor('student'));
    await teacher.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    const assertToolsReachable = async () => {
      for (const name of ['Writing Pen', 'Highlighter', 'Eraser', 'Pan', 'Drawing color', 'Brush settings', 'Insert', 'Board tools']) {
        const tool = button(name);
        await expect(tool).toBeInViewport({ ratio: 0.99 });
        const hit = await tool.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { reachable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), width: r.width, height: r.height };
        });
        expect(hit.reachable, name).toBe(true);
        expect(hit.width, name).toBeGreaterThanOrEqual(44);
        expect(hit.height, name).toBeGreaterThanOrEqual(44);
      }
    };
    await assertToolsReachable();
    await button('Text').tap();
    await canvas.tap({ position: { x: 78, y: 50 } });
    const title = root.getByRole('textbox', { name: 'Whiteboard text', exact: true });
    await title.fill('Draw a right triangle');
    await title.press('Enter');
    await expect(title).toHaveCount(0);

    await button('Writing Pen').tap();
    const box = (await canvas.boundingBox())!;
    const x = Math.round(box.x + 88), y = Math.round(box.y + 116);
    await pen('mousePressed', x, y);
    for (let i = 1; i <= 10; i++) await pen('mouseMoved', x, y + 12 * i);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(2, x + 305, y + 90)] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (let i = 1; i <= 20; i++) await pen('mouseMoved', x + 10 * i, y + 120);
    for (let i = 1; i <= 20; i++) await pen('mouseMoved', x + 200 - 10 * i, y + 120 - 6 * i);
    await pen('mouseReleased', x, y);
    await assertBoardsEqual(teacher, student);
    const lesson = (await board(teacher)).pages[0];
    expect(lesson.elements.map((e: { type: string }) => e.type)).toEqual(['text', 'stroke']);
    const points = lesson.elements[1].points as Array<{ x: number; y: number }>;
    expect(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))).toBeGreaterThan(175);
    expect(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))).toBeGreaterThan(110);

    await button('Insert').tap();
    await button('Shape options').tap();
    await root.getByRole('button', { name: 'Rectangle', exact: true }).tap();
    await expect(root.locator('.shape-dropdown')).toHaveCount(0);
    await root.screenshot({ path: testInfo.outputPath('tablet-insert.png') });
    await button('Board tools').tap();
    await expect(root.getByRole('group', { name: 'Insert objects' })).toBeHidden();
    await button('Snap to grid').tap();
    await expect(button('Snap to grid')).toHaveAttribute('aria-pressed', 'true');
    await teacher.keyboard.press('Escape');
    await expect(button('Board tools')).toBeFocused();
    await button('Writing Pen').tap();
    await root.screenshot({ path: testInfo.outputPath('tablet-portrait.png') });

    const start = (await canvas.boundingBox())!;
    const tx = Math.round(start.x + 130), ty = Math.round(start.y + 120);
    const first = touch(1, tx, ty), second = touch(2, tx + 70, ty);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, tx - 20, ty + 15), touch(2, tx + 110, ty + 15)] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const moved = (await board(teacher)).pages[0];
    expect(moved.view.zoom).toBeGreaterThan(1.4);
    expect(moved.view.panX).not.toBe(lesson.view.panX);
    expect(moved.elements).toEqual(lesson.elements);
    expect((await board(student)).pages[0].elements).toEqual(lesson.elements);
    await teacher.setViewportSize({ width: 1180, height: 820 });
    await assertToolsReachable();
    await root.screenshot({ path: testInfo.outputPath('tablet-landscape.png') });
  } finally {
    await h.close();
  }
});
