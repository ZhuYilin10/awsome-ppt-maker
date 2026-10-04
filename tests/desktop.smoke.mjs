// Real Electron + real filesystem + real OfficeCLI. No renderer IPC mocks.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'ppt-plan-desktop-'));
const office = process.env.OFFICECLI_PATH || join(process.env.HOME, '.local/bin/officecli');
const fixture = join(root, 'sample.pptx');
const reference = join(root, 'reference.pdf');
const env = { ...process.env, OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' };
execFileSync(office, ['create', fixture], { env });
execFileSync(office, ['add', fixture, '/', '--type', 'slide', '--prop', 'title=测试材料入口'], { env });
await writeFile(reference, '%PDF-1.4\n% intake-only test fixture');
const port = 19331;
const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`], {
  env: { ...env, PPT_PLAN_USER_DATA: join(root, 'user-data') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stderr.on('data', (data) => { log += data.toString(); });
child.stdout.on('data', (data) => { log += data.toString(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
const pending = new Map();
let nextId = 1;
const errors = [];
async function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}\n${log}`);
}
async function fill(selector, text) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(text)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}
async function clickText(text) {
  await waitFor(`Boolean([...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)} && !button.disabled))`);
  await evaluate(`(() => {const button = [...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)} && !button.disabled); if(!button) throw new Error('Button unavailable'); button.click();})()`);
}
async function capture(filename) {
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(resolve('.impeccable/review', filename), Buffer.from(image.data, 'base64'));
}
async function assertPinnedActions() {
  const geometry = `(() => {
    const rail = document.querySelector('.setup-aside').getBoundingClientRect();
    const buttons = document.querySelector('.footer-actions').getBoundingClientRect();
    return { railTop: rail.top, railBottom: rail.bottom, buttonsTop: buttons.top, buttonsBottom: buttons.bottom };
  })()`;
  const before = await evaluate(geometry);
  assert.ok(before.buttonsTop >= 0 && before.buttonsBottom <= await evaluate('window.innerHeight'));
  assert.equal(await evaluate("Boolean(document.querySelector('.setup-aside .action-bar'))"), true);
  await evaluate("document.querySelector('.content-scroll').scrollTop = document.querySelector('.content-scroll').scrollHeight");
  assert.ok(await evaluate("document.querySelector('.content-scroll').scrollTop > 0"));
  assert.deepEqual(await evaluate(geometry), before);
  assert.equal(await evaluate('document.documentElement.scrollHeight <= window.innerHeight'), true);
  await evaluate("document.querySelector('.content-scroll').scrollTop = 0");
}
try {
  let page;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === 'page'); if (page) break; } catch {}
    await sleep(100);
  }
  assert.ok(page, log);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error))); else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor("Boolean(window.pptPlan && document.querySelector('#project-name'))");
  const runtime = await evaluate('window.pptPlan.runtimeStatus()');
  assert.equal(runtime.officecli.available, true);
  await clickText('设置');
  await waitFor("Boolean(document.querySelector('.settings-page'))");
  assert.equal(await evaluate('document.documentElement.scrollHeight <= window.innerHeight'), true);
  assert.equal(await evaluate("document.querySelector('.settings-page').scrollHeight > document.querySelector('.settings-page').clientHeight"), true);
  assert.equal(await evaluate("document.querySelector('.provider-choice strong').textContent"), 'OpenAI');
  assert.equal(await evaluate("document.querySelector('.settings-info').textContent.includes('reasoning.effort')"), true);
  await clickText('返回项目');
  await waitFor("Boolean(document.querySelector('#project-name'))");
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await mkdir('.impeccable/review', { recursive: true });
  await capture('desktop-empty.png');
  const { root: documentRoot } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#material-file-input' });
  await send('DOM.setFileInputFiles', { nodeId, files: [fixture, reference] });
  await waitFor("document.querySelectorAll('.material-item').length === 2");
  await fill('#project-name', '初始化测试项目');
  await fill('#project-brief', '内容完整保留；首页和 Logo 不动');
  await fill('.material-controls textarea', '这份是主稿，内容不删减');
  await assertPinnedActions();
  await capture('desktop.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 1000'), true);
  await assertPinnedActions();
  await capture('desktop-compact.png');
  await clickText('保存并分析材料');
  await waitFor("Boolean(document.querySelector('.analysis-panel'))");
  assert.equal(await evaluate("document.querySelector('.analysis-status').textContent"), '统计完成');
  const projects = await evaluate('window.pptPlan.listProjects()');
  assert.equal(projects.length, 1);
  const saved = await evaluate(`window.pptPlan.openProject(${JSON.stringify(projects[0].id)})`);
  assert.equal(saved.materials.length, 2);
  assert.equal(saved.materials[0].note, '这份是主稿，内容不删减');
  assert.notEqual(saved.materials[0].localPath, fixture);
  assert.equal(await readFile(fixture, 'base64'), await readFile(saved.materials[0].localPath, 'base64'));
  await clickText('返回修改材料');
  await fill('.material-controls textarea', '更新后的文件说明');
  await clickText('保存项目');
  await waitFor("document.querySelector('.action-status').textContent.includes('项目已保存到本机') && !document.querySelector('.secondary-action').disabled");
  assert.equal((await evaluate('window.pptPlan.listProjects()')).length, 1);
  await send('Page.reload');
  await waitFor("Boolean(document.querySelector('#project-name'))");
  await clickText('最近项目');
  await waitFor("Boolean(document.querySelector('.recent-item'))");
  await evaluate("document.querySelector('.recent-item').click()");
  await waitFor("document.querySelectorAll('.material-item').length === 2");
  assert.equal(await evaluate("document.querySelector('.material-controls textarea').value"), '更新后的文件说明');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: Electron IPC, multi-file import, notes, SQLite persistence, OfficeCLI stats, update, reopen, desktop widths.');
  console.log(log);
} finally {
  socket?.close();
  child.kill('SIGTERM');
  await sleep(500);
  await rm(root, { recursive: true, force: true });
}
