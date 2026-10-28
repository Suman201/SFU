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
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs' with { loader: 'file' };

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
  | 'matrix'
  | 'table'
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
export type WhiteboardMatrixBracket = 'bracket' | 'parentheses' | 'determinant' | 'none';
export type WhiteboardPenStyle = 'solid' | 'dashed' | 'dotted' | 'marker' | 'pencil' | 'calligraphy';

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardStrokePoint extends WhiteboardPoint {
  pressure?: number;
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
  points: WhiteboardStrokePoint[];
  penStyle?: WhiteboardPenStyle;
  style?: WhiteboardPenStyle;
  opacity?: number;
  smoothing?: number;
  pressureEnabled?: boolean;
  pressureSensitive?: boolean;
  closed?: boolean;
  autoCloseThreshold?: number;
}

export interface WhiteboardShapeElement extends WhiteboardElementBase {
  type: 'shape';
  shape: WhiteboardShapeTool;
  strokeColor: string;
  fillColor: string | null;
  width: number;
  from: WhiteboardPoint;
  to: WhiteboardPoint;
  text?: string;
  textColor?: string;
  fontSize?: number;
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

export interface WhiteboardMatrixElement extends WhiteboardElementBase {
  type: 'matrix';
  position: WhiteboardPoint;
  width: number;
  height: number;
  rows: number;
  columns: number;
  cells: string[][];
  fontSize: number;
  strokeColor: string;
  fillColor?: string | null;
  textColor: string;
  borderColor: string;
  showBorders: boolean;
  align?: WhiteboardTextAlignment;
  bracketStyle: WhiteboardMatrixBracket;
  augmentedColumn?: number | null;
}

export interface WhiteboardTableElement extends WhiteboardElementBase {
  type: 'table';
  position: WhiteboardPoint;
  width: number;
  height: number;
  rows: number;
  columns: number;
  cells: string[][];
  fontSize: number;
  strokeColor: string;
  fillColor?: string | null;
  textColor: string;
  borderColor: string;
  showBorders: boolean;
  align?: WhiteboardTextAlignment;
  headerRow: boolean;
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
  | WhiteboardMatrixElement
  | WhiteboardTableElement
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
  elementIndex?: number;
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

export type WhiteboardPageMetadata = Omit<WhiteboardMemoryPage, 'elements'>;

export type WhiteboardCommand =
  | WhiteboardUpsertCommand
  | WhiteboardDeleteCommand
  | WhiteboardClearCommand
  | { type: 'page-upsert'; page: WhiteboardPageMetadata }
  | { type: 'page-delete'; pageId: string }
  | { type: 'page-select'; pageId: string };

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
  mode: 'text' | 'equation' | 'shape-text' | 'diagram-label';
  elementId?: string;
  labelIndex?: number;
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
type MathToolsTab = 'equation' | 'templates' | 'subjects' | 'snippets' | 'graph' | 'geometry' | 'tables';
type WhiteboardEraserMode = 'partial' | 'stroke' | 'area';
type MatrixTableMode = 'matrix' | 'table';
type SubjectTemplateCategoryId =
  | 'algebra'
  | 'calculus'
  | 'geometry'
  | 'physics'
  | 'chemistry'
  | 'economics'
  | 'coding'
  | 'probability'
  | 'statistics'
  | 'accounting';
type SubjectTemplateRegionKind = 'work' | 'formula' | 'graph' | 'table' | 'diagram' | 'list';
type SubjectTemplateInsertMode = 'page' | 'current' | 'object';

interface MatrixTableDraft {
  elementId?: string;
  mode: MatrixTableMode;
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number;
  columns: number;
  cells: string[][];
  fontSize: number;
  strokeColor: string;
  fillColor: string;
  fillEnabled: boolean;
  textColor: string;
  borderColor: string;
  showBorders: boolean;
  align: WhiteboardTextAlignment;
  headerRow: boolean;
  bracketStyle: WhiteboardMatrixBracket;
  augmentedColumn?: number | null;
  error?: string | null;
}

interface SubjectTemplateCategory {
  id: SubjectTemplateCategoryId;
  label: string;
  description: string;
}

interface SubjectTemplateGraphSpec {
  expression?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  scatterPoints?: string;
  histogramData?: string;
  histogramBins?: number;
  showRegression?: boolean;
  shadeFrom?: number;
  shadeTo?: number;
}

interface SubjectTemplateRegion {
  title: string;
  detail?: string;
  kind?: SubjectTemplateRegionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rows?: number;
  columns?: number;
  cells?: string[][];
  headerRow?: boolean;
  diagramKind?: WhiteboardDiagramTool;
  graph?: SubjectTemplateGraphSpec;
}

interface SubjectTemplateDefinition {
  id: string;
  categoryId: SubjectTemplateCategoryId;
  name: string;
  description: string;
  pageTitle: string;
  pageTemplate: WhiteboardTemplateId;
  tags: string[];
  accent: string;
  regions: SubjectTemplateRegion[];
  objectSupported?: boolean;
}

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
  vectorContent?: string;
}

interface PdfExportOption {
  id: PdfExportMode;
  label: string;
  description: string;
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

interface PenStyleOption {
  id: WhiteboardPenStyle;
  label: string;
  description: string;
}

interface PenAutoCloseThresholdOption {
  label: string;
  value: number;
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

type AssetImportMode = 'element' | 'background' | 'pdf-pages' | 'slide-pages' | 'deck-pages';
type AssetPageSourceType = 'image' | 'slide-image';
type PdfJsModule = typeof import('pdfjs-dist');
type PdfExportMode = 'hybrid' | 'raster';

const GRID_SIZE = 24;
const ALIGNMENT_TOLERANCE = 6;
// Leave room for the Socket.IO event envelope below its 1 MB default payload limit.
const MAX_IMPORTED_COMMAND_BYTES = 900_000;
const MAX_IMPORTED_SNAPSHOT_BYTES = 1_500_000;
const MAX_BOARD_PAGES = 80;
const MAX_BOARD_ELEMENTS = 2500;
const MAX_IMAGE_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_PDF_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_PRESENTATION_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_PDF_IMPORT_PAGES = 30;
const MAX_SLIDE_IMAGE_IMPORT_PAGES = 40;
const PDF_RENDER_MAX_DIMENSION = 1800;
const MATRIX_TABLE_MIN_ROWS = 1;
const MATRIX_TABLE_MAX_ROWS = 8;
const MATRIX_TABLE_MIN_COLUMNS = 1;
const MATRIX_TABLE_MAX_COLUMNS = 8;
const IMAGE_ASSET_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PRESENTATION_ASSET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint'
]);

const DEFAULT_TEMPLATE_ID: WhiteboardTemplateId = 'grid';
const DEFAULT_PAGE_VIEW: WhiteboardPageView = { zoom: 1, panX: 0, panY: 0 };
const PEN_STYLE_OPTIONS: PenStyleOption[] = [
  { id: 'solid', label: 'Solid', description: 'Clean continuous ink' },
  { id: 'dashed', label: 'Dashed', description: 'Segmented emphasis' },
  { id: 'dotted', label: 'Dotted', description: 'Point-by-point guide' },
  { id: 'marker', label: 'Marker', description: 'Translucent highlight' },
  { id: 'pencil', label: 'Pencil', description: 'Soft sketch line' },
  { id: 'calligraphy', label: 'Calligraphy', description: 'Angled variable stroke' }
];
const PEN_AUTO_CLOSE_THRESHOLDS: PenAutoCloseThresholdOption[] = [
  { label: 'Tight', value: 16 },
  { label: 'Normal', value: 28 },
  { label: 'Loose', value: 44 }
];
const PDF_EXPORT_OPTIONS: PdfExportOption[] = [
  {
    id: 'hybrid',
    label: 'Hybrid PDF',
    description: 'Raster backgrounds with selectable/vector board annotations where possible.'
  },
  {
    id: 'raster',
    label: 'Fast raster PDF',
    description: 'Exact canvas snapshots for maximum compatibility.'
  }
];
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
  { id: 'subjects', label: 'Subjects' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'graph', label: 'Graph' },
  { id: 'geometry', label: 'Geometry' },
  { id: 'tables', label: 'Matrices' }
];
const SUBJECT_TEMPLATE_CATEGORIES: SubjectTemplateCategory[] = [
  { id: 'algebra', label: 'Algebra', description: 'Solving, factoring, quadratics, and systems.' },
  { id: 'calculus', label: 'Calculus', description: 'Rules, limits, area, tangents, and secants.' },
  { id: 'geometry', label: 'Geometry', description: 'Proofs, constructions, triangles, and circles.' },
  { id: 'physics', label: 'Physics', description: 'Forces, motion, circuits, waves, and formula work.' },
  { id: 'chemistry', label: 'Chemistry', description: 'Equations, reactions, structures, and lab notes.' },
  { id: 'economics', label: 'Economics', description: 'Markets, curves, elasticity, and cost tables.' },
  { id: 'coding', label: 'Coding / CS', description: 'Flowcharts, pseudocode, recursion, data structures.' },
  { id: 'probability', label: 'Probability', description: 'Trees, Venn sets, sample spaces, and Bayes.' },
  { id: 'statistics', label: 'Statistics', description: 'Frequency, histograms, regression, and tests.' },
  { id: 'accounting', label: 'Accounting', description: 'Ledgers, journals, balances, and statements.' }
];
const SUBJECT_TEMPLATE_LIBRARY: SubjectTemplateDefinition[] = [
  {
    id: 'algebra-equation-solving',
    categoryId: 'algebra',
    name: 'Equation Solving Layout',
    description: 'Two-column setup for steps and reasoning.',
    pageTitle: 'Algebra - Equation Solving',
    pageTemplate: 'ruled',
    tags: ['algebra', 'equations'],
    accent: '#F26076',
    regions: [
      { title: 'Problem', detail: 'Write the original equation and constraints.', kind: 'formula', x: 60, y: 92, width: 680, height: 86 },
      { title: 'Steps', detail: 'Show one operation per line.', kind: 'work', x: 60, y: 200, width: 320, height: 310 },
      { title: 'Reasoning', detail: 'Inverse operation, property, or check.', kind: 'work', x: 420, y: 200, width: 320, height: 310 },
      { title: 'Solution check', detail: 'Substitute back into the original equation.', kind: 'formula', x: 60, y: 538, width: 680, height: 92 }
    ]
  },
  {
    id: 'algebra-factorization',
    categoryId: 'algebra',
    name: 'Factorization Workspace',
    description: 'Factor tree, identities, and final form.',
    pageTitle: 'Algebra - Factorization',
    pageTemplate: 'grid',
    tags: ['algebra', 'factorization'],
    accent: '#458B73',
    regions: [
      { title: 'Expression', detail: 'Copy the expression exactly.', kind: 'formula', x: 60, y: 90, width: 680, height: 76 },
      { title: 'Common factor / identity', detail: 'GCF, difference of squares, grouping.', kind: 'work', x: 60, y: 190, width: 320, height: 160 },
      { title: 'Factor tree / split', detail: 'Break terms or coefficients cleanly.', kind: 'diagram', diagramKind: 'tree', x: 420, y: 190, width: 320, height: 190 },
      { title: 'Final factored form', detail: 'Check by expansion.', kind: 'formula', x: 60, y: 410, width: 680, height: 120 }
    ]
  },
  {
    id: 'algebra-quadratic',
    categoryId: 'algebra',
    name: 'Quadratic Formula Workspace',
    description: 'Identify coefficients, discriminant, roots, and graph.',
    pageTitle: 'Algebra - Quadratic Formula',
    pageTemplate: 'coordinate',
    tags: ['algebra', 'quadratic'],
    accent: '#FF9760',
    regions: [
      { title: 'Standard form', detail: 'ax^2 + bx + c = 0', kind: 'formula', x: 60, y: 90, width: 300, height: 88 },
      { title: 'Coefficient table', kind: 'table', x: 60, y: 200, width: 300, height: 150, rows: 4, columns: 2, cells: [['a', ''], ['b', ''], ['c', ''], ['D = b^2 - 4ac', '']] },
      { title: 'Substitution', detail: 'x = (-b +/- sqrt(D)) / 2a', kind: 'formula', x: 60, y: 382, width: 300, height: 148 },
      { title: 'Parabola sketch', kind: 'graph', x: 410, y: 90, width: 340, height: 300, graph: { expression: 'x^2', xMin: -6, xMax: 6, yMin: -4, yMax: 12 } }
    ]
  },
  {
    id: 'algebra-systems',
    categoryId: 'algebra',
    name: 'Simultaneous Equations',
    description: 'Elimination/substitution layout with coordinate check.',
    pageTitle: 'Algebra - Simultaneous Equations',
    pageTemplate: 'coordinate',
    tags: ['algebra', 'systems'],
    accent: '#FFD150',
    regions: [
      { title: 'System', detail: 'Equation 1 / Equation 2', kind: 'formula', x: 60, y: 90, width: 310, height: 110 },
      { title: 'Elimination / substitution', detail: 'Align variables and solve.', kind: 'work', x: 60, y: 225, width: 310, height: 260 },
      { title: 'Graph check', kind: 'graph', x: 415, y: 90, width: 340, height: 300, graph: { expression: 'x; -x+4', xMin: -2, xMax: 6, yMin: -2, yMax: 6 } },
      { title: 'Solution point', detail: '(x, y) =', kind: 'formula', x: 415, y: 420, width: 340, height: 90 }
    ]
  },
  {
    id: 'calculus-derivative-rules',
    categoryId: 'calculus',
    name: 'Derivative Rules Page',
    description: 'Rule bank with worked example space.',
    pageTitle: 'Calculus - Derivative Rules',
    pageTemplate: 'ruled',
    tags: ['calculus', 'derivatives'],
    accent: '#F26076',
    regions: [
      { title: 'Rule bank', kind: 'table', x: 60, y: 90, width: 340, height: 250, rows: 5, columns: 2, cells: [['Rule', 'Result'], ['Power', 'd/dx x^n'], ['Product', '(uv)'], ['Quotient', 'u/v'], ['Chain', 'f(g(x))']] },
      { title: 'Example function', detail: 'f(x) =', kind: 'formula', x: 430, y: 90, width: 320, height: 92 },
      { title: 'Differentiate step by step', detail: 'Name each rule used.', kind: 'work', x: 430, y: 205, width: 320, height: 280 },
      { title: 'Final derivative', detail: "f'(x) =", kind: 'formula', x: 60, y: 390, width: 340, height: 95 }
    ]
  },
  {
    id: 'calculus-integral-rules',
    categoryId: 'calculus',
    name: 'Integral Rules Page',
    description: 'Substitution, constants, and answer check.',
    pageTitle: 'Calculus - Integral Rules',
    pageTemplate: 'ruled',
    tags: ['calculus', 'integrals'],
    accent: '#458B73',
    regions: [
      { title: 'Integral', detail: 'Integral to evaluate', kind: 'formula', x: 60, y: 90, width: 680, height: 92 },
      { title: 'Rule / substitution', detail: 'Let u = ...', kind: 'work', x: 60, y: 205, width: 320, height: 220 },
      { title: 'Antiderivative', detail: '+ C / definite bounds', kind: 'work', x: 420, y: 205, width: 320, height: 220 },
      { title: 'Check by differentiating', detail: 'Derivative of answer should match integrand.', kind: 'formula', x: 60, y: 455, width: 680, height: 92 }
    ]
  },
  {
    id: 'calculus-limit-workspace',
    categoryId: 'calculus',
    name: 'Limit Table + Graph',
    description: 'Numeric approach table beside graph sketch.',
    pageTitle: 'Calculus - Limit Workspace',
    pageTemplate: 'coordinate',
    tags: ['calculus', 'limits'],
    accent: '#FF9760',
    regions: [
      { title: 'Limit expression', detail: 'lim x -> a f(x)', kind: 'formula', x: 60, y: 88, width: 300, height: 80 },
      { title: 'Approach table', kind: 'table', x: 60, y: 190, width: 300, height: 260, rows: 6, columns: 3, cells: [['x left', 'x right', 'f(x)'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['conclusion', '', '']] },
      { title: 'Graph behavior', kind: 'graph', x: 410, y: 88, width: 340, height: 300, graph: { expression: '1/x', xMin: -5, xMax: 5, yMin: -5, yMax: 5 } }
    ]
  },
  {
    id: 'calculus-tangent-secant',
    categoryId: 'calculus',
    name: 'Tangent / Secant Explanation',
    description: 'Compare average and instantaneous rate of change.',
    pageTitle: 'Calculus - Tangent And Secant',
    pageTemplate: 'coordinate',
    tags: ['calculus', 'tangent'],
    accent: '#FFD150',
    regions: [
      { title: 'Curve + secant/tangent', kind: 'graph', x: 60, y: 90, width: 380, height: 320, graph: { expression: 'x^2', xMin: -4, xMax: 4, yMin: -2, yMax: 12, shadeFrom: 1, shadeTo: 2 } },
      { title: 'Secant slope', detail: '(f(b)-f(a))/(b-a)', kind: 'formula', x: 470, y: 90, width: 280, height: 130 },
      { title: 'Tangent slope', detail: 'lim h -> 0 [f(a+h)-f(a)]/h', kind: 'formula', x: 470, y: 250, width: 280, height: 160 },
      { title: 'Interpretation', detail: 'Units and meaning in context.', kind: 'work', x: 60, y: 440, width: 690, height: 90 }
    ]
  },
  {
    id: 'geometry-proof-layout',
    categoryId: 'geometry',
    name: 'Theorem / Proof Layout',
    description: 'Given, prove, construction, and proof table.',
    pageTitle: 'Geometry - Proof Layout',
    pageTemplate: 'geometry',
    tags: ['geometry', 'proof'],
    accent: '#458B73',
    regions: [
      { title: 'Given', detail: 'Known facts and diagram labels.', kind: 'work', x: 60, y: 90, width: 320, height: 100 },
      { title: 'To prove', detail: 'Statement to establish.', kind: 'work', x: 420, y: 90, width: 320, height: 100 },
      { title: 'Diagram', kind: 'diagram', diagramKind: 'node-edge', x: 60, y: 220, width: 300, height: 220 },
      { title: 'Statements / reasons', kind: 'table', x: 395, y: 220, width: 355, height: 300, rows: 6, columns: 2, cells: [['Statement', 'Reason'], ['', ''], ['', ''], ['', ''], ['', ''], ['', '']] }
    ]
  },
  {
    id: 'geometry-triangle-congruence',
    categoryId: 'geometry',
    name: 'Triangle Congruence',
    description: 'Compare two triangles and evidence.',
    pageTitle: 'Geometry - Triangle Congruence',
    pageTemplate: 'geometry',
    tags: ['geometry', 'triangles'],
    accent: '#F26076',
    regions: [
      { title: 'Triangle 1', kind: 'diagram', diagramKind: 'node-edge', x: 60, y: 100, width: 290, height: 220 },
      { title: 'Triangle 2', kind: 'diagram', diagramKind: 'node-edge', x: 430, y: 100, width: 290, height: 220 },
      { title: 'Corresponding parts', kind: 'table', x: 60, y: 365, width: 320, height: 190, rows: 5, columns: 3, cells: [['Part', 'Triangle 1', 'Triangle 2'], ['Side', '', ''], ['Angle', '', ''], ['Side', '', ''], ['Conclusion', '', '']] },
      { title: 'Congruence rule', detail: 'SSS / SAS / ASA / AAS / HL', kind: 'formula', x: 420, y: 365, width: 320, height: 110 }
    ]
  },
  {
    id: 'geometry-circle-theorem',
    categoryId: 'geometry',
    name: 'Circle Theorem Template',
    description: 'Circle diagram with theorem and proof notes.',
    pageTitle: 'Geometry - Circle Theorem',
    pageTemplate: 'geometry',
    tags: ['geometry', 'circle'],
    accent: '#FF9760',
    regions: [
      { title: 'Circle diagram', kind: 'diagram', diagramKind: 'node-edge', x: 60, y: 95, width: 330, height: 260 },
      { title: 'Theorem statement', detail: 'Angles / chords / tangents.', kind: 'formula', x: 430, y: 95, width: 320, height: 120 },
      { title: 'Known relationships', kind: 'table', x: 430, y: 245, width: 320, height: 190, rows: 4, columns: 2, cells: [['Fact', 'Reason'], ['', ''], ['', ''], ['', '']] },
      { title: 'Proof notes', detail: 'Use equal radii, arc measures, or tangent properties.', kind: 'work', x: 60, y: 395, width: 330, height: 140 }
    ]
  },
  {
    id: 'physics-free-body',
    categoryId: 'physics',
    name: 'Free-Body Diagram',
    description: 'Body, forces, components, and equations.',
    pageTitle: 'Physics - Free-Body Diagram',
    pageTemplate: 'grid',
    tags: ['physics', 'forces'],
    accent: '#FFD150',
    regions: [
      { title: 'System sketch', detail: 'Object + surfaces + axes.', kind: 'diagram', diagramKind: 'node-edge', x: 60, y: 95, width: 330, height: 260 },
      { title: 'Force list', kind: 'table', x: 430, y: 95, width: 320, height: 220, rows: 5, columns: 3, cells: [['Force', 'Direction', 'Value'], ['Weight', '', ''], ['Normal', '', ''], ['Friction', '', ''], ['Applied', '', '']] },
      { title: 'Equations', detail: 'sum Fx = ma, sum Fy = ma', kind: 'formula', x: 60, y: 390, width: 330, height: 120 },
      { title: 'Answer + units', detail: 'Check sign convention.', kind: 'work', x: 430, y: 350, width: 320, height: 160 }
    ]
  },
  {
    id: 'physics-motion-graph',
    categoryId: 'physics',
    name: 'Motion Graph Workspace',
    description: 'Position/velocity graph with data and interpretation.',
    pageTitle: 'Physics - Motion Graph',
    pageTemplate: 'graph',
    tags: ['physics', 'motion'],
    accent: '#458B73',
    regions: [
      { title: 'Motion graph', kind: 'graph', x: 60, y: 92, width: 390, height: 300, graph: { expression: '2*x+1', xMin: 0, xMax: 10, yMin: 0, yMax: 25 } },
      { title: 'Data table', kind: 'table', x: 480, y: 92, width: 270, height: 250, rows: 6, columns: 3, cells: [['t', 'x', 'v'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', '']] },
      { title: 'Slope / area meaning', detail: 'Connect graph features to physical quantities.', kind: 'work', x: 60, y: 425, width: 690, height: 110 }
    ]
  },
  {
    id: 'physics-circuit',
    categoryId: 'physics',
    name: 'Circuit Diagram Starter',
    description: 'Circuit sketch, values, and equations.',
    pageTitle: 'Physics - Circuit Diagram',
    pageTemplate: 'grid',
    tags: ['physics', 'circuits'],
    accent: '#F26076',
    regions: [
      { title: 'Circuit sketch', kind: 'diagram', diagramKind: 'flow', x: 60, y: 95, width: 350, height: 260 },
      { title: 'Known values', kind: 'table', x: 445, y: 95, width: 305, height: 210, rows: 5, columns: 2, cells: [['Quantity', 'Value'], ['V', ''], ['I', ''], ['R', ''], ['P', '']] },
      { title: 'Equations', detail: 'V = IR, P = VI', kind: 'formula', x: 445, y: 340, width: 305, height: 120 },
      { title: 'Result', detail: 'Equivalent resistance / current / power.', kind: 'work', x: 60, y: 390, width: 350, height: 110 }
    ]
  },
  {
    id: 'chemistry-balancing',
    categoryId: 'chemistry',
    name: 'Chemical Equation Balancing',
    description: 'Reactants/products, atom count, and coefficients.',
    pageTitle: 'Chemistry - Equation Balancing',
    pageTemplate: 'ruled',
    tags: ['chemistry', 'balancing'],
    accent: '#458B73',
    regions: [
      { title: 'Unbalanced equation', detail: 'Reactants -> products', kind: 'formula', x: 60, y: 90, width: 680, height: 86 },
      { title: 'Atom count', kind: 'table', x: 60, y: 200, width: 360, height: 260, rows: 6, columns: 3, cells: [['Element', 'Reactants', 'Products'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', '']] },
      { title: 'Coefficient trials', detail: 'Adjust one element at a time.', kind: 'work', x: 455, y: 200, width: 285, height: 190 },
      { title: 'Balanced equation', detail: 'Check conservation of atoms and charge.', kind: 'formula', x: 455, y: 420, width: 285, height: 100 }
    ]
  },
  {
    id: 'chemistry-periodic-notes',
    categoryId: 'chemistry',
    name: 'Periodic Table Notes',
    description: 'Element card and trend workspace.',
    pageTitle: 'Chemistry - Periodic Notes',
    pageTemplate: 'grid',
    tags: ['chemistry', 'periodic table'],
    accent: '#FFD150',
    regions: [
      { title: 'Element card', kind: 'table', x: 60, y: 90, width: 300, height: 240, rows: 5, columns: 2, cells: [['Property', 'Value'], ['Atomic number', ''], ['Mass', ''], ['Group/period', ''], ['Valence', '']] },
      { title: 'Trend sketch', kind: 'graph', x: 410, y: 90, width: 340, height: 260, graph: { expression: 'x', xMin: 0, xMax: 10, yMin: 0, yMax: 10 } },
      { title: 'Electron configuration', detail: 'Shell/orbital notation.', kind: 'formula', x: 60, y: 370, width: 300, height: 110 },
      { title: 'Notes', detail: 'Reactivity, bonding, uses.', kind: 'work', x: 410, y: 380, width: 340, height: 120 }
    ]
  },
  {
    id: 'chemistry-reaction-flow',
    categoryId: 'chemistry',
    name: 'Reaction Mechanism Flow',
    description: 'Stepwise reaction flow with conditions.',
    pageTitle: 'Chemistry - Reaction Mechanism',
    pageTemplate: 'blank',
    tags: ['chemistry', 'reaction'],
    accent: '#FF9760',
    regions: [
      { title: 'Mechanism flow', kind: 'diagram', diagramKind: 'flow', x: 60, y: 95, width: 420, height: 280 },
      { title: 'Reagents / conditions', kind: 'table', x: 510, y: 95, width: 240, height: 220, rows: 5, columns: 2, cells: [['Step', 'Condition'], ['1', ''], ['2', ''], ['3', ''], ['Yield', '']] },
      { title: 'Intermediate notes', detail: 'Charges, arrows, and catalysts.', kind: 'work', x: 60, y: 410, width: 690, height: 110 }
    ]
  },
  {
    id: 'chemistry-lab-observation',
    categoryId: 'chemistry',
    name: 'Lab Observation Table',
    description: 'Observation, inference, safety, and conclusion.',
    pageTitle: 'Chemistry - Lab Observation',
    pageTemplate: 'table',
    tags: ['chemistry', 'lab'],
    accent: '#F26076',
    regions: [
      { title: 'Observation table', kind: 'table', x: 60, y: 95, width: 690, height: 270, rows: 6, columns: 4, cells: [['Step', 'Observation', 'Inference', 'Safety'], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['Conclusion', '', '', '']] },
      { title: 'Variables', detail: 'Independent / dependent / controlled.', kind: 'work', x: 60, y: 395, width: 330, height: 110 },
      { title: 'Result statement', detail: 'Claim, evidence, reasoning.', kind: 'work', x: 420, y: 395, width: 330, height: 110 }
    ]
  },
  {
    id: 'economics-supply-demand',
    categoryId: 'economics',
    name: 'Supply-Demand Graph',
    description: 'Market equilibrium and shifts.',
    pageTitle: 'Economics - Supply Demand',
    pageTemplate: 'coordinate',
    tags: ['economics', 'market'],
    accent: '#458B73',
    regions: [
      { title: 'Market graph', kind: 'graph', x: 60, y: 90, width: 390, height: 320, graph: { expression: '-x+10; x', xMin: 0, xMax: 10, yMin: 0, yMax: 10 } },
      { title: 'Equilibrium', kind: 'table', x: 480, y: 90, width: 270, height: 180, rows: 4, columns: 2, cells: [['Item', 'Value'], ['P*', ''], ['Q*', ''], ['Change', '']] },
      { title: 'Shift explanation', detail: 'Cause -> curve shift -> new price/quantity.', kind: 'work', x: 480, y: 305, width: 270, height: 140 },
      { title: 'Conclusion', detail: 'Short market interpretation.', kind: 'work', x: 60, y: 445, width: 690, height: 80 }
    ]
  },
  {
    id: 'economics-cost-profit',
    categoryId: 'economics',
    name: 'Cost / Revenue / Profit Table',
    description: 'Track total, marginal, and average values.',
    pageTitle: 'Economics - Cost Revenue Profit',
    pageTemplate: 'table',
    tags: ['economics', 'cost'],
    accent: '#FFD150',
    regions: [
      { title: 'Cost table', kind: 'table', x: 60, y: 90, width: 690, height: 300, rows: 7, columns: 5, cells: [['Q', 'TC', 'TR', 'MC/MR', 'Profit'], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['Decision', '', '', '', '']] },
      { title: 'Break-even / max profit rule', detail: 'MR = MC and profit = TR - TC.', kind: 'formula', x: 60, y: 425, width: 330, height: 100 },
      { title: 'Interpretation', detail: 'Should the firm produce? Why?', kind: 'work', x: 420, y: 425, width: 330, height: 100 }
    ]
  },
  {
    id: 'economics-ppc',
    categoryId: 'economics',
    name: 'Production Possibility Curve',
    description: 'Opportunity cost and feasible choices.',
    pageTitle: 'Economics - PPC',
    pageTemplate: 'coordinate',
    tags: ['economics', 'ppc'],
    accent: '#FF9760',
    regions: [
      { title: 'PPC sketch', kind: 'graph', x: 60, y: 90, width: 390, height: 320, graph: { expression: 'sqrt(100-x^2)', xMin: 0, xMax: 10, yMin: 0, yMax: 10 } },
      { title: 'Points', kind: 'table', x: 480, y: 90, width: 270, height: 190, rows: 5, columns: 3, cells: [['Point', 'Good A', 'Good B'], ['A', '', ''], ['B', '', ''], ['C', '', ''], ['D', '', '']] },
      { title: 'Opportunity cost', detail: 'What is given up when moving points?', kind: 'work', x: 480, y: 315, width: 270, height: 140 }
    ]
  },
  {
    id: 'coding-flowchart',
    categoryId: 'coding',
    name: 'Flowchart Template',
    description: 'Algorithm flow with input/process/output.',
    pageTitle: 'Coding - Flowchart',
    pageTemplate: 'blank',
    tags: ['coding', 'flowchart'],
    accent: '#458B73',
    regions: [
      { title: 'Algorithm flow', kind: 'diagram', diagramKind: 'flow', x: 60, y: 95, width: 420, height: 300 },
      { title: 'Variables', kind: 'table', x: 510, y: 95, width: 240, height: 190, rows: 5, columns: 2, cells: [['Variable', 'Meaning'], ['', ''], ['', ''], ['', ''], ['', '']] },
      { title: 'Edge cases', detail: 'Empty input, invalid input, limits.', kind: 'work', x: 510, y: 320, width: 240, height: 120 },
      { title: 'Expected output', detail: 'Trace one example.', kind: 'work', x: 60, y: 430, width: 420, height: 90 }
    ]
  },
  {
    id: 'coding-pseudocode',
    categoryId: 'coding',
    name: 'Pseudocode + Output Table',
    description: 'Code plan with dry-run table.',
    pageTitle: 'Coding - Pseudocode',
    pageTemplate: 'ruled',
    tags: ['coding', 'pseudocode'],
    accent: '#F26076',
    regions: [
      { title: 'Pseudocode', detail: 'Write steps with indentation.', kind: 'work', x: 60, y: 90, width: 340, height: 310 },
      { title: 'Dry run table', kind: 'table', x: 430, y: 90, width: 320, height: 310, rows: 7, columns: 4, cells: [['Step', 'Input', 'State', 'Output'], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['Result', '', '', '']] },
      { title: 'Complexity', detail: 'Time: O( ), Space: O( )', kind: 'formula', x: 60, y: 430, width: 690, height: 90 }
    ]
  },
  {
    id: 'coding-recursion-tree',
    categoryId: 'coding',
    name: 'Recursion Tree',
    description: 'Call tree, base case, and recurrence.',
    pageTitle: 'Coding - Recursion Tree',
    pageTemplate: 'grid',
    tags: ['coding', 'recursion'],
    accent: '#FFD150',
    regions: [
      { title: 'Call tree', kind: 'diagram', diagramKind: 'tree', x: 60, y: 95, width: 430, height: 300 },
      { title: 'Base case', detail: 'When does recursion stop?', kind: 'formula', x: 520, y: 95, width: 230, height: 100 },
      { title: 'Recurrence', detail: 'T(n) = ...', kind: 'formula', x: 520, y: 225, width: 230, height: 100 },
      { title: 'Trace', detail: 'Follow one branch and combine results.', kind: 'work', x: 60, y: 430, width: 690, height: 90 }
    ]
  },
  {
    id: 'coding-data-structures',
    categoryId: 'coding',
    name: 'Stack / Queue Diagram',
    description: 'Visualize operations and state changes.',
    pageTitle: 'Coding - Stack Queue',
    pageTemplate: 'grid',
    tags: ['coding', 'data structures'],
    accent: '#FF9760',
    regions: [
      { title: 'Structure diagram', kind: 'diagram', diagramKind: 'node-edge', x: 60, y: 95, width: 330, height: 240 },
      { title: 'Operations trace', kind: 'table', x: 430, y: 95, width: 320, height: 260, rows: 6, columns: 3, cells: [['Operation', 'State', 'Output'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['Final', '', '']] },
      { title: 'Invariant', detail: 'What must always stay true?', kind: 'work', x: 60, y: 385, width: 690, height: 110 }
    ]
  },
  {
    id: 'probability-tree',
    categoryId: 'probability',
    name: 'Probability Tree',
    description: 'Branching outcomes and path probabilities.',
    pageTitle: 'Probability - Tree',
    pageTemplate: 'blank',
    tags: ['probability', 'tree'],
    accent: '#458B73',
    regions: [
      { title: 'Event tree', kind: 'diagram', diagramKind: 'probability-tree', x: 60, y: 95, width: 430, height: 300 },
      { title: 'Path probabilities', kind: 'table', x: 520, y: 95, width: 230, height: 250, rows: 5, columns: 2, cells: [['Path', 'P'], ['', ''], ['', ''], ['', ''], ['Total', '']] },
      { title: 'Conclusion', detail: 'Answer the target probability in context.', kind: 'work', x: 60, y: 430, width: 690, height: 90 }
    ]
  },
  {
    id: 'probability-venn',
    categoryId: 'probability',
    name: 'Venn Probability',
    description: 'Set notation and inclusion-exclusion.',
    pageTitle: 'Probability - Venn',
    pageTemplate: 'blank',
    tags: ['probability', 'venn'],
    accent: '#F26076',
    regions: [
      { title: 'Venn diagram', kind: 'diagram', diagramKind: 'venn', x: 60, y: 95, width: 360, height: 260 },
      { title: 'Known values', kind: 'table', x: 460, y: 95, width: 290, height: 230, rows: 5, columns: 2, cells: [['Region', 'Probability'], ['P(A)', ''], ['P(B)', ''], ['P(A and B)', ''], ['P(A or B)', '']] },
      { title: 'Formula', detail: 'P(A or B) = P(A) + P(B) - P(A and B)', kind: 'formula', x: 60, y: 395, width: 690, height: 100 }
    ]
  },
  {
    id: 'probability-sample-space',
    categoryId: 'probability',
    name: 'Sample Space Table',
    description: 'Organize outcomes and favorable cases.',
    pageTitle: 'Probability - Sample Space',
    pageTemplate: 'table',
    tags: ['probability', 'sample space'],
    accent: '#FFD150',
    regions: [
      { title: 'Sample space', kind: 'table', x: 60, y: 95, width: 430, height: 300, rows: 6, columns: 5, cells: [['', '1', '2', '3', '4'], ['A', '', '', '', ''], ['B', '', '', '', ''], ['C', '', '', '', ''], ['D', '', '', '', ''], ['Total', '', '', '', '']] },
      { title: 'Favorable outcomes', detail: 'List or shade selected outcomes.', kind: 'work', x: 520, y: 95, width: 230, height: 160 },
      { title: 'Probability', detail: 'favorable / total =', kind: 'formula', x: 520, y: 290, width: 230, height: 110 }
    ]
  },
  {
    id: 'probability-bayes',
    categoryId: 'probability',
    name: 'Bayes Theorem Layout',
    description: 'Prior, likelihood, evidence, posterior.',
    pageTitle: 'Probability - Bayes',
    pageTemplate: 'ruled',
    tags: ['probability', 'bayes'],
    accent: '#FF9760',
    regions: [
      { title: 'Known probabilities', kind: 'table', x: 60, y: 95, width: 340, height: 260, rows: 5, columns: 2, cells: [['Term', 'Value'], ['P(A)', ''], ['P(B|A)', ''], ['P(B)', ''], ['P(A|B)', '']] },
      { title: 'Formula', detail: 'P(A|B) = P(B|A)P(A)/P(B)', kind: 'formula', x: 440, y: 95, width: 310, height: 120 },
      { title: 'Substitution', detail: 'Plug values and simplify.', kind: 'work', x: 440, y: 245, width: 310, height: 170 },
      { title: 'Interpretation', detail: 'Explain posterior probability.', kind: 'work', x: 60, y: 445, width: 690, height: 80 }
    ]
  },
  {
    id: 'statistics-frequency',
    categoryId: 'statistics',
    name: 'Frequency Table',
    description: 'Class intervals, frequency, and cumulative count.',
    pageTitle: 'Statistics - Frequency Table',
    pageTemplate: 'table',
    tags: ['statistics', 'frequency'],
    accent: '#458B73',
    regions: [
      { title: 'Frequency table', kind: 'table', x: 60, y: 95, width: 690, height: 320, rows: 7, columns: 5, cells: [['Class', 'Tally', 'Frequency', 'Cumulative', 'Relative'], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['', '', '', '', ''], ['Total', '', '', '', '']] },
      { title: 'Key measures', detail: 'Mean, median, mode, range.', kind: 'formula', x: 60, y: 450, width: 330, height: 90 },
      { title: 'Comment', detail: 'Shape, center, spread.', kind: 'work', x: 420, y: 450, width: 330, height: 90 }
    ]
  },
  {
    id: 'statistics-histogram',
    categoryId: 'statistics',
    name: 'Histogram Workspace',
    description: 'Histogram plus class interval table.',
    pageTitle: 'Statistics - Histogram',
    pageTemplate: 'graph',
    tags: ['statistics', 'histogram'],
    accent: '#F26076',
    regions: [
      { title: 'Histogram', kind: 'graph', x: 60, y: 90, width: 390, height: 310, graph: { histogramData: '4,5,6,6,7,8,8,8,9,10', histogramBins: 5 } },
      { title: 'Intervals', kind: 'table', x: 480, y: 90, width: 270, height: 250, rows: 6, columns: 3, cells: [['Interval', 'Freq.', 'Notes'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['Total', '', '']] },
      { title: 'Interpretation', detail: 'Skew, modal class, spread.', kind: 'work', x: 60, y: 430, width: 690, height: 90 }
    ]
  },
  {
    id: 'statistics-regression',
    categoryId: 'statistics',
    name: 'Scatter / Regression',
    description: 'Scatter plot and correlation statement.',
    pageTitle: 'Statistics - Scatter Regression',
    pageTemplate: 'coordinate',
    tags: ['statistics', 'regression'],
    accent: '#FF9760',
    regions: [
      { title: 'Scatter plot', kind: 'graph', x: 60, y: 90, width: 390, height: 320, graph: { scatterPoints: '1,2\\n2,3\\n3,4\\n4,6\\n5,7', showRegression: true, xMin: 0, xMax: 6, yMin: 0, yMax: 8 } },
      { title: 'Data notes', kind: 'table', x: 480, y: 90, width: 270, height: 220, rows: 5, columns: 2, cells: [['x', 'y'], ['', ''], ['', ''], ['', ''], ['', '']] },
      { title: 'Model', detail: 'Line of best fit: y = mx + b', kind: 'formula', x: 480, y: 340, width: 270, height: 100 },
      { title: 'Interpretation', detail: 'Correlation, slope meaning, prediction limits.', kind: 'work', x: 60, y: 445, width: 690, height: 80 }
    ]
  },
  {
    id: 'statistics-hypothesis-test',
    categoryId: 'statistics',
    name: 'Hypothesis Test Layout',
    description: 'Structured test workflow.',
    pageTitle: 'Statistics - Hypothesis Test',
    pageTemplate: 'ruled',
    tags: ['statistics', 'hypothesis'],
    accent: '#FFD150',
    regions: [
      { title: 'Hypotheses', detail: 'H0 and H1', kind: 'formula', x: 60, y: 90, width: 320, height: 110 },
      { title: 'Test details', kind: 'table', x: 420, y: 90, width: 330, height: 210, rows: 5, columns: 2, cells: [['Item', 'Value'], ['alpha', ''], ['test statistic', ''], ['p-value', ''], ['decision', '']] },
      { title: 'Work', detail: 'Conditions, calculation, and comparison.', kind: 'work', x: 60, y: 230, width: 320, height: 260 },
      { title: 'Conclusion', detail: 'State result in context.', kind: 'work', x: 420, y: 335, width: 330, height: 130 }
    ]
  },
  {
    id: 'accounting-ledger',
    categoryId: 'accounting',
    name: 'Ledger / T-Account',
    description: 'Debit and credit sides with balance.',
    pageTitle: 'Accounting - T Account',
    pageTemplate: 'table',
    tags: ['accounting', 'ledger'],
    accent: '#458B73',
    regions: [
      { title: 'T-account', kind: 'table', x: 60, y: 95, width: 430, height: 300, rows: 7, columns: 2, cells: [['Debit', 'Credit'], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['Balance', '']] },
      { title: 'Account name', detail: 'Asset / liability / equity / revenue / expense.', kind: 'formula', x: 520, y: 95, width: 230, height: 95 },
      { title: 'Rules', detail: 'Normal balance and posting notes.', kind: 'work', x: 520, y: 220, width: 230, height: 170 },
      { title: 'Final balance', detail: 'Debit or credit balance.', kind: 'formula', x: 60, y: 430, width: 690, height: 90 }
    ]
  },
  {
    id: 'accounting-trial-balance',
    categoryId: 'accounting',
    name: 'Trial Balance Table',
    description: 'Account list with debit and credit totals.',
    pageTitle: 'Accounting - Trial Balance',
    pageTemplate: 'table',
    tags: ['accounting', 'trial balance'],
    accent: '#F26076',
    regions: [
      { title: 'Trial balance', kind: 'table', x: 60, y: 95, width: 690, height: 340, rows: 8, columns: 3, cells: [['Account', 'Debit', 'Credit'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['Total', '', '']] },
      { title: 'Check', detail: 'Total debits must equal total credits.', kind: 'formula', x: 60, y: 470, width: 690, height: 70 }
    ]
  },
  {
    id: 'accounting-journal-entry',
    categoryId: 'accounting',
    name: 'Journal Entry Layout',
    description: 'Date, accounts, debit, credit, and narration.',
    pageTitle: 'Accounting - Journal Entry',
    pageTemplate: 'table',
    tags: ['accounting', 'journal'],
    accent: '#FFD150',
    regions: [
      { title: 'Journal entry', kind: 'table', x: 60, y: 95, width: 690, height: 300, rows: 6, columns: 4, cells: [['Date', 'Account', 'Debit', 'Credit'], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['Narration', '', '', '']] },
      { title: 'Transaction analysis', detail: 'Which accounts increase/decrease?', kind: 'work', x: 60, y: 425, width: 330, height: 105 },
      { title: 'Accounting equation check', detail: 'Assets = Liabilities + Equity.', kind: 'formula', x: 420, y: 425, width: 330, height: 105 }
    ]
  }
];
const MATRIX_TABLE_PRESETS: Array<{
  id: string;
  label: string;
  mode: MatrixTableMode;
  rows: number;
  columns: number;
  cells: string[][];
  bracketStyle?: WhiteboardMatrixBracket;
  augmentedColumn?: number | null;
  headerRow?: boolean;
  showBorders?: boolean;
}> = [
  {
    id: 'matrix-2x2',
    label: '2 x 2',
    mode: 'matrix',
    rows: 2,
    columns: 2,
    cells: [
      ['a', 'b'],
      ['c', 'd']
    ]
  },
  {
    id: 'matrix-3x3',
    label: '3 x 3',
    mode: 'matrix',
    rows: 3,
    columns: 3,
    cells: [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i']
    ]
  },
  { id: 'row-vector', label: 'Row vector', mode: 'matrix', rows: 1, columns: 4, cells: [['x1', 'x2', 'x3', 'x4']] },
  { id: 'column-vector', label: 'Column vector', mode: 'matrix', rows: 4, columns: 1, cells: [['x1'], ['x2'], ['x3'], ['x4']] },
  {
    id: 'augmented',
    label: 'Augmented',
    mode: 'matrix',
    rows: 3,
    columns: 4,
    augmentedColumn: 3,
    cells: [
      ['1', '0', '0', 'a'],
      ['0', '1', '0', 'b'],
      ['0', '0', '1', 'c']
    ]
  },
  {
    id: 'determinant',
    label: 'Determinant',
    mode: 'matrix',
    rows: 2,
    columns: 2,
    bracketStyle: 'determinant',
    cells: [
      ['a', 'b'],
      ['c', 'd']
    ]
  },
  {
    id: 'table-header',
    label: 'Header table',
    mode: 'table',
    rows: 4,
    columns: 3,
    headerRow: true,
    showBorders: true,
    cells: [
      ['Name', 'Value', 'Notes'],
      ['', '', ''],
      ['', '', ''],
      ['', '', '']
    ]
  }
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
  matrix: 'Matrix',
  table: 'Table',
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
  readonly initialState = input<WhiteboardMemorySnapshot | null>(null);
  readonly allowedTools = input<readonly WhiteboardTool[] | null>(null);
  readonly allowPageManagement = input(true);
  readonly allowAssetImport = input(true);
  readonly allowExport = input(true);
  readonly allowClear = input(true);
  readonly allowPresentationMode = input(false);
  readonly allowSubjectTemplates = input(false);
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

  protected readonly activeTool = signal<WhiteboardTool>('pen');
  protected readonly activeShapeTool = signal<WhiteboardShapeTool>('rectangle');
  protected readonly activeGeometryTool = signal<WhiteboardGeometryTool>('segment');
  protected readonly activeDiagramTool = signal<WhiteboardDiagramTool>('venn');
  protected readonly shapeMenuOpen = signal(false);
  protected readonly geometryMenuOpen = signal(false);
  protected readonly diagramMenuOpen = signal(false);
  protected readonly colorMenuOpen = signal(false);
  protected readonly fillColorMenuOpen = signal(false);
  protected readonly penMenuOpen = signal(false);
  protected readonly brushMenuOpen = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly strokeColor = signal('#071c41');
  protected readonly fillColor = signal('#FFD150');
  protected readonly fillEnabled = signal(false);
  protected readonly strokeWidth = signal(4);
  protected readonly activePenStyle = signal<WhiteboardPenStyle>('solid');
  protected readonly penOpacity = signal(1);
  protected readonly penSmoothing = signal(0.35);
  protected readonly pressureSensitivePen = signal(false);
  protected readonly pressureInputAvailable = signal(false);
  protected readonly penAutoCloseEnabled = signal(true);
  protected readonly penAutoCloseThreshold = signal(28);
  protected readonly eraserMode = signal<WhiteboardEraserMode>('partial');
  protected readonly eraserSize = signal(18);
  protected readonly fontSize = signal(28);
  protected readonly colors = ['#071c41', '#458B73', '#F26076', '#FF9760', '#FFD150'];
  protected readonly isHighlighterActive = computed(
    () => this.activeTool() === 'pen' && this.activePenStyle() === 'marker'
  );
  protected readonly isSolidPenActive = computed(
    () => this.activeTool() === 'pen' && this.activePenStyle() !== 'marker'
  );
  protected readonly teachingColors = [
    { value: '#071c41', label: 'Dark Charcoal (Writing)' },
    { value: '#F26076', label: 'Marking Rose (Corrections)' },
    { value: '#2563EB', label: 'Academic Blue (Formulas)' },
    { value: '#458B73', label: 'Solution Green (Answers)' },
    { value: '#FFD150', label: 'Highlighter Amber (Highlight)' }
  ];
  protected readonly recentColors = signal<string[]>([]);
  protected readonly customRecentColors = computed(() =>
    this.recentColors().filter((color) => !this.colors.some((preset) => preset.toLowerCase() === color.toLowerCase()))
  );
  protected readonly penOpacityLabel = computed(() => `${Math.round(this.penOpacity() * 100)}%`);
  protected readonly penSmoothingLabel = computed(() => `${Math.round(this.penSmoothing() * 100)}%`);
  protected readonly brushSizes = [3, 6, 10, 14];
  protected readonly eraserSizes = [12, 18, 28, 40];
  protected readonly penStyleOptions = PEN_STYLE_OPTIONS;
  protected readonly penAutoCloseThresholdOptions = PEN_AUTO_CLOSE_THRESHOLDS;
  protected readonly eraserModeOptions = ERASER_MODE_OPTIONS;
  protected readonly mathSnippets = MATH_SNIPPETS;
  protected readonly mathShortcutGroups = MATH_SHORTCUT_GROUPS;
  protected readonly mathTabs = MATH_TOOLS_TABS;
  protected readonly visibleMathTabs = computed(() =>
    this.allowSubjectTemplates() ? this.mathTabs : this.mathTabs.filter((tab) => tab.id !== 'subjects')
  );
  protected readonly subjectTemplateCategories = SUBJECT_TEMPLATE_CATEGORIES;
  protected readonly subjectTemplates = SUBJECT_TEMPLATE_LIBRARY;
  protected readonly matrixTablePresets = MATRIX_TABLE_PRESETS;
  protected readonly pdfExportOptions = PDF_EXPORT_OPTIONS;
  protected readonly textAlignmentOptions = TEXT_ALIGNMENT_OPTIONS;
  protected readonly geometryToolGroups = GEOMETRY_TOOL_GROUPS;
  protected readonly geometryToolOptions = GEOMETRY_TOOL_OPTIONS;
  protected readonly diagramToolOptions = DIAGRAM_TOOL_OPTIONS;
  protected readonly insertTemplateOptions = INSERT_TEMPLATE_OPTIONS;
  protected readonly angleSnapOptions = ANGLE_SNAP_OPTIONS;
  protected readonly mathPopoverOpen = signal(false);
  protected readonly activeMathTab = signal<MathToolsTab>('equation');
  protected readonly activeSubjectTemplateCategory = signal<SubjectTemplateCategoryId>('algebra');
  protected readonly subjectTemplateSearch = signal('');
  protected readonly filteredSubjectTemplates = computed(() => {
    const categoryId = this.activeSubjectTemplateCategory();
    const query = this.subjectTemplateSearch().trim().toLowerCase();
    return this.subjectTemplates.filter((template) => {
      const matchesCategory = template.categoryId === categoryId;
      if (!matchesCategory) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        template.name.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query) ||
        template.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  });
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
  protected readonly selectedMatrixTableForPopover = computed(() => this.singleSelectedMatrixTable());
  protected readonly mathEquationActionLabel = computed(() => {
    if (this.selectedEquationForPopover()) {
      return 'Update equation';
    }
    if (this.selectedTextForPopover()) {
      return 'Convert text to equation';
    }
    return 'Insert equation';
  });
  protected readonly matrixTableActionLabel = computed(() => (this.matrixTableDraft()?.elementId ? 'Update object' : 'Insert object'));
  protected readonly textDraft = signal<TextDraft | null>(null);
  protected readonly graphDraft = signal<GraphDraft | null>(null);
  protected readonly matrixTableDraft = signal<MatrixTableDraft | null>(null);
  protected readonly contextMenu = signal<ContextMenuState | null>(null);
  protected readonly laserPoint = signal<WhiteboardPoint | null>(null);
  protected readonly eraserCursor = signal<WhiteboardPoint | null>(null);
  protected readonly presentationModeEnabled = signal(false);
  protected readonly presentationEditEnabled = signal(true);
  protected readonly alignmentGuides = signal<AlignmentGuide[]>([]);
  protected readonly selectionMarquee = signal<SelectionMarquee | null>(null);
  private isSpacePressed = false;
  private previousToolBeforeSpace: WhiteboardTool | null = null;
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
      : this.assetImportMode() === 'deck-pages'
        ? '.ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : this.assetImportMode() === 'slide-pages' || this.assetImportMode() === 'background'
        ? 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
        : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,.pdf,application/pdf'
  );
  protected readonly assetInputMultiple = computed(() => this.assetImportMode() === 'slide-pages');
  protected readonly pdfExportMode = signal<PdfExportMode>('hybrid');
  protected readonly templateOptions = TEMPLATE_OPTIONS;
  protected readonly pages = signal<WhiteboardPage[]>([this.createPage('Board 1')]);
  protected readonly activePageId = signal(this.pages()[0]!.id);
  protected readonly activePageIndex = computed(
    () => this.pages().findIndex((page) => page.id === this.activePageId()) + 1
  );
  protected readonly totalPages = computed(() => this.pages().length);
  protected readonly pageManagerOpen = signal(false);
  protected readonly activeTooltip = signal<{
    text: string;
    shortcut?: string;
    x: number;
    y: number;
    placement: 'right' | 'bottom' | 'top';
  } | null>(null);
  private tooltipTimeoutId?: number;

  protected showTooltip(
    event: MouseEvent | FocusEvent,
    text: string,
    shortcut?: string,
    placement: 'right' | 'bottom' | 'top' = 'right'
  ): void {
    window.clearTimeout(this.tooltipTimeoutId);
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();

    let x = rect.right + 8;
    let y = rect.top + rect.height / 2;

    if (placement === 'bottom') {
      x = rect.left + rect.width / 2;
      y = rect.bottom + 8;
    } else if (placement === 'top') {
      x = rect.left + rect.width / 2;
      y = rect.top - 8;
    }

    this.tooltipTimeoutId = window.setTimeout(() => {
      this.activeTooltip.set({ text, shortcut, x, y, placement });
    }, 100);
  }

  protected hideTooltip(): void {
    window.clearTimeout(this.tooltipTimeoutId);
    this.activeTooltip.set(null);
  }
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
  protected readonly presentationPageLabel = computed(() => {
    const index = this.pages().findIndex((page) => page.id === this.activePageId());
    return `${Math.max(1, index + 1)} / ${this.pages().length}`;
  });
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
  private pageSizeCache = new WeakMap<WhiteboardPage, Map<number, number>>();
  private clipboardElements: WhiteboardElement[] = [];
  private clipboardPasteCount = 0;
  private historyPast: WhiteboardPage[][] = [];
  private historyFuture: WhiteboardPage[][] = [];
  private laserTimeout?: number;
  private captureStreamActive = false;
  private captureRefreshTimer?: number;
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
    const initialState = this.initialState();
    if (initialState) {
      this.importBoardState(initialState);
    }
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
    this.stopMediaCapture();
    try {
      this.captureStreamActive = true;
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
          if (this.activeCaptureStream === stream) this.stopMediaCapture();
        },
        { once: true }
      );
      // Canvas capture emits frames when pixels are painted. Keep a static board
      // available after ICE connects and to students joining later without edits.
      this.render();
      this.captureRefreshTimer = window.setInterval(() => {
        if (this.activeCaptureStream === stream) this.render();
      }, 1000);
      return stream;
    } catch {
      this.stopMediaCapture();
      return null;
    }
  }

  stopMediaCapture(): void {
    if (this.captureRefreshTimer !== undefined) {
      window.clearInterval(this.captureRefreshTimer);
      this.captureRefreshTimer = undefined;
    }
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
    if (event.key === 'Escape') {
      event.preventDefault();
      const trigger = this.whiteboardCanvas?.nativeElement.closest('.whiteboard-pane')
        ?.querySelector<HTMLButtonElement>('.whiteboard-toolbar button[aria-expanded="true"]');
      if (this.mathPopoverOpen()) this.closeMathTools();
      if (this.presentationModeEnabled()) this.exitPresentationMode();
      this.cancelKeyboardState();
      trigger?.focus();
      return;
    }

    if (this.isEditableShortcutTarget(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    const usesModifier = event.ctrlKey || event.metaKey;

    if (!usesModifier && !this.textDraft()) {
      if (key === 'p') { this.selectPenTool(); return; }
      if (key === 'm') { this.selectHighlighter(); return; }
      if (key === 'v' || key === 's') { this.selectTool('select'); return; }
      if (key === 'e') { this.selectTool('eraser'); return; }
      if (key === 't') { this.selectTool('text'); return; }
      if (key === 'n') { this.insertStickyNote(); return; }
      if (key === 'r') { this.selectShapeTool('rectangle'); return; }
      if (key === 'c' || key === 'o') { this.selectShapeTool('ellipse'); return; }
      if (key === 'a') { this.selectShapeTool('arrow'); return; }
      if (key === 'l') { this.selectTool('laser'); return; }
      if (key === 'h') { this.selectTool('pan'); return; }
    }

    if (event.code === 'Space' && !this.isSpacePressed && !this.textDraft()) {
      event.preventDefault();
      this.isSpacePressed = true;
      this.previousToolBeforeSpace = this.activeTool();
      this.activeTool.set('pan');
      return;
    }

    if (usesModifier && key === '0') {
      event.preventDefault();
      this.resetView();
      return;
    }

    if (!this.readOnly() && this.canUseTool('select') && usesModifier && key === 'a') {
      event.preventDefault();
      this.activeTool.set('select');
      this.setSelection(this.elements.map((element) => element.id));
      return;
    }

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

    if (this.presentationModeEnabled() && !this.selectedElementIds().length && (event.key === 'ArrowLeft' || event.key === 'PageUp')) {
      event.preventDefault();
      this.previousPresentationPage();
      return;
    }

    if (this.presentationModeEnabled() && !this.selectedElementIds().length && (event.key === 'ArrowRight' || event.key === 'PageDown')) {
      event.preventDefault();
      this.nextPresentationPage();
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
    this.bumpHistoryVersion();
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
    const previousActivePageId = this.activePageId();
    const pageId = command.type === 'page-upsert' ? command.page.id : command.pageId ?? previousActivePageId;
    const normalizedCommand = command.type === 'page-upsert' ? command : { ...command, pageId };
    this.pages.set(this.applyCommandToPages(this.pages(), normalizedCommand));
    // Rebase local history on remote work so undo never rewinds another author's edits.
    this.historyPast = this.historyPast.map((pages) => this.applyCommandToPages(pages, normalizedCommand)).filter((pages) => pages.length);
    this.historyFuture = this.historyFuture.map((pages) => this.applyCommandToPages(pages, normalizedCommand)).filter((pages) => pages.length);
    this.bumpHistoryVersion();
    if (command.type === 'page-select' && this.pages().some((page) => page.id === pageId)) {
      this.activePageId.set(pageId);
    }
    this.ensureActivePage();
    if (this.activePageId() !== previousActivePageId || (command.type === 'page-upsert' && pageId === this.activePageId())) {
      this.applyPageView(this.activePage());
    }
    this.selectedElementIds.set([]);
    this.pruneImageCache();
    this.render();
  }

  private applyCommandToPages(pages: WhiteboardPage[], command: WhiteboardCommand): WhiteboardPage[] {
    if (command.type === 'page-select') {
      return pages;
    }
    if (command.type === 'page-delete') {
      return pages.filter((page) => page.id !== command.pageId);
    }
    if (command.type === 'page-upsert') {
      const metadata = command.page;
      const existing = pages.find((page) => page.id === metadata.id);
      const page: WhiteboardPage = {
        id: metadata.id,
        title: metadata.title,
        tags: this.normalizePageTags(metadata.tags),
        template: this.normalizeTemplateId(metadata.template),
        view: this.normalizePageView(metadata.view),
        background: this.normalizePageBackground(metadata.background),
        elements: existing?.elements ?? []
      };
      const next = pages.filter((item) => item.id !== page.id);
      next.splice(Math.max(0, Math.min(metadata.order, next.length)), 0, page);
      return next;
    }
    const pageId = command.pageId ?? this.activePageId();
    let next = pages;
    if (!next.some((page) => page.id === pageId)) {
      if (command.type !== 'upsert') {
        return next;
      }
      next = [...next, { ...this.createPage('Shared page'), id: pageId }];
    }
    return next.map((page) => {
      if (page.id !== pageId) {
        return page;
      }
      if (command.type === 'clear') {
        return { ...page, elements: [] };
      }
      if (command.type === 'delete') {
        return { ...page, elements: page.elements.filter((element) => element.id !== command.elementId) };
      }
      return { ...page, elements: this.upsertElementInList(page.elements, this.cloneElement(command.element), command.elementIndex) };
    });
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
    return [
      ...this.pages().flatMap((page, index): WhiteboardCommand[] => [
        { type: 'page-upsert', page: this.pageMetadata(page, index) },
        ...page.elements.map((element, elementIndex): WhiteboardCommand => ({ type: 'upsert', element: this.cloneElement(element), pageId: page.id, elementIndex }))
      ]),
      { type: 'page-select', pageId: this.activePageId() }
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

  protected selectPenTool(): void {
    if (this.readOnly()) return;
    this.activeTool.set('pen');
    if (this.activePenStyle() === 'marker') {
      this.activePenStyle.set('solid');
      this.penOpacity.set(1);
      this.strokeWidth.set(4);
      if (this.strokeColor() === '#FFD150') {
        this.strokeColor.set('#071c41');
      }
    }
    this.selectedElementIds.set([]);
    this.penMenuOpen.set(false);
  }

  protected selectHighlighter(): void {
    if (this.readOnly()) return;
    this.activeTool.set('pen');
    this.activePenStyle.set('marker');
    this.penOpacity.set(0.35);
    this.strokeWidth.set(16);
    if (this.strokeColor() === '#071c41' || this.strokeColor() === '#1e293b') {
      this.strokeColor.set('#FFD150');
    }
    this.selectedElementIds.set([]);
    this.penMenuOpen.set(false);
  }

  protected selectTool(tool: WhiteboardTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeTool.set(tool);
    if (tool !== 'select') {
      this.selectedElementIds.set([]);
    }
    if (!this.isShapeTool(tool)) {
      this.shapeMenuOpen.set(false);
    }
    if (!this.isGeometryTool(tool)) {
      this.geometryMenuOpen.set(false);
    }
    if (!this.isDiagramTool(tool)) {
      this.diagramMenuOpen.set(false);
    }
    if (tool !== 'pen') {
      this.penMenuOpen.set(false);
    }
  }

  protected toggleShapeMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.penMenuOpen.set(false);
    this.shapeMenuOpen.update((open) => !open);
  }

  protected selectShapeTool(tool: WhiteboardShapeTool): void {
    if (!this.canUseTool(tool)) {
      return;
    }
    this.activeShapeTool.set(tool);
    this.activeTool.set(tool);
    this.shapeMenuOpen.set(false);
    this.selectedElementIds.set([]);
  }

  protected toggleGeometryMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.penMenuOpen.set(false);
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
    this.selectedElementIds.set([]);
  }

  protected toggleDiagramMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.penMenuOpen.set(false);
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
    this.selectedElementIds.set([]);
  }

  protected togglePageManager(event?: Event): void {
    event?.stopPropagation();
    this.pageManagerOpen.update((open) => !open);
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
    this.penMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.colorMenuOpen.update((open) => !open);
  }

  protected toggleFillColorMenu(event: MouseEvent): void {
    if (this.readOnly() || !this.canUseTool('select')) {
      return;
    }
    event.stopPropagation();
    this.penMenuOpen.set(false);
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
    this.penMenuOpen.set(false);
    this.brushMenuOpen.update((open) => !open);
  }

  protected togglePenMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.canUseTool('pen')) {
      return;
    }
    this.activeTool.set('pen');
    this.shapeMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.diagramMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.brushMenuOpen.set(false);
    this.menuOpen.set(false);
    this.penMenuOpen.update((open) => !open);
  }

  protected selectPenStyle(style: WhiteboardPenStyle): void {
    if (!this.canUseTool('pen')) {
      return;
    }
    this.activePenStyle.set(style);
    this.activeTool.set('pen');
  }

  protected setPenOpacity(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.penOpacity.set(this.clampNumber(Number(inputElement.value), 0.1, 1));
  }

  protected setPenSmoothing(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.penSmoothing.set(this.clampNumber(Number(inputElement.value), 0, 0.85));
  }

  protected togglePressureSensitivePen(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.pressureSensitivePen.set(inputElement.checked && this.pressureInputAvailable());
  }

  protected togglePenAutoClose(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.penAutoCloseEnabled.set(inputElement.checked);
  }

  protected selectPenAutoCloseThreshold(value: number): void {
    this.penAutoCloseThreshold.set(value);
  }

  protected toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.penMenuOpen.set(false);
    this.menuOpen.update((open) => !open);
  }

  protected openMathTools(tab: MathToolsTab = 'equation'): void {
    if (this.readOnly()) {
      return;
    }
    if (tab === 'subjects' && !this.allowSubjectTemplates()) {
      tab = 'templates';
    }
    if (tab === 'equation') {
      this.loadSelectedEquationIntoMathPopover();
    }
    if (tab === 'tables') {
      this.ensureMatrixTableDraft();
    }
    this.activeMathTab.set(tab);
    this.menuOpen.set(false);
    this.shapeMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.diagramMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.penMenuOpen.set(false);
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
    if (tab === 'subjects' && !this.allowSubjectTemplates()) {
      return;
    }
    this.activeMathTab.set(tab);
    if (tab === 'equation') {
      window.setTimeout(() => this.mathEquationInput?.nativeElement.focus());
    }
    if (tab === 'tables') {
      this.ensureMatrixTableDraft();
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
      this.emitElementUpsert(element);
      this.render();
    } else {
      this.addElement(element);
    }
    this.activeTool.set('select');
  }

  protected applyMathTemplate(template: WhiteboardTemplateId): void {
    this.selectTemplate(template);
  }

  protected openSubjectTemplates(): void {
    if (!this.allowSubjectTemplates()) {
      return;
    }
    this.openMathTools('subjects');
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

  protected selectSubjectTemplateCategory(categoryId: SubjectTemplateCategoryId): void {
    this.activeSubjectTemplateCategory.set(categoryId);
  }

  protected setSubjectTemplateSearch(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    this.subjectTemplateSearch.set(inputElement.value);
  }

  protected canInsertSubjectTemplate(mode: SubjectTemplateInsertMode): boolean {
    if (!this.allowSubjectTemplates() || this.readOnly()) {
      return false;
    }
    if (mode === 'page' || mode === 'current') {
      return this.canManagePages();
    }
    return true;
  }

  protected insertSubjectTemplate(template: SubjectTemplateDefinition, mode: SubjectTemplateInsertMode): void {
    if (!this.canInsertSubjectTemplate(mode)) {
      return;
    }
    if (mode === 'page') {
      this.insertSubjectTemplateAsPage(template);
      return;
    }
    if (mode === 'current') {
      this.applySubjectTemplateToCurrentPage(template);
      return;
    }
    this.insertSubjectTemplateAsObject(template);
  }

  protected setMatrixTableMode(mode: MatrixTableMode): void {
    if (!this.canUseTool(mode)) {
      return;
    }
    this.ensureMatrixTableDraft(mode);
    this.matrixTableDraft.update((draft) =>
      draft
        ? {
            ...draft,
            mode,
            showBorders: mode === 'table' ? true : draft.showBorders,
            headerRow: mode === 'table' ? draft.headerRow : false,
            bracketStyle: mode === 'matrix' ? draft.bracketStyle : 'none',
            error: null
          }
        : draft
    );
  }

  protected applyMatrixTablePreset(preset: (typeof MATRIX_TABLE_PRESETS)[number]): void {
    if (!this.canUseTool(preset.mode)) {
      return;
    }
    const draft = this.matrixTableDraft() ?? this.createMatrixTableDraft(this.defaultInsertPoint(360, 220), preset.mode);
    this.matrixTableDraft.set({
      ...draft,
      mode: preset.mode,
      rows: preset.rows,
      columns: preset.columns,
      cells: this.normalizeMatrixTableCells(preset.cells, preset.rows, preset.columns),
      width: Math.max(draft.width, preset.mode === 'table' ? 380 : 260),
      height: Math.max(draft.height, Math.max(120, preset.rows * 48)),
      showBorders: preset.showBorders ?? preset.mode === 'table',
      headerRow: preset.headerRow ?? false,
      bracketStyle: preset.bracketStyle ?? (preset.mode === 'matrix' ? 'bracket' : 'none'),
      augmentedColumn: preset.augmentedColumn ?? null,
      error: null
    });
  }

  protected setMatrixTableRows(event: Event): void {
    this.resizeMatrixTableDraft(Number((event.target as HTMLInputElement).value), this.matrixTableDraft()?.columns ?? 2);
  }

  protected setMatrixTableColumns(event: Event): void {
    this.resizeMatrixTableDraft(this.matrixTableDraft()?.rows ?? 2, Number((event.target as HTMLInputElement).value));
  }

  protected updateMatrixTableCell(rowIndex: number, columnIndex: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.matrixTableDraft.update((draft) => {
      if (!draft) {
        return draft;
      }
      const cells = this.normalizeMatrixTableCells(draft.cells, draft.rows, draft.columns);
      cells[rowIndex]![columnIndex] = value;
      return { ...draft, cells, error: null };
    });
  }

  protected updateMatrixTableNumber(field: 'width' | 'height' | 'fontSize', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, [field]: value, error: null } : draft));
  }

  protected updateMatrixTableColor(field: 'strokeColor' | 'fillColor' | 'textColor' | 'borderColor', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, [field]: value, error: null } : draft));
  }

  protected updateMatrixTableBoolean(field: 'fillEnabled' | 'showBorders' | 'headerRow', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, [field]: checked, error: null } : draft));
  }

  protected setMatrixTableAlignment(align: WhiteboardTextAlignment): void {
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, align, error: null } : draft));
  }

  protected setMatrixBracketStyle(event: Event): void {
    const bracketStyle = (event.target as HTMLSelectElement).value as WhiteboardMatrixBracket;
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, bracketStyle, error: null } : draft));
  }

  protected setMatrixAugmentedColumn(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.matrixTableDraft.update((draft) => (draft ? { ...draft, augmentedColumn: value ? Number(value) : null, error: null } : draft));
  }

  protected matrixTableGridTemplate(columns: number): string {
    return `repeat(${this.clampInteger(columns, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS)}, minmax(54px, 1fr))`;
  }

  protected matrixAugmentedColumnOptions(columns: number): number[] {
    const safeColumns = this.clampInteger(columns, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS);
    return Array.from({ length: Math.max(0, safeColumns - 1) }, (_value, index) => index + 1);
  }

  protected commitMatrixTableDraft(): void {
    const draft = this.matrixTableDraft();
    if (!draft) {
      return;
    }
    const validation = this.validateMatrixTableDraft(draft);
    if (validation) {
      this.matrixTableDraft.set({ ...draft, error: validation });
      return;
    }
    const element = draft.mode === 'matrix' ? this.createMatrixElement(draft) : this.createTableElement(draft);
    this.pushHistory();
    if (draft.elementId) {
      this.elements = this.elements.map((item) => (item.id === draft.elementId ? element : item));
      this.selectedElementIds.set([draft.elementId]);
      this.emitElementUpsert(element);
      this.render();
    } else {
      this.addElement(element);
      this.setSelection([element.id]);
    }
    this.matrixTableDraft.set(null);
    this.activeTool.set('select');
  }

  protected cancelMatrixTableDraft(): void {
    this.matrixTableDraft.set(null);
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
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, template } : page)));
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
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

  protected enterPresentationMode(): void {
    if (!this.allowPresentationMode()) {
      return;
    }
    this.presentationModeEnabled.set(true);
    this.menuOpen.set(false);
    this.penMenuOpen.set(false);
    this.brushMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.shapeMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.diagramMenuOpen.set(false);
    this.contextMenu.set(null);
    if (this.canUseTool('laser')) {
      this.activeTool.set('laser');
    }
    this.render();
  }

  protected exitPresentationMode(): void {
    this.presentationModeEnabled.set(false);
    this.laserPoint.set(null);
    this.render();
  }

  protected togglePresentationEditMode(): void {
    this.presentationEditEnabled.update((enabled) => !enabled);
    if (!this.presentationEditEnabled() && this.canUseTool('laser')) {
      this.activeTool.set('laser');
    }
  }

  protected presentationSelectLaser(): void {
    if (this.canUseTool('laser')) {
      this.activeTool.set('laser');
    }
  }

  protected presentationSelectPen(style: WhiteboardPenStyle = 'solid'): void {
    if (!this.canUseTool('pen')) {
      return;
    }
    this.presentationEditEnabled.set(true);
    this.activePenStyle.set(style);
    this.activeTool.set('pen');
  }

  protected previousPresentationPage(): void {
    this.selectRelativePage(-1);
  }

  protected nextPresentationPage(): void {
    this.selectRelativePage(1);
  }

  protected hasPreviousPage(): boolean {
    return this.pages().findIndex((page) => page.id === this.activePageId()) > 0;
  }

  protected hasNextPage(): boolean {
    const index = this.pages().findIndex((page) => page.id === this.activePageId());
    return index >= 0 && index < this.pages().length - 1;
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
    if (this.readOnly()) {
      return;
    }
    const next = this.historyPast.at(-1);
    if (!next?.length || !this.acceptBoardChange(next, next.some((page) => page.id === this.activePageId()) ? this.activePageId() : next[0]!.id)) {
      return;
    }
    const previous = this.pages();
    const previousActivePageId = this.activePageId();
    this.historyPast.pop();
    this.historyFuture.push(previous);
    this.pages.set(next);
    this.ensureActivePage();
    this.applyPageView(this.activePage());
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.pruneImageCache();
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  protected redo(): void {
    if (this.readOnly()) {
      return;
    }
    const next = this.historyFuture.at(-1);
    if (!next?.length || !this.acceptBoardChange(next, next.some((page) => page.id === this.activePageId()) ? this.activePageId() : next[0]!.id)) {
      return;
    }
    const previous = this.pages();
    const previousActivePageId = this.activePageId();
    this.historyFuture.pop();
    this.historyPast.push(previous);
    this.pages.set(next);
    this.ensureActivePage();
    this.applyPageView(this.activePage());
    this.selectedElementIds.set([]);
    this.bumpHistoryVersion();
    this.pruneImageCache();
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  protected addPage(): void {
    if (!this.canManagePages()) {
      return;
    }
    const page = this.createPage(`Board ${this.pages().length + 1}`, this.activeTemplate());
    const nextPages = [...this.pages(), page];
    if (!this.acceptBoardChange(nextPages, page.id)) return;
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    this.pages.set(nextPages);
    this.activePageId.set(page.id);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  protected addPageBefore(): void {
    this.insertBlankPageRelativeToActive('before');
  }

  protected addPageAfter(): void {
    this.insertBlankPageRelativeToActive('after');
  }

  protected selectPage(pageId: string): void {
    if (pageId === this.activePageId() || !this.acceptBoardChange(this.pages(), pageId)) {
      return;
    }
    const page = this.pages().find((item) => item.id === pageId);
    if (!page) return;
    const previousPage = this.activePage();
    const previousOrder = this.pages().findIndex((item) => item.id === previousPage.id);
    const previousMetadata = this.pageMetadata(previousPage, previousOrder);
    this.persistActivePageView();
    const currentMetadata = this.pageMetadata(this.activePage(), previousOrder);
    this.activePageId.set(pageId);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
    if (this.canManagePages()) {
      if (JSON.stringify(previousMetadata) !== JSON.stringify(currentMetadata)) {
        this.commandCommitted.emit({ type: 'page-upsert', page: currentMetadata });
      }
      this.commandCommitted.emit({ type: 'page-select', pageId });
    }
    this.stateChanged.emit();
  }

  private selectRelativePage(delta: -1 | 1): void {
    const pages = this.pages();
    const currentIndex = pages.findIndex((page) => page.id === this.activePageId());
    const nextPage = pages[currentIndex + delta];
    if (!nextPage) {
      return;
    }
    this.selectPage(nextPage.id);
  }

  protected removeActivePage(): void {
    if (!this.canManagePages() || this.pages().length <= 1) {
      return;
    }
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
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
    this.commitPageChanges(previous, previousActivePageId);
  }

  protected duplicateActivePage(): void {
    if (!this.canManagePages()) {
      return;
    }
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
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
    this.commitPageChanges(previous, previousActivePageId);
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
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, title } : page)));
    this.commitPageChanges(previous, previousActivePageId);
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
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, tags } : page)));
    this.commitPageChanges(previous, previousActivePageId);
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
    this.openAssetPicker('element');
  }

  protected triggerBackgroundImport(): void {
    this.openAssetPicker('background');
  }

  protected triggerPdfPageImport(): void {
    this.openAssetPicker('pdf-pages');
  }

  protected triggerSlideImageImport(): void {
    this.openAssetPicker('slide-pages');
  }

  protected triggerDeckImport(): void {
    this.openAssetPicker('deck-pages');
  }

  private openAssetPicker(mode: AssetImportMode): void {
    if (!this.canImportAssets() || this.assetImporting()) return;
    this.assetImportMode.set(mode);
    this.assetImportStatus.set(null);
    const input = this.fileInput?.nativeElement;
    if (!input) return;
    // Native pickers read these attributes immediately, before Angular renders the signals.
    input.accept = this.assetInputAccept();
    input.multiple = this.assetInputMultiple();
    input.click();
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
    if (mode === 'deck-pages') {
      void this.importPresentationDeck(files[0]!);
      return;
    }
    void this.importAssetFile(files[0]!, mode);
  }

  protected setPdfExportMode(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as PdfExportMode;
    this.pdfExportMode.set(value === 'raster' ? 'raster' : 'hybrid');
  }

  protected resetPageBackground(): void {
    if (!this.canImportAssets() || !this.activePage().background) {
      return;
    }
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) => pages.map((page) => (page.id === activePageId ? { ...page, background: null } : page)));
    this.assetImportStatus.set({ type: 'success', message: 'Page background removed.' });
    this.pruneImageCache();
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
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
      this.emitElementUpsert(nextElement);
      this.assetImportStatus.set({ type: 'success', message: 'Selected image fit to the page.' });
      this.render();
      return;
    }
    const background = this.activePage().background;
    if (!background) {
      this.assetImportStatus.set({ type: 'info', message: 'Select an image or add a page background first.' });
      return;
    }
    const previous = this.clonePages(this.pages());
    this.pushHistory();
    const activePageId = this.activePageId();
    this.pages.update((pages) =>
      pages.map((page) => (page.id === activePageId ? { ...page, background: { ...background, fit: 'contain' } } : page))
    );
    this.assetImportStatus.set({ type: 'success', message: 'Page background fit to canvas.' });
    this.render();
    this.commitPageChanges(previous);
  }

  protected async exportPng(): Promise<void> {
    if (!this.canExportBoard()) {
      return;
    }
    if (!await this.prepareExportImages([this.activePage()])) return;
    const dataUrl = this.exportImage();
    this.downloadDataUrl(dataUrl, `${this.safeFileName(this.activePage().title)}.png`);
  }

  protected async exportPdf(): Promise<void> {
    if (!this.canExportBoard()) {
      return;
    }
    const exported = await this.exportSelectedPagesPdfBlob([this.activePageId()], this.activePage().title, this.pdfExportMode());
    if (!exported) {
      return;
    }
    this.downloadBlob(exported.blob, `${this.safeFileName(this.activePage().title)}.pdf`);
  }

  protected async exportAllPagesPdf(): Promise<void> {
    if (!this.canExportBoard()) {
      return;
    }
    const exported = await this.exportAllPagesPdfBlob();
    if (!exported) {
      return;
    }
    this.downloadBlob(exported.blob, exported.fileName);
  }

  protected async exportSelectedPagesPdf(): Promise<void> {
    if (!this.canExportSelectedPages()) {
      return;
    }
    const exported = await this.exportSelectedPagesPdfBlob(this.selectedExportPageIds(), `${this.title()} selected pages`);
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

  async exportAllPagesPdfBlob(fileBaseName = this.title(), mode = this.pdfExportMode()): Promise<{ blob: Blob; fileName: string } | null> {
    return this.exportSelectedPagesPdfBlob(this.pages().map((page) => page.id), `${fileBaseName}-pages`, mode);
  }

  async exportSelectedPagesPdfBlob(pageIds: string[], fileBaseName = this.title(), mode = this.pdfExportMode()): Promise<{ blob: Blob; fileName: string } | null> {
    if (!this.canExportBoard()) {
      return null;
    }
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return null;
    }
    const selectedIds = new Set(pageIds);
    const selectedPages = this.pages().filter((page) => selectedIds.has(page.id));
    if (!selectedPages.length || !await this.prepareExportImages(selectedPages)) {
      return null;
    }
    const pages = mode === 'hybrid' ? this.createHybridPdfPages(selectedPages, canvas.width, canvas.height) : this.createRasterPdfPages(selectedPages, canvas.width, canvas.height);
    return {
      blob: this.createPdfBlob(pages),
      fileName: `${this.safeFileName(fileBaseName) || 'whiteboard'}${fileBaseName.endsWith('-pages') ? '' : '-pages'}.pdf`
    };
  }

  private async prepareExportImages(pages: WhiteboardPage[]): Promise<boolean> {
    const dataUrls = new Set(pages.flatMap((page) => [
      ...(page.background?.dataUrl ? [page.background.dataUrl] : []),
      ...page.elements.flatMap((element) => element.type === 'file' && element.kind === 'image' ? [element.dataUrl] : [])
    ]));
    try {
      await Promise.all([...dataUrls].map((dataUrl) => this.resolveImage(dataUrl)?.decode()));
      return true;
    } catch {
      this.assetImportStatus.set({ type: 'error', message: 'A board image could not be loaded. Reload or replace it before exporting.' });
      return false;
    }
  }

  private createRasterPdfPages(pages: WhiteboardPage[], width: number, height: number): PdfImagePage[] {
    return pages.map((page) => ({
      jpegDataUrl: this.renderPageImage(page.id, 'image/jpeg', 0.92),
      width,
      height
    }));
  }

  private createHybridPdfPages(pages: WhiteboardPage[], width: number, height: number): PdfImagePage[] {
    try {
      return pages.map((page) => {
        const rasterElements = page.elements.filter((element) => !this.canRenderElementAsPdfVector(element));
        return {
          jpegDataUrl: this.renderPageImage(page.id, 'image/jpeg', 0.9, rasterElements),
          width,
          height,
          vectorContent: page.elements
            .filter((element) => this.canRenderElementAsPdfVector(element))
            .map((element) => this.pdfVectorForElement(element, height))
            .filter(Boolean)
            .join('\n')
        };
      });
    } catch {
      this.assetImportStatus.set({
        type: 'info',
        message: 'Hybrid PDF export fell back to exact raster snapshots for compatibility.'
      });
      return this.createRasterPdfPages(pages, width, height);
    }
  }

  protected updateTextDraft(event: Event): void {
    const inputElement = event.target as HTMLTextAreaElement;
    this.textDraft.update((draft) => (draft ? { ...draft, value: inputElement.value } : draft));
  }

  protected commitTextDraft(): void {
    const draft = this.textDraft();
    const text = draft?.value.trim() ?? '';
    if (!draft) {
      return;
    }

    if (draft.mode === 'diagram-label' && draft.elementId && draft.labelIndex !== undefined) {
      this.pushHistory();
      this.elements = this.elements.map((item) => {
        if (item.id === draft.elementId && item.type === 'diagram') {
          const nextLabels = [...(item.labels ?? [])];
          nextLabels[draft.labelIndex!] = text;
          const updated: WhiteboardDiagramElement = { ...item, labels: nextLabels };
          this.emitElementUpsert(updated);
          return updated;
        }
        return item;
      });
      this.textDraft.set(null);
      this.render();
      return;
    }

    if (draft.mode === 'shape-text' && draft.elementId) {
      this.pushHistory();
      this.elements = this.elements.map((item) => {
        if (item.id === draft.elementId && item.type === 'shape') {
          const updated: WhiteboardShapeElement = {
            ...item,
            text,
            textColor: this.strokeColor(),
            fontSize: this.fontSize()
          };
          this.emitElementUpsert(updated);
          return updated;
        }
        return item;
      });
      this.textDraft.set(null);
      this.render();
      return;
    }

    if (!text) {
      this.textDraft.set(null);
      return;
    }
    const element = draft.mode === 'equation' ? this.createEquationElement(draft, text) : this.createTextElement(draft, text);
    this.pushHistory();
    if (draft.elementId) {
      this.elements = this.elements.map((item) => (item.id === draft.elementId ? element : item));
      this.selectedElementIds.set([]);
      this.emitElementUpsert(element);
      this.render();
    } else {
      this.addElement(element, this.activePageId(), false);
    }
    this.textDraft.set(null);
  }

  protected cancelTextDraft(): void {
    this.textDraft.set(null);
  }

  protected handleWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const surface = this.whiteboardSurface?.nativeElement;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const oldZoom = this.zoom();
      const zoomFactor = event.deltaY < 0 ? 1.08 : 0.92;
      const newZoom = Math.min(Math.max(Number((oldZoom * zoomFactor).toFixed(2)), 0.3), 3.0);
      if (newZoom !== oldZoom) {
        const scaleChange = newZoom / oldZoom;
        const newPanX = mouseX - (mouseX - this.panX()) * scaleChange;
        const newPanY = mouseY - (mouseY - this.panY()) * scaleChange;
        this.panX.set(Math.round(newPanX));
        this.panY.set(Math.round(newPanY));
        this.zoom.set(newZoom);
        this.persistActivePageView();
        this.render();
      }
    } else {
      this.panX.update((x) => Math.round(x - event.deltaX));
      this.panY.update((y) => Math.round(y - event.deltaY));
      this.persistActivePageView();
      this.render();
    }
  }

  @HostListener('window:keyup', ['$event'])
  protected handleWindowKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space' && this.isSpacePressed) {
      this.isSpacePressed = false;
      if (this.previousToolBeforeSpace) {
        this.activeTool.set(this.previousToolBeforeSpace);
        this.previousToolBeforeSpace = null;
      }
    }
  }

  protected onTextEditorEnter(event: Event | KeyboardEvent): void {
    const keyEvent = event as KeyboardEvent;
    if (this.textDraft()?.mode === 'diagram-label' || (!keyEvent.shiftKey && this.textDraft()?.mode === 'shape-text') || (!keyEvent.shiftKey && this.textDraft()?.mode === 'text')) {
      event.preventDefault();
      this.commitTextDraft();
    } else if (keyEvent.ctrlKey || keyEvent.metaKey) {
      event.preventDefault();
      this.commitTextDraft();
    }
  }

  protected onTextEditorBlur(): void {
    const draft = this.textDraft();
    if (draft) {
      window.setTimeout(() => {
        if (this.textDraft()) {
          this.commitTextDraft();
        }
      }, 150);
    }
  }

  protected insertStickyNote(color = '#FEF08A'): void {
    if (this.readOnly()) {
      return;
    }
    const point = this.defaultInsertPoint(180, 180);
    const strokeColor = color === '#FEF08A' ? '#CA8A04' : color === '#BFDBFE' ? '#2563EB' : color === '#BBF7D0' ? '#16A34A' : '#E11D48';
    const textColor = color === '#FEF08A' ? '#713F12' : color === '#BFDBFE' ? '#1E3A8A' : color === '#BBF7D0' ? '#14532D' : '#881337';
    const element: WhiteboardShapeElement = {
      id: `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'shape',
      shape: 'rectangle',
      strokeColor,
      fillColor: color,
      width: 2,
      from: { x: point.x, y: point.y },
      to: { x: point.x + 180, y: point.y + 180 },
      text: 'Sticky Note',
      textColor,
      fontSize: 16
    };
    this.pushHistory();
    this.addElement(element, this.activePageId(), false);
    this.selectedElementIds.set([]);
    this.openShapeTextDraft(element);
  }

  private openShapeTextDraft(element: WhiteboardShapeElement): void {
    const centerX = (element.from.x + element.to.x) / 2;
    const centerY = (element.from.y + element.to.y) / 2;
    const width = Math.max(120, Math.min(300, Math.abs(element.to.x - element.from.x) * 0.85));
    this.textDraft.set({
      x: Math.round(centerX - width / 2),
      y: Math.round(centerY - 22),
      value: element.text ?? '',
      mode: 'shape-text',
      elementId: element.id,
      width,
      height: 44,
      align: 'center'
    });
    this.render();
    window.setTimeout(() => {
      this.textEditor?.nativeElement.select();
    });
  }

  private diagramLabelPositions(element: WhiteboardDiagramElement): Array<{ x: number; y: number; index: number; label: string }> {
    const bounds = this.boundsForElement(element);
    const results: Array<{ x: number; y: number; index: number; label: string }> = [];

    if (element.kind === 'tree' || element.kind === 'probability-tree') {
      const root = { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.2, index: 0, label: element.labels[0] ?? 'Root' };
      const rowOne = [
        { x: bounds.x + bounds.width * 0.3, y: bounds.y + bounds.height * 0.48, index: 1, label: element.labels[1] ?? 'A' },
        { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.48, index: 2, label: element.labels[2] ?? 'B' }
      ];
      const rowTwo = [
        { x: bounds.x + bounds.width * 0.18, y: bounds.y + bounds.height * 0.76, index: 3, label: element.labels[3] ?? 'A1' },
        { x: bounds.x + bounds.width * 0.42, y: bounds.y + bounds.height * 0.76, index: 4, label: element.labels[4] ?? 'A2' },
        { x: bounds.x + bounds.width * 0.58, y: bounds.y + bounds.height * 0.76, index: 5, label: element.labels[5] ?? 'B1' },
        { x: bounds.x + bounds.width * 0.82, y: bounds.y + bounds.height * 0.76, index: 6, label: element.labels[6] ?? 'B2' }
      ];
      results.push(root, ...rowOne, ...rowTwo);
      if (element.kind === 'probability-tree') {
        results.push(
          { x: (root.x + rowOne[0]!.x) / 2 - 12, y: (root.y + rowOne[0]!.y) / 2, index: 7, label: element.labels[7] ?? 'p' },
          { x: (root.x + rowOne[1]!.x) / 2 + 16, y: (root.y + rowOne[1]!.y) / 2, index: 8, label: element.labels[8] ?? '1-p' }
        );
      }
      return results;
    }

    if (element.kind === 'venn') {
      const radius = Math.min(bounds.width, bounds.height) * 0.28;
      const left = { x: bounds.x + bounds.width * 0.42, y: bounds.y + bounds.height * 0.48 };
      const right = { x: bounds.x + bounds.width * 0.58, y: bounds.y + bounds.height * 0.48 };
      results.push(
        { x: left.x - radius * 0.45, y: left.y, index: 0, label: element.labels[0] ?? 'A' },
        { x: right.x + radius * 0.45, y: right.y, index: 1, label: element.labels[1] ?? 'B' },
        { x: bounds.x + bounds.width / 2, y: left.y + radius + 24, index: 2, label: element.labels[2] ?? 'A ∩ B' }
      );
      return results;
    }

    if (element.kind === 'node-edge') {
      results.push(
        { x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.32, index: 0, label: element.labels[0] ?? 'A' },
        { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.28, index: 1, label: element.labels[1] ?? 'B' },
        { x: bounds.x + bounds.width * 0.36, y: bounds.y + bounds.height * 0.7, index: 2, label: element.labels[2] ?? 'C' },
        { x: bounds.x + bounds.width * 0.78, y: bounds.y + bounds.height * 0.68, index: 3, label: element.labels[3] ?? 'D' }
      );
      return results;
    }

    results.push(
      { x: bounds.x + bounds.width * 0.21, y: bounds.y + bounds.height * 0.47, index: 0, label: element.labels[0] ?? 'Start' },
      { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.47, index: 1, label: element.labels[1] ?? 'Step' },
      { x: bounds.x + bounds.width * 0.79, y: bounds.y + bounds.height * 0.47, index: 2, label: element.labels[2] ?? 'Result' }
    );
    return results;
  }

  private openDiagramLabelDraft(element: WhiteboardDiagramElement, point?: WhiteboardPoint): void {
    const positions = this.diagramLabelPositions(element);
    let target = positions[0]!;
    if (point) {
      let minDistance = Infinity;
      for (const pos of positions) {
        const dist = Math.hypot(pos.x - point.x, pos.y - point.y);
        if (dist < minDistance) {
          minDistance = dist;
          target = pos;
        }
      }
    }
    const currentLabel = element.labels?.[target.index] ?? target.label;
    this.textDraft.set({
      x: Math.round(target.x - 65),
      y: Math.round(target.y - 18),
      value: currentLabel,
      mode: 'diagram-label',
      elementId: element.id,
      labelIndex: target.index,
      width: 130,
      height: 38,
      align: 'center'
    });
    this.render();
    window.setTimeout(() => {
      this.textEditor?.nativeElement.select();
    });
  }

  private isDarkFillColor(color: string): boolean {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return (r * 0.299 + g * 0.587 + b * 0.114) < 140;
      }
    }
    return false;
  }

  protected canEditSelectedDiagram(): boolean {
    return this.selectedElements().some((element) => element.type === 'diagram');
  }

  protected canEditSelectedShapeText(): boolean {
    return this.selectedElements().some((element) => element.type === 'shape');
  }

  protected editSelectedDiagramLabels(): void {
    const diagram = this.selectedElements().find((element): element is WhiteboardDiagramElement => element.type === 'diagram');
    if (diagram) {
      this.openDiagramLabelDraft(diagram);
    }
  }

  protected editSelectedShapeText(): void {
    const shape = this.selectedElements().find((element): element is WhiteboardShapeElement => element.type === 'shape');
    if (shape) {
      this.openShapeTextDraft(shape);
    }
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

  protected canEditSelectedMatrixTable(): boolean {
    return !!this.singleSelectedMatrixTable();
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
    this.emitElementUpsert(equation);
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
      this.emitElementUpsert(element);
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

  protected editSelectedMatrixTable(): void {
    const element = this.singleSelectedMatrixTable();
    if (!element) {
      return;
    }
    this.openMatrixTableDraftForElement(element);
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
      this.emitElementUpsert(element);
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
    if (!this.selectedElementIds().includes(element.id)) {
      this.setSelectionForElement(element, event.shiftKey);
    }
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
    this.diagramMenuOpen.set(false);
    this.geometryMenuOpen.set(false);
    this.colorMenuOpen.set(false);
    this.fillColorMenuOpen.set(false);
    this.penMenuOpen.set(false);
    this.brushMenuOpen.set(false);
    this.menuOpen.set(false);
    this.contextMenu.set(null);
    this.textDraft.set(null);
    this.graphDraft.set(null);
    this.matrixTableDraft.set(null);
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
    this.emitSelectionUpserts();
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
    this.emitSelectionUpserts();
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
      this.emitElementUpsert(element);
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

    if (this.activeTool() === 'pan' || event.button === 1 || this.isSpacePressed) {
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
      if (element?.type === 'shape') {
        this.setSelectionForElement(element, false);
        this.openShapeTextDraft(element);
        this.render();
        return;
      }
      if (element?.type === 'diagram') {
        this.setSelectionForElement(element, false);
        this.openDiagramLabelDraft(element, point);
        this.render();
        return;
      }
      if (element?.type === 'graph') {
        this.setSelectionForElement(element, false);
        this.openGraphDraftForElement(element);
        this.render();
        return;
      }
      if (element?.type === 'matrix' || element?.type === 'table') {
        this.setSelectionForElement(element, false);
        this.openMatrixTableDraftForElement(element);
        this.render();
        return;
      }
      if (!element && !this.readOnly()) {
        this.textDraft.set({
          x: Math.round(point.x),
          y: Math.round(point.y),
          value: '',
          mode: 'text',
          align: 'left'
        });
        this.activeTool.set('text');
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
        if (event.shiftKey || !this.selectedElementIds().includes(element.id)) {
          this.setSelectionForElement(element, event.shiftKey);
        }
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
      this.addElement(this.createDiagramElement(this.activeTool() as WhiteboardDiagramTool, this.snapPoint(point)), this.activePageId(), false);
      this.selectedElementIds.set([]);
      this.render();
      return;
    }

    if (this.isGeometryTool(this.activeTool())) {
      const start = this.snapPoint(point);
      if (this.activeTool() === 'point') {
        this.pushHistory();
        this.addElement(this.createGeometryElement('point', start, start), this.activePageId(), false);
        this.selectedElementIds.set([]);
        this.render();
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
      const start = this.snapPoint(point);
      this.lastPoint = start;
      this.shapeStart = start;
      this.previewElement = this.createShapeElement(start, start, this.activeTool() as WhiteboardShapeTool);
    } else {
      const strokePoint = this.getStrokePoint(event, point);
      this.lastPoint = strokePoint;
      this.previewElement = this.createStrokeElement([strokePoint]);
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
    let nextPoint = this.snapPoint(point, this.shapeStart ?? undefined);
    if (this.previewElement.type === 'shape' && this.shapeStart) {
      if (event.shiftKey) {
        const dx = nextPoint.x - this.shapeStart.x;
        const dy = nextPoint.y - this.shapeStart.y;
        if (this.previewElement.shape === 'rectangle' || this.previewElement.shape === 'ellipse' || this.previewElement.shape === 'star') {
          const maxDist = Math.max(Math.abs(dx), Math.abs(dy));
          nextPoint = {
            x: this.shapeStart.x + Math.sign(dx || 1) * maxDist,
            y: this.shapeStart.y + Math.sign(dy || 1) * maxDist
          };
        } else if (this.previewElement.shape === 'line' || this.previewElement.shape === 'arrow') {
          const angle = Math.atan2(dy, dx);
          const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          nextPoint = {
            x: this.shapeStart.x + Math.cos(snapAngle) * len,
            y: this.shapeStart.y + Math.sin(snapAngle) * len
          };
        }
      }
      this.previewElement = this.createShapeElement(this.shapeStart, nextPoint, this.previewElement.shape);
    } else if (this.previewElement.type === 'geometry' && this.shapeStart) {
      this.previewElement = this.createGeometryElement(this.previewElement.kind, this.shapeStart, nextPoint, this.previewElement.id);
    } else if (this.previewElement.type === 'stroke') {
      const firstPoint = this.previewElement.points[0];
      if (event.shiftKey && firstPoint) {
        const dx = nextPoint.x - firstPoint.x;
        const dy = nextPoint.y - firstPoint.y;
        const angle = Math.atan2(dy, dx);
        const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        const straightPoint: WhiteboardStrokePoint = {
          x: Math.round(firstPoint.x + Math.cos(snapAngle) * len),
          y: Math.round(firstPoint.y + Math.sin(snapAngle) * len)
        };
        this.previewElement = {
          ...this.previewElement,
          points: [firstPoint, straightPoint]
        };
        this.lastPoint = straightPoint;
        this.render();
        return;
      }
      const previousStrokePoint = this.previewElement.points[this.previewElement.points.length - 1];
      const nextStrokePoint = this.getStrokePoint(event, nextPoint, previousStrokePoint);
      this.previewElement = {
        ...this.previewElement,
        points: [...this.previewElement.points, nextStrokePoint]
      };
      this.lastPoint = nextStrokePoint;
      this.render();
      return;
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
      this.previewElement = this.finalizePreviewElement(this.previewElement);
      this.pushHistory();
      this.addElement(this.previewElement, this.activePageId(), false);
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
    if (this.activeTool() !== 'select') {
      this.selectedElementIds.set([]);
    }
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
      this.drawAutoClosePreview(this.previewElement);
    }
    if (includeOverlays) {
      this.drawAlignmentGuides();
      this.drawSnapIndicator();
      this.drawSelection();
      this.drawSelectionMarquee();
      this.drawEraserCursor();
      if (this.captureStreamActive) {
        this.drawLaserPointer();
      }
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
      this.pruneImageCache();
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
      this.pruneImageCache();
      this.assetImportMode.set('element');
      this.assetImporting.set(false);
    }
  }

  private async importPresentationDeck(file: File): Promise<void> {
    this.assetImporting.set(true);
    try {
      this.validatePresentationFile(file);
      this.assetImportStatus.set({
        type: 'info',
        message: `Preparing ${file.name} for slide conversion...`
      });
      await Promise.resolve();
      throw new Error(
        'Native PPT/PPTX slide conversion is not configured in this build. Export the deck to PDF and use Import PDF pages, or export slides as PNG/JPG and use Import slide images.'
      );
    } catch (error) {
      this.assetImportStatus.set({
        type: 'error',
        message: error instanceof Error ? error.message : 'Presentation import failed.'
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

  private validatePresentationFile(file: File): void {
    const name = file.name.toLowerCase();
    const isPresentation = PRESENTATION_ASSET_MIME_TYPES.has(file.type) || name.endsWith('.pptx') || name.endsWith('.ppt');
    if (!isPresentation) {
      throw new Error('Use a PPT or PPTX presentation file.');
    }
    if (file.size > MAX_PRESENTATION_ASSET_BYTES) {
      throw new Error('Presentation is too large. Use a file under 50 MB.');
    }
    if (name.endsWith('.ppt')) {
      throw new Error('Legacy .ppt files need server-side conversion. Export to PDF or PPTX first, then import the converted pages.');
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
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, document.baseURI).toString();
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

  private assertImportFits(pages: WhiteboardPage[], commands: WhiteboardCommand[], activePageId = this.activePageId()): void {
    const encoder = new TextEncoder();
    if (commands.some((command) => encoder.encode(JSON.stringify(command)).byteLength > MAX_IMPORTED_COMMAND_BYTES)) {
      throw new Error('This imported page or object is too large to share. Use a smaller image or lower-resolution PDF.');
    }
    this.assertBoardFits(pages, activePageId);
  }

  private assertBoardFits(pages: WhiteboardPage[], activePageId = this.activePageId()): void {
    if (pages.length > MAX_BOARD_PAGES) {
      throw new Error(`A board can contain up to ${MAX_BOARD_PAGES} pages. Remove a page or start a new board.`);
    }
    if (pages.reduce((count, page) => count + page.elements.length, 0) > MAX_BOARD_ELEMENTS) {
      throw new Error(`A board can contain up to ${MAX_BOARD_ELEMENTS} objects. Remove some objects or start a new board.`);
    }
    const encoder = new TextEncoder();
    // Pages/elements are replaced immutably. Cache unchanged pages so each pen stroke
    // checks its own page instead of serializing the entire classroom board again.
    let snapshotBytes = encoder.encode(JSON.stringify({ schemaVersion: 1, activePageId, pages: [] })).byteLength;
    pages.forEach((page, index) => {
      let cached = this.pageSizeCache.get(page);
      if (!cached) {
        cached = new Map();
        this.pageSizeCache.set(page, cached);
      }
      let pageBytes = cached.get(index);
      if (pageBytes === undefined) {
        pageBytes = encoder.encode(JSON.stringify({ ...this.pageMetadata(page, index), elements: page.elements })).byteLength;
        cached.set(index, pageBytes);
      }
      snapshotBytes += pageBytes + (index > 0 ? 1 : 0);
    });
    if (snapshotBytes > MAX_IMPORTED_SNAPSHOT_BYTES) {
      throw new Error('This change exceeds the saved board size limit. Remove some content or start a new board.');
    }
  }

  private acceptBoardChange(pages: WhiteboardPage[], activePageId = this.activePageId()): boolean {
    try {
      this.assertBoardFits(pages, activePageId);
      return true;
    } catch (error) {
      this.assetImportStatus.set({ type: 'error', message: error instanceof Error ? error.message : 'The board limit was reached.' });
      return false;
    }
  }

  private discardUnchangedHistory(pages: WhiteboardPage[]): void {
    const previous = this.historyPast.at(-1);
    if (previous && JSON.stringify(previous) === JSON.stringify(pages)) {
      this.historyPast.pop();
      this.bumpHistoryVersion();
    }
  }

  private insertImportedPages(importedPages: WhiteboardPage[]): void {
    if (!importedPages.length) {
      return;
    }
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    const activePageId = this.activePageId();
    const activeIndex = this.pages().findIndex((page) => page.id === activePageId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : this.pages().length;
    const nextPages = [...this.pages().slice(0, insertIndex), ...importedPages, ...this.pages().slice(insertIndex)];
    this.assertImportFits(nextPages, importedPages.flatMap((page, index): WhiteboardCommand[] => [
      { type: 'page-upsert', page: this.pageMetadata(page, insertIndex + index) },
      ...page.elements.map((element, elementIndex): WhiteboardCommand => ({ type: 'upsert', element, pageId: page.id, elementIndex }))
    ]), importedPages[0]!.id);
    this.pushHistory();
    this.pages.set(nextPages);
    this.activePageId.set(importedPages[0]!.id);
    this.applyPageView(importedPages[0]!);
    this.selectedElementIds.set([]);
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  private insertBlankPageRelativeToActive(position: 'before' | 'after'): void {
    if (!this.canManagePages()) {
      return;
    }
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
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
    this.commitPageChanges(previous, previousActivePageId);
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
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
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
    const nextPages = this.pages().map((page) => page.id === targetPageId ? { ...page, background } : page);
    const pageIndex = nextPages.findIndex((page) => page.id === targetPageId);
    this.assertImportFits(nextPages, [{ type: 'page-upsert', page: this.pageMetadata(nextPages[pageIndex]!, pageIndex) }]);
    this.pushHistory();
    this.pages.set(nextPages);
    this.assetImportStatus.set({ type: 'success', message: `${file.name} set as page background.` });
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  private createFileElement(file: File, dataUrl: string, image: HTMLImageElement): void {
    const targetPageId = this.activePageId();
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
    const nextPages = this.pages().map((page) => page.id === targetPageId ? { ...page, elements: [...page.elements, element] } : page);
    this.assertImportFits(nextPages, [{ type: 'upsert', element, pageId: targetPageId }]);
    this.pushHistory();
    this.addElement(element, targetPageId);
    this.assetImportStatus.set({ type: 'success', message: `${file.name} added as a movable image.` });
  }

  private createDocumentElement(file: File, dataUrl: string): void {
    const targetPageId = this.activePageId();
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
    const nextPages = this.pages().map((page) => page.id === targetPageId ? { ...page, elements: [...page.elements, element] } : page);
    this.assertImportFits(nextPages, [{ type: 'upsert', element, pageId: targetPageId }]);
    this.pushHistory();
    this.addElement(element, targetPageId);
  }

  private getCanvasPoint(event: PointerEvent): WhiteboardPoint {
    return this.getCanvasPointFromClient(event.clientX, event.clientY);
  }

  private getStrokePoint(event: PointerEvent, point = this.getCanvasPoint(event), previous?: WhiteboardStrokePoint): WhiteboardStrokePoint {
    this.detectPressureInput(event);
    const pressure = this.pointerPressure(event);
    const nextPoint: WhiteboardStrokePoint = pressure === undefined ? { ...point } : { ...point, pressure };
    return this.smoothStrokePoint(previous, nextPoint);
  }

  private detectPressureInput(event: PointerEvent): void {
    const hasStylusPressure = event.pointerType === 'pen' || (Number.isFinite(event.pressure) && event.pressure > 0 && event.pressure !== 0.5);
    if (hasStylusPressure) {
      this.pressureInputAvailable.set(true);
    }
  }

  private pointerPressure(event: PointerEvent): number | undefined {
    if (!this.pressureSensitivePen() || !this.pressureInputAvailable() || !Number.isFinite(event.pressure) || event.pressure <= 0) {
      return undefined;
    }
    return this.clampNumber(event.pressure, 0.05, 1);
  }

  private smoothStrokePoint(previous: WhiteboardStrokePoint | undefined, nextPoint: WhiteboardStrokePoint): WhiteboardStrokePoint {
    const smoothing = this.penSmoothing();
    if (!previous || smoothing <= 0) {
      return nextPoint;
    }
    const weight = 1 - this.clampNumber(smoothing, 0, 0.85);
    const pressure =
      previous.pressure === undefined && nextPoint.pressure === undefined
        ? undefined
        : (previous.pressure ?? nextPoint.pressure ?? 0.5) * smoothing + (nextPoint.pressure ?? previous.pressure ?? 0.5) * weight;
    return {
      x: previous.x + (nextPoint.x - previous.x) * weight,
      y: previous.y + (nextPoint.y - previous.y) * weight,
      ...(pressure === undefined ? {} : { pressure: this.clampNumber(pressure, 0.05, 1) })
    };
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

  private finalizePreviewElement(element: WhiteboardElement): WhiteboardElement {
    return element.type === 'stroke' ? this.finalizeStrokeElement(element) : element;
  }

  private finalizeStrokeElement(element: WhiteboardStrokeElement): WhiteboardStrokeElement {
    if (!this.penAutoCloseEnabled()) {
      return {
        ...element,
        closed: false,
        autoCloseThreshold: this.penAutoCloseThreshold()
      };
    }
    const threshold = this.penAutoCloseThreshold();
    const closedPoints = this.autoClosedStrokePoints(element, threshold);
    if (!closedPoints) {
      return {
        ...element,
        autoCloseThreshold: threshold
      };
    }
    return {
      ...element,
      points: closedPoints,
      closed: true,
      autoCloseThreshold: threshold
    };
  }

  private addElement(element: WhiteboardElement, pageId = this.activePageId(), autoSelect = false): void {
    const nextElement = this.cloneElement(element);
    const nextPages = this.pages().map((page) => page.id === pageId ? { ...page, elements: [...page.elements, nextElement] } : page);
    if (!this.acceptBoardChange(nextPages)) {
      this.discardUnchangedHistory(this.pages());
      this.previewElement = null;
      this.render();
      return;
    }
    this.pages.set(nextPages);
    this.previewElement = null;
    if (pageId === this.activePageId()) {
      if (autoSelect) {
        this.selectedElementIds.set([element.id]);
      } else {
        this.selectedElementIds.set([]);
      }
      this.render();
    }
    this.emitElementUpsert(element, pageId);
  }

  private insertSubjectTemplateAsPage(template: SubjectTemplateDefinition): void {
    const previous = this.clonePages(this.pages());
    const previousActivePageId = this.activePageId();
    this.pushHistory();
    const page = this.createPage(this.uniquePageTitle(template.pageTitle), template.pageTemplate);
    page.tags = [...template.tags];
    page.elements = this.createSubjectTemplateElements(template, { x: 0, y: 0 });
    const activePageId = this.activePageId();
    const activeIndex = this.pages().findIndex((item) => item.id === activePageId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : this.pages().length;
    this.pages.update((pages) => [...pages.slice(0, insertIndex), page, ...pages.slice(insertIndex)]);
    this.activePageId.set(page.id);
    this.applyPageView(page);
    this.selectedElementIds.set([]);
    this.render();
    this.commitPageChanges(previous, previousActivePageId);
  }

  private applySubjectTemplateToCurrentPage(template: SubjectTemplateDefinition): void {
    const pageId = this.activePageId();
    const elements = this.createSubjectTemplateElements(template, { x: 0, y: 0 });
    const previous = this.clonePages(this.pages());
    this.pushHistory();
    this.pages.update((pages) =>
      pages.map((page) =>
        page.id === pageId
          ? {
              ...page,
              template: template.pageTemplate,
              tags: Array.from(new Set([...(page.tags ?? []), ...template.tags])),
              elements: [...page.elements, ...elements.map((element) => this.cloneElement(element))]
            }
          : page
      )
    );
    this.setSelection(elements.map((element) => element.id));
    this.render();
    this.commitPageChanges(previous);
  }

  private insertSubjectTemplateAsObject(template: SubjectTemplateDefinition): void {
    const groupId = this.createElementId();
    const origin = this.defaultInsertPoint(720, 520);
    const elements = this.createSubjectTemplateElements(template, origin, groupId);
    const pageId = this.activePageId();
    this.pushHistory();
    this.pages.update((pages) =>
      pages.map((page) =>
        page.id === pageId ? { ...page, elements: [...page.elements, ...elements.map((element) => this.cloneElement(element))] } : page
      )
    );
    this.setSelection(elements.map((element) => element.id));
    this.render();
    for (const element of elements) {
      this.emitElementUpsert(element, pageId);
    }
    this.stateChanged.emit();
  }

  private createSubjectTemplateElements(
    template: SubjectTemplateDefinition,
    origin: WhiteboardPoint,
    groupId?: string
  ): WhiteboardElement[] {
    const elements: WhiteboardElement[] = [
      this.createSubjectText({
        x: origin.x + 60,
        y: origin.y + 36,
        width: 520,
        height: 34,
        text: template.name,
        fontSize: 28,
        color: '#071c41',
        groupId
      }),
      this.createSubjectText({
        x: origin.x + 60,
        y: origin.y + 70,
        width: 640,
        height: 24,
        text: template.description,
        fontSize: 14,
        color: '#587083',
        groupId
      }),
      this.createSubjectShape({
        x: origin.x + 60,
        y: origin.y + 104,
        width: 160,
        height: 4,
        strokeColor: template.accent,
        fillColor: template.accent,
        groupId
      })
    ];

    for (const region of template.regions) {
      elements.push(...this.createSubjectTemplateRegion(region, template, origin, groupId));
    }
    return elements;
  }

  private createSubjectTemplateRegion(
    region: SubjectTemplateRegion,
    template: SubjectTemplateDefinition,
    origin: WhiteboardPoint,
    groupId?: string
  ): WhiteboardElement[] {
    const x = origin.x + region.x;
    const y = origin.y + region.y;
    const kind = region.kind ?? 'work';
    if (kind === 'graph') {
      return [
        this.createSubjectGraph(region, template, { x, y }, groupId)
      ];
    }
    if (kind === 'table') {
      return [
        this.createSubjectText({
          x,
          y,
          width: region.width,
          height: 24,
          text: region.title,
          fontSize: 15,
          color: template.accent,
          groupId
        }),
        this.createSubjectTable(region, template, { x, y: y + 30 }, groupId)
      ];
    }
    if (kind === 'diagram') {
      return [
        this.createSubjectText({
          x,
          y,
          width: region.width,
          height: 24,
          text: region.title,
          fontSize: 15,
          color: template.accent,
          groupId
        }),
        this.createSubjectDiagram(region, template, { x, y: y + 30 }, groupId)
      ];
    }
    return [
      this.createSubjectShape({ x, y, width: region.width, height: region.height, strokeColor: template.accent, groupId }),
      this.createSubjectText({
        x: x + 14,
        y: y + 12,
        width: Math.max(80, region.width - 28),
        height: 24,
        text: region.title,
        fontSize: 16,
        color: template.accent,
        groupId
      }),
      this.createSubjectText({
        x: x + 14,
        y: y + 42,
        width: Math.max(80, region.width - 28),
        height: Math.max(28, region.height - 54),
        text: region.detail ?? 'Add lesson notes here.',
        fontSize: kind === 'formula' ? 18 : 14,
        color: '#24364b',
        groupId
      })
    ];
  }

  private createSubjectText(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSize: number;
    color: string;
    groupId?: string;
  }): WhiteboardTextElement {
    return {
      id: this.createElementId(),
      groupId: options.groupId,
      type: 'text',
      color: options.color,
      fillColor: null,
      fontSize: options.fontSize,
      position: { x: options.x, y: options.y },
      text: options.text,
      width: options.width,
      height: options.height,
      align: 'left'
    };
  }

  private createSubjectShape(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    strokeColor: string;
    fillColor?: string;
    groupId?: string;
  }): WhiteboardShapeElement {
    return {
      id: this.createElementId(),
      groupId: options.groupId,
      type: 'shape',
      shape: 'rectangle',
      strokeColor: options.strokeColor,
      fillColor: options.fillColor ?? '#ffffff',
      width: options.height <= 6 ? Math.max(1, options.height) : 2,
      from: { x: options.x, y: options.y },
      to: { x: options.x + options.width, y: options.y + options.height }
    };
  }

  private createSubjectTable(
    region: SubjectTemplateRegion,
    template: SubjectTemplateDefinition,
    position: WhiteboardPoint,
    groupId?: string
  ): WhiteboardTableElement {
    const rows = this.clampInteger(region.rows ?? region.cells?.length ?? 4, MATRIX_TABLE_MIN_ROWS, MATRIX_TABLE_MAX_ROWS);
    const columns = this.clampInteger(region.columns ?? region.cells?.[0]?.length ?? 3, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS);
    return {
      id: this.createElementId(),
      groupId,
      type: 'table',
      position,
      width: Math.max(180, region.width),
      height: Math.max(110, region.height - 30),
      rows,
      columns,
      cells: this.normalizeMatrixTableCells(region.cells ?? this.defaultMatrixTableCells(rows, columns, 'table'), rows, columns),
      fontSize: 16,
      strokeColor: template.accent,
      fillColor: '#ffffff',
      textColor: '#071c41',
      borderColor: '#9eb3aa',
      showBorders: true,
      align: 'center',
      headerRow: region.headerRow ?? true
    };
  }

  private createSubjectGraph(
    region: SubjectTemplateRegion,
    template: SubjectTemplateDefinition,
    position: WhiteboardPoint,
    groupId?: string
  ): WhiteboardGraphElement {
    const graph = region.graph ?? {};
    const expressions = (graph.expression ?? '').split(';').map((expression) => expression.trim()).filter(Boolean);
    return {
      id: this.createElementId(),
      groupId,
      type: 'graph',
      position,
      width: Math.max(220, region.width),
      height: Math.max(180, region.height),
      title: region.title,
      xMin: graph.xMin ?? -10,
      xMax: graph.xMax ?? 10,
      yMin: graph.yMin ?? -10,
      yMax: graph.yMax ?? 10,
      showGrid: true,
      showAxes: true,
      showTicks: true,
      tickStep: null,
      functions: expressions.map((expression, index) => ({
        id: `fn-${index + 1}`,
        expression,
        color: index === 0 ? template.accent : index === 1 ? '#458B73' : '#FF9760',
        width: 2
      })),
      inequality: '',
      parametric: null,
      polar: null,
      scatterPoints: graph.scatterPoints ?? '',
      scatterColor: '#FF9760',
      labels: [],
      stats: {
        histogramData: graph.histogramData ?? '',
        histogramBins: graph.histogramBins,
        showRegression: graph.showRegression ?? false,
        normalMean: null,
        normalStdDev: null
      },
      helpers: {
        pointX: null,
        tangentX: null,
        shadeFrom: graph.shadeFrom ?? null,
        shadeTo: graph.shadeTo ?? null,
        showIntercepts: false
      }
    };
  }

  private createSubjectDiagram(
    region: SubjectTemplateRegion,
    template: SubjectTemplateDefinition,
    position: WhiteboardPoint,
    groupId?: string
  ): WhiteboardDiagramElement {
    const kind = region.diagramKind ?? 'flow';
    return {
      id: this.createElementId(),
      groupId,
      type: 'diagram',
      kind,
      position,
      width: Math.max(180, region.width),
      height: Math.max(140, region.height - 30),
      strokeColor: template.accent,
      fillColor: '#FFD150',
      lineWidth: 2,
      labels: this.defaultDiagramLabels(kind)
    };
  }

  private upsertElementInList(elements: WhiteboardElement[], element: WhiteboardElement, elementIndex?: number): WhiteboardElement[] {
    const nextElement = this.cloneElement(element);
    const previousIndex = elements.findIndex((item) => item.id === element.id);
    const next = elements.filter((item) => item.id !== element.id);
    const requestedIndex = elementIndex !== undefined && Number.isInteger(elementIndex) && elementIndex >= 0
      ? elementIndex
      : previousIndex >= 0 ? previousIndex : next.length;
    next.splice(Math.min(requestedIndex, next.length), 0, nextElement);
    return next;
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
    } else if (element.type === 'matrix') {
      this.drawMatrixElement(element);
    } else if (element.type === 'table') {
      this.drawTableElement(element);
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
    const style = this.strokePenStyle(element);
    const opacity = this.strokeOpacity(element);
    const width = this.strokeRenderWidth(element);
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = width;
    context.strokeStyle = element.color;
    context.fillStyle = element.color;
    context.globalAlpha = opacity;
    this.configureStrokeDash(context, style, width);
    if (element.points.length === 1) {
      const point = element.points[0]!;
      context.beginPath();
      context.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
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

    if (style === 'calligraphy' || (this.strokePressureEnabled(element) && element.points.some((point) => point.pressure !== undefined))) {
      this.drawVariableStrokePath(context, element, width, style);
    } else {
      this.drawStrokePolyline(context, element.points);
      if (style === 'pencil') {
        context.globalAlpha = opacity * 0.35;
        context.lineWidth = Math.max(0.8, width * 0.55);
        this.drawStrokePolyline(
          context,
          element.points.map((point, index) => ({
            ...point,
            x: point.x + (index % 2 === 0 ? 0.65 : -0.45),
            y: point.y + (index % 2 === 0 ? -0.4 : 0.55)
          }))
        );
      }
    }
    context.restore();
  }

  private drawStrokePolyline(context: CanvasRenderingContext2D, points: readonly WhiteboardStrokePoint[]): void {
    if (!points.length) {
      return;
    }
    context.beginPath();
    if (points.length === 1) {
      context.arc(points[0]!.x, points[0]!.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    if (points.length === 2) {
      context.moveTo(points[0]!.x, points[0]!.y);
      context.lineTo(points[1]!.x, points[1]!.y);
      context.stroke();
      return;
    }
    context.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i]!.x + points[i + 1]!.x) / 2;
      const midY = (points[i]!.y + points[i + 1]!.y) / 2;
      context.quadraticCurveTo(points[i]!.x, points[i]!.y, midX, midY);
    }
    context.lineTo(points[points.length - 1]!.x, points[points.length - 1]!.y);
    context.stroke();
  }

  private drawVariableStrokePath(context: CanvasRenderingContext2D, element: WhiteboardStrokeElement, baseWidth: number, style: WhiteboardPenStyle): void {
    for (let index = 1; index < element.points.length; index += 1) {
      const previous = element.points[index - 1]!;
      const current = element.points[index]!;
      context.lineWidth = this.strokeSegmentWidth(element, previous, current, baseWidth, style);
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
  }

  private strokePenStyle(element: WhiteboardStrokeElement): WhiteboardPenStyle {
    const style = element.penStyle ?? element.style;
    return this.penStyleOptions.some((option) => option.id === style) ? style! : 'solid';
  }

  private strokePressureEnabled(element: WhiteboardStrokeElement): boolean {
    return element.pressureEnabled ?? element.pressureSensitive ?? false;
  }

  private strokeOpacity(element: WhiteboardStrokeElement): number {
    const fallback = this.strokePenStyle(element) === 'marker' ? 0.42 : 1;
    return this.clampNumber(element.opacity ?? fallback, 0.05, 1);
  }

  private strokeRenderWidth(element: WhiteboardStrokeElement): number {
    const style = this.strokePenStyle(element);
    if (style === 'marker') {
      return Math.max(2, element.width * 2.35);
    }
    if (style === 'pencil') {
      return Math.max(1, element.width * 0.82);
    }
    if (style === 'calligraphy') {
      return Math.max(1, element.width * 1.15);
    }
    return Math.max(1, element.width);
  }

  private configureStrokeDash(context: CanvasRenderingContext2D, style: WhiteboardPenStyle, width: number): void {
    if (style === 'dashed') {
      context.setLineDash([Math.max(8, width * 3), Math.max(5, width * 1.8)]);
      return;
    }
    if (style === 'dotted') {
      context.lineCap = 'round';
      context.setLineDash([0.01, Math.max(6, width * 2.2)]);
      return;
    }
    context.setLineDash([]);
  }

  private strokeSegmentWidth(
    element: WhiteboardStrokeElement,
    previous: WhiteboardStrokePoint,
    current: WhiteboardStrokePoint,
    baseWidth: number,
    style: WhiteboardPenStyle
  ): number {
    const pressureEnabled = this.strokePressureEnabled(element);
    const pressure = pressureEnabled ? (previous.pressure ?? current.pressure ?? 0.65) : 0.65;
    const pressureScale = pressureEnabled ? 0.55 + this.clampNumber(pressure, 0.05, 1) * 0.9 : 1;
    if (style !== 'calligraphy') {
      return Math.max(0.8, baseWidth * pressureScale);
    }
    const angle = Math.atan2(current.y - previous.y, current.x - previous.x);
    const nibScale = 0.62 + Math.abs(Math.cos(angle - Math.PI / 4)) * 0.72;
    return Math.max(0.8, baseWidth * nibScale * pressureScale);
  }

  private drawAutoClosePreview(element: WhiteboardElement): void {
    const context = this.context;
    if (!context || element.type !== 'stroke' || !this.penAutoCloseEnabled() || !this.autoClosedStrokePoints(element)) {
      return;
    }
    const first = element.points[0]!;
    const last = element.points[element.points.length - 1]!;
    context.save();
    context.strokeStyle = this.cssVariable('--wb-primary', '#F26076');
    context.fillStyle = this.cssVariable('--wb-attention', '#FFD150');
    context.globalAlpha = 0.82;
    context.lineWidth = 1.5;
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(last.x, last.y);
    context.lineTo(first.x, first.y);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 0.92;
    for (const point of [first, last]) {
      context.beginPath();
      context.arc(point.x, point.y, 7, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
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

    if (element.text) {
      const fontSize = element.fontSize ?? Math.max(13, Math.min(22, Math.abs(element.to.y - element.from.y) * 0.22));
      context.font = `600 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
      context.fillStyle = element.textColor ?? (element.fillColor && this.isDarkFillColor(element.fillColor) ? '#ffffff' : element.strokeColor);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const centerX = (element.from.x + element.to.x) / 2;
      const centerY = (element.from.y + element.to.y) / 2;
      const lines = element.text.split('\n');
      const lineHeight = fontSize * 1.3;
      const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < lines.length; i++) {
        context.fillText(lines[i]!, centerX, startY + i * lineHeight);
      }
    }
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

  private drawMatrixElement(element: WhiteboardMatrixElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const bounds = this.boundsForElement(element);
    context.save();
    if (element.fillColor) {
      this.drawRoundedBlock(context, bounds, element.fillColor);
    }
    const bracketPadding = element.bracketStyle === 'none' ? 8 : 28;
    const gridBounds: ElementBounds = {
      x: bounds.x + bracketPadding,
      y: bounds.y + 10,
      width: Math.max(24, bounds.width - bracketPadding * 2),
      height: Math.max(24, bounds.height - 20)
    };
    this.drawCellGrid(context, element, gridBounds, false);
    if (element.showBorders) {
      this.drawCellGridLines(context, gridBounds, element.rows, element.columns, element.borderColor, 1);
    }
    if (element.augmentedColumn && element.augmentedColumn > 0 && element.augmentedColumn < element.columns) {
      const x = gridBounds.x + (gridBounds.width / element.columns) * element.augmentedColumn;
      context.save();
      context.strokeStyle = element.borderColor;
      context.lineWidth = Math.max(1.4, element.fontSize / 16);
      context.beginPath();
      context.moveTo(x, gridBounds.y);
      context.lineTo(x, gridBounds.y + gridBounds.height);
      context.stroke();
      context.restore();
    }
    this.drawMatrixBrackets(context, bounds, element);
    context.restore();
  }

  private drawTableElement(element: WhiteboardTableElement): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const bounds = this.boundsForElement(element);
    context.save();
    context.fillStyle = element.fillColor ?? this.cssVariable('--canvas-bg', '#f8fbff');
    this.roundedRectPath(context, bounds.x, bounds.y, bounds.width, bounds.height, 8);
    context.fill();
    if (element.headerRow && element.rows > 0) {
      context.save();
      context.globalAlpha = 0.18;
      context.fillStyle = element.fillColor ?? '#FFD150';
      context.beginPath();
      context.rect(bounds.x, bounds.y, bounds.width, bounds.height / element.rows);
      context.fill();
      context.restore();
    }
    this.drawCellGrid(context, element, bounds, element.headerRow);
    if (element.showBorders) {
      this.drawCellGridLines(context, bounds, element.rows, element.columns, element.borderColor, 1);
    } else {
      context.strokeStyle = element.strokeColor;
      context.lineWidth = 1.4;
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
    context.restore();
  }

  private drawCellGrid(
    context: CanvasRenderingContext2D,
    element: WhiteboardMatrixElement | WhiteboardTableElement,
    bounds: ElementBounds,
    emphasizeHeader: boolean
  ): void {
    const rows = Math.max(1, element.rows);
    const columns = Math.max(1, element.columns);
    const cellWidth = bounds.width / columns;
    const cellHeight = bounds.height / rows;
    context.save();
    context.textBaseline = 'middle';
    context.fillStyle = element.textColor;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const text = element.cells[row]?.[column] ?? '';
        const fontWeight = emphasizeHeader && row === 0 ? 800 : 650;
        const fontSize = Math.min(element.fontSize, Math.max(10, cellHeight * 0.42));
        context.font = `${fontWeight} ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
        const maxTextWidth = Math.max(8, cellWidth - 14);
        const measured = context.measureText(text).width;
        let x = bounds.x + column * cellWidth + 7;
        if ((element.align ?? 'center') === 'center') {
          x = bounds.x + column * cellWidth + cellWidth / 2 - Math.min(measured, maxTextWidth) / 2;
        } else if (element.align === 'right') {
          x = bounds.x + (column + 1) * cellWidth - Math.min(measured, maxTextWidth) - 7;
        }
        const y = bounds.y + row * cellHeight + cellHeight / 2;
        context.save();
        context.beginPath();
        context.rect(bounds.x + column * cellWidth + 4, bounds.y + row * cellHeight + 3, Math.max(1, cellWidth - 8), Math.max(1, cellHeight - 6));
        context.clip();
        context.fillText(text, x, y);
        context.restore();
      }
    }
    context.restore();
  }

  private drawCellGridLines(context: CanvasRenderingContext2D, bounds: ElementBounds, rows: number, columns: number, color: string, width: number): void {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    for (let column = 0; column <= columns; column += 1) {
      const x = bounds.x + (bounds.width / columns) * column;
      context.moveTo(x, bounds.y);
      context.lineTo(x, bounds.y + bounds.height);
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = bounds.y + (bounds.height / rows) * row;
      context.moveTo(bounds.x, y);
      context.lineTo(bounds.x + bounds.width, y);
    }
    context.stroke();
    context.restore();
  }

  private drawMatrixBrackets(context: CanvasRenderingContext2D, bounds: ElementBounds, element: WhiteboardMatrixElement): void {
    if (element.bracketStyle === 'none') {
      return;
    }
    context.save();
    context.strokeStyle = element.strokeColor;
    context.lineWidth = Math.max(1.6, element.fontSize / 14);
    const top = bounds.y + 8;
    const bottom = bounds.y + bounds.height - 8;
    const left = bounds.x + 14;
    const right = bounds.x + bounds.width - 14;
    if (element.bracketStyle === 'determinant') {
      context.beginPath();
      context.moveTo(left, top);
      context.lineTo(left, bottom);
      context.moveTo(right, top);
      context.lineTo(right, bottom);
      context.stroke();
      context.restore();
      return;
    }
    const hook = element.bracketStyle === 'parentheses' ? 4 : 12;
    context.beginPath();
    context.moveTo(left + hook, top);
    context.lineTo(left, top);
    context.lineTo(left, bottom);
    context.lineTo(left + hook, bottom);
    context.moveTo(right - hook, top);
    context.lineTo(right, top);
    context.lineTo(right, bottom);
    context.lineTo(right - hook, bottom);
    context.stroke();
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

  private createStrokeElement(points: WhiteboardStrokePoint[]): WhiteboardStrokeElement {
    return {
      id: this.createElementId(),
      type: 'stroke',
      color: this.strokeColor(),
      fillColor: this.fillEnabled() ? this.fillColor() : null,
      width: this.strokeWidth(),
      penStyle: this.activePenStyle(),
      opacity: this.penOpacity(),
      smoothing: this.penSmoothing(),
      pressureEnabled: this.pressureSensitivePen() && points.some((point) => point.pressure !== undefined),
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

  private ensureMatrixTableDraft(mode: MatrixTableMode = 'matrix'): void {
    const selected = this.singleSelectedMatrixTable();
    if (selected) {
      this.openMatrixTableDraftForElement(selected);
      return;
    }
    if (!this.matrixTableDraft()) {
      this.matrixTableDraft.set(this.createMatrixTableDraft(this.defaultInsertPoint(mode === 'table' ? 380 : 280, 220), mode));
    }
  }

  private createMatrixTableDraft(point: WhiteboardPoint, mode: MatrixTableMode): MatrixTableDraft {
    const rows = mode === 'table' ? 4 : 2;
    const columns = mode === 'table' ? 3 : 2;
    return {
      mode,
      x: point.x,
      y: point.y,
      width: mode === 'table' ? 380 : 280,
      height: mode === 'table' ? 220 : 160,
      rows,
      columns,
      cells: this.defaultMatrixTableCells(rows, columns, mode),
      fontSize: 24,
      strokeColor: this.strokeColor(),
      fillColor: this.fillColor(),
      fillEnabled: this.fillEnabled(),
      textColor: this.strokeColor(),
      borderColor: this.strokeColor(),
      showBorders: mode === 'table',
      align: 'center',
      headerRow: mode === 'table',
      bracketStyle: mode === 'matrix' ? 'bracket' : 'none',
      augmentedColumn: null
    };
  }

  private createMatrixElement(draft: MatrixTableDraft): WhiteboardMatrixElement {
    const rows = this.clampInteger(draft.rows, MATRIX_TABLE_MIN_ROWS, MATRIX_TABLE_MAX_ROWS);
    const columns = this.clampInteger(draft.columns, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS);
    return {
      id: draft.elementId ?? this.createElementId(),
      type: 'matrix',
      position: { x: draft.x, y: draft.y },
      width: Math.max(160, draft.width),
      height: Math.max(96, draft.height),
      rows,
      columns,
      cells: this.normalizeMatrixTableCells(draft.cells, rows, columns),
      fontSize: Math.max(12, draft.fontSize),
      strokeColor: draft.strokeColor,
      fillColor: draft.fillEnabled ? draft.fillColor : null,
      textColor: draft.textColor,
      borderColor: draft.borderColor,
      showBorders: draft.showBorders,
      align: draft.align,
      bracketStyle: draft.bracketStyle,
      augmentedColumn: draft.augmentedColumn ?? null
    };
  }

  private createTableElement(draft: MatrixTableDraft): WhiteboardTableElement {
    const rows = this.clampInteger(draft.rows, MATRIX_TABLE_MIN_ROWS, MATRIX_TABLE_MAX_ROWS);
    const columns = this.clampInteger(draft.columns, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS);
    return {
      id: draft.elementId ?? this.createElementId(),
      type: 'table',
      position: { x: draft.x, y: draft.y },
      width: Math.max(180, draft.width),
      height: Math.max(110, draft.height),
      rows,
      columns,
      cells: this.normalizeMatrixTableCells(draft.cells, rows, columns),
      fontSize: Math.max(12, draft.fontSize),
      strokeColor: draft.strokeColor,
      fillColor: draft.fillEnabled ? draft.fillColor : null,
      textColor: draft.textColor,
      borderColor: draft.borderColor,
      showBorders: draft.showBorders,
      align: draft.align,
      headerRow: draft.headerRow
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

  private validateMatrixTableDraft(draft: MatrixTableDraft): string | null {
    if (!this.canUseTool(draft.mode)) {
      return 'This whiteboard tool is not available right now.';
    }
    if (
      !Number.isFinite(draft.width) ||
      !Number.isFinite(draft.height) ||
      !Number.isFinite(draft.fontSize) ||
      !Number.isFinite(draft.rows) ||
      !Number.isFinite(draft.columns)
    ) {
      return 'Rows, columns, size, width, and height must be valid numbers.';
    }
    if (draft.rows < MATRIX_TABLE_MIN_ROWS || draft.rows > MATRIX_TABLE_MAX_ROWS || draft.columns < MATRIX_TABLE_MIN_COLUMNS || draft.columns > MATRIX_TABLE_MAX_COLUMNS) {
      return `Use ${MATRIX_TABLE_MIN_ROWS}-${MATRIX_TABLE_MAX_ROWS} rows and ${MATRIX_TABLE_MIN_COLUMNS}-${MATRIX_TABLE_MAX_COLUMNS} columns.`;
    }
    if (draft.width < 120 || draft.height < 80 || draft.fontSize < 10) {
      return 'Matrix/table dimensions are too small.';
    }
    return null;
  }

  private openMatrixTableDraftForElement(element: WhiteboardMatrixElement | WhiteboardTableElement): void {
    const isMatrix = element.type === 'matrix';
    this.matrixTableDraft.set({
      elementId: element.id,
      mode: element.type,
      x: element.position.x,
      y: element.position.y,
      width: element.width,
      height: element.height,
      rows: element.rows,
      columns: element.columns,
      cells: this.normalizeMatrixTableCells(element.cells, element.rows, element.columns),
      fontSize: element.fontSize,
      strokeColor: element.strokeColor,
      fillColor: element.fillColor ?? this.fillColor(),
      fillEnabled: !!element.fillColor,
      textColor: element.textColor,
      borderColor: element.borderColor,
      showBorders: element.showBorders,
      align: element.align ?? 'center',
      headerRow: !isMatrix && element.headerRow,
      bracketStyle: isMatrix ? element.bracketStyle : 'none',
      augmentedColumn: isMatrix ? element.augmentedColumn ?? null : null
    });
    this.strokeColor.set(element.strokeColor);
    if (element.fillColor) {
      this.fillColor.set(element.fillColor);
      this.fillEnabled.set(true);
    } else {
      this.fillEnabled.set(false);
    }
    this.activeMathTab.set('tables');
    this.mathPopoverOpen.set(true);
    this.clampMathPopoverToViewport();
  }

  private resizeMatrixTableDraft(rows: number, columns: number): void {
    this.matrixTableDraft.update((draft) => {
      if (!draft) {
        return draft;
      }
      const nextRows = this.clampInteger(rows, MATRIX_TABLE_MIN_ROWS, MATRIX_TABLE_MAX_ROWS);
      const nextColumns = this.clampInteger(columns, MATRIX_TABLE_MIN_COLUMNS, MATRIX_TABLE_MAX_COLUMNS);
      return {
        ...draft,
        rows: nextRows,
        columns: nextColumns,
        cells: this.normalizeMatrixTableCells(draft.cells, nextRows, nextColumns),
        error: null
      };
    });
  }

  private normalizeMatrixTableCells(cells: string[][] | undefined, rows: number, columns: number): string[][] {
    return Array.from({ length: rows }, (_row, rowIndex) =>
      Array.from({ length: columns }, (_column, columnIndex) => String(cells?.[rowIndex]?.[columnIndex] ?? ''))
    );
  }

  private defaultMatrixTableCells(rows: number, columns: number, mode: MatrixTableMode): string[][] {
    if (mode === 'table') {
      return Array.from({ length: rows }, (_row, rowIndex) =>
        Array.from({ length: columns }, (_column, columnIndex) => (rowIndex === 0 ? `Header ${columnIndex + 1}` : ''))
      );
    }
    return Array.from({ length: rows }, (_row, rowIndex) => Array.from({ length: columns }, (_column, columnIndex) => (rowIndex === columnIndex ? '1' : '0')));
  }

  private clampInteger(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  private clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
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

  private pageMetadata(page: WhiteboardPage, order: number): WhiteboardPageMetadata {
    return {
      id: page.id,
      title: page.title,
      tags: [...(page.tags ?? [])],
      order,
      template: page.template,
      view: { ...page.view },
      background: page.background ? structuredClone(page.background) as unknown as Record<string, unknown> : null
    };
  }

  private commitPageChanges(previous: WhiteboardPage[], previousActivePageId = this.activePageId()): void {
    const next = this.pages();
    if (!this.acceptBoardChange(next)) {
      this.pages.set(previous);
      this.activePageId.set(previousActivePageId);
      this.ensureActivePage();
      this.applyPageView(this.activePage());
      this.discardUnchangedHistory(previous);
      this.selectedElementIds.set([]);
      this.render();
      return;
    }
    const canManagePages = this.canManagePages();
    // Create/restore pages before their elements; remove pages only after replacements exist.
    next.forEach((page, order) => {
      const previousOrder = previous.findIndex((item) => item.id === page.id);
      const oldPage = previous[previousOrder];
      const metadata = this.pageMetadata(page, order);
      if (canManagePages && (!oldPage || JSON.stringify(metadata) !== JSON.stringify(this.pageMetadata(oldPage, previousOrder)))) {
        this.commandCommitted.emit({ type: 'page-upsert', page: metadata });
      }
      const oldElements = new Map(oldPage?.elements.map((element) => [element.id, element]) ?? []);
      const nextIds = new Set(page.elements.map((element) => element.id));
      for (const element of oldPage?.elements ?? []) {
        if (!nextIds.has(element.id)) {
          this.commandCommitted.emit({ type: 'delete', elementId: element.id, pageId: page.id });
        }
      }
      const projectedOrder = (oldPage?.elements ?? []).filter((element) => nextIds.has(element.id)).map((element) => element.id);
      page.elements.forEach((element, elementIndex) => {
        const currentIndex = projectedOrder.indexOf(element.id);
        if (currentIndex !== elementIndex || JSON.stringify(oldElements.get(element.id)) !== JSON.stringify(element)) {
          this.commandCommitted.emit({ type: 'upsert', element: this.cloneElement(element), pageId: page.id, elementIndex });
          if (currentIndex >= 0) projectedOrder.splice(currentIndex, 1);
          projectedOrder.splice(elementIndex, 0, element.id);
        }
      });
    });
    if (canManagePages) {
      for (const page of previous) {
        if (!next.some((item) => item.id === page.id)) {
          this.commandCommitted.emit({ type: 'page-delete', pageId: page.id });
        }
      }
      if (previousActivePageId !== this.activePageId()) {
        this.commandCommitted.emit({ type: 'page-select', pageId: this.activePageId() });
      }
    }
    this.stateChanged.emit();
  }

  private applyPageView(page: WhiteboardPage): void {
    const view = page.view ?? DEFAULT_PAGE_VIEW;
    this.zoom.set(view.zoom ?? DEFAULT_PAGE_VIEW.zoom);
    this.panX.set(view.panX ?? DEFAULT_PAGE_VIEW.panX);
    this.panY.set(view.panY ?? DEFAULT_PAGE_VIEW.panY);
  }

  private ensureActivePage(): void {
    if (this.pages().length && !this.pages().some((page) => page.id === this.activePageId())) {
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
    const tolerance = Math.max(10, this.strokeRenderWidth(element) + 6);
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
      this.emitElementUpsert(element);
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
      } else if (element.type === 'geometry' || element.type === 'diagram' || element.type === 'matrix' || element.type === 'table') {
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
      this.emitElementUpsert(element);
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
      this.emitElementUpsert(element);
    }
    this.render();
  }

  private canElementReceiveFill(
    element: WhiteboardElement
  ): element is
    | WhiteboardStrokeElement
    | WhiteboardShapeElement
    | WhiteboardTextElement
    | WhiteboardEquationElement
    | WhiteboardGeometryElement
    | WhiteboardDiagramElement
    | WhiteboardMatrixElement
    | WhiteboardTableElement {
    return (
      (element.type === 'stroke' && !!this.strokeFillPath(element)) ||
      (element.type === 'shape' && this.isFillableShape(element.shape)) ||
      element.type === 'geometry' ||
      element.type === 'diagram' ||
      element.type === 'matrix' ||
      element.type === 'table' ||
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

    const nextPages = this.pages().map((page) => page.id === this.activePageId() ? { ...page, elements: nextElements } : page);
    if (!this.acceptBoardChange(nextPages)) return;
    if (!this.eraseHistoryPushed) {
      this.pushHistory();
      this.eraseHistoryPushed = true;
    }

    this.elements = nextElements;
    this.selectedElementIds.update((ids) => ids.filter((id) => nextElements.some((element) => element.id === id)));
    for (const command of commands.filter((item) => item.type === 'delete')) {
      this.commandCommitted.emit(command);
    }
    for (const command of commands) {
      if (command.type === 'upsert') {
        this.emitElementUpsert(command.element);
      }
    }
  }

  private eraseStroke(element: WhiteboardStrokeElement, from: WhiteboardPoint, to: WhiteboardPoint, radius: number): WhiteboardStrokeElement[] | null {
    const threshold = radius + this.strokeRenderWidth(element) / 2;
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
    const threshold = radius + this.strokeRenderWidth(element) / 2;
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
    if (element.type === 'equation' || element.type === 'graph' || element.type === 'diagram' || element.type === 'matrix' || element.type === 'table') {
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
      } else if (next.type === 'matrix' || next.type === 'table') {
        next.width *= scaleX;
        next.height *= scaleY;
        next.fontSize = Math.max(10, next.fontSize * Math.max(scaleX, scaleY));
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
    if (next.type === 'file' || next.type === 'equation' || next.type === 'graph' || next.type === 'diagram' || next.type === 'matrix' || next.type === 'table') {
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
    const previous = this.clonePages(this.pages());
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
    this.commitPageChanges(previous);
    this.render();
  }

  private reorderSelectedToEdge(edge: 'front' | 'back'): void {
    const selectedIds = this.selectedElementIds();
    if (!selectedIds.length) {
      return;
    }
    const previous = this.clonePages(this.pages());
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
    this.commitPageChanges(previous);
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

  private emitElementUpsert(element: WhiteboardElement, pageId = this.activePageId()): void {
    if (!this.acceptBoardChange(this.pages())) {
      const previous = this.historyPast.pop();
      if (previous) {
        this.pages.set(previous);
        this.ensureActivePage();
        this.applyPageView(this.activePage());
        this.selectedElementIds.set([]);
        this.bumpHistoryVersion();
        this.pruneImageCache();
        this.render();
      }
      return;
    }
    const page = this.pages().find((page) => page.id === pageId);
    const elementIndex = page?.elements.findIndex((item) => item.id === element.id);
    // A preceding item in a bulk edit may have rolled back the whole edit.
    if (elementIndex === undefined || elementIndex < 0 || JSON.stringify(page!.elements[elementIndex]) !== JSON.stringify(element)) return;
    this.commandCommitted.emit({
      type: 'upsert', element: this.cloneElement(element), pageId,
      ...(elementIndex !== undefined && elementIndex >= 0 ? { elementIndex } : {})
    });
  }

  private emitSelectionUpserts(): void {
    for (const element of this.elements.filter((item) => this.selectedElementIds().includes(item.id))) {
      this.emitElementUpsert(element);
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

  private singleSelectedMatrixTable(): WhiteboardMatrixElement | WhiteboardTableElement | null {
    const selectedIds = this.selectedElementIds();
    if (selectedIds.length !== 1) {
      return null;
    }
    const element = this.elements.find((item) => item.id === selectedIds[0]);
    return element?.type === 'matrix' || element?.type === 'table' ? element : null;
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
    if (element.type === 'shape' || element.type === 'geometry' || element.type === 'diagram' || element.type === 'matrix' || element.type === 'table') {
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
    // All page and element edits replace their values; sharing unchanged snapshots
    // avoids copying every stroke in a large board for each undo entry.
    this.historyPast.push(this.pages());
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
    this.render();
    if (this.laserTimeout) {
      window.clearTimeout(this.laserTimeout);
    }
    this.laserTimeout = window.setTimeout(() => {
      this.laserPoint.set(null);
      this.render();
    }, 900);
  }

  private drawLaserPointer(): void {
    const point = this.laserPoint();
    const context = this.context;
    if (!point || !context) {
      return;
    }
    context.save();
    context.fillStyle = 'rgba(242, 96, 118, 0.25)';
    context.beginPath();
    context.arc(point.x, point.y, 10, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#F26076';
    context.beginPath();
    context.arc(point.x, point.y, 4, 0, Math.PI * 2);
    context.fill();
    context.restore();
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
    if (element.closed === false) {
      return null;
    }
    const points = element.points;
    if (points.length < 3) {
      return null;
    }

    const closeThreshold = this.strokeCloseThreshold(element);
    const minimumArea = this.strokeMinimumFillArea(element);
    const first = points[0]!;
    const last = points[points.length - 1]!;

    if (element.closed === true) {
      const closedPoints = this.distance(first, last) <= 0.5 ? points : [...points, first];
      return Math.abs(this.polygonArea(closedPoints)) >= minimumArea ? { points: closedPoints.map((point) => ({ ...point })) } : null;
    }

    if (this.distance(first, last) <= closeThreshold && Math.abs(this.polygonArea(points)) >= minimumArea) {
      return { points: points.map((point) => ({ ...point })) };
    }

    const endpointLoop = this.endpointClosedStrokePath(points, closeThreshold, minimumArea);
    if (endpointLoop) {
      return endpointLoop;
    }

    return this.selfIntersectingStrokePath(points, minimumArea);
  }

  private autoClosedStrokePoints(element: WhiteboardStrokeElement, threshold = this.penAutoCloseThreshold()): WhiteboardStrokePoint[] | null {
    const points = element.points;
    if (points.length < 3) {
      return null;
    }
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (this.distance(first, last) > threshold) {
      return null;
    }
    const closedPoints = this.distance(first, last) <= 0.5 ? points : [...points, first];
    if (Math.abs(this.polygonArea(closedPoints)) < this.strokeMinimumFillArea(element)) {
      return null;
    }
    return closedPoints.map((point) => ({ ...point }));
  }

  private strokeCloseThreshold(element: WhiteboardStrokeElement): number {
    if (Number.isFinite(element.autoCloseThreshold)) {
      return this.clampNumber(element.autoCloseThreshold!, 8, 96);
    }
    return Math.max(18, element.width * 3);
  }

  private strokeMinimumFillArea(element: WhiteboardStrokeElement): number {
    return Math.max(36, element.width * element.width * 3);
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

  private renderPageImage(pageId: string, type: 'image/png' | 'image/jpeg', quality?: number, elementsOverride?: WhiteboardElement[]): string {
    const canvas = this.whiteboardCanvas?.nativeElement;
    if (!canvas) {
      return '';
    }
    const previousPageId = this.activePageId();
    const previousSelection = this.selectedElementIds();
    const previousPreview = this.previewElement;
    const previousPages = elementsOverride ? this.pages() : null;
    this.previewElement = null;
    this.activePageId.set(pageId);
    if (elementsOverride) {
      this.pages.update((pages) => pages.map((page) => (page.id === pageId ? { ...page, elements: elementsOverride.map((element) => this.cloneElement(element)) } : page)));
    }
    this.selectedElementIds.set([]);
    this.render(false);
    const dataUrl = canvas.toDataURL(type, quality);
    if (previousPages) {
      this.pages.set(previousPages);
    }
    this.activePageId.set(previousPageId);
    this.selectedElementIds.set(previousSelection);
    this.previewElement = previousPreview;
    this.render();
    return dataUrl;
  }

  private canRenderElementAsPdfVector(element: WhiteboardElement): boolean {
    return (
      element.type === 'stroke' ||
      element.type === 'shape' ||
      element.type === 'text' ||
      element.type === 'geometry' ||
      element.type === 'matrix' ||
      element.type === 'table'
    );
  }

  private pdfVectorForElement(element: WhiteboardElement, pageHeight: number): string {
    if (element.type === 'stroke') {
      return this.pdfStrokeElement(element, pageHeight);
    }
    if (element.type === 'shape') {
      return this.pdfShapeElement(element, pageHeight);
    }
    if (element.type === 'text') {
      return this.pdfTextElement(element, pageHeight);
    }
    if (element.type === 'geometry') {
      return this.pdfGeometryElement(element, pageHeight);
    }
    if (element.type === 'matrix') {
      return this.pdfMatrixElement(element, pageHeight);
    }
    if (element.type === 'table') {
      return this.pdfTableElement(element, pageHeight);
    }
    return '';
  }

  private pdfStrokeElement(element: WhiteboardStrokeElement, pageHeight: number): string {
    if (!element.points.length) {
      return '';
    }
    const style = this.strokePenStyle(element);
    const width = this.strokeRenderWidth(element);
    const opacity = this.strokeOpacity(element);
    const commands: string[] = ['q', '1 J 1 j', this.pdfStrokeDash(style, width), `${this.pdfNumber(width)} w`, this.pdfStrokeColor(element.color, opacity)];
    const fillPath = element.fillColor ? this.strokeFillPath(element) : null;
    if (element.fillColor && fillPath?.points.length) {
      commands.push(this.pdfFillColor(element.fillColor, opacity), this.pdfPolylinePath(fillPath.points, pageHeight, true), 'f*');
    }
    if (element.points.length === 1) {
      const point = element.points[0]!;
      commands.push(this.pdfFillColor(element.color, opacity), this.pdfCirclePath(point.x, point.y, Math.max(1, width / 2), pageHeight), 'f');
    } else {
      commands.push(this.pdfPolylinePath(element.points, pageHeight, false), 'S');
    }
    commands.push('Q');
    return commands.join('\n');
  }

  private pdfStrokeDash(style: WhiteboardPenStyle, width: number): string {
    if (style === 'dashed') {
      return `[${this.pdfNumber(Math.max(8, width * 3))} ${this.pdfNumber(Math.max(5, width * 1.8))}] 0 d`;
    }
    if (style === 'dotted') {
      return `[0.1 ${this.pdfNumber(Math.max(6, width * 2.2))}] 0 d`;
    }
    return '[] 0 d';
  }

  private pdfShapeElement(element: WhiteboardShapeElement, pageHeight: number): string {
    if (element.shape === 'line') {
      return [
        'q',
        '1 J 1 j',
        `${this.pdfNumber(element.width)} w`,
        this.pdfStrokeColor(element.strokeColor),
        this.pdfPolylinePath([element.from, element.to], pageHeight, false),
        'S',
        'Q'
      ].join('\n');
    }
    if (element.shape === 'arrow') {
      return [
        'q',
        '1 J 1 j',
        `${this.pdfNumber(element.width)} w`,
        this.pdfStrokeColor(element.strokeColor),
        this.pdfPolylinePath([element.from, element.to], pageHeight, false),
        'S',
        this.pdfFillColor(element.strokeColor),
        this.pdfArrowHeadPath(element.from, element.to, pageHeight),
        'f',
        'Q'
      ].join('\n');
    }
    const commands = ['q', '1 J 1 j', `${this.pdfNumber(element.width)} w`, this.pdfStrokeColor(element.strokeColor)];
    if (element.fillColor) {
      commands.push(this.pdfFillColor(element.fillColor));
    }
    commands.push(this.pdfShapePath(element, pageHeight));
    commands.push(element.fillColor ? 'B' : 'S', 'Q');
    return commands.join('\n');
  }

  private pdfTextElement(element: WhiteboardTextElement, pageHeight: number): string {
    const bounds = this.boundsForElement(element);
    const commands: string[] = ['q'];
    if (element.fillColor) {
      commands.push(this.pdfFillColor(element.fillColor), this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height, pageHeight), 'f');
    }
    const lineHeight = element.fontSize * 1.25;
    for (const [index, line] of element.text.split('\n').entries()) {
      const lineWidth = this.pdfMeasureText(line, element.fontSize);
      const x = this.alignedInlineX(lineWidth, bounds.x, bounds.width, element.align ?? 'left');
      commands.push(this.pdfText(line, x, element.position.y + index * lineHeight, element.fontSize, element.color, pageHeight));
    }
    commands.push('Q');
    return commands.join('\n');
  }

  private pdfGeometryElement(element: WhiteboardGeometryElement, pageHeight: number): string {
    const commands = ['q', '1 J 1 j', `${this.pdfNumber(Math.max(1, element.width))} w`, this.pdfStrokeColor(element.strokeColor), this.pdfFillColor(element.fillColor ?? element.strokeColor)];
    if (element.kind === 'circle') {
      commands.push(this.pdfCirclePath(element.from.x, element.from.y, this.distance(element.from, element.to), pageHeight), element.fillColor ? 'B' : 'S');
    } else if (element.kind === 'arc' || element.kind === 'angle') {
      const radius = this.distance(element.from, element.to);
      commands.push(this.pdfCirclePath(element.from.x, element.from.y, radius, pageHeight), 'S');
    } else if (element.kind === 'point' || element.kind === 'midpoint') {
      commands.push(this.pdfCirclePath(element.from.x, element.from.y, Math.max(3, element.width * 1.6), pageHeight), 'f');
    } else if (element.kind === 'polygon') {
      commands.push(this.pdfPolylinePath(this.regularPolygonVertices(element.from, element.to, 6), pageHeight, true), element.fillColor ? 'B' : 'S');
    } else {
      commands.push(this.pdfPolylinePath([element.from, element.to], pageHeight, false), 'S');
      if (element.kind === 'vector') {
        commands.push(this.pdfArrowHeadPath(element.from, element.to, pageHeight), 'f');
      }
    }
    commands.push('Q');
    return commands.join('\n');
  }

  private pdfMatrixElement(element: WhiteboardMatrixElement, pageHeight: number): string {
    const bounds = this.boundsForElement(element);
    const bracketPadding = element.bracketStyle === 'none' ? 8 : 28;
    const gridBounds: ElementBounds = {
      x: bounds.x + bracketPadding,
      y: bounds.y + 10,
      width: Math.max(24, bounds.width - bracketPadding * 2),
      height: Math.max(24, bounds.height - 20)
    };
    const commands: string[] = ['q'];
    if (element.fillColor) {
      commands.push(this.pdfFillColor(element.fillColor), this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height, pageHeight), 'f');
    }
    if (element.showBorders) {
      commands.push(this.pdfGridLines(gridBounds, element.rows, element.columns, element.borderColor, 1, pageHeight));
    }
    if (element.augmentedColumn && element.augmentedColumn > 0 && element.augmentedColumn < element.columns) {
      const x = gridBounds.x + (gridBounds.width / element.columns) * element.augmentedColumn;
      commands.push(this.pdfStrokeColor(element.borderColor), `${this.pdfNumber(Math.max(1.4, element.fontSize / 16))} w`, this.pdfPolylinePath([{ x, y: gridBounds.y }, { x, y: gridBounds.y + gridBounds.height }], pageHeight, false), 'S');
    }
    commands.push(this.pdfMatrixBrackets(bounds, element, pageHeight), this.pdfCellText(element, gridBounds, false, pageHeight), 'Q');
    return commands.filter(Boolean).join('\n');
  }

  private pdfTableElement(element: WhiteboardTableElement, pageHeight: number): string {
    const bounds = this.boundsForElement(element);
    const commands: string[] = ['q', this.pdfFillColor(element.fillColor ?? '#ffffff'), this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height, pageHeight), 'f'];
    if (element.headerRow && element.rows > 0) {
      commands.push(this.pdfFillColor(element.fillColor ?? '#FFD150', 0.18), this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height / element.rows, pageHeight), 'f');
    }
    if (element.showBorders) {
      commands.push(this.pdfGridLines(bounds, element.rows, element.columns, element.borderColor, 1, pageHeight));
    } else {
      commands.push(this.pdfStrokeColor(element.strokeColor), '1.4 w', this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height, pageHeight), 'S');
    }
    commands.push(this.pdfCellText(element, bounds, element.headerRow, pageHeight), 'Q');
    return commands.join('\n');
  }

  private pdfCellText(element: WhiteboardMatrixElement | WhiteboardTableElement, bounds: ElementBounds, emphasizeHeader: boolean, pageHeight: number): string {
    const commands: string[] = [];
    const rows = Math.max(1, element.rows);
    const columns = Math.max(1, element.columns);
    const cellWidth = bounds.width / columns;
    const cellHeight = bounds.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const text = element.cells[row]?.[column] ?? '';
        if (!text.trim()) {
          continue;
        }
        const fontSize = Math.min(element.fontSize, Math.max(10, cellHeight * 0.42));
        const textWidth = this.pdfMeasureText(text, fontSize);
        let x = bounds.x + column * cellWidth + 7;
        if ((element.align ?? 'center') === 'center') {
          x = bounds.x + column * cellWidth + cellWidth / 2 - Math.min(textWidth, cellWidth - 14) / 2;
        } else if (element.align === 'right') {
          x = bounds.x + (column + 1) * cellWidth - Math.min(textWidth, cellWidth - 14) - 7;
        }
        const y = bounds.y + row * cellHeight + (cellHeight - fontSize) / 2;
        commands.push(this.pdfText(text, x, y, fontSize, element.textColor, pageHeight, emphasizeHeader && row === 0));
      }
    }
    return commands.join('\n');
  }

  private pdfShapePath(element: WhiteboardShapeElement, pageHeight: number): string {
    if (element.shape === 'line') {
      return this.pdfPolylinePath([element.from, element.to], pageHeight, false);
    }
    if (element.shape === 'rectangle') {
      const bounds = this.boundsForElement(element);
      return this.pdfRectPath(bounds.x, bounds.y, bounds.width, bounds.height, pageHeight);
    }
    if (element.shape === 'ellipse') {
      const bounds = this.boundsForElement(element);
      return this.pdfEllipsePath(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds.width / 2, bounds.height / 2, pageHeight);
    }
    return this.pdfPolylinePath(this.starVertices(element.from, element.to), pageHeight, true);
  }

  private starVertices(from: WhiteboardPoint, to: WhiteboardPoint): WhiteboardPoint[] {
    const centerX = from.x + (to.x - from.x) / 2;
    const centerY = from.y + (to.y - from.y) / 2;
    const outerRadius = Math.max(2, Math.min(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2);
    const innerRadius = outerRadius * 0.45;
    return Array.from({ length: 10 }, (_value, index) => {
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      const angle = -Math.PI / 2 + (index * Math.PI) / 5;
      return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
    });
  }

  private pdfGridLines(bounds: ElementBounds, rows: number, columns: number, color: string, width: number, pageHeight: number): string {
    const commands = ['q', this.pdfStrokeColor(color), `${this.pdfNumber(width)} w`];
    for (let column = 0; column <= columns; column += 1) {
      const x = bounds.x + (bounds.width / columns) * column;
      commands.push(this.pdfPolylinePath([{ x, y: bounds.y }, { x, y: bounds.y + bounds.height }], pageHeight, false), 'S');
    }
    for (let row = 0; row <= rows; row += 1) {
      const y = bounds.y + (bounds.height / rows) * row;
      commands.push(this.pdfPolylinePath([{ x: bounds.x, y }, { x: bounds.x + bounds.width, y }], pageHeight, false), 'S');
    }
    commands.push('Q');
    return commands.join('\n');
  }

  private pdfMatrixBrackets(bounds: ElementBounds, element: WhiteboardMatrixElement, pageHeight: number): string {
    if (element.bracketStyle === 'none') {
      return '';
    }
    const top = bounds.y + 8;
    const bottom = bounds.y + bounds.height - 8;
    const left = bounds.x + 14;
    const right = bounds.x + bounds.width - 14;
    if (element.bracketStyle === 'determinant') {
      return [
        this.pdfStrokeColor(element.strokeColor),
        `${this.pdfNumber(Math.max(1.6, element.fontSize / 14))} w`,
        this.pdfPolylinePath([{ x: left, y: top }, { x: left, y: bottom }], pageHeight, false),
        'S',
        this.pdfPolylinePath([{ x: right, y: top }, { x: right, y: bottom }], pageHeight, false),
        'S'
      ].join('\n');
    }
    const hook = element.bracketStyle === 'parentheses' ? 4 : 12;
    const leftPath = [
      { x: left + hook, y: top },
      { x: left, y: top },
      { x: left, y: bottom },
      { x: left + hook, y: bottom }
    ];
    const rightPath = [
      { x: right - hook, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: right - hook, y: bottom }
    ];
    return [
      this.pdfStrokeColor(element.strokeColor),
      `${this.pdfNumber(Math.max(1.6, element.fontSize / 14))} w`,
      this.pdfPolylinePath(leftPath, pageHeight, false),
      'S',
      this.pdfPolylinePath(rightPath, pageHeight, false),
      'S'
    ].join('\n');
  }

  private pdfPolylinePath(points: WhiteboardPoint[], pageHeight: number, close: boolean): string {
    if (!points.length) {
      return '';
    }
    const [first, ...rest] = points;
    const commands = [`${this.pdfNumber(first!.x)} ${this.pdfNumber(this.pdfY(first!.y, pageHeight))} m`];
    for (const point of rest) {
      commands.push(`${this.pdfNumber(point.x)} ${this.pdfNumber(this.pdfY(point.y, pageHeight))} l`);
    }
    if (close) {
      commands.push('h');
    }
    return commands.join('\n');
  }

  private pdfRectPath(x: number, y: number, width: number, height: number, pageHeight: number): string {
    return `${this.pdfNumber(x)} ${this.pdfNumber(this.pdfY(y + height, pageHeight))} ${this.pdfNumber(width)} ${this.pdfNumber(height)} re`;
  }

  private pdfCirclePath(x: number, y: number, radius: number, pageHeight: number): string {
    return this.pdfEllipsePath(x, y, radius, radius, pageHeight);
  }

  private pdfEllipsePath(cx: number, cy: number, rx: number, ry: number, pageHeight: number): string {
    const kappa = 0.5522847498;
    const left = cx - rx;
    const right = cx + rx;
    const top = cy - ry;
    const bottom = cy + ry;
    return [
      `${this.pdfNumber(cx)} ${this.pdfNumber(this.pdfY(top, pageHeight))} m`,
      `${this.pdfNumber(cx + rx * kappa)} ${this.pdfNumber(this.pdfY(top, pageHeight))} ${this.pdfNumber(right)} ${this.pdfNumber(this.pdfY(cy - ry * kappa, pageHeight))} ${this.pdfNumber(right)} ${this.pdfNumber(this.pdfY(cy, pageHeight))} c`,
      `${this.pdfNumber(right)} ${this.pdfNumber(this.pdfY(cy + ry * kappa, pageHeight))} ${this.pdfNumber(cx + rx * kappa)} ${this.pdfNumber(this.pdfY(bottom, pageHeight))} ${this.pdfNumber(cx)} ${this.pdfNumber(this.pdfY(bottom, pageHeight))} c`,
      `${this.pdfNumber(cx - rx * kappa)} ${this.pdfNumber(this.pdfY(bottom, pageHeight))} ${this.pdfNumber(left)} ${this.pdfNumber(this.pdfY(cy + ry * kappa, pageHeight))} ${this.pdfNumber(left)} ${this.pdfNumber(this.pdfY(cy, pageHeight))} c`,
      `${this.pdfNumber(left)} ${this.pdfNumber(this.pdfY(cy - ry * kappa, pageHeight))} ${this.pdfNumber(cx - rx * kappa)} ${this.pdfNumber(this.pdfY(top, pageHeight))} ${this.pdfNumber(cx)} ${this.pdfNumber(this.pdfY(top, pageHeight))} c`,
      'h'
    ].join('\n');
  }

  private pdfArrowHeadPath(from: WhiteboardPoint, to: WhiteboardPoint, pageHeight: number): string {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLength = 16;
    return this.pdfPolylinePath(
      [
        to,
        { x: to.x - headLength * Math.cos(angle - Math.PI / 6), y: to.y - headLength * Math.sin(angle - Math.PI / 6) },
        { x: to.x - headLength * Math.cos(angle + Math.PI / 6), y: to.y - headLength * Math.sin(angle + Math.PI / 6) }
      ],
      pageHeight,
      true
    );
  }

  private pdfText(text: string, x: number, y: number, fontSize: number, color: string, pageHeight: number, bold = false): string {
    return [
      'BT',
      this.pdfFillColor(color),
      `/F1 ${this.pdfNumber(fontSize)} Tf`,
      `${bold ? '0.25' : '0'} Tc`,
      `1 0 0 1 ${this.pdfNumber(x)} ${this.pdfNumber(this.pdfY(y + fontSize, pageHeight))} Tm`,
      `${this.pdfTextLiteral(text)} Tj`,
      'ET'
    ].join('\n');
  }

  private pdfMeasureText(text: string, fontSize: number): number {
    const context = this.context;
    if (!context) {
      return text.length * fontSize * 0.55;
    }
    context.save();
    context.font = `${fontSize}px Helvetica, Arial, sans-serif`;
    const width = context.measureText(text).width;
    context.restore();
    return width;
  }

  private pdfStrokeColor(color: string, alpha = 1): string {
    const [r, g, b] = this.pdfColor(color, alpha);
    return `${r} ${g} ${b} RG`;
  }

  private pdfFillColor(color: string, alpha = 1): string {
    const [r, g, b] = this.pdfColor(color, alpha);
    return `${r} ${g} ${b} rg`;
  }

  private pdfColor(color: string, alpha = 1): [string, string, string] {
    const normalized = color.trim();
    const hex = normalized.startsWith('#') ? normalized.slice(1) : '';
    let r = 0;
    let g = 0;
    let b = 0;
    if (hex.length === 3) {
      r = Number.parseInt(hex[0]! + hex[0]!, 16);
      g = Number.parseInt(hex[1]! + hex[1]!, 16);
      b = Number.parseInt(hex[2]! + hex[2]!, 16);
    } else if (hex.length >= 6) {
      r = Number.parseInt(hex.slice(0, 2), 16);
      g = Number.parseInt(hex.slice(2, 4), 16);
      b = Number.parseInt(hex.slice(4, 6), 16);
    } else {
      const match = normalized.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (match) {
        r = Number(match[1]);
        g = Number(match[2]);
        b = Number(match[3]);
      }
    }
    const mix = (value: number): string => this.pdfNumber((255 - (255 - value) * alpha) / 255);
    return [mix(r), mix(g), mix(b)];
  }

  private pdfTextLiteral(text: string): string {
    const safeText = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    return `(${safeText})`;
  }

  private pdfY(y: number, pageHeight: number): number {
    return pageHeight - y;
  }

  private pdfNumber(value: number): string {
    return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : '0';
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
    writeObject(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);
    const pageIds = pages.map((_, index) => 4 + index * 3);
    writeObject(2, [`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
    pages.forEach((page, index) => {
      const pageObjectId = 4 + index * 3;
      const imageObjectId = pageObjectId + 1;
      const contentObjectId = pageObjectId + 2;
      const imageName = `Im${index}`;
      const imageBytes = this.base64ToBytes(page.jpegDataUrl.split(',')[1] ?? '');
      const content = [`q ${page.width} 0 0 ${page.height} 0 0 cm /${imageName} Do Q`, page.vectorContent ?? ''].filter(Boolean).join('\n');
      writeObject(pageObjectId, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /${imageName} ${imageObjectId} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`
      ]);
      writeObject(imageObjectId, [
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
        imageBytes,
        '\nendstream'
      ]);
      writeObject(contentObjectId, [`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`]);
    });

    const xrefOffset = byteOffset;
    const objectCount = 3 + pages.length * 3;
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
