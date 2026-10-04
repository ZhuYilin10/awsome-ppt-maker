import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiModelOption, AiRuntimeStatus, AiSettingsInput, AiSettingsSnapshot, ConnectionTestResult, ThinkingLevel } from '../shared/ai';
import { AiSettingsStore, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL, validateAiSettings, validateBaseUrl } from './ai-settings-store';

const PROVIDER_ID = 'ppt-openai';
const MODEL_CONTEXT_WINDOW = 200_000;
const MODEL_MAX_TOKENS = 32_768;
const AGENT_REQUEST_TIMEOUT_MS = 120_000;
const thinkingLevelMap = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
} as const;

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type CompleteOptions = { reasoning?: Exclude<ThinkingLevel, 'off'>; signal?: AbortSignal; timeoutMs?: number };
export type AgentRequestTiming = {
  phase: 'started' | 'finished';
  requestId: number;
  startedAt: string;
  firstResponseAt?: string;
  completedAt?: string;
  totalMs?: number;
  timeToFirstEventMs?: number;
  providerStatus?: string;
  incompleteReason?: string;
  outputTypes?: string[];
  outputTokens?: number;
  reasoning?: string;
  toolCount?: number;
  imageCount?: number;
  inputBytes?: number;
};

function loadPiSdk(): Promise<PiSdk> {
  // The Electron main bundle is CommonJS while Pi is ESM-only.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PiSdk>;
  return dynamicImport('@earendil-works/pi-coding-agent');
}

function redact(message: string) {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|authorization|token|secret)(["'\s:=]+)[^\s,;"']+/gi, '$1$2[REDACTED]');
}

function classifyError(cause: unknown): ConnectionTestResult['status'] {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/401|403|auth|credential|api key|unauthorized/i.test(message)) return 'auth-error';
  if (/404|model|unknown provider|not found/i.test(message)) return 'model-error';
  if (/fetch|network|timeout|ECONN|ENOTFOUND|socket/i.test(message)) return 'network-error';
  return 'error';
}

export class PiRuntime {
  private sdk?: PiSdk;
  private runtime?: ModelRuntime;
  private initializationError?: string;
  private currentSnapshot: AiSettingsSnapshot;
  private readonly sessions = new Set<AgentSession>();

  constructor(private readonly root: string, private readonly store: AiSettingsStore) {
    this.currentSnapshot = store.snapshot(false);
  }

  async initialize() {
    try {
      this.sdk = await loadPiSdk();
      // Pi's default AuthStorage persists API keys to auth.json. Credentials
      // are owned by Electron safeStorage instead, so Pi receives an
      // intentionally ephemeral credential store.
      const ephemeralCredentials = {
        read: async () => undefined,
        list: async () => [],
        modify: async (_providerId: string, update: (current: undefined) => Promise<unknown>) => update(undefined),
        delete: async () => undefined,
      } as any;
      this.runtime = await this.sdk.ModelRuntime.create({
        credentials: ephemeralCredentials,
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      // Remove the file produced by pre-secure-storage development builds.
      await rm(join(this.root, 'pi-auth.json'), { force: true });
      if (this.store.current().configured && this.store.getApiKey()) {
        await this.applySettings(this.store.current(), this.store.getApiKey());
      }
    } catch (cause) {
      this.initializationError = redact(cause instanceof Error ? cause.message : String(cause));
    }
    return this.status();
  }

  status(): AiRuntimeStatus {
    const current = this.store.current();
    return {
      configured: current.configured,
      runtimeReady: Boolean(this.runtime && !this.initializationError),
      provider: 'openai',
      modelId: current.modelId,
      thinkingLevel: current.thinkingLevel,
      error: this.initializationError,
    };
  }

  async getSettings() {
    this.currentSnapshot = this.store.snapshot(Boolean(this.runtime && !this.initializationError));
    return this.currentSnapshot;
  }

  async save(input: AiSettingsInput) {
    if (this.sessions.size) throw new Error('材料分析中，请结束分析后修改 AI 设置。');
    const normalized = validateAiSettings(input);
    await this.requireRuntime();
    const previousKey = this.store.getApiKey();
    const hasKey = Boolean(normalized.apiKey || previousKey);
    if (!hasKey) throw new Error('请填写 OpenAI API Key。');
    await this.applySettings(normalized, normalized.apiKey || previousKey);
    await this.store.save(normalized, hasKey);
    this.currentSnapshot = this.store.snapshot(true);
    return this.currentSnapshot;
  }

  async fetchModels(input: AiSettingsInput): Promise<AiModelOption[]> {
    if (!input || input.provider !== 'openai') throw new Error('目前只支持 OpenAI Provider。');
    const baseUrl = validateBaseUrl(input.baseUrl);
    const apiKey = input.apiKey || this.store.getApiKey();
    if (!apiKey) throw new Error('请填写 OpenAI API Key 后再拉取模型列表。');
    if (apiKey.length < 10 || apiKey.length > 500) throw new Error('API Key 长度无效。');

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new Error(`模型列表请求失败：${redact(cause instanceof Error ? cause.message : String(cause))}`);
    }
    if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）。`);

    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('模型列表响应不是有效 JSON。'); }
    const rawModels = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && 'data' in payload && Array.isArray(payload.data) ? payload.data : payload && typeof payload === 'object' && 'models' in payload && Array.isArray(payload.models) ? payload.models : [];
    const models: AiModelOption[] = [];
    const seen = new Set<string>();
    for (const item of rawModels) {
      const id = typeof item === 'string' ? item : item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? item.id : '';
      if (!id || seen.has(id) || id.length > 160) continue;
      seen.add(id);
      models.push({ id, name: typeof item === 'object' && item && 'name' in item && typeof item.name === 'string' ? item.name : id });
    }
    if (!models.length) throw new Error('模型列表为空，或响应中没有可识别的模型 ID。');
    return models.sort((left, right) => left.id.localeCompare(right.id));
  }

  async clearCredential() {
    if (this.sessions.size) throw new Error('材料分析中，请结束分析后清除凭据。');
    await this.requireRuntime();
    await this.runtime!.removeRuntimeApiKey(PROVIDER_ID);
    await this.store.clear();
    this.currentSnapshot = this.store.snapshot(true);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const testedAt = new Date().toISOString();
    try {
      await this.requireRuntime();
      const settings = this.store.current();
      if (!settings.configured || !this.store.getApiKey()) throw new Error('尚未配置 OpenAI API Key。');
      const model = this.runtime!.getModel(PROVIDER_ID, settings.modelId);
      if (!model) throw new Error(`模型 ${settings.modelId} 不存在或尚未注册。`);
      if (settings.thinkingLevel !== 'off' && !model.reasoning) throw new Error(`模型 ${settings.modelId} 不支持 reasoning。`);
      const response = await this.runtime!.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      }, {
        reasoning: settings.thinkingLevel === 'off' ? undefined : settings.thinkingLevel as Exclude<ThinkingLevel, 'off'>,
        timeoutMs: 30_000,
      } as CompleteOptions);
      if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage || '模型没有成功完成请求。');
      if (response.stopReason === 'length' || !response.content.some((item) => item.type === 'text' && item.text.trim())) throw new Error('模型未返回有效测试文本，请检查服务输出预算或兼容性。');
      const result: ConnectionTestResult = { status: 'success', testedAt, message: 'OpenAI Responses reasoning 连接成功。' };
      await this.store.setTest(result);
      return result;
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      const result: ConnectionTestResult = { status: classifyError(cause), testedAt, message: redact(raw).slice(0, 300) };
      await this.store.setTest(result);
      return result;
    }
  }

  async dispose() {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    this.runtime = undefined;
    this.sdk = undefined;
  }

  safeError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const key = this.store.getApiKey();
    return redact(key ? message.split(key).join('[REDACTED]') : message).slice(0, 500);
  }

  async createAnalysisSession(cwd: string, systemPrompt: string, customTools: ToolDefinition[], hooks: { onRequestTiming?: (timing: AgentRequestTiming) => void } = {}) {
    await this.requireRuntime();
    const settings = this.store.current();
    if (!settings.configured || !this.store.getApiKey()) throw new Error('请先在设置中配置 AI，再开始分析。');
    const model = this.runtime!.getModel(PROVIDER_ID, settings.modelId);
    if (!model) throw new Error('当前模型未注册，请检查 AI 设置。');
    const sdk = this.sdk!;
    const { session } = await sdk.createAgentSession({
      cwd, agentDir: cwd, modelRuntime: this.runtime!, model,
      thinkingLevel: settings.thinkingLevel,
      noTools: 'all',
      tools: customTools.map((tool) => tool.name), customTools,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      },
    });
    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (streamModel, context, options) => originalStream(streamModel, context, { ...options, maxTokens: MODEL_MAX_TOKENS, timeoutMs: AGENT_REQUEST_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0 });
    const diagnostics: { maxOutputTokens?: number; toolCount?: number; reasoning?: string; providerStatus?: string; incompleteReason?: string; outputTypes?: string[]; outputTokens?: number } = {};
    let requestId = 0;
    let activeRequest: AgentRequestTiming | undefined;
    const countImages = (value: unknown): number => {
      if (Array.isArray(value)) return value.reduce((count, item) => count + countImages(item), 0);
      if (!value || typeof value !== 'object') return 0;
      return ('type' in value && value.type === 'input_image' ? 1 : 0) + Object.values(value).reduce((count, item) => count + countImages(item), 0);
    };
    const originalPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, requestModel) => {
      const value = payload as { max_output_tokens?: number; tools?: unknown[]; reasoning?: { effort?: string } };
      const startedAt = new Date().toISOString();
      activeRequest = { phase: 'started', requestId: ++requestId, startedAt, reasoning: value.reasoning?.effort, toolCount: value.tools?.length, imageCount: countImages(payload), inputBytes: JSON.stringify((payload as { input?: unknown }).input ?? '').length };
      hooks.onRequestTiming?.(activeRequest);
      diagnostics.maxOutputTokens = value.max_output_tokens;
      diagnostics.toolCount = value.tools?.length;
      diagnostics.reasoning = value.reasoning?.effort;
      return originalPayload?.(payload, requestModel);
    };
    const originalEvent = session.agent.onProviderStreamEvent;
    session.agent.onProviderStreamEvent = async (data, requestModel) => {
      const event = data as { type?: string; response?: { status?: string; incomplete_details?: { reason?: string }; output?: Array<{ type?: string }>; usage?: { output_tokens?: number } } };
      if (activeRequest && !activeRequest.firstResponseAt) {
        activeRequest.firstResponseAt = new Date().toISOString();
        activeRequest.timeToFirstEventMs = Date.parse(activeRequest.firstResponseAt) - Date.parse(activeRequest.startedAt);
      }
      if (activeRequest && (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')) {
        diagnostics.providerStatus = event.response?.status;
        diagnostics.incompleteReason = event.response?.incomplete_details?.reason;
        diagnostics.outputTypes = event.response?.output?.map((item) => item.type ?? 'unknown');
        diagnostics.outputTokens = event.response?.usage?.output_tokens;
        const completedAt = new Date().toISOString();
        const finished: AgentRequestTiming = { ...activeRequest, phase: 'finished', completedAt, totalMs: Date.parse(completedAt) - Date.parse(activeRequest.startedAt), providerStatus: event.response?.status, incompleteReason: event.response?.incomplete_details?.reason, outputTypes: event.response?.output?.map((item) => item.type ?? 'unknown'), outputTokens: event.response?.usage?.output_tokens };
        hooks.onRequestTiming?.(finished);
        activeRequest = undefined;
      }
      await originalEvent?.(data, requestModel);
    };
    this.sessions.add(session);
    return { session, diagnostics, release: () => { session.dispose(); this.sessions.delete(session); } };
  }

  private async requireRuntime() {
    if (!this.runtime) {
      await this.initialize();
    }
    if (!this.runtime) throw new Error(this.initializationError ?? 'Pi Runtime 尚未就绪。');
  }

  private async applySettings(settings: { baseUrl: string; modelId: string; thinkingLevel: ThinkingLevel }, apiKey?: string) {
    if (!this.runtime) throw new Error('Pi Runtime 尚未就绪。');
    this.runtime.registerProvider(PROVIDER_ID, {
      name: 'OpenAI',
      baseUrl: settings.baseUrl || DEFAULT_OPENAI_BASE_URL,
      api: 'openai-responses',
      models: [{
        id: settings.modelId || DEFAULT_OPENAI_MODEL,
        name: settings.modelId || DEFAULT_OPENAI_MODEL,
        api: 'openai-responses',
        input: ['text', 'image'],
        reasoning: settings.thinkingLevel !== 'off',
        thinkingLevelMap,
        contextWindow: MODEL_CONTEXT_WINDOW,
        maxTokens: MODEL_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: true },
      }],
    });
    if (apiKey) await this.runtime.setRuntimeApiKey(PROVIDER_ID, apiKey);
  }
}
