import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiRuntimeStatus, AiSettingsInput, AiSettingsSnapshot, ConnectionTestResult, ThinkingLevel } from '../shared/ai';
import { AiSettingsStore, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL, DEFAULT_THINKING_LEVEL, validateAiSettings } from './ai-settings-store';

const PROVIDER_ID = 'ppt-openai';
const MODEL_CONTEXT_WINDOW = 200_000;
const MODEL_MAX_TOKENS = 32_768;
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

  async clearCredential() {
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
      await this.runtime!.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      }, {
        reasoning: settings.thinkingLevel === 'off' ? undefined : settings.thinkingLevel as Exclude<ThinkingLevel, 'off'>,
        timeoutMs: 30_000,
      } as CompleteOptions);
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
    this.runtime = undefined;
    this.sdk = undefined;
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
