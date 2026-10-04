import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ProjectRecord } from '../shared/project';
import { authorizedMaterial } from './material-reader';
import { runOfficeCli } from './officecli';

const roles = ['cover', 'overview', 'process', 'comparison', 'data', 'case', 'summary', 'closing', 'other'] as const;
const blockColors = Type.String({ pattern: '^(none|#[0-9A-Fa-f]{6})$' });
const blockSchema = Type.Object({
  type: Type.Union(['heading', 'body', 'stat', 'step', 'callout', 'caption', 'shape'].map((value) => Type.Literal(value))),
  text: Type.String({ maxLength: 600 }),
  x: Type.Number({ minimum: 0, maximum: 33.867 }), y: Type.Number({ minimum: 0, maximum: 19.05 }),
  width: Type.Number({ exclusiveMinimum: 0, maximum: 33.867 }), height: Type.Number({ exclusiveMinimum: 0, maximum: 19.05 }),
  font: Type.String({ minLength: 1, maxLength: 120 }), fontSize: Type.Number({ minimum: 8, maximum: 120 }),
  color: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }), fill: blockColors, line: blockColors, bold: Type.Boolean(),
  align: Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]),
  valign: Type.Union([Type.Literal('top'), Type.Literal('center'), Type.Literal('bottom')]),
  geometry: Type.Optional(Type.Union(['rect', 'roundRect', 'ellipse', 'rightArrow', 'diamond'].map((value) => Type.Literal(value)))),
});
const pageSchema = Type.Object({
  sourcePageNumber: Type.Integer({ minimum: 1 }), title: Type.String({ minLength: 1, maxLength: 200 }), purpose: Type.String({ minLength: 1, maxLength: 800 }),
  contentRole: Type.Union(roles.map((value) => Type.Literal(value))), targetLayout: Type.String({ minLength: 1, maxLength: 500 }), visualDirection: Type.String({ minLength: 1, maxLength: 1200 }),
  contentHierarchy: Type.Array(Type.String({ maxLength: 300 }), { minItems: 1, maxItems: 8 }), sourceContent: Type.Array(Type.String({ maxLength: 800 }), { minItems: 1, maxItems: 12 }),
  preservedElements: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 }), proposedChanges: Type.Array(Type.String({ maxLength: 600 }), { maxItems: 12 }),
  evidenceRefs: Type.Array(Type.String({ pattern: '^E[1-9][0-9]*$' }), { minItems: 1, maxItems: 8 }), confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  prototype: Type.Object({ background: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }), accentColor: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }), blocks: Type.Array(blockSchema, { minItems: 1, maxItems: 24 }) }),
});
export const designDraftSchema = Type.Object({
  runId: Type.String(), analysisRunId: Type.String(),
  designDirection: Type.Object({ thesis: Type.String({ minLength: 1, maxLength: 1200 }), narrativeStrategy: Type.String({ minLength: 1, maxLength: 1600 }), visualSystem: Type.String({ minLength: 1, maxLength: 1600 }), nonNegotiables: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }), evidenceRefs: Type.Array(Type.String({ pattern: '^E[1-9][0-9]*$' }), { minItems: 1, maxItems: 12 }) }),
  selectedPages: Type.Array(pageSchema, { minItems: 1, maxItems: 5 }), openQuestions: Type.Array(Type.String({ maxLength: 800 }), { maxItems: 12 }), limitations: Type.Array(Type.String({ maxLength: 800 }), { maxItems: 12 }),
});
export type DesignDraftSubmission = Static<typeof designDraftSchema>;

function textResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: text.length > 100_000 ? `${text.slice(0, 100_000)}\n[结果已截断]` : text }], details: {} };
}

async function imageResult(path: string, info: unknown) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('页面预览超过 4 MB 限制。');
  return { content: [{ type: 'text' as const, text: JSON.stringify(info) }, { type: 'image' as const, mimeType: extname(path) === '.png' ? 'image/png' : 'image/jpeg', data: bytes.toString('base64') }], details: {} };
}

type DesignEvidence = { id: string; materialId: string; pageNumber?: number; location?: string; note: string; sourceText?: string };

async function readEvidence(runRoot: string, record: ProjectRecord) {
  const directory = join(runRoot, 'evidence');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const entries: DesignEvidence[] = [];
  for (const name of names) {
    const entry = JSON.parse(await readFile(join(directory, name), 'utf8')) as DesignEvidence;
    if (!entry || !record.materials.some((material) => material.id === entry.materialId) || typeof entry.note !== 'string') throw new Error('分析证据损坏，请重新分析材料。');
    // Split analysis sessions may each have their own E1. Give this design
    // session an unambiguous run-local index without altering source evidence.
    entries.push({ ...entry, id: `E${entries.length + 1}` });
  }
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function validateDesignDraft(value: unknown, record: ProjectRecord, analysisRunId: string, runId: string, evidence: Map<string, { materialId: string; pageNumber?: number }>): asserts value is DesignDraftSubmission {
  if (!Check(designDraftSchema, value)) throw new Error('初步设计方案结构不合法。');
  if (value.runId !== runId || value.analysisRunId !== analysisRunId) throw new Error('设计方案运行 ID 不匹配。');
  const analysis = record.analysis;
  if (!analysis || analysis.runId !== analysisRunId || analysis.status !== 'completed') throw new Error('必须基于已完成的材料分析生成设计方案。');
  const primary = record.materials.find((material) => material.purpose === 'primary');
  if (!primary) throw new Error('缺少主稿，无法生成设计方案。');
  const usedPages = new Set<number>();
  const selectedPageNumbers = record.representativeSelection?.runId === analysisRunId ? new Set(record.representativeSelection.pageNumbers) : new Set(analysis.representativePages.map((page) => page.pageNumber));
  const checkRefs = (refs: string[], pageNumber?: number, materialId?: string) => {
    for (const ref of refs) {
      const item = evidence.get(ref);
      if (!item) throw new Error(`设计方案引用了不存在的证据 ${ref}。`);
      if (pageNumber !== undefined && (item.materialId !== materialId || item.pageNumber !== pageNumber)) throw new Error(`证据 ${ref} 与第 ${pageNumber} 页不匹配。`);
    }
  };
  checkRefs(value.designDirection.evidenceRefs);
  const minimum = Math.min(3, selectedPageNumbers.size);
  if (value.selectedPages.length < minimum || value.selectedPages.length > 5) throw new Error('特选页面数量必须为 3—5 页（主稿不足时按实际数量）。');
  for (const page of value.selectedPages) {
    if (usedPages.has(page.sourcePageNumber)) throw new Error('特选页面不能重复。');
    usedPages.add(page.sourcePageNumber);
    if (!selectedPageNumbers.has(page.sourcePageNumber)) throw new Error(`第 ${page.sourcePageNumber} 页不在用户确认的特选页面中。`);
    if (!analysis.representativePages.some((candidate) => candidate.materialId === primary.id && candidate.pageNumber === page.sourcePageNumber)) throw new Error(`第 ${page.sourcePageNumber} 页不是已核实的主稿代表页。`);
    checkRefs(page.evidenceRefs);
    if (!page.evidenceRefs.some((ref) => evidence.get(ref)?.materialId === primary.id && evidence.get(ref)?.pageNumber === page.sourcePageNumber)) throw new Error(`第 ${page.sourcePageNumber} 页须引用自身证据。`);
    for (const block of page.prototype.blocks) {
      if (block.x + block.width > 33.867 || block.y + block.height > 19.05) throw new Error(`第 ${page.sourcePageNumber} 页的原型元素超出画布。`);
      if (block.type !== 'shape' && !block.text.trim()) throw new Error('原型文字元素不能为空。');
    }
  }
}

export async function createDesignTools(record: ProjectRecord, runRoot: string, analysisRunId: string, runId: string, callbacks: { onSubmit: (draft: DesignDraftSubmission) => void; onTool: (tool: string, phase: 'started' | 'finished') => void }) {
  const evidence = await readEvidence(runRoot, record);
  const readRefs = new Set<string>();
  const previewedPages = new Set<number>();
  let contextRead = false;
  let submitted = false;
  function tool<S extends TSchema>(name: string, label: string, description: string, parameters: S, action: (params: Static<S>, signal?: AbortSignal) => Promise<ReturnType<typeof textResult> | Awaited<ReturnType<typeof imageResult>>>) {
    return { name, label, description, parameters, executionMode: 'sequential' as const, execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      if (!Check(parameters, params)) throw new Error('工具参数无效。');
      signal?.throwIfAborted(); callbacks.onTool(name, 'started');
      try { const result = await action(params as Static<S>, signal); signal?.throwIfAborted(); return result; } finally { callbacks.onTool(name, 'finished'); }
    } } satisfies ToolDefinition;
  }
  const tools: ToolDefinition[] = [
    tool('read_design_context', '读取设计上下文', '读取已完成的分析、材料备注、代表页候选及设计会话证据索引。证据编号以此索引为准。', Type.Object({}), async () => {
      contextRead = true;
      return textResult({ project: { name: record.name, brief: record.brief }, materials: record.materials.map(({ id, name, purpose, note }) => ({ id, name, purpose, note })), analysis: record.analysis, candidatePages: record.representativeSelection?.pageNumbers ?? record.analysis?.representativePages.map((page) => page.pageNumber), evidenceIndex: [...evidence.values()].map(({ sourceText: _sourceText, ...item }) => item), renderer: { widthCm: 33.867, heightCm: 19.05, units: 'cm; fontSize in pt', supported: 'editable text and preset shapes only; all title/content/style/geometry must be explicitly specified in prototype.blocks', limitations: '不自动复制源稿或模板的图片、Logo、图表和母版元素；未复现的固定元素必须列入 limitations，不得声称已保留。' } });
    }),
    tool('read_design_evidence', '读取设计证据', '按证据编号读取完整的只读证据。', Type.Object({ evidenceRefs: Type.Array(Type.String({ pattern: '^E[1-9][0-9]*$' }), { minItems: 1, maxItems: 12 }) }), async (params) => {
      const items = params.evidenceRefs.map((id) => { const item = evidence.get(id); if (!item) throw new Error(`证据 ${id} 不存在。`); return item; });
      params.evidenceRefs.forEach((ref) => readRefs.add(ref));
      return textResult(items);
    }),
    tool('render_source_page', '预览主稿页面', '读取已生成的主稿页面预览，用于判断当前页面结构。', Type.Object({ pageNumber: Type.Integer({ minimum: 1 }) }), async (_params, signal) => {
      const selected = record.representativeSelection?.runId === analysisRunId ? new Set(record.representativeSelection.pageNumbers) : new Set(record.analysis?.representativePages.map((candidate) => candidate.pageNumber));
      const primary = record.materials.find((material) => material.purpose === 'primary');
      const page = record.analysis?.representativePages.find((candidate) => candidate.materialId === primary?.id && candidate.pageNumber === _params.pageNumber && selected.has(candidate.pageNumber));
      if (!page) throw new Error('只能预览已核实的主稿代表页。');
      const material = await authorizedMaterial(record, page.materialId);
      const output = join(runRoot, 'previews', `${page.materialId}-${page.pageNumber}.png`);
      try { await access(output); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        await mkdir(join(runRoot, 'previews'), { recursive: true });
        await runOfficeCli(['view', material.localPath, 'screenshot', '--page', String(page.pageNumber), '--screenshot-width', '1400', '--screenshot-height', '1000', '--out', output], { signal });
      }
      signal?.throwIfAborted();
      const result = await imageResult(output, { materialId: page.materialId, pageNumber: page.pageNumber });
      previewedPages.add(page.pageNumber);
      return result;
    }),
    tool('submit_design_draft', '提交初步设计方案', '提交整体设计方向和 3—5 个特选页面的原型规格。提交后立即结束。', designDraftSchema, async (params) => {
      validateDesignDraft(params, record, analysisRunId, runId, evidence);
      if (submitted) throw new Error('本轮方案已提交，不能再次提交。');
      if (!contextRead || params.selectedPages.some((page) => !previewedPages.has(page.sourcePageNumber))) throw new Error('请先读取设计上下文并查看每张特选页面预览。');
      if ([...params.designDirection.evidenceRefs, ...params.selectedPages.flatMap((page) => page.evidenceRefs)].some((ref) => !readRefs.has(ref))) throw new Error('请先读取方案引用的完整证据再提交。');
      callbacks.onSubmit(params);
      submitted = true;
      return textResult('初步设计方案校验通过。请结束本轮。');
    }),
  ];
  return tools;
}
