# PPT Plan Studio

Electron 桌面 PPT 工作台。用代表页与用户反复确认设计，沉淀规范后统一美化整套。

## 当前里程碑

- Electron + React + TypeScript，隔离的 preload/IPC。
- 多文件选择或拖入、唯一 PPTX 主稿；每份材料分别填写用途和说明。
- 导入复制文件，原件不动；SQLite 项目索引和 JSON 项目记录。
- 通过“最近项目”重新打开、继续修改说明，不重复创建项目。
- OfficeCLI 基础统计、逐文件失败提示和重试。
- Pi SDK 已加入依赖；**尚未接入对话、代表页 Plan、规范和全套制作**。

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

资料位于 Electron `userData/projects`，索引在 `userData/projects.sqlite`。可从“项目目录”打开。

Electron 44 的运行时可能在首次启动时才下载。如安装包已装好但启动下载失败，可显式执行：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

`test:desktop` 使用临时独立项目目录和 OfficeCLI 创建的测试主稿，验证真实 Electron IPC、导入、说明、保存、更新与重开；不调用模型，也不改动用户项目。

SQLite 使用 Node 内置 `node:sqlite`，无需 native npm 模块重编译。正式分发仍需验证 OfficeCLI 打包、许可证和更新策略。
