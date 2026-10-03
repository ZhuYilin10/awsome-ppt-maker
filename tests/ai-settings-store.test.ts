import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AiSettingsStore, DEFAULT_OPENAI_BASE_URL, validateAiSettings } from '../src/main/ai-settings-store';

const codec = { encrypt: (value: string) => `encrypted:${value}`, decrypt: (value: string) => value.replace(/^encrypted:/, '') };

test('validates OpenAI Responses settings without accepting unsafe URLs', () => {
  assert.equal(validateAiSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', modelId: 'o3-mini', thinkingLevel: 'medium' }).baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.throws(() => validateAiSettings({ provider: 'openai', baseUrl: 'http://example.com/v1', modelId: 'o3-mini', thinkingLevel: 'medium' }), /HTTPS/);
  assert.throws(() => validateAiSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'bad model', thinkingLevel: 'medium' }), /Model ID/);
  assert.throws(() => validateAiSettings({ provider: 'anthropic' as 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini', thinkingLevel: 'medium' }), /OpenAI/);
});

test('persists settings separately from encrypted credential and never returns the key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-ai-settings-'));
  try {
    const store = new AiSettingsStore(root, codec);
    await store.load();
    const snapshot = await store.save({ provider: 'openai', apiKey: 'sk-test-secret-value', baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini', thinkingLevel: 'high' }, true);
    assert.equal(snapshot.configured, true);
    assert.equal(JSON.stringify(snapshot).includes('sk-test-secret-value'), false);
    assert.equal(store.getApiKey(), 'sk-test-secret-value');
    const settingsFile = await readFile(join(root, 'ai-settings.json'), 'utf8');
    assert.equal(settingsFile.includes('sk-test-secret-value'), false);
    assert.equal(await readFile(join(root, 'ai-credential.bin'), 'utf8'), 'encrypted:sk-test-secret-value');
    const reopened = new AiSettingsStore(root, codec);
    await reopened.load();
    assert.equal(reopened.getApiKey(), 'sk-test-secret-value');
    await reopened.clear();
    assert.equal(reopened.getApiKey(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
