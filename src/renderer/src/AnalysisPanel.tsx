import type { DesktopAPI, ProjectRecord } from '../../shared/project';
import type { AnalysisRunSnapshot } from '../../shared/analysis';
import RepresentativePages from './RepresentativePages';

const stages: Record<string, string> = { queued: '等待开始', preflight: '检查材料', extracting: '读取结构', rendering: '生成预览', 'agent-reading': 'Agent 读取证据', 'agent-synthesis': '综合判断', finalizing: '保存报告', completed: '分析完成', failed: '分析失败', cancelled: '已取消' };
const toolNames: Record<string, string> = { read_material_manifest: '材料清单', office_read: 'Office 内容', office_get: '页面与母版结构', render_pptx_page: 'PPT 页面预览', read_pdf: 'PDF 文本', render_pdf_page: 'PDF 页面预览', inspect_image: '图片分片', submit_analysis: '结构化报告' };
const roles: Record<string, string> = { 'primary-deck': '主稿', template: '模板', content: '内容材料', reference: '参考材料', asset: '素材', unknown: '待确认' };

export default function AnalysisPanel({ project, run, busy, api, onSaved, onBack, onCancel }: { project?: ProjectRecord; run?: AnalysisRunSnapshot; busy: boolean; api?: DesktopAPI; onSaved: (project: ProjectRecord) => void; onBack: () => void; onCancel: () => void }) {
  const report = project?.analysis;
  return <section className="analysis-panel">
    <div className="section-heading"><div><h2>Agent 材料分析</h2><p>本地证据读取 → Pi 理解与核实 → 结构化报告</p></div><button className="text-button" onClick={onBack}>返回修改材料</button></div>
    {run && <div className="analysis-progress" role="status"><div><strong>{stages[run.status]}</strong><p>{run.message}</p><small>结构读取 {run.completedMaterials}/{run.totalMaterials} 份{run.currentMaterialName && ` · ${run.currentMaterialName}`}{run.currentTool && ` · ${toolNames[run.currentTool] ?? run.currentTool}`}</small></div>{busy && <button className="secondary-action" onClick={onCancel}>取消分析</button>}</div>}
    {run?.error && <p className="error-text" role="alert">{run.error}</p>}
    {report && <><article className="analysis-report"><h3>项目判断{busy || run?.status === 'failed' || run?.status === 'cancelled' ? '（上次成功结果）' : ''}</h3><p>{report.summary}</p></article><RepresentativePages project={project!} api={api} disabled={busy} onSaved={onSaved} /></>}
    {project?.materials.map((file) => {
      const result = report?.materials.find((item) => item.materialId === file.id);
      const deterministic = run?.materialStates?.[file.id];
      const deterministicDone = deterministic?.status === 'read';
      return <article className="analysis-item" key={file.id}><div className="material-topline"><strong>{file.name}</strong><span className={`analysis-status ${deterministic?.status === 'error' ? 'error' : result || deterministicDone ? 'analyzed' : file.analysis?.status}`}>{deterministic?.status === 'error' ? '读取失败' : result ? roles[result.role] : deterministicDone ? '统计完成' : '等待 Agent 判断'}</span></div><p>{file.note || '未填写额外说明'}</p>{deterministic?.message && <p className="error-text">{deterministic.message}</p>}{result ? <><p>{result.contentSummary}</p><p>{result.visualSummary}</p>{result.constraints.length > 0 && <><h4>约束</h4><ul>{result.constraints.map((text, index) => <li key={index}>{text}</li>)}</ul></>}{result.issues.length > 0 && <><h4>问题与局限</h4><ul>{result.issues.map((text, index) => <li key={index}>{text}</li>)}</ul></>}<details><summary>查看证据</summary><ul>{result.evidence.map((item, index) => <li key={index}>{project.materials.find((material) => material.id === item.materialId)?.name}{item.pageNumber && ` · 第 ${item.pageNumber} 页`}{item.location && ` · ${item.location}`}：{item.note}</li>)}</ul></details></> : file.analysis?.summary && <details><summary>已有基础统计（非 AI 报告）</summary><pre>{file.analysis.summary}</pre></details>}</article>;
    })}
    {!report && <p className="field-hint">只有 Agent 成功提交并通过证据校验后，才会生成代表页推荐。失败或取消可再次点击“保存并分析材料”。</p>}
  </section>;
}
