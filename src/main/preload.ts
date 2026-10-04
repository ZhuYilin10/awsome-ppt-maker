import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI } from '../shared/project';
import type { AnalysisEvent } from '../shared/analysis';

const api: DesktopAPI = {
  selectMaterials: () => ipcRenderer.invoke('materials:select'),
  importDroppedFiles: (files) => ipcRenderer.invoke('materials:drop', files.map((file) => webUtils.getPathForFile(file))),
  saveProject: (input) => ipcRenderer.invoke('project:save', input),
  listProjects: () => ipcRenderer.invoke('project:list'),
  openProject: (id) => ipcRenderer.invoke('project:open', id),
  analyzeProject: (id) => ipcRenderer.invoke('project:analyze', id),
  revealProject: (id) => ipcRenderer.invoke('project:reveal', id),
  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  saveAiSettings: (input) => ipcRenderer.invoke('ai:save-settings', input),
  fetchAiModels: (input) => ipcRenderer.invoke('ai:fetch-models', input),
  testAiConnection: () => ipcRenderer.invoke('ai:test-connection'),
  clearAiCredential: () => ipcRenderer.invoke('ai:clear-credential'),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startProjectAnalysis: (id) => ipcRenderer.invoke('project:analysis-start', id),
  cancelProjectAnalysis: (id) => ipcRenderer.invoke('project:analysis-cancel', id),
  getAnalysisRun: (id) => ipcRenderer.invoke('project:analysis-run', id),
  getProjectAnalysis: (id) => ipcRenderer.invoke('project:analysis-result', id),
  saveRepresentativePages: (id, pageNumbers) => ipcRenderer.invoke('project:representative-save', id, pageNumbers),
  getRepresentativePreview: (id, pageNumber) => ipcRenderer.invoke('project:representative-preview', id, pageNumber),
  onAnalysisEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AnalysisEvent) => listener(payload);
    ipcRenderer.on('project:analysis-event', handler);
    return () => ipcRenderer.removeListener('project:analysis-event', handler);
  },
};
contextBridge.exposeInMainWorld('pptPlan', api);
