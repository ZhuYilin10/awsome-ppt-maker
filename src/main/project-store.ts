import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ProjectInput, ProjectRecord, ProjectSummary, SelectedMaterial, StoredMaterial } from '../shared/project';

const allowedExtensions = new Set(['.pptx', '.pdf', '.docx', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.svg']);
const purposes = new Set(['primary', 'content', 'reference', 'asset', 'auto']);

export function validateProject(input: ProjectInput) {
  if (!input || typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 120) throw new Error('项目名称须为 2—120 个字符。');
  if (typeof input.brief !== 'string' || input.brief.length > 10_000) throw new Error('项目要求不能超过 10000 字。');
  if (!Array.isArray(input.materials) || !input.materials.length || input.materials.length > 100) throw new Error('请导入 1—100 份材料。');
  const ids = new Set<string>();
  for (const material of input.materials) {
    if (!material || typeof material.id !== 'string' || typeof material.name !== 'string' || typeof material.sourcePath !== 'string' || ids.has(material.id) || !purposes.has(material.purpose)) throw new Error('材料用途或标识无效。');
    ids.add(material.id);
    if (typeof material.note !== 'string' || material.note.length > 5000) throw new Error('每份材料的说明不能超过 5000 字。');
  }
  const primary = input.materials.filter((material) => material.purpose === 'primary');
  if (primary.length !== 1) throw new Error('请选择一份待美化主稿。');
  if (extname(primary[0].name).toLowerCase() !== '.pptx') throw new Error('待美化主稿必须为 PPTX。旧版 PPT 请先另存为 PPTX。');
}

export class ProjectStore {
  private readonly db: DatabaseSync;
  private readonly selected = new Map<string, SelectedMaterial>();

  constructor(private readonly projectsRoot: string, databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL);');
  }

  async select(paths: string[]): Promise<SelectedMaterial[]> {
    if (!Array.isArray(paths) || paths.length > 100 || paths.some((path) => typeof path !== 'string')) throw new Error('无效的文件选择。');
    const files = await Promise.all(paths.map(async (path) => {
      const sourcePath = await realpath(path);
      if (!allowedExtensions.has(extname(sourcePath).toLowerCase())) throw new Error(`暂不支持 ${basename(path)}，请使用 PPTX、DOCX、XLSX、PDF 或图片。`);
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size === 0) throw new Error(`${basename(path)} 不是可读取的非空文件。`);
      const existing = [...this.selected.values()].find((file) => file.sourcePath === sourcePath);
      return existing ?? { id: randomUUID(), sourcePath, name: basename(sourcePath), size: info.size };
    }));
    for (const file of files) this.selected.set(file.id, file);
    return files;
  }

  list(): ProjectSummary[] {
    const rows = this.db.prepare('SELECT record FROM projects ORDER BY updated_at DESC').all();
    return rows.map((row) => {
      const record: ProjectRecord = JSON.parse(row.record as string);
      return { id: record.id, name: record.name, updatedAt: record.updatedAt, materialCount: record.materials.length };
    });
  }

  get(id: string): ProjectRecord {
    if (typeof id !== 'string') throw new Error('无效的项目。');
    const row = this.db.prepare('SELECT record FROM projects WHERE id = ?').get(id);
    if (!row) throw new Error('项目不存在，请从最近项目中重新打开。');
    const record: ProjectRecord = JSON.parse(row.record as string);
    if (!record.analysis && record.analysisRef && /^[a-f0-9-]{36}$/i.test(record.analysisRef.runId)) {
      try { record.analysis = JSON.parse(readFileSync(join(record.projectPath, 'analysis', 'runs', record.analysisRef.runId, 'result.json'), 'utf8')); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    }
    return record;
  }

  async save(input: ProjectInput): Promise<ProjectRecord> {
    validateProject(input);
    const previous = input.id ? this.get(input.id) : undefined;
    const id = previous?.id ?? randomUUID();
    const projectPath = previous?.projectPath ?? join(this.projectsRoot, id);
    const staging = join(projectPath, `.import-${randomUUID()}`);
    const imported: string[] = [];
    await mkdir(staging, { recursive: true });
    await mkdir(join(projectPath, 'materials'), { recursive: true });
    try {
      const materials: StoredMaterial[] = [];
      for (const requested of input.materials) {
        const existing = previous?.materials.find((file) => file.id === requested.id);
        if (existing) {
          materials.push({ ...existing, purpose: requested.purpose, note: requested.note });
          continue;
        }
        const selected = this.selected.get(requested.id);
        if (!selected || selected.sourcePath !== requested.sourcePath) throw new Error('材料未通过文件选择器授权，请重新导入。');
        const localPath = join(projectPath, 'materials', `${randomUUID()}-${selected.name}`);
        const stagedPath = join(staging, selected.id);
        await copyFile(selected.sourcePath, stagedPath);
        await rename(stagedPath, localPath);
        imported.push(localPath);
        materials.push({ ...selected, purpose: requested.purpose, note: requested.note, localPath });
      }
      const now = new Date().toISOString();
      const record: ProjectRecord = { id, name: input.name.trim(), brief: input.brief, createdAt: previous?.createdAt ?? now, updatedAt: now, projectPath, materials };
      // Preserve valid previous results on an unchanged save (including retries).
      if (previous && previous.name === record.name && previous.brief === record.brief && JSON.stringify(previous.materials.map(({ id, purpose, note }) => ({ id, purpose, note }))) === JSON.stringify(materials.map(({ id, purpose, note }) => ({ id, purpose, note })))) {
        record.analysis = previous.analysis;
        record.representativeSelection = previous.representativeSelection;
        record.designDraft = previous.designDraft;
        record.prototypePreview = previous.prototypePreview;
      }
      // Validate again using trusted file names, not renderer-supplied metadata.
      validateProject(record);
      await this.persist(record);
      return record;
    } catch (cause) {
      // Only remove copies produced by this failed import, never user originals.
      for (const path of imported) await rm(path, { force: true });
      throw cause;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async persist(record: ProjectRecord) {
    const { analysis, ...stored } = record;
    if (analysis) {
      if (!/^[a-f0-9-]{36}$/i.test(analysis.runId)) throw new Error('分析运行 ID 无效。');
      const runRoot = join(record.projectPath, 'analysis', 'runs', analysis.runId);
      await mkdir(runRoot, { recursive: true });
      const resultTemp = join(runRoot, `result.${randomUUID()}.tmp`);
      await writeFile(resultTemp, JSON.stringify(analysis, null, 2), 'utf8');
      await rename(resultTemp, join(runRoot, 'result.json'));
      stored.analysisRef = { runId: analysis.runId, status: analysis.status, completedAt: analysis.completedAt };
    } else delete stored.analysisRef;
    const json = JSON.stringify(stored, null, 2);
    const temp = join(record.projectPath, 'project.json.tmp');
    await mkdir(record.projectPath, { recursive: true });
    await writeFile(temp, json, 'utf8');
    await rename(temp, join(record.projectPath, 'project.json'));
    this.db.prepare('INSERT INTO projects (id, name, updated_at, record) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at, record=excluded.record').run(record.id, record.name, record.updatedAt, json);
  }

  async saveRepresentativePages(id: string, pageNumbers: number[]) {
    const record = this.get(id);
    if (!record.analysis || record.analysis.status !== 'completed') throw new Error('请先完成材料分析。');
    const candidates = new Set(record.analysis.representativePages.map((page) => page.pageNumber));
    if (!Array.isArray(pageNumbers) || !pageNumbers.length || pageNumbers.length > 12 || new Set(pageNumbers).size !== pageNumbers.length || pageNumbers.some((page) => !Number.isInteger(page) || !candidates.has(page))) throw new Error('请选择有效的代表页候选。');
    record.representativeSelection = { runId: record.analysis.runId, pageNumbers, confirmedAt: new Date().toISOString() };
    record.updatedAt = record.representativeSelection.confirmedAt;
    await this.persist(record);
    return record;
  }

  close() { this.db.close(); }
}
