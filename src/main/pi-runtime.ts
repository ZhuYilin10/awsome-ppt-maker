import type { AgentSession, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Buffer } from 'node:buffer';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiModelOption, AiRuntimeStatus, AiSettingsInput, AiSettingsSnapshot, ConnectionTestResult, ThinkingLevel } from '../shared/ai';
import { AiSettingsStore, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL, validateAiSettings, validateBaseUrl } from './ai-settings-store';

const PROVIDER_ID = 'ppt-openai';
const MODEL_CONTEXT_WINDOW = 200_000;
const MODEL_MAX_TOKENS = 32_768;
const AGENT_REQUEST_TIMEOUT_MS = 240_000;
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
  inputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  outcome?: 'completed' | 'error' | 'cancelled' | 'timeout';
  error?: string;
  reasoning?: string;
  toolCount?: number;
  imageCount?: number;
  inputBytes?: number;
};

export type AnalysisSessionHooks = {
  onRequestTiming?: (timing: AgentRequestTiming) => void;
  requestTimeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
};

function loadPiSdk(): Promise<PiSdk> {
  // The Electron main bundle is CommonJS while Pi is ESM-only.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PiSdk>;
  return dynamicImport('@earendil-works/pi-coding-agent');
}

function redact(message: string) {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
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
    try {
      await this.applySettings(normalized, normalized.apiKey || previousKey);
      await this.store.save(normalized, hasKey);
    } catch (cause) {
      throw new Error(`AI 设置保存失败：${this.safeError(cause, [normalized.apiKey ?? '', previousKey ?? ''])}`);
    }
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

  safeError(cause: unknown, extraSecrets: string[] = []) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const errorSecrets = cause && typeof cause === 'object' ? [
      'credential' in cause ? String((cause as { credential?: unknown }).credential ?? '') : '',
      'apiKey' in cause ? String((cause as { apiKey?: unknown }).apiKey ?? '') : '',
    ] : [];
    const secrets = [this.store.getApiKey(), ...extraSecrets, ...errorSecrets].filter((value): value is string => Boolean(value && value.length >= 4)).sort((a, b) => b.length - a.length);
    return redact(secrets.reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), message)).slice(0, 500);
  }

  async createAnalysisSession(cwd: string, systemPrompt: string, customTools: ToolDefinition[], hooks: AnalysisSessionHooks = {}) {
    const requestTimeoutMs = hooks.requestTimeoutMs ?? AGENT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 2_147_483_647) throw new Error('请求超时必须为有效的正毫秒数。');
    await this.requireRuntime();
    const settings = this.store.current();
    if (!settings.configured || !this.store.getApiKey()) throw new Error('请先在设置中配置 AI，再开始分析。');
    const registeredModel = this.runtime!.getModel(PROVIDER_ID, settings.modelId);
    if (!registeredModel) throw new Error('当前模型未注册，请检查 AI 设置。');
    const thinkingLevel = hooks.thinkingLevel ?? settings.thinkingLevel;
    const model = hooks.thinkingLevel === undefined ? registeredModel : { ...registeredModel, reasoning: thinkingLevel !== 'off' };
    const importStreams = new Function('return import("@earendil-works/pi-ai")') as () => Promise<typeof import('@earendil-works/pi-ai')>;
    const { createAssistantMessageEventStream } = await importStreams();
    const sdk = this.sdk!;
    const { session } = await sdk.createAgentSession({
      cwd, agentDir: cwd, modelRuntime: this.runtime!, model,
      thinkingLevel,
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
    const diagnostics: Partial<AgentRequestTiming> & { maxOutputTokens?: number } = {};
    let requestId = 0;
    const pendingRequests = new Set<() => void>();
    const countImages = (value: unknown): number => {
      if (Array.isArray(value)) return value.reduce((count, item) => count + countImages(item), 0);
      if (!value || typeof value !== 'object') return 0;
      return ('type' in value && value.type === 'input_image' ? 1 : 0) + Object.values(value).reduce((count, item) => count + countImages(item), 0);
    };
    const safeString = (value: unknown) => typeof value === 'string' ? this.safeError(value) : undefined;
    const tokenCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    session.agent.streamFunction = (streamModel, context, options) => {
      const stream = createAssistantMessageEventStream();
      const started = Date.now();
      const timing: AgentRequestTiming = { phase: 'started', requestId: ++requestId, startedAt: new Date(started).toISOString() };
      let terminal = false;
      let startedEmitted = false;
      let partial: AssistantMessage = {
        role: 'assistant', content: [], api: streamModel.api, provider: streamModel.provider, model: streamModel.id,
        stopReason: 'pending', timestamp: started,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const deadlineController = new AbortController();
      const requestSignal = options?.signal ? AbortSignal.any([options.signal, deadlineController.signal]) : deadlineController.signal;
      const emit = (phase: AgentRequestTiming['phase']) => {
        const snapshot = { ...timing, phase, outputTypes: timing.outputTypes?.slice() };
        Object.assign(diagnostics, snapshot);
        try { hooks.onRequestTiming?.(snapshot); } catch { /* Telemetry cannot interrupt the request. */ }
      };
      const emitStarted = () => { if (!startedEmitted) { startedEmitted = true; emit('started'); } };
      const firstEvent = () => {
        if (timing.firstResponseAt || terminal) return;
        emitStarted();
        timing.firstResponseAt = new Date().toISOString();
        timing.timeToFirstEventMs = Date.now() - started;
      };
      const finish = (message: AssistantMessage, outcome: NonNullable<AgentRequestTiming['outcome']>) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', cancel);
        pendingRequests.delete(cancel);
        emitStarted();
        timing.completedAt = new Date().toISOString();
        timing.totalMs = Date.now() - started;
        timing.outcome = outcome;
        timing.error = safeString(message.errorMessage);
        // Provider input_tokens includes cache tokens; Pi's normalized usage.input excludes them.
        timing.inputTokens ??= tokenCount(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite);
        timing.outputTokens ??= tokenCount(message.usage.output);
        timing.reasoningTokens ??= tokenCount(message.usage.reasoning);
        timing.cacheReadTokens ??= tokenCount(message.usage.cacheRead);
        timing.cacheWriteTokens ??= tokenCount(message.usage.cacheWrite);
        timing.totalTokens ??= tokenCount(message.usage.totalTokens);
        emit('finished');
      };
      const fail = (cause: unknown, outcome: 'error' | 'cancelled' | 'timeout') => {
        if (terminal) return;
        const reason = outcome === 'cancelled' ? 'aborted' : 'error';
        const error: AssistantMessage = { ...partial, stopReason: reason, errorMessage: this.safeError(cause) };
        finish(error, outcome);
        stream.push({ type: 'error', reason, error });
        stream.end();
      };
      const cancel = () => {
        fail('Request cancelled.', 'cancelled');
        deadlineController.abort('Request cancelled.');
      };
      const timer = setTimeout(() => {
        fail(`Request timed out after ${requestTimeoutMs} ms.`, 'timeout');
        deadlineController.abort('Request timed out.');
      }, requestTimeoutMs);
      pendingRequests.add(cancel);
      options?.signal?.addEventListener('abort', cancel, { once: true });
      // Reset the latest-request diagnostics rather than carrying usage/errors from a previous turn.
      for (const key of Object.keys(diagnostics)) delete diagnostics[key as keyof typeof diagnostics];
      if (options?.signal?.aborted) cancel();
      void (async () => {
        if (terminal) return;
        try {
          const upstream = await originalStream(streamModel, context, {
            ...options, signal: requestSignal, maxTokens: MODEL_MAX_TOKENS, timeoutMs: requestTimeoutMs, maxRetries: 0, maxRetryDelayMs: 0,
            onPayload: async (payload, requestModel) => {
              if (terminal) return;
              const replacement = await options?.onPayload?.(payload, requestModel);
              if (terminal) return replacement;
              const value = (replacement ?? payload) as { max_output_tokens?: number; tools?: unknown[]; reasoning?: { effort?: string }; input?: unknown };
              timing.reasoning = safeString(value.reasoning?.effort);
              timing.toolCount = value.tools?.length;
              timing.imageCount = countImages(value);
              timing.inputBytes = Buffer.byteLength(JSON.stringify(value.input ?? ''), 'utf8');
              diagnostics.maxOutputTokens = tokenCount(value.max_output_tokens);
              emitStarted();
              return replacement;
            },
            onProviderStreamEvent: async (data, requestModel) => {
              if (terminal) return;
              firstEvent();
              const event = data as { response?: { status?: string; incomplete_details?: { reason?: string }; output?: Array<{ type?: string }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } } };
              const response = event.response;
              if (response) {
                timing.providerStatus = safeString(response.status) ?? timing.providerStatus;
                timing.incompleteReason = safeString(response.incomplete_details?.reason) ?? timing.incompleteReason;
                timing.outputTypes = response.output?.map((item) => safeString(item.type) ?? 'unknown') ?? timing.outputTypes;
                timing.inputTokens = tokenCount(response.usage?.input_tokens) ?? timing.inputTokens;
                timing.outputTokens = tokenCount(response.usage?.output_tokens) ?? timing.outputTokens;
                timing.totalTokens = tokenCount(response.usage?.total_tokens) ?? timing.totalTokens;
                timing.reasoningTokens = tokenCount(response.usage?.output_tokens_details?.reasoning_tokens) ?? timing.reasoningTokens;
                timing.cacheReadTokens = tokenCount(response.usage?.input_tokens_details?.cached_tokens) ?? timing.cacheReadTokens;
                timing.cacheWriteTokens = tokenCount(response.usage?.input_tokens_details?.cache_write_tokens) ?? timing.cacheWriteTokens;
              }
              await options?.onProviderStreamEvent?.(data, requestModel);
            },
          });
          for await (const event of upstream) {
            if (terminal) break;
            if (event.type === 'done' || event.type === 'error') {
              const message = event.type === 'done' ? event.message : event.error;
              message.errorMessage = safeString(message.errorMessage);
              const outcome = message.stopReason === 'aborted' ? 'cancelled' : message.stopReason === 'error' ? 'error' : 'completed';
              finish(message, outcome);
              stream.push(event);
              stream.end();
              break;
            } else {
              partial = event.partial;
              // Pi emits a synthetic start before any network response; do not count it as the first event.
              if (event.type !== 'start') firstEvent();
              if (partial.errorMessage) partial.errorMessage = safeString(partial.errorMessage);
              stream.push(event);
            }
          }
          if (!terminal) fail('Provider stream ended without a terminal event.', 'error');
        } catch (cause) { fail(cause, 'error'); }
      })();
      return stream;
    };
    const disposeSession = session.dispose.bind(session);
    session.dispose = () => { for (const cancel of pendingRequests) cancel(); disposeSession(); };
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
