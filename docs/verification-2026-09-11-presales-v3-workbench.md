# 售前 v3 集成验收记录

观测日期：2026-09-14。工作树：`.worktrees/presales-batch`，分支：`codex/presales-batch-review`。Task 8 起点：`477debf15cf6633393af905fc8e2e5c910aebb21`。本文件记录合成验收与待交付条件，不能作为真实模型效果、可编辑重建或最终原生应用验收通过的证明。

## 当前交付状态

五页原生集成、真实 App 的合成 DTO 浏览器检查、全分支审查及 F1–F6 修复复审已完成。最终生产源码为 `d5bcdd55f0f04b42410f71515849c8f1af86758f`；2026-09-14 已从该提交重新构建 Worker SEA、前端、原生 release 与独立开发包，并执行包内 v3 离线协议冒烟。后续交付提交只增加打包检查脚本和文档，不改变包内生产源码。

实际构建名称是 `Digital Twin Workbench V3 Dev.app`，保留 `com.digitaltwin.workbench`，版本 0.1.0，最低 macOS 13.0。已保留在 `artifacts/build/presales-v3-dev/`，本地 ad-hoc 封装后整包严格签名验证通过，但没有 Developer ID 签名或公证；具体命令及手动使用条件见 [开发与打包](run-build.md#售前-v3-本轮独立开发产物)。

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

最终复审另修复了第 1 项对旧不可变副本凭据的兼容影响（F6）：读取仍要求数据库原始字符串与磁盘字节完全相等，仅允许当前 canonical 编码或精确旧编码（每个 receipt page 最末的空 references 字段被省略）；不做全局 JSON 归一化、不重写存储。原生历史、省略字段的格式副本、内容修订副本均实际重启读回，DTO 仍输出 `references: []`；修改身份、未知字段、空白重排和 null 仍被拒绝。

其他最终修复：完整场景/绑定编辑与缺失绑定修复、已完成但非法的文本回合终结为 failed、导入版本的 null-basis 采用/恢复/父图编辑、完整原输入重试与 native 持久撤回、离屏原图释放及 24 项缓存。V3 schema 3→4 为精确原子升级，V3 1/2 收敛到 4，QueueOnly schema 2 不变。

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

## 最终检查证据与外部待验收

以下全套源码结果来自最终修复实施记录 `final-fix-report.md`，总控已复审通过；本打包阶段未重复运行未改变的重型套件。早期 Task 8 的 413/401/355 是历史执行边界，不是最终源码计数。总控额外新跑了历史凭据 1/1、withdrawal 3/3、workspace/draft/GalleryImage 24/24。

| 命令 | 结果与时间边界 |
| --- | --- |
| `pnpm run test:core` | 8/8 |
| `pnpm run test:worker` | 416/416，34 个文件；含共用五页 vector 与旧 Golden Project QA 回归 |
| `pnpm --dir apps/desktop test` | 410/410，37 个文件（最终 15:54:38） |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features acceptance-harness -- --test-threads=1` | 361/361，169 lib + 192 bin/integration；含私有合成子进程 1/2/4 五页验收 |
| `pnpm typecheck`、`pnpm lint`、`pnpm check:presales-skill` | 最终修复后全部通过 |
| `pnpm --dir apps/desktop build` | 最终修复及本次打包均通过；80 modules，CSS 63.01 kB / JS 504.37 kB；Vite >500 kB advisory 非阻断 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`、`git diff --check` | 通过；包含此前 Task 5/7 遗留的纯格式整理 |

本轮未复现已知并行重负载下 sidecar timeout 或旧 native-generation-review feedback race；不把没有复现等同于已解决这些历史噪声。

全分支基线 `5f0d06c5826fb63cdfd0156e6a4354125da0aba5` 的独立审查、修复和窄范围复审由总控完成：F1–F6 全部 addressed，未发现新增 Critical/Important。没有重复派发 reviewer。最终浏览器证据在 `artifacts/qa/presales-v3/final-fixes/browser-report.json`（完整场景编辑、40 图滚动，最高 6 个 DOM 原图、errors []、3 个内存资源）与 `final-fixes/native-app/browser-report.json`（更新的真实原生五页 DTO→实际 App，errors []、手机宽度 390）。DOM 原图数量不是内存测量；上文 225.1 MiB 是原始合成树观测，没有因新包构建而重测。

## 最终开发包与离线冒烟

构建命令见 run-build；实际日志 `artifacts/qa/presales-v3/final-package-build.log`。Tauri beforeBuildCommand 重新执行 `build:worker-sidecar`（Node v22.21.1 SEA blob/postject/ad-hoc）和前端构建，再完成原生 release（1m14s），退出 0。未安装依赖。`ditto` 保留副本，未覆盖现存目标。主程序与 Worker 均为 arm64 Mach-O；最终封装包内 8 个文件总计 133,615,912 字节，`du -sk` 为 130500 KiB。

| 包内文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Contents/MacOS/digital-twin-desktop` | 20,097,520 | `85cf24fd6cf4d95034ac328fdd928b9a2f9517d5880225d00a9d284ca66cbc13` |
| `Contents/MacOS/digital-twin-worker` | 111,460,144 | `c617333882ffe5b6af2d59878750581f6cf3f78da8f534e395f32972e5dfccaf` |
| `Contents/Resources/licenses/node-runtime/LICENSE-and-third-party-notices.txt` | 143,299 | `e991d81497a85bb24fc6bffae0a3637a6accd6c6bc5ce1f2c5698bd555cf9d49` |

许可逐字节匹配本机 Node v22.21.1 发行版 LICENSE，VERSION.txt 同为 v22.21.1，包内另有 THIRD_PARTY_NOTICES.md。Worker 逐字节匹配本次新构建 SEA，外层封装未改变 Worker。完整文件清单、哈希、Info.plist、签名命令/退出码保存在 `final-package-inspection.json`（08:24:06 UTC）。清单 JSON 的 SHA-256 为 `74957727ca203499eb5d0477992e9ffd43eba43396549710b00312e4db083451`；这是该记录定义的有序文件清单摘要，不是 `.app` 目录或 zip 的字节哈希。

原始 Tauri 包实测 Worker 严格验证退出 0、整包严格验证退出 1（`code has no resources but signature indicates they must be present`），证据保留在 `final-package-inspection-preseal.json`。总控批准仅对精确保留副本做本地资源封装：先读取主程序/Worker entitlements，均为空；执行 `codesign --force --sign - <保留包>`，未新增能力或使用证书/钥匙串。最终整包 `codesign --verify --deep --strict` 与 Worker `--verify --strict` 均退出 0；Info.plist 14 项已绑定、Sealed Resources version 2/files 5，签名为 ad-hoc，无 TeamIdentifier。主程序哈希因重新封装而变化，原始构建输出未变。未做 Developer ID 签名、公证或 Gatekeeper/GUI 启动验收。

封装后重新执行 `node scripts/smoke-packaged-presales-worker.mjs <包内 Worker 绝对路径>` 退出 0，证据 `final-packaged-worker-smoke.json`（08:24:06 UTC；封装前记录另存 `final-packaged-worker-smoke-preseal.json`）：

- 默认模式仅创建一个真实内存 intake checkpoint 作为校验输入，不执行 Golden deck。
- `--presales-validate` 接受紧凑与缩进两个准确 UTF-8 快照，分别验证 450/550 字节和不同 SHA；伪造 completed/revision99 被 -32602 拒绝，运行时方法被 -32601 拒绝。
- `--presales-runtime` 实际生产私有代理启动，但所有 native start/send 回复由脚本伪造。初始 unavailable→合成能力 generation/referenceEditing true→连接丢失后均 false；旧 generation 与 legacy 方法被拒绝。
- 三个包内 Worker 进程均正常退出 0、stderr 空；仅继承 `/usr/bin:/bin` PATH，无 Node/Codex 查找或账户环境。合成 provider 方法严格限定为 initialize/initialized/account/config/requirements/model/capabilities，thread/turn 调用 0；scratch 仍为空，无 HTTP listener 或 GUI。

打包阶段未运行旧 packaged Golden 全链路：所需已生成 outline 输入不存在，没有为此额外生成数据。源码套件中的旧 Golden QA 仍仅是回归证据。冒烟不证明真实能力、图片设计质量、实际 native provider 启动或 v3 可编辑转换。

仍需单独实测：安全隔离的原生 GUI 初始化与视觉检查、原生 app-tree RSS、真实账户 ImageGen 的五页效果与父图编辑、Keynote 打开/编辑、真实峰值内存。任意 v3 整页 PNG 的可编辑重建仍未实现，不能从本次合成验收或旧 Golden QA 推导为完成。
