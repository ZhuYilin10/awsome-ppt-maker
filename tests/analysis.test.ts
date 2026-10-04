import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { authorizedMaterial, inspectImage, readPdf, renderPdf, scanMaterial } from '../src/main/material-reader';
import { createAnalysisTools, validateSubmission } from '../src/main/analysis-tools';
import { ProjectStore } from '../src/main/project-store';
import { AiSettingsStore } from '../src/main/ai-settings-store';
import { PiRuntime } from '../src/main/pi-runtime';
import { AnalysisRunner } from '../src/main/analysis-runner';
import type { ProjectRecord } from '../src/shared/project';

function sample(record: ProjectRecord, runId: string) {
  const id = record.materials[0].id;
  const evidence = [{ materialId: id, pageNumber: 1, note: '读取了主稿第 1 页' }];
  return { runId, summary: '测试分析报告', materials: [{ materialId: id, role: 'primary-deck', roleReason: '用户指定主稿', contentSummary: '测试材料', visualSummary: '视觉未验证', constraints: ['保留内容'], issues: ['模型为本地协议测试服务'], evidence }], representativePages: [{ materialId: id, pageNumber: 1, contentRole: 'cover', visualRole: 'text', reason: '覆盖封面结构', confidence: 'low', evidence }] };
}

test('image long-sheet slicing is bounded and project paths reject symlinks outside the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-image-test-'));
  try {
    const materialRoot = join(root, 'materials'); await mkdir(materialRoot);
    const image = join(materialRoot, 'long.png');
    await sharp({ create: { width: 1200, height: 6847, channels: 3, background: '#fff' } }).png().toFile(image);
    const info = await inspectImage(image, join(root, 'preview.jpg'), 2);
    assert.ok(info.regionCount > 1); assert.equal(info.top, 1640);
    const meta = await sharp(join(root, 'preview.jpg')).metadata(); assert.ok(meta.height! <= 1800);
    await assert.rejects(() => inspectImage(image, join(root, 'bad.jpg'), 500), /越界/);
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'not authorized');
    await symlink(outside, join(materialRoot, 'linked.png'));
    const record = { projectPath: root, materials: [{ id: 'img', localPath: join(materialRoot, 'linked.png') }] } as ProjectRecord;
    await assert.rejects(() => authorizedMaterial(record, 'img'), /目录内/);
    await assert.rejects(() => authorizedMaterial(record, 'unknown'), /不存在/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 42 >>\nstream\nBT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET\nendstream'];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return result;
}

test('PDF.js reads text and renders a real PDF page without external shell utilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-pdf-test-'));
  try {
    const path = join(root, 'fixture.pdf'); await writeFile(path, pdfFixture());
    const result = await readPdf(path); assert.equal(result.pageCount, 1); assert.match(result.pages[0].text, /Hello PDF/);
    const output = join(root, 'page.jpg'); await renderPdf(path, 1, output); assert.ok((await readFile(output)).length > 100);
    await assert.rejects(() => renderPdf(path, 2, output), /越界/);
    await assert.rejects(() => readPdf(path, AbortSignal.abort()), /abort/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Pi Session calls only controlled tools and persists validated report; malformed references fail', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-pi-integration-'));
  const requests: any[] = [];
  let holdResponse = false;
  let record: ProjectRecord;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    if (holdResponse) return;
    const turn = requests.length;
    const runId = /当前运行 ID：([a-f0-9-]+)/.exec(JSON.stringify(payload))?.[1] ?? '';
    const action = turn === 1 ? { name: 'read_material_manifest', args: {} } : turn === 2 ? { name: 'office_read', args: { materialId: record.materials[0].id, mode: 'text' } } : turn === 3 ? { name: 'render_pptx_page', args: { materialId: record.materials[0].id, pageNumber: 1 } } : turn === 4 ? { name: 'submit_analysis', args: sample(record, runId) } : undefined;
    const item = action ? { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: action.name, arguments: JSON.stringify(action.args), status: 'completed' } : { type: 'message', id: `msg_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '报告已完成。', annotations: [] }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: `resp_${turn}` } });
    send({ type: 'response.output_item.added', output_index: 0, item: action ? { ...item, arguments: '' } : item });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: `resp_${turn}`, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 } } });
    response.end();
  });
  const store = new ProjectStore(join(root, 'projects'), join(root, 'projects.sqlite'));
  const settings = new AiSettingsStore(root, { encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) });
  const runtime = new PiRuntime(root, settings);
  try {
    const fixture = join(root, 'main.pptx'); const office = process.env.OFFICECLI_PATH || join(process.env.HOME!, '.local/bin/officecli');
    execFileSync(office, ['create', fixture], { env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' } });
    execFileSync(office, ['add', fixture, '/', '--type', 'slide', '--prop', 'title=测试页面'], { env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' } });
    const files = await store.select([fixture]); record = await store.save({ name: 'Pi 测试', brief: '', materials: [{ ...files[0], purpose: 'primary', note: '' }] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await runtime.initialize(); assert.equal(runtime.status().runtimeReady, true, runtime.status().error);
    await runtime.save({ provider: 'openai', apiKey: 'sk-local-test-only-value', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'gpt-test', thinkingLevel: 'off' });
    const runner = new AnalysisRunner(store, runtime); const events: string[] = [];
    const completed = await runner.run(record.id, (event) => events.push(event.type));
    assert.equal(completed.analysis?.status, 'completed'); assert.ok(events.includes('tool-started')); assert.ok(events.includes('run-completed'));
    assert.equal(requests.length, 5);
    const declared = requests[0].tools.map((tool: any) => tool.name);
    assert.ok(declared.includes('office_read')); assert.ok(!declared.some((name: string) => ['bash', 'edit', 'write', 'read'].includes(name)));
    assert.ok(requests[2].input.some((item: any) => item.type === 'function_call_output'));
    assert.match(JSON.stringify(requests[3].input), /input_image/);
    assert.equal(JSON.stringify(requests[0].tools.find((item: any) => item.name === 'office_get')).includes('pattern'), false);
    assert.equal(JSON.stringify(requests[0].input).includes('sk-local-test-only-value'), false);
    assert.equal((await readFile(join(record.projectPath, 'analysis', 'manifest.json'), 'utf8')).includes('sk-local-test-only-value'), false);
    const storedProject = JSON.parse(await readFile(join(record.projectPath, 'project.json'), 'utf8'));
    assert.equal(storedProject.analysis, undefined);
    assert.equal(storedProject.analysisRef.runId, completed.analysis!.runId);
    const facts = [await scanMaterial(record.materials[0])];
    const bad = sample(record, 'run'); bad.representativePages[0].pageNumber = 100;
    assert.throws(() => validateSubmission(bad, record, facts, 'run'), /代表页/);
    const unknown = sample(record, 'run'); unknown.materials[0].evidence[0].materialId = 'unknown';
    assert.throws(() => validateSubmission(unknown, record, facts, 'run'), /证据/);
    assert.equal((await runner.getRun(record.id))?.status, 'completed');
    const selected = await store.saveRepresentativePages(record.id, [1]);
    assert.deepEqual(selected.representativeSelection?.pageNumbers, [1]);
    await assert.rejects(() => store.saveRepresentativePages(record.id, [2]), /有效/);
    const unchanged = await store.save({ ...selected, materials: selected.materials });
    assert.equal(unchanged.analysis?.runId, completed.analysis?.runId);
    assert.deepEqual(unchanged.representativeSelection?.pageNumbers, [1]);
    runner.start(record.id, () => undefined);
    await runner.cancel(record.id);
    assert.equal((await runner.getRun(record.id))?.status, 'cancelled');
    assert.equal(store.get(record.id).analysis?.runId, completed.analysis?.runId);
    assert.equal(requests.length, 5, 'preflight cancellation must not invoke the provider');
    holdResponse = true;
    let reading!: () => void;
    const readingStarted = new Promise<void>((resolve) => { reading = resolve; });
    runner.start(record.id, (event) => { if (event.snapshot.status === 'agent-reading') reading(); });
    await readingStarted;
    // Cancel after a real provider request has reached the server.
    for (let attempt = 0; attempt < 100 && requests.length === 5; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 6);
    await assert.rejects(() => runtime.clearCredential(), /分析中/);
    await runner.cancel(record.id);
    assert.equal((await runner.getRun(record.id))?.status, 'cancelled');
    assert.equal(store.get(record.id).analysis?.runId, completed.analysis?.runId);
    const snapshot = await runner.getRun(record.id);
    await writeFile(join(record.projectPath, 'analysis', 'latest-run.json'), JSON.stringify({ ...snapshot, status: 'agent-reading' }));
    const recovered = await new AnalysisRunner(store, runtime).getRun(record.id);
    assert.equal(recovered?.status, 'failed'); assert.match(recovered?.error ?? '', /中断/);
    const tools = createAnalysisTools(record, root, facts, 'run', { onSubmit: () => undefined, onTool: () => undefined });
    await assert.rejects(() => tools.find((tool) => tool.name === 'office_get')!.execute('invalid', { materialId: record.materials[0].id, nodePath: '/../../etc/passwd' }, undefined, undefined as any, undefined as any), /路径无效/);
    const changed = await store.save({ ...selected, brief: '新的要求' });
    assert.equal(changed.analysis, undefined); assert.equal(changed.representativeSelection, undefined);
  } finally { await runtime.dispose(); store.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
