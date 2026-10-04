import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectInput } from '../shared/project';
import { ProjectStore } from './project-store';
import { analyzeOfficeFile, officeStatus } from './officecli';
import { AiSettingsStore } from './ai-settings-store';
import { PiRuntime } from './pi-runtime';

let store: ProjectStore;
let aiSettings: AiSettingsStore;
let piRuntime: PiRuntime;
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
    if (input?.id && busyProjects.has(input.id)) throw new Error('材料分析中，请稍后再保存。');
    if (input?.id) busyProjects.add(input.id);
    try { return await store.save(input); }
    finally { if (input?.id) busyProjects.delete(input.id); }
  });
  handle('project:list', () => store.list());
  handle('project:open', (id: string) => store.get(id));
  handle('project:reveal', (id: string) => { shell.showItemInFolder(join(store.get(id).projectPath, 'project.json')); });
  handle('project:analyze', async (id: string) => {
    if (busyProjects.has(id)) throw new Error('该项目正在分析，请等待本轮结束。');
    const record = store.get(id);
    busyProjects.add(id);
    try {
      for (const material of record.materials) material.analysis = await analyzeOfficeFile(material.localPath);
      record.updatedAt = new Date().toISOString();
      await store.persist(record);
      return record;
    } finally { busyProjects.delete(id); }
  });
  handle('ai:get-settings', () => piRuntime.getSettings());
  handle('ai:save-settings', (input) => piRuntime.save(input));
  handle('ai:fetch-models', (input) => piRuntime.fetchModels(input));
  handle('ai:test-connection', () => piRuntime.testConnection());
  handle('ai:clear-credential', () => piRuntime.clearCredential());
  handle('runtime:status', async () => ({ officecli: await officeStatus(), ai: piRuntime.status() }));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((cause) => {
  dialog.showErrorBox('无法启动项目工作区', cause instanceof Error ? cause.message : String(cause));
  app.quit();
});
app.on('will-quit', () => { void piRuntime?.dispose(); store?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
