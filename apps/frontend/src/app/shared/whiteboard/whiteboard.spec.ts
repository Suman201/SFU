import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import { Whiteboard, type WhiteboardCommand, type WhiteboardElement, type WhiteboardPage } from './whiteboard';

interface WhiteboardHarness {
  pushHistory(): void;
  addElement(element: WhiteboardElement): void;
  undo(): void;
  redo(): void;
  addPage(): void;
  selectPage(pageId: string): void;
  removeActivePage(): void;
  insertImportedPages(pages: WhiteboardPage[]): void;
  resetPageBackground(): void;
  showLaser(point: { x: number; y: number }): void;
  render(includeOverlays?: boolean): void;
  captureStreamActive: boolean;
  selectedElementIds: { set(ids: string[]): void };
  selectTool(tool: string): void;
  startDrawing(event: PointerEvent): void;
  draw(event: PointerEvent): void;
  stopDrawing(event: PointerEvent): void;
  handleKeyboardShortcut(event: KeyboardEvent): void;
  groupSelected(): void;
  ungroupSelected(): void;
  openContextMenu(event: MouseEvent): void;
  bringSelectedToFront(): void;
  sendSelectedToBack(): void;
}

describe('Whiteboard collaboration and classroom controls', () => {
  const initial: WhiteboardMemorySnapshot = {
    schemaVersion: 1,
    activePageId: 'page-1',
    pages: [{ id: 'page-1', title: 'Lesson', tags: [], order: 0, template: 'blank', view: { zoom: 1, panX: 0, panY: 0 }, background: null, elements: [] }]
  };
  const fixtures: ComponentFixture<Whiteboard>[] = [];
  const stroke = (id: string, color = '#071c41'): WhiteboardElement => ({ id, type: 'stroke', color, width: 4, points: [{ x: 20, y: 20 }, { x: 60, y: 60 }] });
  const harness = (fixture: ComponentFixture<Whiteboard>) => fixture.componentInstance as unknown as WhiteboardHarness;
  const elementIds = (board: Whiteboard) => board.exportBoardState().pages.flatMap((page) => page.elements.map((element) => element['id']));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Whiteboard] }).compileComponents();
  });

  afterEach(() => {
    fixtures.splice(0).forEach((fixture) => fixture.destroy());
  });

  function createBoard(allowPageManagement = true): ComponentFixture<Whiteboard> {
    const fixture = TestBed.createComponent(Whiteboard);
    fixtures.push(fixture);
    fixture.componentRef.setInput('initialState', structuredClone(initial));
    fixture.componentRef.setInput('allowPageManagement', allowPageManagement);
    fixture.nativeElement.style.width = '800px';
    fixture.nativeElement.style.height = '600px';
    fixture.detectChanges();
    return fixture;
  }

  function connect(first: Whiteboard, second: Whiteboard): void {
    first.commandCommitted.subscribe((command) => second.applyCommand(command));
    second.commandCommitted.subscribe((command) => first.applyCommand(command));
  }

  it('synchronizes undo and redo without removing the other author\'s newer stroke', () => {
    const teacher = createBoard();
    const student = createBoard(false);
    connect(teacher.componentInstance, student.componentInstance);
    harness(teacher).pushHistory();
    harness(teacher).addElement(stroke('teacher'));
    harness(student).pushHistory();
    harness(student).addElement(stroke('student'));

    harness(teacher).undo();
    expect(elementIds(teacher.componentInstance)).toEqual(['student']);
    expect(elementIds(student.componentInstance)).toEqual(['student']);
    harness(teacher).redo();
    expect(elementIds(teacher.componentInstance).sort()).toEqual(['student', 'teacher']);
    expect(elementIds(student.componentInstance).sort()).toEqual(['student', 'teacher']);
  });

  it('synchronizes stacking changes and undo while preserving subsequent remote work', () => {
    const teacher = createBoard();
    const student = createBoard(false);
    connect(teacher.componentInstance, student.componentInstance);
    for (const id of ['a', 'b', 'c', 'd']) {
      harness(teacher).pushHistory();
      harness(teacher).addElement(stroke(id));
    }
    harness(teacher).selectedElementIds.set(['a', 'b']);
    harness(teacher).bringSelectedToFront();
    expect(elementIds(teacher.componentInstance)).toEqual(['c', 'd', 'a', 'b']);
    expect(elementIds(student.componentInstance)).toEqual(['c', 'd', 'a', 'b']);
    harness(student).pushHistory();
    harness(student).addElement(stroke('remote'));
    const commands: WhiteboardCommand[] = [];
    teacher.componentInstance.commandCommitted.subscribe((command) => commands.push(command));
    harness(teacher).undo();
    expect(elementIds(teacher.componentInstance)).toEqual(['a', 'b', 'c', 'd', 'remote']);
    expect(elementIds(student.componentInstance)).toEqual(['a', 'b', 'c', 'd', 'remote']);
    expect(commands.some((command) => command.type === 'upsert' && command.element.id === 'remote')).toBeFalse();
    harness(teacher).redo();
    expect(elementIds(student.componentInstance)).toEqual(['c', 'd', 'a', 'b', 'remote']);
    harness(teacher).selectedElementIds.set(['a', 'b']);
    harness(teacher).sendSelectedToBack();
    expect(elementIds(student.componentInstance)).toEqual(['a', 'b', 'c', 'd', 'remote']);
  });

  it('preserves a remote edit to an existing local object across undo', () => {
    const fixture = createBoard();
    harness(fixture).pushHistory();
    harness(fixture).addElement(stroke('shared'));
    fixture.componentInstance.applyCommand({ type: 'upsert', pageId: 'page-1', element: stroke('shared', '#F26076') });
    harness(fixture).undo();
    expect(fixture.componentInstance.exportBoardState().pages[0]!.elements[0]!['color']).toBe('#F26076');
  });

  it('broadcasts imported page backgrounds and page navigation, and requests autosave', () => {
    const teacher = createBoard();
    const student = createBoard(false);
    connect(teacher.componentInstance, student.componentInstance);
    const changed = jasmine.createSpy('stateChanged');
    teacher.componentInstance.stateChanged.subscribe(changed);
    harness(teacher).insertImportedPages([{
      id: 'pdf-page', title: 'Worksheet p1', tags: [], template: 'blank', view: { zoom: 1, panX: 0, panY: 0 }, elements: [],
      background: { kind: 'image', sourceType: 'pdf-page', fileName: 'worksheet.pdf', dataUrl: 'data:image/png;base64,', naturalWidth: 800, naturalHeight: 600, fit: 'contain', importedAt: '2026-10-27T00:00:00.000Z' }
    }]);
    const remote = student.componentInstance.exportBoardState();
    expect(remote.activePageId).toBe('pdf-page');
    expect(remote.pages[1]!.title).toBe('Worksheet p1');
    expect(remote.pages[1]!.background?.['fileName']).toBe('worksheet.pdf');
    expect(changed).toHaveBeenCalled();
    harness(teacher).resetPageBackground();
    expect(student.componentInstance.exportBoardState().pages[1]!.background).toBeNull();
    harness(teacher).selectPage('page-1');
    expect(student.componentInstance.currentPageId()).toBe('page-1');
  });

  it('rejects oversized imported pages before changing the board or emitting commands', () => {
    const fixture = createBoard();
    const commands = jasmine.createSpy('commandCommitted');
    fixture.componentInstance.commandCommitted.subscribe(commands);
    const before = fixture.componentInstance.exportBoardState();
    const page: WhiteboardPage = {
      id: 'too-large', title: 'Oversized PDF', tags: [], template: 'blank', view: { zoom: 1, panX: 0, panY: 0 }, elements: [],
      background: { kind: 'image', fileName: 'large.pdf', dataUrl: 'data:image/png;base64,' + 'A'.repeat(900_000), naturalWidth: 1800, naturalHeight: 1200, fit: 'contain', importedAt: '2026-10-27T00:00:00.000Z' }
    };
    expect(() => harness(fixture).insertImportedPages([page])).toThrowError(/too large to share/);
    expect(fixture.componentInstance.exportBoardState()).toEqual(before);
    expect(commands).not.toHaveBeenCalled();
    page.background!.dataUrl = 'data:image/png;base64,' + 'A'.repeat(760_000);
    const second = { ...structuredClone(page), id: 'also-large' };
    expect(() => harness(fixture).insertImportedPages([page, second])).toThrowError(/saved board size limit/);
    expect(fixture.componentInstance.exportBoardState()).toEqual(before);
    expect(commands).not.toHaveBeenCalled();
  });

  it('synchronizes page creation, removal and restoration', () => {
    const teacher = createBoard();
    const student = createBoard(false);
    connect(teacher.componentInstance, student.componentInstance);
    harness(teacher).addPage();
    const addedId = teacher.componentInstance.currentPageId();
    expect(student.componentInstance.currentPageId()).toBe(addedId);
    harness(teacher).removeActivePage();
    expect(student.componentInstance.exportBoardState().pages.length).toBe(1);
    harness(teacher).undo();
    expect(student.componentInstance.exportBoardState().pages.map((page) => page.id)).toContain(addedId);
  });

  it('does not emit teacher-only page commands when a student undoes a stroke', () => {
    const fixture = createBoard(false);
    const commands: WhiteboardCommand[] = [];
    fixture.componentInstance.commandCommitted.subscribe((command) => commands.push(command));
    harness(fixture).pushHistory();
    harness(fixture).addElement(stroke('student'));
    commands.length = 0;
    harness(fixture).undo();
    expect(commands).toEqual([{ type: 'delete', elementId: 'student', pageId: 'page-1' }]);
  });

  it('reports local student page navigation without broadcasting teacher-only commands', () => {
    const fixture = createBoard(false);
    fixture.componentInstance.importBoardState({
      ...structuredClone(initial),
      pages: [...structuredClone(initial.pages), { ...structuredClone(initial.pages[0]!), id: 'page-2', order: 1 }]
    });
    fixture.componentRef.setInput('readOnly', true);
    fixture.detectChanges();
    const commands = jasmine.createSpy('commandCommitted');
    const changed = jasmine.createSpy('stateChanged');
    fixture.componentInstance.commandCommitted.subscribe(commands);
    fixture.componentInstance.stateChanged.subscribe(changed);
    harness(fixture).selectPage('page-2');
    expect(fixture.componentInstance.currentPageId()).toBe('page-2');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(commands).not.toHaveBeenCalled();
  });

  it('provides a native pen settings button and prevents read-only undo', () => {
    const fixture = createBoard();
    const settings = fixture.nativeElement.querySelector('button[aria-label="Pen settings"]') as HTMLButtonElement;
    expect(settings).toBeTruthy();
    const bounds = settings.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThanOrEqual(36);
    expect(bounds.height).toBeGreaterThanOrEqual(36);
    settings.focus();
    expect(document.activeElement).toBe(settings);
    settings.click();
    fixture.detectChanges();
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="group"][aria-label="Pen settings"]')).toBeTruthy();
    harness(fixture).pushHistory();
    harness(fixture).addElement(stroke('protected'));
    fixture.componentRef.setInput('readOnly', true);
    fixture.detectChanges();
    harness(fixture).undo();
    expect(elementIds(fixture.componentInstance)).toEqual(['protected']);
    expect(fixture.nativeElement.querySelector('button[aria-label="Undo"]')).toBeNull();
  });

  it('paints the laser into captured frames, clears it on timeout and omits it from export', () => {
    const fixture = createBoard();
    const board = harness(fixture);
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const arc = spyOn(context, 'arc').and.callThrough();
    jasmine.clock().install();
    board.captureStreamActive = true;
    board.showLaser({ x: 80, y: 80 });
    expect(arc).toHaveBeenCalledWith(80, 80, 4, 0, Math.PI * 2);
    arc.calls.reset();
    board.render(false);
    expect(arc).not.toHaveBeenCalled();
    const clear = spyOn(context, 'clearRect').and.callThrough();
    jasmine.clock().tick(900);
    expect(clear).toHaveBeenCalled();
    expect(arc).not.toHaveBeenCalled();
    jasmine.clock().uninstall();
  });
  it('exposes keyboard-focusable shape and diagram option menus', () => {
    const fixture = createBoard();
    for (const label of ['Shape options', 'Diagram options']) {
      const button = fixture.nativeElement.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(button).toBeTruthy();
      expect(button.disabled).toBeFalse();
      button.focus();
      expect(document.activeElement).toBe(button);
      button.click();
      fixture.detectChanges();
      expect(button.getAttribute('aria-expanded')).toBe('true');
      button.click();
      fixture.detectChanges();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('preserves multi-selection on a selected object context click and synchronizes grouping and ungrouping', () => {
    const student = createBoard(false);
    const teacher = createBoard();
    connect(teacher.componentInstance, student.componentInstance);
    harness(teacher).pushHistory();
    harness(teacher).addElement(stroke('first'));
    harness(teacher).addElement({ ...stroke('second'), type: 'stroke', color: '#F26076', width: 4, points: [{ x: 120, y: 120 }, { x: 160, y: 160 }] });
    harness(teacher).selectedElementIds.set(['first', 'second']);
    const surface = teacher.nativeElement.querySelector('.whiteboard-surface') as HTMLElement;
    const bounds = surface.getBoundingClientRect();
    harness(teacher).openContextMenu(new MouseEvent('contextmenu', { clientX: bounds.left + 20, clientY: bounds.top + 20 }));
    harness(teacher).groupSelected();
    const grouped = teacher.componentInstance.exportBoardState().pages[0]!.elements;
    expect(grouped[0]!['groupId']).toBeTruthy();
    expect(grouped[1]!['groupId']).toBe(grouped[0]!['groupId']);
    expect(student.componentInstance.exportBoardState()).toEqual(teacher.componentInstance.exportBoardState());
    harness(teacher).ungroupSelected();
    expect(teacher.componentInstance.exportBoardState().pages[0]!.elements.every((element) => !element['groupId'])).toBeTrue();
    expect(student.componentInstance.exportBoardState()).toEqual(teacher.componentInstance.exportBoardState());
  });

  it('drags every selected object together and broadcasts both moved positions', () => {
    const student = createBoard(false);
    const teacher = createBoard();
    connect(teacher.componentInstance, student.componentInstance);
    for (const [id, x] of [['first', 140], ['second', 280]] as const) {
      harness(teacher).addElement({ id, type: 'shape', shape: 'rectangle', strokeColor: '#071c41', fillColor: null, width: 3, from: { x, y: 130 }, to: { x: x + 100, y: 200 } });
    }
    harness(teacher).selectTool('select');
    harness(teacher).selectedElementIds.set(['first', 'second']);
    const canvas = teacher.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    spyOn(canvas, 'setPointerCapture').and.stub();
    const bounds = (teacher.nativeElement.querySelector('.whiteboard-surface') as HTMLElement).getBoundingClientRect();
    harness(teacher).startDrawing(new PointerEvent('pointerdown', { pointerId: 1, clientX: bounds.left + 190, clientY: bounds.top + 165, button: 0, buttons: 1 }));
    harness(teacher).draw(new PointerEvent('pointermove', { pointerId: 1, clientX: bounds.left + 210, clientY: bounds.top + 185, buttons: 1 }));
    harness(teacher).stopDrawing(new PointerEvent('pointerup', { pointerId: 1 }));
    const elements = teacher.componentInstance.exportBoardState().pages[0]!.elements;
    expect(elements[0]!['from']).toEqual({ x: 160, y: 150 });
    expect(elements[1]!['from']).toEqual({ x: 300, y: 150 });
    expect(student.componentInstance.exportBoardState()).toEqual(teacher.componentInstance.exportBoardState());
    harness(teacher).undo();
    expect(teacher.componentInstance.exportBoardState().pages[0]!.elements[0]!['from']).toEqual({ x: 140, y: 130 });
    expect(teacher.componentInstance.exportBoardState().pages[0]!.elements[1]!['from']).toEqual({ x: 280, y: 130 });
  });

  it('keeps dropdown triggers clickable and lets Escape dismiss menus while a slider has focus', () => {
    const fixture = createBoard();
    const trigger = fixture.nativeElement.querySelector('button[aria-label="Pen settings"]') as HTMLButtonElement;
    trigger.click(); fixture.detectChanges();
    trigger.scrollIntoView({ block: 'center' });
    const bounds = trigger.getBoundingClientRect();
    expect(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest('button')).toBe(trigger);
    const slider = fixture.nativeElement.querySelector('input[aria-label="Pen width"]') as HTMLInputElement;
    slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.shape-dropdown-overlay')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    const diagram = fixture.nativeElement.querySelector('button[aria-label="Diagram options"]') as HTMLButtonElement;
    diagram.click(); fixture.detectChanges();
    diagram.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.diagram-dropdown')).toBeNull();
  });

  it('selects all current-page objects with Ctrl/Cmd+A while preserving text editing and read-only restrictions', () => {
    const fixture = createBoard();
    harness(fixture).addElement(stroke('first'));
    harness(fixture).addElement(stroke('second'));
    harness(fixture).selectedElementIds.set([]);
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true });
    harness(fixture).handleKeyboardShortcut(event);
    expect(event.defaultPrevented).toBeTrue();
    expect((harness(fixture).selectedElementIds as unknown as (() => string[]))()).toEqual(['first', 'second']);
    harness(fixture).selectedElementIds.set([]);
    const input = fixture.nativeElement.querySelector('input[aria-label="Rename current board page"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    expect((harness(fixture).selectedElementIds as unknown as (() => string[]))()).toEqual([]);
    fixture.componentRef.setInput('readOnly', true); fixture.detectChanges();
    harness(fixture).handleKeyboardShortcut(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    expect((harness(fixture).selectedElementIds as unknown as (() => string[]))()).toEqual([]);
  });

  it('shows board-limit feedback to a drawing student without page-management controls', () => {
    const fixture = createBoard(false);
    const capped = structuredClone(initial);
    capped.pages[0]!.elements = Array.from({ length: 2500 }, (_, index) => stroke(`stroke-${index}`) as unknown as Record<string, unknown>);
    fixture.componentInstance.importBoardState(capped);
    const emitted = jasmine.createSpy('commandCommitted'); fixture.componentInstance.commandCommitted.subscribe(emitted);
    harness(fixture).pushHistory(); harness(fixture).addElement(stroke('overflow'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.asset-status.error')?.textContent).toContain('2500 objects');
    expect(fixture.nativeElement.querySelector('.asset-status')?.getAttribute('role')).toBe('status');
    expect(emitted).not.toHaveBeenCalled();
  });

  it('keeps thirty page titles readable even when teacher controls and an import status fill the header', () => {
    const fixture = createBoard();
    const state = structuredClone(initial);
    state.pages = Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(initial.pages[0]!), id: `page-${index + 1}`, title: `Lesson ${index + 1}`, order: index }));
    fixture.componentInstance.importBoardState(state); fixture.detectChanges();
    const strip = fixture.nativeElement.querySelector('.page-tab-list') as HTMLElement;
    const tab = strip.querySelector('button')!;
    expect(tab.getBoundingClientRect().width).toBeGreaterThan(75);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(getComputedStyle(tab).flexShrink).toBe('0');
    (fixture.componentInstance as unknown as { assetImportStatus: { set(status: unknown): void } }).assetImportStatus.set({ type: 'success', message: 'Classroom image added as an object.' });
    fixture.detectChanges();
    expect(strip.getBoundingClientRect().width).toBeGreaterThanOrEqual(100);
    const tools = fixture.nativeElement.querySelector('.page-tools') as HTMLElement;
    expect(tools.scrollWidth).toBeGreaterThan(tools.clientWidth);
  });

  it('snaps shape starts and endpoints to the grid and existing object points', () => {
    const fixture = createBoard(); const board = harness(fixture);
    (fixture.componentInstance as unknown as { angleSnapDegrees: { set(value: number): void } }).angleSnapDegrees.set(0);
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement; spyOn(canvas, 'setPointerCapture').and.stub();
    const bounds = (fixture.nativeElement.querySelector('.whiteboard-surface') as HTMLElement).getBoundingClientRect();
    const drawShape = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      board.startDrawing(new PointerEvent('pointerdown', { pointerId: 1, button: 0, buttons: 1, clientX: bounds.left + from.x, clientY: bounds.top + from.y }));
      board.draw(new PointerEvent('pointermove', { pointerId: 1, buttons: 1, clientX: bounds.left + to.x, clientY: bounds.top + to.y }));
      board.stopDrawing(new PointerEvent('pointerup', { pointerId: 1 }));
    };
    fixture.nativeElement.querySelector('button[aria-label="Snap to grid"]').click(); board.selectTool('rectangle');
    drawShape({ x: 121, y: 111 }, { x: 210, y: 176 });
    const rectangle = fixture.componentInstance.exportBoardState().pages[0]!.elements[0]!;
    expect(rectangle['from']).toEqual({ x: 120, y: 120 }); expect(rectangle['to']).toEqual({ x: 216, y: 168 });
    fixture.nativeElement.querySelector('button[aria-label="Snap to grid"]').click();
    fixture.nativeElement.querySelector('button[aria-label="Snap to points"]').click(); board.selectTool('line');
    drawShape({ x: 124, y: 124 }, { x: 320, y: 210 });
    expect(fixture.componentInstance.exportBoardState().pages[0]!.elements[1]!['from']).toEqual({ x: 120, y: 120 });
  });

  it('updates selected-page export availability after All, Clear and a checkbox click', () => {
    const fixture = createBoard();
    fixture.nativeElement.querySelector('button[aria-label="Menu"]').click(); fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('.export-pages-panel-head button')] as HTMLButtonElement[];
    const all = buttons.find((button) => button.textContent?.trim() === 'All')!;
    const clear = buttons.find((button) => button.textContent?.trim() === 'Clear')!;
    const checkbox = fixture.nativeElement.querySelector('.export-page-option input') as HTMLInputElement;
    const exportButton = fixture.nativeElement.querySelector('.selected-pages-export') as HTMLButtonElement;
    all.click(); fixture.detectChanges(); expect(checkbox.checked).toBeTrue();
    clear.click(); fixture.detectChanges(); expect(checkbox.checked).toBeFalse(); expect(exportButton.disabled).toBeTrue();
    checkbox.click(); fixture.detectChanges(); expect(checkbox.checked).toBeTrue(); expect(exportButton.disabled).toBeFalse();
  });

  it('configures the native file picker before opening each import mode', () => {
    const fixture = createBoard();
    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    const opened: Array<{ accept: string; multiple: boolean }> = [];
    spyOn(input, 'click').and.callFake(() => opened.push({ accept: input.accept, multiple: input.multiple }));
    for (const label of ['Import slide images', 'Import PDF pages', 'Add page background', 'Import image/PDF object']) {
      fixture.nativeElement.querySelector('button[aria-label="Menu"]').click(); fixture.detectChanges();
      const button = ([...fixture.nativeElement.querySelectorAll('.menu-dropdown button')] as HTMLButtonElement[]).find((candidate) => candidate.textContent?.includes(label))!;
      expect(button).toBeTruthy(); button.click(); fixture.detectChanges();
    }
    expect(opened.length).toBe(4);
    expect(opened[0]!.multiple).toBeTrue(); expect(opened[0]!.accept).toContain('image/png');
    expect(opened[1]).toEqual({ accept: '.pdf,application/pdf', multiple: false });
    expect(opened[2]!.multiple).toBeFalse(); expect(opened[2]!.accept).not.toContain('application/pdf');
    expect(opened[3]!.multiple).toBeFalse(); expect(opened[3]!.accept).toContain('application/pdf');
  });

});
