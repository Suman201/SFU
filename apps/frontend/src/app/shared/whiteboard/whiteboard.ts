import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  input,
  output,
  signal
} from '@angular/core';

export type WhiteboardTool = 'select' | 'pen' | 'eraser' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'star' | 'text' | 'laser' | 'pan';
export type WhiteboardShapeTool = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'star';
export type WhiteboardFileKind = 'image' | 'document';

export interface WhiteboardPoint {
  x: number;
  y: number;
}

interface WhiteboardElementBase {
  id: string;
  groupId?: string;
}

export interface WhiteboardStrokeElement extends WhiteboardElementBase {
  type: 'stroke';
  color: string;
  fillColor?: string | null;
  width: number;
  points: WhiteboardPoint[];
}

export interface WhiteboardShapeElement extends WhiteboardElementBase {
  type: 'shape';
  shape: WhiteboardShapeTool;
  strokeColor: string;
  fillColor: string | null;
  width: number;
  from: WhiteboardPoint;
  to: WhiteboardPoint;
}

export interface WhiteboardTextElement extends WhiteboardElementBase {
  type: 'text';
  color: string;
  fontSize: number;
  position: WhiteboardPoint;
  text: string;
}

export interface WhiteboardFileElement extends WhiteboardElementBase {
  type: 'file';
  kind: WhiteboardFileKind;
  fileName: string;
  dataUrl: string;
  position: WhiteboardPoint;
  width: number;
  height: number;
}

export type WhiteboardElement = WhiteboardStrokeElement | WhiteboardShapeElement | WhiteboardTextElement | WhiteboardFileElement;

export interface WhiteboardPage {
  id: string;
  title: string;
  elements: WhiteboardElement[];
}

export interface WhiteboardCursor {
  participantId: string;
  displayName: string;
  color: string;
  position: WhiteboardPoint;
}

export interface WhiteboardUpsertCommand {
  type: 'upsert';
  element: WhiteboardElement;
  pageId?: string;
}

export interface WhiteboardDeleteCommand {
  type: 'delete';
  elementId: string;
  pageId?: string;
}

export interface WhiteboardClearCommand {
  type: 'clear';
  pageId?: string;
}

export type WhiteboardCommand = WhiteboardUpsertCommand | WhiteboardDeleteCommand | WhiteboardClearCommand;

interface PanStart {
  clientX: number;
  clientY: number;
  panX: number;
  panY: number;
}

interface TextDraft {
  x: number;
  y: number;
  value: string;
}

type TransformHandle = 'nw' | 'ne' | 'sw' | 'se';
type FlipDirection = 'horizontal' | 'vertical' | 'left' | 'right';

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TransformStart {
  elementIds: string[];
  elements: WhiteboardElement[];
  bounds: ElementBounds;
  anchor: WhiteboardPoint;
}

interface ContextMenuState {
  x: number;
  y: number;
}

interface AlignmentGuide {
  orientation: 'horizontal' | 'vertical';
  position: number;
}

interface SelectionMarquee {
  start: WhiteboardPoint;
  current: WhiteboardPoint;
  append: boolean;
  initialIds: string[];
}

interface StrokeFillPath {
  points: WhiteboardPoint[];
}

const GRID_SIZE = 24;
const ALIGNMENT_TOLERANCE = 6;
const TOOL_LABELS: Record<WhiteboardTool, string> = {
  select: 'Select',
  pen: 'Pen',
  eraser: 'Erase',
  line: 'Line',
  arrow: 'Arrow',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  star: 'Star',
  text: 'Text',
  laser: 'Laser',
  pan: 'Pan'
};

@Component({
  selector: 'sfu-whiteboard',
  standalone: true,
  templateUrl: './whiteboard.html',
  styleUrl: './whiteboard.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Whiteboard implements AfterViewInit, OnDestroy {
  readonly title = input('Whiteboard');
  readonly eyebrow = input('Teacher session');
  readonly readOnly = input(false);
  readonly showEndSession = input(false);
  readonly cursors = input<WhiteboardCursor[]>([]);
  readonly commandCommitted = output<WhiteboardCommand>();
  readonly cursorMoved = output<WhiteboardCursor>();
  readonly endSession = output<void>();

  @ViewChild('whiteboardSurface') private readonly whiteboardSurface?: ElementRef<HTMLDivElement>;
  @ViewChild('whiteboardCanvas') private readonly whiteboardCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('textEditor') private readonly textEditor?: ElementRef<HTMLInputElement>;
  @ViewChild('fileInput') private readonly fileInput?: ElementRef<HTMLInputElement>;

  protected readonly activeTool = signal<WhiteboardTool>('select');
  protected readonly activeShapeTool = signal<WhiteboardShapeTool>('rectangle');
  protected readonly shapeMenuOpen = signal(false);
  protected readonly colorMenuOpen = signal(false);
  protected readonly fillColorMenuOpen = signal(false);
  protected readonly brushMenuOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly strokeColor = signal('#071c41');
  protected readonly fillColor = signal('#FFD150');
  protected readonly fillEnabled = signal(false);
  protected readonly strokeWidth = signal(4);
  protected readonly fontSize = signal(28);
  protected readonly colors = ['#071c41', '#458B73', '#F26076', '#FF9760', '#FFD150'];
  protected readonly brushSizes = [3, 6, 10, 14];
  protected readonly zoom = signal(1);
  protected readonly panX = signal(0);
  protected readonly panY = signal(0);
  protected readonly selectedElementIds = signal<string[]>([]);
  protected readonly textDraft = signal<TextDraft | null>(null);
  protected readonly contextMenu = signal<ContextMenuState | null>(null);
  protected readonly laserPoint = signal<WhiteboardPoint | null>(null);
  protected readonly alignmentGuides = signal<AlignmentGuide[]>([]);
  protected readonly selectionMarquee = signal<SelectionMarquee | null>(null);
  protected readonly snapToGrid = signal(false);
  protected readonly showGrid = signal(true);
  protected readonly pages = signal<WhiteboardPage[]>([this.createPage('Board 1')]);
  protected readonly activePageId = signal(this.pages()[0]!.id);
  protected readonly historyVersion = signal(0);
  protected readonly activePage = computed(() => this.pages().find((page) => page.id === this.activePageId()) ?? this.pages()[0]!);
  protected readonly boardTransform = computed(() => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`);
  protected readonly zoomPercent = computed(() => `${Math.round(this.zoom() * 100)}%`);
  protected readonly activeToolLabel = computed(() => TOOL_LABELS[this.activeTool()]);
  protected readonly elementCount = computed(() => this.activePage().elements.length);
  protected readonly canUndo = computed(() => this.historyVersion() >= 0 && this.historyPast.length > 0);
  protected readonly canRedo = computed(() => this.historyVersion() >= 0 && this.historyFuture.length > 0);

  private context: CanvasRenderingContext2D | null = null;
  private previewElement: WhiteboardElement | null = null;
  private drawing = false;
  private erasing = false;
  private eraseHistoryPushed = false;
  private lastPoint: WhiteboardPoint | null = null;
  private shapeStart: WhiteboardPoint | null = null;
  private panStart: PanStart | null = null;
  private movingSelection = false;
  private transformStart: TransformStart | null = null;
  private pendingCommands: WhiteboardCommand[] = [];
  private resizeObserver?: ResizeObserver;
  private imageCache = new Map<string, HTMLImageElement>();
  private clipboardElements: WhiteboardElement[] = [];
  private clipboardPasteCount = 0;
  private historyPast: WhiteboardPage[][] = [];
  private historyFuture: WhiteboardPage[][] = [];
  private laserTimeout?: number;

  private get elements(): WhiteboardElement[] {
    return this.activePage().elements;
  }

  private set elements(elements: WhiteboardElement[]) {
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, elements } : page)));
  }

  ngAfterViewInit(): void {
    if (this.readOnly()) {
      this.activeTool.set('pan');
    }
    this.setupWhiteboard();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    if (this.laserTimeout) {
      window.clearTimeout(this.laserTimeout);
    }
  }

  @HostListener('window:keydown', ['$event'])
  protected handleKeyboardShortcut(event: KeyboardEvent): void {
    const editableTarget = this.isEditableShortcutTarget(event.target);

    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelKeyboardState();
      return;
    }

    if (editableTarget) {
      return;
    }

    const key = event.key.toLowerCase();
    const usesModifier = event.ctrlKey || event.metaKey;

    if (!this.readOnly() && usesModifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      return;
    }

    if (!this.readOnly() && usesModifier && key === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }

    if (!this.readOnly() && usesModifier && key === 'c' && this.selectedElementIds().length) {
      event.preventDefault();
      this.copySelected();
      return;
    }

    if (!this.readOnly() && usesModifier && key === 'v' && this.clipboardElements.length) {
      event.preventDefault();
      this.pasteClipboard();
      return;
    }

    if (!this.readOnly() && usesModifier && key === 'd' && this.selectedElementIds().length) {
      event.preventDefault();
      this.duplicateSelected();
      return;
    }

    if (usesModifier && this.isZoomInShortcut(event)) {
      event.preventDefault();
      this.zoomIn();
      return;
    }

    if (usesModifier && this.isZoomOutShortcut(event)) {
      event.preventDefault();
      this.zoomOut();
      return;
    }

    if (!this.readOnly() && (event.key === 'Delete' || event.key === 'Backspace') && this.selectedElementIds().length) {
      event.preventDefault();
      this.deleteSelected();
    }
  }

  applyCommand(command: WhiteboardCommand): void {
    if (!this.context) {
      this.pendingCommands.push(command);
      return;
    }
    const pageId = command.pageId ?? this.activePageId();
    this.pages.update((pages) =>
      pages.map((page) => {
        if (page.id !== pageId) {
          return page;
        }
        if (command.type === 'clear') {
          return { ...page, elements: [] };
        }
        if (command.type === 'delete') {
          return { ...page, elements: page.elements.filter((element) => element.id !== command.elementId) };
        }
        return { ...page, elements: this.upsertElementInList(page.elements, command.element) };
      })
    );
    this.selectedElementIds.set([]);
    this.render();
  }

  loadCommands(commands: WhiteboardCommand[]): void {
    if (!this.context) {
      this.pendingCommands = [{ type: 'clear' }, ...commands];
      return;
    }
    this.elements = [];
    this.selectedElementIds.set([]);
    for (const command of commands) {
      this.applyCommand(command);
    }
    this.render();
  }

  exportImage(): string {
    this.render(false);
    const dataUrl = this.whiteboardCanvas?.nativeElement.toDataURL('image/png') ?? '';
    this.render();
    return dataUrl;
  }

  protected selectTool(tool: WhiteboardTool): void {
    if (this.readOnly() && tool !== 'pan') {
      return;
    }
    this.activeTool.set(tool);
    if (!this.isShapeTool(tool)) {
      this.shapeMenuOpen.set(false);
    }
  }

  protected toggleShapeMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.shapeMenuOpen.update((open) => !open);
  }

  protected selectShapeTool(tool: WhiteboardShapeTool): void {
    this.activeShapeTool.set(tool);
    this.activeTool.set(tool);
    this.shapeMenuOpen.set(false);
  }

  protected selectColor(color: string): void {
    if (this.readOnly()) {
      return;
    }
    this.strokeColor.set(color);
    this.colorMenuOpen.set(false);
    this.applyStrokeToSelection(color);
  }

  protected setCustomStrokeColor(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.selectColor(inputElement.value);
  }

  protected toggleColorMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.fillColorMenuOpen.set(false);
    this.colorMenuOpen.update((open) => !open);
  }

  protected toggleFillColorMenu(event: MouseEvent): void {
    if (this.readOnly()) {
      return;
    }
    event.stopPropagation();
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.update((open) => !open);
  }

  protected selectFillColor(color: string): void {
    if (this.readOnly()) {
      return;
    }
    this.fillColor.set(color);
    this.fillEnabled.set(true);
    this.fillColorMenuOpen.set(false);
    this.applyFillToSelection(color);
  }

  protected setCustomFillColor(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.selectFillColor(inputElement.value);
  }

  protected toggleBrushMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.brushMenuOpen.update((open) => !open);
  }

  protected toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.menuOpen.update((open) => !open);
  }

  protected toggleFill(): void {
    if (this.readOnly()) {
      return;
    }
    const nextEnabled = !this.fillEnabled();
    this.fillEnabled.set(nextEnabled);
    this.applyFillToSelection(nextEnabled ? this.fillColor() : null);
  }

  protected toggleSnapToGrid(): void {
    this.snapToGrid.update((enabled) => !enabled);
  }

  protected toggleGrid(): void {
    this.showGrid.update((visible) => !visible);
  }

  protected setStrokeWidth(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.strokeWidth.set(Number(inputElement.value));
  }

  protected selectBrushSize(size: number): void {
    if (this.readOnly()) {
      return;
    }
    this.strokeWidth.set(size);
    this.activeTool.set('pen');
  }

  protected zoomOut(): void {
    this.setZoom(this.zoom() - 0.1);
  }

  protected zoomIn(): void {
    this.setZoom(this.zoom() + 0.1);
  }

  protected resetView(): void {
    this.zoom.set(1);
    this.panX.set(0);
    this.panY.set(0);
  }

  protected undo(): void {
    const previous = this.historyPast.pop();
    if (!previous) {
      return;
    }
    this.historyFuture.push(this.clonePages(this.pages()));
    this.pages.set(previous);
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.render();
  }

  protected redo(): void {
    const next = this.historyFuture.pop();
    if (!next) {
      return;
    }
    this.historyPast.push(this.clonePages(this.pages()));
    this.pages.set(next);
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.render();
  }

  protected addPage(): void {
    this.pushHistory();
    const page = this.createPage(`Board ${this.pages().length + 1}`);
    this.pages.update((pages) => [...pages, page]);
    this.activePageId.set(page.id);
    this.selectedElementIds.set([]);
    this.render();
  }

  protected selectPage(pageId: string): void {
    this.activePageId.set(pageId);
    this.selectedElementIds.set([]);
    this.render();
  }

  protected removeActivePage(): void {
    if (this.pages().length <= 1) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    const nextPages = this.pages().filter((page) => page.id !== activePageId);
    this.pages.set(nextPages);
    this.activePageId.set(nextPages[0]!.id);
    this.selectedElementIds.set([]);
    this.render();
  }

  protected requestEndSession(): void {
    this.endSession.emit();
  }

  protected clearWhiteboard(): void {
    if (this.readOnly()) {
      return;
    }
    this.pushHistory();
    this.elements = [];
    this.previewElement = null;
    this.selectedElementIds.set([]);
    this.render();
    this.commandCommitted.emit({ type: 'clear', pageId: this.activePageId() });
  }

  protected triggerFileImport(): void {
    this.fileInput?.nativeElement.click();
  }

  protected importFile(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    const file = inputElement.files?.[0];
    inputElement.value = '';
    if (!file || this.readOnly()) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this.createFileElement(file, String(reader.result));
    reader.readAsDataURL(file);
  }

  protected exportPng(): void {
    const dataUrl = this.exportImage();
    this.downloadDataUrl(dataUrl, `${this.activePage().title}.png`);
  }

  protected exportPdf(): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    this.render(false);
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    this.render();
    const blob = this.createPdfBlob(jpegDataUrl, canvas.width, canvas.height);
    this.downloadBlob(blob, `${this.activePage().title}.pdf`);
  }

  protected updateTextDraft(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.textDraft.update((draft) => (draft ? { ...draft, value: inputElement.value } : draft));
  }

  protected commitTextDraft(): void {
    const draft = this.textDraft();
    const text = draft?.value.trim();
    if (!draft || !text) {
      this.textDraft.set(null);
      return;
    }
    const element: WhiteboardTextElement = {
      id: this.createElementId(),
      type: 'text',
      color: this.strokeColor(),
      fontSize: this.fontSize(),
      position: { x: draft.x, y: draft.y },
      text
    };
    this.pushHistory();
    this.addElement(element);
    this.textDraft.set(null);
  }

  protected cancelTextDraft(): void {
    this.textDraft.set(null);
  }

  protected openContextMenu(event: MouseEvent): void {
    if (this.readOnly()) {
      return;
    }
    event.preventDefault();
    const point = this.getCanvasPointFromClient(event.clientX, event.clientY);
    const element = this.hitTest(point);
    if (!element) {
      this.contextMenu.set(null);
      this.setSelection([]);
      return;
    }
    this.setSelectionForElement(element, event.shiftKey);
    this.activeTool.set('select');
    const surface = this.whiteboardSurface!.nativeElement.getBoundingClientRect();
    this.contextMenu.set({
      x: event.clientX - surface.left,
      y: event.clientY - surface.top
    });
  }

  protected closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  private cancelKeyboardState(): void {
    this.shapeMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.brushMenuOpen.set(false);
    this.menuOpen.set(false);
    this.contextMenu.set(null);
    this.textDraft.set(null);
    this.previewElement = null;
    this.alignmentGuides.set([]);
    this.selectionMarquee.set(null);
    this.setSelection([]);
  }

  private isEditableShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable || tagName === 'input' || tagName === 'select' || tagName === 'textarea';
  }

  private isZoomInShortcut(event: KeyboardEvent): boolean {
    return event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
  }

  private isZoomOutShortcut(event: KeyboardEvent): boolean {
    return event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
  }

  protected activateTransform(): void {
    this.activeTool.set('select');
    this.closeContextMenu();
  }

  protected groupSelected(): void {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length < 2) {
      return;
    }
    this.pushHistory();
    const groupId = this.createElementId();
    this.elements = this.elements.map((element) => (selectedIds.includes(element.id) ? { ...element, groupId } : element));
    this.closeContextMenu();
    this.render();
  }

  protected ungroupSelected(): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    this.elements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id)) {
        return element;
      }
      const next = { ...element };
      delete next.groupId;
      return next;
    });
    this.closeContextMenu();
    this.render();
  }

  protected duplicateSelected(): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    const groupId = selectedIds.length > 1 ? this.createElementId() : undefined;
    const duplicates = this.elements
      .filter((element) => selectedIds.includes(element.id))
      .map((element) => {
        const duplicate = this.cloneElement(element);
        duplicate.id = this.createElementId();
        if (groupId) {
          duplicate.groupId = groupId;
        }
        this.translateElement(duplicate, 24, 24);
        return duplicate;
      });
    this.elements = [...this.elements, ...duplicates];
    this.setSelection(duplicates.map((element) => element.id));
    this.closeContextMenu();
    for (const element of duplicates) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
    this.render();
  }

  protected deleteSelected(): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    this.elements = this.elements.filter((element) => !selectedIds.includes(element.id));
    this.setSelection([]);
    this.closeContextMenu();
    for (const elementId of selectedIds) {
      this.commandCommitted.emit({ type: 'delete', elementId, pageId: this.activePageId() });
    }
    this.render();
  }

  protected removeSelected(): void {
    this.deleteSelected();
  }

  protected flipSelected(direction: FlipDirection): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    const bounds = this.boundsForElements(selectedIds);
    this.elements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id)) {
        return element;
      }
      return direction === 'left' || direction === 'right' ? this.rotateElement(element, bounds, direction) : this.flipElement(element, bounds, direction);
    });
    this.closeContextMenu();
    this.emitSelectionUpserts();
    this.render();
  }

  protected bringSelectedToFront(): void {
    this.reorderSelectedToEdge('front');
  }

  protected bringSelectedForward(): void {
    this.reorderSelected(1);
  }

  protected sendSelectedBackward(): void {
    this.reorderSelected(-1);
  }

  protected sendSelectedToBack(): void {
    this.reorderSelectedToEdge('back');
  }

  protected cursorTransform(cursor: WhiteboardCursor): string {
    return `translate(${cursor.position.x}px, ${cursor.position.y}px)`;
  }

  protected startDrawing(event: PointerEvent): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas || !this.context) {
      return;
    }
    event.preventDefault();
    this.closeContextMenu();
    canvas.setPointerCapture(event.pointerId);

    if (this.activeTool() === 'pan') {
      this.panStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        panX: this.panX(),
        panY: this.panY()
      };
      return;
    }

    if (this.readOnly()) {
      return;
    }

    const point = this.getCanvasPoint(event);
    this.emitCursor(point);

    if (this.activeTool() === 'select') {
      const handle = this.hitTestTransformHandle(point);
      if (handle) {
        const selectedIds = this.selectedElementIds();
        if (selectedIds.length) {
          this.pushHistory();
          this.transformStart = this.createTransformStart(selectedIds, handle);
          return;
        }
      }
      const element = this.hitTest(point);
      if (element) {
        this.setSelectionForElement(element, event.shiftKey);
        this.movingSelection = true;
        this.pushHistory();
      } else if (!event.shiftKey) {
        this.selectedElementIds.set([]);
      }
      if (!element) {
        this.selectionMarquee.set({
          start: point,
          current: point,
          append: event.shiftKey,
          initialIds: this.selectedElementIds()
        });
      }
      this.lastPoint = point;
      this.render();
      return;
    }

    if (this.activeTool() === 'eraser') {
      this.erasing = true;
      this.lastPoint = point;
      this.eraseAlongPath(point, point);
      this.render();
      return;
    }

    if (this.activeTool() === 'laser') {
      this.showLaser(point);
      return;
    }

    if (this.activeTool() === 'text') {
      this.textDraft.set({ x: point.x, y: point.y, value: '' });
      setTimeout(() => this.textEditor?.nativeElement.focus());
      return;
    }

    this.drawing = true;
    this.lastPoint = point;
    if (this.isShapeTool(this.activeTool())) {
      this.shapeStart = point;
      this.previewElement = this.createShapeElement(point, point, this.activeTool() as WhiteboardShapeTool);
    } else {
      this.previewElement = this.createStrokeElement([point]);
    }
    this.render();
  }

  protected draw(event: PointerEvent): void {
    if (this.panStart) {
      event.preventDefault();
      this.panX.set(this.panStart.panX + event.clientX - this.panStart.clientX);
      this.panY.set(this.panStart.panY + event.clientY - this.panStart.clientY);
      return;
    }

    const point = this.getCanvasPoint(event);
    this.emitCursor(point);

    if (this.activeTool() === 'laser' && !this.readOnly()) {
      event.preventDefault();
      this.showLaser(point);
      return;
    }

    if (this.selectionMarquee()) {
      event.preventDefault();
      this.updateSelectionMarquee(point);
      this.render();
      return;
    }

    if (this.erasing && this.lastPoint) {
      event.preventDefault();
      this.eraseAlongPath(this.lastPoint, point);
      this.lastPoint = point;
      this.render();
      return;
    }

    if (this.transformStart) {
      event.preventDefault();
      this.applyTransform(point, event.shiftKey);
      this.render();
      return;
    }

    if (this.movingSelection && this.lastPoint) {
      event.preventDefault();
      const delta = this.adjustMoveDelta(point.x - this.lastPoint.x, point.y - this.lastPoint.y);
      this.moveSelected(delta.x, delta.y);
      this.lastPoint = { x: this.lastPoint.x + delta.x, y: this.lastPoint.y + delta.y };
      this.render();
      return;
    }

    if (!this.drawing || !this.lastPoint || !this.previewElement) {
      return;
    }

    event.preventDefault();
    const nextPoint = this.snapPoint(point);
    if (this.previewElement.type === 'shape' && this.shapeStart) {
      this.previewElement = this.createShapeElement(this.shapeStart, nextPoint, this.previewElement.shape);
    } else if (this.previewElement.type === 'stroke') {
      this.previewElement = {
        ...this.previewElement,
        points: [...this.previewElement.points, nextPoint]
      };
    }
    this.lastPoint = nextPoint;
    this.render();
  }

  protected stopDrawing(event: PointerEvent): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    if (this.selectionMarquee()) {
      this.selectionMarquee.set(null);
    } else if (this.movingSelection || this.transformStart) {
      this.emitSelectionUpserts();
    } else if (this.previewElement && !this.isTinyElement(this.previewElement)) {
      this.pushHistory();
      this.addElement(this.previewElement);
    }

    this.drawing = false;
    this.lastPoint = null;
    this.shapeStart = null;
    this.previewElement = null;
    this.panStart = null;
    this.erasing = false;
    this.eraseHistoryPushed = false;
    this.selectionMarquee.set(null);
    this.movingSelection = false;
    this.transformStart = null;
    this.alignmentGuides.set([]);
    this.render();
  }

  private setupWhiteboard(): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    const surface = this.whiteboardSurface?.nativeElement;
    if (!canvas || !surface) {
      return;
    }
    this.context = canvas.getContext('2d');
    this.resizeWhiteboard();
    this.flushPendingCommands();
    this.resizeObserver = new ResizeObserver(() => this.resizeWhiteboard());
    this.resizeObserver.observe(surface);
  }

  private flushPendingCommands(): void {
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    for (const command of commands) {
      this.applyCommand(command);
    }
  }

  private resizeWhiteboard(): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    const surface = this.whiteboardSurface?.nativeElement;
    if (!canvas || !surface || !this.context) {
      return;
    }
    const bounds = surface.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    const nextWidth = Math.floor(width * dpr);
    const nextHeight = Math.floor(height * dpr);
    if (canvas.width === nextWidth && canvas.height === nextHeight) {
      return;
    }
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';
    this.render();
  }

  private render(includeOverlays = true): void {
    const canvas = this.whiteboardCanvas?.nativeElement;
    const context = this.context;
    if (!canvas || !context) {
      return;
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    for (const element of this.elements) {
      this.drawElement(element);
    }
    if (this.previewElement) {
      this.drawElement(this.previewElement);
    }
    if (includeOverlays) {
      this.drawAlignmentGuides();
      this.drawSelection();
      this.drawSelectionMarquee();
    }
  }

  private createFileElement(file: File, dataUrl: string): void {
    const targetPageId = this.activePageId();
    this.pushHistory();
    if (file.type.startsWith('image/')) {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 360;
        const scale = Math.min(1, maxWidth / image.naturalWidth);
        const element: WhiteboardFileElement = {
          id: this.createElementId(),
          type: 'file',
          kind: 'image',
          fileName: file.name,
          dataUrl,
          position: this.snapPoint({ x: 80, y: 80 }),
          width: Math.max(80, image.naturalWidth * scale),
          height: Math.max(60, image.naturalHeight * scale)
        };
        this.imageCache.set(dataUrl, image);
        this.addElement(element, targetPageId);
      };
      image.src = dataUrl;
      return;
    }
    const element: WhiteboardFileElement = {
      id: this.createElementId(),
      type: 'file',
      kind: 'document',
      fileName: file.name,
      dataUrl,
      position: this.snapPoint({ x: 90, y: 90 }),
      width: 260,
      height: 160
    };
    this.addElement(element, targetPageId);
  }

  private getCanvasPoint(event: PointerEvent): WhiteboardPoint {
    return this.getCanvasPointFromClient(event.clientX, event.clientY);
  }

  private getCanvasPointFromClient(clientX: number, clientY: number): WhiteboardPoint {
    const canvas = this.whiteboardCanvas!.nativeElement;
    const surface = this.whiteboardSurface!.nativeElement;
    const bounds = surface.getBoundingClientRect();
    const x = (clientX - bounds.left - this.panX()) / this.zoom();
    const y = (clientY - bounds.top - this.panY()) / this.zoom();
    return {
      x: Math.min(Math.max(x, 0), canvas.clientWidth),
      y: Math.min(Math.max(y, 0), canvas.clientHeight)
    };
  }

  private addElement(element: WhiteboardElement, pageId = this.activePageId()): void {
    const nextElement = this.cloneElement(element);
    this.pages.update((pages) =>
      pages.map((page) => (page.id === pageId ? { ...page, elements: [...page.elements, nextElement] } : page))
    );
    this.previewElement = null;
    if (pageId === this.activePageId()) {
      this.selectedElementIds.set([element.id]);
      this.render();
    }
    this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId });
  }

  private upsertElementInList(elements: WhiteboardElement[], element: WhiteboardElement): WhiteboardElement[] {
    const nextElement = this.cloneElement(element);
    return elements.some((item) => item.id === element.id)
      ? elements.map((item) => (item.id === element.id ? nextElement : item))
      : [...elements, nextElement];
  }

  private drawElement(element: WhiteboardElement): void {
    if (element.type === 'stroke') {
      this.drawStroke(element);
    } else if (element.type === 'shape') {
      this.drawShape(element);
    } else if (element.type === 'text') {
      this.drawText(element);
    } else {
      this.drawFile(element);
    }
  }

  private drawStroke(element: WhiteboardStrokeElement): void {
    const context = this.context;
    if (!context || !element.points.length) {
      return;
    }
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = element.width;
    context.strokeStyle = element.color;
    context.fillStyle = element.color;
    if (element.points.length === 1) {
      const point = element.points[0]!;
      context.beginPath();
      context.arc(point.x, point.y, element.width / 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
      return;
    }

    const fillPath = element.fillColor ? this.strokeFillPath(element) : null;
    if (element.fillColor && fillPath) {
      context.beginPath();
      context.moveTo(fillPath.points[0]!.x, fillPath.points[0]!.y);
      for (const point of fillPath.points.slice(1)) {
        context.lineTo(point.x, point.y);
      }
      context.closePath();
      context.fillStyle = element.fillColor;
      context.fill('evenodd');
    }

    context.beginPath();
    context.moveTo(element.points[0]!.x, element.points[0]!.y);
    for (const point of element.points.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.stroke();
    context.restore();
  }

  private drawShape(element: WhiteboardShapeElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = element.width;
    context.strokeStyle = element.strokeColor;
    context.fillStyle = element.fillColor ?? 'transparent';
    context.beginPath();
    this.buildShapePath(context, element);
    if (element.fillColor) {
      context.fill();
    }
    context.stroke();
    context.restore();
  }

  private drawText(element: WhiteboardTextElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    context.save();
    context.fillStyle = element.color;
    context.font = `${element.fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    context.textBaseline = 'top';
    context.fillText(element.text, element.position.x, element.position.y);
    context.restore();
  }

  private drawFile(element: WhiteboardFileElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    if (element.kind === 'image') {
      const image = this.resolveImage(element.dataUrl);
      if (image?.complete) {
        context.drawImage(image, element.position.x, element.position.y, element.width, element.height);
        return;
      }
    }
    context.save();
    context.fillStyle = this.cssVariable('--canvas-document-bg', '#f8fbff');
    context.strokeStyle = this.cssVariable('--canvas-document-line', '#d7e3f4');
    context.lineWidth = 1;
    context.fillRect(element.position.x, element.position.y, element.width, element.height);
    context.strokeRect(element.position.x, element.position.y, element.width, element.height);
    context.fillStyle = this.cssVariable('--accent', '#0f5bf1');
    context.font = '700 18px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(element.kind === 'document' ? 'PDF' : 'Image', element.position.x + 16, element.position.y + 20);
    context.fillStyle = this.cssVariable('--text', '#071c41');
    context.font = '14px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(element.fileName.slice(0, 26), element.position.x + 16, element.position.y + 56);
    context.restore();
  }

  private buildShapePath(context: CanvasRenderingContext2D, element: WhiteboardShapeElement): void {
    const { from, to } = element;
    if (element.shape === 'line') {
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      return;
    }
    if (element.shape === 'arrow') {
      this.buildArrowPath(context, from, to);
      return;
    }
    if (element.shape === 'rectangle') {
      context.rect(from.x, from.y, to.x - from.x, to.y - from.y);
      return;
    }
    if (element.shape === 'ellipse') {
      const radiusX = Math.max(1, Math.abs(to.x - from.x) / 2);
      const radiusY = Math.max(1, Math.abs(to.y - from.y) / 2);
      context.ellipse(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2, radiusX, radiusY, 0, 0, Math.PI * 2);
      return;
    }
    this.buildStarPath(context, from, to);
  }

  private buildArrowPath(context: CanvasRenderingContext2D, from: WhiteboardPoint, to: WhiteboardPoint): void {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLength = 18;
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  }

  private buildStarPath(context: CanvasRenderingContext2D, from: WhiteboardPoint, to: WhiteboardPoint): void {
    const centerX = from.x + (to.x - from.x) / 2;
    const centerY = from.y + (to.y - from.y) / 2;
    const outerRadius = Math.max(2, Math.min(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2);
    const innerRadius = outerRadius * 0.45;
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      const angle = -Math.PI / 2 + (index * Math.PI) / 5;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.closePath();
  }

  private createStrokeElement(points: WhiteboardPoint[]): WhiteboardStrokeElement {
    return {
      id: this.createElementId(),
      type: 'stroke',
      color: this.strokeColor(),
      fillColor: this.fillEnabled() ? this.fillColor() : null,
      width: this.strokeWidth(),
      points
    };
  }

  private createShapeElement(from: WhiteboardPoint, to: WhiteboardPoint, shape: WhiteboardShapeTool): WhiteboardShapeElement {
    return {
      id: this.previewElement?.id ?? this.createElementId(),
      type: 'shape',
      shape,
      strokeColor: this.strokeColor(),
      fillColor: this.fillEnabled() && this.isFillableShape(shape) ? this.fillColor() : null,
      width: this.strokeWidth(),
      from,
      to
    };
  }

  private createElementId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `whiteboard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private createPage(title: string): WhiteboardPage {
    return { id: this.createElementId(), title, elements: [] };
  }

  private setSelection(ids: string[]): void {
    this.selectedElementIds.set([...new Set(ids)]);
    this.render();
  }

  private setSelectionForElement(element: WhiteboardElement, append: boolean): void {
    const ids = this.selectionIdsForElement(element);
    if (!append) {
      this.setSelection(ids);
      return;
    }
    const selected = this.selectedElementIds();
    const allSelected = ids.every((id) => selected.includes(id));
    this.setSelection(allSelected ? selected.filter((id) => !ids.includes(id)) : [...selected, ...ids]);
  }

  private selectionIdsForElement(element: WhiteboardElement): string[] {
    if (!element.groupId) {
      return [element.id];
    }
    return this.elements.filter((item) => item.groupId === element.groupId).map((item) => item.id);
  }

  private hitTest(point: WhiteboardPoint): WhiteboardElement | null {
    for (const element of [...this.elements].reverse()) {
      if (this.containsPoint(element, point)) {
        return element;
      }
    }
    return null;
  }

  private containsPoint(element: WhiteboardElement, point: WhiteboardPoint): boolean {
    if (element.type === 'stroke') {
      return this.strokeContainsPoint(element, point);
    }
    if (element.type === 'shape') {
      return this.shapeContainsPoint(element, point);
    }
    return this.rectContainsPoint(this.boundsForElement(element), point);
  }

  private strokeContainsPoint(element: WhiteboardStrokeElement, point: WhiteboardPoint): boolean {
    const tolerance = Math.max(10, element.width + 6);
    for (let index = 1; index < element.points.length; index += 1) {
      if (this.distanceToSegment(point, element.points[index - 1]!, element.points[index]!) <= tolerance) {
        return true;
      }
    }
    const fillPath = this.strokeFillPath(element);
    if (fillPath && this.pointInPolygon(point, fillPath.points)) {
      return true;
    }
    return element.points.some((item) => this.distance(point, item) <= tolerance);
  }

  private shapeContainsPoint(element: WhiteboardShapeElement, point: WhiteboardPoint): boolean {
    const tolerance = Math.max(10, element.width + 6);
    if (element.shape === 'line' || element.shape === 'arrow') {
      return this.distanceToSegment(point, element.from, element.to) <= tolerance;
    }
    return this.rectContainsPoint(this.expandBounds(this.boundsForElement(element), tolerance), point);
  }

  private rectContainsPoint(bounds: ElementBounds, point: WhiteboardPoint): boolean {
    return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  }

  private moveSelected(deltaX: number, deltaY: number): void {
    const selectedIds = this.selectedElementIds();
    this.elements = this.elements.map((element) => (selectedIds.includes(element.id) ? this.translateElement(this.cloneElement(element), deltaX, deltaY) : element));
  }

  private translateElement<T extends WhiteboardElement>(element: T, deltaX: number, deltaY: number): T {
    if (element.type === 'stroke') {
      element.points = element.points.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY }));
    } else if (element.type === 'shape') {
      element.from = { x: element.from.x + deltaX, y: element.from.y + deltaY };
      element.to = { x: element.to.x + deltaX, y: element.to.y + deltaY };
    } else {
      element.position = { x: element.position.x + deltaX, y: element.position.y + deltaY };
    }
    return element;
  }

  private copySelected(): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.clipboardElements = this.elements.filter((element) => selectedIds.includes(element.id)).map((element) => this.cloneElement(element));
    this.clipboardPasteCount = 0;
  }

  private pasteClipboard(): void {
    if (!this.clipboardElements.length) {
      return;
    }
    this.pushHistory();
    this.clipboardPasteCount += 1;
    const offset = 24 * this.clipboardPasteCount;
    const pasted = this.cloneElementsForPaste(this.clipboardElements, offset);
    this.elements = [...this.elements, ...pasted];
    this.setSelection(pasted.map((element) => element.id));
    for (const element of pasted) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
    this.render();
  }

  private cloneElementsForPaste(elements: WhiteboardElement[], offset: number): WhiteboardElement[] {
    const groupMap = new Map<string, string>();
    return elements.map((element) => {
      const next = this.cloneElement(element);
      next.id = this.createElementId();
      if (next.groupId) {
        const groupId = groupMap.get(next.groupId) ?? this.createElementId();
        groupMap.set(next.groupId, groupId);
        next.groupId = groupId;
      }
      this.translateElement(next, offset, offset);
      return next;
    });
  }

  private updateSelectionMarquee(point: WhiteboardPoint): void {
    const marquee = this.selectionMarquee();
    if (!marquee) {
      return;
    }
    const nextMarquee = { ...marquee, current: point };
    const bounds = this.boundsFromAnchor(nextMarquee.start, nextMarquee.current);
    const marqueeIds = this.elements.filter((element) => this.boundsIntersect(this.boundsForElement(element), bounds)).flatMap((element) => this.selectionIdsForElement(element));
    this.selectionMarquee.set(nextMarquee);
    this.selectedElementIds.set(nextMarquee.append ? [...new Set([...nextMarquee.initialIds, ...marqueeIds])] : [...new Set(marqueeIds)]);
  }

  private drawSelectionMarquee(): void {
    const context = this.context;
    const marquee = this.selectionMarquee();
    if (!context || !marquee) {
      return;
    }
    const bounds = this.boundsFromAnchor(marquee.start, marquee.current);
    if (bounds.width < 2 && bounds.height < 2) {
      return;
    }
    context.save();
    context.fillStyle = this.cssVariable('--accent-soft', 'rgba(15, 91, 241, 0.12)');
    context.strokeStyle = this.cssVariable('--accent', '#0f5bf1');
    context.lineWidth = 1.4;
    context.setLineDash([7, 5]);
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.restore();
  }

  private boundsIntersect(a: ElementBounds, b: ElementBounds): boolean {
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
  }

  private applyStrokeToSelection(color: string): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }

    const changedElements: WhiteboardElement[] = [];
    const nextElements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id) || element.type === 'file') {
        return element;
      }

      let nextElement: WhiteboardElement;
      let currentColor: string;
      if (element.type === 'shape') {
        currentColor = element.strokeColor;
        nextElement = { ...element, strokeColor: color };
      } else {
        currentColor = element.color;
        nextElement = { ...element, color };
      }

      if (currentColor === color) {
        return element;
      }

      changedElements.push(nextElement);
      return nextElement;
    });

    if (!changedElements.length) {
      return;
    }

    this.pushHistory();
    this.elements = nextElements;
    for (const element of changedElements) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
    this.render();
  }

  private applyFillToSelection(fillColor: string | null): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }

    const changedElements: WhiteboardElement[] = [];
    const nextElements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id) || !this.canElementReceiveFill(element)) {
        return element;
      }
      const nextElement = { ...element, fillColor } as WhiteboardElement;
      const currentFill = 'fillColor' in element ? element.fillColor ?? null : null;
      if (currentFill === fillColor) {
        return element;
      }
      changedElements.push(nextElement);
      return nextElement;
    });

    if (!changedElements.length) {
      return;
    }

    this.pushHistory();
    this.elements = nextElements;
    for (const element of changedElements) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
    this.render();
  }

  private canElementReceiveFill(element: WhiteboardElement): element is WhiteboardStrokeElement | WhiteboardShapeElement {
    return (element.type === 'stroke' && !!this.strokeFillPath(element)) || (element.type === 'shape' && this.isFillableShape(element.shape));
  }

  private eraseAlongPath(from: WhiteboardPoint, to: WhiteboardPoint): void {
    const radius = this.eraserRadius();
    const nextElements: WhiteboardElement[] = [];
    const commands: WhiteboardCommand[] = [];
    let changed = false;

    for (const element of this.elements) {
      if (element.type === 'stroke') {
        const fragments = this.eraseStroke(element, from, to, radius);
        if (!fragments) {
          nextElements.push(element);
          continue;
        }
        changed = true;
        commands.push({ type: 'delete', elementId: element.id, pageId: this.activePageId() });
        nextElements.push(...fragments);
        for (const fragment of fragments) {
          commands.push({ type: 'upsert', element: this.cloneElement(fragment), pageId: this.activePageId() });
        }
        continue;
      }

      if (this.elementIntersectsEraser(element, from, to, radius)) {
        changed = true;
        commands.push({ type: 'delete', elementId: element.id, pageId: this.activePageId() });
        continue;
      }

      nextElements.push(element);
    }

    if (!changed) {
      return;
    }

    if (!this.eraseHistoryPushed) {
      this.pushHistory();
      this.eraseHistoryPushed = true;
    }

    this.elements = nextElements;
    this.selectedElementIds.update((ids) => ids.filter((id) => nextElements.some((element) => element.id === id)));
    for (const command of commands) {
      this.commandCommitted.emit(command);
    }
  }

  private eraseStroke(element: WhiteboardStrokeElement, from: WhiteboardPoint, to: WhiteboardPoint, radius: number): WhiteboardStrokeElement[] | null {
    const threshold = radius + element.width / 2;
    if (element.points.length <= 1) {
      return this.distanceToSegment(element.points[0]!, from, to) <= threshold ? [] : null;
    }

    const fragments: WhiteboardPoint[][] = [];
    let current: WhiteboardPoint[] = [];
    let changed = false;

    for (let index = 0; index < element.points.length - 1; index += 1) {
      const start = element.points[index]!;
      const end = element.points[index + 1]!;
      const segmentErased = this.segmentDistance(start, end, from, to) <= threshold;
      const startErased = this.distanceToSegment(start, from, to) <= threshold;
      const endErased = this.distanceToSegment(end, from, to) <= threshold;

      if (!startErased && current.length === 0) {
        current.push(start);
      }

      if (segmentErased || startErased || endErased) {
        changed = true;
        if (current.length > 1) {
          fragments.push(current);
        }
        current = [];
        continue;
      }

      current.push(end);
    }

    if (current.length > 1) {
      fragments.push(current);
    }

    if (!changed) {
      return null;
    }

    return fragments.map((points) => ({
      ...element,
      id: this.createElementId(),
      points: points.map((point) => ({ ...point }))
    }));
  }

  private elementIntersectsEraser(element: Exclude<WhiteboardElement, WhiteboardStrokeElement>, from: WhiteboardPoint, to: WhiteboardPoint, radius: number): boolean {
    if (element.type === 'shape' && (element.shape === 'line' || element.shape === 'arrow')) {
      return this.segmentDistance(element.from, element.to, from, to) <= radius + element.width / 2;
    }
    return this.pathIntersectsBounds(from, to, this.expandBounds(this.boundsForElement(element), radius));
  }

  private eraserRadius(): number {
    return Math.max(14, this.strokeWidth() * 2.4);
  }

  private pathIntersectsBounds(from: WhiteboardPoint, to: WhiteboardPoint, bounds: ElementBounds): boolean {
    const topLeft = { x: bounds.x, y: bounds.y };
    const topRight = { x: bounds.x + bounds.width, y: bounds.y };
    const bottomRight = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    const bottomLeft = { x: bounds.x, y: bounds.y + bounds.height };
    return (
      this.rectContainsPoint(bounds, from) ||
      this.rectContainsPoint(bounds, to) ||
      this.segmentsIntersect(from, to, topLeft, topRight) ||
      this.segmentsIntersect(from, to, topRight, bottomRight) ||
      this.segmentsIntersect(from, to, bottomRight, bottomLeft) ||
      this.segmentsIntersect(from, to, bottomLeft, topLeft)
    );
  }

  private drawSelection(): void {
    const context = this.context;
    const selectedIds = this.selectedElementIds();
    if (!context || !selectedIds.length) {
      return;
    }
    const bounds = this.boundsForElements(selectedIds);
    context.save();
    context.setLineDash([6, 5]);
    context.lineWidth = 1.5;
    context.strokeStyle = this.cssVariable('--accent', '#0f5bf1');
    context.strokeRect(bounds.x - 6, bounds.y - 6, bounds.width + 12, bounds.height + 12);
    context.setLineDash([]);
    context.fillStyle = this.cssVariable('--canvas-selection-fill', '#ffffff');
    context.strokeStyle = this.cssVariable('--accent', '#0f5bf1');
    for (const handle of this.transformHandles(bounds)) {
      context.fillRect(handle.x - 5, handle.y - 5, 10, 10);
      context.strokeRect(handle.x - 5, handle.y - 5, 10, 10);
    }
    context.restore();
  }

  private drawAlignmentGuides(): void {
    const context = this.context;
    if (!context || !this.alignmentGuides().length) {
      return;
    }
    const canvas = this.whiteboardCanvas!.nativeElement;
    context.save();
    context.strokeStyle = this.cssVariable('--info', '#2563eb');
    context.lineWidth = 1;
    context.setLineDash([4, 4]);
    for (const guide of this.alignmentGuides()) {
      context.beginPath();
      if (guide.orientation === 'vertical') {
        context.moveTo(guide.position, 0);
        context.lineTo(guide.position, canvas.clientHeight);
      } else {
        context.moveTo(0, guide.position);
        context.lineTo(canvas.clientWidth, guide.position);
      }
      context.stroke();
    }
    context.restore();
  }

  private boundsForElement(element: WhiteboardElement): ElementBounds {
    if (element.type === 'stroke') {
      const xs = element.points.map((point) => point.x);
      const ys = element.points.map((point) => point.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, width: Math.max(1, Math.max(...xs) - minX), height: Math.max(1, Math.max(...ys) - minY) };
    }
    if (element.type === 'shape') {
      const x = Math.min(element.from.x, element.to.x);
      const y = Math.min(element.from.y, element.to.y);
      return { x, y, width: Math.max(1, Math.abs(element.to.x - element.from.x)), height: Math.max(1, Math.abs(element.to.y - element.from.y)) };
    }
    if (element.type === 'file') {
      return { x: element.position.x, y: element.position.y, width: element.width, height: element.height };
    }
    const context = this.context;
    const width = context ? this.measureTextWidth(context, element) : element.text.length * element.fontSize * 0.58;
    return { x: element.position.x, y: element.position.y, width, height: element.fontSize * 1.25 };
  }

  private boundsForElements(ids: string[]): ElementBounds {
    const bounds = this.elements.filter((element) => ids.includes(element.id)).map((element) => this.boundsForElement(element));
    const minX = Math.min(...bounds.map((bound) => bound.x));
    const minY = Math.min(...bounds.map((bound) => bound.y));
    const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width));
    const maxY = Math.max(...bounds.map((bound) => bound.y + bound.height));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  private transformHandles(bounds: ElementBounds): Array<{ handle: TransformHandle; x: number; y: number }> {
    return [
      { handle: 'nw', x: bounds.x, y: bounds.y },
      { handle: 'ne', x: bounds.x + bounds.width, y: bounds.y },
      { handle: 'sw', x: bounds.x, y: bounds.y + bounds.height },
      { handle: 'se', x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    ];
  }

  private hitTestTransformHandle(point: WhiteboardPoint): TransformHandle | null {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return null;
    }
    const tolerance = 9;
    for (const handle of this.transformHandles(this.boundsForElements(selectedIds))) {
      if (Math.abs(point.x - handle.x) <= tolerance && Math.abs(point.y - handle.y) <= tolerance) {
        return handle.handle;
      }
    }
    return null;
  }

  private createTransformStart(elementIds: string[], handle: TransformHandle): TransformStart {
    const bounds = this.boundsForElements(elementIds);
    const anchor = {
      x: handle.includes('w') ? bounds.x + bounds.width : bounds.x,
      y: handle.includes('n') ? bounds.y + bounds.height : bounds.y
    };
    return {
      elementIds,
      elements: this.elements.filter((element) => elementIds.includes(element.id)).map((element) => this.cloneElement(element)),
      bounds,
      anchor
    };
  }

  private applyTransform(pointer: WhiteboardPoint, keepRatio: boolean): void {
    const transform = this.transformStart;
    if (!transform) {
      return;
    }
    let nextX = pointer.x;
    let nextY = pointer.y;
    if (keepRatio) {
      const ratio = Math.max(0.01, transform.bounds.width / Math.max(1, transform.bounds.height));
      const deltaX = nextX - transform.anchor.x;
      const deltaY = nextY - transform.anchor.y;
      if (Math.abs(deltaX) > Math.abs(deltaY) * ratio) {
        nextY = transform.anchor.y + (Math.abs(deltaX) / ratio) * Math.sign(deltaY || 1);
      } else {
        nextX = transform.anchor.x + Math.abs(deltaY) * ratio * Math.sign(deltaX || 1);
      }
    }
    const nextBounds = this.boundsFromAnchor(transform.anchor, this.snapPoint({ x: nextX, y: nextY }));
    const transformed = transform.elements.map((element) => this.scaleElementToBounds(element, transform.bounds, nextBounds));
    this.elements = this.elements.map((element) => transformed.find((item) => item.id === element.id) ?? element);
  }

  private boundsFromAnchor(anchor: WhiteboardPoint, point: WhiteboardPoint): ElementBounds {
    return {
      x: Math.min(anchor.x, point.x),
      y: Math.min(anchor.y, point.y),
      width: Math.max(1, Math.abs(point.x - anchor.x)),
      height: Math.max(1, Math.abs(point.y - anchor.y))
    };
  }

  private scaleElementToBounds(element: WhiteboardElement, fromBounds: ElementBounds, toBounds: ElementBounds): WhiteboardElement {
    const scaleX = toBounds.width / Math.max(1, fromBounds.width);
    const scaleY = toBounds.height / Math.max(1, fromBounds.height);
    const mapPoint = (point: WhiteboardPoint): WhiteboardPoint => ({
      x: toBounds.x + (point.x - fromBounds.x) * scaleX,
      y: toBounds.y + (point.y - fromBounds.y) * scaleY
    });
    const next = this.cloneElement(element);
    if (next.type === 'stroke') {
      next.points = next.points.map(mapPoint);
    } else if (next.type === 'shape') {
      next.from = mapPoint(next.from);
      next.to = mapPoint(next.to);
    } else {
      next.position = mapPoint(next.position);
      if (next.type === 'text') {
        next.fontSize = Math.max(8, next.fontSize * Math.max(scaleX, scaleY));
      } else {
        next.width *= scaleX;
        next.height *= scaleY;
      }
    }
    return next;
  }

  private flipElement(element: WhiteboardElement, bounds: ElementBounds, direction: 'horizontal' | 'vertical'): WhiteboardElement {
    const next = this.cloneElement(element);
    const flipPoint = (point: WhiteboardPoint): WhiteboardPoint =>
      direction === 'horizontal'
        ? { x: bounds.x + bounds.width - (point.x - bounds.x), y: point.y }
        : { x: point.x, y: bounds.y + bounds.height - (point.y - bounds.y) };
    if (next.type === 'stroke') {
      next.points = next.points.map(flipPoint);
    } else if (next.type === 'shape') {
      next.from = flipPoint(next.from);
      next.to = flipPoint(next.to);
    } else {
      next.position = flipPoint(next.position);
    }
    return next;
  }

  private rotateElement(element: WhiteboardElement, bounds: ElementBounds, direction: 'left' | 'right'): WhiteboardElement {
    const next = this.cloneElement(element);
    const rotatePoint = (point: WhiteboardPoint): WhiteboardPoint => this.rotatePoint(point, bounds, direction);
    if (next.type === 'stroke') {
      next.points = next.points.map(rotatePoint);
      return next;
    }
    if (next.type === 'shape') {
      next.from = rotatePoint(next.from);
      next.to = rotatePoint(next.to);
      return next;
    }

    const elementBounds = this.boundsForElement(next);
    const center = rotatePoint({
      x: elementBounds.x + elementBounds.width / 2,
      y: elementBounds.y + elementBounds.height / 2
    });
    if (next.type === 'file') {
      const width = next.height;
      const height = next.width;
      next.width = width;
      next.height = height;
      next.position = { x: center.x - width / 2, y: center.y - height / 2 };
      return next;
    }

    next.position = {
      x: center.x - elementBounds.width / 2,
      y: center.y - elementBounds.height / 2
    };
    return next;
  }

  private rotatePoint(point: WhiteboardPoint, bounds: ElementBounds, direction: 'left' | 'right'): WhiteboardPoint {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const deltaX = point.x - centerX;
    const deltaY = point.y - centerY;
    return direction === 'right'
      ? { x: centerX - deltaY, y: centerY + deltaX }
      : { x: centerX + deltaY, y: centerY - deltaX };
  }

  private reorderSelected(direction: 1 | -1): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    const elements = [...this.elements];
    const orderedIndexes = elements.map((element, index) => ({ element, index })).filter(({ element }) => selectedIds.includes(element.id));
    const indexes = direction === 1 ? orderedIndexes.reverse() : orderedIndexes;
    for (const { index } of indexes) {
      const target = index + direction;
      if (target < 0 || target >= elements.length || selectedIds.includes(elements[target]!.id)) {
        continue;
      }
      [elements[index], elements[target]] = [elements[target]!, elements[index]!];
    }
    this.elements = elements;
    this.closeContextMenu();
    this.emitSelectionUpserts();
    this.render();
  }

  private reorderSelectedToEdge(edge: 'front' | 'back'): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    this.pushHistory();
    const selected: WhiteboardElement[] = [];
    const unselected: WhiteboardElement[] = [];
    for (const element of this.elements) {
      if (selectedIds.includes(element.id)) {
        selected.push(element);
      } else {
        unselected.push(element);
      }
    }
    this.elements = edge === 'front' ? [...unselected, ...selected] : [...selected, ...unselected];
    this.closeContextMenu();
    this.emitSelectionUpserts();
    this.render();
  }

  private adjustMoveDelta(deltaX: number, deltaY: number): WhiteboardPoint {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return { x: deltaX, y: deltaY };
    }
    let nextDelta = { x: deltaX, y: deltaY };
    if (this.snapToGrid()) {
      const bounds = this.boundsForElements(selectedIds);
      const snapped = this.snapPoint({ x: bounds.x + deltaX, y: bounds.y + deltaY });
      nextDelta = { x: snapped.x - bounds.x, y: snapped.y - bounds.y };
    }
    const adjusted = this.applyAlignmentGuides(nextDelta);
    this.alignmentGuides.set(adjusted.guides);
    return adjusted.delta;
  }

  private applyAlignmentGuides(delta: WhiteboardPoint): { delta: WhiteboardPoint; guides: AlignmentGuide[] } {
    const selectedIds = this.selectedElementIds();
    const moving = this.boundsForElements(selectedIds);
    const next = { x: moving.x + delta.x, y: moving.y + delta.y, width: moving.width, height: moving.height };
    const movingX = [next.x, next.x + next.width / 2, next.x + next.width];
    const movingY = [next.y, next.y + next.height / 2, next.y + next.height];
    const others = this.elements.filter((element) => !selectedIds.includes(element.id)).map((element) => this.boundsForElement(element));
    const guides: AlignmentGuide[] = [];
    let adjusted = { ...delta };
    for (const other of others) {
      const otherX = [other.x, other.x + other.width / 2, other.x + other.width];
      const otherY = [other.y, other.y + other.height / 2, other.y + other.height];
      for (const source of movingX) {
        for (const target of otherX) {
          if (Math.abs(source - target) <= ALIGNMENT_TOLERANCE) {
            adjusted.x += target - source;
            guides.push({ orientation: 'vertical', position: target });
          }
        }
      }
      for (const source of movingY) {
        for (const target of otherY) {
          if (Math.abs(source - target) <= ALIGNMENT_TOLERANCE) {
            adjusted.y += target - source;
            guides.push({ orientation: 'horizontal', position: target });
          }
        }
      }
    }
    return { delta: adjusted, guides: guides.slice(0, 2) };
  }

  private emitSelectionUpserts(): void {
    for (const element of this.elements.filter((item) => this.selectedElementIds().includes(item.id))) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
  }

  private snapPoint(point: WhiteboardPoint): WhiteboardPoint {
    if (!this.snapToGrid()) {
      return point;
    }
    return {
      x: Math.round(point.x / GRID_SIZE) * GRID_SIZE,
      y: Math.round(point.y / GRID_SIZE) * GRID_SIZE
    };
  }

  private selectedElements(): WhiteboardElement[] {
    const selectedIds = this.selectedElementIds();
    return this.elements.filter((element) => selectedIds.includes(element.id));
  }

  private pushHistory(): void {
    this.historyPast.push(this.clonePages(this.pages()));
    if (this.historyPast.length > 80) {
      this.historyPast.shift();
    }
    this.historyFuture = [];
    this.bumpHistoryVersion();
  }

  private bumpHistoryVersion(): void {
    this.historyVersion.update((version) => version + 1);
  }

  private clonePages(pages: WhiteboardPage[]): WhiteboardPage[] {
    return structuredClone(pages);
  }

  private resolveImage(dataUrl: string): HTMLImageElement | undefined {
    const cached = this.imageCache.get(dataUrl);
    if (cached) {
      return cached;
    }
    const image = new Image();
    image.onload = () => this.render();
    image.src = dataUrl;
    this.imageCache.set(dataUrl, image);
    return image;
  }

  private showLaser(point: WhiteboardPoint): void {
    this.laserPoint.set(point);
    this.emitCursor(point);
    if (this.laserTimeout) {
      window.clearTimeout(this.laserTimeout);
    }
    this.laserTimeout = window.setTimeout(() => this.laserPoint.set(null), 900);
  }

  private emitCursor(point: WhiteboardPoint): void {
    this.cursorMoved.emit({
      participantId: 'local',
      displayName: 'You',
      color: this.strokeColor(),
      position: point
    });
  }

  private measureTextWidth(context: CanvasRenderingContext2D, element: WhiteboardTextElement): number {
    context.save();
    context.font = `${element.fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    const width = context.measureText(element.text).width;
    context.restore();
    return width;
  }

  private distanceToSegment(point: WhiteboardPoint, start: WhiteboardPoint, end: WhiteboardPoint): number {
    const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    if (lengthSquared === 0) {
      return this.distance(point, start);
    }
    const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
    return this.distance(point, {
      x: start.x + ratio * (end.x - start.x),
      y: start.y + ratio * (end.y - start.y)
    });
  }

  private segmentDistance(a: WhiteboardPoint, b: WhiteboardPoint, c: WhiteboardPoint, d: WhiteboardPoint): number {
    if (this.segmentsIntersect(a, b, c, d)) {
      return 0;
    }
    return Math.min(
      this.distanceToSegment(a, c, d),
      this.distanceToSegment(b, c, d),
      this.distanceToSegment(c, a, b),
      this.distanceToSegment(d, a, b)
    );
  }

  private segmentsIntersect(a: WhiteboardPoint, b: WhiteboardPoint, c: WhiteboardPoint, d: WhiteboardPoint): boolean {
    const orientationA = this.segmentOrientation(a, b, c);
    const orientationB = this.segmentOrientation(a, b, d);
    const orientationC = this.segmentOrientation(c, d, a);
    const orientationD = this.segmentOrientation(c, d, b);

    if (orientationA !== orientationB && orientationC !== orientationD) {
      return true;
    }

    return (
      (orientationA === 0 && this.pointOnSegment(c, a, b)) ||
      (orientationB === 0 && this.pointOnSegment(d, a, b)) ||
      (orientationC === 0 && this.pointOnSegment(a, c, d)) ||
      (orientationD === 0 && this.pointOnSegment(b, c, d))
    );
  }

  private segmentOrientation(a: WhiteboardPoint, b: WhiteboardPoint, c: WhiteboardPoint): -1 | 0 | 1 {
    const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(value) < 0.001) {
      return 0;
    }
    return value > 0 ? 1 : -1;
  }

  private pointOnSegment(point: WhiteboardPoint, start: WhiteboardPoint, end: WhiteboardPoint): boolean {
    const epsilon = 0.001;
    return (
      point.x >= Math.min(start.x, end.x) - epsilon &&
      point.x <= Math.max(start.x, end.x) + epsilon &&
      point.y >= Math.min(start.y, end.y) - epsilon &&
      point.y <= Math.max(start.y, end.y) + epsilon
    );
  }

  private distance(a: WhiteboardPoint, b: WhiteboardPoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private expandBounds(bounds: ElementBounds, amount: number): ElementBounds {
    return {
      x: bounds.x - amount,
      y: bounds.y - amount,
      width: bounds.width + amount * 2,
      height: bounds.height + amount * 2
    };
  }

  private cloneElement<T extends WhiteboardElement>(element: T): T {
    return structuredClone(element);
  }

  private cssVariable(name: string, fallback: string): string {
    const value = getComputedStyle(this.whiteboardSurface?.nativeElement ?? document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  protected isShapeTool(tool: WhiteboardTool): boolean {
    return tool === 'line' || tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse' || tool === 'star';
  }

  private isFillableShape(shape: WhiteboardShapeTool): boolean {
    return shape === 'rectangle' || shape === 'ellipse' || shape === 'star';
  }

  private strokeFillPath(element: WhiteboardStrokeElement): StrokeFillPath | null {
    const points = element.points;
    if (points.length < 3) {
      return null;
    }

    const closeThreshold = Math.max(18, element.width * 3);
    const minimumArea = Math.max(36, element.width * element.width * 3);
    const first = points[0]!;
    const last = points[points.length - 1]!;

    if (this.distance(first, last) <= closeThreshold && Math.abs(this.polygonArea(points)) >= minimumArea) {
      return { points: points.map((point) => ({ ...point })) };
    }

    const endpointLoop = this.endpointClosedStrokePath(points, closeThreshold, minimumArea);
    if (endpointLoop) {
      return endpointLoop;
    }

    return this.selfIntersectingStrokePath(points, minimumArea);
  }

  private endpointClosedStrokePath(points: WhiteboardPoint[], closeThreshold: number, minimumArea: number): StrokeFillPath | null {
    const last = points[points.length - 1]!;
    let bestPath: StrokeFillPath | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < points.length - 2; index += 1) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const closePoint = this.closestPointOnSegment(last, start, end);
      const distance = this.distance(last, closePoint);
      if (distance > closeThreshold || distance >= bestDistance) {
        continue;
      }
      const loopPoints = [closePoint, ...points.slice(index + 1), closePoint];
      if (Math.abs(this.polygonArea(loopPoints)) < minimumArea) {
        continue;
      }
      bestDistance = distance;
      bestPath = { points: loopPoints };
    }

    return bestPath;
  }

  private selfIntersectingStrokePath(points: WhiteboardPoint[], minimumArea: number): StrokeFillPath | null {
    let bestPath: StrokeFillPath | null = null;
    let bestArea = 0;

    for (let firstIndex = 0; firstIndex < points.length - 1; firstIndex += 1) {
      for (let secondIndex = firstIndex + 2; secondIndex < points.length - 1; secondIndex += 1) {
        const firstStart = points[firstIndex]!;
        const firstEnd = points[firstIndex + 1]!;
        const secondStart = points[secondIndex]!;
        const secondEnd = points[secondIndex + 1]!;
        if (!this.segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
          continue;
        }
        const intersection = this.segmentIntersectionPoint(firstStart, firstEnd, secondStart, secondEnd) ?? firstEnd;
        const loopPoints = [intersection, ...points.slice(firstIndex + 1, secondIndex + 1), intersection];
        const area = Math.abs(this.polygonArea(loopPoints));
        if (area >= minimumArea && area > bestArea) {
          bestArea = area;
          bestPath = { points: loopPoints };
        }
      }
    }

    return bestPath;
  }

  private polygonArea(points: WhiteboardPoint[]): number {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      area += current.x * next.y - next.x * current.y;
    }
    return area / 2;
  }

  private pointInPolygon(point: WhiteboardPoint, polygon: WhiteboardPoint[]): boolean {
    let inside = false;
    for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
      const current = polygon[index]!;
      const previous = polygon[previousIndex]!;
      const crossesY = current.y > point.y !== previous.y > point.y;
      if (!crossesY) {
        continue;
      }
      const xAtY = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
      if (point.x < xAtY) {
        inside = !inside;
      }
    }
    return inside;
  }

  private closestPointOnSegment(point: WhiteboardPoint, start: WhiteboardPoint, end: WhiteboardPoint): WhiteboardPoint {
    const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    if (lengthSquared === 0) {
      return { ...start };
    }
    const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
    return {
      x: start.x + ratio * (end.x - start.x),
      y: start.y + ratio * (end.y - start.y)
    };
  }

  private segmentIntersectionPoint(a: WhiteboardPoint, b: WhiteboardPoint, c: WhiteboardPoint, d: WhiteboardPoint): WhiteboardPoint | null {
    const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(denominator) < 0.001) {
      return null;
    }
    const aCrossB = a.x * b.y - a.y * b.x;
    const cCrossD = c.x * d.y - c.y * d.x;
    return {
      x: (aCrossB * (c.x - d.x) - (a.x - b.x) * cCrossD) / denominator,
      y: (aCrossB * (c.y - d.y) - (a.y - b.y) * cCrossD) / denominator
    };
  }

  private isTinyElement(element: WhiteboardElement): boolean {
    const bounds = this.boundsForElement(element);
    return element.type === 'shape' && bounds.width < 3 && bounds.height < 3;
  }

  private setZoom(value: number): void {
    this.zoom.set(Math.min(Math.max(Number(value.toFixed(2)), 0.5), 2.5));
  }

  private downloadDataUrl(dataUrl: string, fileName: string): void {
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = fileName;
    anchor.click();
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    this.downloadDataUrl(url, fileName);
    window.setTimeout(() => URL.revokeObjectURL(url));
  }

  private createPdfBlob(jpegDataUrl: string, width: number, height: number): Blob {
    const encoder = new TextEncoder();
    const imageBytes = this.base64ToBytes(jpegDataUrl.split(',')[1] ?? '');
    const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    const chunks: BlobPart[] = [];
    const offsets: number[] = [];
    let byteOffset = 0;
    const write = (part: string | Uint8Array): void => {
      const bytes = typeof part === 'string' ? encoder.encode(part) : part;
      chunks.push(new Uint8Array(bytes));
      byteOffset += bytes.length;
    };
    const writeObject = (id: number, parts: Array<string | Uint8Array>): void => {
      offsets[id] = byteOffset;
      write(`${id} 0 obj\n`);
      for (const part of parts) {
        write(part);
      }
      write('\nendobj\n');
    };

    write('%PDF-1.3\n');
    writeObject(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    writeObject(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
    writeObject(3, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
    ]);
    writeObject(4, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
      imageBytes,
      '\nendstream'
    ]);
    writeObject(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);

    const xrefOffset = byteOffset;
    write('xref\n0 6\n0000000000 65535 f \n');
    for (let objectId = 1; objectId <= 5; objectId += 1) {
      write(`${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`);
    }
    write(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
}
