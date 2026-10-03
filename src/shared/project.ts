export type MaterialPurpose = 'primary' | 'content' | 'reference' | 'asset' | 'auto';
export type SelectedMaterial = { id: string; sourcePath: string; name: string; size: number };
export type Material = SelectedMaterial & { purpose: MaterialPurpose; note: string };
export type ProjectInput = { id?: string; name: string; brief: string; materials: Material[] };
export type MaterialAnalysis = { status: 'analyzed' | 'skipped' | 'error'; message?: string; summary?: string };
export type StoredMaterial = Material & { localPath: string; analysis?: MaterialAnalysis };
export type ProjectRecord = Omit<ProjectInput, 'materials' | 'id'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  materials: StoredMaterial[];
};
export type ProjectSummary = Pick<ProjectRecord, 'id' | 'name' | 'updatedAt'> & { materialCount: number };
export type RuntimeStatus = { officecli: { available: boolean; version?: string }; agent: 'Pi SDK' };
export interface DesktopAPI {
  selectMaterials(): Promise<SelectedMaterial[]>;
  importDroppedFiles(files: File[]): Promise<SelectedMaterial[]>;
  saveProject(input: ProjectInput): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectSummary[]>;
  openProject(id: string): Promise<ProjectRecord>;
  analyzeProject(id: string): Promise<ProjectRecord>;
  revealProject(id: string): Promise<void>;
  runtimeStatus(): Promise<RuntimeStatus>;
}
