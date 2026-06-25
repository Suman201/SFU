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
import type { WhiteboardMemoryPage, WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export type WhiteboardTool =
  | 'select'
  | 'pen'
  | 'eraser'
  | 'line'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'star'
  | 'text'
  | 'equation'
  | 'graph'
  | 'segment'
  | 'ruler'
  | 'protractor'
  | 'angle'
  | 'circle'
  | 'arc'
  | 'perpendicular'
  | 'parallel'
  | 'midpoint'
  | 'point'
  | 'vector'
  | 'polygon'
  | 'venn'
  | 'node-edge'
  | 'tree'
  | 'flow'
  | 'probability-tree'
  | 'coordinate-axes'
  | 'number-line-template'
  | 'table-layout'
  | 'fraction-bars'
  | 'laser'
  | 'pan';
export type WhiteboardShapeTool = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'star';
export type WhiteboardGeometryTool =
  | 'segment'
  | 'ruler'
  | 'protractor'
  | 'angle'
  | 'circle'
  | 'arc'
  | 'perpendicular'
  | 'parallel'
  | 'midpoint'
  | 'point'
  | 'vector'
  | 'polygon';
export type WhiteboardDiagramTool =
  | 'venn'
  | 'node-edge'
  | 'tree'
  | 'flow'
  | 'probability-tree'
  | 'coordinate-axes'
  | 'number-line-template'
  | 'table-layout'
  | 'fraction-bars';
export type WhiteboardFileKind = 'image' | 'document';
export type WhiteboardAssetFit = 'contain' | 'cover' | 'stretch';
export type WhiteboardTemplateId = 'blank' | 'ruled' | 'grid' | 'graph' | 'coordinate' | 'number-line' | 'geometry' | 'table' | 'fraction';
export type WhiteboardTextAlignment = 'left' | 'center' | 'right';

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
  fillColor?: string | null;
  fontSize: number;
  position: WhiteboardPoint;
  text: string;
  width?: number;
  height?: number;
  align?: WhiteboardTextAlignment;
}

export interface WhiteboardEquationElement extends WhiteboardElementBase {
  type: 'equation';
  color: string;
  fillColor?: string | null;
  fontSize: number;
  position: WhiteboardPoint;
  raw: string;
  width: number;
  height: number;
  align?: WhiteboardTextAlignment;
}

export interface WhiteboardGraphFunction {
  id: string;
  expression: string;
  color: string;
  width: number;
}

export interface WhiteboardGraphHelpers {
  pointX?: number | null;
  tangentX?: number | null;
  shadeFrom?: number | null;
  shadeTo?: number | null;
  showIntercepts?: boolean;
}

export interface WhiteboardGraphParametricPlot {
  xExpression: string;
  yExpression: string;
  tMin: number;
  tMax: number;
  color: string;
  width: number;
}

export interface WhiteboardGraphPolarPlot {
  expression: string;
  thetaMin: number;
  thetaMax: number;
  color: string;
  width: number;
}

export interface WhiteboardGraphLabel {
  x: number;
  y: number;
  text: string;
  color?: string;
}

export interface WhiteboardGraphStats {
  histogramData?: string;
  histogramBins?: number;
  showRegression?: boolean;
  normalMean?: number | null;
  normalStdDev?: number | null;
}

export interface WhiteboardGraphElement extends WhiteboardElementBase {
  type: 'graph';
  position: WhiteboardPoint;
  width: number;
  height: number;
  title?: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  showGrid: boolean;
  showAxes: boolean;
  showTicks: boolean;
  tickStep?: number | null;
  functions: WhiteboardGraphFunction[];
  inequality?: string;
  parametric?: WhiteboardGraphParametricPlot | null;
  polar?: WhiteboardGraphPolarPlot | null;
  scatterPoints?: string;
  scatterColor?: string;
  labels?: WhiteboardGraphLabel[];
  stats?: WhiteboardGraphStats;
  helpers?: WhiteboardGraphHelpers;
}

export interface WhiteboardGeometryElement extends WhiteboardElementBase {
  type: 'geometry';
  kind: WhiteboardGeometryTool;
  strokeColor: string;
  fillColor?: string | null;
  width: number;
  from: WhiteboardPoint;
  to: WhiteboardPoint;
  label?: string;
  showMeasurement: boolean;
  dashed?: boolean;
}

export interface WhiteboardDiagramElement extends WhiteboardElementBase {
  type: 'diagram';
  kind: WhiteboardDiagramTool;
  position: WhiteboardPoint;
  width: number;
  height: number;
  strokeColor: string;
  fillColor?: string | null;
  lineWidth: number;
  labels: string[];
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

export interface WhiteboardPageBackground {
  kind: 'image';
  sourceType?: 'image' | 'pdf-page' | 'slide-image';
  fileName: string;
  mimeType?: string;
  pageNumber?: number;
  materialId?: string;
  attachmentId?: string;
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  fit: WhiteboardAssetFit;
  importedAt: string;
}

export type WhiteboardElement =
  | WhiteboardStrokeElement
  | WhiteboardShapeElement
  | WhiteboardTextElement
  | WhiteboardEquationElement
  | WhiteboardGraphElement
  | WhiteboardGeometryElement
  | WhiteboardDiagramElement
  | WhiteboardFileElement;

export interface WhiteboardPage {
  id: string;
  title: string;
  tags?: string[];
  template: WhiteboardTemplateId;
  view: WhiteboardPageView;
  background?: WhiteboardPageBackground | null;
  elements: WhiteboardElement[];
}

export interface WhiteboardPageView {
  zoom: number;
  panX: number;
  panY: number;
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

export interface WhiteboardElementRef {
  elementId: string;
  pageId?: string;
}

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
  mode: 'text' | 'equation';
  elementId?: string;
  width?: number;
  height?: number;
  align?: WhiteboardTextAlignment;
}

interface GraphDraft {
  elementId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  expression: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  showGrid: boolean;
  showAxes: boolean;
  showTicks: boolean;
  tickStep: string;
  curveColor: string;
  lineWidth: number;
  pointX: string;
  tangentX: string;
  shadeFrom: string;
  shadeTo: string;
  showIntercepts: boolean;
  inequality: string;
  parametricX: string;
  parametricY: string;
  parametricTMin: string;
  parametricTMax: string;
  polarExpression: string;
  polarThetaMin: string;
  polarThetaMax: string;
  scatterPoints: string;
  histogramData: string;
  histogramBins: string;
  showRegression: boolean;
  normalMean: string;
  normalStdDev: string;
  labels: string;
  error?: string | null;
}

type TransformHandle = 'nw' | 'ne' | 'sw' | 'se';
type FlipDirection = 'horizontal' | 'vertical' | 'left' | 'right';
type MathToolsTab = 'equation' | 'templates' | 'snippets' | 'graph' | 'geometry';
type WhiteboardEraserMode = 'partial' | 'stroke' | 'area';

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

interface WhiteboardTemplateOption {
  id: WhiteboardTemplateId;
  label: string;
  description: string;
}

interface PdfImagePage {
  jpegDataUrl: string;
  width: number;
  height: number;
}

interface MathSnippet {
  label: string;
  value: string;
}

interface MathShortcutGroup {
  label: string;
  shortcuts: MathSnippet[];
}

interface MathRunMetrics {
  width: number;
  height: number;
}

interface ParsedGroup {
  value: string;
  endIndex: number;
}

type GraphTokenType = 'number' | 'identifier' | 'operator' | 'paren' | 'comma' | 'eof';

interface GraphToken {
  type: GraphTokenType;
  value: string;
}

type GraphAstNode =
  | { type: 'number'; value: number }
  | { type: 'variable' }
  | { type: 'unary'; operator: '+' | '-'; argument: GraphAstNode }
  | { type: 'binary'; operator: '+' | '-' | '*' | '/' | '^'; left: GraphAstNode; right: GraphAstNode }
  | { type: 'call'; name: string; argument: GraphAstNode };

interface GraphParseResult {
  evaluate: (x: number) => number;
  error?: string;
}

interface GraphViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface GeometryToolOption {
  id: WhiteboardGeometryTool;
  label: string;
}

interface GeometryToolGroup {
  label: string;
  tools: GeometryToolOption[];
}

interface DiagramToolOption {
  id: WhiteboardDiagramTool;
  label: string;
}

interface MathToolsTabOption {
  id: MathToolsTab;
  label: string;
}

interface EraserModeOption {
  id: WhiteboardEraserMode;
  label: string;
  description: string;
}

interface InsertTemplateOption {
  kind: WhiteboardDiagramTool;
  label: string;
  description: string;
}

interface MathPopoverPosition {
  x: number;
  y: number;
}

interface MathPopoverDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface AssetImportStatus {
  type: 'info' | 'success' | 'error';
  message: string;
}

type AssetImportMode = 'element' | 'background' | 'pdf-pages' | 'slide-pages';
type AssetPageSourceType = 'image' | 'slide-image';
type PdfJsModule = typeof import('pdfjs-dist');

const GRID_SIZE = 24;
const ALIGNMENT_TOLERANCE = 6;
const MAX_IMAGE_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_PDF_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_PDF_IMPORT_PAGES = 30;
const MAX_SLIDE_IMAGE_IMPORT_PAGES = 40;
const PDF_RENDER_MAX_DIMENSION = 1800;
const IMAGE_ASSET_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PDFJS_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
const DEFAULT_TEMPLATE_ID: WhiteboardTemplateId = 'grid';
const DEFAULT_PAGE_VIEW: WhiteboardPageView = { zoom: 1, panX: 0, panY: 0 };
const TEMPLATE_OPTIONS: WhiteboardTemplateOption[] = [
  { id: 'blank', label: 'Blank', description: 'Clean canvas' },
  { id: 'ruled', label: 'Ruled notebook', description: 'Writing lines with margin' },
  { id: 'grid', label: 'Grid', description: 'Standard square grid' },
  { id: 'graph', label: 'Graph paper', description: 'Fine graph paper' },
  { id: 'coordinate', label: 'Coordinate axes', description: 'Centered x/y axes' },
  { id: 'number-line', label: 'Number line', description: 'Horizontal number line' },
  { id: 'geometry', label: 'Geometry grid', description: 'Construction guide grid' },
  { id: 'table', label: 'Table layout', description: 'Rows and columns' },
  { id: 'fraction', label: 'Fraction bars', description: 'Fraction comparison bars' }
];
const TEXT_ALIGNMENT_OPTIONS: WhiteboardTextAlignment[] = ['left', 'center', 'right'];
const MATH_SHORTCUT_GROUPS: MathShortcutGroup[] = [
  {
    label: 'Structure',
    shortcuts: [
      { label: 'Fraction', value: '\\frac{a}{b}' },
      { label: 'Power', value: 'x^{2}' },
      { label: 'Subscript', value: 'a_{n}' },
      { label: 'Root', value: '\\sqrt{x}' }
    ]
  },
  {
    label: 'Greek',
    shortcuts: [
      { label: 'α', value: '\\alpha' },
      { label: 'β', value: '\\beta' },
      { label: 'γ', value: '\\gamma' },
      { label: 'θ', value: '\\theta' },
      { label: 'π', value: '\\pi' },
      { label: 'σ', value: '\\sigma' },
      { label: 'ω', value: '\\omega' }
    ]
  },
  {
    label: 'Operators',
    shortcuts: [
      { label: 'Integral', value: '\\int ' },
      { label: 'Sum', value: '\\sum ' },
      { label: 'Limit', value: '\\lim_{x \\to 0}' },
      { label: 'Vector', value: '\\vec{v}' },
      { label: 'Angle', value: '\\angle ABC' }
    ]
  },
  {
    label: 'Matrices',
    shortcuts: [
      { label: '2 x 2', value: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}' },
      { label: '3 x 3', value: '\\begin{matrix} a & b & c \\\\ d & e & f \\\\ g & h & i \\end{matrix}' }
    ]
  }
];
const MATH_SNIPPETS: MathSnippet[] = [
  ...MATH_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts),
  { label: 'Quadratic', value: 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}' },
  { label: 'Circle', value: '(x-h)^2+(y-k)^2=r^2' },
  { label: 'Slope', value: 'm=\\frac{y_2-y_1}{x_2-x_1}' },
  { label: 'Distance', value: 'd=\\sqrt{(x_2-x_1)^2+(y_2-y_1)^2}' },
  { label: 'Pythagorean', value: 'a^2+b^2=c^2' },
  { label: 'Area circle', value: 'A=\\pi r^2' },
  { label: 'Trig identity', value: '\\sin^2\\theta+\\cos^2\\theta=1' },
  { label: 'Proof frame', value: 'Given:\\nTo prove:\\nConstruction:\\nProof:' }
];
const MATH_COMMAND_REPLACEMENTS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  phi: 'φ',
  omega: 'ω',
  int: '∫',
  sum: 'Σ',
  lim: 'lim',
  angle: '∠',
  infty: '∞',
  infinity: '∞',
  le: '≤',
  ge: '≥',
  approx: '≈',
  neq: '≠',
  times: '×',
  div: '÷',
  pm: '±',
  cdot: '·',
  ldots: '…',
  cdots: '⋯',
  to: '→',
  rightarrow: '→',
  leftarrow: '←'
};
const GEOMETRY_TOOL_GROUPS: GeometryToolGroup[] = [
  {
    label: 'Precision',
    tools: [
      { id: 'ruler', label: 'Ruler' },
      { id: 'protractor', label: 'Protractor' },
      { id: 'circle', label: 'Compass' },
      { id: 'angle', label: 'Angle' }
    ]
  },
  {
    label: 'Construction',
    tools: [
      { id: 'segment', label: 'Straightedge' },
      { id: 'parallel', label: 'Parallel' },
      { id: 'perpendicular', label: 'Perpendicular' },
      { id: 'midpoint', label: 'Midpoint' },
      { id: 'point', label: 'Point' }
    ]
  },
  {
    label: 'Shapes',
    tools: [
      { id: 'vector', label: 'Vector' },
      { id: 'polygon', label: 'Polygon' },
      { id: 'arc', label: 'Arc' }
    ]
  }
];
const GEOMETRY_TOOL_OPTIONS: GeometryToolOption[] = GEOMETRY_TOOL_GROUPS.flatMap((group) => group.tools);
const DIAGRAM_TOOL_OPTIONS: DiagramToolOption[] = [
  { id: 'venn', label: 'Venn' },
  { id: 'node-edge', label: 'Nodes' },
  { id: 'tree', label: 'Tree' },
  { id: 'flow', label: 'Flow' },
  { id: 'probability-tree', label: 'Probability' }
];
const MATH_TOOLS_TABS: MathToolsTabOption[] = [
  { id: 'equation', label: 'Equation' },
  { id: 'templates', label: 'Templates' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'graph', label: 'Graph' },
  { id: 'geometry', label: 'Geometry' }
];
const ERASER_MODE_OPTIONS: EraserModeOption[] = [
  { id: 'partial', label: 'Partial', description: 'Trim pen strokes under the eraser.' },
  { id: 'stroke', label: 'Stroke', description: 'Remove the whole stroke or object.' },
  { id: 'area', label: 'Area', description: 'Use a larger classroom eraser radius.' }
];
const INSERT_TEMPLATE_OPTIONS: InsertTemplateOption[] = [
  { kind: 'coordinate-axes', label: 'Coordinate axes', description: 'Movable x/y axes with ticks and origin.' },
  { kind: 'number-line-template', label: 'Number line', description: 'Movable signed number line with ticks.' },
  { kind: 'table-layout', label: 'Table layout', description: 'Editable 4 x 5 classroom table starter.' },
  { kind: 'fraction-bars', label: 'Fraction bars', description: 'Halves, thirds, fourths, fifths, and eighths.' },
  { kind: 'venn', label: 'Venn diagram', description: 'Editable two-set comparison starter.' },
  { kind: 'flow', label: 'Flowchart', description: 'Editable process / worked-example steps.' },
  { kind: 'tree', label: 'Tree', description: 'Branching proof or decision layout.' },
  { kind: 'probability-tree', label: 'Probability tree', description: 'Probability branches with p / 1-p labels.' }
];
const ANGLE_SNAP_OPTIONS = [0, 15, 30, 45, 90];
const RECENT_COLOR_LIMIT = 8;
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
  equation: 'Equation',
  graph: 'Graph',
  segment: 'Segment',
  ruler: 'Ruler',
  protractor: 'Protractor',
  angle: 'Angle',
  circle: 'Circle',
  arc: 'Arc',
  perpendicular: 'Perpendicular',
  parallel: 'Parallel',
  midpoint: 'Midpoint',
  point: 'Point',
  vector: 'Vector',
  polygon: 'Polygon',
  venn: 'Venn',
  'node-edge': 'Nodes',
  tree: 'Tree',
  flow: 'Flow',
  'probability-tree': 'Probability',
  'coordinate-axes': 'Axes',
  'number-line-template': 'Number line',
  'table-layout': 'Table',
  'fraction-bars': 'Fractions',
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
  readonly allowedTools = input<readonly WhiteboardTool[] | null>(null);
  readonly allowPageManagement = input(true);
  readonly allowAssetImport = input(true);
  readonly allowExport = input(true);
  readonly allowClear = input(true);
  readonly showEndSession = input(false);
  readonly cursors = input<WhiteboardCursor[]>([]);
  readonly commandCommitted = output<WhiteboardCommand>();
  readonly cursorMoved = output<WhiteboardCursor>();
  readonly stateChanged = output<void>();
  readonly endSession = output<void>();

  @ViewChild('whiteboardSurface') private readonly whiteboardSurface?: ElementRef<HTMLDivElement>;
  @ViewChild('whiteboardCanvas') private readonly whiteboardCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('textEditor') private readonly textEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('mathEquationInput') private readonly mathEquationInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('mathToolsPopover') private readonly mathToolsPopover?: ElementRef<HTMLElement>;
  @ViewChild('fileInput') private readonly fileInput?: ElementRef<HTMLInputElement>;

  protected readonly activeTool = signal<WhiteboardTool>('select');
  protected readonly activeShapeTool = signal<WhiteboardShapeTool>('rectangle');
  protected readonly activeGeometryTool = signal<WhiteboardGeometryTool>('segment');
  protected readonly activeDiagramTool = signal<WhiteboardDiagramTool>('venn');
  protected readonly shapeMenuOpen = signal(false);
  protected readonly geometryMenuOpen = signal(false);
  protected readonly diagramMenuOpen = signal(false);
  protected readonly colorMenuOpen = signal(false);
  protected readonly fillColorMenuOpen = signal(false);
  protected readonly brushMenuOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly strokeColor = signal('#071c41');
  protected readonly fillColor = signal('#FFD150');
  protected readonly fillEnabled = signal(false);
  protected readonly strokeWidth = signal(4);
  protected readonly eraserMode = signal<WhiteboardEraserMode>('partial');
  protected readonly eraserSize = signal(18);
  protected readonly fontSize = signal(28);
  protected readonly colors = ['#071c41', '#458B73', '#F26076', '#FF9760', '#FFD150'];
  protected readonly recentColors = signal<string[]>([]);
  protected readonly customRecentColors = computed(() =>
    this.recentColors().filter((color) => !this.colors.some((preset) => preset.toLowerCase() === color.toLowerCase()))
  );
  protected readonly brushSizes = [3, 6, 10, 14];
  protected readonly eraserSizes = [12, 18, 28, 40];
  protected readonly eraserModeOptions = ERASER_MODE_OPTIONS;
  protected readonly mathSnippets = MATH_SNIPPETS;
  protected readonly mathShortcutGroups = MATH_SHORTCUT_GROUPS;
  protected readonly mathTabs = MATH_TOOLS_TABS;
  protected readonly textAlignmentOptions = TEXT_ALIGNMENT_OPTIONS;
  protected readonly geometryToolGroups = GEOMETRY_TOOL_GROUPS;
  protected readonly geometryToolOptions = GEOMETRY_TOOL_OPTIONS;
  protected readonly diagramToolOptions = DIAGRAM_TOOL_OPTIONS;
  protected readonly insertTemplateOptions = INSERT_TEMPLATE_OPTIONS;
  protected readonly angleSnapOptions = ANGLE_SNAP_OPTIONS;
  protected readonly mathPopoverOpen = signal(false);
  protected readonly activeMathTab = signal<MathToolsTab>('equation');
  protected readonly mathPopoverPosition = signal<MathPopoverPosition>({ x: 72, y: 72 });
  protected readonly mathEquationDraft = signal('\\frac{a}{b}');
  protected readonly mathEquationFontSize = signal(32);
  protected readonly mathEquationAlignment = signal<WhiteboardTextAlignment>('left');
  protected readonly mathPopoverTransform = computed(() => {
    const position = this.mathPopoverPosition();
    return `translate3d(${position.x}px, ${position.y}px, 0)`;
  });
  protected readonly mathEquationPreview = computed(() => this.renderEquationPreview(this.mathEquationDraft(), this.mathEquationFontSize(), this.strokeColor()));
  protected readonly mathEquationError = computed(() => this.validateMathSource(this.mathEquationDraft()));
  protected readonly zoom = signal(1);
  protected readonly panX = signal(0);
  protected readonly panY = signal(0);
  protected readonly selectedElementIds = signal<string[]>([]);
  protected readonly selectedEquationForPopover = computed(() => this.singleSelectedEquation());
  protected readonly selectedTextForPopover = computed(() => this.singleSelectedText());
  protected readonly mathEquationActionLabel = computed(() => {
    if (this.selectedEquationForPopover()) {
      return 'Update equation';
    }
    if (this.selectedTextForPopover()) {
      return 'Convert text to equation';
    }
    return 'Insert equation';
  });
  protected readonly textDraft = signal<TextDraft | null>(null);
  protected readonly graphDraft = signal<GraphDraft | null>(null);
  protected readonly contextMenu = signal<ContextMenuState | null>(null);
  protected readonly laserPoint = signal<WhiteboardPoint | null>(null);
  protected readonly eraserCursor = signal<WhiteboardPoint | null>(null);
  protected readonly alignmentGuides = signal<AlignmentGuide[]>([]);
  protected readonly selectionMarquee = signal<SelectionMarquee | null>(null);
  protected readonly snapToGrid = signal(false);
  protected readonly snapToPoints = signal(false);
  protected readonly snapIndicator = signal<WhiteboardPoint | null>(null);
  protected readonly angleSnapDegrees = signal(15);
  protected readonly showMeasurements = signal(true);
  protected readonly assetImportMode = signal<AssetImportMode>('element');
  protected readonly assetImportStatus = signal<AssetImportStatus | null>(null);
  protected readonly assetImporting = signal(false);
  protected readonly assetInputAccept = computed(() =>
    this.assetImportMode() === 'pdf-pages'
      ? '.pdf,application/pdf'
      : this.assetImportMode() === 'slide-pages' || this.assetImportMode() === 'background'
        ? 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
        : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,.pdf,application/pdf'
  );
  protected readonly assetInputMultiple = computed(() => this.assetImportMode() === 'slide-pages');
  protected readonly templateOptions = TEMPLATE_OPTIONS;
  protected readonly pages = signal<WhiteboardPage[]>([this.createPage('Board 1')]);
  protected readonly activePageId = signal(this.pages()[0]!.id);
  protected readonly pageSearchQuery = signal('');
  protected readonly selectedExportPageIds = signal<string[]>([]);
  protected readonly historyVersion = signal(0);
  protected readonly activePage = computed(() => this.pages().find((page) => page.id === this.activePageId()) ?? this.pages()[0]!);
  protected readonly activeTemplate = computed(() => this.activePage().template ?? DEFAULT_TEMPLATE_ID);
  protected readonly activeTemplateLabel = computed(
    () => this.templateOptions.find((option) => option.id === this.activeTemplate())?.label ?? 'Grid'
  );
  protected readonly activePageTagsText = computed(() => (this.activePage().tags ?? []).join(', '));
  protected readonly filteredPages = computed(() => {
    const query = this.pageSearchQuery().trim().toLowerCase();
    if (!query) {
      return this.pages();
    }
    return this.pages().filter((page) =>
      page.title.toLowerCase().includes(query) || (page.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
    );
  });
  protected readonly selectedExportPages = computed(() => {
    const selectedIds = new Set(this.selectedExportPageIds());
    return this.pages().filter((page) => selectedIds.has(page.id));
  });
  protected readonly canExportSelectedPages = computed(() => this.canExportBoard() && this.selectedExportPages().length > 0);
  protected readonly canManagePages = computed(() => !this.readOnly() && this.allowPageManagement());
  protected readonly canImportAssets = computed(() => !this.readOnly() && this.allowAssetImport());
  protected readonly canExportBoard = computed(() => this.allowExport());
  protected readonly canClearBoard = computed(() => !this.readOnly() && this.allowClear());
  protected readonly boardTransform = computed(() => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`);
  protected readonly zoomPercent = computed(() => `${Math.round(this.zoom() * 100)}%`);
  protected readonly activeToolLabel = computed(() => {
    if (this.activeTool() === 'eraser') {
      return `Erase · ${this.eraserModeOptions.find((mode) => mode.id === this.eraserMode())?.label ?? 'Partial'}`;
    }
    return TOOL_LABELS[this.activeTool()];
  });
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
  private resizeFrame = 0;
  private imageCache = new Map<string, HTMLImageElement>();
  private clipboardElements: WhiteboardElement[] = [];
  private clipboardPasteCount = 0;
  private historyPast: WhiteboardPage[][] = [];
  private historyFuture: WhiteboardPage[][] = [];
  private laserTimeout?: number;
  private captureStreamActive = false;
  private activeCaptureStream: MediaStream | null = null;
  private pdfWorkerConfigured = false;
  private pdfJsModule: PdfJsModule | null = null;
  private mathPopoverDrag: MathPopoverDragState | null = null;

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
    this.closeMathTools();
    this.stopMediaCapture();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame) {
      window.cancelAnimationFrame(this.resizeFrame);
    }
    if (this.laserTimeout) {
      window.clearTimeout(this.laserTimeout);
    }
    this.imageCache.clear();
  }

  captureMediaStream(fps = 15): MediaStream | null {
    const canvas = this.whiteboardCanvas?.nativeElement;
    const captureStream = canvas?.captureStream;
    if (!canvas || typeof captureStream !== 'function') {
      return null;
    }
    try {
      this.captureStreamActive = true;
      this.render();
      const stream = captureStream.call(canvas, fps);
      if (!stream.getVideoTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        this.captureStreamActive = false;
        this.activeCaptureStream = null;
        this.render();
        return null;
      }
      this.activeCaptureStream = stream;
      stream.getVideoTracks()[0]?.addEventListener(
        'ended',
        () => {
          if (this.activeCaptureStream === stream) {
            this.captureStreamActive = false;
            this.activeCaptureStream = null;
            this.render();
          }
        },
        { once: true }
      );
      this.requestCaptureFrame(stream);
      return stream;
    } catch {
      this.captureStreamActive = false;
      this.activeCaptureStream = null;
      this.render();
      return null;
    }
  }

  stopMediaCapture(): void {
    const stream = this.activeCaptureStream;
    if (!this.captureStreamActive && !stream) {
      return;
    }
    this.captureStreamActive = false;
    this.activeCaptureStream = null;
    stream?.getTracks().forEach((track) => {
      if (track.readyState !== 'ended') {
        track.stop();
      }
    });
    this.render();
  }

  requestCaptureFrame(stream?: MediaStream | null): void {
    const targetStream = stream === undefined ? this.activeCaptureStream : stream;
    for (const track of targetStream?.getVideoTracks() ?? []) {
      const requestFrame = (track as MediaStreamTrack & { requestFrame?: () => void }).requestFrame;
      if (typeof requestFrame === 'function') {
        requestFrame.call(track);
      }
    }
  }

  @HostListener('window:keydown', ['$event'])
  protected handleKeyboardShortcut(event: KeyboardEvent): void {
    const editableTarget = this.isEditableShortcutTarget(event.target);

    if (editableTarget) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.mathPopoverOpen()) {
        this.closeMathTools();
        return;
      }
      this.cancelKeyboardState();
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
      return;
    }

    if (!this.readOnly() && event.key.startsWith('Arrow') && this.selectedElementIds().length) {
      event.preventDefault();
      const distance = event.shiftKey ? 10 : 1;
      const delta = this.arrowKeyDelta(event.key, distance);
      this.nudgeSelected(delta.x, delta.y);
    }
  }

  @HostListener('window:resize')
  @HostListener('window:orientationchange')
  protected scheduleViewportResize(): void {
    if (this.resizeFrame) {
      window.cancelAnimationFrame(this.resizeFrame);
    }
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = 0;
      this.resizeWhiteboard();
      this.clampMathPopoverToViewport();
    });
  }

  @HostListener('window:pointermove', ['$event'])
  protected dragMathPopover(event: PointerEvent): void {
    const drag = this.mathPopoverDrag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    event.preventDefault();
    this.mathPopoverPosition.set(
      this.clampMathPopoverPosition(
        {
          x: event.clientX - drag.offsetX,
          y: event.clientY - drag.offsetY
        },
        drag.width,
        drag.height
      )
    );
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  protected stopDraggingMathPopover(event: PointerEvent): void {
    if (this.mathPopoverDrag?.pointerId === event.pointerId) {
      this.mathPopoverDrag = null;
    }
  }

  currentPageId(): string {
    return this.activePageId();
  }

  exportBoardState(): WhiteboardMemorySnapshot {
    this.persistActivePageView();
    return {
      schemaVersion: 1,
      activePageId: this.activePageId(),
      pages: this.pages().map((page, index): WhiteboardMemoryPage => ({
        id: page.id,
        title: page.title,
        tags: page.tags ?? [],
        order: index,
        template: page.template ?? DEFAULT_TEMPLATE_ID,
        view: { ...(page.view ?? DEFAULT_PAGE_VIEW) },
        background: page.background ? (structuredClone(page.background) as unknown as Record<string, unknown>) : null,
        elements: page.elements.map((element) => structuredClone(element) as unknown as Record<string, unknown>)
      }))
    };
  }

  importBoardState(snapshot: WhiteboardMemorySnapshot): void {
    if (!snapshot?.pages?.length) {
      return;
    }
    const pages = snapshot.pages.map((page, index): WhiteboardPage => ({
      id: page.id || this.createElementId(),
      title: page.title || `Board ${index + 1}`,
      tags: this.normalizePageTags(page.tags),
      template: this.normalizeTemplateId(page.template),
      view: this.normalizePageView(page.view),
      background: this.normalizePageBackground(page.background),
      elements: Array.isArray(page.elements) ? page.elements.map((element) => structuredClone(element) as unknown as WhiteboardElement) : []
    }));
    this.pages.set(pages);
    this.activePageId.set(snapshot.activePageId && pages.some((page) => page.id === snapshot.activePageId) ? snapshot.activePageId : pages[0]!.id);
    this.historyPast = [];
    this.historyFuture = [];
    this.ensureActivePage();
    this.applyPageView(this.activePage());
    this.selectedElementIds.set([]);
    this.pruneImageCache();
    this.render();
  }

  protected canUseTool(tool: WhiteboardTool): boolean {
    if (tool === 'pan') {
      return true;
    }
    if (this.readOnly()) {
      return false;
    }
    const allowedTools = this.allowedTools();
    return !allowedTools || allowedTools.includes(tool);
  }

  applyCommand(command: WhiteboardCommand): void {
    if (!this.context) {
      this.pendingCommands.push(command);
      return;
    }
    const pageId = command.pageId ?? this.activePageId();
    if (command.pageId && !this.pages().some((page) => page.id === pageId)) {
      const page: WhiteboardPage = { ...this.createPage('Shared page'), id: pageId };
      this.pages.update((pages) => [...pages, page]);
      this.activePageId.set(pageId);
      this.applyPageView(page);
    }
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

  snapshotCommands(): WhiteboardCommand[] {
    const pageId = this.activePageId();
    return [
      { type: 'clear', pageId },
      ...this.activePage().elements.map((element) => ({
        type: 'upsert' as const,
        element: this.cloneElement(element),
        pageId
      }))
    ];
  }

  elementRefs(): WhiteboardElementRef[] {
    return this.pages().flatMap((page) => page.elements.map((element) => ({ pageId: page.id, elementId: element.id })));
  }

  removeElementsByRefs(refs: readonly WhiteboardElementRef[]): number {
    if (this.readOnly() || !refs.length) {
      return 0;
    }

    const exactRefs = new Set(refs.filter((ref) => ref.elementId && ref.pageId).map((ref) => `${ref.pageId}:${ref.elementId}`));
    const globalRefs = new Set(refs.filter((ref) => ref.elementId && !ref.pageId).map((ref) => ref.elementId));
    const deleteCommands: WhiteboardDeleteCommand[] = [];
    const nextPages = this.pages().map((page) => {
      const nextElements = page.elements.filter((element) => {
        const shouldRemove = exactRefs.has(`${page.id}:${element.id}`) || globalRefs.has(element.id);
        if (shouldRemove) {
          deleteCommands.push({ type: 'delete', elementId: element.id, pageId: page.id });
        }
        return !shouldRemove;
      });
      return nextElements.length === page.elements.length ? page : { ...page, elements: nextElements };
    });

    if (!deleteCommands.length) {
      return 0;
    }

    this.pushHistory();
    this.pages.set(nextPages);
    this.selectedElementIds.update((ids) => ids.filter((id) => !deleteCommands.some((command) => command.elementId === id)));
    this.pruneImageCache();
    this.render();
    for (const command of deleteCommands) {
      this.commandCommitted.emit(command);
    }
    return deleteCommands.length;
  }

  exportImage(): string {
    return this.renderPageImage(this.activePageId(), 'image/png');
  }

  protected selectTool(tool: WhiteboardTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeTool.set(tool);
    if (!this.isShapeTool(tool)) {
      this.shapeMenuOpen.set(false);
    }
    if (!this.isGeometryTool(tool)) {
      this.geometryMenuOpen.set(false);
    }
    if (!this.isDiagramTool(tool)) {
      this.diagramMenuOpen.set(false);
    }
  }

  protected toggleShapeMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.shapeMenuOpen.update((open) => !open);
  }

  protected selectShapeTool(tool: WhiteboardShapeTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeShapeTool.set(tool);
    this.activeTool.set(tool);
    this.shapeMenuOpen.set(false);
  }

  protected toggleGeometryMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.shapeMenuOpen.set(false);
    this.diagramMenuOpen.set(false);
    this.geometryMenuOpen.update((open) => !open);
  }

  protected selectGeometryTool(tool: WhiteboardGeometryTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeGeometryTool.set(tool);
    this.activeTool.set(tool);
    this.geometryMenuOpen.set(false);
  }

  protected toggleDiagramMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.shapeMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.diagramMenuOpen.update((open) => !open);
  }

  protected selectDiagramTool(tool: WhiteboardDiagramTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeDiagramTool.set(tool);
    this.activeTool.set(tool);
    this.diagramMenuOpen.set(false);
  }

  protected selectColor(color: string): void {
    if (this.readOnly()) {
      return;
    }
    const normalizedColor = this.normalizeColor(color);
    this.strokeColor.set(normalizedColor);
    this.rememberColor(normalizedColor);
    this.colorMenuOpen.set(false);
    this.applyStrokeToSelection(normalizedColor);
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
    if (this.readOnly() || !this.canUseTool('select')) {
      return;
    }
    event.stopPropagation();
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.update((open) => !open);
  }

  protected selectFillColor(color: string): void {
    if (this.readOnly() || !this.canUseTool('select')) {
      return;
    }
    const normalizedColor = this.normalizeColor(color);
    this.fillColor.set(normalizedColor);
    this.rememberColor(normalizedColor);
    this.fillEnabled.set(true);
    this.fillColorMenuOpen.set(false);
    this.applyFillToSelection(normalizedColor);
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

  protected openMathTools(tab: MathToolsTab = 'equation'): void {
    if (this.readOnly()) {
      return;
    }
    if (tab === 'equation') {
      this.loadSelectedEquationIntoMathPopover();
    }
    this.activeMathTab.set(tab);
    this.menuOpen.set(false);
    this.shapeMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.diagramMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.brushMenuOpen.set(false);
    this.mathPopoverOpen.set(true);
    this.clampMathPopoverToViewport();
    if (tab === 'equation') {
      window.setTimeout(() => this.mathEquationInput?.nativeElement.focus());
    }
  }

  protected closeMathTools(): void {
    this.mathPopoverDrag = null;
    this.mathPopoverOpen.set(false);
  }

  protected selectMathTab(tab: MathToolsTab): void {
    this.activeMathTab.set(tab);
    if (tab === 'equation') {
      window.setTimeout(() => this.mathEquationInput?.nativeElement.focus());
    }
  }

  protected startMathPopoverDrag(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return;
    }
    const popover = (event.currentTarget as HTMLElement | null)?.closest('.math-tools-popover') as HTMLElement | null;
    if (!popover) {
      return;
    }
    event.preventDefault();
    const bounds = popover.getBoundingClientRect();
    this.mathPopoverDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height
    };
  }

  protected updateMathEquationDraft(event: Event): void {
    const inputElement = event.target as HTMLTextAreaElement;
    this.mathEquationDraft.set(inputElement.value);
  }

  protected setMathEquationFontSize(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.mathEquationFontSize.set(Number(inputElement.value));
  }

  protected setMathEquationAlignment(alignment: WhiteboardTextAlignment): void {
    this.mathEquationAlignment.set(alignment);
  }

  protected setMathEquationColor(color: string): void {
    if (this.readOnly()) {
      return;
    }
    const normalizedColor = this.normalizeColor(color);
    this.strokeColor.set(normalizedColor);
    this.rememberColor(normalizedColor);
    this.applyStrokeToSelection(normalizedColor);
  }

  protected insertMathSnippetIntoPopover(snippet: string): void {
    const input = this.mathEquationInput?.nativeElement;
    const currentValue = this.mathEquationDraft();
    const start = input?.selectionStart ?? currentValue.length;
    const end = input?.selectionEnd ?? start;
    const nextValue = `${currentValue.slice(0, start)}${snippet}${currentValue.slice(end)}`;
    const nextCursor = this.cursorAfterSnippet(snippet, start);
    this.mathEquationDraft.set(nextValue);
    window.setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  protected insertEquationFromPopover(): void {
    if (!this.canUseTool('equation')) {
      return;
    }
    const raw = this.mathEquationDraft().trim();
    if (!raw || this.mathEquationError()) {
      this.mathEquationInput?.nativeElement.focus();
      return;
    }
    this.fontSize.set(this.mathEquationFontSize());
    const selectedEquation = this.singleSelectedEquation();
    const selectedText = selectedEquation ? null : this.singleSelectedText();
    const selectedElement = selectedEquation ?? selectedText;
    const selectedBounds = selectedElement ? this.boundsForElement(selectedElement) : null;
    const position = selectedElement?.position ?? this.defaultInsertPoint(320, 112);
    const draft: TextDraft = {
      x: position.x,
      y: position.y,
      value: raw,
      mode: 'equation',
      elementId: selectedElement?.id,
      width: selectedEquation?.width ?? Math.max(320, selectedBounds?.width ?? 0),
      height: selectedEquation?.height ?? Math.max(112, selectedBounds?.height ?? 0),
      align: this.mathEquationAlignment()
    };
    if (selectedElement) {
      this.strokeColor.set(selectedElement.color);
      this.fillEnabled.set(!!selectedElement.fillColor);
      if (selectedElement.fillColor) {
        this.fillColor.set(selectedElement.fillColor);
      }
    }
    const element = this.createEquationElement(draft, raw);
    this.pushHistory();
    if (selectedElement) {
      this.elements = this.elements.map((item) => (item.id === selectedElement.id ? element : item));
      this.setSelection([selectedElement.id]);
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
      this.render();
    } else {
      this.addElement(element);
    }
    this.activeTool.set('select');
  }

  protected applyMathTemplate(template: WhiteboardTemplateId): void {
    this.selectTemplate(template);
  }

  protected insertBoardTemplate(kind: WhiteboardDiagramTool): void {
    if (!this.canUseTool(kind)) {
      return;
    }
    const position = this.defaultInsertPoint(360, 240);
    this.pushHistory();
    const element = this.createDiagramElement(kind, position);
    this.addElement(element);
    this.activeTool.set('select');
    this.setSelection([element.id]);
  }

  protected openGraphFromMathTools(): void {
    if (!this.canUseTool('graph')) {
      return;
    }
    const position = this.defaultInsertPoint(460, 320);
    this.activeTool.set('graph');
    this.graphDraft.set(this.createGraphDraft(position));
  }

  protected selectGeometryToolFromMathTools(tool: WhiteboardGeometryTool): void {
    this.selectGeometryTool(tool);
  }

  protected toggleFill(): void {
    if (this.readOnly() || !this.canUseTool('select')) {
      return;
    }
    const nextEnabled = !this.fillEnabled();
    this.fillEnabled.set(nextEnabled);
    this.applyFillToSelection(nextEnabled ? this.fillColor() : null);
  }

  protected toggleSnapToGrid(): void {
    this.snapToGrid.update((enabled) => !enabled);
    this.snapIndicator.set(null);
  }

  protected toggleSnapToPoints(): void {
    this.snapToPoints.update((enabled) => !enabled);
    this.snapIndicator.set(null);
  }

  protected setAngleSnapDegrees(event: Event): void {
    const selectElement = event.target as HTMLSelectElement;
    this.angleSnapDegrees.set(Number(selectElement.value));
  }

  protected toggleMeasurements(): void {
    this.showMeasurements.update((show) => !show);
  }

  protected selectTemplateFromEvent(event: Event): void {
    const selectElement = event.target as HTMLSelectElement;
    this.selectTemplate(selectElement.value as WhiteboardTemplateId);
  }

  protected selectTemplate(template: WhiteboardTemplateId): void {
    if (!this.canManagePages() || !this.templateOptions.some((option) => option.id === template) || template === this.activeTemplate()) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, template } : page)));
    this.render();
    this.stateChanged.emit();
  }

  protected setStrokeWidth(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.strokeWidth.set(Number(inputElement.value));
  }

  protected setFontSizeFromEvent(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.fontSize.set(Number(inputElement.value));
  }

  protected selectBrushSize(size: number): void {
    if (!this.canUseTool('pen')) {
      return;
    }
    this.strokeWidth.set(size);
    this.activeTool.set('pen');
  }

  protected selectEraserMode(mode: WhiteboardEraserMode): void {
    if (!this.canUseTool('eraser')) {
      return;
    }
    this.eraserMode.set(mode);
    this.activeTool.set('eraser');
  }

  protected selectEraserSize(size: number): void {
    if (!this.canUseTool('eraser')) {
      return;
    }
    this.eraserSize.set(size);
    this.activeTool.set('eraser');
  }

  protected setEraserSize(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.selectEraserSize(Number(inputElement.value));
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
    this.persistActivePageView();
    this.render();
  }

  protected undo(): void {
    const previous = this.historyPast.pop();
    if (!previous) {
      return;
    }
    this.historyFuture.push(this.clonePages(this.pages()));
    this.pages.set(previous);
    this.ensureActivePage();
    this.applyPageView(this.activePage());
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.pruneImageCache();
    this.render();
    this.stateChanged.emit();
  }

  protected redo(): void {
    const next = this.historyFuture.pop();
    if (!next) {
      return;
    }
    this.historyPast.push(this.clonePages(this.pages()));
    this.pages.set(next);
    this.ensureActivePage();
    this.applyPageView(this.activePage());
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.pruneImageCache();
    this.render();
    this.stateChanged.emit();
  }

  protected addPage(): void {
    if (!this.canManagePages()) {
      return;
    }
    this.pushHistory();
    const page = this.createPage(`Board ${this.pages().length + 1}`, this.activeTemplate());
    this.pages.update((pages) => [...pages, page]);
    this.activePageId.set(page.id);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
    this.stateChanged.emit();
  }

  protected addPageBefore(): void {
    this.insertBlankPageRelativeToActive('before');
  }

  protected addPageAfter(): void {
    this.insertBlankPageRelativeToActive('after');
  }

  protected selectPage(pageId: string): void {
    if (pageId === this.activePageId()) {
      return;
    }
    this.persistActivePageView();
    const page = this.pages().find((item) => item.id === pageId);
    if (!page) {
      return;
    }
    this.activePageId.set(pageId);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
  }

  protected removeActivePage(): void {
    if (!this.canManagePages() || this.pages().length <= 1) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    const activeIndex = this.pages().findIndex((page) => page.id === activePageId);
    const nextPages = this.pages().filter((page) => page.id !== activePageId);
    const nextPage = nextPages[Math.min(Math.max(activeIndex, 0), nextPages.length - 1)]!;
    this.pages.set(nextPages);
    this.activePageId.set(nextPage.id);
    this.applyPageView(nextPage);
    this.selectedElementIds.set([]);
    this.pruneImageCache();
    this.render();
    this.stateChanged.emit();
  }

  protected duplicateActivePage(): void {
    if (!this.canManagePages()) {
      return;
    }
    this.pushHistory();
    const activePage = this.activePage();
    const duplicate: WhiteboardPage = {
      ...this.clonePage(activePage),
      id: this.createElementId(),
      title: this.uniquePageTitle(`${activePage.title} copy`),
      elements: this.cloneElementsForPageDuplicate(activePage.elements)
    };
    const activeIndex = this.pages().findIndex((page) => page.id === activePage.id);
    this.pages.update((pages) => [
      ...pages.slice(0, activeIndex + 1),
      duplicate,
      ...pages.slice(activeIndex + 1)
    ]);
    this.activePageId.set(duplicate.id);
    this.applyPageView(duplicate);
    this.selectedElementIds.set([]);
    this.render();
    this.stateChanged.emit();
  }

  protected renameActivePage(event: Event): void {
    if (!this.canManagePages()) {
      return;
    }
    const inputElement = event.target as HTMLInputElement;
    const title = inputElement.value.trim() || this.activePage().title;
    inputElement.value = title;
    if (title === this.activePage().title) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, title } : page)));
    this.stateChanged.emit();
  }

  protected setPageSearchQuery(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.pageSearchQuery.set(inputElement.value);
  }

  protected updateActivePageTags(event: Event): void {
    if (!this.canManagePages()) {
      return;
    }
    const inputElement = event.target as HTMLInputElement;
    const tags = this.normalizePageTags(inputElement.value);
    inputElement.value = tags.join(', ');
    const currentTags = this.activePage().tags ?? [];
    if (tags.length === currentTags.length && tags.every((tag, index) => tag === currentTags[index])) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, tags } : page)));
    this.stateChanged.emit();
  }

  protected requestEndSession(): void {
    this.endSession.emit();
  }

  protected clearWhiteboard(): void {
    if (!this.canClearBoard()) {
      return;
    }
    this.pushHistory();
    this.elements = [];
    this.previewElement = null;
    this.selectedElementIds.set([]);
    this.pruneImageCache();
    this.render();
    this.commandCommitted.emit({ type: 'clear', pageId: this.activePageId() });
  }

  protected triggerFileImport(): void {
    if (!this.canImportAssets() || this.assetImporting()) {
      return;
    }
    this.assetImportMode.set('element');
    this.assetImportStatus.set(null);
    this.fileInput?.nativeElement.click();
  }

  protected triggerBackgroundImport(): void {
    if (!this.canImportAssets() || this.assetImporting()) {
      return;
    }
    this.assetImportMode.set('background');
    this.assetImportStatus.set(null);
    this.fileInput?.nativeElement.click();
  }

  protected triggerPdfPageImport(): void {
    if (!this.canImportAssets() || this.assetImporting()) {
      return;
    }
    this.assetImportMode.set('pdf-pages');
    this.assetImportStatus.set(null);
    this.fileInput?.nativeElement.click();
  }

  protected triggerSlideImageImport(): void {
    if (!this.canImportAssets() || this.assetImporting()) {
      return;
    }
    this.assetImportMode.set('slide-pages');
    this.assetImportStatus.set(null);
    this.fileInput?.nativeElement.click();
  }

  protected importFile(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    const files = Array.from(inputElement.files ?? []);
    inputElement.value = '';
    if (!files.length || !this.canImportAssets() || this.assetImporting()) {
      return;
    }
    const mode = this.assetImportMode();
    if (mode === 'slide-pages') {
      void this.importSlideImageFiles(files);
      return;
    }
    void this.importAssetFile(files[0]!, mode);
  }

  protected resetPageBackground(): void {
    if (!this.canImportAssets() || !this.activePage().background) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, background: null } : page)));
    this.assetImportStatus.set({ type: 'success', message: 'Page background removed.' });
    this.pruneImageCache();
    this.render();
  }

  protected fitAssetToPage(): void {
    if (!this.canImportAssets()) {
      return;
    }
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const selectedImage = this.selectedElements().find((element): element is WhiteboardFileElement => element.type === 'file' && element.kind === 'image');
    if (selectedImage) {
      const image = this.resolveImage(selectedImage.dataUrl);
      const naturalWidth = image?.naturalWidth || selectedImage.width;
      const naturalHeight = image?.naturalHeight || selectedImage.height;
      const rect = this.fitRect(naturalWidth, naturalHeight, canvas.clientWidth, canvas.clientHeight, 'contain');
      this.pushHistory();
      const nextElement: WhiteboardFileElement = { ...selectedImage, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height };
      this.elements = this.elements.map((element) => (element.id === selectedImage.id ? nextElement : element));
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(nextElement), pageId: this.activePageId() });
      this.assetImportStatus.set({ type: 'success', message: 'Selected image fit to the page.' });
      this.render();
      return;
    }
    const background = this.activePage().background;
    if (!background) {
      this.assetImportStatus.set({ type: 'info', message: 'Select an image or add a page background first.' });
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) =>
      pages.map((page) => (page.id === activePageId ? { ...page, background: { ...background, fit: 'contain' } } : page))
    );
    this.assetImportStatus.set({ type: 'success', message: 'Page background fit to canvas.' });
    this.render();
  }

  protected exportPng(): void {
    if (!this.canExportBoard()) {
      return;
    }
    const dataUrl = this.exportImage();
    this.downloadDataUrl(dataUrl, `${this.safeFileName(this.activePage().title)}.png`);
  }

  protected exportPdf(): void {
    if (!this.canExportBoard()) {
      return;
    }
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const jpegDataUrl = this.renderPageImage(this.activePageId(), 'image/jpeg', 0.92);
    const blob = this.createPdfBlob([{ jpegDataUrl, width: canvas.width, height: canvas.height }]);
    this.downloadBlob(blob, `${this.safeFileName(this.activePage().title)}.pdf`);
  }

  protected exportAllPagesPdf(): void {
    if (!this.canExportBoard()) {
      return;
    }
    const exported = this.exportAllPagesPdfBlob();
    if (!exported) {
      return;
    }
    this.downloadBlob(exported.blob, exported.fileName);
  }

  protected exportSelectedPagesPdf(): void {
    if (!this.canExportSelectedPages()) {
      return;
    }
    const exported = this.exportSelectedPagesPdfBlob(this.selectedExportPageIds(), `${this.title()} selected pages`);
    if (!exported) {
      return;
    }
    this.downloadBlob(exported.blob, exported.fileName);
  }

  protected toggleExportPage(pageId: string): void {
    this.selectedExportPageIds.update((pageIds) =>
      pageIds.includes(pageId) ? pageIds.filter((id) => id !== pageId) : [...pageIds, pageId]
    );
  }

  protected selectAllExportPages(): void {
    this.selectedExportPageIds.set(this.pages().map((page) => page.id));
  }

  protected clearExportPageSelection(): void {
    this.selectedExportPageIds.set([]);
  }

  exportAllPagesPdfBlob(fileBaseName = this.title()): { blob: Blob; fileName: string } | null {
    return this.exportSelectedPagesPdfBlob(this.pages().map((page) => page.id), `${fileBaseName}-pages`);
  }

  exportSelectedPagesPdfBlob(pageIds: string[], fileBaseName = this.title()): { blob: Blob; fileName: string } | null {
    if (!this.canExportBoard()) {
      return null;
    }
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return null;
    }
    const selectedIds = new Set(pageIds);
    const selectedPages = this.pages().filter((page) => selectedIds.has(page.id));
    if (!selectedPages.length) {
      return null;
    }
    const pages = selectedPages.map((page) => ({
      jpegDataUrl: this.renderPageImage(page.id, 'image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height
    }));
    return {
      blob: this.createPdfBlob(pages),
      fileName: `${this.safeFileName(fileBaseName) || 'whiteboard'}${fileBaseName.endsWith('-pages') ? '' : '-pages'}.pdf`
    };
  }

  protected updateTextDraft(event: Event): void {
    const inputElement = event.target as HTMLTextAreaElement;
    this.textDraft.update((draft) => (draft ? { ...draft, value: inputElement.value } : draft));
  }

  protected commitTextDraft(): void {
    const draft = this.textDraft();
    const text = draft?.value.trim();
    if (!draft || !text) {
      this.textDraft.set(null);
      return;
    }
    const element = draft.mode === 'equation' ? this.createEquationElement(draft, text) : this.createTextElement(draft, text);
    this.pushHistory();
    if (draft.elementId) {
      this.elements = this.elements.map((item) => (item.id === draft.elementId ? element : item));
      this.selectedElementIds.set([draft.elementId]);
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
      this.render();
    } else {
      this.addElement(element);
    }
    this.textDraft.set(null);
  }

  protected cancelTextDraft(): void {
    this.textDraft.set(null);
  }

  protected insertMathSnippet(snippet: string): void {
    const draft = this.textDraft();
    if (!draft) {
      return;
    }
    const editor = this.textEditor?.nativeElement;
    const start = editor?.selectionStart ?? draft.value.length;
    const end = editor?.selectionEnd ?? start;
    const nextValue = `${draft.value.slice(0, start)}${snippet}${draft.value.slice(end)}`;
    this.textDraft.set({ ...draft, value: nextValue });
    window.setTimeout(() => {
      editor?.focus();
      const nextCursor = this.cursorAfterSnippet(snippet, start);
      editor?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  protected canEditSelectedTextBlock(): boolean {
    return !!this.editableSelectedElement();
  }

  protected canConvertSelectedTextToEquation(): boolean {
    return !!this.singleSelectedText();
  }

  protected canAlignTextSelection(): boolean {
    return this.selectedElements().some((element) => element.type === 'text' || element.type === 'equation');
  }

  protected canAlignSelectedObjects(): boolean {
    return this.selectedElementIds().length > 1;
  }

  protected canDistributeSelectedVertically(): boolean {
    return this.selectedElementIds().length > 2;
  }

  protected canEditSelectedGraph(): boolean {
    return !!this.editableSelectedGraph();
  }

  protected editSelectedTextBlock(): void {
    const element = this.editableSelectedElement();
    if (!element) {
      return;
    }
    this.openTextDraftForElement(element);
    this.closeContextMenu();
  }

  protected convertSelectedTextToEquation(): void {
    const text = this.singleSelectedText();
    if (!text) {
      return;
    }
    const raw = text.text.trim();
    this.mathEquationDraft.set(raw);
    this.mathEquationFontSize.set(text.fontSize);
    this.mathEquationAlignment.set(text.align ?? 'left');
    this.strokeColor.set(text.color);
    if (text.fillColor) {
      this.fillColor.set(text.fillColor);
      this.fillEnabled.set(true);
    } else {
      this.fillEnabled.set(false);
    }
    const error = this.validateMathSource(raw);
    if (!raw || error) {
      this.openMathTools('equation');
      return;
    }
    const bounds = this.boundsForElement(text);
    const draft: TextDraft = {
      x: text.position.x,
      y: text.position.y,
      value: raw,
      mode: 'equation',
      elementId: text.id,
      width: Math.max(320, bounds.width),
      height: Math.max(112, bounds.height),
      align: text.align ?? 'left'
    };
    const equation = this.createEquationElement(draft, raw);
    this.pushHistory();
    this.elements = this.elements.map((element) => (element.id === text.id ? equation : element));
    this.setSelection([text.id]);
    this.closeContextMenu();
    this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(equation), pageId: this.activePageId() });
    this.render();
  }

  protected setSelectedTextAlignment(alignment: WhiteboardTextAlignment): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    const changed: WhiteboardElement[] = [];
    const nextElements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id) || (element.type !== 'text' && element.type !== 'equation')) {
        return element;
      }
      if ((element.align ?? 'left') === alignment) {
        return element;
      }
      const next = { ...element, align: alignment } as WhiteboardElement;
      changed.push(next);
      return next;
    });
    if (!changed.length) {
      this.closeContextMenu();
      return;
    }
    this.pushHistory();
    this.elements = nextElements;
    this.closeContextMenu();
    for (const element of changed) {
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
    }
    this.render();
  }

  protected alignSelectedObjects(alignment: WhiteboardTextAlignment): void {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length < 2) {
      return;
    }
    const groupBounds = this.boundsForElements(selectedIds);
    this.pushHistory();
    this.elements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id)) {
        return element;
      }
      const bounds = this.boundsForElement(element);
      const targetX =
        alignment === 'left'
          ? groupBounds.x
          : alignment === 'center'
            ? groupBounds.x + groupBounds.width / 2 - bounds.width / 2
            : groupBounds.x + groupBounds.width - bounds.width;
      return this.translateElement(this.cloneElement(element), targetX - bounds.x, 0);
    });
    this.closeContextMenu();
    this.emitSelectionUpserts();
    this.render();
  }

  protected distributeSelectedVertically(): void {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length < 3) {
      return;
    }
    const selected = this.elements
      .filter((element) => selectedIds.includes(element.id))
      .map((element) => ({ element, bounds: this.boundsForElement(element) }))
      .sort((a, b) => a.bounds.y - b.bounds.y);
    const groupBounds = this.boundsForElements(selectedIds);
    const totalHeight = selected.reduce((sum, item) => sum + item.bounds.height, 0);
    const gap = Math.max(0, (groupBounds.height - totalHeight) / Math.max(1, selected.length - 1));
    const targetTops = new Map<string, number>();
    let cursorY = groupBounds.y;
    for (const item of selected) {
      targetTops.set(item.element.id, cursorY);
      cursorY += item.bounds.height + gap;
    }
    this.pushHistory();
    this.elements = this.elements.map((element) => {
      if (!selectedIds.includes(element.id)) {
        return element;
      }
      const bounds = this.boundsForElement(element);
      const targetY = targetTops.get(element.id) ?? bounds.y;
      return this.translateElement(this.cloneElement(element), 0, targetY - bounds.y);
    });
    this.closeContextMenu();
    this.emitSelectionUpserts();
    this.render();
  }

  protected editSelectedGraph(): void {
    const element = this.editableSelectedGraph();
    if (!element) {
      return;
    }
    this.openGraphDraftForElement(element);
    this.closeContextMenu();
  }

  protected updateGraphDraftField(field: keyof GraphDraft, event: Event): void {
    const inputElement = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.graphDraft.update((draft) => (draft ? { ...draft, [field]: inputElement.value, error: null } : draft));
  }

  protected updateGraphDraftNumber(field: keyof GraphDraft, event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    const value = Number(inputElement.value);
    this.graphDraft.update((draft) => (draft ? { ...draft, [field]: value, error: null } : draft));
  }

  protected updateGraphDraftBoolean(field: keyof GraphDraft, event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.graphDraft.update((draft) => (draft ? { ...draft, [field]: inputElement.checked, error: null } : draft));
  }

  protected setGraphCurveColor(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.graphDraft.update((draft) => (draft ? { ...draft, curveColor: inputElement.value, error: null } : draft));
  }

  protected commitGraphDraft(): void {
    const draft = this.graphDraft();
    if (!draft) {
      return;
    }
    const validation = this.validateGraphDraft(draft);
    if (validation) {
      this.graphDraft.set({ ...draft, error: validation });
      return;
    }
    const element = this.createGraphElement(draft);
    this.pushHistory();
    if (draft.elementId) {
      this.elements = this.elements.map((item) => (item.id === draft.elementId ? element : item));
      this.selectedElementIds.set([draft.elementId]);
      this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: this.activePageId() });
      this.render();
    } else {
      this.addElement(element);
    }
    this.graphDraft.set(null);
    this.activeTool.set('select');
  }

  protected cancelGraphDraft(): void {
    this.graphDraft.set(null);
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
    this.graphDraft.set(null);
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

  private arrowKeyDelta(key: string, distance: number): WhiteboardPoint {
    if (key === 'ArrowLeft') {
      return { x: -distance, y: 0 };
    }
    if (key === 'ArrowRight') {
      return { x: distance, y: 0 };
    }
    if (key === 'ArrowUp') {
      return { x: 0, y: -distance };
    }
    return { x: 0, y: distance };
  }

  private nudgeSelected(deltaX: number, deltaY: number): void {
    if (!this.selectedElementIds().length || (!deltaX && !deltaY)) {
      return;
    }
    this.pushHistory();
    this.moveSelected(deltaX, deltaY);
    this.emitSelectionUpserts();
    this.render();
  }

  private clampMathPopoverToViewport(): void {
    if (!this.mathPopoverOpen()) {
      return;
    }
    const bounds = this.mathToolsPopover?.nativeElement.getBoundingClientRect();
    this.mathPopoverPosition.update((position) => this.clampMathPopoverPosition(position, bounds?.width, bounds?.height));
  }

  private clampMathPopoverPosition(position: MathPopoverPosition, width = 380, height = 540): MathPopoverPosition {
    if (typeof window === 'undefined') {
      return position;
    }
    const margin = 12;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);
    return {
      x: Math.min(Math.max(position.x, margin), maxX),
      y: Math.min(Math.max(position.y, margin), maxY)
    };
  }

  private defaultInsertPoint(width: number, height: number): WhiteboardPoint {
    const canvas = this.whiteboardCanvas?.nativeElement;
    const surface = this.whiteboardSurface?.nativeElement;
    const viewWidth = surface?.clientWidth ?? canvas?.clientWidth ?? 900;
    const viewHeight = surface?.clientHeight ?? canvas?.clientHeight ?? 620;
    const canvasWidth = canvas?.clientWidth ?? viewWidth;
    const canvasHeight = canvas?.clientHeight ?? viewHeight;
    const x = (viewWidth / 2 - this.panX()) / this.zoom() - width / 2;
    const y = (viewHeight / 2 - this.panY()) / this.zoom() - height / 2;
    return this.snapPoint({
      x: Math.min(Math.max(16, x), Math.max(16, canvasWidth - width - 16)),
      y: Math.min(Math.max(16, y), Math.max(16, canvasHeight - height - 16))
    });
  }

  private renderEquationPreview(raw: string, fontSize: number, color: string): string | null {
    if (typeof document === 'undefined') {
      return null;
    }
    if (this.validateMathSource(raw)) {
      return null;
    }
    const value = raw.trim() || '\\frac{a}{b}';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    const padding = this.equationPadding(fontSize);
    const metrics = this.drawMathBlock(context, value, padding, padding, fontSize, false);
    const width = Math.min(720, Math.ceil(Math.max(180, metrics.width + padding * 2)));
    const height = Math.min(280, Math.ceil(Math.max(fontSize * 2.25, metrics.height + padding * 2)));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.scale(dpr, dpr);
    context.fillStyle = color;
    context.strokeStyle = color;
    this.drawMathBlock(context, value, padding, padding, fontSize, true);
    return canvas.toDataURL('image/png');
  }

  private loadSelectedEquationIntoMathPopover(): void {
    const equation = this.singleSelectedEquation();
    const text = equation ? null : this.singleSelectedText();
    if (!equation && !text) {
      return;
    }
    const source = equation ?? text!;
    this.mathEquationDraft.set(equation?.raw ?? text!.text);
    this.mathEquationFontSize.set(source.fontSize);
    this.mathEquationAlignment.set(source.align ?? 'left');
    this.strokeColor.set(source.color);
    if (source.fillColor) {
      this.fillColor.set(source.fillColor);
      this.fillEnabled.set(true);
    } else {
      this.fillEnabled.set(false);
    }
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
    if (!selectedIds.length || (!this.canUseTool('select') && !this.canUseTool('eraser'))) {
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
    if (!this.canUseTool(this.activeTool())) {
      return;
    }

    const point = this.getCanvasPoint(event);
    this.emitCursor(point);

    if (event.detail >= 2) {
      const element = this.hitTest(point);
      if (element && this.isEditableTextBlock(element)) {
        this.setSelectionForElement(element, false);
        this.openTextDraftForElement(element);
        this.render();
        return;
      }
      if (element?.type === 'graph') {
        this.setSelectionForElement(element, false);
        this.openGraphDraftForElement(element);
        this.render();
        return;
      }
    }

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
      this.eraserCursor.set(point);
      this.eraseAlongPath(point, point);
      this.render();
      return;
    }

    if (this.activeTool() === 'laser') {
      this.showLaser(point);
      return;
    }

    if (this.activeTool() === 'text' || this.activeTool() === 'equation') {
      this.textDraft.set({
        x: point.x,
        y: point.y,
        value: this.activeTool() === 'equation' ? '\\frac{a}{b}' : '',
        mode: this.activeTool() === 'equation' ? 'equation' : 'text',
        width: this.activeTool() === 'equation' ? 320 : 240,
        height: this.activeTool() === 'equation' ? 112 : 56,
        align: this.activeTool() === 'equation' ? this.mathEquationAlignment() : 'left'
      });
      setTimeout(() => this.textEditor?.nativeElement.focus());
      return;
    }

    if (this.activeTool() === 'graph') {
      this.graphDraft.set(this.createGraphDraft(point));
      return;
    }

    if (this.isDiagramTool(this.activeTool())) {
      this.pushHistory();
      this.addElement(this.createDiagramElement(this.activeTool() as WhiteboardDiagramTool, this.snapPoint(point)));
      return;
    }

    if (this.isGeometryTool(this.activeTool())) {
      const start = this.snapPoint(point);
      if (this.activeTool() === 'point') {
        this.pushHistory();
        this.addElement(this.createGeometryElement('point', start, start));
        return;
      }
      this.drawing = true;
      this.lastPoint = start;
      this.shapeStart = start;
      this.previewElement = this.createGeometryElement(this.activeTool() as WhiteboardGeometryTool, start, start);
      this.render();
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

    if (this.activeTool() === 'eraser') {
      this.eraserCursor.set(point);
      if (!this.erasing) {
        this.render();
      }
    }

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
    const nextPoint = this.snapPoint(point, this.shapeStart ?? undefined);
    if (this.previewElement.type === 'shape' && this.shapeStart) {
      this.previewElement = this.createShapeElement(this.shapeStart, nextPoint, this.previewElement.shape);
    } else if (this.previewElement.type === 'geometry' && this.shapeStart) {
      this.previewElement = this.createGeometryElement(this.previewElement.kind, this.shapeStart, nextPoint, this.previewElement.id);
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
    if (this.panStart) {
      this.persistActivePageView();
    }
    this.panStart = null;
    this.erasing = false;
    this.eraseHistoryPushed = false;
    this.eraserCursor.set(null);
    this.selectionMarquee.set(null);
    this.snapIndicator.set(null);
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
    this.drawBoardTemplate(canvas);
    this.drawPageBackground(canvas);
    for (const element of this.elements) {
      this.drawElement(element);
    }
    if (this.previewElement) {
      this.drawElement(this.previewElement);
    }
    if (includeOverlays) {
      this.drawAlignmentGuides();
      this.drawSnapIndicator();
      this.drawSelection();
      this.drawSelectionMarquee();
      this.drawEraserCursor();
    }
    if (this.captureStreamActive) {
      this.requestCaptureFrame(this.activeCaptureStream);
    }
  }

  private drawBoardTemplate(canvas: HTMLCanvasElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    context.save();
    context.fillStyle = this.cssVariable('--canvas-bg', '#f8fbff');
    context.fillRect(0, 0, width, height);

    const template = this.activeTemplate();
    if (template === 'ruled') {
      this.drawRuledTemplate(context, width, height);
    } else if (template === 'grid') {
      this.drawGridTemplate(context, width, height);
    } else if (template === 'graph') {
      this.drawGraphPaperTemplate(context, width, height);
    } else if (template === 'coordinate') {
      this.drawCoordinateTemplate(context, width, height);
    } else if (template === 'number-line') {
      this.drawNumberLineTemplate(context, width, height);
    } else if (template === 'geometry') {
      this.drawGeometryTemplate(context, width, height);
    } else if (template === 'table') {
      this.drawTableTemplate(context, width, height);
    } else if (template === 'fraction') {
      this.drawFractionBarsTemplate(context, width, height);
    }

    context.restore();
  }

  private drawPageBackground(canvas: HTMLCanvasElement): void {
    const context = this.context;
    const background = this.activePage().background;
    if (!context || !background) {
      return;
    }
    const image = this.resolveImage(background.dataUrl);
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight) {
      return;
    }
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const rect = this.fitRect(background.naturalWidth || image.naturalWidth, background.naturalHeight || image.naturalHeight, width, height, background.fit);
    context.save();
    context.fillStyle = 'rgba(255, 255, 255, 0.94)';
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }

  private fitRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number, fit: WhiteboardAssetFit): ElementBounds {
    if (fit === 'stretch') {
      return { x: 0, y: 0, width: targetWidth, height: targetHeight };
    }
    const safeSourceWidth = Math.max(1, sourceWidth);
    const safeSourceHeight = Math.max(1, sourceHeight);
    const scale = fit === 'cover'
      ? Math.max(targetWidth / safeSourceWidth, targetHeight / safeSourceHeight)
      : Math.min(targetWidth / safeSourceWidth, targetHeight / safeSourceHeight);
    const width = safeSourceWidth * scale;
    const height = safeSourceHeight * scale;
    return {
      x: (targetWidth - width) / 2,
      y: (targetHeight - height) / 2,
      width,
      height
    };
  }

  private drawRuledTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    const lineColor = this.cssVariable('--canvas-grid', '#d7e3f4');
    const marginColor = this.cssVariable('--canvas-template-accent', '#F26076');
    context.strokeStyle = lineColor;
    context.lineWidth = 1;
    context.beginPath();
    for (let y = 56; y <= height; y += 32) {
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
    }
    context.stroke();
    context.strokeStyle = marginColor;
    context.globalAlpha = 0.38;
    context.beginPath();
    context.moveTo(72.5, 0);
    context.lineTo(72.5, height);
    context.stroke();
    context.globalAlpha = 1;
  }

  private drawGridTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawGridLines(context, width, height, GRID_SIZE, this.cssVariable('--canvas-grid', '#d7e3f4'), 1);
  }

  private drawGraphPaperTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawGridLines(context, width, height, 8, this.cssVariable('--canvas-grid-soft', '#edf3fb'), 0.6);
    this.drawGridLines(context, width, height, GRID_SIZE, this.cssVariable('--canvas-grid-strong', '#c8d8eb'), 1);
  }

  private drawCoordinateTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawGraphPaperTemplate(context, width, height);
    const centerX = Math.round(width / 2) + 0.5;
    const centerY = Math.round(height / 2) + 0.5;
    const axisColor = this.cssVariable('--canvas-axis', '#458B73');

    context.save();
    context.strokeStyle = axisColor;
    context.fillStyle = axisColor;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(20, centerY);
    context.lineTo(width - 20, centerY);
    context.moveTo(centerX, height - 20);
    context.lineTo(centerX, 20);
    context.stroke();
    this.drawArrowHead(context, { x: width - 20, y: centerY }, 0, 9);
    this.drawArrowHead(context, { x: centerX, y: 20 }, -Math.PI / 2, 9);

    context.lineWidth = 1;
    context.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let x = centerX + GRID_SIZE; x < width - 24; x += GRID_SIZE) {
      const value = Math.round((x - centerX) / GRID_SIZE);
      this.drawAxisTick(context, x, centerY, true);
      if (value % 2 === 0) {
        context.fillText(String(value), x, centerY + 8);
      }
    }
    for (let x = centerX - GRID_SIZE; x > 24; x -= GRID_SIZE) {
      const value = Math.round((x - centerX) / GRID_SIZE);
      this.drawAxisTick(context, x, centerY, true);
      if (value % 2 === 0) {
        context.fillText(String(value), x, centerY + 8);
      }
    }
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let y = centerY - GRID_SIZE; y > 24; y -= GRID_SIZE) {
      const value = Math.round((centerY - y) / GRID_SIZE);
      this.drawAxisTick(context, centerX, y, false);
      if (value % 2 === 0) {
        context.fillText(String(value), centerX - 8, y);
      }
    }
    for (let y = centerY + GRID_SIZE; y < height - 24; y += GRID_SIZE) {
      const value = Math.round((centerY - y) / GRID_SIZE);
      this.drawAxisTick(context, centerX, y, false);
      if (value % 2 === 0) {
        context.fillText(String(value), centerX - 8, y);
      }
    }
    context.fillText('0', centerX - 8, centerY + 12);
    context.restore();
  }

  private drawNumberLineTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    const centerX = Math.round(width / 2) + 0.5;
    const centerY = Math.round(height / 2) + 0.5;
    const axisColor = this.cssVariable('--canvas-axis', '#458B73');
    this.drawRuledTemplate(context, width, height);
    context.save();
    context.strokeStyle = axisColor;
    context.fillStyle = axisColor;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(28, centerY);
    context.lineTo(width - 28, centerY);
    context.stroke();
    this.drawArrowHead(context, { x: width - 28, y: centerY }, 0, 9);
    this.drawArrowHead(context, { x: 28, y: centerY }, Math.PI, 9);
    context.font = '12px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let x = centerX; x < width - 32; x += 48) {
      const value = Math.round((x - centerX) / 48);
      this.drawAxisTick(context, x, centerY, true, 18);
      context.fillText(String(value), x, centerY + 16);
    }
    for (let x = centerX - 48; x > 32; x -= 48) {
      const value = Math.round((x - centerX) / 48);
      this.drawAxisTick(context, x, centerY, true, 18);
      context.fillText(String(value), x, centerY + 16);
    }
    context.restore();
  }

  private drawGeometryTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawGridLines(context, width, height, 32, this.cssVariable('--canvas-grid', '#d7e3f4'), 1);
    context.save();
    context.strokeStyle = this.cssVariable('--canvas-geometry-line', '#dfe8f4');
    context.lineWidth = 1;
    context.beginPath();
    for (let x = -height; x < width; x += 64) {
      context.moveTo(x, 0);
      context.lineTo(x + height, height);
    }
    for (let x = 0; x < width + height; x += 64) {
      context.moveTo(x, 0);
      context.lineTo(x - height, height);
    }
    context.stroke();
    context.restore();
  }

  private drawTableTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    const left = 44.5;
    const top = 44.5;
    const right = Math.max(left + 240, width - 44.5);
    const bottom = Math.max(top + 180, height - 44.5);
    const columnCount = 5;
    const rowCount = 8;
    const columnWidth = (right - left) / columnCount;
    const rowHeight = (bottom - top) / rowCount;
    context.save();
    context.fillStyle = this.cssVariable('--canvas-table-header', 'rgba(255, 209, 80, 0.18)');
    context.fillRect(left, top, right - left, rowHeight);
    context.strokeStyle = this.cssVariable('--canvas-grid-strong', '#c8d8eb');
    context.lineWidth = 1;
    context.beginPath();
    for (let index = 0; index <= columnCount; index += 1) {
      const x = left + index * columnWidth;
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    for (let index = 0; index <= rowCount; index += 1) {
      const y = top + index * rowHeight;
      context.moveTo(left, y);
      context.lineTo(right, y);
    }
    context.stroke();
    context.restore();
  }

  private drawFractionBarsTemplate(context: CanvasRenderingContext2D, width: number, height: number): void {
    const denominators = [2, 3, 4, 5, 8];
    const barWidth = Math.min(560, Math.max(260, width - 180));
    const left = Math.max(76, (width - barWidth) / 2);
    const startY = Math.max(56, height / 2 - 150);
    context.save();
    context.font = '12px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.strokeStyle = this.cssVariable('--canvas-grid-strong', '#c8d8eb');
    context.fillStyle = this.cssVariable('--canvas-template-muted', '#6d7890');
    for (let row = 0; row < denominators.length; row += 1) {
      const denominator = denominators[row]!;
      const y = startY + row * 54;
      context.fillText(`1/${denominator}`, left - 12, y + 16);
      context.strokeRect(left, y, barWidth, 32);
      for (let index = 1; index < denominator; index += 1) {
        const x = left + (barWidth / denominator) * index;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x, y + 32);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawGridLines(context: CanvasRenderingContext2D, width: number, height: number, size: number, color: string, lineWidth: number): void {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.beginPath();
    for (let x = 0; x <= width; x += size) {
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += size) {
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
    }
    context.stroke();
    context.restore();
  }

  private drawAxisTick(context: CanvasRenderingContext2D, x: number, y: number, horizontalAxis: boolean, size = 10): void {
    context.beginPath();
    if (horizontalAxis) {
      context.moveTo(x, y - size / 2);
      context.lineTo(x, y + size / 2);
    } else {
      context.moveTo(x - size / 2, y);
      context.lineTo(x + size / 2, y);
    }
    context.stroke();
  }

  private drawArrowHead(context: CanvasRenderingContext2D, point: WhiteboardPoint, angle: number, size: number): void {
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x - size * Math.cos(angle - Math.PI / 6), point.y - size * Math.sin(angle - Math.PI / 6));
    context.lineTo(point.x - size * Math.cos(angle + Math.PI / 6), point.y - size * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  private async importAssetFile(file: File, mode: AssetImportMode): Promise<void> {
    this.assetImporting.set(true);
    try {
      if (mode === 'pdf-pages') {
        await this.handlePdfPageImport(file);
        return;
      }
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        if (mode === 'background') {
          this.assetImportStatus.set({ type: 'error', message: 'Use Import PDF pages to render a PDF into annotatable pages.' });
          return;
        }
        this.validatePdfFile(file);
        const dataUrl = await this.readFileAsDataUrl(file);
        this.createDocumentElement(file, dataUrl);
        this.assetImportStatus.set({ type: 'info', message: 'PDF added as a movable reference card. Use Import PDF pages for annotatable backgrounds.' });
        return;
      }

      this.validateImageFile(file);
      const dataUrl = await this.readFileAsDataUrl(file);
      const image = await this.decodeImage(dataUrl);
      this.imageCache.set(dataUrl, image);
      if (mode === 'background') {
        this.createPageBackground(file, dataUrl, image);
      } else {
        this.createFileElement(file, dataUrl, image);
      }
    } catch (error) {
      this.assetImportStatus.set({
        type: 'error',
        message: error instanceof Error ? error.message : 'Asset import failed.'
      });
    } finally {
      this.assetImportMode.set('element');
      this.assetImporting.set(false);
    }
  }

  private async importSlideImageFiles(files: File[]): Promise<void> {
    this.assetImporting.set(true);
    try {
      const slideFiles = files.slice(0, MAX_SLIDE_IMAGE_IMPORT_PAGES);
      if (files.length > MAX_SLIDE_IMAGE_IMPORT_PAGES) {
        throw new Error(`Import up to ${MAX_SLIDE_IMAGE_IMPORT_PAGES} slide images at a time.`);
      }
      const pages: WhiteboardPage[] = [];
      for (let index = 0; index < slideFiles.length; index += 1) {
        const file = slideFiles[index]!;
        this.assetImportStatus.set({ type: 'info', message: `Importing slide ${index + 1} of ${slideFiles.length}...` });
        this.validateImageFile(file);
        const dataUrl = await this.readFileAsDataUrl(file);
        const image = await this.decodeImage(dataUrl);
        this.imageCache.set(dataUrl, image);
        pages.push(this.createImportedImagePage(file, dataUrl, image, 'slide-image', index + 1));
      }
      this.insertImportedPages(pages);
      this.assetImportStatus.set({
        type: 'success',
        message: `Imported ${pages.length} slide image${pages.length === 1 ? '' : 's'} as annotatable pages.`
      });
    } catch (error) {
      this.assetImportStatus.set({
        type: 'error',
        message: error instanceof Error ? error.message : 'Slide image import failed.'
      });
    } finally {
      this.assetImportMode.set('element');
      this.assetImporting.set(false);
    }
  }

  private validateImageFile(file: File): void {
    if (!IMAGE_ASSET_MIME_TYPES.has(file.type)) {
      throw new Error('Use a PNG, JPG, JPEG, or WebP image.');
    }
    if (file.size > MAX_IMAGE_ASSET_BYTES) {
      throw new Error('Image is too large. Use an image under 12 MB.');
    }
  }

  private validatePdfFile(file: File): void {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      throw new Error('Use a PDF file.');
    }
    if (file.size > MAX_PDF_ASSET_BYTES) {
      throw new Error('PDF is too large. Use a file under 25 MB.');
    }
  }

  private async handlePdfPageImport(file: File): Promise<void> {
    this.validatePdfFile(file);
    const pdfjs = await this.loadPdfJs();
    this.assetImportStatus.set({ type: 'info', message: `Reading ${file.name}...` });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: true,
      stopAtErrors: true
    });
    let pdf: PDFDocumentProxy | null = null;
    try {
      pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_PDF_IMPORT_PAGES) {
        throw new Error(`PDF has ${pdf.numPages} pages. Import up to ${MAX_PDF_IMPORT_PAGES} pages at a time.`);
      }
      const pages: WhiteboardPage[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        this.assetImportStatus.set({ type: 'info', message: `Rendering page ${pageNumber} of ${pdf.numPages}...` });
        const renderedPage = await this.renderPdfPageBackground(pdf, file.name, pageNumber);
        pages.push(renderedPage);
      }
      this.insertImportedPages(pages);
      this.assetImportStatus.set({ type: 'success', message: `Imported ${pdf.numPages} PDF page${pdf.numPages === 1 ? '' : 's'} from ${file.name}.` });
    } catch (error) {
      throw new Error(this.pdfImportErrorMessage(error));
    } finally {
      if (pdf) {
        await pdf.cleanup();
      }
      try {
        await loadingTask.destroy();
      } catch {
        // pdf.js may already have destroyed the task after a failed load.
      }
    }
  }

  private async loadPdfJs(): Promise<PdfJsModule> {
    const pdfjs = this.pdfJsModule ?? (await import('pdfjs-dist'));
    this.pdfJsModule = pdfjs;
    this.configurePdfWorker(pdfjs);
    return pdfjs;
  }

  private configurePdfWorker(pdfjs: PdfJsModule): void {
    if (this.pdfWorkerConfigured) {
      return;
    }
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    this.pdfWorkerConfigured = true;
  }

  private async renderPdfPageBackground(pdf: PDFDocumentProxy, fileName: string, pageNumber: number): Promise<WhiteboardPage> {
    let page: PDFPageProxy | null = null;
    const canvas = document.createElement('canvas');
    try {
      page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(0.5, PDF_RENDER_MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height)));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Browser canvas rendering is unavailable.');
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      const preview = new Image();
      preview.src = dataUrl;
      this.imageCache.set(dataUrl, preview);
      const pageTitle = `${this.safeFileName(fileName.replace(/\.pdf$/i, '')) || 'PDF'} p${pageNumber}`;
      const whiteboardPage = this.createPage(pageTitle, 'blank');
      whiteboardPage.background = {
        kind: 'image',
        sourceType: 'pdf-page',
        fileName: `${fileName} · page ${pageNumber}`,
        mimeType: 'application/pdf',
        pageNumber,
        dataUrl,
        naturalWidth: canvas.width,
        naturalHeight: canvas.height,
        fit: 'contain',
        importedAt: new Date().toISOString()
      };
      return whiteboardPage;
    } finally {
      page?.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  private createImportedImagePage(
    file: File,
    dataUrl: string,
    image: HTMLImageElement,
    sourceType: AssetPageSourceType,
    pageNumber?: number
  ): WhiteboardPage {
    const titlePrefix = sourceType === 'slide-image' ? 'Slide' : 'Image';
    const cleanName = this.safeFileName(file.name.replace(/\.[^.]+$/, '')) || titlePrefix;
    const page = this.createPage(pageNumber ? `${cleanName} ${pageNumber}` : cleanName, 'blank');
    page.background = {
      kind: 'image',
      sourceType,
      fileName: file.name,
      mimeType: file.type || 'image',
      ...(pageNumber ? { pageNumber } : {}),
      dataUrl,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      fit: 'contain',
      importedAt: new Date().toISOString()
    };
    return page;
  }

  private insertImportedPages(importedPages: WhiteboardPage[]): void {
    if (!importedPages.length) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    const activeIndex = this.pages().findIndex((page) => page.id === activePageId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : this.pages().length;
    this.pages.update((pages) => [...pages.slice(0, insertIndex), ...importedPages, ...pages.slice(insertIndex)]);
    this.activePageId.set(importedPages[0]!.id);
    this.applyPageView(importedPages[0]!);
    this.selectedElementIds.set([]);
    this.render();
  }

  private insertBlankPageRelativeToActive(position: 'before' | 'after'): void {
    if (!this.canManagePages()) {
      return;
    }
    this.pushHistory();
    const activePageId = this.activePageId();
    const activeIndex = this.pages().findIndex((page) => page.id === activePageId);
    const insertIndex = activeIndex >= 0 ? activeIndex + (position === 'after' ? 1 : 0) : this.pages().length;
    const page = this.createPage(`Board ${this.pages().length + 1}`, 'blank');
    this.pages.update((pages) => [...pages.slice(0, insertIndex), page, ...pages.slice(insertIndex)]);
    this.activePageId.set(page.id);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
  }

  private pdfImportErrorMessage(error: unknown): string {
    const candidate = error as { name?: string; message?: string };
    const name = candidate?.name ?? '';
    const message = candidate?.message ?? '';
    if (name.includes('Password') || /password|encrypted/i.test(message)) {
      return 'This PDF is encrypted or password-protected. Use an unlocked PDF.';
    }
    if (name.includes('InvalidPDF') || /invalid|corrupt|malformed/i.test(message)) {
      return 'This PDF appears to be corrupt or unsupported.';
    }
    if (/worker/i.test(message)) {
      return 'PDF renderer could not start. Try reloading the page and importing again.';
    }
    return message || 'PDF import failed.';
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
  }

  private async decodeImage(dataUrl: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.decoding = 'async';
    image.src = dataUrl;
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch {
        throw new Error('Could not decode that image.');
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not decode that image.'));
      });
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error('Image has no readable dimensions.');
    }
    return image;
  }

  private createPageBackground(file: File, dataUrl: string, image: HTMLImageElement): void {
    const targetPageId = this.activePageId();
    this.pushHistory();
    const background: WhiteboardPageBackground = {
      kind: 'image',
      sourceType: 'image',
      fileName: file.name,
      mimeType: file.type || 'image',
      dataUrl,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      fit: 'contain',
      importedAt: new Date().toISOString()
    };
    this.pages.update((pages) => pages.map((page) => (page.id === targetPageId ? { ...page, background } : page)));
    this.assetImportStatus.set({ type: 'success', message: `${file.name} set as page background.` });
    this.render();
  }

  private createFileElement(file: File, dataUrl: string, image: HTMLImageElement): void {
    const targetPageId = this.activePageId();
    this.pushHistory();
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
    this.addElement(element, targetPageId);
    this.assetImportStatus.set({ type: 'success', message: `${file.name} added as a movable image.` });
  }

  private createDocumentElement(file: File, dataUrl: string): void {
    const targetPageId = this.activePageId();
    this.pushHistory();
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
    } else if (element.type === 'equation') {
      this.drawEquation(element);
    } else if (element.type === 'graph') {
      this.drawGraph(element);
    } else if (element.type === 'geometry') {
      this.drawGeometry(element);
    } else if (element.type === 'diagram') {
      this.drawDiagram(element);
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
    const bounds = this.boundsForElement(element);
    if (element.fillColor) {
      this.drawRoundedBlock(context, bounds, element.fillColor);
    }
    context.fillStyle = element.color;
    context.font = `${element.fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    context.textBaseline = 'top';
    const lineHeight = element.fontSize * 1.25;
    for (const [index, line] of element.text.split('\n').entries()) {
      const lineWidth = context.measureText(line).width;
      const x = this.alignedInlineX(lineWidth, bounds.x, bounds.width, element.align ?? 'left');
      context.fillText(line, x, element.position.y + index * lineHeight);
    }
    context.restore();
  }

  private drawEquation(element: WhiteboardEquationElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    context.save();
    if (element.fillColor) {
      this.drawRoundedBlock(context, this.boundsForElement(element), element.fillColor);
    }
    context.fillStyle = element.color;
    context.strokeStyle = element.color;
    const padding = this.equationPadding(element.fontSize);
    const metrics = this.drawMathBlock(context, element.raw, 0, 0, element.fontSize, false);
    const contentX = element.position.x + padding;
    const contentWidth = Math.max(1, element.width - padding * 2);
    const x = this.alignedInlineX(metrics.width, contentX, contentWidth, element.align ?? 'left');
    this.drawMathBlock(context, element.raw, x, element.position.y + padding, element.fontSize, true);
    context.restore();
  }

  private drawGraph(element: WhiteboardGraphElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const bounds = this.boundsForElement(element);
    const viewport = this.graphViewport(element);
    context.save();
    context.fillStyle = this.cssVariable('--canvas-bg', '#f8fbff');
    context.strokeStyle = this.cssVariable('--canvas-grid-strong', '#c8d8eb');
    context.lineWidth = 1.4;
    this.roundedRectPath(context, bounds.x, bounds.y, bounds.width, bounds.height, 10);
    context.fill();
    context.stroke();

    if (element.title?.trim()) {
      context.fillStyle = this.cssVariable('--text', '#071c41');
      context.font = '700 14px Inter, ui-sans-serif, system-ui, sans-serif';
      context.textBaseline = 'top';
      context.fillText(element.title.slice(0, 48), bounds.x + 14, bounds.y + 10);
    }

    context.save();
    context.beginPath();
    context.rect(viewport.left, viewport.top, viewport.width, viewport.height);
    context.clip();
    context.fillStyle = this.cssVariable('--canvas-graph-bg', '#ffffff');
    context.fillRect(viewport.left, viewport.top, viewport.width, viewport.height);
    if (element.showGrid) {
      this.drawGraphGrid(context, viewport, element.tickStep ?? null);
    }
    if (element.showAxes) {
      this.drawGraphAxes(context, viewport, element.showTicks, element.tickStep ?? null);
    }

    const parsedFunctions = element.functions.map((fn) => ({ fn, parser: this.parseGraphExpression(fn.expression) }));
    const graphErrors = parsedFunctions.flatMap((item) => (item.parser.error ? [item.parser.error] : []));
    const primary = parsedFunctions.find((item) => !item.parser.error);
    const inequalityError = element.inequality?.trim() ? this.drawGraphInequality(context, viewport, element.inequality, '#FFD150') : null;
    if (inequalityError) {
      graphErrors.push(inequalityError);
    }
    this.drawGraphHistogram(context, viewport, element);
    if (primary && this.hasFiniteNumber(element.helpers?.shadeFrom) && this.hasFiniteNumber(element.helpers?.shadeTo)) {
      this.drawGraphArea(context, viewport, primary.parser.evaluate, Number(element.helpers?.shadeFrom), Number(element.helpers?.shadeTo), primary.fn.color);
    }
    for (const { fn, parser } of parsedFunctions) {
      if (parser.error) {
        continue;
      }
      this.drawGraphFunction(context, viewport, parser.evaluate, fn.color, fn.width);
    }
    if (primary) {
      const helpers = element.helpers;
      if (this.hasFiniteNumber(helpers?.pointX)) {
        this.drawGraphPoint(context, viewport, primary.parser.evaluate, Number(helpers?.pointX), primary.fn.color);
      }
      if (this.hasFiniteNumber(helpers?.tangentX)) {
        this.drawGraphTangent(context, viewport, primary.parser.evaluate, Number(helpers?.tangentX), primary.fn.color);
      }
      if (helpers?.showIntercepts) {
        this.drawGraphIntercepts(context, viewport, primary.parser.evaluate, primary.fn.color);
      }
    }
    const parametricError = this.drawGraphParametric(context, viewport, element.parametric ?? null);
    const polarError = this.drawGraphPolar(context, viewport, element.polar ?? null);
    if (parametricError) {
      graphErrors.push(parametricError);
    }
    if (polarError) {
      graphErrors.push(polarError);
    }
    this.drawNormalCurve(context, viewport, element);
    this.drawScatterPoints(context, viewport, element);
    if (element.stats?.showRegression) {
      this.drawRegressionLine(context, viewport, element);
    }
    this.drawGraphLabels(context, viewport, element.labels ?? []);
    context.restore();

    context.strokeStyle = this.cssVariable('--canvas-grid-strong', '#c8d8eb');
    context.strokeRect(viewport.left, viewport.top, viewport.width, viewport.height);
    const error = graphErrors[0];
    if (error) {
      context.fillStyle = this.cssVariable('--danger', '#dc2626');
      context.font = '700 12px Inter, ui-sans-serif, system-ui, sans-serif';
      context.textBaseline = 'bottom';
      context.fillText(error.slice(0, 72), bounds.x + 14, bounds.y + bounds.height - 10);
    }
    context.restore();
  }

  private drawGeometry(element: WhiteboardGeometryElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const { from, to } = element;
    const color = element.strokeColor;
    const radius = Math.max(1, this.distance(from, to));
    const midpoint = this.midpoint(from, to);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const measurement = element.showMeasurement ? this.formatDistance(this.distance(from, to)) : '';

    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(1, element.width);
    context.strokeStyle = color;
    context.fillStyle = color;
    if (element.dashed) {
      context.setLineDash([8, 6]);
    }

    if (element.kind === 'segment') {
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.setLineDash([]);
      this.drawGeometryEndpoint(context, from, color);
      this.drawGeometryEndpoint(context, to, color);
      if (measurement) {
        this.drawMeasurementLabel(context, measurement, midpoint.x, midpoint.y - 12, color);
      }
      context.restore();
      return;
    }

    if (element.kind === 'vector') {
      context.beginPath();
      this.buildArrowPath(context, from, to);
      context.stroke();
      context.setLineDash([]);
      this.drawGeometryEndpoint(context, from, color);
      const label = element.label ?? 'v';
      const deltaX = Math.round(to.x - from.x);
      const deltaY = Math.round(to.y - from.y);
      this.drawMeasurementLabel(context, element.showMeasurement ? `${label} = <${deltaX}, ${deltaY}>` : label, midpoint.x, midpoint.y - 14, color);
      context.restore();
      return;
    }

    if (element.kind === 'ruler') {
      this.drawRulerGeometry(context, element, from, to, color);
      context.restore();
      return;
    }

    if (element.kind === 'protractor') {
      this.drawProtractorGeometry(context, element, from, to, color);
      context.restore();
      return;
    }

    if (element.kind === 'polygon') {
      this.drawPolygonGeometry(context, element, from, to, color);
      context.restore();
      return;
    }

    if (element.kind === 'angle') {
      const armLength = Math.max(48, radius);
      const baseline = { x: from.x + armLength, y: from.y };
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(baseline.x, baseline.y);
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.setLineDash([]);
      const sweep = this.normalizeAngle(angle);
      const arcRadius = Math.min(72, Math.max(24, armLength * 0.34));
      context.beginPath();
      context.arc(from.x, from.y, arcRadius, 0, sweep, sweep < 0);
      context.stroke();
      this.drawGeometryEndpoint(context, from, color);
      this.drawMeasurementLabel(context, `${Math.round((Math.abs(sweep) * 180) / Math.PI)}°`, from.x + Math.cos(sweep / 2) * (arcRadius + 18), from.y + Math.sin(sweep / 2) * (arcRadius + 18), color);
      context.restore();
      return;
    }

    if (element.kind === 'circle') {
      if (element.fillColor) {
        context.globalAlpha = 0.2;
        context.fillStyle = element.fillColor;
        context.beginPath();
        context.arc(from.x, from.y, radius, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
      }
      context.beginPath();
      context.arc(from.x, from.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      this.drawGeometryEndpoint(context, from, color);
      this.drawGeometryEndpoint(context, to, color);
      if (measurement) {
        this.drawMeasurementLabel(context, `r=${measurement}`, midpoint.x, midpoint.y - 12, color);
      }
      context.restore();
      return;
    }

    if (element.kind === 'arc') {
      if (element.fillColor) {
        context.globalAlpha = 0.16;
        context.fillStyle = element.fillColor;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.arc(from.x, from.y, radius, 0, angle, angle < 0);
        context.closePath();
        context.fill();
        context.globalAlpha = 1;
      }
      context.beginPath();
      context.arc(from.x, from.y, radius, 0, angle, angle < 0);
      context.stroke();
      context.setLineDash([]);
      this.drawGeometryEndpoint(context, from, color);
      this.drawGeometryEndpoint(context, to, color);
      this.drawMeasurementLabel(context, `${Math.round((Math.abs(this.normalizeAngle(angle)) * 180) / Math.PI)}° arc`, from.x + Math.cos(angle / 2) * (radius + 18), from.y + Math.sin(angle / 2) * (radius + 18), color);
      context.restore();
      return;
    }

    if (element.kind === 'perpendicular') {
      const perpAngle = angle + Math.PI / 2;
      const helperLength = Math.max(42, radius * 0.38);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.moveTo(midpoint.x - Math.cos(perpAngle) * helperLength, midpoint.y - Math.sin(perpAngle) * helperLength);
      context.lineTo(midpoint.x + Math.cos(perpAngle) * helperLength, midpoint.y + Math.sin(perpAngle) * helperLength);
      context.stroke();
      context.setLineDash([]);
      this.drawMeasurementLabel(context, '90°', midpoint.x + 14, midpoint.y - 14, color);
      context.restore();
      return;
    }

    if (element.kind === 'parallel') {
      const offset = Math.max(22, Math.min(48, radius * 0.22));
      const normal = { x: -Math.sin(angle) * offset, y: Math.cos(angle) * offset };
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.moveTo(from.x + normal.x, from.y + normal.y);
      context.lineTo(to.x + normal.x, to.y + normal.y);
      context.stroke();
      context.setLineDash([]);
      this.drawMeasurementLabel(context, 'parallel', midpoint.x + normal.x, midpoint.y + normal.y - 12, color);
      context.restore();
      return;
    }

    if (element.kind === 'midpoint') {
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.setLineDash([]);
      this.drawGeometryEndpoint(context, from, color);
      this.drawGeometryEndpoint(context, to, color);
      this.drawMidpointMarker(context, midpoint, color);
      this.drawMeasurementLabel(context, 'midpoint', midpoint.x, midpoint.y - 16, color);
      context.restore();
      return;
    }

    this.drawGeometryEndpoint(context, from, color, 5);
    this.drawMeasurementLabel(context, element.label ?? 'P', from.x + 14, from.y - 12, color);
    context.restore();
  }

  private drawRulerGeometry(
    context: CanvasRenderingContext2D,
    element: WhiteboardGeometryElement,
    from: WhiteboardPoint,
    to: WhiteboardPoint,
    color: string
  ): void {
    const length = Math.max(80, this.distance(from, to));
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    context.save();
    context.translate(from.x, from.y);
    context.rotate(angle);
    context.setLineDash([]);
    this.roundedRectPath(context, 0, -18, length, 36, 6);
    context.fillStyle = element.fillColor ?? 'rgba(255, 209, 80, 0.22)';
    context.strokeStyle = color;
    context.globalAlpha = 0.88;
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
    context.font = '700 9px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const step = 16;
    for (let x = 0; x <= length; x += step) {
      const major = Math.round(x / step) % 4 === 0;
      context.beginPath();
      context.moveTo(x, 18);
      context.lineTo(x, major ? 1 : 9);
      context.stroke();
      if (major && x > 0) {
        context.fillText(String(Math.round(x)), x, -15);
      }
    }
    context.restore();
    if (element.showMeasurement) {
      const midpoint = this.midpoint(from, to);
      this.drawMeasurementLabel(context, this.formatDistance(length), midpoint.x, midpoint.y - 28, color);
    }
  }

  private drawProtractorGeometry(
    context: CanvasRenderingContext2D,
    element: WhiteboardGeometryElement,
    from: WhiteboardPoint,
    to: WhiteboardPoint,
    color: string
  ): void {
    const radius = Math.max(64, this.distance(from, to));
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    context.save();
    context.translate(from.x, from.y);
    context.rotate(angle);
    context.setLineDash([]);
    context.fillStyle = element.fillColor ?? 'rgba(255, 151, 96, 0.14)';
    context.strokeStyle = color;
    context.globalAlpha = 0.82;
    context.beginPath();
    context.moveTo(-radius, 0);
    context.arc(0, 0, radius, Math.PI, 0);
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
    context.beginPath();
    context.arc(0, 0, radius * 0.62, Math.PI, 0);
    context.stroke();
    context.font = '700 9px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let degree = 0; degree <= 180; degree += 5) {
      const theta = Math.PI - (degree * Math.PI) / 180;
      const major = degree % 30 === 0;
      const outer = radius;
      const inner = radius - (major ? 15 : 8);
      context.beginPath();
      context.moveTo(Math.cos(theta) * outer, Math.sin(theta) * outer);
      context.lineTo(Math.cos(theta) * inner, Math.sin(theta) * inner);
      context.stroke();
      if (major) {
        context.fillText(String(degree), Math.cos(theta) * (radius - 28), Math.sin(theta) * (radius - 28));
      }
    }
    context.restore();
    this.drawGeometryEndpoint(context, from, color, 4);
    this.drawGeometryEndpoint(context, to, color, 4);
  }

  private drawPolygonGeometry(
    context: CanvasRenderingContext2D,
    element: WhiteboardGeometryElement,
    from: WhiteboardPoint,
    to: WhiteboardPoint,
    color: string
  ): void {
    const vertices = this.regularPolygonVertices(from, to, 6);
    context.save();
    context.setLineDash([]);
    context.beginPath();
    vertices.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.closePath();
    if (element.fillColor) {
      context.globalAlpha = 0.22;
      context.fillStyle = element.fillColor;
      context.fill();
      context.globalAlpha = 1;
    }
    context.strokeStyle = color;
    context.stroke();
    for (const vertex of vertices) {
      this.drawGeometryEndpoint(context, vertex, color, 3.2);
    }
    if (element.showMeasurement) {
      this.drawMeasurementLabel(context, 'regular hexagon', from.x, from.y - this.distance(from, to) - 12, color);
    }
    context.restore();
  }

  private drawDiagram(element: WhiteboardDiagramElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const bounds = this.boundsForElement(element);
    const accent = element.strokeColor;
    const fill = element.fillColor ?? '#FFD150';
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(1, element.lineWidth);
    context.strokeStyle = accent;
    context.fillStyle = fill;

    if (element.kind === 'coordinate-axes') {
      this.drawCoordinateAxesDiagram(context, bounds, accent, fill);
      context.restore();
      return;
    }

    if (element.kind === 'number-line-template') {
      this.drawNumberLineDiagram(context, bounds, accent, fill);
      context.restore();
      return;
    }

    if (element.kind === 'table-layout') {
      this.drawTableLayoutDiagram(context, bounds, accent, fill);
      context.restore();
      return;
    }

    if (element.kind === 'fraction-bars') {
      this.drawFractionBarsDiagram(context, bounds, accent, fill);
      context.restore();
      return;
    }

    if (element.kind === 'venn') {
      const radius = Math.min(bounds.width, bounds.height) * 0.28;
      const left = { x: bounds.x + bounds.width * 0.42, y: bounds.y + bounds.height * 0.48 };
      const right = { x: bounds.x + bounds.width * 0.58, y: bounds.y + bounds.height * 0.48 };
      context.globalAlpha = 0.18;
      context.beginPath();
      context.arc(left.x, left.y, radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#F26076';
      context.beginPath();
      context.arc(right.x, right.y, radius, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = accent;
      context.beginPath();
      context.arc(left.x, left.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(right.x, right.y, radius, 0, Math.PI * 2);
      context.stroke();
      this.drawDiagramText(context, element.labels[0] ?? 'A', left.x - radius * 0.45, left.y, accent);
      this.drawDiagramText(context, element.labels[1] ?? 'B', right.x + radius * 0.45, right.y, accent);
      this.drawDiagramText(context, element.labels[2] ?? 'A ∩ B', bounds.x + bounds.width / 2, left.y + radius + 24, accent);
      context.restore();
      return;
    }

    if (element.kind === 'node-edge') {
      const nodes = [
        { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.32, label: element.labels[0] ?? 'A' },
        { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.28, label: element.labels[1] ?? 'B' },
        { x: bounds.x + bounds.width * 0.36, y: bounds.y + bounds.height * 0.7, label: element.labels[2] ?? 'C' },
        { x: bounds.x + bounds.width * 0.78, y: bounds.y + bounds.height * 0.68, label: element.labels[3] ?? 'D' }
      ];
      this.drawDiagramEdges(context, nodes, [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3]]);
      nodes.forEach((node) => this.drawDiagramNode(context, node, accent, fill));
      context.restore();
      return;
    }

    if (element.kind === 'tree' || element.kind === 'probability-tree') {
      const root = { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.2, label: element.labels[0] ?? 'Root' };
      const rowOne = [
        { x: bounds.x + bounds.width * 0.3, y: bounds.y + bounds.height * 0.48, label: element.labels[1] ?? 'A' },
        { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.48, label: element.labels[2] ?? 'B' }
      ];
      const rowTwo = [
        { x: bounds.x + bounds.width * 0.18, y: bounds.y + bounds.height * 0.76, label: element.labels[3] ?? (element.kind === 'probability-tree' ? 'A1' : 'A1') },
        { x: bounds.x + bounds.width * 0.42, y: bounds.y + bounds.height * 0.76, label: element.labels[4] ?? (element.kind === 'probability-tree' ? 'A2' : 'A2') },
        { x: bounds.x + bounds.width * 0.58, y: bounds.y + bounds.height * 0.76, label: element.labels[5] ?? (element.kind === 'probability-tree' ? 'B1' : 'B1') },
        { x: bounds.x + bounds.width * 0.82, y: bounds.y + bounds.height * 0.76, label: element.labels[6] ?? (element.kind === 'probability-tree' ? 'B2' : 'B2') }
      ];
      this.drawDiagramEdges(context, [root, ...rowOne, ...rowTwo], [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6]]);
      if (element.kind === 'probability-tree') {
        this.drawDiagramText(context, element.labels[7] ?? 'p', (root.x + rowOne[0]!.x) / 2 - 12, (root.y + rowOne[0]!.y) / 2, accent);
        this.drawDiagramText(context, element.labels[8] ?? '1-p', (root.x + rowOne[1]!.x) / 2 + 16, (root.y + rowOne[1]!.y) / 2, accent);
      }
      [root, ...rowOne, ...rowTwo].forEach((node) => this.drawDiagramNode(context, node, accent, fill));
      context.restore();
      return;
    }

    const boxes = [
      { x: bounds.x + bounds.width * 0.1, y: bounds.y + bounds.height * 0.35, width: bounds.width * 0.22, height: bounds.height * 0.24, label: element.labels[0] ?? 'Start' },
      { x: bounds.x + bounds.width * 0.39, y: bounds.y + bounds.height * 0.35, width: bounds.width * 0.22, height: bounds.height * 0.24, label: element.labels[1] ?? 'Step' },
      { x: bounds.x + bounds.width * 0.68, y: bounds.y + bounds.height * 0.35, width: bounds.width * 0.22, height: bounds.height * 0.24, label: element.labels[2] ?? 'Result' }
    ];
    for (const box of boxes) {
      this.roundedRectPath(context, box.x, box.y, box.width, box.height, 10);
      context.globalAlpha = 0.16;
      context.fill();
      context.globalAlpha = 1;
      context.stroke();
      this.drawDiagramText(context, box.label, box.x + box.width / 2, box.y + box.height / 2, accent);
    }
    this.drawDiagramArrow(context, { x: boxes[0]!.x + boxes[0]!.width, y: boxes[0]!.y + boxes[0]!.height / 2 }, { x: boxes[1]!.x, y: boxes[1]!.y + boxes[1]!.height / 2 }, accent);
    this.drawDiagramArrow(context, { x: boxes[1]!.x + boxes[1]!.width, y: boxes[1]!.y + boxes[1]!.height / 2 }, { x: boxes[2]!.x, y: boxes[2]!.y + boxes[2]!.height / 2 }, accent);
    context.restore();
  }

  private drawCoordinateAxesDiagram(context: CanvasRenderingContext2D, bounds: ElementBounds, accent: string, fill: string): void {
    const inset = Math.max(18, Math.min(34, bounds.width * 0.07));
    const left = bounds.x + inset;
    const right = bounds.x + bounds.width - inset;
    const top = bounds.y + inset;
    const bottom = bounds.y + bounds.height - inset;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const gridStep = Math.max(22, Math.min(38, bounds.width / 10));
    this.drawTemplateCard(context, bounds, fill, accent);
    context.save();
    context.strokeStyle = this.cssVariable('--canvas-grid', '#d7e3f4');
    context.lineWidth = 1;
    context.beginPath();
    for (let x = centerX; x <= right; x += gridStep) {
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    for (let x = centerX - gridStep; x >= left; x -= gridStep) {
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    for (let y = centerY; y <= bottom; y += gridStep) {
      context.moveTo(left, y);
      context.lineTo(right, y);
    }
    for (let y = centerY - gridStep; y >= top; y -= gridStep) {
      context.moveTo(left, y);
      context.lineTo(right, y);
    }
    context.stroke();
    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(left, centerY);
    context.lineTo(right, centerY);
    context.moveTo(centerX, bottom);
    context.lineTo(centerX, top);
    context.stroke();
    this.drawArrowHead(context, { x: right, y: centerY }, 0, 8);
    this.drawArrowHead(context, { x: centerX, y: top }, -Math.PI / 2, 8);
    context.lineWidth = 1;
    context.font = '700 11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let index = -4; index <= 4; index += 1) {
      if (index === 0) {
        continue;
      }
      const tickX = centerX + index * gridStep;
      if (tickX > left && tickX < right) {
        this.drawAxisTick(context, tickX, centerY, true, 10);
      }
      const tickY = centerY - index * gridStep;
      if (tickY > top && tickY < bottom) {
        this.drawAxisTick(context, centerX, tickY, false, 10);
      }
    }
    context.fillText('x', right - 8, centerY + 10);
    context.fillText('0', centerX - 12, centerY + 8);
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillText('y', centerX + 10, top + 8);
    context.restore();
  }

  private drawNumberLineDiagram(context: CanvasRenderingContext2D, bounds: ElementBounds, accent: string, fill: string): void {
    const left = bounds.x + Math.max(26, bounds.width * 0.08);
    const right = bounds.x + bounds.width - Math.max(26, bounds.width * 0.08);
    const centerY = bounds.y + bounds.height / 2;
    const step = (right - left) / 10;
    this.drawTemplateCard(context, bounds, fill, accent);
    context.save();
    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(left, centerY);
    context.lineTo(right, centerY);
    context.stroke();
    this.drawArrowHead(context, { x: right, y: centerY }, 0, 8);
    this.drawArrowHead(context, { x: left, y: centerY }, Math.PI, 8);
    context.font = '700 12px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let value = -5; value <= 5; value += 1) {
      const x = left + (value + 5) * step;
      this.drawAxisTick(context, x, centerY, true, value === 0 ? 20 : 14);
      context.fillText(String(value), x, centerY + 18);
    }
    context.restore();
  }

  private drawTableLayoutDiagram(context: CanvasRenderingContext2D, bounds: ElementBounds, accent: string, fill: string): void {
    const columns = 4;
    const rows = 5;
    const inset = 18;
    const left = bounds.x + inset;
    const top = bounds.y + inset;
    const width = bounds.width - inset * 2;
    const height = bounds.height - inset * 2;
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    this.drawTemplateCard(context, bounds, fill, accent);
    context.save();
    context.fillStyle = fill;
    context.globalAlpha = 0.18;
    context.fillRect(left, top, width, cellHeight);
    context.globalAlpha = 1;
    context.strokeStyle = accent;
    context.lineWidth = 1.4;
    context.beginPath();
    for (let column = 0; column <= columns; column += 1) {
      const x = left + column * cellWidth;
      context.moveTo(x, top);
      context.lineTo(x, top + height);
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = top + row * cellHeight;
      context.moveTo(left, y);
      context.lineTo(left + width, y);
    }
    context.stroke();
    context.fillStyle = accent;
    context.font = '700 11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let column = 0; column < columns; column += 1) {
      context.fillText(`Col ${column + 1}`, left + column * cellWidth + cellWidth / 2, top + cellHeight / 2);
    }
    context.restore();
  }

  private drawFractionBarsDiagram(context: CanvasRenderingContext2D, bounds: ElementBounds, accent: string, fill: string): void {
    const denominators = [2, 3, 4, 5, 8];
    const leftLabel = bounds.x + Math.max(34, bounds.width * 0.11);
    const barLeft = leftLabel + 18;
    const barRight = bounds.x + bounds.width - Math.max(24, bounds.width * 0.08);
    const rowGap = Math.max(28, (bounds.height - 48) / denominators.length);
    const barHeight = Math.max(16, Math.min(28, rowGap * 0.48));
    const startY = bounds.y + 28;
    this.drawTemplateCard(context, bounds, fill, accent);
    context.save();
    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 1.4;
    context.font = '700 11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    denominators.forEach((denominator, row) => {
      const y = startY + row * rowGap;
      const labelY = y + barHeight / 2;
      context.fillText(`1/${denominator}`, leftLabel, labelY);
      context.strokeRect(barLeft, y, barRight - barLeft, barHeight);
      context.save();
      context.globalAlpha = 0.14;
      context.fillStyle = fill;
      context.fillRect(barLeft, y, (barRight - barLeft) / denominator, barHeight);
      context.restore();
      for (let index = 1; index < denominator; index += 1) {
        const x = barLeft + ((barRight - barLeft) / denominator) * index;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x, y + barHeight);
        context.stroke();
      }
    });
    context.restore();
  }

  private drawTemplateCard(context: CanvasRenderingContext2D, bounds: ElementBounds, fill: string, accent: string): void {
    context.save();
    this.roundedRectPath(context, bounds.x, bounds.y, bounds.width, bounds.height, 12);
    context.fillStyle = this.cssVariable('--canvas-bg', '#f8fbff');
    context.fill();
    context.globalAlpha = 0.12;
    context.fillStyle = fill;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = accent;
    context.lineWidth = 1.4;
    context.stroke();
    context.restore();
  }

  private drawGeometryEndpoint(context: CanvasRenderingContext2D, point: WhiteboardPoint, color: string, radius = 3.8): void {
    context.save();
    context.fillStyle = color;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.6;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  private drawMidpointMarker(context: CanvasRenderingContext2D, point: WhiteboardPoint, color: string): void {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(point.x - 7, point.y - 7);
    context.lineTo(point.x + 7, point.y + 7);
    context.moveTo(point.x + 7, point.y - 7);
    context.lineTo(point.x - 7, point.y + 7);
    context.stroke();
    context.restore();
  }

  private drawMeasurementLabel(context: CanvasRenderingContext2D, label: string, x: number, y: number, color: string): void {
    const paddingX = 7;
    const paddingY = 4;
    context.save();
    context.font = '700 12px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const width = context.measureText(label).width + paddingX * 2;
    this.roundedRectPath(context, x - width / 2, y - 11, width, 22, 7);
    context.fillStyle = 'rgba(255, 255, 255, 0.88)';
    context.fill();
    context.strokeStyle = color;
    context.globalAlpha = 0.5;
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = color;
    context.fillText(label, x, y + paddingY * 0.1);
    context.restore();
  }

  private drawDiagramNode(context: CanvasRenderingContext2D, node: WhiteboardPoint & { label: string }, stroke: string, fill: string): void {
    context.save();
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.globalAlpha = 0.18;
    context.beginPath();
    context.arc(node.x, node.y, 24, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
    this.drawDiagramText(context, node.label, node.x, node.y, stroke);
    context.restore();
  }

  private drawDiagramEdges(context: CanvasRenderingContext2D, nodes: Array<WhiteboardPoint & { label: string }>, edges: Array<[number, number]>): void {
    context.save();
    context.beginPath();
    for (const [fromIndex, toIndex] of edges) {
      const from = nodes[fromIndex];
      const to = nodes[toIndex];
      if (!from || !to) {
        continue;
      }
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    context.stroke();
    context.restore();
  }

  private drawDiagramArrow(context: CanvasRenderingContext2D, from: WhiteboardPoint, to: WhiteboardPoint, color: string): void {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    this.drawArrowHead(context, to, angle, 8);
    context.restore();
  }

  private drawDiagramText(context: CanvasRenderingContext2D, label: string, x: number, y: number, color: string): void {
    context.save();
    context.fillStyle = color;
    context.font = '800 12px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label.slice(0, 18), x, y);
    context.restore();
  }

  private normalizeAngle(angle: number): number {
    let next = angle;
    while (next <= -Math.PI) {
      next += Math.PI * 2;
    }
    while (next > Math.PI) {
      next -= Math.PI * 2;
    }
    return next;
  }

  private midpoint(from: WhiteboardPoint, to: WhiteboardPoint): WhiteboardPoint {
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }

  private regularPolygonVertices(center: WhiteboardPoint, radiusPoint: WhiteboardPoint, sides: number): WhiteboardPoint[] {
    const radius = Math.max(12, this.distance(center, radiusPoint));
    const startAngle = Math.atan2(radiusPoint.y - center.y, radiusPoint.x - center.x);
    return Array.from({ length: Math.max(3, sides) }, (_item, index) => {
      const angle = startAngle + (index * Math.PI * 2) / Math.max(3, sides);
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    });
  }

  private formatDistance(distance: number): string {
    if (distance >= 1000) {
      return `${(distance / 1000).toFixed(2)}k px`;
    }
    return `${Math.round(distance)} px`;
  }

  private graphViewport(element: WhiteboardGraphElement): GraphViewport {
    const titleOffset = element.title?.trim() ? 34 : 22;
    const left = element.position.x + 44;
    const top = element.position.y + titleOffset;
    return {
      left,
      top,
      width: Math.max(120, element.width - 58),
      height: Math.max(90, element.height - titleOffset - 24),
      xMin: element.xMin,
      xMax: element.xMax,
      yMin: element.yMin,
      yMax: element.yMax
    };
  }

  private drawGraphGrid(context: CanvasRenderingContext2D, viewport: GraphViewport, tickStep?: number | null): void {
    context.save();
    context.strokeStyle = this.cssVariable('--canvas-grid', '#d7e3f4');
    context.lineWidth = 1;
    context.beginPath();
    for (const x of this.graphTicks(viewport.xMin, viewport.xMax, tickStep)) {
      const pixel = this.graphXToPixel(viewport, x);
      context.moveTo(pixel + 0.5, viewport.top);
      context.lineTo(pixel + 0.5, viewport.top + viewport.height);
    }
    for (const y of this.graphTicks(viewport.yMin, viewport.yMax, tickStep)) {
      const pixel = this.graphYToPixel(viewport, y);
      context.moveTo(viewport.left, pixel + 0.5);
      context.lineTo(viewport.left + viewport.width, pixel + 0.5);
    }
    context.stroke();
    context.restore();
  }

  private drawGraphAxes(context: CanvasRenderingContext2D, viewport: GraphViewport, showTicks: boolean, tickStep?: number | null): void {
    context.save();
    context.strokeStyle = this.cssVariable('--canvas-axis', '#458B73');
    context.fillStyle = this.cssVariable('--canvas-template-muted', '#6d7890');
    context.lineWidth = 1.6;
    const zeroX = this.graphXToPixel(viewport, 0);
    const zeroY = this.graphYToPixel(viewport, 0);
    context.beginPath();
    if (zeroY >= viewport.top && zeroY <= viewport.top + viewport.height) {
      context.moveTo(viewport.left, zeroY);
      context.lineTo(viewport.left + viewport.width, zeroY);
    }
    if (zeroX >= viewport.left && zeroX <= viewport.left + viewport.width) {
      context.moveTo(zeroX, viewport.top);
      context.lineTo(zeroX, viewport.top + viewport.height);
    }
    context.stroke();
    if (showTicks) {
      context.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      for (const x of this.graphTicks(viewport.xMin, viewport.xMax, tickStep)) {
        const pixel = this.graphXToPixel(viewport, x);
        context.fillText(this.formatGraphTick(x), pixel, Math.min(viewport.top + viewport.height - 12, Math.max(viewport.top + 2, zeroY + 4)));
      }
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      for (const y of this.graphTicks(viewport.yMin, viewport.yMax, tickStep)) {
        if (Math.abs(y) < 1e-9) {
          continue;
        }
        const pixel = this.graphYToPixel(viewport, y);
        context.fillText(this.formatGraphTick(y), Math.min(viewport.left + viewport.width - 4, Math.max(viewport.left + 28, zeroX - 4)), pixel);
      }
    }
    context.restore();
  }

  private drawGraphFunction(
    context: CanvasRenderingContext2D,
    viewport: GraphViewport,
    evaluate: (x: number) => number,
    color: string,
    width: number
  ): void {
    const samples = Math.max(120, Math.min(520, Math.round(viewport.width * 1.45)));
    const yRange = viewport.yMax - viewport.yMin;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, width);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.beginPath();
    let drawing = false;
    let previousY: number | null = null;
    for (let index = 0; index <= samples; index += 1) {
      const x = viewport.xMin + (index / samples) * (viewport.xMax - viewport.xMin);
      const y = evaluate(x);
      const valid = Number.isFinite(y) && Math.abs(y) < 1e6;
      if (!valid || (previousY !== null && Math.abs(y - previousY) > yRange * 1.2)) {
        drawing = false;
        previousY = valid ? y : null;
        continue;
      }
      const px = this.graphXToPixel(viewport, x);
      const py = this.graphYToPixel(viewport, y);
      if (!drawing) {
        context.moveTo(px, py);
        drawing = true;
      } else {
        context.lineTo(px, py);
      }
      previousY = y;
    }
    context.stroke();
    context.restore();
  }

  private drawGraphArea(
    context: CanvasRenderingContext2D,
    viewport: GraphViewport,
    evaluate: (x: number) => number,
    from: number,
    to: number,
    color: string
  ): void {
    const start = Math.max(viewport.xMin, Math.min(from, to));
    const end = Math.min(viewport.xMax, Math.max(from, to));
    if (end <= start) {
      return;
    }
    const samples = 96;
    const zeroY = this.graphYToPixel(viewport, 0);
    context.save();
    context.fillStyle = color;
    context.globalAlpha = 0.16;
    context.beginPath();
    context.moveTo(this.graphXToPixel(viewport, start), zeroY);
    for (let index = 0; index <= samples; index += 1) {
      const x = start + (index / samples) * (end - start);
      const y = evaluate(x);
      if (!Number.isFinite(y)) {
        continue;
      }
      context.lineTo(this.graphXToPixel(viewport, x), this.graphYToPixel(viewport, y));
    }
    context.lineTo(this.graphXToPixel(viewport, end), zeroY);
    context.closePath();
    context.fill();
    context.restore();
  }

  private drawGraphPoint(context: CanvasRenderingContext2D, viewport: GraphViewport, evaluate: (x: number) => number, x: number, color: string): void {
    const y = evaluate(x);
    if (!Number.isFinite(y)) {
      return;
    }
    context.save();
    context.fillStyle = color;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(this.graphXToPixel(viewport, x), this.graphYToPixel(viewport, y), 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  private drawGraphTangent(context: CanvasRenderingContext2D, viewport: GraphViewport, evaluate: (x: number) => number, x: number, color: string): void {
    const h = Math.max(0.0001, (viewport.xMax - viewport.xMin) / 1200);
    const y = evaluate(x);
    const left = evaluate(x - h);
    const right = evaluate(x + h);
    if (![y, left, right].every(Number.isFinite)) {
      return;
    }
    const slope = (right - left) / (2 * h);
    const tangent = (nextX: number) => y + slope * (nextX - x);
    context.save();
    context.strokeStyle = color;
    context.globalAlpha = 0.66;
    context.lineWidth = 1.4;
    context.setLineDash([7, 5]);
    context.beginPath();
    context.moveTo(this.graphXToPixel(viewport, viewport.xMin), this.graphYToPixel(viewport, tangent(viewport.xMin)));
    context.lineTo(this.graphXToPixel(viewport, viewport.xMax), this.graphYToPixel(viewport, tangent(viewport.xMax)));
    context.stroke();
    context.restore();
    this.drawGraphPoint(context, viewport, evaluate, x, color);
  }

  private drawGraphIntercepts(context: CanvasRenderingContext2D, viewport: GraphViewport, evaluate: (x: number) => number, color: string): void {
    const intercepts: WhiteboardPoint[] = [];
    const samples = 180;
    let previousX = viewport.xMin;
    let previousY = evaluate(previousX);
    for (let index = 1; index <= samples; index += 1) {
      const x = viewport.xMin + (index / samples) * (viewport.xMax - viewport.xMin);
      const y = evaluate(x);
      if (Number.isFinite(y) && Number.isFinite(previousY) && Math.sign(y) !== Math.sign(previousY)) {
        const ratio = Math.abs(previousY) / (Math.abs(previousY) + Math.abs(y));
        const root = previousX + (x - previousX) * ratio;
        intercepts.push({ x: this.graphXToPixel(viewport, root), y: this.graphYToPixel(viewport, 0) });
      }
      previousX = x;
      previousY = y;
    }
    const yIntercept = evaluate(0);
    if (Number.isFinite(yIntercept) && 0 >= viewport.xMin && 0 <= viewport.xMax) {
      intercepts.push({ x: this.graphXToPixel(viewport, 0), y: this.graphYToPixel(viewport, yIntercept) });
    }
    context.save();
    context.fillStyle = color;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.5;
    for (const point of intercepts.slice(0, 8)) {
      context.beginPath();
      context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawScatterPoints(context: CanvasRenderingContext2D, viewport: GraphViewport, element: WhiteboardGraphElement): void {
    const points = this.parseScatterPoints(element.scatterPoints ?? '');
    if (!points.length) {
      return;
    }
    context.save();
    context.fillStyle = element.scatterColor ?? '#FF9760';
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.5;
    for (const point of points) {
      if (point.x < viewport.xMin || point.x > viewport.xMax || point.y < viewport.yMin || point.y > viewport.yMax) {
        continue;
      }
      context.beginPath();
      context.arc(this.graphXToPixel(viewport, point.x), this.graphYToPixel(viewport, point.y), 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawGraphInequality(context: CanvasRenderingContext2D, viewport: GraphViewport, source: string, color: string): string | null {
    const parsed = this.parseInequalitySource(source);
    if (typeof parsed === 'string') {
      return parsed;
    }
    context.save();
    context.fillStyle = color;
    context.strokeStyle = color;
    context.globalAlpha = 0.16;
    if (parsed.axis === 'x') {
      const x = this.graphXToPixel(viewport, parsed.boundary);
      const shadeRight = parsed.operator === '>' || parsed.operator === '>=';
      const left = shadeRight ? x : viewport.left;
      const width = shadeRight ? viewport.left + viewport.width - x : x - viewport.left;
      context.fillRect(left, viewport.top, width, viewport.height);
      context.globalAlpha = 0.62;
      if (parsed.operator === '>' || parsed.operator === '<') {
        context.setLineDash([6, 5]);
      }
      context.beginPath();
      context.moveTo(x, viewport.top);
      context.lineTo(x, viewport.top + viewport.height);
      context.stroke();
      context.restore();
      return null;
    }
    const expression = this.parseGraphExpression(parsed.expression);
    if (expression.error) {
      context.restore();
      return expression.error;
    }
    const samples = Math.max(80, Math.min(260, Math.round(viewport.width)));
    const shadeAbove = parsed.operator === '>' || parsed.operator === '>=';
    const edgeY = shadeAbove ? viewport.top : viewport.top + viewport.height;
    const points: WhiteboardPoint[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const x = viewport.xMin + (index / samples) * (viewport.xMax - viewport.xMin);
      const y = expression.evaluate(x);
      if (!Number.isFinite(y)) {
        continue;
      }
      points.push({ x: this.graphXToPixel(viewport, x), y: this.graphYToPixel(viewport, y) });
    }
    if (points.length > 1) {
      context.beginPath();
      context.moveTo(points[0]!.x, edgeY);
      for (const point of points) {
        context.lineTo(point.x, point.y);
      }
      context.lineTo(points[points.length - 1]!.x, edgeY);
      context.closePath();
      context.fill();
      context.globalAlpha = 0.74;
      if (parsed.operator === '>' || parsed.operator === '<') {
        context.setLineDash([6, 5]);
      }
      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.stroke();
    }
    context.restore();
    return null;
  }

  private drawGraphParametric(context: CanvasRenderingContext2D, viewport: GraphViewport, plot: WhiteboardGraphParametricPlot | null): string | null {
    if (!plot?.xExpression.trim() || !plot.yExpression.trim()) {
      return null;
    }
    const parsedX = this.parseGraphExpression(plot.xExpression, 't');
    const parsedY = this.parseGraphExpression(plot.yExpression, 't');
    if (parsedX.error || parsedY.error) {
      return parsedX.error ?? parsedY.error ?? 'Invalid parametric curve.';
    }
    const samples = 360;
    const points: WhiteboardPoint[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const t = plot.tMin + (index / samples) * (plot.tMax - plot.tMin);
      const x = parsedX.evaluate(t);
      const y = parsedY.evaluate(t);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x: this.graphXToPixel(viewport, x), y: this.graphYToPixel(viewport, y) });
      }
    }
    this.drawGraphPolyline(context, points, plot.color, plot.width, []);
    return null;
  }

  private drawGraphPolar(context: CanvasRenderingContext2D, viewport: GraphViewport, plot: WhiteboardGraphPolarPlot | null): string | null {
    if (!plot?.expression.trim()) {
      return null;
    }
    const parsed = this.parseGraphExpression(plot.expression, 'theta');
    if (parsed.error) {
      return parsed.error;
    }
    const samples = 360;
    const points: WhiteboardPoint[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const theta = plot.thetaMin + (index / samples) * (plot.thetaMax - plot.thetaMin);
      const radius = parsed.evaluate(theta);
      if (!Number.isFinite(radius)) {
        continue;
      }
      const x = radius * Math.cos(theta);
      const y = radius * Math.sin(theta);
      points.push({ x: this.graphXToPixel(viewport, x), y: this.graphYToPixel(viewport, y) });
    }
    this.drawGraphPolyline(context, points, plot.color, plot.width, []);
    return null;
  }

  private drawGraphPolyline(context: CanvasRenderingContext2D, points: WhiteboardPoint[], color: string, width: number, dash: number[]): void {
    if (points.length < 2) {
      return;
    }
    context.save();
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, width);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.setLineDash(dash);
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.stroke();
    context.restore();
  }

  private drawGraphHistogram(context: CanvasRenderingContext2D, viewport: GraphViewport, element: WhiteboardGraphElement): void {
    const values = this.parseNumberList(element.stats?.histogramData ?? '');
    if (!values.length) {
      return;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
      return;
    }
    const binCount = Math.max(2, Math.min(24, element.stats?.histogramBins ?? Math.ceil(Math.sqrt(values.length))));
    const binWidth = (max - min) / binCount;
    const counts = Array.from({ length: binCount }, () => 0);
    for (const value of values) {
      const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - min) / binWidth)));
      counts[index]! += 1;
    }
    context.save();
    context.fillStyle = '#458B73';
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.globalAlpha = 0.35;
    counts.forEach((count, index) => {
      const x0 = min + index * binWidth;
      const x1 = x0 + binWidth;
      const left = this.graphXToPixel(viewport, x0);
      const right = this.graphXToPixel(viewport, x1);
      const top = this.graphYToPixel(viewport, Math.min(viewport.yMax, count));
      const bottom = this.graphYToPixel(viewport, 0);
      context.fillRect(left, top, right - left, bottom - top);
      context.strokeRect(left, top, right - left, bottom - top);
    });
    context.restore();
  }

  private drawRegressionLine(context: CanvasRenderingContext2D, viewport: GraphViewport, element: WhiteboardGraphElement): void {
    const regression = this.linearRegression(this.parseScatterPoints(element.scatterPoints ?? ''));
    if (!regression) {
      return;
    }
    const evaluate = (x: number) => regression.slope * x + regression.intercept;
    this.drawGraphFunction(context, viewport, evaluate, '#F26076', 1.8);
    context.save();
    context.fillStyle = '#F26076';
    context.font = '700 11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textBaseline = 'top';
    context.fillText(`y=${this.formatGraphTick(regression.slope)}x+${this.formatGraphTick(regression.intercept)}  R2=${regression.rSquared.toFixed(2)}`, viewport.left + 8, viewport.top + 8);
    context.restore();
  }

  private drawNormalCurve(context: CanvasRenderingContext2D, viewport: GraphViewport, element: WhiteboardGraphElement): void {
    const mean = element.stats?.normalMean;
    const stdDev = element.stats?.normalStdDev;
    if (!this.hasFiniteNumber(mean) || !this.hasFiniteNumber(stdDev) || stdDev <= 0) {
      return;
    }
    const scale = Math.max(1, viewport.yMax - viewport.yMin);
    const evaluate = (x: number) => (1 / (stdDev * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mean) / stdDev) ** 2) * scale;
    this.drawGraphFunction(context, viewport, evaluate, '#7c3aed', 1.8);
  }

  private drawGraphLabels(context: CanvasRenderingContext2D, viewport: GraphViewport, labels: WhiteboardGraphLabel[]): void {
    if (!labels.length) {
      return;
    }
    context.save();
    context.font = '700 11px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textBaseline = 'middle';
    for (const label of labels.slice(0, 24)) {
      if (label.x < viewport.xMin || label.x > viewport.xMax || label.y < viewport.yMin || label.y > viewport.yMax) {
        continue;
      }
      const x = this.graphXToPixel(viewport, label.x);
      const y = this.graphYToPixel(viewport, label.y);
      context.fillStyle = label.color ?? '#071c41';
      context.strokeStyle = '#ffffff';
      context.lineWidth = 3;
      context.strokeText(label.text.slice(0, 36), x + 7, y - 7);
      context.fillText(label.text.slice(0, 36), x + 7, y - 7);
      context.beginPath();
      context.arc(x, y, 3, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  private graphXToPixel(viewport: GraphViewport, x: number): number {
    return viewport.left + ((x - viewport.xMin) / (viewport.xMax - viewport.xMin)) * viewport.width;
  }

  private graphYToPixel(viewport: GraphViewport, y: number): number {
    return viewport.top + viewport.height - ((y - viewport.yMin) / (viewport.yMax - viewport.yMin)) * viewport.height;
  }

  private graphTicks(min: number, max: number, preferredStep?: number | null): number[] {
    const span = max - min;
    const rawStep = span / 8;
    const step = preferredStep && preferredStep > 0
      ? preferredStep
      : (() => {
          const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawStep, 0.000001)));
          const normalized = rawStep / magnitude;
          return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
        })();
    const ticks: number[] = [];
    const start = Math.ceil(min / step) * step;
    for (let value = start; value <= max + step * 0.25 && ticks.length < 32; value += step) {
      ticks.push(Number(value.toFixed(8)));
    }
    return ticks;
  }

  private formatGraphTick(value: number): string {
    if (Math.abs(value) < 1e-9) {
      return '0';
    }
    if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
      return value.toExponential(1);
    }
    return Number(value.toFixed(2)).toString();
  }

  private parseGraphFunctionList(value: string): string[] {
    return value
      .split(/[\n;]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  private parseNumberList(value: string): number[] {
    return value
      .split(/[,\s;\n]+/)
      .map((entry) => Number(entry.trim()))
      .filter(Number.isFinite)
      .slice(0, 500);
  }

  private parseGraphLabels(value: string): WhiteboardGraphLabel[] {
    return value
      .split(/\n|;/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [xText, yText, ...labelParts] = entry.split(',').map((part) => part.trim());
        const x = Number(xText);
        const y = Number(yText);
        const text = labelParts.join(',').trim();
        return Number.isFinite(x) && Number.isFinite(y) && text ? { x, y, text } : null;
      })
      .filter((label): label is WhiteboardGraphLabel => !!label)
      .slice(0, 24);
  }

  private serializeGraphLabels(labels: WhiteboardGraphLabel[]): string {
    return labels.map((label) => `${label.x},${label.y},${label.text}`).join('\n');
  }

  private parseScatterPoints(value: string): WhiteboardPoint[] {
    return value
      .split(/[;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [x, y] = entry.split(',').map((part) => Number(part.trim()));
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      })
      .filter((point): point is WhiteboardPoint => !!point)
      .slice(0, 160);
  }

  private linearRegression(points: WhiteboardPoint[]): { slope: number; intercept: number; rSquared: number } | null {
    if (points.length < 2) {
      return null;
    }
    const n = points.length;
    const sumX = points.reduce((sum, point) => sum + point.x, 0);
    const sumY = points.reduce((sum, point) => sum + point.y, 0);
    const meanX = sumX / n;
    const meanY = sumY / n;
    const sxx = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const syy = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    const sxy = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
    if (Math.abs(sxx) < 1e-10 || Math.abs(syy) < 1e-10) {
      return null;
    }
    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    return { slope, intercept, rSquared: Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy))) };
  }

  private parseInequalitySource(source: string): { axis: 'x'; operator: '<' | '<=' | '>' | '>='; boundary: number } | { axis: 'y'; operator: '<' | '<=' | '>' | '>='; expression: string } | string {
    const trimmed = source.trim();
    const xMatch = trimmed.match(/^x\s*(<=|>=|<|>)\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i);
    if (xMatch) {
      return { axis: 'x', operator: xMatch[1] as '<' | '<=' | '>' | '>=', boundary: Number(xMatch[2]) };
    }
    const yMatch = trimmed.match(/^y\s*(<=|>=|<|>)\s*(.+)$/i);
    if (yMatch) {
      return { axis: 'y', operator: yMatch[1] as '<' | '<=' | '>' | '>=', expression: yMatch[2]!.trim() };
    }
    return 'Use simple inequalities like y > x + 2 or x >= 0.';
  }

  private validateInequalitySource(source: string): string | null {
    const parsed = this.parseInequalitySource(source);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (parsed.axis === 'y') {
      const expression = this.parseGraphExpression(parsed.expression);
      if (expression.error) {
        return expression.error;
      }
    }
    return null;
  }

  private parseGraphExpression(source: string, variableName: 'x' | 't' | 'theta' = 'x'): GraphParseResult {
    let expression = source.trim();
    if (variableName === 'x') {
      expression = expression.replace(/^\s*y\s*=/i, '').trim();
    } else if (variableName === 't') {
      expression = expression.replace(/^\s*[xy]\s*\(\s*t\s*\)\s*=/i, '').trim();
    } else {
      expression = expression.replace(/^\s*r\s*(?:\(\s*(?:theta|t)\s*\))?\s*=/i, '').trim();
    }
    if (!expression) {
      return { evaluate: () => Number.NaN, error: 'Function is empty.' };
    }
    try {
      const parser = new GraphExpressionParser(this.tokenizeGraphExpression(expression), variableName);
      const ast = parser.parse();
      return {
        evaluate: (valueAtVariable: number) => {
          const value = this.evaluateGraphAst(ast, valueAtVariable);
          return Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : Number.NaN;
        }
      };
    } catch (error) {
      return {
        evaluate: () => Number.NaN,
        error: error instanceof Error ? error.message : 'Invalid graph expression.'
      };
    }
  }

  private tokenizeGraphExpression(source: string): GraphToken[] {
    const tokens: GraphToken[] = [];
    let index = 0;
    while (index < source.length) {
      const char = source[index]!;
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (/[0-9.]/.test(char)) {
        let cursor = index + 1;
        while (cursor < source.length && /[0-9.]/.test(source[cursor]!)) {
          cursor += 1;
        }
        if (/[eE]/.test(source[cursor] ?? '')) {
          cursor += 1;
          if (/[+-]/.test(source[cursor] ?? '')) {
            cursor += 1;
          }
          while (cursor < source.length && /[0-9]/.test(source[cursor]!)) {
            cursor += 1;
          }
        }
        tokens.push({ type: 'number', value: source.slice(index, cursor) });
        index = cursor;
        continue;
      }
      if (/[A-Za-z]/.test(char)) {
        let cursor = index + 1;
        while (cursor < source.length && /[A-Za-z]/.test(source[cursor]!)) {
          cursor += 1;
        }
        tokens.push({ type: 'identifier', value: source.slice(index, cursor).toLowerCase() });
        index = cursor;
        continue;
      }
      if ('+-*/^'.includes(char)) {
        tokens.push({ type: 'operator', value: char });
        index += 1;
        continue;
      }
      if ('()'.includes(char)) {
        tokens.push({ type: 'paren', value: char });
        index += 1;
        continue;
      }
      if (char === ',') {
        tokens.push({ type: 'comma', value: char });
        index += 1;
        continue;
      }
      throw new Error(`Unsupported character "${char}".`);
    }
    tokens.push({ type: 'eof', value: '' });
    return tokens;
  }

  private evaluateGraphAst(node: GraphAstNode, x: number): number {
    if (node.type === 'number') {
      return node.value;
    }
    if (node.type === 'variable') {
      return x;
    }
    if (node.type === 'unary') {
      const value = this.evaluateGraphAst(node.argument, x);
      return node.operator === '-' ? -value : value;
    }
    if (node.type === 'binary') {
      const left = this.evaluateGraphAst(node.left, x);
      const right = this.evaluateGraphAst(node.right, x);
      if (node.operator === '+') {
        return left + right;
      }
      if (node.operator === '-') {
        return left - right;
      }
      if (node.operator === '*') {
        return left * right;
      }
      if (node.operator === '/') {
        return Math.abs(right) < 1e-10 ? Number.NaN : left / right;
      }
      return Math.abs(left) > 1e6 || Math.abs(right) > 64 ? Number.NaN : left ** right;
    }
    const argument = this.evaluateGraphAst(node.argument, x);
    if (node.name === 'sin') {
      return Math.sin(argument);
    }
    if (node.name === 'cos') {
      return Math.cos(argument);
    }
    if (node.name === 'tan') {
      return Math.abs(Math.cos(argument)) < 0.025 ? Number.NaN : Math.tan(argument);
    }
    if (node.name === 'asin') {
      return Math.abs(argument) > 1 ? Number.NaN : Math.asin(argument);
    }
    if (node.name === 'acos') {
      return Math.abs(argument) > 1 ? Number.NaN : Math.acos(argument);
    }
    if (node.name === 'atan') {
      return Math.atan(argument);
    }
    if (node.name === 'exp') {
      return argument > 24 ? Number.NaN : Math.exp(argument);
    }
    if (node.name === 'ln' || node.name === 'log') {
      return argument <= 0 ? Number.NaN : Math.log(argument);
    }
    if (node.name === 'sqrt') {
      return argument < 0 ? Number.NaN : Math.sqrt(argument);
    }
    if (node.name === 'abs') {
      return Math.abs(argument);
    }
    throw new Error(`Unsupported function "${node.name}".`);
  }

  private optionalNumber(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const next = Number(trimmed);
    return Number.isFinite(next) ? next : null;
  }

  private optionalPositiveInteger(value: string): number | undefined {
    const next = this.optionalNumber(value);
    if (!next || next <= 0) {
      return undefined;
    }
    return Math.max(1, Math.round(next));
  }

  private optionalNumberText(value: number | null | undefined): string {
    return this.hasFiniteNumber(value) ? String(value) : '';
  }

  private hasFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private drawRoundedBlock(context: CanvasRenderingContext2D, bounds: ElementBounds, fillColor: string): void {
    const radius = 8;
    context.save();
    context.fillStyle = fillColor;
    context.globalAlpha = 0.86;
    context.beginPath();
    context.moveTo(bounds.x + radius, bounds.y);
    context.lineTo(bounds.x + bounds.width - radius, bounds.y);
    context.quadraticCurveTo(bounds.x + bounds.width, bounds.y, bounds.x + bounds.width, bounds.y + radius);
    context.lineTo(bounds.x + bounds.width, bounds.y + bounds.height - radius);
    context.quadraticCurveTo(bounds.x + bounds.width, bounds.y + bounds.height, bounds.x + bounds.width - radius, bounds.y + bounds.height);
    context.lineTo(bounds.x + radius, bounds.y + bounds.height);
    context.quadraticCurveTo(bounds.x, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height - radius);
    context.lineTo(bounds.x, bounds.y + radius);
    context.quadraticCurveTo(bounds.x, bounds.y, bounds.x + radius, bounds.y);
    context.fill();
    context.restore();
  }

  private measureEquationBlock(raw: string, fontSize: number): { width: number; height: number } {
    const context = this.context;
    if (!context) {
      const lines = raw.split('\n').length;
      return { width: Math.max(180, raw.length * fontSize * 0.48), height: Math.max(64, lines * fontSize * 1.5) };
    }
    const padding = this.equationPadding(fontSize);
    const metrics = this.drawMathBlock(context, raw, 0, 0, fontSize, false);
    return {
      width: Math.max(160, metrics.width + padding * 2),
      height: Math.max(fontSize * 2.2, metrics.height + padding * 2)
    };
  }

  private drawMathBlock(context: CanvasRenderingContext2D, raw: string, x: number, y: number, fontSize: number, draw: boolean): MathRunMetrics {
    const matrix = this.extractMatrix(raw);
    if (matrix) {
      return this.renderMatrix(context, matrix, x, y, fontSize, draw);
    }

    const lines = raw.split('\n');
    let cursorY = y;
    let maxWidth = 0;
    let totalHeight = 0;
    for (const line of lines) {
      const metrics = this.renderMathInline(context, line, x, cursorY + fontSize, fontSize, draw);
      const lineHeight = Math.max(metrics.height, fontSize * 1.45);
      maxWidth = Math.max(maxWidth, metrics.width);
      cursorY += lineHeight + fontSize * 0.24;
      totalHeight += lineHeight + fontSize * 0.24;
    }
    return { width: maxWidth, height: Math.max(fontSize * 1.45, totalHeight) };
  }

  private renderMathInline(context: CanvasRenderingContext2D, source: string, x: number, baseline: number, fontSize: number, draw: boolean): MathRunMetrics {
    let cursorX = x;
    let index = 0;
    let maxHeight = fontSize * 1.35;
    context.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    context.textBaseline = 'alphabetic';

    while (index < source.length) {
      const next = this.readMathToken(source, index, context, cursorX, baseline, fontSize, draw);
      cursorX += next.width;
      maxHeight = Math.max(maxHeight, next.height);
      index = next.endIndex;
    }

    return { width: cursorX - x, height: maxHeight };
  }

  private readMathToken(
    source: string,
    index: number,
    context: CanvasRenderingContext2D,
    x: number,
    baseline: number,
    fontSize: number,
    draw: boolean
  ): MathRunMetrics & { endIndex: number } {
    const char = source[index]!;
    if (char === '\\') {
      const command = this.readCommand(source, index);
      if (command.name === 'frac') {
        const numerator = this.readBraceGroup(source, command.endIndex);
        const denominator = this.readBraceGroup(source, numerator.endIndex);
        return { ...this.renderFraction(context, numerator.value, denominator.value, x, baseline, fontSize, draw), endIndex: denominator.endIndex };
      }
      if (command.name === 'sqrt') {
        const body = this.readBraceGroup(source, command.endIndex);
        return { ...this.renderSqrt(context, body.value, x, baseline, fontSize, draw), endIndex: body.endIndex };
      }
      if (command.name === 'vec') {
        const body = this.readBraceGroup(source, command.endIndex);
        return { ...this.renderVector(context, body.value, x, baseline, fontSize, draw), endIndex: body.endIndex };
      }
      const replacement = MATH_COMMAND_REPLACEMENTS[command.name] ?? `\\${command.name}`;
      return { ...this.renderPlainMathText(context, replacement, x, baseline, fontSize, draw), endIndex: command.endIndex };
    }

    if (char === '^' || char === '_') {
      const script = this.readScriptArgument(source, index + 1);
      const size = fontSize * 0.64;
      const y = char === '^' ? baseline - fontSize * 0.52 : baseline + fontSize * 0.42;
      return { ...this.renderPlainMathText(context, this.normalizeMathText(script.value), x, y, size, draw), endIndex: script.endIndex };
    }

    if (char === '{' || char === '}') {
      return { width: 0, height: fontSize * 1.2, endIndex: index + 1 };
    }

    const nextSpecial = this.nextMathSpecialIndex(source, index + 1);
    const text = this.normalizeMathText(source.slice(index, nextSpecial));
    return { ...this.renderPlainMathText(context, text, x, baseline, fontSize, draw), endIndex: nextSpecial };
  }

  private renderFraction(
    context: CanvasRenderingContext2D,
    numerator: string,
    denominator: string,
    x: number,
    baseline: number,
    fontSize: number,
    draw: boolean
  ): MathRunMetrics {
    const childSize = fontSize * 0.72;
    const numeratorMetrics = this.renderMathInline(context, numerator, 0, 0, childSize, false);
    const denominatorMetrics = this.renderMathInline(context, denominator, 0, 0, childSize, false);
    const width = Math.max(numeratorMetrics.width, denominatorMetrics.width) + fontSize * 0.65;
    const lineY = baseline - fontSize * 0.28;
    if (draw) {
      const numeratorX = x + (width - numeratorMetrics.width) / 2;
      const denominatorX = x + (width - denominatorMetrics.width) / 2;
      this.renderMathInline(context, numerator, numeratorX, lineY - fontSize * 0.24, childSize, true);
      context.save();
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1, fontSize / 18);
      context.beginPath();
      context.moveTo(x + fontSize * 0.16, lineY);
      context.lineTo(x + width - fontSize * 0.16, lineY);
      context.stroke();
      context.restore();
      this.renderMathInline(context, denominator, denominatorX, lineY + fontSize * 0.78, childSize, true);
    }
    return { width, height: fontSize * 1.82 };
  }

  private renderSqrt(context: CanvasRenderingContext2D, body: string, x: number, baseline: number, fontSize: number, draw: boolean): MathRunMetrics {
    const bodyMetrics = this.renderMathInline(context, body, 0, 0, fontSize * 0.86, false);
    const width = bodyMetrics.width + fontSize * 0.78;
    if (draw) {
      const rootX = x + fontSize * 0.12;
      const topY = baseline - fontSize * 0.9;
      context.save();
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1.2, fontSize / 16);
      context.beginPath();
      context.moveTo(rootX, baseline - fontSize * 0.28);
      context.lineTo(rootX + fontSize * 0.18, baseline - fontSize * 0.12);
      context.lineTo(rootX + fontSize * 0.36, topY);
      context.lineTo(rootX + fontSize * 0.58 + bodyMetrics.width, topY);
      context.stroke();
      context.restore();
      this.renderMathInline(context, body, x + fontSize * 0.66, baseline, fontSize * 0.86, true);
    }
    return { width, height: fontSize * 1.45 };
  }

  private renderVector(context: CanvasRenderingContext2D, body: string, x: number, baseline: number, fontSize: number, draw: boolean): MathRunMetrics {
    const metrics = this.renderMathInline(context, body, 0, 0, fontSize, false);
    if (draw) {
      this.renderMathInline(context, body, x, baseline, fontSize, true);
      context.save();
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1, fontSize / 18);
      const y = baseline - fontSize * 0.92;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + metrics.width, y);
      context.lineTo(x + metrics.width - fontSize * 0.22, y - fontSize * 0.12);
      context.moveTo(x + metrics.width, y);
      context.lineTo(x + metrics.width - fontSize * 0.22, y + fontSize * 0.12);
      context.stroke();
      context.restore();
    }
    return { width: metrics.width, height: fontSize * 1.45 };
  }

  private renderPlainMathText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    baseline: number,
    fontSize: number,
    draw: boolean
  ): MathRunMetrics {
    context.save();
    context.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    context.textBaseline = 'alphabetic';
    const width = context.measureText(text).width;
    if (draw) {
      context.fillText(text, x, baseline);
    }
    context.restore();
    return { width, height: fontSize * 1.25 };
  }

  private renderMatrix(context: CanvasRenderingContext2D, matrixSource: string, x: number, y: number, fontSize: number, draw: boolean): MathRunMetrics {
    const rows = matrixSource
      .split(/\\\\|;/)
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => row.split('&').map((cell) => cell.trim()));
    const columnCount = Math.max(...rows.map((row) => row.length), 1);
    const cellMetrics = rows.map((row) =>
      Array.from({ length: columnCount }, (_, index) => this.renderMathInline(context, row[index] ?? '', 0, 0, fontSize * 0.88, false))
    );
    const columnWidths = Array.from({ length: columnCount }, (_, column) => Math.max(...cellMetrics.map((row) => row[column]?.width ?? 0), fontSize));
    const rowHeight = fontSize * 1.45;
    const innerWidth = columnWidths.reduce((sum, width) => sum + width, 0) + (columnCount - 1) * fontSize * 0.8;
    const width = innerWidth + fontSize * 1.4;
    const height = Math.max(rowHeight, rows.length * rowHeight);
    if (draw) {
      context.save();
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1.2, fontSize / 16);
      const left = x + fontSize * 0.28;
      const right = x + width - fontSize * 0.28;
      context.beginPath();
      context.moveTo(left + fontSize * 0.28, y);
      context.lineTo(left, y);
      context.lineTo(left, y + height);
      context.lineTo(left + fontSize * 0.28, y + height);
      context.moveTo(right - fontSize * 0.28, y);
      context.lineTo(right, y);
      context.lineTo(right, y + height);
      context.lineTo(right - fontSize * 0.28, y + height);
      context.stroke();
      context.restore();

      rows.forEach((row, rowIndex) => {
        let cursorX = x + fontSize * 0.82;
        row.forEach((cell, columnIndex) => {
          const metrics = cellMetrics[rowIndex]?.[columnIndex] ?? { width: 0, height: rowHeight };
          const cellX = cursorX + (columnWidths[columnIndex]! - metrics.width) / 2;
          this.renderMathInline(context, cell, cellX, y + rowIndex * rowHeight + fontSize, fontSize * 0.88, true);
          cursorX += columnWidths[columnIndex]! + fontSize * 0.8;
        });
      });
    }
    return { width, height };
  }

  private extractMatrix(raw: string): string | null {
    const match = raw.match(/\\begin\{[bp]?matrix\}([\s\S]*?)\\end\{[bp]?matrix\}/);
    return match?.[1]?.trim() || null;
  }

  private validateMathSource(raw: string): string | null {
    const value = raw.trim();
    if (!value) {
      return null;
    }
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth < 0) {
          return 'There is an extra closing brace in this equation.';
        }
      }
    }
    if (depth > 0) {
      return 'Close all braces before inserting this equation.';
    }
    const environments = Array.from(value.matchAll(/\\(begin|end)\{([^}]+)\}/g));
    const supportedEnvironments = new Set(['matrix', 'bmatrix', 'pmatrix']);
    const stack: string[] = [];
    for (const match of environments) {
      const action = match[1];
      const environment = match[2] ?? '';
      if (!supportedEnvironments.has(environment)) {
        return `Unsupported environment "${environment}". Use matrix, bmatrix, or pmatrix.`;
      }
      if (action === 'begin') {
        stack.push(environment);
      } else if (stack.pop() !== environment) {
        return `The ${environment} matrix environment is not closed correctly.`;
      }
    }
    return stack.length ? 'Close the matrix environment before inserting.' : null;
  }

  private readCommand(source: string, index: number): { name: string; endIndex: number } {
    let cursor = index + 1;
    while (cursor < source.length && /[A-Za-z]/.test(source[cursor]!)) {
      cursor += 1;
    }
    return { name: source.slice(index + 1, cursor), endIndex: cursor };
  }

  private readBraceGroup(source: string, index: number): ParsedGroup {
    if (source[index] !== '{') {
      return { value: '', endIndex: index };
    }
    let depth = 0;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      const char = source[cursor]!;
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return { value: source.slice(index + 1, cursor), endIndex: cursor + 1 };
        }
      }
    }
    return { value: source.slice(index + 1), endIndex: source.length };
  }

  private readScriptArgument(source: string, index: number): ParsedGroup {
    if (source[index] === '{') {
      return this.readBraceGroup(source, index);
    }
    if (source[index] === '\\') {
      const command = this.readCommand(source, index);
      return { value: MATH_COMMAND_REPLACEMENTS[command.name] ?? `\\${command.name}`, endIndex: command.endIndex };
    }
    return { value: source[index] ?? '', endIndex: Math.min(source.length, index + 1) };
  }

  private nextMathSpecialIndex(source: string, start: number): number {
    const nextIndexes = ['\\', '^', '_', '{', '}']
      .map((char) => source.indexOf(char, start))
      .filter((index) => index >= 0);
    return nextIndexes.length ? Math.min(...nextIndexes) : source.length;
  }

  private normalizeMathText(value: string): string {
    return value
      .replace(/\\([A-Za-z]+)/g, (_match, command: string) => MATH_COMMAND_REPLACEMENTS[command] ?? `\\${command}`)
      .replace(/-->/g, '→')
      .replace(/<-/g, '←');
  }

  private cursorAfterSnippet(snippet: string, start: number): number {
    const emptyPlaceholderIndex = snippet.indexOf('{}');
    if (emptyPlaceholderIndex >= 0) {
      return start + emptyPlaceholderIndex + 1;
    }
    const firstGroup = snippet.match(/\{[^{}]*\}/);
    if (firstGroup?.index !== undefined) {
      return start + firstGroup.index + 1;
    }
    return start + snippet.length;
  }

  private alignedInlineX(contentWidth: number, left: number, availableWidth: number, alignment: WhiteboardTextAlignment): number {
    if (alignment === 'center') {
      return left + Math.max(0, availableWidth - contentWidth) / 2;
    }
    if (alignment === 'right') {
      return left + Math.max(0, availableWidth - contentWidth);
    }
    return left;
  }

  private equationPadding(fontSize: number): number {
    return Math.max(10, fontSize * 0.36);
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

  private createGeometryElement(
    kind: WhiteboardGeometryTool,
    from: WhiteboardPoint,
    to: WhiteboardPoint,
    id = this.previewElement?.id ?? this.createElementId()
  ): WhiteboardGeometryElement {
    return {
      id,
      type: 'geometry',
      kind,
      strokeColor: this.strokeColor(),
      fillColor: this.fillEnabled() && (kind === 'circle' || kind === 'arc' || kind === 'angle' || kind === 'polygon') ? this.fillColor() : null,
      width: this.strokeWidth(),
      from,
      to,
      label: kind === 'point' ? 'P' : kind === 'vector' ? 'v' : kind === 'polygon' ? 'hexagon' : undefined,
      showMeasurement: this.showMeasurements(),
      dashed: kind === 'perpendicular' || kind === 'parallel'
    };
  }

  private createDiagramElement(kind: WhiteboardDiagramTool, position: WhiteboardPoint): WhiteboardDiagramElement {
    const dimensions = this.defaultDiagramDimensions(kind);
    return {
      id: this.createElementId(),
      type: 'diagram',
      kind,
      position,
      width: dimensions.width,
      height: dimensions.height,
      strokeColor: this.strokeColor(),
      fillColor: this.fillEnabled() ? this.fillColor() : '#FFD150',
      lineWidth: Math.max(2, this.strokeWidth()),
      labels: this.defaultDiagramLabels(kind)
    };
  }

  private defaultDiagramDimensions(kind: WhiteboardDiagramTool): { width: number; height: number } {
    if (kind === 'coordinate-axes') {
      return { width: 460, height: 320 };
    }
    if (kind === 'number-line-template') {
      return { width: 460, height: 150 };
    }
    if (kind === 'table-layout') {
      return { width: 420, height: 260 };
    }
    if (kind === 'fraction-bars') {
      return { width: 440, height: 300 };
    }
    if (kind === 'flow') {
      return { width: 420, height: 280 };
    }
    if (kind === 'venn') {
      return { width: 360, height: 250 };
    }
    return { width: 360, height: 280 };
  }

  private defaultDiagramLabels(kind: WhiteboardDiagramTool): string[] {
    if (kind === 'coordinate-axes') {
      return ['x', 'y', '0'];
    }
    if (kind === 'number-line-template') {
      return ['-5', '-4', '-3', '-2', '-1', '0', '1', '2', '3', '4', '5'];
    }
    if (kind === 'table-layout') {
      return ['Col 1', 'Col 2', 'Col 3', 'Col 4'];
    }
    if (kind === 'fraction-bars') {
      return ['1/2', '1/3', '1/4', '1/5', '1/8'];
    }
    if (kind === 'venn') {
      return ['A', 'B', 'A ∩ B'];
    }
    if (kind === 'node-edge') {
      return ['A', 'B', 'C', 'D'];
    }
    if (kind === 'tree') {
      return ['Root', 'A', 'B', 'A1', 'A2', 'B1', 'B2'];
    }
    if (kind === 'probability-tree') {
      return ['Start', 'A', 'B', 'A1', 'A2', 'B1', 'B2', 'p', '1-p'];
    }
    return ['Start', 'Step', 'Result'];
  }

  private createTextElement(draft: TextDraft, text: string): WhiteboardTextElement {
    return {
      id: draft.elementId ?? this.createElementId(),
      type: 'text',
      color: this.strokeColor(),
      fillColor: this.fillEnabled() ? this.fillColor() : null,
      fontSize: this.fontSize(),
      position: { x: draft.x, y: draft.y },
      text,
      width: draft.width,
      height: draft.height,
      align: draft.align ?? 'left'
    };
  }

  private createEquationElement(draft: TextDraft, raw: string): WhiteboardEquationElement {
    const size = this.measureEquationBlock(raw, this.fontSize());
    return {
      id: draft.elementId ?? this.createElementId(),
      type: 'equation',
      color: this.strokeColor(),
      fillColor: this.fillEnabled() ? this.fillColor() : null,
      fontSize: this.fontSize(),
      position: { x: draft.x, y: draft.y },
      raw,
      width: Math.max(draft.width ?? 0, size.width),
      height: Math.max(draft.height ?? 0, size.height),
      align: draft.align ?? 'left'
    };
  }

  private createGraphDraft(point: WhiteboardPoint): GraphDraft {
    return {
      x: point.x,
      y: point.y,
      width: 460,
      height: 320,
      title: 'Function graph',
      expression: 'x^2',
      xMin: -10,
      xMax: 10,
      yMin: -10,
      yMax: 10,
      showGrid: true,
      showAxes: true,
      showTicks: true,
      tickStep: '',
      curveColor: this.strokeColor(),
      lineWidth: Math.max(2, this.strokeWidth()),
      pointX: '',
      tangentX: '',
      shadeFrom: '',
      shadeTo: '',
      showIntercepts: false,
      inequality: '',
      parametricX: '',
      parametricY: '',
      parametricTMin: '0',
      parametricTMax: String(Number((Math.PI * 2).toFixed(4))),
      polarExpression: '',
      polarThetaMin: '0',
      polarThetaMax: String(Number((Math.PI * 2).toFixed(4))),
      scatterPoints: '',
      histogramData: '',
      histogramBins: '',
      showRegression: false,
      normalMean: '',
      normalStdDev: '',
      labels: ''
    };
  }

  private createGraphElement(draft: GraphDraft): WhiteboardGraphElement {
    const expressions = this.parseGraphFunctionList(draft.expression);
    const primaryColor = draft.curveColor;
    const secondaryColors = ['#F26076', '#FF9760', '#458B73', '#7c3aed', '#0f5bf1'];
    return {
      id: draft.elementId ?? this.createElementId(),
      type: 'graph',
      position: { x: draft.x, y: draft.y },
      width: Math.max(220, draft.width),
      height: Math.max(180, draft.height),
      title: draft.title.trim(),
      xMin: draft.xMin,
      xMax: draft.xMax,
      yMin: draft.yMin,
      yMax: draft.yMax,
      showGrid: draft.showGrid,
      showAxes: draft.showAxes,
      showTicks: draft.showTicks,
      tickStep: this.optionalNumber(draft.tickStep),
      functions: expressions.map((expression, index) => ({
        id: `fn-${index + 1}`,
        expression,
        color: index === 0 ? primaryColor : secondaryColors[(index - 1) % secondaryColors.length]!,
        width: Math.max(1, draft.lineWidth)
      })),
      inequality: draft.inequality.trim(),
      parametric: this.createParametricPlot(draft),
      polar: this.createPolarPlot(draft),
      scatterPoints: draft.scatterPoints.trim(),
      scatterColor: '#FF9760',
      labels: this.parseGraphLabels(draft.labels),
      stats: {
        histogramData: draft.histogramData.trim(),
        histogramBins: this.optionalPositiveInteger(draft.histogramBins),
        showRegression: draft.showRegression,
        normalMean: this.optionalNumber(draft.normalMean),
        normalStdDev: this.optionalNumber(draft.normalStdDev)
      },
      helpers: {
        pointX: this.optionalNumber(draft.pointX),
        tangentX: this.optionalNumber(draft.tangentX),
        shadeFrom: this.optionalNumber(draft.shadeFrom),
        shadeTo: this.optionalNumber(draft.shadeTo),
        showIntercepts: draft.showIntercepts
      }
    };
  }

  private createParametricPlot(draft: GraphDraft): WhiteboardGraphParametricPlot | null {
    if (!draft.parametricX.trim() && !draft.parametricY.trim()) {
      return null;
    }
    return {
      xExpression: draft.parametricX.trim(),
      yExpression: draft.parametricY.trim(),
      tMin: Number(draft.parametricTMin),
      tMax: Number(draft.parametricTMax),
      color: '#458B73',
      width: Math.max(1, draft.lineWidth)
    };
  }

  private createPolarPlot(draft: GraphDraft): WhiteboardGraphPolarPlot | null {
    if (!draft.polarExpression.trim()) {
      return null;
    }
    return {
      expression: draft.polarExpression.trim(),
      thetaMin: Number(draft.polarThetaMin),
      thetaMax: Number(draft.polarThetaMax),
      color: '#FF9760',
      width: Math.max(1, draft.lineWidth)
    };
  }

  private validateGraphDraft(draft: GraphDraft): string | null {
    if (
      !draft.expression.trim() &&
      !draft.parametricX.trim() &&
      !draft.parametricY.trim() &&
      !draft.polarExpression.trim() &&
      !draft.scatterPoints.trim() &&
      !draft.histogramData.trim() &&
      !draft.normalMean.trim()
    ) {
      return 'Enter a function, curve, scatter data, histogram data, or normal curve.';
    }
    if (![draft.xMin, draft.xMax, draft.yMin, draft.yMax, draft.width, draft.height, draft.lineWidth].every(Number.isFinite)) {
      return 'Graph values must be valid numbers.';
    }
    if (draft.xMin >= draft.xMax || draft.yMin >= draft.yMax) {
      return 'Min values must be lower than max values.';
    }
    if (Math.abs(draft.xMax - draft.xMin) > 100000 || Math.abs(draft.yMax - draft.yMin) > 100000) {
      return 'Graph range is too large.';
    }
    for (const expression of this.parseGraphFunctionList(draft.expression)) {
      const parsed = this.parseGraphExpression(expression);
      if (parsed.error) {
        return parsed.error;
      }
    }
    const optionalValues = [
      draft.tickStep,
      draft.pointX,
      draft.tangentX,
      draft.shadeFrom,
      draft.shadeTo,
      draft.parametricTMin,
      draft.parametricTMax,
      draft.polarThetaMin,
      draft.polarThetaMax,
      draft.histogramBins,
      draft.normalMean,
      draft.normalStdDev
    ].filter((value) => value.trim());
    if (optionalValues.some((value) => !Number.isFinite(Number(value)))) {
      return 'Graph helper values must be numbers.';
    }
    if (draft.tickStep.trim() && Number(draft.tickStep) <= 0) {
      return 'Tick spacing must be greater than zero.';
    }
    if (draft.parametricX.trim() || draft.parametricY.trim()) {
      if (!draft.parametricX.trim() || !draft.parametricY.trim()) {
        return 'Parametric plots need both x(t) and y(t).';
      }
      const parsedX = this.parseGraphExpression(draft.parametricX, 't');
      const parsedY = this.parseGraphExpression(draft.parametricY, 't');
      if (parsedX.error || parsedY.error) {
        return parsedX.error ?? parsedY.error ?? 'Invalid parametric curve.';
      }
      if (Number(draft.parametricTMin) >= Number(draft.parametricTMax)) {
        return 'Parametric t min must be lower than t max.';
      }
    }
    if (draft.polarExpression.trim()) {
      const parsedPolar = this.parseGraphExpression(draft.polarExpression, 'theta');
      if (parsedPolar.error) {
        return parsedPolar.error;
      }
      if (Number(draft.polarThetaMin) >= Number(draft.polarThetaMax)) {
        return 'Polar theta min must be lower than theta max.';
      }
    }
    if (draft.inequality.trim()) {
      const inequalityError = this.validateInequalitySource(draft.inequality);
      if (inequalityError) {
        return inequalityError;
      }
    }
    if (draft.scatterPoints.trim() && !this.parseScatterPoints(draft.scatterPoints).length) {
      return 'Scatter points should look like: 1,2; 2,4; 3,5.';
    }
    if (draft.histogramData.trim() && !this.parseNumberList(draft.histogramData).length) {
      return 'Histogram data should be comma or space separated numbers.';
    }
    if (draft.normalMean.trim() || draft.normalStdDev.trim()) {
      if (!draft.normalMean.trim() || !draft.normalStdDev.trim()) {
        return 'Normal curve needs both mean and standard deviation.';
      }
      if (Number(draft.normalStdDev) <= 0) {
        return 'Normal curve standard deviation must be greater than zero.';
      }
    }
    if (draft.labels.trim() && !this.parseGraphLabels(draft.labels).length) {
      return 'Labels should look like: 0,0,Origin.';
    }
    return null;
  }

  private openGraphDraftForElement(element: WhiteboardGraphElement): void {
    const primaryFunction = element.functions[0];
    this.graphDraft.set({
      elementId: element.id,
      x: element.position.x,
      y: element.position.y,
      width: element.width,
      height: element.height,
      title: element.title ?? '',
      expression: primaryFunction?.expression ?? 'x',
      xMin: element.xMin,
      xMax: element.xMax,
      yMin: element.yMin,
      yMax: element.yMax,
      showGrid: element.showGrid,
      showAxes: element.showAxes,
      showTicks: element.showTicks,
      tickStep: this.optionalNumberText(element.tickStep),
      curveColor: primaryFunction?.color ?? this.strokeColor(),
      lineWidth: primaryFunction?.width ?? this.strokeWidth(),
      pointX: this.optionalNumberText(element.helpers?.pointX),
      tangentX: this.optionalNumberText(element.helpers?.tangentX),
      shadeFrom: this.optionalNumberText(element.helpers?.shadeFrom),
      shadeTo: this.optionalNumberText(element.helpers?.shadeTo),
      showIntercepts: !!element.helpers?.showIntercepts,
      inequality: element.inequality ?? '',
      parametricX: element.parametric?.xExpression ?? '',
      parametricY: element.parametric?.yExpression ?? '',
      parametricTMin: this.optionalNumberText(element.parametric?.tMin) || '0',
      parametricTMax: this.optionalNumberText(element.parametric?.tMax) || String(Number((Math.PI * 2).toFixed(4))),
      polarExpression: element.polar?.expression ?? '',
      polarThetaMin: this.optionalNumberText(element.polar?.thetaMin) || '0',
      polarThetaMax: this.optionalNumberText(element.polar?.thetaMax) || String(Number((Math.PI * 2).toFixed(4))),
      scatterPoints: element.scatterPoints ?? '',
      histogramData: element.stats?.histogramData ?? '',
      histogramBins: this.optionalNumberText(element.stats?.histogramBins),
      showRegression: !!element.stats?.showRegression,
      normalMean: this.optionalNumberText(element.stats?.normalMean),
      normalStdDev: this.optionalNumberText(element.stats?.normalStdDev),
      labels: this.serializeGraphLabels(element.labels ?? [])
    });
    this.strokeColor.set(primaryFunction?.color ?? this.strokeColor());
  }

  private editableSelectedGraph(): WhiteboardGraphElement | null {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length !== 1) {
      return null;
    }
    const element = this.elements.find((item) => item.id === selectedIds[0]);
    return element?.type === 'graph' ? element : null;
  }

  private editableSelectedElement(): WhiteboardTextElement | WhiteboardEquationElement | null {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length !== 1) {
      return null;
    }
    const element = this.elements.find((item) => item.id === selectedIds[0]);
    return element && this.isEditableTextBlock(element) ? element : null;
  }

  private isEditableTextBlock(element: WhiteboardElement): element is WhiteboardTextElement | WhiteboardEquationElement {
    return element.type === 'text' || element.type === 'equation';
  }

  private openTextDraftForElement(element: WhiteboardTextElement | WhiteboardEquationElement): void {
    const bounds = this.boundsForElement(element);
    this.textDraft.set({
      x: element.position.x,
      y: element.position.y,
      value: element.type === 'equation' ? element.raw : element.text,
      mode: element.type,
      elementId: element.id,
      width: bounds.width,
      height: bounds.height,
      align: element.align ?? 'left'
    });
    this.strokeColor.set(element.color);
    if (element.fillColor) {
      this.fillColor.set(element.fillColor);
      this.fillEnabled.set(true);
    }
    this.fontSize.set(element.fontSize);
    if (element.type === 'equation') {
      this.mathEquationAlignment.set(element.align ?? 'left');
    }
    window.setTimeout(() => {
      const editor = this.textEditor?.nativeElement;
      editor?.focus();
      editor?.select();
    });
  }

  private createElementId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `whiteboard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private createPage(title: string, template: WhiteboardTemplateId = DEFAULT_TEMPLATE_ID): WhiteboardPage {
    return {
      id: this.createElementId(),
      title,
      tags: [],
      template,
      view: { ...DEFAULT_PAGE_VIEW },
      background: null,
      elements: []
    };
  }

  private normalizeTemplateId(template: unknown): WhiteboardTemplateId {
    return typeof template === 'string' && this.templateOptions.some((option) => option.id === template)
      ? (template as WhiteboardTemplateId)
      : DEFAULT_TEMPLATE_ID;
  }

  private normalizePageView(view: unknown): WhiteboardPageView {
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      return { ...DEFAULT_PAGE_VIEW };
    }
    const record = view as Partial<Record<keyof WhiteboardPageView, unknown>>;
    return {
      zoom: Number.isFinite(Number(record.zoom)) ? Number(record.zoom) : DEFAULT_PAGE_VIEW.zoom,
      panX: Number.isFinite(Number(record.panX)) ? Number(record.panX) : DEFAULT_PAGE_VIEW.panX,
      panY: Number.isFinite(Number(record.panY)) ? Number(record.panY) : DEFAULT_PAGE_VIEW.panY
    };
  }

  private normalizePageBackground(background: unknown): WhiteboardPageBackground | null {
    if (!background || typeof background !== 'object' || Array.isArray(background)) {
      return null;
    }
    const record = background as Partial<WhiteboardPageBackground>;
    return record.kind === 'image' && typeof record.dataUrl === 'string' ? (structuredClone(record) as WhiteboardPageBackground) : null;
  }

  private normalizePageTags(value: string | string[] | undefined): string[] {
    const source = Array.isArray(value) ? value : String(value ?? '').split(',');
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of source) {
      const tag = item.trim().replace(/\s+/g, ' ').slice(0, 32);
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) {
        continue;
      }
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 8) {
        break;
      }
    }
    return tags;
  }

  private clonePage(page: WhiteboardPage): WhiteboardPage {
    return {
      ...structuredClone(page),
      tags: page.tags ? [...page.tags] : [],
      template: page.template ?? DEFAULT_TEMPLATE_ID,
      view: { ...(page.view ?? DEFAULT_PAGE_VIEW) },
      background: page.background ? { ...page.background } : null
    };
  }

  private cloneElementsForPageDuplicate(elements: WhiteboardElement[]): WhiteboardElement[] {
    const groupMap = new Map<string, string>();
    return elements.map((element) => {
      const next = this.cloneElement(element);
      next.id = this.createElementId();
      if (next.groupId) {
        const groupId = groupMap.get(next.groupId) ?? this.createElementId();
        groupMap.set(next.groupId, groupId);
        next.groupId = groupId;
      }
      return next;
    });
  }

  private uniquePageTitle(title: string): string {
    const existing = new Set(this.pages().map((page) => page.title.toLowerCase()));
    let candidate = title.trim() || 'Board';
    let suffix = 2;
    while (existing.has(candidate.toLowerCase())) {
      candidate = `${title} ${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private persistActivePageView(): void {
    const activePageId = this.activePageId();
    const view: WhiteboardPageView = {
      zoom: this.zoom(),
      panX: this.panX(),
      panY: this.panY()
    };
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, view } : page)));
  }

  private applyPageView(page: WhiteboardPage): void {
    const view = page.view ?? DEFAULT_PAGE_VIEW;
    this.zoom.set(view.zoom ?? DEFAULT_PAGE_VIEW.zoom);
    this.panX.set(view.panX ?? DEFAULT_PAGE_VIEW.panX);
    this.panY.set(view.panY ?? DEFAULT_PAGE_VIEW.panY);
  }

  private ensureActivePage(): void {
    if (!this.pages().some((page) => page.id === this.activePageId())) {
      this.activePageId.set(this.pages()[0]!.id);
    }
  }

  private setSelection(ids: string[]): void {
    this.selectedElementIds.set([...new Set(ids)]);
    this.syncStyleFromSelection();
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
    if (element.type === 'geometry') {
      return this.geometryContainsPoint(element, point);
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

  private geometryContainsPoint(element: WhiteboardGeometryElement, point: WhiteboardPoint): boolean {
    const tolerance = Math.max(10, element.width + 6);
    if (element.kind === 'point') {
      return this.distance(point, element.from) <= tolerance;
    }
    if (element.kind === 'circle' || element.kind === 'arc') {
      const radius = this.distance(element.from, element.to);
      const distanceFromCenter = this.distance(point, element.from);
      return Math.abs(distanceFromCenter - radius) <= tolerance || (!!element.fillColor && distanceFromCenter <= radius);
    }
    return this.distanceToSegment(point, element.from, element.to) <= tolerance || this.rectContainsPoint(this.expandBounds(this.boundsForElement(element), tolerance), point);
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
    } else if (element.type === 'shape' || element.type === 'geometry') {
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
      } else if (element.type === 'graph') {
        currentColor = element.functions[0]?.color ?? color;
        nextElement = {
          ...element,
          functions: element.functions.map((fn, index) => (index === 0 ? { ...fn, color } : fn))
        };
      } else if (element.type === 'geometry' || element.type === 'diagram') {
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

  private canElementReceiveFill(
    element: WhiteboardElement
  ): element is WhiteboardStrokeElement | WhiteboardShapeElement | WhiteboardTextElement | WhiteboardEquationElement | WhiteboardGeometryElement | WhiteboardDiagramElement {
    return (
      (element.type === 'stroke' && !!this.strokeFillPath(element)) ||
      (element.type === 'shape' && this.isFillableShape(element.shape)) ||
      element.type === 'geometry' ||
      element.type === 'diagram' ||
      element.type === 'text' ||
      element.type === 'equation'
    );
  }

  private eraseAlongPath(from: WhiteboardPoint, to: WhiteboardPoint): void {
    const radius = this.eraserRadius();
    const mode = this.eraserMode();
    const nextElements: WhiteboardElement[] = [];
    const commands: WhiteboardCommand[] = [];
    let changed = false;

    for (const element of this.elements) {
      if (element.type === 'stroke') {
        if (mode === 'stroke' && this.strokeIntersectsEraser(element, from, to, radius)) {
          changed = true;
          commands.push({ type: 'delete', elementId: element.id, pageId: this.activePageId() });
          continue;
        }
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

  private strokeIntersectsEraser(element: WhiteboardStrokeElement, from: WhiteboardPoint, to: WhiteboardPoint, radius: number): boolean {
    const threshold = radius + element.width / 2;
    if (element.points.length <= 1) {
      return this.distanceToSegment(element.points[0]!, from, to) <= threshold;
    }
    for (let index = 0; index < element.points.length - 1; index += 1) {
      if (this.segmentDistance(element.points[index]!, element.points[index + 1]!, from, to) <= threshold) {
        return true;
      }
    }
    return false;
  }

  private elementIntersectsEraser(element: Exclude<WhiteboardElement, WhiteboardStrokeElement>, from: WhiteboardPoint, to: WhiteboardPoint, radius: number): boolean {
    if (element.type === 'shape' && (element.shape === 'line' || element.shape === 'arrow')) {
      return this.segmentDistance(element.from, element.to, from, to) <= radius + element.width / 2;
    }
    return this.pathIntersectsBounds(from, to, this.expandBounds(this.boundsForElement(element), radius));
  }

  private eraserRadius(): number {
    const size = this.eraserSize();
    return this.eraserMode() === 'area' ? Math.round(size * 1.45) : size;
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

  private drawSnapIndicator(): void {
    const context = this.context;
    const point = this.snapIndicator();
    if (!context || !point) {
      return;
    }
    context.save();
    context.strokeStyle = this.cssVariable('--wb-live', '#FF9760');
    context.fillStyle = this.cssVariable('--wb-attention', '#FFD150');
    context.lineWidth = 1.5;
    context.globalAlpha = 0.92;
    context.beginPath();
    context.arc(point.x, point.y, 7, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(point.x - 11, point.y);
    context.lineTo(point.x - 4, point.y);
    context.moveTo(point.x + 4, point.y);
    context.lineTo(point.x + 11, point.y);
    context.moveTo(point.x, point.y - 11);
    context.lineTo(point.x, point.y - 4);
    context.moveTo(point.x, point.y + 4);
    context.lineTo(point.x, point.y + 11);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  private drawEraserCursor(): void {
    const context = this.context;
    const point = this.eraserCursor();
    if (!context || !point || this.activeTool() !== 'eraser' || this.readOnly()) {
      return;
    }
    const radius = this.eraserRadius();
    context.save();
    context.strokeStyle = this.cssVariable('--wb-primary', '#F26076');
    context.fillStyle = this.cssVariable('--accent-soft', 'rgba(242, 96, 118, 0.12)');
    context.lineWidth = 1.5;
    context.setLineDash(this.eraserMode() === 'stroke' ? [5, 4] : []);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = this.cssVariable('--wb-primary', '#F26076');
    context.beginPath();
    context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    context.fill();
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
    if (element.type === 'geometry') {
      const padding = Math.max(12, element.width + 8);
      if (element.kind === 'circle' || element.kind === 'arc' || element.kind === 'protractor' || element.kind === 'polygon') {
        const radius = Math.max(1, this.distance(element.from, element.to));
        return { x: element.from.x - radius - padding, y: element.from.y - radius - padding, width: radius * 2 + padding * 2, height: radius * 2 + padding * 2 };
      }
      const x = Math.min(element.from.x, element.to.x) - padding;
      const y = Math.min(element.from.y, element.to.y) - padding;
      return {
        x,
        y,
        width: Math.max(1, Math.abs(element.to.x - element.from.x)) + padding * 2,
        height: Math.max(1, Math.abs(element.to.y - element.from.y)) + padding * 2
      };
    }
    if (element.type === 'equation' || element.type === 'graph' || element.type === 'diagram') {
      return { x: element.position.x, y: element.position.y, width: element.width, height: element.height };
    }
    if (element.type === 'file') {
      return { x: element.position.x, y: element.position.y, width: element.width, height: element.height };
    }
    const context = this.context;
    const lines = element.text.split('\n');
    const width = context ? this.measureTextWidth(context, element) : Math.max(...lines.map((line) => line.length)) * element.fontSize * 0.58;
    const height = Math.max(1, lines.length) * element.fontSize * 1.25;
    return {
      x: element.position.x,
      y: element.position.y,
      width: Math.max(width, element.width ?? 0),
      height: Math.max(height, element.height ?? 0)
    };
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
    } else if (next.type === 'shape' || next.type === 'geometry') {
      next.from = mapPoint(next.from);
      next.to = mapPoint(next.to);
    } else {
      next.position = mapPoint(next.position);
      if (next.type === 'text') {
        next.fontSize = Math.max(8, next.fontSize * Math.max(scaleX, scaleY));
        next.width = Math.max(24, (next.width ?? fromBounds.width) * scaleX);
        next.height = Math.max(18, (next.height ?? fromBounds.height) * scaleY);
      } else if (next.type === 'equation') {
        next.width *= scaleX;
        next.height *= scaleY;
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
    } else if (next.type === 'shape' || next.type === 'geometry') {
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
    if (next.type === 'geometry') {
      next.from = rotatePoint(next.from);
      next.to = rotatePoint(next.to);
      return next;
    }

    const elementBounds = this.boundsForElement(next);
    const center = rotatePoint({
      x: elementBounds.x + elementBounds.width / 2,
      y: elementBounds.y + elementBounds.height / 2
    });
    if (next.type === 'file' || next.type === 'equation' || next.type === 'graph' || next.type === 'diagram') {
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

  private snapPoint(point: WhiteboardPoint, origin?: WhiteboardPoint): WhiteboardPoint {
    if (!this.snapToGrid() && !this.snapToPoints()) {
      this.snapIndicator.set(null);
      return point;
    }
    const target = this.snapToPoints() ? this.nearestSnapTarget(point) : null;
    let snapped = target ?? (this.snapToGrid()
      ? {
          x: Math.round(point.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(point.y / GRID_SIZE) * GRID_SIZE
        }
      : { ...point });
    const angleSnap = this.angleSnapDegrees();
    if (origin && angleSnap > 0 && (this.snapToGrid() || this.snapToPoints()) && !target && this.distance(origin, snapped) > 2) {
      const distance = this.distance(origin, point);
      const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
      const increment = (angleSnap * Math.PI) / 180;
      const snappedAngle = Math.round(angle / increment) * increment;
      snapped = {
        x: origin.x + Math.cos(snappedAngle) * distance,
        y: origin.y + Math.sin(snappedAngle) * distance
      };
    }
    this.snapIndicator.set(this.distance(point, snapped) > 0.5 ? snapped : null);
    return snapped;
  }

  private nearestSnapTarget(point: WhiteboardPoint): WhiteboardPoint | null {
    const tolerance = Math.max(8, 12 / this.zoom());
    let best: { point: WhiteboardPoint; distance: number } | null = null;
    for (const target of this.snapTargets()) {
      const distance = this.distance(point, target);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { point: target, distance };
      }
    }
    return best ? { ...best.point } : null;
  }

  private snapTargets(): WhiteboardPoint[] {
    const targets: WhiteboardPoint[] = [];
    const addBoundsTargets = (bounds: ElementBounds): void => {
      targets.push(
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x, y: bounds.y + bounds.height },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      );
    };
    for (const element of this.elements) {
      if (element.type === 'stroke') {
        if (!element.points.length) {
          continue;
        }
        targets.push(element.points[0]!, element.points[element.points.length - 1]!);
        for (let index = 4; index < element.points.length; index += 8) {
          targets.push(element.points[index]!);
        }
        continue;
      }
      if (element.type === 'shape') {
        targets.push(element.from, element.to, this.midpoint(element.from, element.to));
        if (element.shape !== 'line' && element.shape !== 'arrow') {
          addBoundsTargets(this.boundsForElement(element));
        }
        continue;
      }
      if (element.type === 'geometry') {
        targets.push(element.from, element.to, this.midpoint(element.from, element.to));
        if (element.kind === 'polygon') {
          targets.push(...this.regularPolygonVertices(element.from, element.to, 6));
        }
        if (element.kind === 'circle' || element.kind === 'arc') {
          const radius = this.distance(element.from, element.to);
          targets.push(
            { x: element.from.x + radius, y: element.from.y },
            { x: element.from.x - radius, y: element.from.y },
            { x: element.from.x, y: element.from.y + radius },
            { x: element.from.x, y: element.from.y - radius }
          );
        }
        continue;
      }
      addBoundsTargets(this.boundsForElement(element));
    }
    return targets.filter(Boolean);
  }

  private selectedElements(): WhiteboardElement[] {
    const selectedIds = this.selectedElementIds();
    return this.elements.filter((element) => selectedIds.includes(element.id));
  }

  private singleSelectedEquation(): WhiteboardEquationElement | null {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length !== 1) {
      return null;
    }
    const element = this.elements.find((item) => item.id === selectedIds[0]);
    return element?.type === 'equation' ? element : null;
  }

  private singleSelectedText(): WhiteboardTextElement | null {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length !== 1) {
      return null;
    }
    const element = this.elements.find((item) => item.id === selectedIds[0]);
    return element?.type === 'text' ? element : null;
  }

  private syncStyleFromSelection(): void {
    const selected = this.selectedElements();
    if (!selected.length) {
      return;
    }
    const firstStrokeColor = this.strokeColorForElement(selected[0]!);
    if (firstStrokeColor) {
      this.strokeColor.set(firstStrokeColor);
    }
    const fillable = selected.find((element) => this.canElementReceiveFill(element));
    if (!fillable || !('fillColor' in fillable)) {
      return;
    }
    const selectedFill = fillable.fillColor ?? null;
    this.fillEnabled.set(Boolean(selectedFill));
    if (selectedFill) {
      this.fillColor.set(selectedFill);
    }
  }

  private strokeColorForElement(element: WhiteboardElement): string | null {
    if (element.type === 'shape' || element.type === 'geometry' || element.type === 'diagram') {
      return element.strokeColor;
    }
    if (element.type === 'graph') {
      return element.functions[0]?.color ?? null;
    }
    if (element.type === 'file') {
      return null;
    }
    return element.color;
  }

  private normalizeColor(color: string): string {
    const preset = this.colors.find((item) => item.toLowerCase() === color.toLowerCase());
    return preset ?? color;
  }

  private rememberColor(color: string): void {
    if (this.colors.some((preset) => preset.toLowerCase() === color.toLowerCase())) {
      return;
    }
    this.recentColors.update((colors) => [color, ...colors.filter((item) => item.toLowerCase() !== color.toLowerCase())].slice(0, RECENT_COLOR_LIMIT));
  }

  private pushHistory(): void {
    this.persistActivePageView();
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
    return pages.map((page) => this.clonePage(page));
  }

  private pruneImageCache(): void {
    const liveDataUrls = new Set<string>();
    for (const page of this.pages()) {
      if (page.background?.dataUrl) {
        liveDataUrls.add(page.background.dataUrl);
      }
      for (const element of page.elements) {
        if (element.type === 'file' && element.kind === 'image') {
          liveDataUrls.add(element.dataUrl);
        }
      }
    }
    for (const dataUrl of this.imageCache.keys()) {
      if (!liveDataUrls.has(dataUrl)) {
        this.imageCache.delete(dataUrl);
      }
    }
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
    const width = Math.max(...element.text.split('\n').map((line) => context.measureText(line).width));
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

  protected isGeometryTool(tool: WhiteboardTool): tool is WhiteboardGeometryTool {
    return (
      tool === 'segment' ||
      tool === 'ruler' ||
      tool === 'protractor' ||
      tool === 'angle' ||
      tool === 'circle' ||
      tool === 'arc' ||
      tool === 'perpendicular' ||
      tool === 'parallel' ||
      tool === 'midpoint' ||
      tool === 'point' ||
      tool === 'vector' ||
      tool === 'polygon'
    );
  }

  protected isDiagramTool(tool: WhiteboardTool): tool is WhiteboardDiagramTool {
    return (
      tool === 'venn' ||
      tool === 'node-edge' ||
      tool === 'tree' ||
      tool === 'flow' ||
      tool === 'probability-tree' ||
      tool === 'coordinate-axes' ||
      tool === 'number-line-template' ||
      tool === 'table-layout' ||
      tool === 'fraction-bars'
    );
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
    return (
      (element.type === 'shape' && bounds.width < 3 && bounds.height < 3) ||
      (element.type === 'geometry' && element.kind !== 'point' && this.distance(element.from, element.to) < 3)
    );
  }

  private setZoom(value: number): void {
    this.zoom.set(Math.min(Math.max(Number(value.toFixed(2)), 0.5), 2.5));
    this.persistActivePageView();
  }

  private renderPageImage(pageId: string, type: 'image/png' | 'image/jpeg', quality?: number): string {
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return '';
    }
    const previousPageId = this.activePageId();
    const previousSelection = this.selectedElementIds();
    const previousPreview = this.previewElement;
    this.previewElement = null;
    this.activePageId.set(pageId);
    this.selectedElementIds.set([]);
    this.render(false);
    const dataUrl = canvas.toDataURL(type, quality);
    this.activePageId.set(previousPageId);
    this.selectedElementIds.set(previousSelection);
    this.previewElement = previousPreview;
    this.render();
    return dataUrl;
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

  private safeFileName(value: string): string {
    return value
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'whiteboard';
  }

  private createPdfBlob(pages: PdfImagePage[]): Blob {
    const encoder = new TextEncoder();
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
    const pageIds = pages.map((_, index) => 3 + index * 3);
    writeObject(2, [`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
    pages.forEach((page, index) => {
      const pageObjectId = 3 + index * 3;
      const imageObjectId = pageObjectId + 1;
      const contentObjectId = pageObjectId + 2;
      const imageName = `Im${index}`;
      const imageBytes = this.base64ToBytes(page.jpegDataUrl.split(',')[1] ?? '');
      const content = `q ${page.width} 0 0 ${page.height} 0 0 cm /${imageName} Do Q`;
      writeObject(pageObjectId, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /${imageName} ${imageObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`
      ]);
      writeObject(imageObjectId, [
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
        imageBytes,
        '\nendstream'
      ]);
      writeObject(contentObjectId, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    });

    const xrefOffset = byteOffset;
    const objectCount = 2 + pages.length * 3;
    write(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
    for (let objectId = 1; objectId <= objectCount; objectId += 1) {
      write(`${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`);
    }
    write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
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

class GraphExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: GraphToken[],
    private readonly variableName: 'x' | 't' | 'theta' = 'x'
  ) {}

  parse(): GraphAstNode {
    const expression = this.parseAdditive();
    if (this.peek().type !== 'eof') {
      throw new Error(`Unexpected "${this.peek().value}".`);
    }
    return expression;
  }

  private parseAdditive(): GraphAstNode {
    let node = this.parseMultiplicative();
    while (this.matchOperator('+') || this.matchOperator('-')) {
      const operator = this.previous().value as '+' | '-';
      const right = this.parseMultiplicative();
      node = { type: 'binary', operator, left: node, right };
    }
    return node;
  }

  private parseMultiplicative(): GraphAstNode {
    let node = this.parsePower();
    while (this.matchOperator('*') || this.matchOperator('/') || this.canStartImplicitFactor()) {
      const explicit = this.previousIfOperator('*', '/');
      const operator = explicit?.value === '/' ? '/' : '*';
      const right = this.parsePower();
      node = { type: 'binary', operator, left: node, right };
    }
    return node;
  }

  private parsePower(): GraphAstNode {
    let node = this.parseUnary();
    if (this.matchOperator('^')) {
      node = { type: 'binary', operator: '^', left: node, right: this.parsePower() };
    }
    return node;
  }

  private parseUnary(): GraphAstNode {
    if (this.matchOperator('+') || this.matchOperator('-')) {
      const operator = this.previous().value as '+' | '-';
      return { type: 'unary', operator, argument: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): GraphAstNode {
    const token = this.peek();
    if (this.match('number')) {
      const value = Number(token.value);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number "${token.value}".`);
      }
      return { type: 'number', value };
    }
    if (this.match('identifier')) {
      const name = token.value;
      if (name === this.variableName || (this.variableName === 'theta' && name === 't')) {
        return { type: 'variable' };
      }
      if (name === 'pi') {
        return { type: 'number', value: Math.PI };
      }
      if (name === 'e') {
        return { type: 'number', value: Math.E };
      }
      if (!this.matchParen('(')) {
        throw new Error(`Use ${name}(x) for functions.`);
      }
      const argument = this.parseAdditive();
      if (!this.matchParen(')')) {
        throw new Error(`Missing ")" after ${name}.`);
      }
      if (!['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'ln', 'log', 'sqrt', 'abs'].includes(name)) {
        throw new Error(`Unsupported function "${name}".`);
      }
      return { type: 'call', name, argument };
    }
    if (this.matchParen('(')) {
      const expression = this.parseAdditive();
      if (!this.matchParen(')')) {
        throw new Error('Missing ")".');
      }
      return expression;
    }
    throw new Error('Invalid graph expression.');
  }

  private canStartImplicitFactor(): boolean {
    const token = this.peek();
    return token.type === 'number' || token.type === 'identifier' || (token.type === 'paren' && token.value === '(');
  }

  private match(type: GraphTokenType): boolean {
    if (this.peek().type !== type) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private matchOperator(...operators: Array<'+' | '-' | '*' | '/' | '^'>): boolean {
    const token = this.peek();
    if (token.type !== 'operator' || !operators.includes(token.value as '+' | '-' | '*' | '/' | '^')) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private matchParen(paren: '(' | ')'): boolean {
    const token = this.peek();
    if (token.type !== 'paren' || token.value !== paren) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private previousIfOperator(...operators: Array<'*' | '/'>): GraphToken | null {
    const token = this.previous();
    return token.type === 'operator' && operators.includes(token.value as '*' | '/') ? token : null;
  }

  private peek(): GraphToken {
    return this.tokens[this.index] ?? { type: 'eof', value: '' };
  }

  private previous(): GraphToken {
    return this.tokens[Math.max(0, this.index - 1)] ?? { type: 'eof', value: '' };
  }
}
