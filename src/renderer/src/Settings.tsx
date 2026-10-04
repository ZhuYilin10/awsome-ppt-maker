import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, List, LoaderCircle, Network, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import type { AiModelOption, AiSettingsInput, AiSettingsSnapshot, ConnectionTestResult, ThinkingLevel } from '../../shared/ai';
import type { DesktopAPI } from '../../shared/project';

type Props = { api?: DesktopAPI; onBack: () => void };

const levels: Array<{ value: ThinkingLevel; label: string; description: string }> = [
  { value: 'off', label: '关闭', description: '不发送 reasoning 参数' },
  { value: 'minimal', label: 'Minimal', description: '快速处理简单任务' },
  { value: 'low', label: 'Low', description: '轻量推理' },
  { value: 'medium', label: 'Medium', description: '推荐的默认级别' },
  { value: 'high', label: 'High', description: '复杂规划和分析' },
  { value: 'xhigh', label: 'XHigh', description: '最高推理强度，耗时更长' },
];

function resultLabel(result?: ConnectionTestResult) {
  if (!result) return '尚未测试连接';
  if (result.status === 'success') return '连接成功';
  if (result.status === 'auth-error') return '认证失败';
  if (result.status === 'model-error') return '模型或地址错误';
  if (result.status === 'network-error') return '网络连接失败';
  return '连接测试失败';
}

export default function Settings({ api, onBack }: Props) {
  const [settings, setSettings] = useState<AiSettingsSnapshot>();
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [modelId, setModelId] = useState('o3-mini');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<AiModelOption[]>([]);

  useEffect(() => {
    if (!api) return;
    void api.getAiSettings().then((snapshot) => {
      setSettings(snapshot); setBaseUrl(snapshot.baseUrl); setModelId(snapshot.modelId); setThinkingLevel(snapshot.thinkingLevel);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取 AI 设置。'));
  }, [api]);

  function errorText(cause: unknown) { return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败，请重试。'; }
  function change(setter: (value: string) => void, value: string) { setter(value); setDirty(true); setMessage(''); setError(''); }

  function currentInput(): AiSettingsInput { return { provider: 'openai', baseUrl, modelId, thinkingLevel, ...(apiKey ? { apiKey } : {}) }; }

  async function fetchModels() {
    if (!api || busy) return;
    setBusy('正在拉取模型'); setError(''); setMessage('');
    try {
      const result = await api.fetchAiModels(currentInput());
      setModels(result);
      setMessage(`已拉取 ${result.length} 个模型，可在列表中选择。`);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function save() {
    if (!api || !modelId.trim() || !baseUrl.trim() || busy) return;
    setBusy('正在保存设置'); setError(''); setMessage('');
    const input = currentInput();
    try {
      const snapshot = await api.saveAiSettings(input);
      setSettings(snapshot); setApiKey(''); setDirty(false); setMessage('设置已保存，新的 Agent 会话将使用它。');
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function testConnection() {
    if (!api || busy) return;
    if (dirty) { setError('请先保存设置，再测试连接。'); return; }
    setBusy('正在请求 OpenAI'); setError(''); setMessage('');
    try {
      const result = await api.testAiConnection();
      setSettings((current) => current ? { ...current, lastTest: result } : current);
      if (result.status === 'success') setMessage(result.message ?? resultLabel(result));
      else setError(result.message ?? resultLabel(result));
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  async function clearCredential() {
    if (!api || busy || !window.confirm('确定清除已保存的 OpenAI API Key 吗？')) return;
    setBusy('正在清除凭据'); setError(''); setMessage('');
    try { await api.clearAiCredential(); setSettings((current) => current ? { ...current, configured: false, lastTest: undefined } : current); setMessage('API Key 已清除。'); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }

  return <section className="settings-page">
    <header className="settings-header"><button className="back-button" onClick={onBack}><ArrowLeft size={16} />返回项目</button><div className="settings-kicker">WORKSPACE SETTINGS</div><h1>让 Agent 连接到你的模型。</h1><p>配置一次，后续的材料分析、Plan 和设计迭代都会使用这套运行时。</p></header>
    <div className="settings-layout">
      <div className="settings-main">
        <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Network size={18} /></div><div><h2>AI Provider</h2><p>当前版本只支持 OpenAI。</p></div><span className="beta-tag">第一期</span></div><div className="provider-choice"><div className="provider-logo">◎</div><div><strong>OpenAI</strong><small>Responses API · reasoning</small></div><Check size={17} /></div></section>
        <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><KeyRound size={18} /></div><div><h2>连接配置</h2><p>API Key 只保存在本机安全存储，不会进入项目文件。</p></div></div><div className="settings-fields"><label>API Key <span>{settings?.configured ? '已配置，输入新值可替换' : '必填'}</span><div className="secret-field"><input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => change(setApiKey, event.target.value)} disabled={!!busy} placeholder={settings?.configured ? '已保存 · 不会显示原值' : 'sk-...'} autoComplete="off" />{apiKey && <button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>}</div></label><label>Base URL <span>支持 OpenAI 兼容的 HTTP / HTTPS 地址</span><input value={baseUrl} onChange={(event) => change(setBaseUrl, event.target.value)} disabled={!!busy} placeholder="https://api.openai.com/v1" /></label><label>Model ID <span>可从模型列表选择，也可手动填写</span><div className="field-with-action"><input list="ai-model-options" value={modelId} onChange={(event) => change(setModelId, event.target.value)} disabled={!!busy} placeholder="例如 gpt-4o" /><button type="button" className="fetch-models-button" onClick={fetchModels} disabled={!api || !!busy || !baseUrl.trim() || (!apiKey && !settings?.configured)}><RefreshCw size={14} className={busy === '正在拉取模型' ? 'spin' : ''} />拉取模型</button></div><datalist id="ai-model-options">{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>{models.length > 0 && <small className="model-count"><List size={13} />已加载 {models.length} 个模型</small>}</label></div>{baseUrl.trim().toLowerCase().startsWith('http://') && <div className="settings-warning"><ShieldCheck size={15} /><span>当前使用 HTTP，API Key 会以明文传输；仅建议用于可信内网或已确认安全的兼容服务。</span></div>}</section>
        <section className="settings-card"><div className="settings-card-title"><div className="settings-icon reasoning-icon">✦</div><div><h2>Reasoning</h2><p>使用 OpenAI Responses API 的 reasoning.effort 协议。</p></div></div><div className="reasoning-options">{levels.map((level) => <button type="button" key={level.value} className={`reasoning-option ${thinkingLevel === level.value ? 'selected' : ''}`} onClick={() => { setThinkingLevel(level.value); setDirty(true); setMessage(''); }} disabled={!!busy}><span>{level.label}</span><small>{level.description}</small></button>)}</div><div className="settings-info"><ShieldCheck size={15} /><span>关闭时不发送 reasoning 参数；其他级别会映射为对应的 <code>reasoning.effort</code>。应用不会展示隐藏思维链。</span></div></section>
        <div className="settings-actions"><div aria-live="polite">{error ? <span className="error-text">{error}</span> : message ? <span className="success-text"><Check size={15} />{message}</span> : dirty ? <span className="settings-unsaved">有修改尚未保存</span> : null}</div><div><button className="secondary-action" onClick={testConnection} disabled={!api || !!busy || !settings?.configured || dirty}><Network size={15} />测试连接</button><button className="primary-action" onClick={save} disabled={!api || !!busy || !dirty || !modelId.trim() || !baseUrl.trim()}>{busy ? <><LoaderCircle size={16} className="spin" />{busy}</> : <><Save size={16} />保存设置</>}</button></div></div>
      </div>
      <aside className="settings-side"><div className={`connection-card ${settings?.configured ? 'configured' : ''}`}><div className="connection-status-dot" /><strong>{settings?.configured ? 'OpenAI 已配置' : '尚未配置 Provider'}</strong><p>{settings?.configured ? '可以开始测试连接。' : '完成配置后，Agent 才能开始工作。'}</p>{settings?.configured && <dl><div><dt>模型</dt><dd>{settings.modelId}</dd></div><div><dt>地址</dt><dd>{settings.baseUrl.replace(/^https?:\/\//, '')}</dd></div><div><dt>Reasoning</dt><dd>{settings.thinkingLevel}</dd></div></dl>}</div><div className="settings-side-note"><ShieldCheck size={15} /><div><strong>你的 Key 留在本机</strong><p>API Key 使用 macOS 安全存储加密。renderer、项目材料和日志都不会拿到原始值。</p></div></div>{settings?.configured && <button className="danger-button" onClick={clearCredential} disabled={!!busy}><Trash2 size={15} />清除 API Key</button>}{settings?.lastTest && <div className={`last-test ${settings.lastTest.status === 'success' ? 'success' : 'failure'}`}><span>{resultLabel(settings.lastTest)}</span><small>{new Date(settings.lastTest.testedAt).toLocaleString('zh-CN')}</small></div>}</aside>
    </div>
  </section>;
}
