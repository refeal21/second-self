# Golden Project 与 QA

## 固定输入

`fixtures/golden-project/` 是确定性的五页中文管理层汇报夹具：

- `management-memo.pdf`：事实与结论来源。
- `kpis.csv`：收入、毛利率、续约率和交付周期。
- `market-background.png`：无文字复杂背景。
- `style-reference.pptx`：视觉风格参考。
- `manifest.json`：夹具结构和预期页数。

五页分别覆盖封面、管理层摘要、可编辑 KPI 卡、可编辑表格、可编辑图表与图片背景。

## 自动验收

运行：

```bash
pnpm golden:qa
```

该入口直接使用 Node 的 `tsx` loader，不创建 `tsx` CLI IPC socket；在禁止 Unix socket 的受限构建环境中也能执行同一 Golden 脚本。

流程会先验证跳过材料分析、大纲批准、逐页规格批准或任一视觉批准均失败，然后走完合法审批链。最终断言包括：

- PPTX 中的中文与已批准规格完全一致。
- 标题、正文、表格、图表、基础色块分别存在于 OOXML，可独立编辑。
- 复杂背景只作为图片嵌入；参考图片中的文字不会和可编辑文字重复。
- LibreOffice 使用项目局部 Fontconfig 与 macOS `Hiragino Sans GB` 渲染全部五页。
- 每个 LibreOffice 渲染页与其对应的、互不相同的批准全页 PNG 做像素归一化比较，差异分数必须不高于 `0.6`。
- 页数为 5，所用字体可用，并且无空白页、缺失 OOXML 资源、对象越界或非法裁切；自动修复轮数不超过 2。

主要输出：

```text
artifacts/qa/golden-project/golden-project/exports/golden-management-report.pptx
artifacts/qa/golden-project/golden-project/exports/source-map.json
artifacts/qa/golden-project/golden-project/qa/qa-summary.txt
artifacts/qa/golden-project/golden-project/qa/qa-round-1.json
artifacts/qa/golden-project/golden-project/qa/qa-round-1.txt
artifacts/qa/golden-project/golden-project/qa/run-1/golden-management-report.pdf
artifacts/qa/golden-project/golden-project/qa/run-1/rendered-1.png … rendered-5.png
```

`artifacts/` 被 Git 忽略，报告里的绝对路径不会进入仓库。

## Keynote 人工检查

本机已检测到 `/Applications/Keynote.app`，但第一版不使用不可靠的 UI 自动化去假装完成编辑。交付前人工执行：

1. 用 Keynote 打开 Golden PPTX，确认 5 页均出现且字体正常。
2. 分别选择第 3 页 KPI 卡、第 4 页单元格和第 5 页图表，修改一个文字/数值后撤销。
3. 确认标题和正文可独立选择，第 5 页背景图不能误选为文字。
4. 关闭时选择“不保存”，避免修改 Golden 证据。

该检查不等于 Microsoft PowerPoint 兼容性验证；当前没有 PowerPoint 环境，因此不作此声明。

## 内存验收

2026-09-04 在当前 Apple Silicon Mac 的最新 release `.app` 和生产验收边界上，以 100 ms 间隔记录整条验收进程树。原生 sampler 接收真实时间戳操作事件，并在每个事件到达时立即采样，再持续覆盖稳定窗口。最新权威证据为：

- `artifacts/qa/production-harness/memory.json`：本轮 90 个样本，峰值 `618.8 MiB`，低于 4096 MiB 门槛。
- 时间线实际覆盖 `create-project`、`open-project`、`quit-worker-close-sqlite`、`restart-rust-sqlite-worker`、`reopen-project-after-restart` 和 `stable-sampling-window`，还覆盖材料、两次整体审批、五页视觉、导出与 QA。
- 每个样本保存 PID、PPID、RSS 和可执行文件路径；观测到 Node 驱动器、编译后的 Rust Workbench harness、`.app` 内嵌 SEA Worker、LibreOffice 和 pdftoppm。

这个数值是包含验收驱动器、Rust 服务、Worker 与 QA 子进程的保守生产 harness 窗口，不等于只启动图形 `.app` 的空闲占用。旧 `memory-one-project-v2.json` 的 60 个同标签样本只能证明当时 `one-project-open` 稳态，不能证明创建或重启峰值，因此不再作为完整操作时间线的验收依据。

复测命令：

```bash
pnpm build:production-harness
pnpm harness:production
```

macOS RSS 会随缓存波动；判定应使用同一 release 构建、同一 production harness 进程范围重新测量，并以新报告里的 `operationEvents`、`samples` 和 `peakProcesses` 为准。

## 生产边界端到端验收

`artifacts/qa/production-harness/result.json` 是打包生产路径的确定性证据。它使用真实 production adapter、编译后的 Rust Workbench/Tauri service delegates、SQLite、`.app` 内嵌 SEA、Rust held-fd/`O_NOFOLLOW`/原子写入和真实 LibreOffice/pdftoppm；只有 Codex 结构化生成结果由脚本固定。

验收要求包括：完成状态、SQLite 与 Worker 双重重启恢复、五张互不相同的批准全页 PNG、逐页比较分数、真实可读 `.txt` 报告、版本/审批/任务/产物行数，以及重启后的完整 provenance。harness 以空 PATH 启动 Rust 边界；本轮自动发现 Codex runtime 的原生 LibreOffice 与 pdftoppm，`pptxOoxml.mediaCount=5`，五页均 `imageCount=1`，表格页保留原生表格、图表页保留原生图表，并且基础形状与唯一可编辑标题均有逐页证据。五张 rendered PNG 都有 SHA-256 且 `likelyTofu=false`，原始 1920×1080 页面 1/4 又经人工像素抽查，中文可读。

同一结果的 `chatGptAuthGate` 记录 8 次 `account/read`（3 次结构化生成和 5 次视觉请求）、3 次 `thread/start`/`turn/start`，且首次账户读取发生在首次 `thread/start` 之前。API-key/未知/空计划的负向 spy 测试断言不会调用 native/Worker、`workspace_directory`、`thread/start` 或 `turn/start`。

完整聚合恢复还会核对任务 ID 中的修订号、状态/错误组合，以及分析、大纲、细化、视觉、转换和 QA 的任务来源。视觉阶段不再只检查阶段区间：校验器按每个 revision 重放 `visual_review → blocked → visual_review/conversion`，同时推进每页 `none → placeholder/candidate → frozen`，并把替换、批准和重新打开与完整 visual/version/approval 历史绑定。兼容边界保留 schema v1、SQLite 原 JSON 和“直接注入旧材料/全部材料经 Rust 附件命令写入”两种既有来源偏移。最终 `.app` 内嵌 SEA 的负向 smoke 使用真实 revision-29/12-task 完成态，只把最后一个 visual task 从 revision 25 改到 approval 所在的 revision 27，要求恢复原子拒绝且原聚合完全不变。这里的 provenance 是结构化合法执行证明，不是密码学防篡改日志。

## 运行时与配置审计

同一构建的只读审计结果：生产源码没有 TCP listener 实现，短时启动的主程序 PID 没有 TCP 条目；仓库生产代码与两个 bundle executables 中未发现 `OPENAI_API_KEY`、`api.openai.com` 或 `sk-proj-`。API-key 字样仅存在于明确拒绝该认证模式的实现、UI 文案与负向测试。生产通信为 Tauri IPC 与 stdio。

当前发布前重建的 `.app` 为 125 MiB，只含 arm64 主程序与 arm64 SEA Worker；源 SEA 与同一 `.app` 的 bundle SEA SHA-256 都是 `2633274138eaeba33fc370b7adbf680299c07ae27bdb874402c35efba1750f23`。每次 SEA 重建或 ad-hoc 签名都可能改变某次构建的具体 SHA-256；验收契约是同一构建的 source 与 bundle Worker 字节一致，而不是跨构建复用旧哈希。Node v22.21.1 的 143,299 字节 LICENSE/第三方声明与构建 runtime 字节相同。bundle 是 ad-hoc/linker-signed、没有 TeamIdentifier；`codesign --verify --deep --strict` 因未密封资源退出 1，因此不声称严格签名或公证通过。

生产组件视觉测试为 `native-workspace.test.tsx` 与 `app.test.tsx`，覆盖真实 `<img>` 加载、1280×720/16:9 门禁、坏图禁批、意见重生成、上传替换和批准页 reopen。当前受限环境禁止 Vite 监听端口，Playwright 启动本机 Chrome 又被沙箱终止，Browser Use 也按安全策略拒绝 `file://`；没有把 browser screenshot 伪报为通过。真实组件交互测试和生产 rendered PNG 原图共同作为本轮视觉证据。
