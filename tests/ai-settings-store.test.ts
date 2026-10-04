import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { AiSettingsStore, DEFAULT_OPENAI_BASE_URL, validateAiSettings } from '../src/main/ai-settings-store';
import { PiRuntime } from '../src/main/pi-runtime';

const codec = { encrypt: (value: string) => `encrypted:${value}`, decrypt: (value: string) => value.replace(/^encrypted:/, '') };

test('validates OpenAI Responses settings without accepting unsafe URLs', () => {
  assert.equal(validateAiSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', modelId: 'o3-mini', thinkingLevel: 'medium' }).baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.equal(validateAiSettings({ provider: 'openai', baseUrl: 'http://112.124.49.46:3000/v1', modelId: 'gpt-6-sol', thinkingLevel: 'medium' }).baseUrl, 'http://112.124.49.46:3000/v1');
  assert.throws(() => validateAiSettings({ provider: 'openai', baseUrl: 'file:///tmp/models', modelId: 'o3-mini', thinkingLevel: 'medium' }), /HTTP 或 HTTPS/);
  assert.throws(() => validateAiSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'bad model', thinkingLevel: 'medium' }), /Model ID/);
  assert.throws(() => validateAiSettings({ provider: 'anthropic' as 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'o3-mini', thinkingLevel: 'medium' }), /OpenAI/);
});

test('fetches OpenAI-compatible model lists without returning credentials', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer sk-test-secret-value');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'gpt-z' }, { id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-z' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const runtime = new PiRuntime('/tmp/ppt-plan-model-test', new AiSettingsStore('/tmp/ppt-plan-model-test', codec));
    assert.deepEqual(await runtime.fetchModels({ provider: 'openai', apiKey: 'sk-test-secret-value', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: '', thinkingLevel: 'medium' }), [
      { id: 'gpt-a', name: 'GPT A' },
      { id: 'gpt-z', name: 'gpt-z' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  }
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
