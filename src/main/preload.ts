import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI } from '../shared/project';

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
};
contextBridge.exposeInMainWorld('pptPlan', api);
