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
