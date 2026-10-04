export type AnalysisRunStatus = 'queued' | 'preflight' | 'extracting' | 'rendering' | 'agent-reading' | 'agent-synthesis' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
export type AnalysisStage = Exclude<AnalysisRunStatus, 'queued' | 'completed' | 'failed' | 'cancelled'>;

export type EvidenceRef = {
  materialId: string;
  pageNumber?: number;
  location?: string;
  note: string;
};

export type RepresentativePageCandidate = {
  materialId: string;
  pageNumber: number;
  title?: string;
  contentRole: 'cover' | 'overview' | 'process' | 'comparison' | 'data' | 'case' | 'summary' | 'closing' | 'other';
  visualRole: 'template' | 'text' | 'table' | 'diagram' | 'image' | 'mixed' | 'other';
  reason: string;
  evidence: EvidenceRef[];
  confidence: 'low' | 'medium' | 'high';
};

export type MaterialRole = 'primary-deck' | 'template' | 'content' | 'reference' | 'asset' | 'unknown';

export type MaterialAnalysisResult = {
  materialId: string;
  role: MaterialRole;
  roleReason: string;
  contentSummary: string;
  visualSummary: string;
  constraints: string[];
  issues: string[];
  evidence: EvidenceRef[];
};

export type ProjectAnalysis = {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary: string;
  materials: MaterialAnalysisResult[];
  representativePages: RepresentativePageCandidate[];
  evidence: EvidenceRef[];
  error?: string;
};

export type AnalysisRunSnapshot = {
  runId: string;
  projectId: string;
  status: AnalysisRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  currentMaterialId?: string;
  currentMaterialName?: string;
  currentTool?: string;
  agentRequestNumber?: number;
  agentRequestStartedAt?: string;
  abortReason?: 'user' | 'app-dispose' | 'timeout' | 'tool-limit' | 'unknown';
  completedMaterials: number;
  totalMaterials: number;
  materialStates?: Record<string, { status: 'read' | 'error'; message?: string }>;
  message?: string;
  error?: string;
};

export type AnalysisEvent = {
  type: 'run-started' | 'stage-changed' | 'material-started' | 'material-finished' | 'tool-started' | 'tool-finished' | 'message' | 'run-completed' | 'run-failed' | 'run-cancelled';
  snapshot: AnalysisRunSnapshot;
  materialId?: string;
  tool?: string;
  message?: string;
};

export type DesignLayout = 'cover' | 'overview' | 'process' | 'comparison' | 'data' | 'case' | 'summary' | 'closing' | 'other';
// Geometry is in cm on a widescreen 33.867 × 19.05 cm canvas. Pi owns every
// visible element, including the title; the executor must not invent a layout.
export type PrototypeBlock = {
  type: 'heading' | 'body' | 'stat' | 'step' | 'callout' | 'caption' | 'shape';
  text: string;
  x: number; y: number; width: number; height: number;
  font: string; fontSize: number; color: string; fill: string; line: string;
  bold: boolean; align: 'left' | 'center' | 'right'; valign: 'top' | 'center' | 'bottom';
  geometry?: 'rect' | 'roundRect' | 'ellipse' | 'rightArrow' | 'diamond';
};
export type PrototypePageSpec = {
  sourcePageNumber: number;
  title: string;
  purpose: string;
  contentRole: DesignLayout;
  targetLayout: string;
  visualDirection: string;
  contentHierarchy: string[];
  sourceContent: string[];
  preservedElements: string[];
  proposedChanges: string[];
  evidenceRefs: string[];
  confidence: 'low' | 'medium' | 'high';
  prototype: { background: string; accentColor: string; blocks: PrototypeBlock[] };
};
export type DesignDraft = {
  runId: string;
  analysisRunId: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  designDirection: { thesis: string; narrativeStrategy: string; visualSystem: string; nonNegotiables: string[]; evidenceRefs: string[] };
  selectedPages: PrototypePageSpec[];
  openQuestions: string[];
  limitations: string[];
  error?: string;
};
export type PrototypePreview = {
  prototypeId: string;
  draftRunId: string;
  sourceProjectId: string;
  outputPath: string;
  sourceHashes: Record<string, string>;
  pages: Array<{ sourcePageNumber: number; previewPath: string; status: 'generated' | 'render-failed' }>;
  createdAt: string;
};
export type DesignRunSnapshot = {
  runId: string;
  projectId: string;
  status: 'queued' | 'agent-reading' | 'generating' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  agentRequestNumber?: number;
  currentTool?: string;
  message?: string;
  error?: string;
};
export type DesignEvent = { type: 'run-started' | 'stage-changed' | 'tool-started' | 'tool-finished' | 'message' | 'run-completed' | 'run-failed' | 'run-cancelled'; snapshot: DesignRunSnapshot; tool?: string; message?: string };
