import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectInput } from '../shared/project';
import { ProjectStore } from './project-store';
import { officeStatus } from './officecli';
import { AiSettingsStore } from './ai-settings-store';
import { PiRuntime } from './pi-runtime';
import { AnalysisRunner } from './analysis-runner';
import type { AnalysisEvent } from '../shared/analysis';
import type { DesignEvent } from '../shared/analysis';
import { DesignRunner } from './design-runner';

let store: ProjectStore;
let aiSettings: AiSettingsStore;
let piRuntime: PiRuntime;
let analysisRunner: AnalysisRunner;
let designRunner: DesignRunner;
const busyProjects = new Set<string>();
const devURL = process.env.VITE_DEV_SERVER_URL;
if (!app.isPackaged && process.env.PPT_PLAN_USER_DATA) app.setPath('userData', process.env.PPT_PLAN_USER_DATA);

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1000, minHeight: 700,
    backgroundColor: '#f5f6f8', title: 'PPT Plan Studio',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: '尚有修改未保存', message: '当前材料或说明尚未保存，要放弃修改吗？',
      buttons: ['继续编辑', '放弃修改'], defaultId: 0, cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
  if (devURL) void window.loadURL(devURL);
  else void window.loadFile(join(__dirname, '../../renderer/index.html'));
}

app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  await mkdir(dataPath, { recursive: true });
  store = new ProjectStore(join(dataPath, 'projects'), join(dataPath, 'projects.sqlite'));
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全保存 OpenAI API Key。');
  const codec = {
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  aiSettings = new AiSettingsStore(dataPath, codec);
  await aiSettings.load();
  piRuntime = new PiRuntime(dataPath, aiSettings);
  await piRuntime.initialize();
  analysisRunner = new AnalysisRunner(store, piRuntime);
  const emitAnalysis = (event: AnalysisEvent) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('project:analysis-event', event);
  };
  designRunner = new DesignRunner(store, piRuntime);
  const emitDesign = (event: DesignEvent) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('project:design-event', event);
  };
  const allowedURL = devURL ?? pathToFileURL(join(__dirname, '../../renderer/index.html')).href;
  function handle(channel: string, callback: (...args: any[]) => unknown) {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.senderFrame?.url !== allowedURL && event.senderFrame?.url !== `${allowedURL}/`) throw new Error('此页面无权访问本地项目。');
      return callback(...args);
    });
  }
  handle('materials:select', async () => {
    const selection = await dialog.showOpenDialog({
      title: '导入项目材料', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '项目材料', extensions: ['pptx', 'pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'svg'] }],
    });
    return selection.canceled ? [] : store.select(selection.filePaths);
  });
  handle('materials:drop', (paths: string[]) => store.select(paths));
  handle('project:save', async (input: ProjectInput) => {
    if (input?.id && (busyProjects.has(input.id) || analysisRunner.isBusy(input.id) || designRunner.isBusy(input.id))) throw new Error('Agent 任务运行中，请稍后再保存。');
    if (input?.id) busyProjects.add(input.id);
    try { return await store.save(input); }
    finally { if (input?.id) busyProjects.delete(input.id); }
  });
  handle('project:list', () => store.list());
  handle('project:open', (id: string) => store.get(id));
  handle('project:reveal', (id: string) => { shell.showItemInFolder(join(store.get(id).projectPath, 'project.json')); });
  handle('project:analyze', async (id: string) => {
    if (busyProjects.has(id) || designRunner.hasActiveRuns()) throw new Error('当前有 Agent 任务正在运行，请等待本轮结束。');
    return analysisRunner.run(id, emitAnalysis);
  });
  handle('project:analysis-start', (id: string) => {
    if (busyProjects.has(id) || designRunner.hasActiveRuns()) throw new Error('当前有 Agent 任务正在运行，请等待本轮结束。');
    return analysisRunner.start(id, emitAnalysis);
  });
  handle('project:analysis-cancel', (id: string) => analysisRunner.cancel(id));
  handle('project:analysis-run', (id: string) => analysisRunner.getRun(id));
  handle('project:analysis-result', (id: string) => analysisRunner.getResult(id));
  handle('project:representative-save', async (id: string, pages: number[]) => {
    if (busyProjects.has(id) || analysisRunner.isBusy(id) || designRunner.isBusy(id)) throw new Error('Agent 任务运行中，请稍后再确认。');
    busyProjects.add(id);
    try { return await store.saveRepresentativePages(id, pages); }
    finally { busyProjects.delete(id); }
  });
  handle('project:representative-preview', async (id: string, pageNumber: number) => {
    const record = store.get(id);
    const candidate = record.analysis?.representativePages.find((page) => page.pageNumber === pageNumber);
    if (!candidate || !/^[a-f0-9-]{36}$/i.test(record.analysis!.runId) || !/^[a-f0-9-]{36}$/i.test(candidate.materialId)) return undefined;
    try {
      const bytes = await readFile(join(record.projectPath, 'analysis', 'runs', record.analysis!.runId, 'previews', `${candidate.materialId}-${pageNumber}.png`));
      if (bytes.byteLength > 4 * 1024 * 1024) return undefined;
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch { return undefined; }
  });
  handle('project:design-start', (id: string) => {
    if (analysisRunner.hasActiveRuns() || designRunner.hasActiveRuns() || busyProjects.has(id)) throw new Error('请等待当前任务完成后再生成设计方案。');
    return designRunner.start(id, emitDesign);
  });
  handle('project:design-cancel', (id: string) => designRunner.cancel(id));
  handle('project:design-run', (id: string) => designRunner.getRun(id));
  handle('project:design-draft', (id: string) => designRunner.getDraft(id));
  handle('project:prototype-preview', async (id: string, pageNumber: number) => {
    const record = store.get(id);
    const item = record.prototypePreview?.pages.find((page) => page.sourcePageNumber === pageNumber);
    if (!item || item.status !== 'generated') return undefined;
    if (record.prototypePreview?.sourceProjectId !== id || !/^[-a-f0-9]{36}$/i.test(record.prototypePreview.draftRunId) || !Number.isInteger(pageNumber) || pageNumber < 1) return undefined;
    const expected = resolve(record.projectPath, 'design', 'runs', record.prototypePreview.draftRunId, 'previews', `page-${pageNumber}.png`);
    if (resolve(item.previewPath) !== expected) return undefined;
    try { const bytes = await readFile(expected); if (bytes.byteLength > 4 * 1024 * 1024) return undefined; return `data:image/png;base64,${bytes.toString('base64')}`; } catch { return undefined; }
  });
  handle('ai:get-settings', () => piRuntime.getSettings());
  handle('ai:save-settings', (input) => {
    if (analysisRunner.hasActiveRuns() || designRunner.hasActiveRuns()) throw new Error('Agent 任务运行中，请结束任务后修改设置。');
    return piRuntime.save(input);
  });
  handle('ai:fetch-models', (input) => piRuntime.fetchModels(input));
  handle('ai:test-connection', () => piRuntime.testConnection());
  handle('ai:clear-credential', () => {
    if (analysisRunner.hasActiveRuns() || designRunner.hasActiveRuns()) throw new Error('Agent 任务运行中，请结束任务后清除凭据。');
    return piRuntime.clearCredential();
  });
  handle('runtime:status', async () => ({ officecli: await officeStatus(), ai: piRuntime.status() }));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((cause) => {
  dialog.showErrorBox('无法启动项目工作区', cause instanceof Error ? cause.message : String(cause));
  app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || (!analysisRunner?.hasActiveRuns() && !designRunner?.hasActiveRuns())) return;
  event.preventDefault();
  void Promise.all([analysisRunner.dispose(), designRunner.dispose()]).finally(() => { quitting = true; app.quit(); });
});
app.on('will-quit', () => { void piRuntime?.dispose(); store?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
