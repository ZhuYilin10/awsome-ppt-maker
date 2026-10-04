// Opt-in verification against the running application; never reads credentials.
// Start Electron with --remote-debugging-port=19332, then run this script.
const port = process.env.PPT_PLAN_CDP_PORT || '19332';
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('未找到运行中的 Electron 页面。');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
};
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => {
      if (message.error || message.result?.exceptionDetails) reject(new Error('Electron IPC 验证失败。'));
      else resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
try {
  const projects = await evaluate('window.pptPlan.listProjects()');
  const project = process.env.PPT_PLAN_PROJECT_ID ? projects.find((item) => item.id === process.env.PPT_PLAN_PROJECT_ID) : projects.find((item) => item.name === '海洋之帆');
  if (!project) throw new Error('未找到指定验证项目。');
  const id = JSON.stringify(project.id);
  const run = await evaluate(`window.pptPlan.startProjectAnalysis(${id})`);
  console.log(JSON.stringify({ projectId: project.id, runId: run.runId }));
  let last;
  for (let turn = 0; turn < 460; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const snapshot = await evaluate(`window.pptPlan.getAnalysisRun(${id})`);
    const marker = JSON.stringify({ status: snapshot?.status, completedMaterials: snapshot?.completedMaterials, tool: snapshot?.currentTool, error: snapshot?.error });
    if (marker !== last) { console.log(marker); last = marker; }
    if (['completed', 'failed', 'cancelled'].includes(snapshot?.status)) {
      if (snapshot.status !== 'completed') process.exitCode = 1;
      else {
        const report = await evaluate(`window.pptPlan.getProjectAnalysis(${id})`);
        console.log(JSON.stringify({ materials: report.materials.length, representativePages: report.representativePages.map((item) => item.pageNumber) }));
      }
      break;
    }
  }
} finally { socket.close(); }
