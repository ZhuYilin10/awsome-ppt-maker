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
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
};
contextBridge.exposeInMainWorld('pptPlan', api);
