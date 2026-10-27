import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import { Whiteboard, type WhiteboardCommand, type WhiteboardElement, type WhiteboardPage } from './whiteboard';

interface LargeBoardHarness {
  pages(): WhiteboardPage[];
  moveSelected(x: number, y: number): void;
  flipSelected(direction: 'horizontal' | 'right'): void;
  eraseAlongPath(from: { x: number; y: number }, to: { x: number; y: number }): void;
  resetPageBackground(): void;
  setZoom(value: number): void;
  commitTextDraft(): void;
  textDraft: { set(value: unknown): void };
  resizeWhiteboard(): void;
  pushHistory(): void;
  addElement(element: WhiteboardElement): void;
  undo(): void;
  redo(): void;
  addPage(): void;
  deleteSelected(): void;
  duplicateSelected(): void;
  selectedElementIds: { set(ids: string[]): void };
  assetImportStatus: () => { message: string } | null;
  selectPage(id: string): void;
  insertImportedPages(pages: WhiteboardPage[]): void;
  renderPageImage(id: string, type: 'image/png' | 'image/jpeg'): string;
  resolveImage(dataUrl: string): HTMLImageElement;
  historyPast: WhiteboardPage[][];
}

// These use the real Angular component and Chrome canvas. Budgets deliberately allow
// slower CI machines; logged measurements are diagnostics, not a hardware benchmark.
describe('Whiteboard large classroom board acceptance', () => {
  const fixtures: ComponentFixture<Whiteboard>[] = [];
  const harness = (fixture: ComponentFixture<Whiteboard>) => fixture.componentInstance as unknown as LargeBoardHarness;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const stroke = (id: string, seed = 0): WhiteboardElement => ({
    id, type: 'stroke', color: '#071c41', width: 3,
    points: Array.from({ length: 43 }, (_, point) => ({ x: 20 + (seed * 11 + point * 7) % 700, y: 20 + (seed * 17 + point * 5) % 440 }))
  });
  const largeSnapshot = (): WhiteboardMemorySnapshot => ({
    schemaVersion: 1, activePageId: 'page-0',
    pages: Array.from({ length: 30 }, (_, page) => ({
      id: `page-${page}`, title: `Lesson ${page + 1}`, tags: ['acceptance'], order: page, template: 'blank',
      view: { zoom: 1, panX: 0, panY: 0 }, background: null,
      elements: Array.from({ length: 50 }, (_, element) => stroke(`stroke-${page}-${element}`, element) as unknown as Record<string, unknown>)
    }))
  });
  const measure = <T>(label: string, operation: () => T, budgetMs = 5000): T => {
    const start = performance.now();
    const result = operation();
    const durationMs = performance.now() - start;
    console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ label, durationMs: Number(durationMs.toFixed(1)) }));
    expect(durationMs).withContext(label).toBeLessThan(budgetMs);
    return result;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Whiteboard] }).compileComponents();
  });
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.destroy()));

  function createBoard(snapshot = largeSnapshot()): ComponentFixture<Whiteboard> {
    const fixture = TestBed.createComponent(Whiteboard);
    fixtures.push(fixture);
    fixture.componentRef.setInput('initialState', snapshot);
    fixture.nativeElement.style.width = '1000px';
    fixture.nativeElement.style.height = '700px';
    fixture.detectChanges();
    const surface = fixture.nativeElement.querySelector('.whiteboard-surface') as HTMLElement;
    surface.style.width = '960px';
    surface.style.height = '540px';
    harness(fixture).resizeWhiteboard();
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThanOrEqual(960);
    expect(canvas.height).toBeGreaterThanOrEqual(540);
    return fixture;
  }

  function imagePage(id: string, size = 200): WhiteboardPage {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(size, size);
    let seed = 42;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i + channel] = seed >>> 24;
      }
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return {
      id, title: 'Imported worksheet', tags: [], template: 'blank', view: { zoom: 1, panX: 0, panY: 0 }, elements: [],
      background: { kind: 'image', sourceType: 'pdf-page', fileName: 'worksheet.pdf', pageNumber: 1, mimeType: 'image/png', dataUrl: canvas.toDataURL(), naturalWidth: size, naturalHeight: size, fit: 'contain', importedAt: '2026-10-27T00:00:00.000Z' }
    };
  }

  it('keeps 30 pages and 1500 strokes editable through a full undo history, remote edits, navigation and reload', () => {
    const initial = largeSnapshot();
    console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ snapshotBytes: bytes(initial), pages: 30, strokes: 1500, points: 64500 }));
    const fixture = measure('load 30 pages / 1500 strokes', () => createBoard(initial));
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const heapBefore = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    measure('80 local edits with full undo history', () => {
      for (let i = 0; i < 80; i++) {
        api.pushHistory();
        api.addElement(stroke(`local-${i}`, i));
      }
    }, 15000);
    expect(api.historyPast.length).toBe(80);
    const heapAfter = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ heapBefore, heapAfter, historyEntries: api.historyPast.length, canvasWidth: 960, canvasHeight: 540 }));
    measure('30 remote edits rebasing 80 history entries', () => {
      for (let i = 0; i < 30; i++) board.applyCommand({ type: 'upsert', pageId: 'page-0', element: stroke(`remote-${i}`, i) });
    });
    measure('undo and redo on large board', () => { api.undo(); api.redo(); });
    expect(board.exportBoardState().pages[0]!.elements.map((element) => element['id'])).toContain('remote-29');
    expect(board.exportBoardState().pages[0]!.elements.map((element) => element['id'])).toContain('local-79');
    measure('navigate all 30 pages', () => { for (let page = 0; page < 30; page++) api.selectPage(`page-${page}`); });
    const saved = measure('serialize large board', () => board.exportBoardState());
    const reloaded = measure('reload saved board', () => createBoard(saved));
    expect(reloaded.componentInstance.exportBoardState()).toEqual(saved);
  }, 30000);

  it('exports all 30 pages in both PDF modes without changing the board', async () => {
    const fixture = createBoard();
    const board = fixture.componentInstance;
    const before = board.exportBoardState();
    for (const mode of ['raster', 'hybrid'] as const) {
      const start = performance.now();
      const result = (await board.exportAllPagesPdfBlob('Large classroom', mode))!;
      const durationMs = performance.now() - start;
      expect(durationMs).toBeLessThan(15000);
      console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ label: `${mode} PDF export / 30 pages`, durationMs: Number(durationMs.toFixed(1)) }));
      expect(result.blob.type).toBe('application/pdf');
      expect(result.blob.size).toBeGreaterThan(1000);
      const content = await result.blob.text();
      expect(content.startsWith('%PDF-1.3')).toBeTrue();
      expect(content).toContain('/Count 30');
      expect((content.match(/\/Type \/Page /g) ?? []).length).toBe(30);
      expect(board.exportBoardState()).toEqual(before);
      console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ mode, pdfBytes: result.blob.size }));
    }
  }, 30000);

  it('accepts a real image/PDF background near 1.5 MB and atomically rejects the next oversized import', async () => {
    const fixture = createBoard();
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const page = imagePage('worksheet');
    measure('import real PNG worksheet near board limit', () => api.insertImportedPages([page]));
    await api.resolveImage(page.background!.dataUrl).decode();
    const snapshot = board.exportBoardState();
    expect(bytes(snapshot)).toBeGreaterThan(1400000);
    expect(bytes(snapshot)).toBeLessThan(1500000);
    const emitted: WhiteboardCommand[] = [];
    board.commandCommitted.subscribe((command) => emitted.push(command));
    const historyLength = api.historyPast.length;
    expect(() => api.insertImportedPages([imagePage('overflow')])).toThrowError(/size limit/);
    expect(board.exportBoardState()).toEqual(snapshot);
    expect(api.historyPast.length).toBe(historyLength);
    expect(emitted).toEqual([]);
    const result = (await board.exportSelectedPagesPdfBlob(['worksheet'], 'Worksheet', 'raster'))!;
    expect(result.blob.size).toBeGreaterThan(1000);
    const reloaded = createBoard(snapshot);
    expect(reloaded.componentInstance.exportBoardState()).toEqual(snapshot);
    console.info('WHITEBOARD_ACCEPTANCE', JSON.stringify({ nearLimitBytes: bytes(snapshot), imageDataBytes: page.background!.dataUrl.length }));
  }, 30000);

  it('includes an unvisited imported background when exporting a restored board', async () => {
    const page = imagePage('unvisited-image', 32);
    const snapshot = largeSnapshot();
    snapshot.pages = snapshot.pages.slice(0, 1);
    snapshot.pages[0]!.elements = [];
    snapshot.pages.push({ ...page, order: 1, elements: [] } as unknown as WhiteboardMemorySnapshot['pages'][number]);
    const fixture = createBoard(snapshot);
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const exported = await board.exportSelectedPagesPdfBlob(['unvisited-image'], 'Restored worksheet', 'raster');
    expect(exported?.blob.size).toBeGreaterThan(1000);
    const firstExport = api.renderPageImage('unvisited-image', 'image/png');
    await api.resolveImage(page.background!.dataUrl).decode();
    const loadedExport = api.renderPageImage('unvisited-image', 'image/png');
    expect(firstExport).withContext('First export must contain the background without visiting the page first').toBe(loadedExport);
    expect(board.currentPageId()).toBe('page-0');
  });
  it('rejects the 81st page before any local mutation or shared command', () => {
    const initial = largeSnapshot();
    initial.pages = Array.from({ length: 80 }, (_, index) => ({ ...initial.pages[0]!, id: `page-${index}`, order: index, elements: [] }));
    const fixture = createBoard(initial);
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const before = board.exportBoardState();
    const commands: WhiteboardCommand[] = [];
    const changed = jasmine.createSpy('stateChanged');
    board.commandCommitted.subscribe((command) => commands.push(command));
    board.stateChanged.subscribe(changed);
    api.addPage();
    expect(board.exportBoardState()).toEqual(before);
    expect(commands).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(api.assetImportStatus()?.message).toContain('80 pages');
    expect(() => api.insertImportedPages([imagePage('overflow', 16)])).toThrowError(/80 pages/);
    expect(api.historyPast.length).toBe(0);
  });

  it('rejects object 2501, then allows deletion, drawing and undo at the capacity boundary', () => {
    const initial = largeSnapshot();
    initial.pages = initial.pages.slice(0, 1);
    initial.pages[0]!.elements = Array.from({ length: 2500 }, (_, i) => ({ ...stroke(`cap-${i}`, i), points: [{ x: 20, y: 20 }, { x: 40, y: 40 }] }));
    const fixture = createBoard(initial);
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const before = board.exportBoardState();
    const commands: WhiteboardCommand[] = [];
    board.commandCommitted.subscribe((command) => commands.push(command));
    api.pushHistory();
    api.addElement(stroke('overflow'));
    expect(board.exportBoardState()).toEqual(before);
    expect(commands).toEqual([]);
    expect(api.historyPast.length).toBe(0);
    expect(api.assetImportStatus()?.message).toContain('2500 objects');
    api.selectedElementIds.set(['cap-0', 'cap-1']);
    api.duplicateSelected();
    expect(board.exportBoardState()).toEqual(before);
    expect(commands).toEqual([]);
    expect(api.historyPast.length).toBe(0);
    const imported = imagePage('overflow-page', 16);
    imported.elements = [stroke('overflow-import')];
    expect(() => api.insertImportedPages([imported])).toThrowError(/2500 objects/);
    api.selectedElementIds.set(['cap-0']);
    api.deleteSelected();
    expect(board.exportBoardState().pages[0]!.elements.length).toBe(2499);
    api.pushHistory();
    api.addElement(stroke('replacement'));
    expect(board.exportBoardState().pages[0]!.elements.length).toBe(2500);
    api.undo();
    expect(board.exportBoardState().pages[0]!.elements.length).toBe(2499);
  }, 15000);

  it('rejects a normal pen stroke crossing the aggregate byte cap without emitting it', () => {
    const fixture = createBoard();
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const before = board.exportBoardState();
    const emitted = jasmine.createSpy('commandCommitted');
    board.commandCommitted.subscribe(emitted);
    api.pushHistory();
    api.addElement({ id: 'too-long', type: 'stroke', color: '#071c41', width: 3, points: Array.from({ length: 20000 }, (_, i) => ({ x: i % 700, y: i % 400 })) });
    expect(board.exportBoardState()).toEqual(before);
    expect(emitted).not.toHaveBeenCalled();
    expect(api.historyPast.length).toBe(0);
    expect(api.assetImportStatus()?.message).toContain('size limit');
  });

  it('keeps shared history snapshots immutable during drag, transform, erase, text, background and remote edits', () => {
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    };
    const actions: Array<(api: LargeBoardHarness, board: Whiteboard) => void> = [
      (api) => { api.pushHistory(); api.moveSelected(40, 20); },
      (api) => api.flipSelected('horizontal'),
      (api) => api.flipSelected('right'),
      (api) => api.eraseAlongPath({ x: 15, y: 15 }, { x: 50, y: 50 }),
      (api) => { api.textDraft.set({ mode: 'text', elementId: 'text', x: 100, y: 100, value: 'Updated explanation' }); api.commitTextDraft(); },
      (api) => api.resetPageBackground()
    ];
    for (const action of actions) {
      const initial = largeSnapshot();
      initial.pages = initial.pages.slice(0, 1);
      initial.pages[0]!.elements = [stroke('shape') as unknown as Record<string, unknown>, { id: 'text', type: 'text', text: 'Explanation', color: '#071c41', size: 24, position: { x: 100, y: 100 } }];
      initial.pages[0]!.background = imagePage('background', 16).background as unknown as Record<string, unknown>;
      const fixture = createBoard(initial);
      const api = harness(fixture);
      const board = fixture.componentInstance;
      const before = board.exportBoardState();
      freeze(api.pages());
      api.selectedElementIds.set(['shape']);
      expect(() => action(api, board)).not.toThrow();
      api.undo();
      expect(board.exportBoardState()).toEqual(before);
      api.redo();
      api.pushHistory();
      freeze(api.pages());
      expect(() => api.setZoom(1.5)).not.toThrow();
      expect(() => board.applyCommand({ type: 'upsert', pageId: 'page-0', element: stroke('remote') })).not.toThrow();
      api.undo();
      expect(board.exportBoardState().pages[0]!.elements.some((element) => element['id'] === 'remote')).toBeTrue();
    }
  });

  it('accounts for the target page id when selecting a page at the exact byte limit', () => {
    const initial = largeSnapshot();
    const targetId = 'long-page-'.padEnd(128, 'x');
    initial.pages[1]!.id = targetId;
    const padding = { id: 'padding', type: 'text', color: '#071c41', size: 20, text: '', position: { x: 20, y: 20 } };
    initial.pages[29]!.elements.push(padding);
    padding.text = 'x'.repeat(1499950 - bytes(initial));
    expect(bytes(initial)).toBe(1499950);
    const fixture = createBoard(initial);
    const board = fixture.componentInstance;
    const api = harness(fixture);
    const before = board.exportBoardState();
    const commands = jasmine.createSpy('commandCommitted');
    board.commandCommitted.subscribe(commands);
    api.selectPage(targetId);
    expect(board.exportBoardState()).toEqual(before);
    expect(commands).not.toHaveBeenCalled();
    expect(api.assetImportStatus()?.message).toContain('size limit');
  });

});
