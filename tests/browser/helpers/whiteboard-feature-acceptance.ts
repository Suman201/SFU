import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { board, assertBoardsEqual, renameBoardPage, assertRenderedBoard } from './whiteboard-classroom';

/** Actual classroom UI actions; Angular is read only through the shared board getter. */
export async function runWhiteboardFeatureAcceptance(teacher: Page, student: Page, testInfo: TestInfo) {
  const root = teacher.locator('sfu-whiteboard');
  const evidence: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  teacher.setDefaultTimeout(12000);
  const runStep = async (name: string, action: () => Promise<void>) => {
    console.info(`[whiteboard features] ${name}`);
    try { await test.step(name, action); console.info(`[whiteboard features] PASS ${name}`); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`); evidence.push({ feature: name, error: message });
      console.info(`[whiteboard features] FAIL ${name}: ${message.split('\n')[0]}`);
      await writeFile(testInfo.outputPath('whiteboard-feature-evidence.json'), JSON.stringify(evidence, null, 2));
      await teacher.screenshot({ path: testInfo.outputPath(`feature-failure-${failures.length}.png`), fullPage: true }).catch(() => undefined);
      await teacher.keyboard.press('Escape').catch(() => undefined);
      for (let i = 0; i < 4 && await root.locator('.shape-dropdown-overlay').last().isVisible(); i++) {
        await root.locator('.shape-dropdown-overlay').last().click({ position: { x: 2, y: 2 } }).catch(() => undefined);
      }
      for (const selector of ['.text-editor-shell', '.graph-editor-shell']) {
        const cancel = root.locator(selector).getByRole('button', { name: 'Cancel', exact: true });
        if (await cancel.isVisible()) await cancel.click().catch(() => undefined);
      }
      if (await root.getByRole('button', { name: 'Close math tools', exact: true }).isVisible()) await root.getByRole('button', { name: 'Close math tools', exact: true }).click();
    }
  };
  const active = async () => { const state = await board(teacher); return state.pages.find((page: any) => page.id === state.activePageId)!; };
  const sync = async (feature: string) => {
    await assertBoardsEqual(teacher, student);
    const state = await board(teacher);
    evidence.push({ feature, pages: state.pages.length, objects: state.pages.reduce((n: number, page: any) => n + page.elements.length, 0) });
  };
  const checkTeacherPageTabs = async (context: string) => runStep(`teacher page navigation remains visible ${context}`, async () => {
    const width = await root.locator('.page-tab-list').evaluate((element) => element.getBoundingClientRect().width);
    evidence.push({ feature: `teacher page tab viewport ${context}`, width });
    expect(width, 'Page controls and status must leave room to navigate pages').toBeGreaterThanOrEqual(100);
  });
  const button = (name: string) => root.getByRole('button', { name, exact: true });
  const closeMath = async () => { if (await button('Close math tools').isVisible()) { await button('Close math tools').click(); await expect(button('Close math tools')).toHaveCount(0); } };
  const menu = async (name: string) => {
    // Wait for the preceding click to render without dismissing the current object selection.
    const expanded = await root.evaluate((element) => Boolean((window as any).ng.getComponent(element).menuOpen()));
    await expect(button('Menu')).toHaveAttribute('aria-expanded', String(expanded));
    if (!expanded) await button('Menu').click();
    await expect(root.locator('.menu-dropdown')).toBeVisible();
    await root.locator('.menu-dropdown').getByRole('button', { name, exact: true }).click();
  };
  const newPage = async (name: string) => {
    await closeMath();
    await button('Add board page').click();
    await renameBoardPage(teacher, name);
    await sync(`new page: ${name}`);
  };
  const point = async (x = 150, y = 130) => {
    const canvas = root.locator('canvas.whiteboard-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const bounds = (await canvas.boundingBox())!;
    return { x: bounds.x + Math.min(x, bounds.width * 0.6), y: bounds.y + Math.min(y, bounds.height * 0.6) };
  };
  const drag = async (x = 120, y = 110, dx = 130, dy = 75) => {
    const start = await point(x, y);
    await teacher.mouse.move(start.x, start.y); await teacher.mouse.down();
    await teacher.mouse.move(start.x + dx, start.y + dy, { steps: 12 }); await teacher.mouse.up();
  };
  const math = async (tab: string) => {
    if (!await button('Close math tools').isVisible()) await menu('Math tools');
    await root.locator('.math-tools-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  const context = async (name: string) => {
    const p = await active(); const element = p.elements[0];
    const position = element.points?.[0] ?? element.from ?? element.position ?? { x: 150, y: 130 };
    const origin = await point(0, 0);
    await teacher.mouse.click(origin.x + position.x + 2, origin.y + position.y + 2, { button: 'right' });
    await root.getByRole('menu', { name: 'Element actions' }).getByRole('menuitem', { name, exact: true }).click();
    await sync(`context menu: ${name}`);
  };
  try {
    await runStep('feature fixture resets through visible page controls after large-board proof', async () => {
      const revoke = teacher.getByRole('button', { name: /^Revoke whiteboard control for / });
      if (await revoke.isVisible()) await revoke.click();
      await expect(student.getByRole('button', { name: /^Pen:/ })).toHaveCount(0);
      while ((await board(teacher)).pages.length > 1) { await button('Remove current board page').click(); await sync('remove large-fixture page'); }
      await button('Clear whiteboard').click(); await sync('clear remaining fixture page');
      await checkTeacherPageTabs('with normal controls');
    });
    await runStep('read-only student can pan, zoom and reset without changing teacher content', async () => {
      const studentRoot = student.locator('sfu-whiteboard');
      const studentActive = async () => { const state = await board(student); return state.pages.find((page: any) => page.id === state.activePageId)!; };
      const teacherBefore = await board(teacher); const studentBefore = await board(student);
      await studentRoot.getByRole('button', { name: 'Pan', exact: true }).click();
      const bounds = (await studentRoot.locator('canvas').boundingBox())!;
      await student.mouse.move(bounds.x + 120, bounds.y + 150); await student.mouse.down(); await student.mouse.move(bounds.x + 180, bounds.y + 180, { steps: 8 }); await student.mouse.up();
      expect((await studentActive()).view.panX).not.toBe(0);
      await studentRoot.getByRole('button', { name: 'Menu', exact: true }).click();
      await studentRoot.locator('.menu-dropdown').getByRole('button', { name: 'Zoom In', exact: true }).click();
      expect((await studentActive()).view.zoom).toBeGreaterThan(1); await student.keyboard.press('Escape');
      expect(await board(teacher)).toEqual(teacherBefore);
      expect((await studentActive()).elements).toEqual(studentBefore.pages.find((page: any) => page.id === studentBefore.activePageId)!.elements);
      const localView = (await studentActive()).view;
      await root.getByRole('button', { name: /^Pen:/ }).click(); await drag(120, 130, 100, 35);
      await expect.poll(async () => (await studentActive()).elements.length).toBe((await active()).elements.length);
      expect((await studentActive()).view).toEqual(localView);
      await studentRoot.getByRole('button', { name: 'Menu', exact: true }).click();
      await studentRoot.locator('.menu-dropdown').getByRole('button', { name: /^Reset View/ }).click();
      expect((await studentActive()).view).toEqual({ zoom: 1, panX: 0, panY: 0 });
      await button('Undo').click(); await sync('student local navigation preserves teacher work');
    });
    await runStep('all pen styles, width, opacity, smoothing, color, undo and redo synchronize', async () => {
      await newPage('Acceptance drawing');
      for (const [index, style] of ['Solid', 'Dashed', 'Dotted', 'Marker', 'Pencil', 'Calligraphy'].entries()) {
        await button('Pen settings').click();
        await root.locator('.pen-style-grid button').filter({ has: teacher.locator('strong', { hasText: new RegExp(`^${style}$`) }) }).click();
        await root.getByRole('slider', { name: 'Pen width', exact: true }).fill('6');
        await root.getByRole('slider', { name: 'Pen opacity', exact: true }).fill('0.75');
        await root.getByRole('slider', { name: 'Pen smoothing', exact: true }).fill('0.35');
        await button('Pen settings').click();
        await drag(90, 80 + index * 36, 150, 20);
        const ink = (await active()).elements.at(-1);
        expect(ink.penStyle).toBe(style.toLowerCase()); expect(ink.width).toBe(6); expect(ink.opacity).toBe(0.75);
        await sync(`pen style: ${style}`);
      }
      expect((await active()).elements.length).toBe(6);
      await button('Pen settings').click();
      await root.getByRole('checkbox', { name: 'Auto close', exact: true }).check();
      await root.locator('.pen-threshold-row').getByRole('button', { name: 'Loose', exact: true }).click();
      await button('Pen settings').click();
      const start = await point(350, 310);
      await teacher.mouse.move(start.x, start.y); await teacher.mouse.down();
      for (const [dx, dy] of [[90, 0], [90, 70], [0, 70], [5, 5]]) await teacher.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
      await teacher.mouse.up();
      expect((await active()).elements.at(-1)).toMatchObject({ closed: true, autoCloseThreshold: 44 });
      await sync('pen auto close');
      await button('Pen settings').click(); await root.getByRole('checkbox', { name: 'Auto close', exact: true }).uncheck(); await button('Pen settings').click();
      await button('Drawing color').click();
      await root.locator('.color-dropdown button.color-swatch').nth(1).click();
      await drag(310, 100); await sync('drawing color');
      await button('Undo').click(); await sync('toolbar undo');
      await button('Redo').click(); await sync('toolbar redo');
      await root.locator('canvas').click({ position: { x: 400, y: 90 } });
      await teacher.keyboard.press('ControlOrMeta+z'); await sync('keyboard undo');
      await teacher.keyboard.press('ControlOrMeta+Shift+z'); await sync('keyboard redo');
    });
    await runStep('all eraser modes modify shared strokes', async () => {
      for (const mode of ['Partial', 'Stroke', 'Area']) {
        await newPage(`Acceptance eraser ${mode}`);
        await button('Pen settings').click(); await root.locator('.pen-style-grid button').filter({ hasText: 'Clean continuous ink' }).click(); await button('Pen settings').click();
        await drag(100, 100, 180, 0); const beforeErase = (await active()).elements;
        await root.getByRole('button', { name: /^Eraser:/ }).click(); await button('Eraser settings').click();
        await root.locator('.eraser-mode-grid button').filter({ has: teacher.locator('strong', { hasText: new RegExp(`^${mode}$`) }) }).click();
        await button('Eraser settings').click(); await drag(190, 90, 0, 30);
        expect((await active()).elements).not.toEqual(beforeErase); await sync(`eraser mode: ${mode}`);
      }
    });
    await runStep('every shape, diagram and geometry tool emits a matching shared object', async () => {
      await newPage('Acceptance shapes');
      for (const [index, shape] of ['Line', 'Arrow', 'Rectangle', 'Ellipse', 'Star'].entries()) {
        await button('Shape options').focus(); await teacher.keyboard.press('Enter');
        await root.locator('.shape-dropdown:not(.diagram-dropdown)').getByRole('button', { name: shape, exact: true }).click();
        const before = (await active()).elements.length;
        await drag(80 + index * 35, 90 + index * 25, 140, 80);
        expect((await active()).elements.length).toBe(before + 1); expect((await active()).elements.at(-1).shape).toBe(shape.toLowerCase()); await sync(`shape: ${shape}`);
      }
      await button('Fill shape').click(); expect((await active()).elements.at(-1).fillColor).toBeTruthy(); await sync('shape fill');
      for (const diagram of ['Venn', 'Nodes', 'Tree', 'Flow', 'Probability']) {
        await button('Diagram options').focus(); await teacher.keyboard.press('Enter');
        await root.locator('.diagram-dropdown').getByRole('button', { name: diagram, exact: true }).click();
        const before = (await active()).elements.length;
        const start = await point(200, 160); await teacher.mouse.click(start.x, start.y);
        expect((await active()).elements.length).toBe(before + 1); expect((await active()).elements.at(-1).type).toBe('diagram'); await sync(`diagram: ${diagram}`);
      }
    });
    await runStep('all geometry tools and snap controls work', async () => {
      await newPage('Acceptance geometry');
      for (const geometry of ['Ruler', 'Protractor', 'Compass', 'Angle', 'Straightedge', 'Parallel', 'Perpendicular', 'Midpoint', 'Point', 'Vector', 'Polygon', 'Arc']) {
        await math('Geometry');
        await root.locator('.math-tool-grid').getByRole('button', { name: geometry, exact: true }).click();
        await closeMath(); const before = (await active()).elements.length;
        await drag(160, 130, 150, 90);
        expect((await active()).elements.length).toBe(before + 1); expect((await active()).elements.at(-1).type).toBe('geometry'); await sync(`geometry: ${geometry}`);
      }
      await newPage('Acceptance snapping');
      await button('Menu').click(); await root.getByRole('combobox', { name: 'Angle snap increment', exact: true }).selectOption('0'); await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
      await button('Snap to grid').click(); await expect(button('Snap to grid')).toHaveAttribute('aria-pressed', 'true');
      await button('Shape options').click(); await root.locator('.shape-dropdown:not(.diagram-dropdown)').getByRole('button', { name: 'Rectangle', exact: true }).click();
      await drag(341, 311, 89, 65); const snapped = (await active()).elements.at(-1);
      for (const value of [snapped.from.x, snapped.from.y, snapped.to.x, snapped.to.y]) expect(value % 24).toBeCloseTo(0, 5);
      await sync('grid snap positions'); await button('Snap to grid').click();
      await button('Snap to points').click(); await expect(button('Snap to points')).toHaveAttribute('aria-pressed', 'true');
      await button('Shape options').click(); await root.locator('.shape-dropdown:not(.diagram-dropdown)').getByRole('button', { name: 'Line', exact: true }).click();
      await drag(snapped.from.x + 4, snapped.from.y + 4, 140, 80);
      expect((await active()).elements.at(-1).from).toEqual(snapped.from); await sync('point snap positions'); await button('Snap to points').click();
      await button('Menu').click(); await root.getByRole('combobox', { name: 'Angle snap increment', exact: true }).selectOption('45'); await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
      await button('Snap to grid').click(); await drag(501, 411, 110, 60); const angled = (await active()).elements.at(-1);
      expect(Math.abs(angled.to.x - angled.from.x)).toBeCloseTo(Math.abs(angled.to.y - angled.from.y), 4); await sync('angle snap'); await button('Snap to grid').click();
      await menu('Hide measurements'); await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
      await math('Geometry'); await root.locator('.math-tool-grid').getByRole('button', { name: 'Ruler', exact: true }).click(); await closeMath();
      await drag(150, 200, 140, 70); expect((await active()).elements.at(-1).showMeasurement).toBe(false); await sync('measurement visibility');
      await menu('Show measurements'); await root.getByRole('combobox', { name: 'Angle snap increment', exact: true }).selectOption('0'); await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
    });
    await runStep('text, equation shortcuts and math templates synchronize through rendered editors', async () => {
      await newPage('Acceptance text');
      await button('Text').click(); const start = await point(130, 110); await teacher.mouse.click(start.x, start.y);
      await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).fill('Classroom explanation');
      await root.locator('.text-editor-actions').getByRole('button', { name: 'Done', exact: true }).click();
      await sync('text editor'); expect((await active()).elements[0].text).toBe('Classroom explanation');
      await context('Edit text/equation');
      await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).fill('Revised classroom explanation');
      await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).press('ControlOrMeta+Enter');
      await sync('text edit keyboard commit');
      for (const alignment of ['center', 'right', 'left']) {
        await context(`Text align ${alignment}`); expect((await active()).elements[0].align).toBe(alignment);
      }
      await context('Edit text/equation'); await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).fill('x^2 + 1');
      await root.getByRole('textbox', { name: 'Whiteboard text', exact: true }).press('ControlOrMeta+Enter');
      await context('Convert to equation'); expect((await active()).elements[0].type).toBe('equation');

    });
    await runStep('equations, snippets and page templates synchronize', async () => {
      await newPage('Acceptance equation'); await math('Equation');
      await root.locator('.math-equation-input').fill('x^2 + y^2 = r^2');
      await root.getByRole('button', { name: 'Insert equation', exact: true }).click(); await closeMath(); await sync('equation editor');
      expect((await active()).elements[0].type).toBe('equation');
      await math('Snippets'); await root.locator('.math-snippet-grid button').first().click();
      await math('Equation'); await expect(root.locator('.math-equation-input')).not.toHaveValue(''); await closeMath();
      for (const template of ['blank', 'ruled', 'grid', 'graph', 'coordinate', 'number-line', 'geometry', 'table', 'fraction']) {
        await root.getByRole('combobox', { name: 'Board template', exact: true }).selectOption(template); await sync(`background template: ${template}`);
      }
      await math('Templates'); await root.locator('.math-template-grid.compact button').first().click(); await closeMath(); await sync('movable board template');
    });
    await runStep('function graph, matrix and table editors synchronize their data', async () => {
      await newPage('Acceptance graph'); await math('Graph');
      await root.locator('.math-feature-button').click(); await closeMath();
      await root.getByRole('textbox', { name: 'Function expressions', exact: true }).fill('x^2\nsin(x)');
      await root.getByRole('textbox', { name: 'Graph title', exact: true }).fill('Classroom functions');
      await root.locator('.graph-editor-shell').getByLabel('Inequality', { exact: true }).fill('y > x + 2');
      const graphEditor = root.locator('.graph-editor-shell');
      for (const [label, value] of Object.entries({ 'Point x': '1', 'Tangent x': '2', 'Shade a': '-1', 'Shade b': '1', 'x(t)': 'cos(t)', 'y(t)': 'sin(t)', 't min': '0', 't max': '6.28', 'r(theta)': '2sin(theta)', 'theta min': '0', 'theta max': '6.28', 'Scatter points': '1,2; 2,4; 3,5', 'Histogram data': '1,2,2,3,4,5', 'Bins': '3', 'Mean': '0', 'Std dev': '1', 'Labels': '0,0,Origin' })) {
        await graphEditor.getByLabel(label, { exact: true }).fill(value);
      }
      await graphEditor.getByLabel('Regression', { exact: true }).check();
      await graphEditor.getByLabel('Intercepts', { exact: true }).check();
      await root.locator('.graph-editor-shell').getByRole('button', { name: 'Done', exact: true }).click();
      await expect(root.locator('.graph-editor-shell')).toHaveCount(0); await sync('function graph with inequality');
      const graph = (await active()).elements[0];
      expect(graph.type).toBe('graph'); expect(graph.functions.length).toBe(2);
      expect(graph.helpers).toMatchObject({ pointX: 1, tangentX: 2, shadeFrom: -1, shadeTo: 1, showIntercepts: true });
      expect(graph.parametric).toMatchObject({ xExpression: 'cos(t)', yExpression: 'sin(t)' });
      expect(graph.polar.expression).toBe('2sin(theta)'); expect(graph.scatterPoints).toBe('1,2; 2,4; 3,5');
      expect(graph.stats).toMatchObject({ histogramBins: 3, normalMean: 0, normalStdDev: 1, showRegression: true });
      expect(graph.labels[0].text).toBe('Origin');
      await context('Edit graph'); await root.getByRole('textbox', { name: 'Graph title', exact: true }).fill('Revised functions');
      await root.locator('.graph-editor-shell').getByRole('button', { name: 'Done', exact: true }).click();
      expect((await active()).elements[0].title).toBe('Revised functions'); await sync('edit graph');
    });
    await runStep('matrix and table creation and editing synchronize', async () => {
      for (const mode of ['Matrix', 'Table']) {
        await newPage(`Acceptance ${mode}`); await math('Matrices');
        await root.locator('.matrix-mode-toggle').getByRole('button', { name: mode, exact: true }).click();
        await root.getByRole('textbox', { name: 'Cell 1, 1', exact: true }).fill('42');
        await root.getByRole('button', { name: 'Insert object', exact: true }).click(); await closeMath();
        await sync(`${mode.toLowerCase()} editor`); expect((await active()).elements[0].cells[0][0]).toBe('42');
        await context('Edit matrix/table'); await root.getByRole('textbox', { name: 'Cell 1, 1', exact: true }).fill('84');
        await root.getByRole('button', { name: 'Update object', exact: true }).click(); await closeMath();
        expect((await active()).elements[0].cells[0][0]).toBe('84'); await sync(`edit ${mode.toLowerCase()}`);
      }
    });
    await runStep('subject starters and page metadata, ordering, filtering and duplication synchronize', async () => {
      await newPage('Acceptance subjects'); await math('Subjects');
      const search = root.getByRole('searchbox', { name: 'Search templates', exact: true });
      await search.fill('Equation Solving');
      await root.locator('.subject-template-card').first().getByRole('button', { name: 'Current page', exact: true }).click();
      await closeMath(); await sync('subject template current page');
      expect((await active()).elements.length).toBeGreaterThan(0);
      await math('Subjects'); await root.getByRole('searchbox', { name: 'Search templates', exact: true }).fill('');
      for (const category of ['Algebra', 'Calculus', 'Geometry', 'Physics', 'Chemistry', 'Economics', 'Coding / CS', 'Probability', 'Statistics', 'Accounting']) {
        await root.locator('.subject-category-list').getByRole('button', { name: category, exact: true }).click();
        const before = (await active()).elements.length;
        await root.locator('.subject-template-card').first().getByRole('button', { name: 'As object', exact: true }).click();
        expect((await active()).elements.length).toBeGreaterThan(before); await sync(`subject category as object: ${category}`);
      }
      const beforeSubjectPage = (await board(teacher)).pages.length;
      await root.locator('.subject-template-card').first().getByRole('button', { name: 'New page', exact: true }).click();
      expect((await board(teacher)).pages.length).toBe(beforeSubjectPage + 1); await closeMath(); await sync('subject template new page');
      await root.getByRole('textbox', { name: 'Current board page tags' }).fill('acceptance, algebra');
      await root.getByRole('textbox', { name: 'Current board page tags' }).press('Tab'); await sync('page tags');
      await root.getByRole('searchbox', { name: 'Search board pages' }).fill('Acceptance subjects');
      await expect(root.locator('.page-tab-list button')).toHaveCount(1);
      await root.getByRole('searchbox', { name: 'Search board pages' }).fill('');
      for (const action of ['Duplicate current board page', 'Add blank page before current page', 'Add blank page after current page']) {
        const count = (await board(teacher)).pages.length; await button(action).click();
        expect((await board(teacher)).pages.length).toBe(count + 1); await sync(action);
      }
      await button('Remove current board page').click(); await sync('remove page');
      await button('Undo').click(); await sync('restore removed page with undo');
    });
    await runStep('selection context actions, clipboard and pan/zoom work without losing shared objects', async () => {
      await newPage('Acceptance selection');
      await button('Shape options').click(); await root.locator('.shape-dropdown').getByRole('button', { name: 'Rectangle', exact: true }).click();
      await drag(140, 130, 100, 70); await sync('selection fixture');
      await context('Duplicate'); expect((await active()).elements.length).toBe(2);
      await button('Select and move').click();
      const p = await point(150, 145); await teacher.mouse.click(p.x, p.y);
      await teacher.keyboard.press('ControlOrMeta+a');
      await context('Group'); const grouped = (await active()).elements; expect(grouped[0].groupId).toBeTruthy(); expect(grouped[1].groupId).toBe(grouped[0].groupId);
      await context('Ungroup'); expect((await active()).elements.every((element: any) => !element.groupId)).toBeTruthy();
      await context('Transform'); const beforeMove = (await active()).elements;
      await drag(155, 145, 35, 20); const moved = (await active()).elements;
      expect(moved[0].from).not.toEqual(beforeMove[0].from); expect(moved[1].from).not.toEqual(beforeMove[1].from); await sync('selection drag move');
      await teacher.keyboard.press('ControlOrMeta+a');
      const shapes = (await active()).elements; const maxX = Math.max(...shapes.flatMap((element: any) => [element.from.x, element.to.x]));
      const maxY = Math.max(...shapes.flatMap((element: any) => [element.from.y, element.to.y]));
      const beforeResize = (await active()).elements; await drag(maxX, maxY, 40, 30);
      expect((await active()).elements).not.toEqual(beforeResize); await sync('selection resize handle');
      await teacher.keyboard.press('ControlOrMeta+a');
      for (const alignment of ['left', 'center', 'right']) {
        await context(`Align objects ${alignment}`);
        const positions = (await active()).elements.map((element: any) => alignment === 'left' ? Math.min(element.from.x, element.to.x) : alignment === 'right' ? Math.max(element.from.x, element.to.x) : (element.from.x + element.to.x) / 2);
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.01);
      }
      await context('Duplicate'); await teacher.keyboard.press('ControlOrMeta+a'); await context('Distribute vertically');
      const distributed = (await active()).elements.map((element: any) => ({ top: Math.min(element.from.y, element.to.y), bottom: Math.max(element.from.y, element.to.y) })).sort((a: any, b: any) => a.top - b.top);
      const gaps = distributed.slice(1).map((item: any, index: number) => item.top - distributed[index].bottom);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.01);
      for (const action of ['Bring to front', 'Send to back', 'Bring forward', 'Send backward', 'Flip horizontal', 'Flip vertical', 'Rotate left', 'Rotate right']) await context(action);
      const beforePaste = (await active()).elements.length;
      await teacher.keyboard.press('ControlOrMeta+c'); await teacher.keyboard.press('ControlOrMeta+v'); await sync('copy and paste');
      expect((await active()).elements.length).toBeGreaterThan(beforePaste); const beforeRemove = (await active()).elements.length;
      await context('Remove'); expect((await active()).elements.length).toBeLessThan(beforeRemove);
      await menu('Zoom In'); expect((await active()).view.zoom).toBeGreaterThan(1);
      await root.locator('.menu-dropdown').getByRole('button', { name: /^Reset View/ }).click();
      expect((await active()).view).toEqual({ zoom: 1, panX: 0, panY: 0 });
      await button('Pan').click(); await drag(100, 100, 40, 30);
      expect((await active()).view.panX).not.toBe(0);
      await menu('Zoom Out'); expect((await active()).view.zoom).toBeLessThan(1);
      await root.locator('.menu-dropdown').getByRole('button', { name: /^Reset View/ }).click();
      expect((await active()).view).toEqual({ zoom: 1, panX: 0, panY: 0 });
      evidence.push({ feature: 'pan and zoom reset', view: (await active()).view });
    });
    await runStep('image object, page background, slide images and PDF page imports synchronize and export', async () => {
      await newPage('Acceptance imports');
      const image = { name: 'classroom.png', mimeType: 'image/png', buffer: pngFixture() };
      await button('Import image or PDF object').click(); await root.locator('input[type=file]').setInputFiles(image);
      await expect.poll(async () => (await active()).elements.length).toBe(1); await sync('image object import');
      await checkTeacherPageTabs('after import status');
      await runStep('fit selected image', async () => {
        const originalImage = (await active()).elements[0];
        await button('Select and move').click(); const imagePoint = await point(originalImage.position.x + originalImage.width / 2, originalImage.position.y + originalImage.height / 2); await teacher.mouse.click(imagePoint.x, imagePoint.y);
        await menu('Fit asset to page'); const fitted = (await active()).elements[0];
        expect(fitted.width).toBeGreaterThan(originalImage.width); expect(fitted.width).toBeCloseTo(fitted.height, 2); await sync('fit selected image');
      });
      await menu('Add page background'); await root.locator('input[type=file]').setInputFiles(image);
      await expect.poll(async () => (await active()).background?.fileName).toBe('classroom.png'); await sync('page background import');
      await menu('Fit asset to page'); await sync('fit asset');
      for (const item of [{ action: 'Export page PNG', extension: '.png' }, { action: 'Export page PDF', extension: '.pdf' }, { action: 'Export all pages', extension: '.pdf' }]) await runStep(`download ${item.action}`, async () => {
        const [download] = await Promise.all([teacher.waitForEvent('download', { timeout: 30000 }), menu(item.action)]);
        expect(download.suggestedFilename().endsWith(item.extension)).toBeTruthy();
        const output = testInfo.outputPath(`feature-${item.action.replaceAll(' ', '-')}${item.extension}`); await download.saveAs(output);
        const contents = await readFile(output); expect(contents.length).toBeGreaterThan(100);
        evidence.push({ feature: item.action, bytes: contents.length, path: output });
      });
      for (const mode of ['raster', 'hybrid']) await runStep(`download ${mode} PDF`, async () => {
        await button('Menu').click(); await root.getByRole('combobox', { name: 'PDF export mode', exact: true }).selectOption(mode);
        const [download] = await Promise.all([teacher.waitForEvent('download', { timeout: 30000 }), root.locator('.menu-dropdown').getByRole('button', { name: 'Export page PDF', exact: true }).click()]);
        const output = testInfo.outputPath(`feature-${mode}.pdf`); await download.saveAs(output);
        const contents = await readFile(output); expect(contents.toString('latin1').startsWith('%PDF-')).toBeTruthy();
        evidence.push({ feature: `PDF mode ${mode}`, bytes: contents.length, path: output });
      });
      await runStep('download selected PDF pages', async () => {
        await button('Menu').click();
        const checkbox = root.locator('.export-page-option').first().getByRole('checkbox');
        await root.locator('.export-pages-panel-head').getByRole('button', { name: 'All', exact: true }).click();
        await expect(checkbox).toBeChecked();
        await root.locator('.export-pages-panel-head').getByRole('button', { name: 'Clear', exact: true }).click();
        await expect(checkbox).not.toBeChecked();
        await checkbox.check(); await expect(checkbox).toBeChecked(); await expect(root.locator('.selected-pages-export')).toBeEnabled();
        const [selectedPdf] = await Promise.all([teacher.waitForEvent('download', { timeout: 30000 }), root.locator('.selected-pages-export').click()]);
        const selectedPath = testInfo.outputPath('feature-selected-pages.pdf'); await selectedPdf.saveAs(selectedPath);
        expect((await readFile(selectedPath)).toString('latin1')).toContain('/Count 1'); evidence.push({ feature: 'selected page export', path: selectedPath });
      });
      await menu('Reset page background'); await sync('remove background');
      await runStep('import a PDF document object', async () => {
        const beforePdfObject = (await active()).elements.length;
        await button('Import image or PDF object').click();
        await root.locator('input[type=file]').setInputFiles({ name: 'reference.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
        await expect.poll(async () => (await active()).elements.length).toBe(beforePdfObject + 1); await sync('PDF document object import');
      });
      await runStep('import slide image pages', async () => {
        const beforeSlides = (await board(teacher)).pages.length;
        await menu('Import slide images'); await expect(root.locator('input[type=file]')).toHaveAttribute('multiple', '');
        await root.locator('input[type=file][multiple]').setInputFiles([image, { ...image, name: 'classroom-two.png' }]);
        await expect.poll(async () => (await board(teacher)).pages.length).toBe(beforeSlides + 2); await sync('slide image pages');
      });
      await runStep('import rendered PDF pages', async () => {
        const beforePdf = (await board(teacher)).pages.length;
        await menu('Import PDF pages'); await expect(root.locator('input[type=file]')).toHaveAttribute('accept', '.pdf,application/pdf');
        await root.locator('input[type=file]').setInputFiles({ name: 'worksheet.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
        await expect.poll(async () => (await board(teacher)).pages.length, { timeout: 30000 }).toBe(beforePdf + 1); await sync('PDF page import');
      });
    });
    await runStep('Attach board notes uploads a PDF and shares it to student materials', async () => {
      await teacher.getByRole('button', { name: 'Open media controls', exact: true }).click();
      const [uploaded, shared] = await Promise.all([
        teacher.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/materials/upload')).then(async (response) => {
          expect(response.ok(), `Notes upload HTTP ${response.status()}: ${await response.text()}`).toBeTruthy(); return response;
        }),
        teacher.waitForResponse((response) => response.request().method() === 'POST' && /\/materials\/[^/]+\/share/.test(response.url())),
        teacher.getByRole('menuitem', { name: 'Attach board notes', exact: true }).click()
      ]);
      expect(uploaded.ok()).toBeTruthy();
      const uploadBody = await uploaded.json(); const material = (uploadBody.data ?? uploadBody)[0];
      expect(material.mimeType).toBe('application/pdf'); expect(material.size).toBeGreaterThan(1000);
      expect(shared.ok()).toBeTruthy();
      if (await student.locator('.student-whiteboard-drawer').isVisible()) await student.getByRole('button', { name: 'Close whiteboard', exact: true }).click();
      await student.getByRole('button', { name: 'Open class materials', exact: true }).click();
      await expect(student.locator('.shared-card')).toContainText(material.title, { timeout: 15000 });
      await student.locator('.student-materials-drawer').getByRole('button', { name: 'Close materials', exact: true }).click();
      if (!await student.locator('sfu-whiteboard').isVisible()) await student.locator('.student-whiteboard-button').click();
      evidence.push({ feature: 'attach board notes', materialId: material.materialId, title: material.title, size: material.size });
    });
    await runStep('presentation, laser and narrow-screen keyboard navigation remain usable', async () => {
      await menu('Presentation mode'); await expect(button('Exit presentation mode')).toBeVisible();
      const laser = root.locator('.presentation-controls').getByRole('button', { name: 'Laser pointer', exact: true });
      await laser.click(); const pos = await point(200, 150); await teacher.mouse.move(pos.x, pos.y);
      await expect(root.locator('.laser-dot')).toBeVisible();
      const controls = root.locator('.presentation-controls');
      if (await controls.getByRole('button', { name: 'Edit on', exact: true }).isVisible()) await controls.getByRole('button', { name: 'Edit on', exact: true }).click();
      await expect(controls.getByRole('button', { name: 'Pen', exact: true })).toBeDisabled();
      await controls.getByRole('button', { name: 'Edit off', exact: true }).click();
      for (const [label, style] of [['Pen', 'solid'], ['Highlighter', 'marker']]) {
        await controls.getByRole('button', { name: label, exact: true }).click(); const before = (await active()).elements.length;
        await drag(100, 120, 100, 30); expect((await active()).elements.length).toBe(before + 1);
        expect((await active()).elements.at(-1).penStyle).toBe(style); await sync(`presentation ${label.toLowerCase()}`);
      }
      await controls.getByRole('button', { name: 'Edit on', exact: true }).click();
      await expect(controls.getByRole('button', { name: 'Pen', exact: true })).toBeDisabled();
      await button('Previous page').click(); await sync('presentation previous page');
      await button('Next page').click(); await sync('presentation next page');
      await button('Exit presentation mode').click();
      await teacher.setViewportSize({ width: 1366, height: 768 });
      await button('Shape options').focus(); await teacher.keyboard.press('Enter');
      await expect(root.getByRole('button', { name: 'Star', exact: true })).toBeVisible();
      await root.getByRole('button', { name: 'Star', exact: true }).click();
      await math('Matrices'); await root.getByRole('button', { name: 'Insert object', exact: true }).scrollIntoViewIfNeeded();
      await expect(root.getByRole('button', { name: 'Insert object', exact: true })).toBeInViewport();
      await teacher.screenshot({ path: testInfo.outputPath('features-narrow-math-controls.png'), fullPage: true });
      await closeMath(); await teacher.setViewportSize({ width: 1680, height: 1100 });
    });
    await runStep('phone portrait keeps basic teacher controls and student page navigation reachable', async () => {
      await teacher.setViewportSize({ width: 390, height: 844 });
      await student.setViewportSize({ width: 390, height: 844 });
      try {
        for (const [role, page] of [['teacher', teacher], ['student', student]] as const) {
          const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
          evidence.push({ feature: `${role} phone layout`, ...dimensions });
          expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
        }
        await button('Menu').scrollIntoViewIfNeeded(); await expect(button('Menu')).toBeInViewport();
        await button('Menu').click();
        await expect(root.locator('.menu-dropdown')).toBeInViewport();
        await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
        await button('Pen settings').scrollIntoViewIfNeeded(); await expect(button('Pen settings')).toBeInViewport();
        await button('Pen settings').click(); await expect(root.locator('.pen-dropdown')).toBeInViewport();
        await teacher.keyboard.press('Escape'); await expect(root.locator('.menu-dropdown')).toHaveCount(0);
        await assertRenderedBoard(student, 250);
        evidence.push({ feature: 'student phone canvas', bounds: await student.locator('canvas.whiteboard-canvas').boundingBox() });
        const studentTabs = student.locator('sfu-whiteboard .page-tab-list button');
        const firstTitle = await studentTabs.first().innerText();
        await studentTabs.first().scrollIntoViewIfNeeded(); await studentTabs.first().click();
        await expect.poll(async () => { const state = await board(student); return state.pages.find((page: any) => page.id === state.activePageId)?.title; }).toBe(firstTitle);
        await expect(student.getByRole('button', { name: /^Pen:/ })).toHaveCount(0);
        const teacherBoard = (await root.boundingBox())!; const teacherCanvas = (await root.locator('canvas.whiteboard-canvas').boundingBox())!;
        const sidebar = (await teacher.locator('.session-sidebar').boundingBox())!;
        evidence.push({ feature: 'teacher phone vertical layout', teacherBoard, teacherCanvas, sidebar });
        expect(Math.max(teacherBoard.y + teacherBoard.height, teacherCanvas.y + teacherCanvas.height), 'Teacher sidebar must not overlap the board').toBeLessThanOrEqual(sidebar.y + 1);
        await teacher.screenshot({ path: testInfo.outputPath('teacher-phone-portrait.png'), fullPage: true });
        await student.screenshot({ path: testInfo.outputPath('student-phone-portrait.png'), fullPage: true });
        const teacherState = await board(teacher); const index = teacherState.pages.findIndex((page: any) => page.id === teacherState.activePageId);
        await studentTabs.nth(index).click();
      } finally {
        await teacher.setViewportSize({ width: 1680, height: 1100 }); await student.setViewportSize({ width: 1680, height: 1100 });
      }
    });
  } finally {
    evidence.push({ limitations: ['Real stylus pressure and touch/gesture hardware not exercised by a mouse-driven browser.', 'Every preset permutation and visual result across all browsers is not exhaustively tested.'], failures });
    await writeFile(testInfo.outputPath('whiteboard-feature-evidence.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('whiteboard-feature-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  }
  expect(failures, 'Every feature group should complete; screenshots and evidence include all failures').toEqual([]);
}

function pngFixture(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (64 * 3 + 1));
  for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column++) { const i = row * 193 + 1 + column * 3; pixels[i] = 242; pixels[i + 1] = row * 3; pixels[i + 2] = column * 3; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function pdfFixture(): Buffer {
  const stream = 'BT /F1 20 Tf 40 160 Td (Classroom worksheet) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content); content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}
