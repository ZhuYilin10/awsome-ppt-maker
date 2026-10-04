import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord, ProjectSummary, RuntimeStatus } from '../../shared/project';
import type { AnalysisRunSnapshot } from '../../shared/analysis';
import Settings from './Settings';
import AnalysisPanel from './AnalysisPanel';
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Info,
  Layers3,
  LoaderCircle,
  Paperclip,
  Presentation,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { formatFileSize, Material, MaterialPurpose, purposeLabels } from './types';

const initialMaterial = (file: { id: string; sourcePath: string; name: string; size: number }): Material => ({
  ...file,
  purpose: file.name.toLowerCase().endsWith('.pptx') ? 'primary' : 'auto',
  note: '',
});

function fileKind(name: string) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pptx' || extension === 'ppt') return 'presentation';
  if (extension === 'xlsx' || extension === 'xls') return 'spreadsheet';
  if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(extension ?? '')) return 'image';
  return 'document';
}

function MaterialIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === 'presentation') return <Presentation size={19} />;
  if (kind === 'spreadsheet') return <FileSpreadsheet size={19} />;
  if (kind === 'image') return <FileImage size={19} />;
  return <FileText size={19} />;
}

function App() {
  const api = window.pptPlan;
  const [projectName, setProjectName] = useState('');
  const [brief, setBrief] = useState('');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [isSaving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [error, setError] = useState('');
  const [project, setProject] = useState<ProjectRecord>();
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [analysisVisible, setAnalysisVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [analysisRun, setAnalysisRun] = useState<AnalysisRunSnapshot>();
  const [dragging, setDragging] = useState(false);
  const operationPending = useRef(false);
  const projectIdRef = useRef<string>();
  projectIdRef.current = project?.id;

  useEffect(() => {
    if (!api) return;
    void Promise.all([api.listProjects(), api.runtimeStatus()]).then(([items, status]) => { setRecent(items); setRuntime(status); }).catch((cause) => setError(String(cause)));
    return api.onAnalysisEvent((event) => {
      if (event.snapshot.projectId !== projectIdRef.current) return;
      setAnalysisRun(event.snapshot);
      if (event.type === 'run-failed' || event.type === 'run-cancelled') setError(event.message ?? event.snapshot.error ?? '材料分析未完成。');
      if (event.type === 'run-completed' || event.type === 'material-finished') void api.openProject(event.snapshot.projectId).then((record) => {
        setProject((current) => current?.id === record.id ? record : current);
        if (event.type === 'run-completed') setError('');
      }).catch(() => undefined);
    });
  }, [api]);

  useEffect(() => {
    const warnBeforeClosing = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warnBeforeClosing);
    return () => window.removeEventListener('beforeunload', warnBeforeClosing);
  }, [dirty]);

  const primaryCount = useMemo(() => materials.filter((material) => material.purpose === 'primary').length, [materials]);
  const canContinue = projectName.trim().length > 1 && materials.length > 0 && primaryCount === 1;
  const analysisBusy = Boolean(analysisRun && !['completed', 'failed', 'cancelled'].includes(analysisRun.status));
  const saving = isSaving || analysisBusy;

  async function addMaterials(files?: File[]) {
    setError('');
    if (!api || saving || operationPending.current) return;
    operationPending.current = true;
    let selected;
    try { selected = files ? await api.importDroppedFiles(files) : await api.selectMaterials(); } catch (cause) { setError(String(cause)); return; } finally { operationPending.current = false; }
    if (!selected.length) return;
    setMaterials((current) => {
      const existing = new Set(current.map((material) => material.sourcePath));
      let hasPrimary = current.some((material) => material.purpose === 'primary');
      const added = selected.filter((file) => !existing.has(file.sourcePath)).map((file) => {
        const material = initialMaterial(file);
        if (material.purpose === 'primary' && hasPrimary) material.purpose = 'auto';
        if (material.purpose === 'primary') hasPrimary = true;
        return material;
      });
      return [...current, ...added];
    });
    setDirty(true);
  }

  function updateMaterial(id: string, patch: Partial<Material>) {
    setDirty(true);
    setMaterials((current) => current.map((material) => {
      if (material.id !== id) return material;
      return { ...material, ...patch };
    }));
  }

  function setPurpose(id: string, purpose: MaterialPurpose) {
    setDirty(true);
    setMaterials((current) => current.map((material) => {
      if (material.id === id) return { ...material, purpose };
      if (purpose === 'primary' && material.purpose === 'primary') return { ...material, purpose: 'auto' };
      return material;
    }));
  }

  async function createProject(analyze = true) {
    if (!api || !canContinue || saving || operationPending.current) return;
    operationPending.current = true;
    setSaving(true);
    setError('');
    try {
      const record = await api.saveProject({ id: project?.id, name: projectName.trim(), brief: brief.trim(), materials });
      setProject(record);
      projectIdRef.current = record.id;
      setSavedPath(record.projectPath);
      setDirty(false);
      if (analyze) {
        setAnalysisVisible(true);
        const run = await api.startProjectAnalysis(record.id);
        setAnalysisRun((current) => current?.runId === run.runId ? current : run);
      }
      setRecent(await api.listProjects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '项目保存失败，请重试。');
    } finally {
      setSaving(false);
      operationPending.current = false;
    }
  }

  async function openProject(id: string) {
    if (!api || saving || operationPending.current) return;
    if (dirty && !window.confirm('有修改未保存，是否放弃修改并打开其他项目？')) return;
    operationPending.current = true;
    try {
      const record = await api.openProject(id);
      setProject(record); setProjectName(record.name); setBrief(record.brief); setMaterials(record.materials);
      const run = await api.getAnalysisRun(record.id);
      setSavedPath(record.projectPath); setDirty(false); setShowRecent(false); setAnalysisVisible(Boolean(record.analysis || (run && !['completed', 'failed', 'cancelled'].includes(run.status)))); setAnalysisRun(run); setError('');
    } catch (cause) { setError(String(cause)); } finally { operationPending.current = false; }
  }

  function newProject() {
    if (saving || operationPending.current) return;
    if (dirty && !window.confirm('有修改未保存，是否放弃修改并新建项目？')) return;
    setProject(undefined); setProjectName(''); setBrief(''); setMaterials([]); setSavedPath(''); setAnalysisRun(undefined);
    setDirty(false); setAnalysisVisible(false); setShowRecent(false); setError('');
  }

  if (settingsVisible) return <main className="app-shell"><aside className="sidebar"><div className="brand-lockup"><div className="brand-mark"><Layers3 size={20} strokeWidth={2.4} /></div><div><div className="brand-name">PPT Plan</div><div className="brand-caption">STUDIO</div></div></div><div className="sidebar-section-label">工作区</div><nav className="workflow-nav" aria-label="工作区导航"><button className="workflow-item" onClick={() => setSettingsVisible(false)}><span className="workflow-number">01</span><span>项目材料</span></button><button className="workflow-item active"><Settings2 size={15} /><span>设置</span><span className="workflow-dot" /></button></nav><div className="sidebar-footnote"><Sparkles size={15} /><span>配置 Provider，<br />让 Agent 开始工作。</span></div></aside><section className="workspace"><Settings api={api} onBack={() => setSettingsVisible(false)} /></section></main>;

  return (
    <main className={`app-shell ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); if (api && !saving) setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!saving) void addMaterials(Array.from(event.dataTransfer.files)); }}>
      <input id="material-file-input" type="file" multiple hidden accept=".pptx,.docx,.xlsx,.pdf,.png,.jpg,.jpeg,.svg,.webp" onChange={(event) => { if (event.target.files && !saving) void addMaterials(Array.from(event.target.files)); event.target.value = ''; }} />
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Layers3 size={20} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">PPT Plan</div>
            <div className="brand-caption">STUDIO</div>
          </div>
        </div>

        <div className="sidebar-section-label">工作流</div>
        <nav className="workflow-nav" aria-label="项目工作流">
           <button className={`workflow-item ${!analysisVisible ? 'active' : ''}`} onClick={() => setAnalysisVisible(false)}><span className="workflow-number">01</span><span>导入材料</span>{!analysisVisible && <span className="workflow-dot" />}</button>
            <button className={`workflow-item ${analysisVisible ? 'active' : ''}`} disabled={project?.analysis?.status !== 'completed' || dirty || analysisBusy} onClick={() => setAnalysisVisible(true)}><span className="workflow-number">02</span><span>选择代表页</span>{analysisVisible && <span className="workflow-dot" />}</button>
           <button className="workflow-item" disabled><span className="workflow-number">03</span><span>代表页 Plan</span></button>
           <button className="workflow-item" disabled><span className="workflow-number">04</span><span>设计规范</span></button>
           <button className="workflow-item" disabled><span className="workflow-number">05</span><span>整套制作</span></button>
        </nav>

        <div className="sidebar-footnote">
          <Sparkles size={15} />
          <span>先让 Agent 读懂材料，再开始设计。</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>项目</span><span className="breadcrumb-slash">/</span><strong>{project?.name ?? '新建项目'}</strong></div>
          <div className="topbar-actions"><span className="local-badge"><span className="status-dot" />本地工作区</span><button className="text-button" onClick={() => setSettingsVisible(true)} disabled={!api || saving}><Settings2 size={16} />设置</button><button className="text-button" onClick={newProject} disabled={!api || saving}>新建项目</button><button className="text-button" onClick={() => setShowRecent(!showRecent)} disabled={!api || saving}><FolderOpen size={17} />最近项目</button></div>
        </header>

        <div className="project-workspace">
        <div className="content-scroll">
          {!api && <div className="preview-warning">这是界面预览。本地文件与项目操作仅在 Electron 桌面程序中可用。</div>}
          {showRecent && <section className="recent-panel"><h2>最近项目</h2>{recent.length ? recent.map((item) => <button className="recent-item" key={item.id} onClick={() => openProject(item.id)}><span>{item.name}</span><small>{item.materialCount} 份材料 · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small><ArrowRight size={16} /></button>) : <p>还没有已保存项目。</p>}</section>}
          <div className="intro-row">
            <div>
              <h1>{analysisVisible ? '读懂材料，再确定代表页。' : '先把材料交给 Agent。'}</h1>
              <p className="intro-copy">{analysisVisible ? '查看材料判断与证据，选择能覆盖不同内容结构的页面。' : '告诉它每份文件该怎么用。说明越具体，后面生成的设计规范越贴近你的真实意图。'}</p>
            </div>
            <div className="stage-mark"><span>PLAN</span><span className="stage-line" /><span>{analysisVisible ? '02' : '01'}</span></div>
          </div>

           {analysisVisible ? <AnalysisPanel project={project} run={analysisRun} busy={analysisBusy || dirty} api={api} onSaved={setProject} onBack={() => setAnalysisVisible(false)} onCancel={() => { if (project) void api?.cancelProjectAnalysis(project.id).catch((cause) => setError(String(cause))); }} /> : (
            <section className="setup-main">
              <div className="section-heading"><div><h2>项目基本信息</h2><p>这是 Agent 在整个项目中都会看到的背景。</p></div><Info size={17} /></div>
              <div className="field-group">
                <label htmlFor="project-name">项目名称 <span>必填</span></label>
                <input id="project-name" maxLength={120} disabled={saving} value={projectName} onChange={(event) => { setProjectName(event.target.value); setDirty(true); }} placeholder="例如：海洋之帆奖申报 PPT" />
              </div>
              <div className="field-group">
                <label htmlFor="project-brief">这次希望怎么改？ <span>可选</span></label>
                <textarea id="project-brief" rows={4} maxLength={10000} disabled={saving} value={brief} onChange={(event) => { setBrief(event.target.value); setDirty(true); }} placeholder="例如：内容完整保留，整体稳重但不要厚重。蓝色为主，少量金色；首页、尾页和右下角 Logo 不要改。" />
                <div className="field-hint">可以写用途、受众、风格偏好，以及明确不能动的内容。</div>
              </div>

              <div className="section-heading materials-heading"><div><h2>项目材料 <span className="count-badge">{materials.length}</span></h2><p>每份材料都可以单独说明用途和注意事项。</p></div><button className="add-material-button" disabled={!api || saving} onClick={() => addMaterials()}><Paperclip size={16} />添加材料</button></div>

              {materials.length === 0 ? (
                <button className="dropzone" disabled={!api || saving} onClick={() => addMaterials()}>
                  <span className="upload-icon"><Upload size={21} /></span>
                  <span className="dropzone-title">拖入 PPTX、Word、Excel、PDF 或图片</span>
                  <span className="dropzone-caption">支持一次选择多份材料，文件只保存在本机项目目录</span>
                  <span className="dropzone-action">选择文件 <ArrowRight size={15} /></span>
                </button>
              ) : (
                <div className="material-list">
                  {materials.map((material, index) => (
                    <article className={`material-item ${material.purpose === 'primary' ? 'is-primary' : ''}`} key={material.id}>
                      <div className="material-topline">
                        <div className="material-file"><span className="file-icon"><MaterialIcon name={material.name} /></span><div><strong>{material.name}</strong><small>{formatFileSize(material.size)} · {material.purpose === 'primary' ? '主稿' : `材料 ${String(index + 1).padStart(2, '0')}`}</small></div></div>
                        <button className="remove-button" disabled={saving} onClick={() => { setMaterials((current) => current.filter((item) => item.id !== material.id)); setDirty(true); }} aria-label={`移除 ${material.name}`}><Trash2 size={16} /></button>
                      </div>
                      <div className="material-controls">
                        <div className="select-wrap"><select disabled={saving} aria-label={`${material.name} 的用途`} value={material.purpose} onChange={(event) => setPurpose(material.id, event.target.value as MaterialPurpose)}>{Object.entries(purposeLabels).map(([value, option]) => <option value={value} key={value} disabled={value === 'primary' && !/\.pptx$/i.test(material.name)}>{option.label}</option>)}</select><ChevronDown size={15} /></div>
                        <textarea rows={2} maxLength={5000} disabled={saving} aria-label={`${material.name} 的说明`} value={material.note} onChange={(event) => updateMaterial(material.id, { note: event.target.value })} placeholder="这份材料怎么使用？有哪些不能忽略的地方？" />
                      </div>
                      <div className="purpose-description">{purposeLabels[material.purpose].description}</div>
                    </article>
                  ))}
                  <button className="add-more" disabled={!api || saving} onClick={() => addMaterials()}><Paperclip size={15} />继续添加材料</button>
                </div>
              )}
            </section>
          )}
        </div>

            <aside className="setup-aside" aria-label="项目操作">
              <div className="aside-content">
              <div className="aside-card agent-card">
                <div className="aside-card-header"><span className="mini-agent-mark"><Sparkles size={14} /></span><span>Agent 会怎么处理</span></div>
                <ol className="agent-steps">
                  <li className="current"><span>1</span><div><strong>读取材料</strong><small>识别页面、文字、图片和固定元素</small></div></li>
                  <li><span>2</span><div><strong>推荐代表页</strong><small>找出内容形式差异最大的页面</small></div></li>
                  <li><span>3</span><div><strong>开始视觉 Plan</strong><small>用真实页面建立设计方向</small></div></li>
                </ol>
              </div>
              <div className="aside-card rule-card"><div className="rule-icon"><Check size={15} /></div><div><strong>原文件不会被修改</strong><p>导入时复制到项目目录。用途与说明会进入项目记录，供后续 Agent 使用。</p></div></div>
              <div className="aside-note"><Sparkles size={14} /><span>主稿只能有一份。其他文件可以作为内容、参考或素材。</span></div>
              <div className="runtime-note">OfficeCLI：{runtime ? runtime.officecli.available ? runtime.officecli.version : '未检测到，可先保存' : '检测中'}<br />AI Runtime：{runtime ? runtime.ai.runtimeReady ? runtime.ai.configured ? `OpenAI / ${runtime.ai.modelId}` : '未配置' : '不可用' : '检测中'}</div>
              </div>

          <footer className="action-bar">
            <div className="action-status" aria-live="polite">{error ? <span className="error-text" role="alert">{error}</span> : dirty && savedPath ? '有修改尚未保存' : savedPath ? <span className="success-text"><Check size={15} />项目已保存到本机</span> : materials.length && primaryCount !== 1 ? '请选择一份 PPTX 主稿' : <span><span className="status-dot muted" />准备好后开始分析</span>}</div>
             <div className="footer-actions">{project && <button className="text-button" disabled={isSaving} onClick={() => { void api?.revealProject(project.id).catch((cause) => setError(String(cause))); }}><FolderOpen size={16} />项目目录</button>}{analysisBusy && <button className="secondary-action" onClick={() => { if (project) void api?.cancelProjectAnalysis(project.id).catch((cause) => setError(String(cause))); }}>取消分析</button>}<button className="secondary-action" disabled={!api || !canContinue || saving} onClick={() => createProject(false)}>保存项目</button><button className="primary-action" disabled={!api || !canContinue || saving} onClick={() => createProject(true)}>{saving ? <><LoaderCircle size={17} className="spin" />{analysisBusy ? 'Agent 正在分析' : '正在保存'}</> : <>保存并分析材料 <ArrowRight size={17} /></>}</button></div>
          </footer>
            </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
