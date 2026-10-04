# PPT Plan Studio

Electron 桌面 PPT 工作台。用代表页与用户反复确认设计，沉淀规范后统一美化整套。

## 当前里程碑

- Electron + React + TypeScript，隔离的 preload/IPC。
- 多文件选择或拖入、唯一 PPTX 主稿；每份材料分别填写用途和说明。
- 导入复制文件，原件不动；SQLite 项目索引和 JSON 项目记录。
- 通过“最近项目”重新打开、继续修改说明，不重复创建项目。
- 确定性读取 Office/PDF/图片证据，并启动真正的 Pi Agent 只读分析；提供进度、取消、结构化报告和代表页候选。
- 成功后可查看代表页预览、勾选并确认；未实现页面改写或整套制作。
- Pi Runtime 已接入 OpenAI Responses API reasoning 配置；可在“设置”页面保存和清除 OpenAI API Key、Base URL、Model ID 与 thinking level，并测试连接。
- **尚未接入完整 Agent 对话、代表页 Plan、设计规范和全套制作**。

## 开发

需要 Node.js 24+ 和 npm。本机安装 OfficeCLI，或以 `OFFICECLI_PATH` 指定位置。

```sh
npm install
npm run dev
```

Electron 下载超时，可在安装时使用镜像：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

```sh
npm run typecheck
npm test
npm run test:desktop
npm run build
npm start
npm run package:dir
```

`dev` 启动真正的桌面窗口。浏览器只可预览界面，本地操作不会模拟成功。主进程代码修改需重启；React 页面支持热更新。

资料位于 Electron `userData/projects`，索引在 `userData/projects.sqlite`；分析运行和报告位于项目目录的 `analysis/`。可从“项目目录”打开。

AI 设置位于 Electron `userData/ai-settings.json`；API Key 单独使用系统安全存储加密，保存在 `ai-credential.bin`，不会进入项目 JSON、SQLite、renderer 或日志。当前 Provider 只有 OpenAI，使用 `openai-responses` 与 reasoning effort 协议。

Electron 44 的运行时可能在首次启动时才下载。如安装包已装好但启动下载失败，可显式执行：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

`test:desktop` 使用临时独立项目目录和 OfficeCLI 创建的测试主稿，验证真实 Electron IPC、导入、说明、保存、确定性读取、更新与重开；不调用模型，也不改动用户项目。

`npm test` 还通过本地 Responses SSE 服务驱动真正的 Pi Session，验证受控工具循环、视觉输入、结构化提交、取消和恢复。`tests/real-analysis.verify.mjs` 是显式真实服务验证入口，使用运行中的 Electron 凭据，只在选定项目新增分析结果，不读取或输出 API Key。

### 分析能力边界

- PDF.js 和图片处理依赖随应用打包；OfficeCLI 仍需单独安装或配置 `OFFICECLI_PATH`，再分发许可与跨平台分发尚未确认。
- PPT 预览是 OfficeCLI HTML 渲染，不等同 PowerPoint 原生保真。
- 中文 OCR 未启用；图片和扫描 PDF 依赖模型视觉读取，并保留此局限。
- 中断后保留上次成功报告，可重新分析；不续跑失去上下文的 Pi 会话。
- 报告独立保存在 `analysis/runs/<runId>/result.json`；项目 JSON/SQLite 只存最新引用。证据、运行状态、工具时间线与预览同时保留。

SQLite 使用 Node 内置 `node:sqlite`，无需 native npm 模块重编译。正式分发仍需验证 OfficeCLI 打包、许可证和更新策略。
