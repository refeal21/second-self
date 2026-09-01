# 数字分身工作台 MVP

## Global Constraints

- 纯本地 macOS Tauri 2 + React 应用，不开放 HTTP 端口。
- 使用 Codex App Server 的 stdio JSONL 协议和 ChatGPT 登录；不得提供或存储 OpenAI API Key。
- Rust 核心拥有 SQLite、路径安全和进程监管；TypeScript Worker 拥有 Codex 协议与 PPT 工作流编排。
- 默认工作区为 `~/Documents/DigitalTwinWorkspace`，只能在工作区写入；用户目录读取只由显式选择触发。
- PPT 流程固定为 `intake → source_analysis → outline_review → detail_review → visual_review → conversion → qa → completed`，失败进入 `blocked`，审批不可跳过。
- PPT 采用图片优先：先逐页生成并审批视觉，再把标题、正文、表格、图表和基础形状重建为可编辑对象；复杂视觉保留为图片。
- AI 偏好只能先形成提案，用户批准后才能成为长期记忆。
- 正常单项目增量内存峰值目标不超过 4GB。

## Task 1: Scaffold and domain foundation

- 创建 pnpm workspace、React/Vite 前端、TypeScript Worker 和 Tauri 2 Rust 壳。
- 建立共享核心类型、工作流状态机、版本/审批模型和路径安全模块。
- Rust 使用 rusqlite 建立项目、版本、审批、任务、产物和记忆提案表。
- 为状态机、路径保护、版本冻结和记忆审批先写失败测试，再实现通过。
- 提供可运行开发命令、类型检查、lint 和测试脚本。

## Task 2: Codex App Server and general tasks

- 实现 Codex 二进制发现顺序：用户配置、PATH、ChatGPT 应用内置路径。
- 通过 `codex app-server --listen stdio://` 启动，完成 initialize/initialized、account/read、ChatGPT browser login、thread/start/resume、turn/start 和流式事件解析。
- 不实现 API Key 登录，认证数据不得写入工作台数据库。
- 实现通用任务的线程、流式 transcript、取消、恢复、审批请求和错误状态。
- 使用模拟 App Server 对协议握手、登录、事件、额度、崩溃恢复先写失败测试。

## Task 3: PPT workflow and local artifacts

- 实现项目创建、材料附件、来源映射、大纲整体审批、逐页细化整体审批、逐页视觉审批、重新生成与替换图片。
- 生成结构化 outline、slide spec 和每页 image-generation brief；联网搜索必须经过明确审批。
- 每次审批冻结版本；只允许当前合法阶段的操作，重开旧页产生新版本。
- 实现 `PptxExporter` 适配器，按照批准规格生成可编辑 PPTX；批准图片仅作为复杂背景/视觉层。
- 实现 LibreOffice 探测、渲染、最多两轮 QA 编排和 QA 报告。
- 测试不得出现烘焙文字与可编辑文字重复，并验证 PPTX XML 中的批准文字和可编辑对象。

## Task 4: Production desktop UI

- 以 `design/concepts/dashboard.png` 和 `design/concepts/ppt-workspace.png` 为视觉基准。
- 实现首页、通用任务、PPT 项目、审批中心、偏好记忆和设置。
- PPT 页面使用左流程/页码、中间 16:9 画布、右审批与进度的三栏布局。
- 所有主要按钮、表单、导航、审批、重新生成、导出和状态切换连接真实本地状态或明确的后端错误，不得是无响应占位控件。
- 支持窄窗口响应式布局、键盘焦点、减少动态效果和中文排版。
- 添加组件/交互测试并进行浏览器视觉 QA。

## Task 5: Integration, golden project, packaging and QA

- 提供固定五页中文商务汇报 Golden Project，覆盖 PDF、表格、图片和风格参考的等价测试夹具。
- 完成前端、Rust、Worker 和 Codex 模拟器端到端连接。
- 验证状态机不能跳过审批、工作区外不能写、崩溃能从完整检查点恢复。
- 验证导出的 PPTX 可由 LibreOffice 全页渲染并通过溢出/空白页/资源检查；记录 Keynote 人工验收步骤。
- 生成个人使用的 unsigned macOS `.app` 开发构建说明，记录 ImageGen 未启用时的显式阻塞状态。
- 记录内存测量方式、许可证归属、运行和故障排查文档。

