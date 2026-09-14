# 售前 v3 集成验收记录

观测日期：2026-09-14。工作树：`.worktrees/presales-batch`，分支：`codex/presales-batch-review`。Task 8 起点：`477debf15cf6633393af905fc8e2e5c910aebb21`。本文件记录合成验收与待交付条件，不能作为真实模型效果、可编辑重建或最终原生应用验收通过的证明。

## 当前交付状态

五页原生集成、真实 App 的合成 DTO 浏览器检查、源码检查与前端构建已执行。最终 Worker SEA 与独立 `.app` 按总控要求等待全分支审查和修复波次完成后再构建，避免交付过时二进制；Task 8 尚未完成最终包交付。

计划构建名称是 `Digital Twin Workbench V3 Dev.app`，保留 `com.digitaltwin.workbench`。计划交付目录：`artifacts/build/presales-v3-dev/`，当前不是已生成产物。具体命令见 [开发与打包](run-build.md#售前-v3-本轮独立开发产物)。

该应用即使名称、文件位置不同，启动仍会打开标准应用数据目录下两个 SQLite 数据库，初始化 `~/Documents/DigitalTwinWorkspace`，并由 App 自动连接常规账户路径。没有添加测试专用生产启动模式，本轮没有启动原生 GUI，也没有替换 `/Applications` 或运行中的应用。

## 五页共用夹具与原生路径

`fixtures/presales/five-page-acceptance.json` 是 Worker 和 Rust 共用的 Chinese presales pair：

| 页 | 类型与内容 | 模块覆盖 |
| --- | --- | --- |
| 1 | 园区协同运营建设目标：发现、协同、复盘 | 项目目标 |
| 2 | 感知与处置双模块总体架构 | sensing、response |
| 3 | 感知接入：输入、处理、输出与核验 | sensing |
| 4 | 协同处置：派单、接单、反馈、复核 | response |
| 5 | 人员协作场景：告警到复核闭环 | 两模块连续步骤及连接边 |

每页有不同标题、目的、正文、视觉简述和设计；架构声明的两个模块均有后续模块页和场景覆盖。全部标题与正文叶子都有显式 text binding；speakerNotes 不作为可见文字。Worker `parseOutlineEnvelope / parseDetailsEnvelope / resolveVisibleBindings` 与 Rust `validate_pair` 同时校验该文件，删除正文绑定会被双方拒绝。原 Golden Project 只用于已有导出器回归，未用来代替该五页故事。

原生集成复用 `basis::tests` 中真实的 Database 成对保存、outline freeze/approval、details freeze/approval，再通过 `ValidatedV3ProjectSeed::from_checkpoint` 建立新合成 v3 项目。配色 profile 与 revision 2 被保存到 v3 项目并在重启后核对；这不是一次 UI 配色保存操作的观测。

| 验收项 | 本次真实执行的合成路径 |
| --- | --- |
| 并发 1/2/4 | 实际 QueueSupervisor 启动私有 Worker 子进程，五页按 FIFO 提交；事件回调检查占位不超过设置 |
| B 先完成与跨页审批 | 并发 2/4 用文件门闩保持 A 未完成，B 先完成并获批准；并发 4 同时确认 C running。并发 1 按 A→B FIFO 完成，不声称单槽也乱序 |
| 页级参考 | 系统选择权威 helper 复制合成 PNG，仅架构页引用；冻结 target 的引用上下文一致，provider-input resolver 读回相同字节 |
| 五轮修订 | 每轮 B 使用当前精确版本作为非空 parent，校验冻结 parent image 身份和 native provider-input 路径的实际 PNG 字节；保存不同 baseVersionId 的反馈 |
| 运行中存草稿 | 每轮先等待 running，再保存独立反馈 CAS，随后放行子进程。自动发起下一轮不是副作用 |
| 历史与重启 | 关闭实际子进程、释放服务、重新打开 SQLite；B 六个版本和五份反馈逐一可读，原图 SHA/版本身份保持 |
| 精确交付 | 仅浏览历史不改变交付；明确 adopt 旧初稿后再 restore 原审批，D 精确选择该版本与原 approvalId。其余四页与原快照相同 |
| 不确定取消 | 同一五页项目发起 A 新请求，取消 ACK 不释放槽位；子进程/服务重启后 outcome_unknown 仍占槽且不重发；不确认重复风险则不能 abandon |
| 资源缺失 | 临时移走本轮合成父图，预览、provider-input 读取和新 parent admission 均拒绝；测试内恢复该合成文件 |

私有 Worker 合成 provider 返回确定 PNG，不执行图片语义修改。五轮证明历史父图身份、实际可解析字节、队列与持久化编排；真实模型是否正确编辑父图仍未观察。已有 Worker image-provider 与原生 production proxy 的合成测试也保留在全套回归中。

## 实际 DTO 暴露并修复的边界问题

1. 原生 `V3PageState.references` 对空数组使用 skip_serializing_if；前端要求数组并读取 length。实际原生 DTO 令 App 白屏，控制台为 `Cannot read properties of undefined (reading 'length')`。先运行回归，得到 `Null != Array []`；然后让原生始终输出数组，保留 serde default 以读取旧数据。原生回归、旧值读取和实际 App 重跑通过，未在夹具中补假字段。
2. 原生 ordinal 为 0..4；前端误直接显示 0..4。先运行读取模型回归，得到 `first:0/fifth:4` 而非 `1/5`；再只调整用户可见页码加 1。Gallery 的 display-number 约定、数据库顺序和页面 ID 未改，关联参考图、反馈、对照与审批标签一致。

## 浏览器视觉与交互

使用 frontend-testing-debugging 流程。Browser plugin not available；使用已安装 Playwright + headless Chrome，`--mute-audio`。没有 HTTP listener；`https://presales-test.invalid` 的三个页面资源由内存响应，其他请求全部拒绝。没有 production Tauri adapter、账户配置写入或真实 provider 连接。

入口是实际 `App`，注入原生集成导出的 `concurrency-4-five-revisions.json`。仅预览图在测试 adapter 边界替换为按冻结正文画出的 Canvas PNG，图内明确标注“合成验收示意、非模型生成图”。这些截图不声称满足 design 的真实模型视觉品质。

| 检查 | 结果 |
| --- | --- |
| 页面身份/非空/错误覆盖层 | 正确标题与五页项目；可操作、无框架错误覆盖层 |
| Desktop | 1440×1000，五页逐一切换与截图 |
| Mobile | 390×844；body scrollWidth 390，无水平溢出 |
| 控制台 | errors/warnings 0 |
| 网络 | 内存响应 3，额外请求 0；没有本地服务 |
| 历史与反馈 | 查看 B 初稿原反馈→保存→切第 6 版本→回初稿，反馈独立恢复 |
| 交付 | 浏览初稿不产生 adopt；点击交付仍为 `visual-attempt-revision-5`，明确返回 unsupported_editable_conversion，export/qa 均 not_run |

这里的浏览器 D 选择的是当时最新的第 6 版本：B 顺序为 `visual-attempt-1`、`visual-attempt-revision-1` 至 `visual-attempt-revision-5`。浏览器证明“看初稿不改变最新交付”。选择较旧历史稿的独立证明来自同一个 Task 8 原生测试：重启后明确 adopt 第 1 版本 `visual-attempt-1`、restore 原审批，再断言 D 的 versionId/approvalId 与最初批准相同、其余四页不变，且六个 B 版本仍保留；两项证据没有互相替代。

截图和日志位于忽略提交的 `artifacts/qa/presales-v3/`：`page-1-desktop.png` 至 `page-5-desktop.png`、`history-exact-delivery.png`、`mobile.png`、`browser-report.json`。首次白屏证据保留在 `browser-failure.txt`，它描述修复前失败，不是当前运行结果。

复现时先导出本轮合成原生 DTO：

```bash
PRESALES_ACCEPTANCE_EVIDENCE_DIR="$PWD/artifacts/qa/presales-v3" \
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness \
  five_page_acceptance -- --nocapture
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/installed/playwright \
  node apps/desktop/scripts/presales-v3-acceptance-browser.mjs
```

Playwright 脚本不安装依赖。可用 `PLAYWRIGHT_BROWSER_PATH` 指定已有 Chrome 可执行文件；本次使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。实际本机 bundled module 是 `/Users/yangjinlong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`。

## RSS：仅合成验收树采样

复用原生 `process-rss-sampler`，100 ms 间隔、221 个样本、15 个命名操作窗口；本次最高采样 RSS **225.1 MiB**。根是存活到采样结束的 Node 协调器，包含 Rust 测试宿主/SQLite/vault、合成 Worker/tsx/编译辅助进程以及采样器自身；测量开销没有扣除。底层日志的 peak 字段表示最高采样值。

不包含原生 GUI/WebKit、真实 Codex/ImageGen provider、脱离树的辅助进程及两次采样之间的尖峰；不是物理峰值、真实模型内存或 app-tree 验收。没有引用旧 579/618/544 MiB 数字。初次以短寿命测试 PID 为根时最后一次捕获失败，未产生有效报告；改用持久协调器后才有本次数据。

日志：`native-synthetic-rss.json` 和 `native-synthetic-rss-test.log`。命令：

```bash
# 路径取自刚完成的 cargo test 输出，不使用过时测试可执行文件。
PRESALES_TEST_BINARY=/absolute/path/to/target/debug/deps/digital_twin_desktop_lib-HASH \
  node apps/desktop/scripts/presales-v3-acceptance-rss.mjs
```

测试 wrapper 只启动指定测试可执行文件；原生 helper 必須先由 acceptance-harness feature 编译。本次控制器只读音量检查返回 output volume 0、alert volume 0、output muted true；未播放声音。

## 检查证据与最终待办

| 命令 | 结果与时间边界 |
| --- | --- |
| `pnpm run test:core` | 8/8 |
| `pnpm run test:worker` | 413/413，包括共用五页 vector 与旧 Golden Project QA 回归 |
| `pnpm --dir apps/desktop test` | 修复后全套 401/401，36 个文件（15:04:51 开始） |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness -- --test-threads=1` | 355/355；为两项边界修复之前的完整执行，日志 rust-full.log |
| 修复后 native basis tests | 7/7，含新 serialization regression 与旧省略字段读取 |
| 修复后 native integrated test | 1/1，内部依次覆盖 1/2/4；RSS 运行同样通过 |
| 修复后 frontend targeted | 23/23：read-model、workspace、draft-workspace、App routing |
| `pnpm typecheck`、`pnpm lint`、`pnpm check:presales-skill` | 修复后全部再次执行通过 |
| `pnpm --dir apps/desktop build` | 通过；79 modules，CSS 62.42 kB / JS 497.13 kB；仅前端 dist，不是 SEA 或原生包 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`、`git diff --check` | 通过；包含此前 Task 5/7 遗留的纯格式整理 |

本轮未复现已知并行重负载下 sidecar timeout 或旧 native-generation-review feedback race；不把没有复现等同于已解决这些历史噪声。

全分支基线 `5f0d06c5826fb63cdfd0156e6a4354125da0aba5` 的独立审查、发现修复与窄范围复审由总控执行。本次没有自行再派一个重复 reviewer。审查波次完成后需要刷新最终检查、重新构建真实自包含 SEA 和独立 `.app`，记录实际路径、二进制身份、包内文件与签名检查，再完成开发包交付。

仍需单独实测：安全隔离的原生 GUI 初始化与视觉检查、原生 app-tree RSS、真实账户 ImageGen 的五页效果与父图编辑、Keynote 打开/编辑、真实峰值内存。任意 v3 整页 PNG 的可编辑重建仍未实现，不能从本次合成验收或旧 Golden QA 推导为完成。
