import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectRecord } from '../src/shared/project';
import type { PrototypePageSpec } from '../src/shared/analysis';
import { validateDesignDraft } from '../src/main/design-tools';
import { generatePrototype } from '../src/main/prototype-generator';
import { runOfficeCli } from '../src/main/officecli';

const pages = [1, 4, 8].map((sourcePageNumber, index) => ({
  sourcePageNumber, title: `原型页 ${sourcePageNumber}`, purpose: '验证页面生成', contentRole: ['cover', 'process', 'data'][index], targetLayout: '测试布局', visualDirection: '清晰层级', contentHierarchy: ['标题', '关键内容'], sourceContent: ['真实内容'], preservedElements: ['品牌色'], proposedChanges: ['突出重点'], evidenceRefs: [`E${index + 1}`], confidence: 'high',
  prototype: { background: '#F5F7FB', accentColor: '#5267DF', blocks: [
    { type: 'heading', text: '原型副标题', x: 1.5, y: 1, width: 24, height: 1.5, font: 'Aptos', fontSize: 36, color: '#13233A', fill: 'none', line: 'none', bold: true, align: 'left', valign: 'top' },
    { type: 'stat', text: '0.080%', x: 1.5, y: 4, width: 8, height: 2.5, font: 'Aptos', fontSize: 28, color: '#5267DF', fill: '#FFFFFF', line: '#5267DF', bold: true, align: 'center', valign: 'center', geometry: 'roundRect' },
    { type: 'callout', text: '闭环机制', x: 18, y: 4, width: 13, height: 3, font: 'Aptos', fontSize: 18, color: '#344054', fill: '#FFFFFF', line: '#5267DF', bold: false, align: 'left', valign: 'center', geometry: 'roundRect' },
  ] },
})) as PrototypePageSpec[];

function record(): ProjectRecord {
  return {
    id: 'project-id', name: '测试项目', brief: '测试设计方案', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectPath: '/tmp/project',
    materials: [{ id: 'primary-id', sourcePath: '/tmp/source.pptx', name: 'source.pptx', size: 1, purpose: 'primary', note: '', localPath: '/tmp/source.pptx' }],
    analysis: { runId: 'analysis-id', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), summary: 'summary', materials: [{ materialId: 'primary-id', role: 'primary-deck', roleReason: '主稿', contentSummary: '内容', visualSummary: '结构', constraints: [], issues: [], evidence: [{ materialId: 'primary-id', pageNumber: 1, note: 'page' }] }], representativePages: pages.map((page) => ({ materialId: 'primary-id', pageNumber: page.sourcePageNumber, contentRole: page.contentRole, visualRole: 'text', reason: '代表', confidence: 'high', evidence: [{ materialId: 'primary-id', pageNumber: page.sourcePageNumber, note: 'page' }] })), evidence: [] },
    representativeSelection: { runId: 'analysis-id', pageNumbers: [1, 4, 8], confirmedAt: new Date().toISOString() },
  };
}

test('validates an evidence-backed design draft and rejects unconfirmed pages', () => {
  const value = { runId: 'design-id', analysisRunId: 'analysis-id', designDirection: { thesis: '方向', narrativeStrategy: '叙事', visualSystem: '系统', nonNegotiables: ['品牌色'], evidenceRefs: ['E1'] }, selectedPages: pages, openQuestions: [], limitations: [] };
  const evidence = new Map(['E1', 'E2', 'E3'].map((id, index) => [id, { materialId: 'primary-id', pageNumber: [1, 4, 8][index] }]));
  assert.doesNotThrow(() => validateDesignDraft(value, record(), 'analysis-id', 'design-id', evidence));
  const invalid = { ...value, selectedPages: [{ ...pages[0], sourcePageNumber: 2 }, pages[1], pages[2]] };
  assert.throws(() => validateDesignDraft(invalid, record(), 'analysis-id', 'design-id', evidence), /不在用户确认|已核实/);
});

test('generates an editable prototype PPTX and rendered previews', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-design-prototype-'));
  try {
    const result = await generatePrototype(root, 'project-id', 'design-id', pages);
    assert.equal(result.pages.length, 3);
    assert.ok(result.pages.every((page) => page.status === 'generated'));
    assert.deepEqual(result.sourceHashes, {});
    const stats = JSON.parse(await runOfficeCli(['view', result.outputPath, 'stats', '--json']));
    assert.equal(stats.data.slides, 3);
    assert.equal(stats.data.textBoxes > 0, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
