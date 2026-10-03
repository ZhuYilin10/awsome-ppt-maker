import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiSettingsInput, AiSettingsSnapshot, ConnectionTestResult, ThinkingLevel } from '../shared/ai';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'o3-mini';
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

type StoredSettings = Omit<AiSettingsSnapshot, 'runtimeReady'> & { runtimeReady?: boolean };
type SecretCodec = { encrypt(value: string): string; decrypt(value: string): string };

const thinkingLevels = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function validateAiSettings(input: AiSettingsInput) {
  if (!input || input.provider !== 'openai') throw new Error('目前只支持 OpenAI Provider。');
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 500) throw new Error('Base URL 无效。');
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new Error('Base URL 必须是有效的 URL。'); }
  const localDevelopmentUrl = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !localDevelopmentUrl) throw new Error('Base URL 必须使用 HTTPS；本地开发仅允许 localhost。');
  if (typeof input.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.modelId.trim())) throw new Error('Model ID 只能包含字母、数字、点、下划线、冒号、斜线和短横线。');
  if (!thinkingLevels.has(input.thinkingLevel)) throw new Error('Reasoning level 无效。');
  if (input.apiKey !== undefined && input.apiKey !== '' && (input.apiKey.length < 10 || input.apiKey.length > 500)) throw new Error('API Key 长度无效。');
  return { ...input, baseUrl: input.baseUrl.replace(/\/+$/, ''), modelId: input.modelId.trim() };
}

export class AiSettingsStore {
  private readonly path: string;
  private readonly secretPath: string;
  private settings: StoredSettings;
  private apiKey?: string;

  constructor(private readonly root: string, private readonly codec: SecretCodec) {
    this.path = join(root, 'ai-settings.json');
    this.secretPath = join(root, 'ai-credential.bin');
    this.settings = {
      provider: 'openai',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      modelId: DEFAULT_OPENAI_MODEL,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      configured: false,
    };
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredSettings>;
      if (parsed.provider === 'openai' && typeof parsed.baseUrl === 'string' && typeof parsed.modelId === 'string' && thinkingLevels.has(parsed.thinkingLevel as ThinkingLevel)) {
        this.settings = { ...this.settings, ...parsed, runtimeReady: undefined };
      }
      try { this.apiKey = this.codec.decrypt(await readFile(this.secretPath, 'utf8')); } catch { this.apiKey = undefined; }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AI 设置文件损坏，请删除 ai-settings.json 后重新配置。');
    }
    return this.snapshot(false);
  }

  snapshot(runtimeReady: boolean) {
    const { provider, baseUrl, modelId, thinkingLevel, configured, lastTest } = this.settings;
    return { provider, baseUrl, modelId, thinkingLevel, configured, runtimeReady, lastTest } satisfies AiSettingsSnapshot;
  }

  current() { return this.settings; }

  getApiKey() { return this.apiKey; }

  async save(input: AiSettingsInput, configured: boolean) {
    const normalized = validateAiSettings(input);
    this.settings = {
      provider: normalized.provider,
      baseUrl: normalized.baseUrl,
      modelId: normalized.modelId,
      thinkingLevel: normalized.thinkingLevel,
      configured,
      lastTest: undefined,
    };
    if (normalized.apiKey) {
      this.apiKey = normalized.apiKey;
      await this.persistSecret();
    }
    await this.persist();
    return this.snapshot(false);
  }

  async setTest(result: ConnectionTestResult) {
    this.settings.lastTest = result;
    await this.persist();
  }

  async clear() {
    this.apiKey = undefined;
    this.settings.configured = false;
    this.settings.lastTest = undefined;
    await this.persist();
    await rm(this.secretPath, { force: true });
  }

  private async persist() {
    await mkdir(this.root, { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.path);
    await rm(temporaryPath, { force: true });
  }

  private async persistSecret() {
    if (!this.apiKey) return;
    await mkdir(this.root, { recursive: true });
    const temporaryPath = `${this.secretPath}.tmp`;
    await writeFile(temporaryPath, this.codec.encrypt(this.apiKey), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.secretPath);
    await rm(temporaryPath, { force: true });
  }
}
