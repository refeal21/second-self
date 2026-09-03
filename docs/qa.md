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

2026-09-03 在当前 Apple Silicon Mac 的最新 release `.app` 上，以 100 ms 间隔对应用根 PID 及全部后代进程求 RSS 总和。报告的峰值样本同时保存每个 PID、PPID、RSS 与完整命令，并为每个采样点保留用户操作标签和 PID 列表：

- 从最新 bundle 重新启动应用，打开一个真实持久化 PPT 项目后采样 8 秒：峰值 `130.6 MiB`。
- 峰值进程是主应用 PID `6909`（`92,784 KiB`）和内嵌 Worker PID `6940`（`40,944 KiB`）；该窗口没有启动 Codex App Server，因为项目停留在材料阶段。
- `artifacts/qa/memory-one-project-v2.json` 保存 60 个 `one-project-open` 时间线样本，低于 4096 MiB 门槛。

PID 会在每次复测时变化，应以新报告中的 `rootPid`、`peakProcesses` 和 `operationTimeline` 为准；上述 PID 只用于标识本次验收证据。

复测命令：

```bash
node scripts/measure-process-tree-rss.mjs \
  --pid <digital-twin-desktop-pid> \
  --duration 8000 \
  --operation one-project-open \
  --output artifacts/qa/memory-one-project-v2.json
```

macOS RSS 会随缓存波动；判定应使用同一 release 构建、相同子进程范围重新测量。

## 运行时与配置审计

同一构建的只读审计结果：主程序、Worker 和 Codex App Server 均没有 TCP listener；仓库与两个 bundle executables 中未发现 `OPENAI_API_KEY` 或 `api.openai.com`；唯一 API-key 字样位于“拒绝 Codex API-key 登录通知”的负向单元测试。生产通信为 Tauri IPC 与 stdio。
