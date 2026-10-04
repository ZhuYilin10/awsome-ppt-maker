import { useEffect, useState } from 'react';
import type { DesignRunSnapshot } from '../../shared/analysis';
import type { DesktopAPI, ProjectRecord } from '../../shared/project';

const stages: Record<DesignRunSnapshot['status'], string> = { queued: '等待开始', 'agent-reading': 'Agent 读取设计证据', generating: '生成特选页面原型', completed: '方案和预览已完成', failed: '生成失败', cancelled: '已取消' };

export default function DesignPanel({ project, run, busy, api, onRunStarted, onBack, onCancel }: { project?: ProjectRecord; run?: DesignRunSnapshot; busy: boolean; api?: DesktopAPI; onRunStarted: (run: DesignRunSnapshot) => void; onBack: () => void; onCancel: () => void }) {
  const draft = project?.designDraft;
  const [sourcePreviews, setSourcePreviews] = useState<Record<number, string>>({});
  const [prototypePreviews, setPrototypePreviews] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    setSourcePreviews({}); setPrototypePreviews({}); setError('');
    if (!api || !draft) return;
    let active = true;
    const previewError = () => { if (active) setError('部分页面预览加载失败，请重新打开项目。'); };
    void Promise.all(draft.selectedPages.map(async (page) => [page.sourcePageNumber, await api.getRepresentativePreview(project!.id, page.sourcePageNumber)] as const)).then((items) => { if (active) setSourcePreviews(Object.fromEntries(items.filter((item): item is [number, string] => Boolean(item[1])))); }).catch(previewError);
    void Promise.all(draft.selectedPages.map(async (page) => [page.sourcePageNumber, await api.getPrototypePreview(project!.id, page.sourcePageNumber)] as const)).then((items) => { if (active) setPrototypePreviews(Object.fromEntries(items.filter((item): item is [number, string] => Boolean(item[1])))); }).catch(previewError);
    return () => { active = false; };
  }, [api, draft, project]);
  async function start() {
    if (!api || !project || busy) return;
    setError('');
    try { const next = await api.startDesignDraft(project.id); onRunStarted(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <section className="design-panel">
    <div className="section-heading"><div><h2>Agent 初步设计方案</h2><p>Pi 读取已核实的材料和代表页，先生成少量可预览的原型页面。</p></div><button className="text-button" onClick={onBack}>返回代表页</button></div>
    {run && <div className="analysis-progress" role="status"><div><strong>{stages[run.status]}</strong><p>{run.message}</p><small>{run.currentTool && `当前工具 · ${run.currentTool}`}{run.agentRequestNumber && ` · 模型第 ${run.agentRequestNumber} 轮`}</small></div>{busy && <button className="secondary-action" onClick={onCancel}>取消生成</button>}</div>}
    {run?.error && <p className="error-text" role="alert">{run.error}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {!draft && !busy && <div className="design-empty"><span className="design-empty-kicker">PI / DESIGN EXPLORATION</span><h3>先做几页，让方向变得可见。</h3><p>Agent 会从主稿中选择封面、流程、数据等不同结构的页面，生成一个独立的原型 PPT。原始材料不会被修改。当前原型支持可编辑文字和基本形状，暂不复制图片、Logo、图表及母版。</p><button className="primary-action" onClick={() => void start()}>生成初步方案与特选页面</button></div>}
    {draft && <>
      <article className="design-direction"><span className="design-empty-kicker">DESIGN DIRECTION</span><h3>{draft.designDirection.thesis}</h3><p>{draft.designDirection.narrativeStrategy}</p><div className="design-direction-grid"><div><strong>视觉系统</strong><p>{draft.designDirection.visualSystem}</p></div><div><strong>不可变元素</strong><ul>{draft.designDirection.nonNegotiables.map((item) => <li key={item}>{item}</li>)}</ul></div></div></article>
      <div className="section-heading design-pages-heading"><div><h3>特选页面原型</h3><p>左侧是原始页面，右侧是按 Agent 规格生成的独立原型。</p></div><button className="secondary-action" disabled={busy} onClick={() => void start()}>重新生成</button></div>
      <div className="prototype-list">{draft.selectedPages.map((page) => <article className="prototype-card" key={page.sourcePageNumber}><div className="prototype-card-header"><div><strong>第 {page.sourcePageNumber} 页 · {page.title}</strong><small>{page.contentRole} · {page.targetLayout}</small></div><span className={`analysis-status ${page.confidence === 'high' ? 'analyzed' : ''}`}>{page.confidence} confidence</span></div><div className="prototype-comparison"><div><span>原始页面</span>{sourcePreviews[page.sourcePageNumber] ? <img src={sourcePreviews[page.sourcePageNumber]} alt={`原始第 ${page.sourcePageNumber} 页`} /> : <div className="preview-placeholder">暂无原始预览</div>}</div><div><span>Agent 原型</span>{prototypePreviews[page.sourcePageNumber] ? <img src={prototypePreviews[page.sourcePageNumber]} alt={`原型第 ${page.sourcePageNumber} 页`} /> : <div className="preview-placeholder">等待原型生成</div>}</div></div><p className="prototype-purpose">{page.purpose}</p><details><summary>查看设计规格</summary><p><strong>视觉方向：</strong>{page.visualDirection}</p><p><strong>保留：</strong>{page.preservedElements.join('、') || '无'}</p><p><strong>改动：</strong>{page.proposedChanges.join('、') || '无'}</p></details></article>)}</div>
      {draft.openQuestions.length > 0 && <article className="analysis-report"><h3>待确认问题</h3><ul>{draft.openQuestions.map((item) => <li key={item}>{item}</li>)}</ul></article>}
      {draft.limitations.length > 0 && <article className="analysis-report"><h3>原型限制与未复现元素</h3><ul>{draft.limitations.map((item) => <li key={item}>{item}</li>)}</ul></article>}
    </>}
  </section>;
}
