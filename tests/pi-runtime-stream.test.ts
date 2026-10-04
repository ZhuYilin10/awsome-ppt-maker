import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AiSettingsStore } from '../src/main/ai-settings-store';
import { PiRuntime, type AgentRequestTiming } from '../src/main/pi-runtime';

const apiKey = 'local-credential-without-standard-prefix';
type Payload = { input: unknown; reasoning?: { effort?: string }; max_output_tokens?: number };
type Respond = (response: ServerResponse, send: (event: unknown) => void) => void;

async function fixture(t: TestContext, respond: Respond) {
  const root = await mkdtemp(join(tmpdir(), 'ppt-runtime-stream-'));
  const requests: Payload[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    respond(response, (event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
  });
  const settings = new AiSettingsStore(root, { encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) });
  const runtime = new PiRuntime(root, settings);
  t.after(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await runtime.initialize();
  assert.equal(runtime.status().runtimeReady, true, runtime.status().error);
  await runtime.save({ provider: 'openai', apiKey, baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'gpt-test', thinkingLevel: 'off' });
  return { root, requests, runtime, settings };
}

function assertFinished(timings: AgentRequestTiming[], outcome: AgentRequestTiming['outcome'], firstEvent = true) {
  assert.deepEqual(timings.map((timing) => timing.phase), ['started', 'finished']);
  const finished = timings.at(-1)!;
  assert.equal(finished.outcome, outcome);
  assert.ok(finished.completedAt);
  assert.ok(finished.totalMs! >= 0);
  assert.equal(finished.requestId, 1);
  if (firstEvent) {
    assert.ok(finished.firstResponseAt);
    assert.ok(finished.timeToFirstEventMs! <= finished.totalMs!);
    assert.equal(timings[0].firstResponseAt, undefined, 'previously emitted snapshots are immutable');
  }
  return finished;
}

test('hard deadline stops an SSE stream that remains alive after response.created', { timeout: 15_000 }, async (t) => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
  let heartbeats = 0;
  const { root, runtime, requests } = await fixture(t, (response, send) => {
    send({ type: 'response.created', response: { id: 'stall', status: 'in_progress' } });
    const heartbeat = setInterval(() => { heartbeats++; response.write(': still alive\n\n'); }, 10);
    response.on('close', () => { clearInterval(heartbeat); closed(); });
  });
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Test streaming deadlines.', [], { requestTimeoutMs: 350, onRequestTiming: (timing) => timings.push(timing) });
  const started = Date.now();
  await agent.session.prompt('测试输入 🌏', { expandPromptTemplates: false });
  assert.ok(Date.now() - started < 2_000, 'request must terminate independently of SSE EOF or heartbeat traffic');
  assert.ok(heartbeats > 0);
  const finished = assertFinished(timings, 'timeout');
  assert.ok(finished.totalMs! >= 300);
  assert.match(finished.error!, /timed out/);
  assert.equal(finished.providerStatus, 'in_progress');
  assert.equal(finished.inputBytes, Buffer.byteLength(JSON.stringify(requests[0].input), 'utf8'));
  const message = agent.session.messages.at(-1)!;
  assert.equal(message.role, 'assistant');
  assert.equal('stopReason' in message && message.stopReason, 'error');
  assert.deepEqual(agent.diagnostics.outcome, 'timeout');
  await Promise.race([connectionClosed, delay(1_000).then(() => assert.fail('upstream transport was not aborted'))]);
  agent.release();
});

test('caller cancellation terminates a live SSE stream and is not reported as timeout', { timeout: 15_000 }, async (t) => {
  const { root, runtime } = await fixture(t, (_response, send) => {
    send({ type: 'response.created', response: { id: 'cancel', status: 'in_progress' } });
  });
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Test cancellation.', [], { requestTimeoutMs: 500, onRequestTiming: (timing) => timings.push(timing) });
  let first!: () => void;
  const firstEvent = new Promise<void>((resolve) => { first = resolve; });
  const originalEvent = agent.session.agent.onProviderStreamEvent;
  agent.session.agent.onProviderStreamEvent = async (data, model) => { await originalEvent?.(data, model); first(); };
  const prompt = agent.session.prompt('Cancel this response.', { expandPromptTemplates: false });
  await firstEvent;
  await agent.session.abort();
  await prompt;
  const finished = assertFinished(timings, 'cancelled');
  assert.match(finished.error!, /cancelled/);
  const message = agent.session.messages.at(-1)!;
  assert.equal('stopReason' in message && message.stopReason, 'aborted');
  await delay(550);
  assert.equal(timings.filter((timing) => timing.phase === 'finished').length, 1, 'deadline timer must be cleaned up on cancellation');
  agent.release();
});

test('successful requests preserve provider usage, UTF-8 size, local IDs, and temporary thinking overrides', { timeout: 15_000 }, async (t) => {
  const { root, runtime, requests, settings } = await fixture(t, (response, send) => {
    const item = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    send({ type: 'response.created', response: { id: 'ok', status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'ok', status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45, input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 5 } } } });
    response.end();
  });
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Return OK.', [], { requestTimeoutMs: 300, thinkingLevel: 'low', onRequestTiming: (timing) => timings.push(timing) });
  await agent.session.prompt('中文 🌏', { expandPromptTemplates: false });
  const finished = assertFinished(timings, 'completed');
  assert.deepEqual([finished.inputTokens, finished.outputTokens, finished.reasoningTokens, finished.cacheReadTokens, finished.cacheWriteTokens, finished.totalTokens], [30, 15, 5, 7, 3, 45]);
  assert.equal(finished.reasoning, 'low');
  assert.equal(requests[0].reasoning?.effort, 'low');
  assert.equal(requests[0].max_output_tokens, 32_768);
  assert.equal(finished.inputBytes, Buffer.byteLength(JSON.stringify(requests[0].input)));
  assert.ok(finished.inputBytes! > JSON.stringify(requests[0].input).length);
  assert.equal(settings.current().thinkingLevel, 'off');
  assert.deepEqual(finished.outputTypes, ['message']);
  assert.equal(finished.providerStatus, 'completed');
  await agent.session.prompt('Second request.', { expandPromptTemplates: false });
  assert.equal(timings.at(-1)!.requestId, 2);
  assert.equal(timings.at(-1)!.outcome, 'completed');
  agent.release();
  const nextTimings: AgentRequestTiming[] = [];
  const next = await runtime.createAnalysisSession(root, 'Return OK.', [], { onRequestTiming: (timing) => nextTimings.push(timing) });
  await next.session.prompt('Another session.', { expandPromptTemplates: false });
  assert.equal(nextTimings.at(-1)!.requestId, 1);
  assert.equal(requests[2].reasoning, undefined, 'thinking override does not affect the next session');
  await delay(350);
  assert.equal(timings.filter((timing) => timing.phase === 'finished').length, 2, 'successful requests clean up their timers');
  next.release();
});

test('provider errors and EOF without completed emit sanitized terminal telemetry', { timeout: 15_000 }, async (t) => {
  let failed = true;
  const { root, runtime } = await fixture(t, (response, send) => {
    send({ type: 'response.created', response: { id: 'error', status: 'in_progress' } });
    if (failed) send({ type: 'response.failed', response: { id: 'error', status: 'failed', error: { code: 'bad_request', message: `Echoed credential ${apiKey}, Bearer credential-secret, sk-unrelated-secret` }, usage: { input_tokens: 9, output_tokens: 2 } } });
    response.end();
  });
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Return OK.', [], { requestTimeoutMs: 500, onRequestTiming: (timing) => timings.push(timing) });
  await agent.session.prompt('Fail safely.', { expandPromptTemplates: false });
  const finished = assertFinished(timings, 'error');
  assert.equal(finished.providerStatus, 'failed');
  assert.equal(finished.inputTokens, 9);
  assert.equal(finished.outputTokens, 2);
  assert.match(finished.error!, /REDACTED/);
  const persisted = JSON.stringify({ timings, diagnostics: agent.diagnostics, messages: agent.session.messages });
  for (const secret of [apiKey, 'credential-secret', 'sk-unrelated-secret']) assert.equal(persisted.includes(secret), false);
  failed = false;
  await agent.session.prompt('EOF early.', { expandPromptTemplates: false });
  assert.equal(timings.at(-1)!.outcome, 'error');
  assert.match(timings.at(-1)!.error!, /terminal response event/);
  assert.equal(agent.diagnostics.providerStatus, 'in_progress');
  assert.equal(agent.diagnostics.inputTokens, 0, 'failed request usage does not leak into the next request');
  agent.release();
});

test('pre-aborted direct stream resolves protocol error and leaves no cancellation listener', { timeout: 15_000 }, async (t) => {
  const { root, runtime, requests } = await fixture(t, () => assert.fail('pre-aborted stream must not reach provider'));
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Return OK.', [], { requestTimeoutMs: 100, onRequestTiming: (timing) => { timings.push(timing); throw new Error('observer failure'); } });
  const controller = new AbortController();
  controller.abort(apiKey);
  const stream = await agent.session.agent.streamFunction(agent.session.agent.state.model, { messages: [] }, { signal: controller.signal });
  const events = []; for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'aborted');
  assert.equal(events.at(-1)!.type, 'error');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertFinished(timings, 'cancelled', false);
  assert.equal(JSON.stringify(timings).includes(apiKey), false);
  assert.equal(requests.length, 0);
  await delay(150);
  assert.equal(timings.length, 2);
  agent.release();
});

test('deadline before the first SSE event still resolves result and removes the caller listener', { timeout: 15_000 }, async (t) => {
  const { root, runtime, requests } = await fixture(t, (response) => { response.flushHeaders(); });
  const timings: AgentRequestTiming[] = [];
  const agent = await runtime.createAnalysisSession(root, 'Return OK.', [], { requestTimeoutMs: 150, onRequestTiming: (timing) => timings.push(timing) });
  const controller = new AbortController();
  const stream = await agent.session.agent.streamFunction(agent.session.agent.state.model, {
    messages: [{ role: 'user', content: 'Never receive an event.', timestamp: Date.now() }],
  }, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage!, /timed out/);
  const finished = assertFinished(timings, 'timeout', false);
  assert.equal(finished.firstResponseAt, undefined);
  assert.equal(finished.timeToFirstEventMs, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(controller.signal.aborted, false, 'deadline must not abort the caller signal');
  assert.equal(requests.length, 1);
  controller.abort();
  await delay(180);
  assert.equal(timings.length, 2, 'caller abort after terminal does not produce a second finished record');
  agent.release();
});
