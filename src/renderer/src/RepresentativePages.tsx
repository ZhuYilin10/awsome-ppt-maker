import { useEffect, useState } from 'react';
import type { DesktopAPI, ProjectRecord } from '../../shared/project';

export default function RepresentativePages({ project, api, disabled, onSaved }: { project: ProjectRecord; api?: DesktopAPI; disabled: boolean; onSaved: (project: ProjectRecord) => void }) {
  const report = project.analysis!;
  const [selected, setSelected] = useState<number[]>([]);
  const [previews, setPreviews] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setSelected(project.representativeSelection?.runId === report.runId ? project.representativeSelection.pageNumbers : report.representativePages.map((page) => page.pageNumber));
    setPreviews({}); setError('');
    if (api) void Promise.all(report.representativePages.map(async (page) => [page.pageNumber, await api.getRepresentativePreview(project.id, page.pageNumber)] as const)).then((values) => {
      if (active) setPreviews(Object.fromEntries(values.filter((value): value is readonly [number, string] => Boolean(value[1]))));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, project.id, report.runId]);
  async function confirm() {
    if (!api) return;
    setPending(true); setError('');
    try { onSaved(await api.saveRepresentativePages(project.id, selected)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '代表页保存失败。'); }
    finally { setPending(false); }
  }
  return <section className="representative-pages"><div className="section-heading"><div><h3>选择代表页</h3><p>覆盖不同页面结构，用它们建立后续设计方向。</p></div><button className="secondary-action" disabled={disabled || pending || !selected.length || !api} onClick={() => { void confirm(); }}>{pending ? '正在保存' : '确认代表页'}</button></div>
    {report.representativePages.map((page) => <article className="analysis-item representative-candidate" key={page.pageNumber}><label className="candidate-heading"><input type="checkbox" disabled={disabled || pending} checked={selected.includes(page.pageNumber)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, page.pageNumber] : current.filter((number) => number !== page.pageNumber))} /><strong>第 {page.pageNumber} 页 · {page.title ?? '代表页'}</strong></label>{previews[page.pageNumber] ? <img className="candidate-preview" src={previews[page.pageNumber]} alt={`主稿第 ${page.pageNumber} 页的 OfficeCLI 预览`} /> : <p className="field-hint">该页暂无已生成预览，请按证据判断。</p>}<p>{page.reason}</p><small>证据：{page.evidence.map((item) => `${item.pageNumber ? `第 ${item.pageNumber} 页` : '材料'} ${item.note}`).join('；')}</small></article>)}
    {error && <p role="alert" className="error-text">{error}</p>}{project.representativeSelection?.runId === report.runId && <p className="success-text" role="status">已确认：{project.representativeSelection.pageNumbers.map((page) => `第 ${page} 页`).join('、')}。页面设计在后续阶段生成。</p>}
  </section>;
}
